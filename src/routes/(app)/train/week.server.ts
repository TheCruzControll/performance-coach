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
 * - The week as Instrument v2 says it (v2/07, week-lines.ts): its place ('Week 3 of 14 · Build'),
 *   its title ('This week'), what is done, one line per session, the arrows' links, and the one
 *   line under it that opens the week's note (`note`, `noteParts`).
 * - A bridge week (unplanned, between blocks: M6's late start) is a state card with the day the
 *   next block starts, never seven rest days, and lists what was logged in it as off-plan lines.
 * - A planned week a weekly review changed carries the notice's words (week-changes.ts): each
 *   change and its why, the version that applied it and the review. 'First block complete' leads
 *   to the last planned block's cycle review, or to the reviews list that creates it.
 * - A planned week still ahead carries its findings (m7/04, services/periodisation/evaluate.ts):
 *   each finding once in the week's note, and their count as the week's line. An evaluation that
 *   fails is recorded (part 'periodisation') and the week renders without them.
 * - Every session of a planned week a decision names says why it is on its day (m7/14,
 *   services/periodisation/explain.ts), read before the findings, which take the generator's
 *   priority trade-offs from it. A read that fails is recorded (part 'why') and the week renders
 *   its findings without the why.
 * - A deload, taper, event, recovery, cutback or maintenance week still ahead names its kind
 *   with one line of why and any event's countdown (m7/38, services/periodisation/week-line.ts).
 *   A read that fails is recorded (part 'weekLine') and the week renders without it.
 * - The number of goals the season's lanes list (m7/39), so the plan sheet reserves their room
 *   while the season streams (road.server.ts, from +page.server.ts).
 * - With no program, whether the training profile is complete picks the empty state's next step.
 *   A program exists only once onboarding is complete (the build refuses it before), so a running
 *   program never shows before the owner's setup is done.
 * - Until its first planned day has passed, Train offers Start date (/train/start).
 * - An open re-plan that the goal priorities asked for (source goal_priority) is named by
 *   the week's note (`noteParts.replan`), linking to its proposal. Never the plan. A read that fails is recorded (part 'replanNote') and the week renders without it.
 * - It fails soft: a read that fails is recorded as a server error (kind 'load') and Train shows
 *   its designed error with Retry, inside the shell, instead of the 500 page.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import { daysBetween } from '#lib/domain/calendar.ts';
import type { Goal } from '#lib/domain/profile/types.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import type { ContextDeps } from '#lib/server/services/periodisation/context.ts';
import {
	getWeekEvaluation,
	type FindingNote,
	type WeekAt,
	type WeekFindingsView
} from '#lib/server/services/periodisation/evaluate.ts';
import {
	getPlacementWhy,
	type PlacementAt,
	type PlacementWhyView
} from '#lib/server/services/periodisation/explain.ts';
import { getOpenReplan } from '#lib/server/services/periodisation/propose.ts';
import {
	getWeekLine,
	type WeekLineAt,
	type WeekLineView
} from '#lib/server/services/periodisation/week-line.ts';
import { getOnboarding, listGoals } from '#lib/server/services/profile/index.ts';
import {
	getCurrentProgram,
	getTrainingWeek,
	weekChanges,
	type CurrentProgram,
	type TrainingWeek
} from '#lib/server/services/programs/index.ts';
import { DEFAULT_INTENT } from '#lib/domain/programming/rules/added.ts';
import { PHASE_LABEL } from '#lib/domain/training/vocabulary.ts';
import { SESSIONS_A_DAY } from '#lib/server/services/programs/edits.ts';
import { getLiveCycleReview } from '#lib/server/services/reviews/index.ts';
import { getSessionsInRange } from '#lib/server/services/training/history.ts';
import type { TrainingDeps } from '#lib/server/services/training/shared.ts';
import { timelineView, type TimelineBlock } from '#lib/ui/program/timeline.ts';
import {
	headsUps,
	weekLines,
	weekNote,
	weekPosition,
	weekStatus,
	weekTitle,
	type WeekLine
} from '#lib/ui/program/week-lines.ts';
import {
	BASELINE_BRIEF,
	blockCompleteCard,
	bridgeCard,
	ERROR_CARD,
	noProgramCard,
	notPlannedCard,
	offPlanLine,
	reviewNotice,
	whyWords,
	type AsidePanel,
	type CardWhy,
	type NextBlock,
	type StateCard
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
			/** The top line: 'Week 3 of 14 · Build', 'Week 9 · Peak', 'Between blocks'. */
			position: string;
			/** 'This week', 'Last week', 'Next week' or 'Week 9'. */
			title: string;
			/** What is done ('Four of six done'), or 'Starts Monday 23 November'; null off a planned week. */
			status: string | null;
			/** The week shown holds today (before the program starts, week 1 does). */
			current: boolean;
			/** The arrows' links: the weeks either side, or null at either end. */
			previous: string | null;
			next: string | null;
			/**
			 * Its start may still move (Start date, /train/start): its first planned day is today or
			 * later. A workout logged before then also keeps it, which that screen says.
			 */
			movable: boolean;
			/** The week as lines, Monday first (week-lines.ts); empty for a week that is not planned. */
			lines: WeekLine[];
			/** The one line under the week, and whether it opens the week's note; null for none. */
			note: { text: string; opens: boolean } | null;
			/** What the week's note holds, each part present or empty. */
			noteParts: NoteParts;
			/** In place of the week's sessions: first block complete, not planned yet, or a bridge. */
			card: StateCard | null;
			/** A bridge week's logged workouts as lines, oldest first (none in any other week). */
			offPlan: WeekLine[];
			/** The whole plan in words, for the plan overview. */
			plan: TimelineBlock[];
			/** The goals the season gives a lane in each block (laneCount), reserved while it streams. */
			openGoals: number;
			/** The current version's number: what an add (Add session) is made on. */
			version: number;
			/**
			 * The days of the week an owner can add a session to (AddSessionSheet): today or later, from
			 * the program's first planned day, with fewer than SESSIONS_A_DAY sessions. Empty unless the
			 * week is a planned week of the current version (not an outline or a bridge week).
			 */
			addable: IsoDate[];
			/** The effort an add takes until the owner picks one, by kind (rules/added.ts). */
			addIntents: typeof DEFAULT_INTENT;
	  };

/**
 * The week's note, behind the one line under its lines (v2/07): each part present only when the
 * week has it, and the findings' line itself.
 */
export interface NoteParts {
	/** The findings counted ('1 heads-up this week', 'No clashes this week'); null when not read. */
	summary: string | null;
	/** A light or special week still ahead: 'Deload week', and why (m7/38). */
	kind: { label: string; why: string } | null;
	/** The week's findings, each once, in the week's order (m7/04). */
	findings: FindingNote[];
	/** What a weekly review changed in it. */
	review: AsidePanel | null;
	/** Week 1's brief, in a baseline week. */
	baseline: AsidePanel | null;
	/** The open re-plan the goal priorities asked for: its proposal's page. */
	replan: { href: string } | null;
	/** Why each session is on its day (m7/14), in the week's order. */
	why: CardWhy[];
}

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
	/** The open re-plan read behind `replanNote`, from `db` unless given its own (a test's fault). */
	replanNote?: Pick<TrainingDeps, 'db'>;
	/**
	 * The week's findings and why: on by default, read from `db` unless given its own (and the why
	 * from `why.db` when given). false skips every M7 read: only the explain harness turns it off,
	 * to time Train's own path.
	 */
	periodisation?:
		| false
		| (Pick<TrainingDeps, 'db'> & {
				why?: Pick<TrainingDeps, 'db'>;
				/** The week-kind line (m7/38). */
				line?: Pick<TrainingDeps, 'db'>;
				/** The evaluation context's reads (context.ts), for a test to fail or stall. */
				context?: Pick<ContextDeps, 'repository' | 'reader' | 'statementTimeoutMs'>;
		  });
}

/**
 * How many goals the season gives a lane in a block: the active goals, or with every open goal
 * paused the paused ones (M3's shaping goals, which the road's modes cover).
 */
const laneCount = (goals: readonly Pick<Goal, 'status'>[]) =>
	goals.filter((g) => g.status === 'active').length ||
	goals.filter((g) => g.status === 'paused').length;

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
	today: IsoDate,
	db: TrainingDeps['db']
): Promise<WeekLine[]> {
	const { logged } = await getSessionsInRange(
		ownerId,
		{ from: week.startsOn, to: week.endsOn },
		{ db }
	);
	return logged.filter((w) => w.status === 'completed').map((w) => offPlanLine(w, today));
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

/** The week's kind line, or null when reading it failed: recorded. */
const lineOf = (ownerId: string, at: WeekLineAt, deps: PartDeps): Promise<WeekLineView | null> =>
	softly('weekLine', () => getWeekLine(ownerId, at, { db: deps.db }), deps);

/**
 * The open re-plan a goal priority proposed, named by its id (Train's one line), or null. The
 * owner's newest open replan is the only one read; any other source is not Train's note.
 */
const replanNoteOf = async (ownerId: string, db: TrainingDeps['db']) => {
	const open = await getOpenReplan(ownerId, { db });
	return open?.origin?.kind === 'goal_priority' ? { proposalId: open.id } : null;
};

/** The kind line in words: its why, then any countdown. */
const kindWords = ({ label, why, countdown }: NonNullable<WeekLineView['line']>) => ({
	label,
	why: countdown ? `${why} · ${countdown}` : why
});

/** The `?week=` link to the program's week `n`. */
const weekHref = (n: number) => `/train?week=${n}`;

export async function loadTrainWeek(
	ownerId: string,
	{ now, week, origin }: TrainRequest,
	{ db, errorsDb, periodisation = {}, replanNote: replanDeps }: TrainLoadDeps = {}
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
		const offPlan = bridge ? await offPlanIn(ownerId, shown, today, db) : [];
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
		const goals = await listGoals(ownerId, { db });
		const lineAt = { programId: program.id, version: shown.version.number, today, goals };
		// Only a planned week still ahead shows its kind line: any other reads none.
		const kinds =
			at && m7 && shown.endsOn >= today
				? await lineOf(
						ownerId,
						{ ...lineAt, weekStartsOn: shown.startsOn },
						{ ...m7, db: periodisation.line?.db ?? m7.db }
					)
				: null;
		const line = kinds?.line;
		const planned = shown.planned && !bridge ? shown : null;
		const totalWeeks = (daysBetween(program.startsOn, lastDay) + 1) / 7;
		const lastBlock = program.blocks.findLast((b) => b.plannedWeeks > 0)?.name ?? 'last block';
		const sessions = planned ? planned.days.flatMap((d) => d.sessions) : [];
		const lineages = sessions.map((s) => s.lineage);
		const replan = await softly('replanNote', () => replanNoteOf(ownerId, replanDeps?.db ?? db), {
			db,
			errorsDb,
			origin
		});
		const reasons = why?.byLineage ?? {};
		const noteParts: NoteParts = {
			summary: findings?.summary ?? null,
			kind: line ? kindWords(line) : null,
			findings: headsUps(findings?.notes ?? {}, lineages),
			review: changes ? reviewNotice(changes) : null,
			baseline: planned?.kind === 'baseline' ? BASELINE_BRIEF : null,
			replan: replan && { href: `/coach/proposals/${replan.proposalId}` },
			why: sessions.flatMap((s) => (reasons[s.lineage] ? [whyWords(reasons[s.lineage]!, s)] : []))
		};
		return {
			state: 'program',
			today,
			program,
			week: shown,
			shown: number,
			totalWeeks,
			asked: asked !== null,
			position: bridge
				? 'Between blocks'
				: shown.planned
					? weekPosition(number, totalWeeks, shown.blockName)
					: complete
						? 'First block complete'
						: weekPosition(number, null, shown.phase ? PHASE_LABEL[shown.phase] : null),
			title: weekTitle(shown.startsOn, today, number),
			status: planned ? weekStatus(planned.days, today, program.firstPlannedDay) : null,
			current:
				(shown.startsOn <= today && today <= shown.endsOn) || (program.notStarted && number === 1),
			previous: number > 1 ? weekHref(Math.min(number - 1, totalWeeks)) : null,
			next: number < totalWeeks ? weekHref(number + 1) : null,
			movable: today <= program.firstPlannedDay,
			lines: planned ? weekLines(planned.days, today) : [],
			note: weekNote({
				summary: noteParts.summary,
				findings: noteParts.findings.length,
				review: !!noteParts.review,
				kind: noteParts.kind?.label ?? null,
				baseline: !!noteParts.baseline,
				replan: !!noteParts.replan,
				why: noteParts.why.length > 0
			}),
			noteParts,
			card: bridge
				? bridgeCard(bridge)
				: shown.planned
					? null
					: complete
						? blockCompleteCard(
								{ ...program, name: lastBlock, weeks: program.plannedWeeks },
								shown.phase,
								await cycleReviewKey(ownerId, program, db)
							)
						: notPlannedCard(number, shown.phase, lastBlock),
			offPlan,
			version: shown.version.number,
			addIntents: DEFAULT_INTENT,
			addable: planned
				? planned.days
						.filter(
							(d) =>
								d.date >= today &&
								d.date >= program.firstPlannedDay &&
								d.sessions.length < SESSIONS_A_DAY
						)
						.map((d) => d.date)
				: [],
			plan: timelineView(program, { today, goals }),
			openGoals: laneCount(goals)
		};
	} catch (error) {
		await recordServerError(
			{ error, kind: 'load', status: 500, ...origin, context: { load: 'train' } },
			{ db: errorsDb }
		);
		return { state: 'error', card: ERROR_CARD };
	}
}
