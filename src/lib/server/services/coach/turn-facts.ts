/**
 * What the server knows about the owner's day when a coach turn starts (M5, the turn context):
 * their local date, time and zone, the active program version and its current week through M3's
 * program reads, and a matcher over their exercise library. The agent turns these into the turn's
 * context message (agent/prompt/context.ts); nothing here comes from the model.
 *
 * Queries run one at a time (docs/architecture.md), so the turn may hand this a transaction.
 */
import type { IsoDate } from '../../../domain/calendar';
import { localDay } from '../../../domain/dates';
import { CATALOGUE } from '../../../domain/exercises';
import { matchExercise, type MatchableExercise } from '../../../domain/exercises/match';
import { createProgramsRepository } from '../../db/repositories/programs';
import { listCustomExercises } from '../exercises';
import { getAthleteProfile } from '../profile';
import { getCurrentProgram, getTrainingWeek } from '../programs';
import { resolveDeps, type CoachDeps } from './shared';

export interface PlannedTitle {
	date: IsoDate;
	title: string;
}

export interface ProgramFacts {
	/** The active version: what a segment starts on and its week summary compares with. */
	versionId: string;
	versionNumber: number;
	/** The planned week today falls in, skipped sessions left out; null once the weeks are over. */
	week: { number: number; of: number; sessions: PlannedTitle[] } | null;
	todaysSessions: { title: string }[];
}

export interface TurnDayFacts {
	today: IsoDate;
	/** HH:MM in the owner's zone. */
	localTime: string;
	timeZone: string;
	/** Null when no program is active. */
	program: ProgramFacts | null;
	/** M3's matchExercise over the owner's library (catalogue and custom exercises). */
	matchExercise: (text: string) => string | null;
}

function localTime(instant: Date, timeZone: string): string {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).format(instant);
}

export async function loadTurnFacts(ownerId: string, deps: CoachDeps = {}): Promise<TurnDayFacts> {
	const { db, now } = resolveDeps(deps);
	const at = now();
	const { timeZone } = await getAthleteProfile(ownerId, { db });
	const today = localDay(at, timeZone);

	let program: ProgramFacts | null = null;
	const active = await createProgramsRepository(db).currentProgram(ownerId);
	const current = active && (await getCurrentProgram(ownerId, today, { db }));
	if (active && current) {
		const week = current.blockComplete
			? null
			: await getTrainingWeek(ownerId, { date: today }, {}, { db });
		// A skipped session is no longer planned for the owner.
		const sessions = week?.planned
			? week.days
					.flatMap((day) => day.sessions)
					.filter((session) => session.status !== 'skipped')
					.map(({ date, title }) => ({ date, title }))
			: [];
		program = {
			versionId: active.version.id,
			versionNumber: current.version.number,
			week:
				week?.planned === true ? { number: week.number, of: current.plannedWeeks, sessions } : null,
			todaysSessions: sessions.filter((s) => s.date === today).map(({ title }) => ({ title }))
		};
	}

	const custom = await listCustomExercises(ownerId, { db });
	const library: MatchableExercise[] = [
		...CATALOGUE,
		...custom.map(({ id, name, aliases }) => ({ key: `custom:${id}`, name, aliases }))
	];
	return {
		today,
		localTime: localTime(at, timeZone),
		timeZone,
		program,
		matchExercise: (text) => matchExercise(text, library)
	};
}
