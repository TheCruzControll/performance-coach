/**
 * What Train renders on the server: the owner's current program and one week of it, from the
 * owner's own today (ownerToday). Kept out of +page.server.ts so integration tests can run it
 * with an unreachable database.
 *
 * - `?week=n` is the program's week n, counted from week 1 past the plan's end too, so a week
 *   beyond the planned weeks is 'not planned yet' (its outline phase, if any). Anything else
 *   (absent, 0, 'abc', 1000) is the current week, never an error: WEEK_PARAM below.
 * - The current week is the one that holds today: week 1 before the program starts, and past the
 *   planned weeks the 'first block complete' view (`asked` false, `program.blockComplete`).
 * - With no program, whether the training profile is complete picks the empty state's next step.
 * - It fails soft: a read that fails is recorded as a server error (kind 'load') and Train shows
 *   its designed error with Retry, inside the shell, instead of the 500 page.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import { daysBetween } from '#lib/domain/calendar.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import { getOnboarding } from '#lib/server/services/profile/index.ts';
import {
	getCurrentProgram,
	getTrainingWeek,
	type CurrentProgram,
	type TrainingWeek
} from '#lib/server/services/programs/index.ts';
import type { TrainingDeps } from '#lib/server/services/training/shared.ts';
import { shortDate, type StripDayView } from '#lib/ui/program/words.ts';
import {
	BASELINE_BRIEF,
	blockCompleteCard,
	ERROR_CARD,
	noProgramCard,
	notPlannedCard,
	weekWords,
	type StateCard,
	type TrainDay
} from './cards.server';

/**
 * A week number Train accepts in ?week: a whole number from 1 to 999 (a plan is a few blocks of
 * weeks; services allow up to 1000). Decision (m3 plan): a malformed value shows the current week.
 */
const WEEK_PARAM = /^[1-9]\d{0,2}$/;

export type TrainWeekData =
	| { state: 'none'; today: IsoDate; profileComplete: boolean; card: StateCard }
	| { state: 'error'; card: StateCard }
	| {
			state: 'program';
			today: IsoDate;
			program: CurrentProgram;
			week: TrainingWeek;
			/** The week shown, by its number in the program (1 is week 1). */
			shown: number;
			/** Every week from week 1 to the end of the program's last block, outline included. */
			totalWeeks: number;
			/** ?week named the week shown; false for the current week. */
			asked: boolean;
			/** Its block and place: 'Baseline week · Week 1 of 5', 'Week 9 · Not planned yet'. */
			position: string;
			/** 'Starts Mon 9 Nov' before the program starts, else null. */
			status: string | null;
			/** The week in words, Monday first (both empty for a week that is not planned). */
			strip: StripDayView[];
			days: TrainDay[];
			/** Week 1's brief, in a baseline week only. */
			brief: typeof BASELINE_BRIEF | null;
			/** In place of the week's sessions: first block complete, or not planned yet. */
			card: StateCard | null;
	  };

export interface TrainRequest {
	now: Date;
	/** The ?week parameter as given. */
	week: string | null;
	/** What a recorded failure carries: the request's id, method, path, route and app version. */
	origin: Pick<ServerErrorInput, 'requestId' | 'method' | 'path' | 'routeId' | 'appVersion'>;
}

export interface TrainLoadDeps extends Pick<TrainingDeps, 'db'> {
	/** Where a failure is recorded (app_errors): the app's database unless given. */
	errorsDb?: TrainingDeps['db'];
}

/** The week number in `param`, or null for the current week. */
const weekParam = (param: string | null) =>
	param !== null && WEEK_PARAM.test(param) ? Number(param) : null;

/** A week's number in the program, from its Monday. */
const weekNumber = (program: CurrentProgram, monday: IsoDate) =>
	daysBetween(program.startsOn, monday) / 7 + 1;

export async function loadTrainWeek(
	ownerId: string,
	{ now, week, origin }: TrainRequest,
	{ db, errorsDb }: TrainLoadDeps = {}
): Promise<TrainWeekData> {
	try {
		const today = await ownerToday(ownerId, now, { db });
		const program = await getCurrentProgram(ownerId, today, { db });
		if (!program) {
			const { complete } = await getOnboarding(ownerId, { db });
			return { state: 'none', today, profileComplete: complete, card: noProgramCard(complete) };
		}
		const asked = weekParam(week);
		const shown = await getTrainingWeek(
			ownerId,
			asked === null ? { date: today } : { block: 1, week: asked },
			{},
			{ db }
		);
		// getCurrentProgram found the program a moment ago; only a concurrent archive removes it.
		if (!shown) throw new Error('the active program disappeared while Train loaded');
		const lastDay = program.blocks.reduce((end, b) => (b.endsOn > end ? b.endsOn : end), '');
		const number = weekNumber(program, shown.startsOn);
		const complete = asked === null && program.blockComplete;
		return {
			state: 'program',
			today,
			program,
			week: shown,
			shown: number,
			totalWeeks: (daysBetween(program.startsOn, lastDay) + 1) / 7,
			asked: asked !== null,
			position: shown.planned
				? `${shown.blockName} · Week ${shown.number} of ${program.plannedWeeks}`
				: complete
					? 'First block complete'
					: `Week ${number} · Not planned yet`,
			status: program.notStarted ? `Starts ${shortDate(program.firstPlannedDay)}` : null,
			...(shown.planned ? weekWords(shown, today) : { strip: [], days: [] }),
			brief: shown.planned && shown.kind === 'baseline' ? BASELINE_BRIEF : null,
			card: shown.planned
				? null
				: complete
					? blockCompleteCard(program, shown.phase)
					: notPlannedCard(number, shown.phase)
		};
	} catch (error) {
		await recordServerError(
			{ error, kind: 'load', status: 500, ...origin, context: { load: 'train' } },
			{ db: errorsDb }
		);
		return { state: 'error', card: ERROR_CARD };
	}
}
