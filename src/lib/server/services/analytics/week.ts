/**
 * The week in progress at a glance, as Today's 'This week' shows it: sessions, training load
 * (sRPE: minutes × session RPE) and running distance from Monday through today, each against
 * the same days of last week. Every figure is the dashboards' own rule (series.ts's soFar over
 * the facts loader's counted workouts and runs, workload.ts's sessionLoads, running.ts's
 * wholeRun), read over those two half-weeks only, so Today and Progress never disagree.
 * - `logged`: whether anything has ever been logged, so a screen shows 0 for an empty week once
 *   there is a history, and 'no data yet' only before the first session.
 * - Reads run one at a time (the facts loader's queue), so `db` may be a transaction.
 */
import { METRICS } from '../../../domain/analytics/metrics';
import {
	sameDaysLastWeek,
	type DayRange,
	type InProgressWeek
} from '../../../domain/analytics/periods';
import { wholeRun } from '../../../domain/analytics/running';
import { soFar, type SoFar } from '../../../domain/analytics/series';
import { sessionLoads } from '../../../domain/analytics/workload';
import { daysBetween, mondayOf, type IsoDate } from '../../../domain/calendar';
import { getAthleteProfile } from '../profile/index';
import { resolveDeps, type TrainingDeps } from '../training/shared';
import { factsSource, type DashboardDeps } from './facts';
import { displayUnits, type DisplayUnits } from './format';

export interface WeekSoFar {
	/** Monday through today. */
	week: InProgressWeek;
	/** The same days of last week. */
	lastWeek: DayRange;
	units: DisplayUnits;
	/** Anything logged on or before today, ever. */
	logged: boolean;
	sessions: SoFar;
	/** sRPE load, the known loads added. */
	load: SoFar;
	/** Running distance in metres. */
	distance: SoFar;
}

export async function getWeekSoFar(
	ownerId: string,
	{ today }: { today: IsoDate },
	deps: Pick<TrainingDeps, 'db'> & DashboardDeps = {}
): Promise<WeekSoFar> {
	const { db } = resolveDeps(deps);
	const profile = await getAthleteProfile(ownerId, { db });
	const { timeZone } = profile;
	const weekStart = mondayOf(today);
	const week = { weekStart, through: today, days: daysBetween(weekStart, today) + 1 };
	const lastWeek = sameDaysLastWeek(week);
	const facts = factsSource(db, ownerId, timeZone, deps)(lastWeek.from, today);

	const first = await facts.firstActivity();
	const sessions = await facts.sessions();
	const runs = await facts.runs();
	const loads = sessionLoads(sessions, timeZone);
	const over = (id: 'sessions' | 'srpe_load' | 'mileage', values: { at: Date; value: number }[]) =>
		soFar(values, week, { timeZone, direction: METRICS[id].direction });

	return {
		week,
		lastWeek,
		units: displayUnits(profile),
		logged: first !== null && first <= today,
		sessions: over(
			'sessions',
			sessions.map((s) => ({ at: s.startedAt, value: 1 }))
		),
		load: over(
			'srpe_load',
			sessions.flatMap((s, n) => {
				const load = loads[n]!.load;
				return load === null ? [] : [{ at: s.startedAt, value: load }];
			})
		),
		distance: over(
			'mileage',
			runs.flatMap((run) => {
				const metres = wholeRun(run).distanceMetres;
				return metres === null ? [] : [{ at: run.startedAt, value: metres }];
			})
		)
	};
}
