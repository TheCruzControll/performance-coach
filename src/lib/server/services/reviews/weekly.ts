/**
 * Weekly reviews (PRD §11; the M6 plan's weekly-review-service): create, refresh and read one
 * week's review, computed from code alone and stored with its snapshot, with next week's
 * adjustments proposed through M5's proposal lifecycle.
 *
 * - A week is reviewable once it has ended, or earlier once every planned session is completed
 *   or skipped (EARLY_REVIEW). Before that, creating it is a WeeklyReviewNotReviewableError with
 *   the day it becomes available.
 * - Creating is one transaction under the owner's review lock, and idempotent: the live review
 *   of the week is returned as it is. It reads the week's facts and the TRAILING_WEEKS before it,
 *   the week's targets (targets.ts), composes the review, stores it, then turns next week's
 *   adjustments into a program_adjustment on the current version, created with the review's
 *   rules provenance (evidence.source) and linked to it.
 * - A late review (next week has ended), a boundary review (next week is the cycle review's) and
 *   a week no program plans store no proposal; the reason is in the snapshot (noProposal), and
 *   every change the rules could not propose is a 'next' finding with its words.
 * - Refresh only replaces a review that is out of date (its inputs digest differs from today's)
 *   and whose decision is still open: a new revision supersedes it, both rows stay, and an
 *   undecided head proposal is superseded as review_refreshed before the new one is proposed.
 * - The view reads the decision from the proposal chain's head, never the proposal first linked.
 * - Next week's rules read no e1RM trend or latest e1RM: an RPE-based line moves its target RPE,
 *   within the week's RPE cap, and a load moves on its own plates.
 * Every query is awaited in turn, so the whole create or refresh runs on one transaction.
 */
import { addDays, mondayOf, parseIsoDate, type IsoDate } from '../../../domain/calendar';
import type { Exposure } from '../../../domain/analytics/prescribed';
import { ANALYTICS_VERSION } from '../../../domain/analytics/version';
import { RATIONALE_MAX } from '../../../domain/coach/proposals';
import { localDay } from '../../../domain/dates';
import { toExerciseKey } from '../../../domain/programming/input';
import type { Finding } from '../../../domain/programming/review/brief';
import { inputsDigest, type DigestFacts } from '../../../domain/programming/review/digest';
import {
	proposeNextWeek,
	type NextSession,
	type NextWeekExercise,
	type NextWeekProposal
} from '../../../domain/programming/review/next-week';
import type {
	NextWeekState,
	NoProposalReason,
	WeeklyReviewSnapshot
} from '../../../domain/programming/review/snapshot';
import {
	clip,
	composeWeeklyReview,
	TRAILING_WEEKS,
	type ReviewExercise,
	type ReviewPlannedSession,
	type WeeklyReviewInput
} from '../../../domain/programming/review/weekly';
import { estimateMinutes } from '../../../domain/programming/timefit';
import type { ExerciseRef } from '../../../domain/training/types';
import { cleanFloat } from '../../../domain/units';
import { getDb, type Executor } from '../../db';
import { createCoachProposalsRepository } from '../../db/repositories/coach-proposals';
import { createProgramsRepository } from '../../db/repositories/programs';
import { createReviewsRepository } from '../../db/repositories/reviews';
import { createFactsLoader, createQueue, type DatedSession } from '../analytics/facts';
import { displayUnits, formatIn } from '../analytics/format';
import { getMuscleTargets } from '../analytics/targets';
import { createProposal, getProposalView, type ProposalView } from '../coach/proposals';
import { getExercisesByIds, resolveKeys, type ExerciseDef } from '../exercises/index';
import { getAthleteProfile } from '../profile/index';
import { programmingInputFor } from '../programs/alternatives';
import { getProgramVersion, type StoredSession, type StoredWeek } from '../programs/index';
import {
	decisionOf,
	getLiveWeeklyReview,
	getWeeklyReview,
	linkProposal,
	proposalHead,
	ReviewInputError,
	ReviewNotFoundError,
	ReviewSupersededError,
	stale,
	storeWeeklyReview,
	supersedeWeeklyReview,
	type DecisionState,
	type ReviewDeps,
	type StoredWeeklyReview
} from './store';

/**
 * Owner decision (m6-plan open question 'early review'): a week is reviewable before its Sunday
 * once every planned session is completed or skipped. false: only after the week ends.
 */
export const EARLY_REVIEW = true;

/** The proposal's title, as M5's card and inbox show it. */
export const PROPOSAL_TITLE = "Next week's changes from your weekly review";

/** The decisions a refresh may replace: nothing the owner has settled yet. */
export const REFRESHABLE: readonly DecisionState['state'][] = ['undecided', 'partly_past', 'none'];

/** Why a review proposes nothing for next week, in the owner's words. */
export const NO_PROPOSAL_WORDS: Record<NoProposalReason, string> = {
	late: 'Next week has already ended, so there is nothing left to change.',
	boundary: 'Next week starts a new block: your cycle review plans it.',
	no_program: 'No program plans this week, so there is nothing to adjust.',
	no_changes: 'Next week stays as planned: nothing in this week calls for a change.'
};

export type ReviewableReason = 'ended' | 'all_done';

/** The week is not over and not all done yet; nothing was written. */
export class WeeklyReviewNotReviewableError extends Error {
	readonly reason = 'not_reviewable';
	/** The first day the week is reviewable whatever is logged: the Monday after it. */
	readonly availableOn: IsoDate;
	constructor(availableOn: IsoDate) {
		super(`the week is reviewable from ${availableOn}, or once every session is done or skipped`);
		this.name = 'WeeklyReviewNotReviewableError';
		this.availableOn = availableOn;
	}
}

/** A refresh was refused: the review is up to date, or its decision is already made. */
export class WeeklyReviewRefreshError extends Error {
	readonly reason: 'not_stale' | 'decided';
	constructor(reason: WeeklyReviewRefreshError['reason']) {
		super(reason === 'not_stale' ? 'the review is up to date' : 'the review is already decided');
		this.name = 'WeeklyReviewRefreshError';
		this.reason = reason;
	}
}

const resolve = (deps: ReviewDeps) => ({
	db: deps.db ?? getDb(),
	now: deps.now ?? (() => new Date())
});

const keyOf = (def: Pick<ExerciseDef, 'id' | 'key'>) =>
	toExerciseKey(def.key ? { key: def.key } : { customId: def.id });

/** A run's planned metres; null when any segment is planned by time. */
function plannedMetres(s: StoredSession): number | null {
	if (s.kind !== 'run') return null;
	if (s.segments.some((seg) => seg.distanceMetres === null)) return null;
	return s.segments.reduce((sum, seg) => sum + seg.distanceMetres! * (seg.repeats ?? 1), 0);
}

// ---- reading a week ------------------------------------------------------------------------

/** The owner's current program at its current version, with the weeks it plans by Monday. */
async function currentPlan(db: Executor, ownerId: string) {
	const found = await createProgramsRepository(db).currentProgram(ownerId);
	if (!found) return null;
	const version = await getProgramVersion(ownerId, found.program.id, found.version.number, { db });
	const weeks = new Map<IsoDate, { week: StoredWeek; block: string; outline: boolean }>();
	for (const block of version.blocks)
		for (const week of block.weeks)
			weeks.set(week.startsOn, { week, block: block.lineage, outline: block.outline });
	return { programId: found.program.id, versionId: found.version.id, weeks };
}
type Plan = NonNullable<Awaited<ReturnType<typeof currentPlan>>>;

/** What next week is, seen from the reviewed week's block. */
function nextStateOf(
	plan: Plan | null,
	monday: IsoDate
): { state: NextWeekState; kind: StoredWeek['kind'] | null } {
	const reviewed = plan?.weeks.get(monday);
	const next = plan?.weeks.get(addDays(monday, 7));
	if (!next) return { state: 'unplanned', kind: null };
	if (next.outline) return { state: 'outline', kind: next.week.kind };
	if (!reviewed || reviewed.block !== next.block)
		return { state: 'new_block', kind: next.week.kind };
	return { state: 'planned', kind: next.week.kind };
}

/**
 * The digest facts: every set, workout and check-in of the weeks read, with when each last
 * changed. The sets before the window, read only to judge PRs, are left out on purpose: reading
 * all of them on every view would cost more than an older set's edit is worth.
 */
function digestOf(
	sets: readonly { id: string; updatedAt: Date }[],
	sessions: readonly DatedSession[],
	recovery: readonly { id: string; updatedAt: Date }[]
): DigestFacts {
	return {
		facts: [
			...sets.map((s) => ({ kind: 'set', id: s.id, updatedAt: s.updatedAt })),
			...sessions.map((s) => ({ kind: 'session', id: s.id, updatedAt: s.updatedAt })),
			...recovery.map((r) => ({ kind: 'recovery', id: r.id, updatedAt: r.updatedAt }))
		],
		// The facts are counted workouts only: completed and not deleted.
		workouts: sessions.map((s) => ({ id: s.id, status: 'completed' as const }))
	};
}

/** The first day the review reads: the TRAILING_WEEKS complete weeks before the reviewed one. */
const windowFrom = (monday: IsoDate) => addDays(monday, -7 * TRAILING_WEEKS);

/** The facts of the weeks a review of `monday` reads, and their digest. */
async function weekFacts(db: Executor, ownerId: string, monday: IsoDate, timeZone: string) {
	const queue = createQueue();
	const facts = createFactsLoader(
		db,
		ownerId,
		{ from: windowFrom(monday), to: addDays(monday, 6), timeZone },
		{ queue }
	);
	const sets = await facts.sets();
	const sessions = await facts.sessions();
	const recovery = await facts.recovery();
	return { facts, queue, sets, sessions, recovery, digest: digestOf(sets, sessions, recovery) };
}

/** Everything a review of `monday` is computed from, on `today`. */
async function readWeek(db: Executor, ownerId: string, monday: IsoDate, today: IsoDate) {
	const profile = await getAthleteProfile(ownerId, { db });
	const { timeZone } = profile;
	const sunday = addDays(monday, 6);
	const plan = await currentPlan(db, ownerId);
	const read = await weekFacts(db, ownerId, monday, timeZone);
	const { facts, sessions, recovery } = read;
	// PRs are judged against every earlier set, so the sets before the window are read too.
	const first = await facts.firstActivity();
	const earlier =
		first !== null && first < windowFrom(monday)
			? await createFactsLoader(
					db,
					ownerId,
					{ from: first, to: addDays(windowFrom(monday), -1), timeZone },
					{ queue: read.queue }
				).sets()
			: [];
	const sets = [...earlier, ...read.sets];
	const runs = await facts.runs();
	const planned = await facts.planned();
	const lines = await facts.prescriptions();
	const prescriptions = sessions.flatMap((s) =>
		(s.plannedSessionId ? (lines.get(s.plannedSessionId) ?? []) : []).map((p) => ({
			...p,
			workoutId: s.id,
			day: s.date
		}))
	);
	const ids = [
		...new Set([...sets.map((s) => s.exercise), ...prescriptions.map((p) => p.exerciseId)])
	];
	const defs = await getExercisesByIds(ownerId, ids, { db });
	const [target] = await getMuscleTargets(ownerId, { from: monday, to: sunday }, { db });
	const factor = target!.volumeFactor;
	const band = Object.keys(target!.targets).length
		? Object.fromEntries(
				Object.entries(target!.targets).map(([g, [lo, hi]]) => [
					g,
					[cleanFloat(lo / factor, 2), cleanFloat(hi / factor, 2)]
				])
			)
		: null;
	const reviewed = plan?.weeks.get(monday)?.week ?? null;
	const weekSessions = (reviewed?.sessions ?? []).map(
		(s): ReviewPlannedSession & { session: StoredSession } => ({
			lineage: s.lineage,
			date: s.date,
			status: s.status,
			movedFrom: s.movedFrom,
			discipline: s.discipline,
			title: s.title,
			type: s.type,
			source: s.source,
			plannedMetres: plannedMetres(s),
			session: s
		})
	);
	const input: WeeklyReviewInput = {
		weekStartsOn: monday,
		today,
		timeZone,
		unit: profile.weightUnit,
		distanceUnit: profile.distanceUnit,
		week: { kind: reviewed?.kind ?? null, sessions: weekSessions },
		next: nextStateOf(plan, monday),
		completedLineages: planned.completed,
		workouts: sessions,
		sets,
		runs,
		recovery,
		prescriptions,
		exercises: defs as ReadonlyMap<string, ReviewExercise>,
		targets: {
			band: band as WeeklyReviewInput['targets']['band'],
			volumeFactor: factor,
			planned: target!.planned?.groups ?? null,
			label: target!.label
		},
		digest: read.digest,
		format: formatIn(displayUnits(profile))
	};
	return { input, plan, defs, runs, weekSessions, profile };
}
type Week = Awaited<ReturnType<typeof readWeek>>;

/** Every planned session of the week is completed or skipped (and it plans at least one). */
function allDone(
	sessions: readonly { lineage: string; status: string }[],
	completed: ReadonlySet<string>
) {
	return (
		sessions.length > 0 && sessions.every((s) => s.status === 'skipped' || completed.has(s.lineage))
	);
}

/** Whether the owner's week starting `monday` is all done, read without its facts. */
async function weekDone(db: Executor, ownerId: string, monday: IsoDate) {
	const { timeZone } = await getAthleteProfile(ownerId, { db });
	const sessions = (await currentPlan(db, ownerId))?.weeks.get(monday)?.week.sessions ?? [];
	const range = { from: monday, to: addDays(monday, 6), timeZone };
	const { completed } = await createFactsLoader(db, ownerId, range).planned();
	return allDone(sessions, completed);
}

// ---- next week ---------------------------------------------------------------------------

/** Next week's adjustments, from the reviewed week and the current version's next week. */
async function nextWeekOf(
	db: Executor,
	ownerId: string,
	week: Week,
	snapshot: WeeklyReviewSnapshot,
	exposures: readonly Exposure[]
): Promise<NextWeekProposal> {
	const { input, plan, defs, runs, weekSessions } = week;
	const monday = addDays(input.weekStartsOn, 7);
	const next = plan?.weeks.get(monday)?.week;
	const sessions = (next?.sessions ?? []) as unknown as NextSession[];
	const refs: ExerciseRef[] = sessions.flatMap((s) =>
		s.kind === 'strength' ? s.exercises.map((e) => e.exercise) : []
	);
	const exercises = new Map<string, NextWeekExercise>();
	const keys = refs.flatMap((r) => ('key' in r ? [r.key] : []));
	for (const def of (await resolveKeys(keys, { db })).values()) exercises.set(keyOf(def), def);
	const custom = refs.flatMap((r) => ('customId' in r ? [r.customId] : []));
	for (const def of (await getExercisesByIds(ownerId, custom, { db })).values())
		exercises.set(keyOf(def), def);
	const programming = await programmingInputFor(ownerId, { db });
	// The exposures name exercises by id; next week's rules by key.
	const byKey = exposures.flatMap((e) => {
		const def = defs.get(e.exerciseId);
		return def ? [{ ...e, exerciseId: keyOf(def) }] : [];
	});
	const reviewedRuns = weekSessions.filter((s) => s.session.kind === 'run');
	const long = weekSessions.find((s) => s.type === 'long_run');
	const dayOf = (at: Date) => localDay(at, input.timeZone);
	const sunday = addDays(input.weekStartsOn, 6);
	const ran = runs.filter(
		(r) => dayOf(r.startedAt) >= input.weekStartsOn && dayOf(r.startedAt) <= sunday
	);
	const longDone = long && input.workouts.find((w) => w.plannedLineage === long.lineage);
	const longRun = longDone && ran.find((r) => r.workout === longDone.id);
	const running = reviewedRuns.length
		? {
				previousPlanned: reviewedRuns.reduce((sum, s) => sum + (s.plannedMetres ?? 0), 0),
				actual: ran.reduce((sum, r) => sum + (r.metres ?? 0), 0),
				lastLongRun: long
					? {
							prescribed: long.plannedMetres ?? 0,
							completed: input.completedLineages.has(long.lineage),
							rpe: longRun?.rpe ?? null,
							targetRpe: long.session.targetRpe
						}
					: null
			}
		: null;
	// A session with a workout of any status is never touched: its status says so.
	const started = sessions.filter(
		(s) => s.status !== 'planned' || input.completedLineages.has(s.lineage)
	);
	return proposeNextWeek(
		{
			startsOn: monday,
			state: snapshot.next.state,
			kind: snapshot.next.kind,
			rpeCap: next?.targets.rpeCap ?? null,
			sessions
		},
		snapshot,
		byKey,
		{
			today: input.today,
			unit: input.unit,
			exercises,
			workouts: started.map((s) => ({ plannedLineage: s.lineage })),
			sessionMinutes: programming.sessionMinutes,
			estimateMinutes: (s) => estimateMinutes(s, programming),
			running
		}
	);
}

/** The 'next' findings: why nothing is proposed, each change left out, and the cycle flag. */
function nextFindings(proposal: NextWeekProposal, reason: NoProposalReason | null): Finding[] {
	const finding = (id: string, label: string, words: string): Finding => ({
		id: clip(`next:${id}`, 120),
		section: 'next',
		label: clip(label, 120),
		figures: [],
		verdict: { level: 'neutral', words: clip(words, 300) },
		window: null,
		metricId: null,
		sources: []
	});
	return [
		...(reason
			? [
					finding(
						'no_proposal',
						'No changes proposed',
						proposal.reason ?? NO_PROPOSAL_WORDS[reason]
					)
				]
			: []),
		...proposal.notProposed.map((n) => finding(`not_proposed:${n.id}`, n.why, n.words)),
		...(proposal.cycleFlag
			? [finding('cycle_flag', 'For your cycle review', proposal.cycleFlag)]
			: [])
	];
}

// ---- create ------------------------------------------------------------------------------

/** The latest week the owner can review today and has not: this week once all done, else last. */
export async function reviewableWeek(
	ownerId: string,
	today: IsoDate,
	deps: ReviewDeps = {}
): Promise<{ weekStartsOn: IsoDate; reason: ReviewableReason } | null> {
	const { db } = resolve(deps);
	const thisWeek = mondayOf(today);
	if (EARLY_REVIEW && !(await getLiveWeeklyReview(ownerId, thisWeek, { db }))) {
		if (await weekDone(db, ownerId, thisWeek))
			return { weekStartsOn: thisWeek, reason: 'all_done' };
	}
	const lastWeek = addDays(thisWeek, -7);
	if (await getLiveWeeklyReview(ownerId, lastWeek, { db })) return null;
	return { weekStartsOn: lastWeek, reason: 'ended' };
}

export interface CreateWeeklyReview {
	weekStartsOn: IsoDate;
	/** The owner's day (ownerToday). */
	today: IsoDate;
}

function checkWeek({ weekStartsOn, today }: CreateWeeklyReview) {
	if (parseIsoDate(weekStartsOn) === null || mondayOf(weekStartsOn) !== weekStartsOn)
		throw new ReviewInputError('weekStartsOn', 'A review starts on a Monday');
	if (parseIsoDate(today) === null) throw new ReviewInputError('today', 'Use a real date');
	if (weekStartsOn > today) throw new ReviewInputError('weekStartsOn', 'That week has not started');
}

/** The week's review as stored, and next week's changes to propose (null: none). */
async function compute(db: Executor, ownerId: string, monday: IsoDate, today: IsoDate) {
	const week = await readWeek(db, ownerId, monday, today);
	const ended = today > addDays(monday, 6);
	if (!ended && !(EARLY_REVIEW && allDone(week.input.week.sessions, week.input.completedLineages)))
		throw new WeeklyReviewNotReviewableError(addDays(monday, 7));
	const composed = composeWeeklyReview(week.input);
	const proposal = await nextWeekOf(db, ownerId, week, composed.snapshot, composed.exposures);
	const reason: NoProposalReason | null =
		composed.snapshot.noProposal ?? (proposal.adjustments.length ? null : 'no_changes');
	const findings = [...composed.snapshot.brief.findings, ...nextFindings(proposal, reason)];
	const snapshot: WeeklyReviewSnapshot = {
		...composed.snapshot,
		noProposal: reason,
		brief: { ...composed.snapshot.brief, findings }
	};
	const values = {
		snapshot: snapshot as unknown as Record<string, unknown>,
		summary: composed.summary,
		programId: week.plan?.programId ?? null,
		versionId: week.plan?.versionId ?? null,
		snapshotVersion: snapshot.version,
		analyticsVersion: snapshot.analyticsVersion,
		inputsDigest: composed.inputsDigest
	};
	return { values, proposal: reason ? null : proposal, snapshot };
}

/** Propose the adjustments for the stored review and link them to it. */
async function proposeFor(
	ownerId: string,
	review: StoredWeeklyReview,
	proposal: NextWeekProposal,
	deps: { db: Executor; now: () => Date }
) {
	const whys = [...new Set(proposal.adjustments.map((a) => a.why))];
	const rationale = clip(
		`From your review of the week of ${review.weekStartsOn}: ${whys.join(' ')}`,
		RATIONALE_MAX
	);
	const { proposal: created } = await createProposal(
		ownerId,
		{
			proposal: {
				kind: 'program_adjustment',
				title: PROPOSAL_TITLE,
				rationale,
				payload: { ops: proposal.adjustments.map((a) => a.op) }
			},
			provenance: {
				kind: 'weekly_review',
				reviewId: review.id,
				revision: review.revision,
				weekStartsOn: review.weekStartsOn
			},
			// Each change's half step and evidence, for deciding item by item.
			evidence: {
				adjustments: proposal.adjustments.map((a) => ({
					id: a.id,
					kind: a.kind,
					sessionDate: a.sessionDate,
					why: a.why,
					before: a.before,
					after: a.after,
					halfStep: a.options.half_step,
					evidence: a.evidence,
					significant: a.significant
				}))
			}
		},
		deps
	);
	await linkProposal(ownerId, 'weekly', review.id, created.id, deps);
	return getWeeklyReview(ownerId, review.id, deps);
}

/**
 * Review the owner's week: computed, stored and proposed in one transaction, or the live review
 * of that week as it is (`created` false).
 */
export async function createWeeklyReview(
	ownerId: string,
	options: CreateWeeklyReview,
	deps: ReviewDeps = {}
): Promise<{ review: StoredWeeklyReview; created: boolean }> {
	checkWeek(options);
	const { db, now } = resolve(deps);
	return db.transaction(async (tx) => {
		const inTx = { db: tx, now };
		await createReviewsRepository(tx).lock(ownerId);
		const live = await getLiveWeeklyReview(ownerId, options.weekStartsOn, inTx);
		if (live) return { review: live, created: false };
		const { values, proposal } = await compute(tx, ownerId, options.weekStartsOn, options.today);
		const { review } = await storeWeeklyReview(
			ownerId,
			{ ...values, weekStartsOn: options.weekStartsOn },
			inTx
		);
		if (!proposal) return { review, created: true };
		return { review: await proposeFor(ownerId, review, proposal, inTx), created: true };
	});
}

// ---- refresh -----------------------------------------------------------------------------

/**
 * Replace an out-of-date review whose decision is still open with its next revision; both rows
 * stay. An undecided head proposal is superseded as review_refreshed, then the new revision
 * proposes again.
 */
export async function refreshWeeklyReview(
	ownerId: string,
	id: string,
	{ today }: { today: IsoDate },
	deps: ReviewDeps = {}
): Promise<StoredWeeklyReview> {
	const { db, now } = resolve(deps);
	return db.transaction(async (tx) => {
		const inTx = { db: tx, now };
		await createReviewsRepository(tx).lock(ownerId);
		const review = await getWeeklyReview(ownerId, id, inTx);
		if (review.supersededAt) throw new ReviewSupersededError();
		checkWeek({ weekStartsOn: review.weekStartsOn, today });
		const head = await proposalHead(ownerId, review, inTx);
		if (!REFRESHABLE.includes(decisionOf(head).state))
			throw new WeeklyReviewRefreshError('decided');
		const { values, proposal } = await compute(tx, ownerId, review.weekStartsOn, today);
		if (!stale(review, values.inputsDigest)) throw new WeeklyReviewRefreshError('not_stale');
		const next = await supersedeWeeklyReview(ownerId, id, { ...values, proposalId: null }, inTx);
		if (head?.status === 'proposed') {
			const at = now();
			const proposals = createCoachProposalsRepository(tx);
			await proposals.lockProposal(ownerId, head.id);
			await proposals.decide(ownerId, head.id, {
				status: 'superseded',
				supersededReason: 'review_refreshed',
				closedAt: at,
				updatedAt: at
			});
		}
		return proposal ? proposeFor(ownerId, next, proposal, inTx) : next;
	});
}

// ---- read --------------------------------------------------------------------------------

export interface WeeklyReviewView {
	review: Pick<
		StoredWeeklyReview,
		'id' | 'weekStartsOn' | 'revision' | 'summary' | 'createdAt' | 'programId' | 'versionId'
	>;
	/** Written before M6 (or by another release): only the summary can be shown. */
	legacy: boolean;
	snapshot: WeeklyReviewSnapshot | null;
	/** The findings by section, in screen order; empty for a legacy review. */
	sections: { section: Finding['section']; findings: Finding[] }[];
	/** The head of the proposal's revision chain, as M5's card shows it. */
	proposal: ProposalView | null;
	decision: DecisionState;
	/**
	 * The facts changed since it was computed, and about how many: those whose updated_at is after
	 * the review was stored (at least 1 when stale, since a deleted fact leaves no row to count).
	 */
	stale: boolean;
	laterChanges: number;
	/** Computed with older analytics definitions than today's. */
	analyticsOutdated: boolean;
	writeUp: { state: 'written'; text: string } | { state: 'none' };
	/** Why nothing is proposed for next week; null when something is. */
	noProposal: { reason: NoProposalReason; words: string } | null;
	/** The changes the rules found but could not propose, each with why. */
	notProposed: Finding[];
	late: boolean;
	boundary: boolean;
}

/** The owner's live review of the week starting `weekStartsOn`, as the review page shows it. */
export async function getWeeklyReviewView(
	ownerId: string,
	weekStartsOn: IsoDate,
	deps: ReviewDeps = {}
): Promise<WeeklyReviewView> {
	const { db } = resolve(deps);
	const review = await getLiveWeeklyReview(ownerId, weekStartsOn, { db });
	if (!review) throw new ReviewNotFoundError();
	const head = await proposalHead(ownerId, review, { db });
	const proposal = head ? await getProposalView(ownerId, head.id, { db }) : null;
	const { timeZone } = await getAthleteProfile(ownerId, { db });
	const { sets, sessions, recovery, digest } = await weekFacts(db, ownerId, weekStartsOn, timeZone);
	const changed = [...sets, ...sessions, ...recovery].filter(
		(f) => f.updatedAt > review.createdAt
	).length;
	const isStale = stale(review, inputsDigest(digest));
	const snapshot = review.read.legacy ? null : review.read.snapshot;
	const findings = snapshot?.brief.findings ?? [];
	const sections = [...new Set(findings.map((f) => f.section))].map((section) => ({
		section,
		findings: findings.filter((f) => f.section === section)
	}));
	const reason = snapshot?.noProposal ?? null;
	return {
		review: {
			id: review.id,
			weekStartsOn: review.weekStartsOn,
			revision: review.revision,
			summary: review.summary,
			createdAt: review.createdAt,
			programId: review.programId,
			versionId: review.versionId
		},
		legacy: review.read.legacy,
		snapshot,
		sections,
		proposal,
		decision: decisionOf(head),
		stale: isStale,
		laterChanges: isStale ? Math.max(changed, 1) : 0,
		analyticsOutdated: review.analyticsVersion < ANALYTICS_VERSION,
		writeUp: review.narrative ? { state: 'written', text: review.narrative } : { state: 'none' },
		noProposal: reason && {
			reason,
			words:
				findings.find((f) => f.id === 'next:no_proposal')?.verdict.words ??
				NO_PROPOSAL_WORDS[reason]
		},
		notProposed: findings.filter((f) => f.id.startsWith('next:not_proposed:')),
		late: reason === 'late',
		boundary: reason === 'boundary'
	};
}
