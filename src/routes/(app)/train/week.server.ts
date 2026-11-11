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
 * - The whole plan, for the plan overview: each block with its weeks, this week, the weeks not
 *   planned yet and the dated goals the plan leads to (timeline.ts).
 * - A bridge week (unplanned, between blocks: M6's late start) is a state card with the day the
 *   next block starts, never seven rest days, and lists what was logged in it as off-plan.
 * - A planned week a weekly review changed carries the notice's words (week-changes.ts): each
 *   change and its why, the version that applied it and the review. 'First block complete' leads
 *   to the last planned block's cycle review, or to the reviews list that creates it.
 * - A planned week still ahead carries its findings (m7/04, services/periodisation/evaluate.ts):
 *   a note on each card a finding names, and the week line. An evaluation that fails is recorded
 *   (part 'periodisation') and the week renders without them.
 * - Every card of a planned week a decision names says why it is on its day (m7/14,
 *   services/periodisation/explain.ts), read before the findings, which take the generator's
 *   priority trade-offs from it. A read that fails is recorded (part 'why') and the week renders
 *   its findings without the disclosures.
 * - With no program, whether the training profile is complete picks the empty state's next step.
 * - It fails soft: a read that fails is recorded as a server error (kind 'load') and Train shows
 *   its designed error with Retry, inside the shell, instead of the 500 page.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import { daysBetween } from '#lib/domain/calendar.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import type { ContextDeps } from '#lib/server/services/periodisation/context.ts';
import {
	getWeekEvaluation,
	type WeekAt,
	type WeekFindingsView
} from '#lib/server/services/periodisation/evaluate.ts';
import {
	getPlacementWhy,
	type PlacementAt,
	type PlacementWhyView
} from '#lib/server/services/periodisation/explain.ts';
import { getOnboarding, listGoals } from '#lib/server/services/profile/index.ts';
import {
	getCurrentProgram,
	getTrainingWeek,
	weekChanges,
	type CurrentProgram,
	type TrainingWeek
} from '#lib/server/services/programs/index.ts';
import { getLiveCycleReview } from '#lib/server/services/reviews/index.ts';
import { getSessionsInRange } from '#lib/server/services/training/history.ts';
import type { TrainingDeps } from '#lib/server/services/training/shared.ts';
import { timelineView, type TimelineBlock } from '#lib/ui/program/timeline.ts';
import { shortDate, type StripDayView } from '#lib/ui/program/words.ts';
import {
	BASELINE_BRIEF,
	blockCompleteCard,
	bridgeCard,
	ERROR_CARD,
	noProgramCard,
	notPlannedCard,
	offPlanCard,
	reviewNotice,
	weekWords,
	whyWords,
	type AsidePanel,
	type NextBlock,
	type OffPlanWorkout,
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
			/** Its findings counted: on a planned week still ahead, else null (week line). */
			weekLine: string | null;
			/** The side column: week 1's brief in a baseline week, then what a review changed. */
			aside: AsidePanel[];
			/** In place of the week's sessions: first block complete, not planned yet, or a bridge. */
			card: StateCard | null;
			/** A bridge week's logged workouts, oldest first (none in any other week). */
			offPlan: OffPlanWorkout[];
			/** The whole plan in words, for the plan overview. */
			plan: TimelineBlock[];
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
	/**
	 * The week's findings and why: on by default, read from `db` unless given its own (and the why
	 * from `why.db` when given). false skips every M7 read: only the explain harness turns it off,
	 * to time Train's own path.
	 */
	periodisation?:
		| false
		| (Pick<TrainingDeps, 'db'> & {
				why?: Pick<TrainingDeps, 'db'>;
				/** The evaluation context's reads (context.ts), for a test to fail or stall. */
				context?: Pick<ContextDeps, 'repository' | 'reader' | 'statementTimeoutMs'>;
		  });
}

/** The week number in `param`, or null for the current week. */
const weekParam = (param: string | null) =>
	param !== null && WEEK_PARAM.test(param) ? Number(param) : null;

/** A week's number in the program, from its Monday. */
const weekNumber = (program: CurrentProgram, monday: IsoDate) =>
	daysBetween(program.startsOn, monday) / 7 + 1;

/** The block a bridge week leads to, from the day it starts. */
function nextBlockOf(program: CurrentProgram, startsOn: IsoDate): NextBlock {
	const name = program.blocks.find((b) => b.startsOn === startsOn)?.name ?? 'Next block';
	return { startsOn, name, week: weekNumber(program, startsOn) };
}

/** The key of the live cycle review of the program's last planned block, or null. */
async function cycleReviewKey(ownerId: string, program: CurrentProgram, db: TrainingDeps['db']) {
	const block = program.blocks.findLast((b) => b.plannedWeeks > 0);
	const review = block && (await getLiveCycleReview(ownerId, program.id, block.lineage, { db }));
	return review ? `c-${review.id}` : null;
}

/** The completed workouts logged in `week`, none of them on a plan (a bridge plans nothing). */
async function offPlanIn(
	ownerId: string,
	week: Pick<TrainingWeek, 'startsOn' | 'endsOn'>,
	db: TrainingDeps['db']
): Promise<OffPlanWorkout[]> {
	const { logged } = await getSessionsInRange(
		ownerId,
		{ from: week.startsOn, to: week.endsOn },
		{ db }
	);
	return logged.filter((w) => w.status === 'completed').map(offPlanCard);
}

type PartDeps = Pick<TrainLoadDeps, 'db' | 'errorsDb'> &
	Pick<TrainRequest, 'origin'> & {
		context?: Pick<ContextDeps, 'repository' | 'reader' | 'statementTimeoutMs'>;
	};

/** `read`'s result, or null when it failed: recorded as Train's `part`, and the week renders. */
async function softly<T>(part: string, read: () => Promise<T>, { errorsDb, origin }: PartDeps) {
	try {
		return await read();
	} catch (error) {
		const context = { load: 'train', part };
		await recordServerError(
			{ error, kind: 'load', status: 500, ...origin, context },
			{ db: errorsDb }
		);
		return null;
	}
}

/** The week's findings, or null when reading them failed: recorded, and the week renders. */
const findingsOf = (
	ownerId: string,
	at: WeekAt,
	deps: PartDeps
): Promise<WeekFindingsView | null> =>
	softly(
		'periodisation',
		() => {
			const { db, errorsDb, origin, context } = deps;
			return getWeekEvaluation(ownerId, at, { db, errorsDb, origin, ...context });
		},
		deps
	);

/** Why each session is on its day, or null when reading it failed: recorded. */
const whyOf = (
	ownerId: string,
	at: PlacementAt,
	deps: PartDeps
): Promise<PlacementWhyView | null> =>
	softly('why', () => getPlacementWhy(ownerId, at, { db: deps.db }), deps);

/** Each card with its finding's note and its why, when it has them. */
function withNotes(
	words: ReturnType<typeof weekWords>,
	findings: WeekFindingsView | null,
	why: PlacementWhyView | null
) {
	const notes = findings?.notes ?? {};
	const reasons = why?.byLineage ?? {};
	const days = words.days.map((day) => ({
		...day,
		cards: day.cards.map((card) => ({
			...card,
			...(notes[card.lineage] && { note: notes[card.lineage] }),
			...(reasons[card.lineage] && { why: whyWords(reasons[card.lineage]!) })
		}))
	}));
	return { strip: words.strip, days };
}

export async function loadTrainWeek(
	ownerId: string,
	{ now, week, origin }: TrainRequest,
	{ db, errorsDb, periodisation = {} }: TrainLoadDeps = {}
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
		const bridge =
			shown.planned && shown.nextBlockStartsOn
				? nextBlockOf(program, shown.nextBlockStartsOn)
				: null;
		const offPlan = bridge ? await offPlanIn(ownerId, shown, db) : [];
		const at = shown.planned && !bridge && { programId: program.id, weekLineage: shown.lineage };
		const changes =
			at && (await weekChanges(ownerId, { ...at, version: shown.version.number }, { db }));
		const m7 = periodisation && {
			...{ db: periodisation.db ?? db, errorsDb, origin },
			context: periodisation.context
		};
		const placed = shown.planned
			? shown.days.flatMap((d) => d.sessions.map(({ lineage, date }) => ({ lineage, date })))
			: [];
		const why =
			at && m7
				? await whyOf(
						ownerId,
						{ programId: program.id, sessions: placed },
						{ ...m7, db: periodisation.why?.db ?? m7.db }
					)
				: null;
		const ahead = {
			...{ version: shown.version.number, weekStartsOn: shown.startsOn, today },
			tradeoffs: why?.tradeoffs ?? []
		};
		const findings =
			at && m7 && shown.endsOn >= today ? await findingsOf(ownerId, ahead, m7) : null;
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
			...(shown.planned && !bridge
				? withNotes(weekWords(shown, today), findings, why)
				: { strip: [], days: [] }),
			weekLine: findings?.summary ?? null,
			aside: [
				...(shown.planned && shown.kind === 'baseline' ? [BASELINE_BRIEF] : []),
				...(changes ? [reviewNotice(changes)] : [])
			],
			card: bridge
				? bridgeCard(bridge)
				: shown.planned
					? null
					: complete
						? blockCompleteCard(program, shown.phase, await cycleReviewKey(ownerId, program, db))
						: notPlannedCard(number, shown.phase),
			offPlan,
			plan: timelineView(program, { today, goals: await listGoals(ownerId, { db }) })
		};
	} catch (error) {
		await recordServerError(
			{ error, kind: 'load', status: 500, ...origin, context: { load: 'train' } },
			{ db: errorsDb }
		);
		return { state: 'error', card: ERROR_CARD };
	}
}
