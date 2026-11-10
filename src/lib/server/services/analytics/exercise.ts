/**
 * One exercise's figures (PRD §10, the exercise detail screen) in one call: its e1RM trend with a
 * verdict and the profile's maxes marked apart, top sets, the 1–10 rep-max table with each
 * record's date and the record it beat, its e1RM and volume PRs, its RPE against target and its
 * recent sessions. Every number comes from domain/analytics on the facts loader's rows, as the
 * strength dashboard reads them (strength.ts); nothing is redefined.
 *
 * - Only completed, undeleted workouts count (the facts loader's rule), for every figure and for
 *   the recent sessions, which M3's getLastPerformances reads.
 * - An e1RM is an estimate. The profile's 1RMs are markers (measuredMaxes), each labelled measured
 *   or estimated by M2, never points of the series.
 * - The e1RM figure and RPE against target follow the dashboards: a value over the period's
 *   complete weeks, a comparison with the previous period, a verdict over trendWindow(period), and
 *   the week in progress as the last point, flagged. Top sets cover the period and this week.
 * - Records (rep maxes and PRs) are judged against every completed workout of the lift ever, so
 *   the sets before the period are read too; PR timelines run oldest first over all time.
 * - An id that is malformed, unknown or another owner's custom exercise is TrainingNotFoundError;
 *   a retired catalogue or custom exercise of the owner's stays readable.
 * - Reads run one at a time, so `db` may be a transaction.
 */
import { addDays, daysBetween, mondayOf, type IsoDate } from '../../../domain/calendar';
import { localDay } from '../../../domain/dates';
import { METRICS, type MetricId } from '../../../domain/analytics/metrics';
import { goodness, kpi, trendOf } from '../../../domain/analytics/overview';
import {
	periodWindow,
	sameDaysLastWeek,
	trendWindow,
	type Period,
	type PeriodWindow,
	type TrendWindow,
	type WeekRange
} from '../../../domain/analytics/periods';
import {
	exposure,
	matchPrescription,
	rpeDeviationSummary,
	type Exposure
} from '../../../domain/analytics/prescribed';
import { byMonth, fillWeeks } from '../../../domain/analytics/series';
import {
	e1rmSeries,
	measuredMaxes,
	prTimeline,
	topSets as topSetsOf,
	type MaxPoint,
	type StrengthPr
} from '../../../domain/analytics/strength';
import type { Availability, SeriesPoint } from '../../../domain/analytics/types';
import { personalRecords, PR_MAX_REPS } from '../../../domain/training/metrics';
import { prCandidates } from '../../../domain/workout/logging';
import { above } from '../../../domain/workout/summary';
import type { AnalyticsRepository, SetFact } from '../../db/repositories/analytics';
import type { Executor } from '../../db/types';
import { getExercisesByIds, type ExerciseDef } from '../exercises/index';
import { isUuid } from '../ids';
import { getAthleteProfile } from '../profile/index';
import { getLastPerformances, MAX_LAST_PERFORMANCES, type Performance } from '../training/history';
import { TrainingNotFoundError } from '../training/shared';
import { createFactsLoader } from './facts';
import { displayUnits, formatIn, weight, type DisplayUnits } from './format';
import type { Figure, FigureContext } from './strength';

/** The recent sessions the screen lists, newest first. */
export const RECENT_SESSIONS = 5;

export interface ExerciseAnalyticsOptions {
	period: Period;
	/** The owner's calendar day (ownerToday). */
	today: IsoDate;
}

export interface ExerciseAnalyticsDeps {
	/** The fact reads, for a test to count; the analytics repository on `db` unless given. */
	repository?: AnalyticsRepository;
}

/** A record as shown: its value in kg (reps for 'Most reps'), where it was set, and its text. */
export interface ShownRecord {
	value: number;
	text: string;
	on: IsoDate;
	workoutId: string;
}

/** The heaviest load lifted for a rep count, and the record it beat (null for a first lift). */
export interface RepMaxRow {
	reps: number;
	/** Null when the rep count was never lifted with a load. */
	record: (ShownRecord & { setId: string }) | null;
	previous: ShownRecord | null;
}

export type ExercisePr = StrengthPr & { text: string; previousText: string };

/** A session's top set, in the period or the week in progress. */
export interface ShownTopSet {
	workoutId: string;
	on: IsoDate;
	inProgress: boolean;
	kg: number | null;
	reps: number | null;
	/** '100 kg × 5'; reps alone without a load. */
	text: string;
}

/** A recent completed workout of the lift, with its working sets, on the owner's day. */
export type RecentSession = Performance & { on: IsoDate };

export interface ExerciseAnalytics {
	window: PeriodWindow;
	trendWindow: TrendWindow;
	units: DisplayUnits;
	exercise: ExerciseDef & { custom: boolean; retired: boolean };
	/** Counted sessions of the lift ever, against the e1RM trend's least data (2 sessions). */
	availability: Availability;
	e1rm: Figure & { markers: (MaxPoint & { text: string })[] };
	topSets: FigureContext & { sessions: ShownTopSet[] };
	/** One row for each rep count from 1 to PR_MAX_REPS. */
	repMaxes: RepMaxRow[];
	/** Every e1RM and session-volume PR, oldest first. */
	prs: { e1rm: ExercisePr[]; volume: ExercisePr[] };
	rpeDeviation: Figure;
	recent: RecentSession[];
}

const within = (day: IsoDate, range: Pick<WeekRange, 'from' | 'to'> | null) =>
	range !== null && range.from <= day && day <= range.to;

const earliest = (...days: (IsoDate | undefined)[]) =>
	days.filter((day) => day !== undefined).sort()[0]!;

function availabilityOf(id: MetricId, have: number): Availability {
	const { need, unit } = METRICS[id].minData;
	return have >= need ? { ready: true } : { ready: false, have, need, unit };
}

function contextOf(id: MetricId, have: number): FigureContext {
	const { label, kind, method, caveat } = METRICS[id];
	return { metric: id, label, kind, method, caveat, availability: availabilityOf(id, have) };
}

/** The lift's sessions (live sets by workout) in order, each on the day its first set fell. */
function sessionsOf(sets: readonly SetFact[], timeZone: string) {
	return [...Map.groupBy(sets, (set) => set.workoutId)]
		.map(([workoutId, own]) => {
			const at = Math.min(...own.map((set) => set.performedAt.getTime()));
			return { workoutId, at, on: localDay(new Date(at), timeZone), sets: own };
		})
		.sort((a, b) => a.at - b.at || a.workoutId.localeCompare(b.workoutId));
}

export async function getExerciseAnalytics(
	db: Executor,
	ownerId: string,
	exerciseId: string,
	{ period, today }: ExerciseAnalyticsOptions,
	{ repository }: ExerciseAnalyticsDeps = {}
): Promise<ExerciseAnalytics> {
	if (!isUuid(exerciseId)) throw new TrainingNotFoundError('exercise');
	const lift = (await getExercisesByIds(ownerId, [exerciseId], { db })).get(exerciseId);
	if (!lift) throw new TrainingNotFoundError('exercise');

	const profile = await getAthleteProfile(ownerId, { db });
	const { timeZone } = profile;
	const units = displayUnits(profile);
	const format = formatIn(units);
	const loader = (from: IsoDate, to: IsoDate) =>
		createFactsLoader(db, ownerId, { from, to, timeZone }, { repository });

	const first = await loader(today, today).firstActivity();
	const window = periodWindow(today, period, first);
	const trend = trendWindow(window);
	const { inProgress } = window;
	const from = earliest(
		window.weeks?.from,
		trend.weeks?.from,
		window.previous?.from,
		sameDaysLastWeek(inProgress).from
	);
	const facts = loader(from, today);
	const own = (sets: SetFact[]) => sets.filter((set) => set.exercise === exerciseId);
	const sets = own(await facts.sets());
	const sessions = await facts.sessions();
	const prescriptions = await facts.prescriptions();
	const baselines = await facts.baselines();
	const earlier =
		first !== null && first < from ? own(await loader(first, addDays(from, -1)).sets()) : [];
	const history = [...earlier, ...sets];
	const counted = new Set(history.map((set) => set.workoutId));
	const performances = await getLastPerformances(
		ownerId,
		exerciseId,
		{ count: MAX_LAST_PERFORMANCES },
		{ db }
	);

	// ---- the weeks read and the figure builder (as strength.ts builds its figures)
	const lastSunday = addDays(inProgress.weekStart, -1);
	const count = daysBetween(from, inProgress.weekStart) / 7;
	const loaded = count > 0 ? { from, to: lastSunday, count } : null;
	const show = (id: MetricId, value: number) => format(METRICS[id], value, 'value');
	const signed = (id: MetricId, value: number) =>
		`${value > 0 ? '+' : value < 0 ? '−' : ''}${format(METRICS[id], Math.abs(value), 'delta')}`;

	function figure(
		id: MetricId,
		weekly: SeriesPoint[],
		valueOf: (range: WeekRange) => number | null,
		have: (range: WeekRange | null) => number,
		text: (id: MetricId, value: number) => string = show
	): Figure {
		const context = contextOf(id, have(window.weeks));
		const at = (range: WeekRange | null) =>
			context.availability.ready && range ? valueOf(range) : null;
		const value = at(window.weeks);
		const { previous } = window;
		const shown = weekly.filter((p) => p.inProgress || within(p.at, window.weeks));
		const bucketed = window.bucket === 'month' ? byMonth(shown) : shown;
		return {
			...context,
			value: value === null ? null : { text: text(id, value), value },
			comparison: kpi(
				id,
				{ value, weeks: window.weeks },
				previous && { value: at(previous), weeks: previous },
				format
			),
			trend: trendOf(id, availabilityOf(id, have(trend.weeks)).ready ? weekly : [], window),
			goodness: goodness(id, value),
			series: bucketed.map((p) => ({ ...p, text: p.value === null ? null : text(id, p.value) }))
		};
	}

	// ---- e1RM: each week's best session estimate, and the profile's maxes beside it
	const points = e1rmSeries(sets, lift, timeZone);
	const best = new Map<IsoDate, number>();
	for (const { on, value } of points) {
		best.set(mondayOf(on), Math.max(best.get(mondayOf(on)) ?? value, value));
	}
	const pointsIn = (range: WeekRange | null) => points.filter((p) => within(p.on, range));
	const e1rm = {
		...figure(
			'e1rm',
			fillWeeks(best, loaded, 'gap', inProgress),
			(range) =>
				pointsIn(range).reduce<number | null>((top, p) => Math.max(top ?? p.value, p.value), null),
			(range) => pointsIn(range).length
		),
		markers: measuredMaxes(baselines)
			.filter((max) => lift.baselineLift !== null && max.lift === lift.baselineLift)
			.map((max) => ({ ...max, text: weight(max.kg, units).text }))
	};

	// ---- top sets over the period and the week in progress
	const shownFrom = window.weeks?.from ?? inProgress.weekStart;
	const tops = topSetsOf(sets, lift, timeZone)
		.filter((top) => top.on >= shownFrom)
		.map(({ workoutId, on, kg, reps }) => ({
			...{ workoutId, on, inProgress: on >= inProgress.weekStart, kg, reps },
			text:
				kg === null
					? `${reps ?? 0} reps`
					: `${weight(kg, units).text}${reps === null ? '' : ` × ${reps}`}`
		}));

	// ---- records: rep maxes walked session by session, as prTimeline judges them
	const recordAt = (value: number, on: IsoDate, workoutId: string): ShownRecord => ({
		...{ value, on, workoutId },
		text: weight(value, units).text
	});
	const repMaxes = new Map<number, RepMaxRow>();
	for (const session of sessionsOf(history, timeZone)) {
		const competing = session.sets.filter((set) => prCandidates(set, lift).includes('rep_max'));
		for (const { reps, weightKg, set } of personalRecords(competing)) {
			const held = repMaxes.get(reps)?.record ?? null;
			if (held && !above(weightKg, held.value)) continue;
			const record = { ...recordAt(weightKg, session.on, session.workoutId), setId: set.id };
			const previous = held && recordAt(held.value, held.on, held.workoutId);
			repMaxes.set(reps, { reps, record, previous });
		}
	}
	const shownPr = (pr: StrengthPr, value: number) =>
		pr.kind === 'most_reps' ? `${value} reps` : weight(value, units).text;
	const prs = prTimeline(history, lift, timeZone).map((pr) => ({
		...pr,
		text: shownPr(pr, pr.value),
		previousText: shownPr(pr, pr.previous.value)
	}));

	// ---- RPE against each set's target, where the lift was prescribed
	const byWorkout = Map.groupBy(await facts.sets(), (set) => set.workoutId);
	const exposures: Exposure[] = sessions.flatMap((session) => {
		const planned = session.plannedSessionId && prescriptions.get(session.plannedSessionId);
		if (session.kind !== 'strength' || !planned) return [];
		const logged = (byWorkout.get(session.id) ?? []).toSorted(
			(a, b) => a.setIndex - b.setIndex || a.performedAt.getTime() - b.performedAt.getTime()
		);
		return planned
			.filter((lines) => lines.exerciseId === exerciseId)
			.map((lines) =>
				exposure(matchPrescription(lines, logged, { unit: profile.weightUnit }), session.date)
			);
	});
	const exposuresIn = (range: WeekRange | null) => exposures.filter((e) => within(e.day, range));
	const deviationWeeks = Object.entries(rpeDeviationSummary(exposures).byWeek).flatMap(
		([week, { mean }]) => (mean === null ? [] : [[week, mean] as const])
	);
	const rpeDeviation = figure(
		'rpe_deviation',
		fillWeeks(new Map(deviationWeeks), loaded, 'gap', inProgress),
		(range) => rpeDeviationSummary(exposuresIn(range)).overall.mean,
		(range) => rpeDeviationSummary(exposuresIn(range)).overall.count,
		signed
	);

	return {
		window,
		trendWindow: trend,
		units,
		exercise: { ...lift, custom: lift.key === null, retired: lift.retiredAt !== null },
		availability: availabilityOf('e1rm', counted.size),
		e1rm,
		topSets: { ...contextOf('top_set', tops.length), sessions: tops },
		repMaxes: Array.from({ length: PR_MAX_REPS }, (_, i) => {
			return repMaxes.get(i + 1) ?? { reps: i + 1, record: null, previous: null };
		}),
		prs: {
			e1rm: prs.filter((pr) => pr.kind === 'e1rm'),
			volume: prs.filter((pr) => pr.kind === 'volume')
		},
		rpeDeviation,
		recent: performances
			.filter((p) => p.status === 'completed' && counted.has(p.workoutId))
			.slice(0, RECENT_SESSIONS)
			.map((p) => ({ ...p, on: localDay(p.startedAt, timeZone) }))
	};
}
