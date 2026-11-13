/**
 * Planning the next cycle on real Postgres (services/reviews/next-cycle.ts and
 * services/coach/apply/next-cycle.ts, the M6 plan's next-cycle-apply), from the block-end and
 * block-end-late fixtures seeded at a forced today:
 * - deciding plans the previewed block as one new version: the outline block planned under its
 *   lineage, loads from the block's e1RMs (basis estimated), kept and rotated exercises as the
 *   directives say; version N reads as it did, the review names the new version, and a second
 *   decision writes nothing
 * - the planned block is the season's (M7's next-cycle-periodised): its weeks from the directives'
 *   weekPlan, decisions recording its block type and its goal's mode, an owner override clamped
 * - a stale fingerprint is refused, one made under the next block's id before m7-stage-list or
 *   before next-cycle-periodised too, and the fresh preview's applies once; no outline appends a block; three weeks late plans a bridge
 *   and the outline from its shifted date; an owner override keeps a rotated exercise through a
 *   revision whose decision reads applied
 * - every path of M5's inbox: the review's own proposal is a 409 choose_start with the review's
 *   link, a coach next_cycle is folded into the undecided review, and once the block is planned
 *   any other open next_cycle is superseded as cycle_planned
 * Today is Wednesday 18 Nov 2026 in Los Angeles; block-end's block ends this Sunday and its
 * outline block (Build, four weeks) starts on Monday 23 Nov.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import * as strength from '../../../src/lib/domain/analytics/strength';
import { localDay } from '../../../src/lib/domain/dates';
import type { ProgrammingInput } from '../../../src/lib/domain/programming/input';
import type * as Random from '../../../src/lib/domain/programming/random';
import { GENERATOR_ID } from '../../../src/lib/domain/programming/next-block/generate';
import type { CycleDirectives } from '../../../src/lib/domain/programming/review/directives';
import { cleanFloat } from '../../../src/lib/domain/units';
import type { Executor } from '../../../src/lib/server/db';
import {
	acceptProposal,
	createProposal,
	type RulesProvenance
} from '../../../src/lib/server/services/coach/proposals';
import {
	cycleReviewHref,
	NextCycleConflictError
} from '../../../src/lib/server/services/coach/apply/next-cycle';
import { getExercisesByIds } from '../../../src/lib/server/services/exercises/index';
import { listGoals, saveSchedule } from '../../../src/lib/server/services/profile/index';
import {
	getProgramVersion,
	type StoredBlock
} from '../../../src/lib/server/services/programs/index';
import {
	createCycleReview,
	decideNextCycle,
	decisionState,
	getCycleReview,
	getCycleReviewView,
	OWNER_KEPT,
	type DecideNextCycle,
	type NextBlockPreview
} from '../../../src/lib/server/services/reviews';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import type { ReviewFixtureResult } from '../../../src/lib/server/test-support/analytics-fixtures/reviews';
import { POST } from '../../../src/routes/api/coach/proposals/[id]/+server';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/**
 * fingerprint() as it is, recording what the next block hashed last, so a test can make the
 * fingerprint the same preview had under the next block's id before m7-stage-list.
 */
const hashed = vi.hoisted(() => ({
	last: null as null | { input: ProgrammingInput; digest: string },
	actual: null as null | ((input: ProgrammingInput, digest: string, generator?: string) => string)
}));
vi.mock('../../../src/lib/domain/programming/random', async (importOriginal) => {
	const random = await importOriginal<typeof Random>();
	hashed.actual = random.fingerprint;
	return {
		...random,
		fingerprint: (input: ProgrammingInput, digest: string, generator?: string) => {
			if (generator?.startsWith('next-block/')) hashed.last = { input, digest };
			return random.fingerprint(input, digest, generator);
		}
	};
});

const TZ = 'America/Los_Angeles';
const TODAY = '2026-11-18';
const BUILD_STARTS = '2026-11-23';
const nowOn = (day: string) => () => atLocal(day, '12:00', TZ);

type Seeded = ReviewFixtureResult & { exercises: Record<string, string> };

/** The fixture seeded on `today`, its block's review created, and bench made to stall. */
async function reviewed(
	db: Executor,
	fixture: 'block-end' | 'block-end-late',
	{ stallBench = false, today = TODAY } = {}
) {
	const owner = await makeOwner(db);
	const seeded = (await seedAnalyticsFixture(
		owner,
		fixture,
		{ timeZone: TZ, now: nowOn(today)() },
		{ db }
	)) as unknown as Seeded;
	// Bench at one load all block: held over eight sessions, stalled, so the rules rotate it.
	if (stallBench)
		await db.execute(
			sql`update set_records set weight = 80 where exercise_id = ${seeded.exercises.bench_press}`
		);
	const programId = seeded.programId!;
	const v1 = await getProgramVersion(owner, programId, 1, { db });
	const target = { programId, blockLineage: v1.blocks[0]!.lineage };
	const deps = { db, now: nowOn(today) };
	const { review } = await createCycleReview(owner, { ...target, today }, deps);
	return { owner, seeded, programId, v1, target, review, deps };
}
type Reviewed = Awaited<ReturnType<typeof reviewed>>;

/** The review page's preview of `start` on `today`. */
async function preview(r: Reviewed, start: NextBlockPreview['start'], today = TODAY) {
	const view = await getCycleReviewView(
		r.owner,
		{ ...r.target, today },
		{ db: r.deps.db, now: nowOn(today) }
	);
	return view.previews.find((p) => p.start === start)!;
}

const decide = (r: Reviewed, input: DecideNextCycle, today = TODAY) =>
	decideNextCycle(r.owner, r.review.id, input, { db: r.deps.db, now: nowOn(today) });

async function versions(db: Executor, programId: string) {
	const { rows } = await db.execute<{
		id: string;
		number: number;
		created_by: string;
		summary: string;
		generator: string | null;
		input_fingerprint: string | null;
		catalogue_digest: string | null;
		input_snapshot: { baselines: Record<string, { kg: number; kind: string }>; dislikes: string[] };
	}>(sql`select * from program_versions where program_id = ${programId} order by number`);
	return rows;
}

async function proposalRow(db: Executor, id: string) {
	const { rows } = await db.execute<{
		status: string;
		superseded_reason: string | null;
		revision_of: string | null;
		applied_version_id: string | null;
		payload: Record<string, unknown>;
		evidence: { source: RulesProvenance; folded: string[]; directives: { keep: unknown[] } };
	}>(sql`select * from coach_proposals where id = ${id}`);
	return rows[0]!;
}

/** Every exercise key a block plans. */
const keysIn = (block: StoredBlock) =>
	new Set(
		block.weeks.flatMap((w) =>
			w.sessions.flatMap((s) =>
				s.kind === 'strength' ? s.exercises.map((e) => (e.exercise as { key: string }).key) : []
			)
		)
	);

/** A coach next_cycle for the reviewed block, as the coach's propose tool drafts one. */
async function coachNextCycle(r: Reviewed, over: Record<string, unknown> = {}) {
	const payload = {
		...{ fromBlockLineage: r.target.blockLineage, focus: 'Coach: heavier triples' },
		...{ phase: 'accumulation', weeks: 4, emphasis: [], rotation: [], running: null },
		targets: { rpeCap: 8, volumeFactor: 0.8, loadStep: 0.025, runVolumeFactor: 1 },
		...{ ending: 'none', constraints: ['Keep Tuesdays for the class'] },
		...over
	};
	const draft = { kind: 'next_cycle', title: 'Next block', rationale: 'Go heavier', payload };
	return (await createProposal(r.owner, { proposal: draft }, r.deps)).proposal;
}

describe('deciding the next cycle', () => {
	it('plans the previewed block as one version: the outline lineage, e1RM loads, kept and rotated exercises', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, 'block-end', { stallBench: true });
			const shown = await preview(r, 'next_monday');
			const v1Before = await getProgramVersion(r.owner, r.programId, 1, { db });

			const decided = await decide(r, { start: 'next_monday', fingerprint: shown.fingerprint });
			expect(decided).toMatchObject({
				outcome: 'applied',
				proposalId: r.review.proposalId,
				versionNumber: 2
			});

			const [, v2row] = await versions(db, r.programId);
			expect(v2row).toMatchObject({
				id: decided.outcome === 'applied' ? decided.versionId : null,
				created_by: 'rules',
				summary: `Next block: ${shown.block.name}`,
				generator: 'next-block/2+perfo-programming/6',
				input_fingerprint: shown.fingerprint
			});
			expect(v2row!.catalogue_digest).toMatch(/^[0-9a-f]{16}$/);

			// The outline block is planned under its own lineage, from Monday, the base block shared.
			const v2 = await getProgramVersion(r.owner, r.programId, 2, { db });
			const [base, build] = r.v1.blocks;
			expect(v2.blocks.map((b) => [b.lineage, b.outline])).toEqual([
				[base!.lineage, false],
				[build!.lineage, false]
			]);
			expect(v2.blocks[0]!.id).toBe(base!.id);
			const planned = v2.blocks[1]!;
			expect(planned).toMatchObject({ startsOn: BUILD_STARTS, endsOn: '2026-12-20' });
			expect(planned.weeks.flatMap((w) => w.sessions).length).toBeGreaterThan(0);

			// Loads start from the block's latest e1RM, read here from SQL rows: basis estimated.
			const { rows: sets } = await db.execute<Record<string, unknown>>(
				sql`select r.id::text as id, r.workout_id as "workoutId", r.exercise_id as exercise,
						r.set_index as "setIndex", r.weight::float as weight, r.unit, r.reps,
						r.missed_reps as "missedReps", r.rpe::float as rpe, r.is_warmup as "isWarmup",
						r.is_extra as "isExtra", r.is_skipped as "isSkipped", r.performed_at as "performedAt"
					from set_records r where r.owner_id = ${r.owner}
						and r.exercise_id = ${r.seeded.exercises.back_squat} and r.deleted_at is null`
			);
			const squat = (
				await getExercisesByIds(r.owner, [r.seeded.exercises.back_squat!], { db })
			).get(r.seeded.exercises.back_squat!)!;
			const facts = sets.map((s) => ({
				...s,
				performedAt: new Date(s.performedAt as string),
				deletedAt: null
			})) as unknown as strength.StrengthFact[];
			const e1rm = cleanFloat(strength.e1rmSeries(facts, squat, TZ).at(-1)!.value, 1);
			expect(v2row!.input_snapshot.baselines.back_squat).toEqual({ kg: e1rm, kind: 'estimated' });
			const squatLines = planned.weeks
				.flatMap((w) => w.sessions)
				.flatMap((s) => (s.kind === 'strength' ? s.exercises : []))
				.filter((e) => (e.exercise as { key: string }).key === 'back_squat')
				.flatMap((e) => e.sets);
			expect(squatLines.length).toBeGreaterThan(0);
			expect(squatLines.some((l) => l.loadBasis === 'estimated' && l.reference1rm === e1rm)).toBe(
				true
			);

			// Squat and deadlift progressed: kept, each with its decision. Bench stalled: rotated out.
			const keys = keysIn(planned);
			expect(keys.has('back_squat') && keys.has('deadlift')).toBe(true);
			expect(keys.has('bench_press')).toBe(false);
			expect(v2row!.input_snapshot.dislikes).toContain('bench_press');
			const kept = v2.decisions.filter((d) => d.kind === 'exercise_kept');
			expect(kept).toHaveLength(2);

			// Version 1 reads as it did; the review names version 2; the proposal is applied with it.
			expect(await getProgramVersion(r.owner, r.programId, 1, { db })).toEqual({
				...v1Before,
				version: { ...v1Before.version, current: false }
			});
			expect((await getCycleReview(r.owner, r.review.id, { db })).nextVersionId).toBe(v2row!.id);
			expect(await proposalRow(db, r.review.proposalId!)).toMatchObject({
				status: 'applied',
				applied_version_id: v2row!.id
			});

			// A second decision returns the first and writes nothing.
			const again = await decide(r, { start: 'next_monday', fingerprint: shown.fingerprint });
			expect(again).toEqual(decided);
			expect(await versions(db, r.programId)).toHaveLength(2);
			expect(
				(await getCycleReviewView(r.owner, { ...r.target, today: TODAY }, r.deps)).previews
			).toEqual([]);
		});
	});

	it('stores the season’s block: its weeks, and decisions that record its type and its goal’s mode', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, 'block-end');
			const shown = await preview(r, 'next_monday');
			await decide(r, { start: 'next_monday', fingerprint: shown.fingerprint });
			const v2 = await getProgramVersion(r.owner, r.programId, 2, { db });
			const planned = v2.blocks[1]!;

			// The weeks are the season's (past its block, its last loading week again).
			const own = await proposalRow(db, r.review.proposalId!);
			const plan = (own.evidence.directives as unknown as CycleDirectives).weekPlan!;
			const season = planned.weeks.map((_, i) => plan[i] ?? plan.at(-1)!);
			expect(planned.weeks.map((w) => w.kind)).toEqual(season.map((w) => w.kind));
			expect(planned.weeks.map((w) => w.targets.mainLifts)).toEqual(
				season.map((w) => w.targets.mainLifts)
			);
			expect(planned.weeks[0]!.targets.mainLifts).toBeDefined();

			// Its type, as the season chose it for the block's dates, and the goal's mode.
			const types = v2.decisions.filter((d) => d.kind === 'block_type_chosen');
			expect(types.map((d) => d.evidence)).toEqual([
				expect.objectContaining({
					type: 'strength',
					block: planned.name,
					weeks: 4,
					startsOn: BUILD_STARTS
				})
			]);
			const [goal] = await listGoals(r.owner, { db });
			const modes = v2.decisions.filter((d) => d.kind === 'priority_resolved');
			expect(modes.map((d) => d.evidence)).toContainEqual(
				expect.objectContaining({ goalRef: goal!.id, mode: 'primary' })
			);
		});
	});

	it('holds an owner’s override to the review’s bounds on the season’s weeks', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, 'block-end');
			const shown = await preview(r, 'next_monday');
			const targets = { rpeCap: 9.5, volumeFactor: 0.8, loadStep: 0.025, runVolumeFactor: 1 };
			const decided = await decide(r, {
				start: 'next_monday',
				fingerprint: shown.fingerprint,
				overrides: { targets }
			});
			expect(decided.outcome).toBe('applied');
			const own = await proposalRow(db, r.review.proposalId!);
			const cap = (own.payload.targets as { rpeCap: number }).rpeCap;
			expect(cap).toBeLessThan(9.5);
			const revision = await proposalRow(db, decided.proposalId);
			expect((revision.evidence as unknown as { clamps: unknown[] }).clamps).toEqual([
				{ field: 'targets.rpeCap', asked: 9.5, used: cap }
			]);

			const v2 = await getProgramVersion(r.owner, r.programId, 2, { db });
			const weeks = v2.blocks[1]!.weeks;
			const plan = (own.evidence.directives as unknown as CycleDirectives).weekPlan!;
			const season = weeks.map((_, i) => plan[i] ?? plan.at(-1)!);
			expect(weeks.every((w) => w.targets.rpeCap <= cap)).toBe(true);
			expect(weeks.map((w) => w.targets.volumeFactor)).toEqual(
				season.map((w) => cleanFloat(w.targets.volumeFactor * 0.8, 3))
			);
		});
	});

	it('refuses a fingerprint from before a profile change, and writes nothing', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, 'block-end');
			const shown = await preview(r, 'next_monday');
			await saveSchedule(
				r.owner,
				{
					daysPerWeek: 5,
					availableDays: ['mon', 'tue', 'wed', 'thu', 'sat'],
					preferredTimes: ['morning', 'evening'],
					sessionMinutes: 75,
					commitments: []
				},
				{ db }
			);
			const refused = await decide(r, {
				start: 'next_monday',
				fingerprint: shown.fingerprint
			}).catch((e: unknown) => e);
			expect(refused).toBeInstanceOf(NextCycleConflictError);
			expect(refused).toMatchObject({ reason: 'profile' });
			expect(await versions(db, r.programId)).toHaveLength(1);
			expect((await decisionState(r.owner, r.review, { db })).state).toBe('undecided');

			// The fresh preview's fingerprint plans it.
			const fresh = await preview(r, 'next_monday');
			const decided = await decide(r, { start: 'next_monday', fingerprint: fresh.fingerprint });
			expect(decided).toMatchObject({ outcome: 'applied', versionNumber: 2 });
		});
	});

	// 'next-block/1' before m7-stage-list, 'next-block/1+…' before the season planned the next block.
	it.each(['next-block/1', 'next-block/1+perfo-programming/6'])(
		"refuses a preview made under '%s', then re-previews and applies once",
		async (id) => {
			await withRollback(async (db) => {
				const r = await reviewed(db, 'block-end');
				hashed.last = null;
				const shown = await preview(r, 'next_monday');
				const { input, digest } = hashed.last!;
				expect(hashed.actual!(input, digest, GENERATOR_ID)).toBe(shown.fingerprint);
				// The same preview, fingerprinted by an id the next block stored before.
				const before = hashed.actual!(input, digest, id);
				expect(before).not.toBe(shown.fingerprint);

				const refused = await decide(r, { start: 'next_monday', fingerprint: before }).catch(
					(e: unknown) => e
				);
				expect(refused).toBeInstanceOf(NextCycleConflictError);
				expect(refused).toMatchObject({ reason: 'profile' });
				expect(await versions(db, r.programId)).toHaveLength(1);
				expect((await decisionState(r.owner, r.review, { db })).state).toBe('undecided');

				// The review previews again with the new fingerprint, which applies once.
				const fresh = await preview(r, 'next_monday');
				expect(fresh.fingerprint).toBe(shown.fingerprint);
				const decided = await decide(r, { start: 'next_monday', fingerprint: fresh.fingerprint });
				expect(decided).toMatchObject({ outcome: 'applied', versionNumber: 2 });
				// Once: deciding again returns that decision and writes nothing.
				expect(await decide(r, { start: 'next_monday', fingerprint: fresh.fingerprint })).toEqual(
					decided
				);
				const rows = await versions(db, r.programId);
				expect(rows.map((v) => [v.number, v.generator])).toEqual([
					[1, rows[0]!.generator],
					[2, GENERATOR_ID]
				]);
			});
		}
	);

	it('with no outline left, appends the block after a bridge', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, 'block-end-late');
			const shown = await preview(r, 'next_monday');
			expect(shown.dates.block.outline).toBeNull();
			const decided = await decide(r, { start: 'next_monday', fingerprint: shown.fingerprint });
			expect(decided).toMatchObject({ outcome: 'applied', versionNumber: 2 });
			const v2 = await getProgramVersion(r.owner, r.programId, 2, { db });
			const [base, bridge, appended] = v2.blocks;
			expect(v2.blocks).toHaveLength(3);
			expect(base!.lineage).toBe(r.v1.blocks[0]!.lineage);
			expect(bridge).toMatchObject({ phase: 'transition', startsOn: '2026-11-02' });
			expect(bridge!.weeks.map((w) => w.kind)).toEqual(['unplanned', 'unplanned', 'unplanned']);
			expect(appended).toMatchObject({ outline: false, startsOn: '2026-11-23' });
			expect(appended!.lineage).not.toBe(base!.lineage);
		});
	});

	it("three weeks late with 'this week': a bridge and the outline planned from its shifted date, in one version", async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, 'block-end');
			const late = '2026-12-16';
			const shown = await preview(r, 'this_week', late);
			expect(shown.dates.bridge).toEqual({
				startsOn: BUILD_STARTS,
				endsOn: '2026-12-13',
				weeks: 3
			});
			const decided = await decide(r, { start: 'this_week', fingerprint: shown.fingerprint }, late);
			expect(decided).toMatchObject({ outcome: 'applied', versionNumber: 2 });
			const v2 = await getProgramVersion(r.owner, r.programId, 2, { db });
			const [, bridge, build] = v2.blocks;
			expect(bridge).toMatchObject({ phase: 'transition', startsOn: BUILD_STARTS });
			expect(bridge!.weeks.every((w) => w.sessions.length === 0)).toBe(true);
			expect(build).toMatchObject({
				lineage: r.v1.blocks[1]!.lineage,
				outline: false,
				startsOn: '2026-12-14',
				endsOn: '2027-01-10'
			});
			const days = build!.weeks.flatMap((w) => w.sessions.map((s) => s.date));
			expect(days.length).toBeGreaterThan(0);
			expect(days.every((d) => d >= late)).toBe(true);
		});
	});

	it('an owner override keeps an exercise the rules rotate, through a revision whose decision reads applied', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, 'block-end', { stallBench: true });
			const shown = await preview(r, 'next_monday');
			const bench = r.seeded.exercises.bench_press!;
			const decided = await decide(r, {
				start: 'next_monday',
				fingerprint: shown.fingerprint,
				overrides: { keep: [bench] }
			});
			expect(decided.outcome).toBe('applied');
			const revisionId = decided.proposalId;
			expect(revisionId).not.toBe(r.review.proposalId);

			const revision = await proposalRow(db, revisionId);
			expect(revision).toMatchObject({ status: 'applied', revision_of: r.review.proposalId });
			expect(revision.evidence.source).toMatchObject({
				kind: 'cycle_review',
				reviewId: r.review.id,
				modifiedBy: 'owner'
			});
			expect(revision.evidence.directives.keep).toContainEqual({
				exercise: bench,
				reason: OWNER_KEPT
			});
			expect(await proposalRow(db, r.review.proposalId!)).toMatchObject({
				status: 'superseded',
				superseded_reason: 'revised'
			});

			const [, v2row] = await versions(db, r.programId);
			expect(v2row).toMatchObject({ created_by: 'owner' });
			expect(v2row!.input_snapshot.dislikes).not.toContain('bench_press');
			const v2 = await getProgramVersion(r.owner, r.programId, 2, { db });
			expect(keysIn(v2.blocks[1]!).has('bench_press')).toBe(true);
			expect(await decisionState(r.owner, r.review, { db })).toEqual({
				state: 'applied',
				proposalId: revisionId,
				versionId: v2row!.id,
				versionNumber: 2
			});
		});
	});

	it('rejecting plans nothing', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, 'block-end');
			const decided = await decide(r, { reject: true, note: 'Taking a break' });
			expect(decided).toEqual({ outcome: 'rejected', proposalId: r.review.proposalId });
			expect(await versions(db, r.programId)).toHaveLength(1);
			expect((await getCycleReview(r.owner, r.review.id, { db })).nextVersionId).toBeNull();
		});
	});
});

describe("M5's inbox", () => {
	it("refuses the review's own proposal with a 409 choose_start and the review's link, applying nothing", async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const now = new Date();
			const seeded = (await seedAnalyticsFixture(
				owner,
				'block-end',
				{ timeZone: TZ, now },
				{
					db
				}
			)) as unknown as Seeded;
			const v1 = await getProgramVersion(owner, seeded.programId!, 1, { db });
			const { review } = await createCycleReview(
				owner,
				{
					programId: seeded.programId!,
					blockLineage: v1.blocks[0]!.lineage,
					today: localDay(now, TZ)
				},
				{ db, now: () => now }
			);
			const request = new Request(
				`http://localhost:5173/api/coach/proposals/${review.proposalId}`,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ action: 'accept' })
				}
			);
			const response = (await POST({
				request,
				params: { id: review.proposalId! },
				url: new URL(request.url),
				locals: { session: { id: crypto.randomUUID(), ownerId: owner }, requestId: 'req-test' },
				getClientAddress: () => '127.0.0.1'
			} as never)) as Response;
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				error: 'conflict',
				reason: 'choose_start',
				href: `/progress/reviews/c-${review.id}`,
				message: 'Choose when it starts in your cycle review'
			});
			expect(await proposalRow(db, review.proposalId!)).toMatchObject({ status: 'proposed' });
			expect(await versions(db, seeded.programId!)).toHaveLength(1);
		});
	});

	it('folds a coach next_cycle accepted after the review into an owner revision of its head', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, 'block-end');
			const coach = await coachNextCycle(r, {
				targets: { rpeCap: 9.5, volumeFactor: 0.8, loadStep: 0.025, runVolumeFactor: 1 }
			});
			const accepted = await acceptProposal(r.owner, coach.id, r.deps);
			expect(accepted.proposal).toMatchObject({
				status: 'superseded',
				supersededReason: 'folded_into_review'
			});
			expect(accepted.href).toBe(cycleReviewHref(r.review.id));

			const decision = await decisionState(r.owner, r.review, { db });
			expect(decision.state).toBe('undecided');
			const head = await proposalRow(db, (decision as { proposalId: string }).proposalId);
			expect(head).toMatchObject({ status: 'proposed', revision_of: r.review.proposalId });
			expect(head.evidence.source).toMatchObject({ reviewId: r.review.id, modifiedBy: 'owner' });
			expect(head.evidence.folded).toEqual([coach.id]);
			// Within bounds: the coach's focus and volume, the RPE held to the directed cap.
			const own = await proposalRow(db, r.review.proposalId!);
			expect(own).toMatchObject({ status: 'superseded', superseded_reason: 'revised' });
			expect(head.payload).toMatchObject({
				focus: 'Coach: heavier triples',
				targets: { rpeCap: (own.payload.targets as { rpeCap: number }).rpeCap, volumeFactor: 0.8 }
			});

			// The preview plans from the folded head, and deciding applies it.
			const shown = await preview(r, 'next_monday');
			// The coach's 0.8 scales the season's weekly factors.
			// Past the season's block, its last loading week repeats.
			const plan = (head.evidence.directives as unknown as CycleDirectives).weekPlan!;
			const season = [0, 1, 2, 3].map((i) => plan[i] ?? plan.at(-1)!);
			expect(shown.block.weeks.map((w) => w.targets.volumeFactor)).toEqual(
				season.map((w) => cleanFloat(w.targets.volumeFactor * 0.8, 3))
			);
			const decided = await decide(r, { start: 'next_monday', fingerprint: shown.fingerprint });
			const headId = (decision as { proposalId: string }).proposalId;
			expect(decided).toMatchObject({ outcome: 'applied', proposalId: headId });
			expect((await versions(db, r.programId)).at(-1)!.created_by).toBe('owner');
		});
	});

	it("still refuses the review's own proposal with choose_start once the program has a newer version", async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, 'block-end');
			// An owner edit after the review: version 2, which the review's proposal is not on.
			await db.execute(sql`
				with v as (
					insert into program_versions
						(program_id, number, parent_version_id, created_by, summary, starts_on, first_planned_day)
					select program_id, 2, id, 'owner', 'An owner edit', starts_on, first_planned_day
					from program_versions where program_id = ${r.programId} and number = 1
					returning id, program_id
				)
				update programs set current_version_id = v.id from v where programs.id = v.program_id`);
			const refused = acceptProposal(r.owner, r.review.proposalId!, r.deps);
			await expect(refused).rejects.toMatchObject({
				reason: 'choose_start',
				href: cycleReviewHref(r.review.id)
			});
			expect(await proposalRow(db, r.review.proposalId!)).toMatchObject({ status: 'proposed' });
		});
	});

	it('supersedes an open coach next_cycle as cycle_planned once the block is planned, and a later accept too', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, 'block-end');
			const open = await coachNextCycle(r);
			const shown = await preview(r, 'next_monday');
			await decide(r, { start: 'next_monday', fingerprint: shown.fingerprint });
			expect(await proposalRow(db, open.id)).toMatchObject({
				status: 'superseded',
				superseded_reason: 'cycle_planned'
			});

			// Proposed against version 2 and accepted: the review's block is planned already.
			const later = await coachNextCycle(r, { focus: 'Coach: one more idea' });
			const accepted = await acceptProposal(r.owner, later.id, r.deps);
			expect(accepted.proposal).toMatchObject({
				status: 'superseded',
				supersededReason: 'cycle_planned'
			});
			expect(await versions(db, r.programId)).toHaveLength(2);
		});
	});
});
