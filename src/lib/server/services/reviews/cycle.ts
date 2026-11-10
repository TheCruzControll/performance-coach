/**
 * Cycle reviews (PRD §11; the M6 plan's cycle-review-service): create, refresh and read the review
 * of one finished block, computed from code alone, stored with its snapshot and a next_cycle
 * proposal, and read with a preview of the next block for each start on offer.
 *
 * - A block is reviewable once its last planned week has ended, or earlier once every session of
 *   that week is completed or skipped. Before that, creating it is a
 *   CycleReviewNotReviewableError with the day it becomes available.
 * - Creating is one transaction under the owner's review lock, and idempotent. It reads the
 *   block's facts (the workouts before it too, for the ACWR), each week's targets (targets.ts) and
 *   M2's active goals, then evaluateCycle → directivesFrom → store. The next_cycle proposal is the
 *   directives' modifiable subset, created with the review's rules provenance (evidence.source)
 *   and linked to it. Decision: its evidence keeps the directives and the folded overrides, since
 *   the cycle snapshot's schema has no field for them; the previews and a refresh read them back.
 * - A next_cycle the owner accepted from the coach for the block (NEXT_CYCLE_AWAITS) is folded in:
 *   its fields are overrides clampOverrides holds to the directives' bounds, and it is superseded
 *   as folded_into_review. A refresh keeps what was folded.
 * - Refresh replaces an out-of-date review only while no next version is planned and its head is
 *   undecided; both rows stay.
 * - The view previews the next block for each start offeredStarts gives: nextBlockDates over the
 *   current version's blocks, then generateNextBlock over buildProgrammingInput(today's profile)
 *   with the block's results overlaid (nextBlockInput) and the head proposal's subset. The bridge,
 *   lostWeeks, fingerprint and significant changes come with it. Pure on read: nothing is stored.
 *   plannedNextBlock gives one start's block the same way, for the applier that stores it
 *   (services/coach/apply/next-cycle.ts), so what is planned is what the preview showed.
 * Every query is awaited in turn, so the whole create or refresh runs on one transaction.
 */
import { addDays, daysBetween, parseIsoDate, type IsoDate } from '../../../domain/calendar';
import type { Exposure } from '../../../domain/analytics/prescribed';
import { exposure, matchPrescription } from '../../../domain/analytics/prescribed';
import { METRICS } from '../../../domain/analytics/metrics';
import {
	bestEfforts,
	longRuns,
	runPace,
	weeklyRunning,
	type RunFact
} from '../../../domain/analytics/running';
import { e1rmSeries, measuredMaxes } from '../../../domain/analytics/strength';
import { classifyTrend } from '../../../domain/analytics/trend';
import { ANALYTICS_VERSION } from '../../../domain/analytics/version';
import { RATIONALE_MAX } from '../../../domain/coach/proposals';
import { toExerciseKey, type ProgrammingInput } from '../../../domain/programming/input';
import {
	BRIDGE_PHASE,
	BRIDGE_WEEK_KIND,
	DEFAULT_NEXT_BLOCK_START,
	nextBlockDates,
	offeredStarts,
	type DatedBlock,
	type NextBlockDates,
	type NextBlockStart
} from '../../../domain/programming/next-block/dates';
import { generateNextBlock, type NextBlock } from '../../../domain/programming/next-block/generate';
import { nextBlockInput, type ResultsSnapshot } from '../../../domain/programming/next-block/input';
import type { Finding } from '../../../domain/programming/review/brief';
import { evaluateCycle, type CycleReviewInput } from '../../../domain/programming/review/cycle';
import type { CycleReviewSnapshot } from '../../../domain/programming/review/cycle-snapshot';
import { inputsDigest } from '../../../domain/programming/review/digest';
import {
	clampOverrides,
	directivesFrom,
	type Clamp,
	type CycleDirectives,
	type NextCycleSubset
} from '../../../domain/programming/review/directives';
import { clip, type ReviewExercise } from '../../../domain/programming/review/weekly';
import type { LiftResults } from '../../../domain/programming/stages/results';
import { compareText } from '../../../domain/programming/random';
import type { BaselineLift } from '../../../domain/training/types';
import type { WeightUnit } from '../../../domain/units';
import { getDb, type Executor } from '../../db';
import { createCoachProposalsRepository } from '../../db/repositories/coach-proposals';
import { createProgramsRepository } from '../../db/repositories/programs';
import { createReviewsRepository } from '../../db/repositories/reviews';
import { createFactsLoader, createQueue } from '../analytics/facts';
import { displayUnits, formatIn } from '../analytics/format';
import { getMuscleTargets } from '../analytics/targets';
import { createProposal, getProposalView, type ProposalView } from '../coach/proposals';
import { getExercisesByIds, type ExerciseDef } from '../exercises/index';
import { getAthleteProfile, listGoals } from '../profile/index';
import { programmingInputFor } from '../programs/alternatives';
import { getProgramVersion, type StoredBlock } from '../programs/index';
import { isUuid } from '../ids';
import {
	decisionOf,
	getLiveCycleReview,
	getCycleReview,
	linkProposal,
	proposalHead,
	ReviewInputError,
	ReviewNotFoundError,
	ReviewSupersededError,
	stale,
	storeCycleReview,
	supersedeCycleReview,
	type DecisionState,
	type ReviewDeps,
	type StoredCycleReview
} from './store';
import { allDone, digestOf, plannedMetres, volumeTargetsOf } from './weekly';

/** The next_cycle proposal's title, as M5's card and inbox show it. */
export const NEXT_CYCLE_TITLE = 'Your next block, from your cycle review';

/** The decisions a cycle refresh may replace: nothing the owner has settled yet. */
export const CYCLE_REFRESHABLE: readonly DecisionState['state'][] = ['undecided', 'none'];

/** A start the review does not offer today: while the block runs, only the Monday after it. */
export const START_NOT_OFFERED = 'Choose a start the review offers';

/** The most accepted proposals read when looking for the coach's next_cycle to fold in. */
export const FOLD_SCAN = 50;

export type CycleReviewableReason = 'ended' | 'all_done';

/** The block's last week is not over and not all done yet; nothing was written. */
export class CycleReviewNotReviewableError extends Error {
	readonly reason = 'not_reviewable';
	/** The first day the block is reviewable whatever is logged: the Monday after it. */
	readonly availableOn: IsoDate;
	constructor(availableOn: IsoDate) {
		super(`the block is reviewable from ${availableOn}, or once its last week is done`);
		this.name = 'CycleReviewNotReviewableError';
		this.availableOn = availableOn;
	}
}

/** A refresh was refused: up to date, already decided, or the next block is planned. */
export class CycleReviewRefreshError extends Error {
	readonly reason: 'not_stale' | 'decided' | 'planned';
	constructor(reason: CycleReviewRefreshError['reason']) {
		super(`the review cannot be refreshed: ${reason}`);
		this.name = 'CycleReviewRefreshError';
		this.reason = reason;
	}
}

const resolve = (deps: ReviewDeps) => ({
	db: deps.db ?? getDb(),
	now: deps.now ?? (() => new Date())
});

const keyOf = (def: Pick<ExerciseDef, 'id' | 'key'>) =>
	toExerciseKey(def.key ? { key: def.key } : { customId: def.id });
const weeksOf = (b: { startsOn: IsoDate; endsOn: IsoDate }) =>
	(daysBetween(b.startsOn, b.endsOn) + 1) / 7;
const windowOf = (block: StoredBlock) => ({
	weeks: { from: block.startsOn, to: block.endsOn, count: weeksOf(block) },
	inProgress: { weekStart: addDays(block.endsOn, 1), through: addDays(block.endsOn, 1), days: 1 }
});

// ---- reading a block -----------------------------------------------------------------------

/** The owner's current program at its current version, when it is `programId`. */
async function currentVersion(db: Executor, ownerId: string, programId?: string) {
	const found = await createProgramsRepository(db).currentProgram(ownerId);
	if (!found || (programId !== undefined && found.program.id !== programId)) return null;
	return getProgramVersion(ownerId, found.program.id, found.version.number, { db });
}
type Version = NonNullable<Awaited<ReturnType<typeof currentVersion>>>;

/** A planned training block: not an outline, nor a late start's 'Between blocks' bridge. */
const trained = (b: StoredBlock) =>
	!b.outline && !(b.phase === BRIDGE_PHASE && b.weeks.every((w) => w.kind === BRIDGE_WEEK_KIND));

/** The planned training block with `lineage` in `version`, and its index. */
function blockOf(version: Version, lineage: string) {
	const index = version.blocks.findIndex((b) => b.lineage === lineage && trained(b));
	if (index === -1) throw new ReviewNotFoundError('block');
	return { block: version.blocks[index]!, index };
}

/** The block's facts, read in turn on one queue, and their digest. */
async function blockFacts(db: Executor, ownerId: string, block: StoredBlock, timeZone: string) {
	const queue = createQueue();
	const range = { from: block.startsOn, to: block.endsOn, timeZone };
	const facts = createFactsLoader(db, ownerId, range, { queue });
	const sets = await facts.sets();
	const sessions = await facts.sessions();
	const recovery = await facts.recovery();
	return { facts, queue, sets, sessions, recovery, digest: digestOf(sets, sessions, recovery) };
}
type BlockFacts = Awaited<ReturnType<typeof blockFacts>>;

/** Each completed workout's planned lines, with the workout and its day; and the exercises. */
async function prescribed(db: Executor, ownerId: string, read: BlockFacts) {
	const lines = await read.facts.prescriptions();
	const prescriptions = read.sessions.flatMap((s) =>
		(s.plannedSessionId ? (lines.get(s.plannedSessionId) ?? []) : []).map((p) => ({
			...p,
			workoutId: s.id,
			day: s.date
		}))
	);
	const ids = [
		...new Set([...read.sets.map((s) => s.exercise), ...prescriptions.map((p) => p.exerciseId)])
	];
	return { prescriptions, defs: await getExercisesByIds(ownerId, ids, { db }) };
}

/** Is the block's last week done: every session completed or skipped? */
async function lastWeekDone(db: Executor, ownerId: string, block: StoredBlock, timeZone: string) {
	const week = block.weeks.at(-1)!;
	const range = { from: week.startsOn, to: week.endsOn, timeZone };
	const { completed } = await createFactsLoader(db, ownerId, range).planned();
	return allDone(week.sessions, completed);
}

/** Everything the block's review is computed from, on `today`. */
async function readBlock(
	db: Executor,
	ownerId: string,
	version: Version,
	index: number,
	today: IsoDate
) {
	const profile = await getAthleteProfile(ownerId, { db });
	const { timeZone } = profile;
	const block = version.blocks[index]!;
	const read = await blockFacts(db, ownerId, block, timeZone);
	const { facts } = read;
	const first = await facts.firstActivity();
	// The ACWR reads every workout from the first: the ones before the block are read for it.
	const before =
		first !== null && first < block.startsOn
			? await createFactsLoader(
					db,
					ownerId,
					{ from: first, to: addDays(block.startsOn, -1), timeZone },
					{ queue: read.queue }
				).sessions()
			: [];
	const runs = await facts.runs();
	const { completed } = await facts.planned();
	const { prescriptions, defs } = await prescribed(db, ownerId, read);
	const targets = await getMuscleTargets(
		ownerId,
		{ from: block.startsOn, to: block.endsOn },
		{ db }
	);
	const goals = (await listGoals(ownerId, { db })).filter((g) => g.status === 'active');
	const prior = version.blocks.slice(0, index).findLast(trained);
	const previous =
		prior && (await getLiveCycleReview(ownerId, version.programId, prior.lineage, { db }));
	const next = version.blocks[index + 1]?.outline ? version.blocks[index + 1]! : null;
	const input: CycleReviewInput = {
		block: {
			lineage: block.lineage,
			name: block.name,
			phase: block.phase,
			weeks: block.weeks.map((w, i) => ({
				startsOn: w.startsOn,
				kind: w.kind,
				targets: volumeTargetsOf(targets[i]!)
			}))
		},
		today,
		timeZone,
		unit: profile.weightUnit,
		distanceUnit: profile.distanceUnit,
		sessions: block.weeks.flatMap((w) =>
			w.sessions.map((s) => ({
				...{ lineage: s.lineage, date: s.date, status: s.status, movedFrom: s.movedFrom },
				...{ discipline: s.discipline, title: s.title, type: s.type, source: s.source },
				plannedMetres: plannedMetres(s)
			}))
		),
		completedLineages: completed,
		workouts: [...before, ...read.sessions],
		sets: read.sets,
		runs,
		recovery: read.recovery,
		prescriptions,
		exercises: defs as ReadonlyMap<string, ReviewExercise>,
		goals,
		previous:
			previous && !previous.read.legacy
				? {
						from: previous.read.snapshot.block.from,
						to: previous.read.snapshot.block.to,
						summary: previous.summary,
						adherencePct: previous.read.snapshot.adherence.pct
					}
				: null,
		next: next && {
			name: next.name,
			phase: next.phase,
			startsOn: next.startsOn,
			firstWeekKind: next.weeks[0]?.kind ?? null
		},
		digest: read.digest,
		format: formatIn(displayUnits(profile))
	};
	return { input, block, next, runs, goals, timeZone, distanceUnit: profile.distanceUnit };
}

// ---- create ------------------------------------------------------------------------------

/** The latest planned block the owner can review today and has not; null with none. */
export async function reviewableBlock(
	ownerId: string,
	today: IsoDate,
	deps: ReviewDeps = {}
): Promise<{ programId: string; blockLineage: string; reason: CycleReviewableReason } | null> {
	const { db } = resolve(deps);
	const version = await currentVersion(db, ownerId);
	if (!version) return null;
	const { timeZone } = await getAthleteProfile(ownerId, { db });
	const started = version.blocks.filter((b) => trained(b) && b.startsOn <= today);
	for (const block of started.toReversed()) {
		const ended = block.endsOn < today;
		if (!ended && !(await lastWeekDone(db, ownerId, block, timeZone))) continue;
		if (await getLiveCycleReview(ownerId, version.programId, block.lineage, { db })) return null;
		return {
			programId: version.programId,
			blockLineage: block.lineage,
			reason: ended ? 'ended' : 'all_done'
		};
	}
	return null;
}

export interface CreateCycleReview {
	programId: string;
	blockLineage: string;
	/** The owner's day (ownerToday). */
	today: IsoDate;
}

function checkOptions({ programId, blockLineage, today }: CreateCycleReview) {
	if (!isUuid(programId) || !isUuid(blockLineage)) throw new ReviewNotFoundError('block');
	if (parseIsoDate(today) === null) throw new ReviewInputError('today', 'Use a real date');
}

/** The coach's accepted next_cycle proposals for the block, oldest first, with their payloads. */
async function coachNextCycles(db: Executor, ownerId: string, lineage: string) {
	const repo = createCoachProposalsRepository(db);
	const accepted = await repo.proposalPage(ownerId, { status: 'accepted', limit: FOLD_SCAN });
	const found = [];
	for (const p of accepted.toReversed()) {
		if (p.kind !== 'next_cycle' || p.source !== null) continue;
		const row = (await repo.lockProposal(ownerId, p.id))!;
		const payload = row.payload as unknown as NextCycleSubset;
		if (payload.fromBlockLineage === lineage) found.push({ id: row.id, payload });
	}
	return found;
}

/** What a review's proposal keeps beside its payload (evidence). */
export interface CycleEvidence {
	directives: CycleDirectives;
	overrides: Partial<NextCycleSubset>;
	clamps: Clamp[];
	folded: string[];
}
const NOTHING_FOLDED = { overrides: {}, folded: [] };

/** The block's review as stored, its directives and its proposal's subset. */
async function compute(
	db: Executor,
	ownerId: string,
	options: CreateCycleReview,
	carried: Pick<CycleEvidence, 'overrides' | 'folded'> = NOTHING_FOLDED
) {
	const { programId, blockLineage, today } = options;
	const version = await currentVersion(db, ownerId, programId);
	if (!version) throw new ReviewNotFoundError('program');
	const { block, index } = blockOf(version, blockLineage);
	if (block.startsOn > today) throw new CycleReviewNotReviewableError(addDays(block.endsOn, 1));
	const read = await readBlock(db, ownerId, version, index, today);
	const done = allDone(block.weeks.at(-1)!.sessions, read.input.completedLineages);
	if (today <= block.endsOn && !done)
		throw new CycleReviewNotReviewableError(addDays(block.endsOn, 1));
	const evaluation = evaluateCycle(read.input);
	const { runs } = read;
	const mileage = weeklyRunning(runs, windowOf(block), read.distanceUnit, read.timeZone);
	const running = runs.length
		? {
				weeklyMetres: mileage.weeks.map((w) => w.metres ?? 0),
				longestRunMetres: Math.max(...runs.map((r) => r.metres ?? 0)) || null
			}
		: null;
	const outline = read.next && { phase: read.next.phase, weeks: weeksOf(read.next) };
	const directives = directivesFrom(
		{ snapshot: evaluation.snapshot, running },
		outline,
		read.goals
	);
	const folded = await coachNextCycles(db, ownerId, blockLineage);
	const payloads = folded.map((f) => f.payload);
	const overrides: Partial<NextCycleSubset> = Object.assign({}, carried.overrides, ...payloads);
	const { subset, clamps } = clampOverrides(overrides, directives);
	const values = {
		snapshot: evaluation.snapshot as unknown as Record<string, unknown>,
		summary: evaluation.summary,
		versionId: version.version.id,
		blockStartsOn: block.startsOn,
		blockEndsOn: block.endsOn,
		snapshotVersion: evaluation.snapshot.version,
		analyticsVersion: evaluation.snapshot.analyticsVersion,
		inputsDigest: evaluation.inputsDigest
	};
	const evidence: CycleEvidence = {
		...{ directives, overrides, clamps },
		folded: [...carried.folded, ...folded.map((f) => f.id)]
	};
	return { values, block, subset, evidence, newlyFolded: folded.map((f) => f.id) };
}
type Computed = Awaited<ReturnType<typeof compute>>;

/** Propose the next cycle for the stored review, link it, and supersede what it folded in. */
async function proposeFor(
	ownerId: string,
	review: StoredCycleReview,
	c: Computed,
	deps: { db: Executor; now: () => Date }
) {
	const rationale = clip(`From your review of ${c.block.name}: ${review.summary}`, RATIONALE_MAX);
	const { proposal } = await createProposal(
		ownerId,
		{
			proposal: { kind: 'next_cycle', title: NEXT_CYCLE_TITLE, rationale, payload: c.subset },
			provenance: { kind: 'cycle_review', reviewId: review.id, revision: review.revision },
			evidence: { ...c.evidence }
		},
		deps
	);
	await linkProposal(ownerId, 'cycle', review.id, proposal.id, deps);
	const proposals = createCoachProposalsRepository(deps.db);
	for (const id of c.newlyFolded) {
		const decided = { status: 'superseded', supersededReason: 'folded_into_review' } as const;
		await proposals.decide(ownerId, id, { ...decided, updatedAt: deps.now() });
	}
	return getCycleReview(ownerId, review.id, deps);
}

/**
 * Review the owner's block: computed, stored and proposed in one transaction, or the live review
 * of that block as it is (`created` false).
 */
export async function createCycleReview(
	ownerId: string,
	options: CreateCycleReview,
	deps: ReviewDeps = {}
): Promise<{ review: StoredCycleReview; created: boolean }> {
	checkOptions(options);
	const { db, now } = resolve(deps);
	return db.transaction(async (tx) => {
		const inTx = { db: tx, now };
		await createReviewsRepository(tx).lock(ownerId);
		const { programId, blockLineage } = options;
		const live = await getLiveCycleReview(ownerId, programId, blockLineage, inTx);
		if (live) return { review: live, created: false };
		const computed = await compute(tx, ownerId, options);
		const stored = { ...computed.values, programId, blockLineageId: blockLineage };
		const { review } = await storeCycleReview(ownerId, stored, inTx);
		return { review: await proposeFor(ownerId, review, computed, inTx), created: true };
	});
}

// ---- refresh -----------------------------------------------------------------------------

/**
 * Replace an out-of-date review with its next revision while no next version is planned and its
 * head is undecided; both rows stay. The head is superseded as review_refreshed.
 */
export async function refreshCycleReview(
	ownerId: string,
	id: string,
	{ today }: { today: IsoDate },
	deps: ReviewDeps = {}
): Promise<StoredCycleReview> {
	const { db, now } = resolve(deps);
	return db.transaction(async (tx) => {
		const inTx = { db: tx, now };
		await createReviewsRepository(tx).lock(ownerId);
		const review = await getCycleReview(ownerId, id, inTx);
		if (review.supersededAt) throw new ReviewSupersededError();
		if (review.nextVersionId) throw new CycleReviewRefreshError('planned');
		const options = { programId: review.programId, blockLineage: review.blockLineageId, today };
		checkOptions(options);
		const head = await proposalHead(ownerId, review, inTx);
		if (!CYCLE_REFRESHABLE.includes(decisionOf(head).state))
			throw new CycleReviewRefreshError('decided');
		const own = await createCoachProposalsRepository(tx).lockProposal(ownerId, review.proposalId!);
		const computed = await compute(tx, ownerId, options, own?.evidence as unknown as CycleEvidence);
		if (!stale(review, computed.values.inputsDigest))
			throw new CycleReviewRefreshError('not_stale');
		const next = await supersedeCycleReview(
			ownerId,
			id,
			{ ...computed.values, proposalId: null },
			inTx
		);
		if (head?.status === 'proposed') {
			const proposals = createCoachProposalsRepository(tx);
			await proposals.lockProposal(ownerId, head.id);
			const at = now();
			await proposals.decide(ownerId, head.id, {
				...{ status: 'superseded', supersededReason: 'review_refreshed' },
				...{ closedAt: at, updatedAt: at }
			});
		}
		return proposeFor(ownerId, next, computed, inTx);
	});
}

// ---- read --------------------------------------------------------------------------------

/** The next block as it would be planned from one start: nothing is stored. */
export interface NextBlockPreview extends NextBlock {
	start: NextBlockStart;
	dates: NextBlockDates;
}

export interface CycleReviewView {
	review: Pick<
		StoredCycleReview,
		| 'id'
		| 'programId'
		| 'blockLineageId'
		| 'revision'
		| 'summary'
		| 'createdAt'
		| 'versionId'
		| 'nextVersionId'
	>;
	/** Written before M6 (or by another release): only the summary can be shown. */
	legacy: boolean;
	snapshot: CycleReviewSnapshot | null;
	/** The findings by section, in screen order; empty for a legacy review. */
	sections: { section: Finding['section']; findings: Finding[] }[];
	/** The head of the proposal's revision chain, as M5's card shows it. */
	proposal: ProposalView | null;
	decision: DecisionState;
	stale: boolean;
	laterChanges: number;
	analyticsOutdated: boolean;
	writeUp: { state: 'written'; text: string } | { state: 'none' };
	/** One per start on offer, the first being the default; none once the next block is planned. */
	previews: NextBlockPreview[];
}

/** What the block showed, as the next block's input overlay and results stage read it. */
async function resultsOf(
	db: Executor,
	ownerId: string,
	block: StoredBlock,
	read: BlockFacts,
	{ timeZone: tz, weightUnit: unit }: { timeZone: string; weightUnit: WeightUnit }
) {
	const { prescriptions, defs } = await prescribed(db, ownerId, read);
	const setsOf = Map.groupBy(read.sets, (s) => s.exercise);
	const e1rms: ResultsSnapshot['e1rms'] = [...defs.values()].flatMap((def) => {
		const last = def.baselineLift && e1rmSeries(setsOf.get(def.id) ?? [], def, tz).at(-1);
		return last ? [{ lift: def.baselineLift as BaselineLift, point: last }] : [];
	});
	const runs: RunFact[] = await read.facts.runs();
	const window = windowOf(block);
	const running = runs.length
		? {
				weeks: weeklyRunning(runs, window, 'km', tz).weeks,
				longRuns: longRuns(runs, window, tz),
				paces: runs.flatMap((r) => runPace(r) ?? []),
				efforts: bestEfforts(runs, await read.facts.races())
			}
		: null;
	const maxes = measuredMaxes(await read.facts.baselines());
	const setsIn = Map.groupBy(read.sets, (s) => s.workoutId);
	const byDay = prescriptions.toSorted((a, b) => compareText(a.day, b.day));
	const exposures = Map.groupBy(byDay, (p) => p.exerciseId);
	const lifts: LiftResults[] = [...exposures].flatMap(([id, list]) => {
		const def = defs.get(id);
		if (!def) return [];
		const logged = (p: (typeof list)[number]) =>
			(setsIn.get(p.workoutId) ?? []).map((s) => ({ ...s, exerciseId: s.exercise }));
		const seen: Exposure[] = list.map((p) =>
			exposure(matchPrescription(p, logged(p), { unit }), p.day)
		);
		const points = e1rmSeries(setsOf.get(id) ?? [], def, tz).map((p) => ({
			at: p.on,
			value: p.value,
			inProgress: false
		}));
		const trend = classifyTrend(points, {
			direction: METRICS.e1rm.direction,
			mpc: METRICS.e1rm.mpc
		});
		return [{ exercise: keyOf(def), exposures: seen, trend }];
	});
	const keys = new Map([...defs.values()].map((def) => [def.id, keyOf(def)]));
	return { snapshot: { timeZone: tz, e1rms, maxes, running }, lifts, keys };
}

/**
 * The directives with their kept and rotated exercises named as the generator names them. The
 * snapshot judges each exercise by its library id; carryover and the input overlay compare plan
 * keys ('back_squat', 'custom:…'), so an id left as it is would keep or rotate nothing.
 */
const byKey = (d: CycleDirectives, keys: ReadonlyMap<string, string>): CycleDirectives => ({
	...d,
	keep: d.keep.map((k) => ({ ...k, exercise: keys.get(k.exercise) ?? k.exercise })),
	rotate: d.rotate.map((r) => ({ ...r, exercise: keys.get(r.exercise) ?? r.exercise }))
});

/** One start's next block, with what storing it as a version needs beside the preview. */
export interface PlannedNextBlock {
	preview: NextBlockPreview;
	/** The current version it plans onto. */
	versionNumber: number;
	/** The outline block it plans, or null when it is appended. */
	outlineLineage: string | null;
	/** The lineage of each block in preview.dates.shifted, in its order. */
	shiftedLineages: string[];
	/** The generator's input (today's profile with the block's results), which the version keeps. */
	input: ProgrammingInput;
}

/**
 * The next block from each start on offer (or `only` that one), from the review's directives and
 * its head's subset. An owner revision that kept a rotated exercise carries its own directives.
 */
async function plannedOf(
	db: Executor,
	ownerId: string,
	review: StoredCycleReview,
	headId: string,
	read: BlockFacts,
	{ today, profile }: { today: IsoDate; profile: Awaited<ReturnType<typeof getAthleteProfile>> },
	only?: NextBlockStart
): Promise<PlannedNextBlock[]> {
	const version = await currentVersion(db, ownerId, review.programId);
	if (!version) return [];
	const { block, index } = blockOf(version, review.blockLineageId);
	const repo = createCoachProposalsRepository(db);
	const own = (await repo.lockProposal(ownerId, review.proposalId!))!;
	const head = headId === own.id ? own : (await repo.lockProposal(ownerId, headId))!;
	const evidence = (row: typeof own) => row.evidence as unknown as Partial<CycleEvidence> | null;
	const results = await resultsOf(db, ownerId, block, read, profile);
	const directives = byKey(
		(evidence(head)?.directives ?? evidence(own)!.directives)!,
		results.keys
	);
	const base = await programmingInputFor(ownerId, { db });
	const overrides = head.payload as unknown as NextCycleSubset;
	const next = nextBlockInput(base, results.snapshot, directives, overrides);
	const goals = await listGoals(ownerId, { db });
	const events = goals.flatMap((g) => (g.status === 'active' && g.eventDate ? [g.eventDate] : []));
	// Each dated block carries its lineage through nextBlockDates, which spreads what it lays.
	const blocks: (DatedBlock & { lineage: string })[] = version.blocks.map((b) => ({
		...{ phase: b.phase, name: b.name, startsOn: b.startsOn, endsOn: b.endsOn, outline: b.outline },
		lineage: b.lineage
	}));
	const lineageOf = (b: DatedBlock) => (b as DatedBlock & { lineage: string }).lineage;
	const previous = { block, results: results.lifts, unit: profile.weightUnit };
	const starts = offeredStarts(blocks[index]!, today)
		.filter((start) => only === undefined || start === only)
		.toSorted(
			(a, b) => Number(b === DEFAULT_NEXT_BLOCK_START) - Number(a === DEFAULT_NEXT_BLOCK_START)
		);
	return starts.map((start) => {
		const weeks = next.subset.weeks;
		const dates = nextBlockDates({ blocks, reviewedBlock: index, today, start, events, weeks });
		const from = dates.block.outline;
		const outline = from ? version.blocks.find((b) => b.lineage === lineageOf(from))! : null;
		const generated = generateNextBlock(next, { dates, outline, previous, directives });
		return {
			preview: { start, dates, ...generated },
			versionNumber: version.version.number,
			outlineLineage: outline?.lineage ?? null,
			shiftedLineages: dates.shifted.map(lineageOf),
			input: next.input
		};
	});
}

/**
 * The next block of the owner's live, unplanned review from `start`, as its preview shows it, on
 * the head `headId` of its proposal's chain. A start not on offer today is a ReviewInputError.
 */
export async function plannedNextBlock(
	ownerId: string,
	review: StoredCycleReview,
	{ headId, start, today }: { headId: string; start: NextBlockStart; today: IsoDate },
	deps: ReviewDeps = {}
): Promise<PlannedNextBlock> {
	const { db } = resolve(deps);
	const version = await currentVersion(db, ownerId, review.programId);
	if (!version) throw new ReviewNotFoundError('program');
	const { block } = blockOf(version, review.blockLineageId);
	const profile = await getAthleteProfile(ownerId, { db });
	const read = await blockFacts(db, ownerId, block, profile.timeZone);
	const [planned] = await plannedOf(db, ownerId, review, headId, read, { today, profile }, start);
	if (!planned) throw new ReviewInputError('start', START_NOT_OFFERED);
	return planned;
}

/** The owner's live review of a program's block, as the review page shows it. */
export async function getCycleReviewView(
	ownerId: string,
	{ programId, blockLineage, today }: CreateCycleReview,
	deps: ReviewDeps = {}
): Promise<CycleReviewView> {
	const { db } = resolve(deps);
	const review = await getLiveCycleReview(ownerId, programId, blockLineage, { db });
	if (!review) throw new ReviewNotFoundError();
	const head = await proposalHead(ownerId, review, { db });
	const proposal = head ? await getProposalView(ownerId, head.id, { db }) : null;
	const version = await currentVersion(db, ownerId, programId);
	const profile = await getAthleteProfile(ownerId, { db });
	const block = version?.blocks.find((b) => b.lineage === blockLineage) ?? null;
	const read = block && (await blockFacts(db, ownerId, block, profile.timeZone));
	const changed = read
		? [...read.sets, ...read.sessions, ...read.recovery].filter(
				(f) => f.updatedAt > review.createdAt
			)
		: [];
	const isStale = read !== null && stale(review, inputsDigest(read.digest));
	const snapshot = review.read.legacy ? null : review.read.snapshot;
	const findings = snapshot?.brief.findings ?? [];
	const sections = [...new Set(findings.map((f) => f.section))].map((section) => ({
		section,
		findings: findings.filter((f) => f.section === section)
	}));
	const open = snapshot && head && read && review.nextVersionId === null;
	return {
		review: {
			...{ id: review.id, programId: review.programId, blockLineageId: review.blockLineageId },
			...{ revision: review.revision, summary: review.summary, createdAt: review.createdAt },
			...{ versionId: review.versionId, nextVersionId: review.nextVersionId }
		},
		legacy: review.read.legacy,
		snapshot,
		sections,
		proposal,
		decision: decisionOf(head),
		stale: isStale,
		laterChanges: isStale ? Math.max(changed.length, 1) : 0,
		analyticsOutdated: review.analyticsVersion < ANALYTICS_VERSION,
		writeUp: review.narrative ? { state: 'written', text: review.narrative } : { state: 'none' },
		previews: open
			? (await plannedOf(db, ownerId, review, head.id, read, { today, profile })).map(
					(p) => p.preview
				)
			: []
	};
}
