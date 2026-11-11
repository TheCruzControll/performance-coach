/**
 * Cycle reviews on real Postgres (services/reviews/cycle.ts, the M6 plan's cycle-review-service),
 * from the block-end and block-end-late fixtures seeded at a forced today:
 * - adherence, effectiveness, hard sets, goal progress and the deload need equal the domain
 *   functions over rows read here in SQL
 * - a review is stored with its snapshot, once, and refused before its block is reviewable
 * - its next_cycle proposal is the directives' subset, with evidence.source naming the review
 * - a next_cycle the owner accepted from the coach is folded in within bounds and superseded
 * - previews a week and three weeks late carry the bridge and shifted dates, fit the whole
 *   version (programPlanSchema's checkPlan) and plan nothing before today; they are deterministic
 *   and their fingerprint follows the profile
 * - a late set makes it stale and a refresh supersedes it; everything is owner-scoped
 * - an M7 hypertrophy block's weeks are judged by their own rising ranges (periodised-targets)
 * Today is Wednesday 18 Nov 2026 in Los Angeles.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as strength from '../../../src/lib/domain/analytics/strength';
import { proposalSchema } from '../../../src/lib/domain/coach/proposals';
import {
	directivesFrom,
	modifiableSubset,
	type CycleDirectives
} from '../../../src/lib/domain/programming/review/directives';
import { programPlanSchema } from '../../../src/lib/domain/training/schemas';
import type { BlockPlan, ProgramPlan } from '../../../src/lib/domain/training/types';
import { validate } from '../../../src/lib/domain/validation';
import type { Executor } from '../../../src/lib/server/db';
import { acceptProposal, createProposal } from '../../../src/lib/server/services/coach/proposals';
import { getMuscleTargets } from '../../../src/lib/server/services/analytics/targets';
import { getExercisesByIds } from '../../../src/lib/server/services/exercises/index';
import { listGoals, saveSchedule } from '../../../src/lib/server/services/profile/index';
import { getProgramVersion } from '../../../src/lib/server/services/programs/index';
import {
	createCycleReview,
	CycleReviewNotReviewableError,
	getCycleReviewView,
	refreshCycleReview,
	reviewableBlock,
	ReviewNotFoundError,
	type NextBlockPreview
} from '../../../src/lib/server/services/reviews';
import { finishWorkout, logSet, startWorkout } from '../../../src/lib/server/services/training/log';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import type { ReviewFixtureResult } from '../../../src/lib/server/test-support/analytics-fixtures/reviews';
import { addDays } from '../../../src/lib/domain/calendar';
import { M7_SCENARIOS } from '../../../src/lib/domain/programming/periodisation/scenarios';
import { SCENARIO_START } from '../../../src/lib/domain/programming/scenarios';
import { logAsPlanned, storeM7Program } from '../analytics/fixtures/m7-programs';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const TODAY = '2026-11-18';
/** block-end's block: the four weeks ending this Sunday. */
const BLOCK = { from: '2026-10-26', to: '2026-11-22' };
const nowOn = (day: string) => () => atLocal(day, '12:00', TZ);

type Seeded = ReviewFixtureResult & { exercises: Record<string, string> };

async function seed(db: Executor, fixture: string) {
	const owner = await makeOwner(db);
	const seeded = (await seedAnalyticsFixture(
		owner,
		fixture,
		{ timeZone: TZ, now: nowOn(TODAY)() },
		{ db }
	)) as unknown as Seeded;
	const { rows } = await db.execute<{ lineage: string }>(
		sql`select b.lineage_id::text as lineage from programs p
			join program_version_blocks vb on vb.version_id = p.current_version_id
			join program_blocks b on b.id = vb.block_id
			where p.owner_id = ${owner} and not b.outline order by b.starts_on limit 1`
	);
	const target = { programId: seeded.programId!, blockLineage: rows[0]!.lineage };
	return { owner, seeded, target, deps: { db, now: nowOn(TODAY) } };
}
type Target = Awaited<ReturnType<typeof seed>>['target'];

const review = (owner: string, target: Target, deps: { db: Executor }, today = TODAY) =>
	createCycleReview(owner, { ...target, today }, { ...deps, now: nowOn(today) });
const view = (owner: string, target: Target, db: Executor, today = TODAY) =>
	getCycleReviewView(owner, { ...target, today }, { db, now: nowOn(today) });

async function proposalRow(db: Executor, id: string) {
	const { rows } = await db.execute<{
		kind: string;
		status: string;
		superseded_reason: string | null;
		title: string;
		rationale: string;
		payload: Record<string, unknown>;
		evidence: { source: unknown; directives: CycleDirectives; clamps: unknown[]; folded: string[] };
	}>(sql`select * from coach_proposals where id = ${id}`);
	return rows[0]!;
}

/** The block's completed, undeleted sets, as the strength functions read them. */
async function blockSets(db: Executor, owner: string) {
	const { rows } = await db.execute<Record<string, unknown>>(
		sql`select r.id::text as id, r.workout_id as "workoutId", r.exercise_id as exercise,
				r.planned_exercise_lineage_id as "plannedLineage", r.set_index as "setIndex",
				r.weight::float as weight, r.unit, r.assistance, r.reps, r.missed_reps as "missedReps",
				r.seconds, r.metres, r.rpe::float as rpe, r.is_warmup as "isWarmup",
				r.is_extra as "isExtra", r.is_skipped as "isSkipped", r.performed_at as "performedAt"
			from set_records r
			join workouts x on x.id = r.workout_id and x.status = 'completed' and x.deleted_at is null
			where r.owner_id = ${owner} and r.deleted_at is null
				and (r.performed_at at time zone ${TZ})::date between ${BLOCK.from} and ${BLOCK.to}`
	);
	return rows.map((s) => ({
		...s,
		performedAt: new Date(s.performedAt as string),
		deletedAt: null
	})) as unknown as strength.StrengthFact[];
}

/** A bench set logged now in an ad hoc workout inside block-end's block. */
async function lateSet(db: Executor, owner: string, benchId: string) {
	const at = atLocal('2026-11-04', '18:00', TZ);
	const clientId = crypto.randomUUID();
	const workout = { clientId, kind: 'strength', discipline: 'strength', sessionType: 'strength' };
	const started = { ...workout, title: 'Extra bench', plannedSessionId: null };
	await startWorkout(owner, { ...started, startedAt: at.toISOString() }, { db });
	await logSet(
		owner,
		{
			...{ clientMutationId: crypto.randomUUID(), workoutClientId: clientId },
			...{ exerciseId: benchId, plannedExerciseLineageId: null, exercisePosition: 1, setIndex: 1 },
			...{ weight: 60, unit: 'kg', reps: 5, missedReps: 0, rpe: 6, seconds: null, metres: null },
			...{ isExtra: false, isSkipped: false, isWarmup: false },
			performedAt: new Date(at.getTime() + 60_000).toISOString()
		},
		{ db }
	);
	const finishedAt = new Date(at.getTime() + 20 * 60_000).toISOString();
	const done = { status: 'completed', finishedAt, durationSeconds: 1200, sessionRpe: 6 };
	await finishWorkout(owner, clientId, done, { db });
}

/** The whole version with `preview` in place of what follows the reviewed block. */
async function wholeVersion(
	db: Executor,
	owner: string,
	target: Target,
	preview: NextBlockPreview
) {
	const found = await db.execute<{ number: number }>(
		sql`select v.number from programs p join program_versions v on v.id = p.current_version_id
			where p.id = ${target.programId}`
	);
	const version = await getProgramVersion(owner, target.programId, found.rows[0]!.number, { db });
	const reviewed = version.blocks.findIndex((b) => b.lineage === target.blockLineage);
	const outline = (b: (typeof preview.dates.shifted)[number]): BlockPlan => ({
		...b,
		goalRefs: [],
		progression: {},
		weeks: []
	});
	const plan: ProgramPlan = {
		title: version.title,
		startsOn: version.startsOn,
		firstPlannedDay: version.firstPlannedDay,
		blocks: [
			...(version.blocks.slice(0, reviewed + 1) as unknown as BlockPlan[]),
			...(preview.bridge ? [preview.bridge] : []),
			preview.block,
			...preview.dates.shifted.map(outline)
		],
		decisions: []
	};
	return programPlanSchema.safeParse(plan).error?.issues ?? [];
}

const sessionDays = (p: NextBlockPreview) =>
	p.block.weeks.flatMap((w) => w.sessions.map((s) => s.date));

describe('creating a cycle review', () => {
	it('evaluates adherence, effectiveness, hard sets, goals and deload need as the domain functions do over SQL rows', async () => {
		await withRollback(async (db) => {
			const { owner, target, deps } = await seed(db, 'block-end');
			const { review: stored } = await review(owner, target, deps);
			expect(stored.read.legacy).toBe(false);
			const snapshot = stored.read.legacy ? null! : stored.read.snapshot;
			expect(snapshot.block).toMatchObject({ ...BLOCK, weeks: 4, name: 'Base' });

			// Planned against completed: the block's sessions in the current version and their workouts.
			const { rows: planned } = await db.execute<{ planned: number; completed: number }>(
				sql`select count(*)::int as planned, count(*) filter (where exists (
						select 1 from workouts x where x.planned_lineage_id = s.lineage_id
						and x.status = 'completed' and x.deleted_at is null))::int as completed
					from programs p
					join program_version_weeks vw on vw.version_id = p.current_version_id
					join program_weeks w on w.id = vw.week_id
					join planned_sessions s on s.week_id = w.id
					where p.owner_id = ${owner} and s.scheduled_on between ${BLOCK.from} and ${BLOCK.to}
						and s.status <> 'skipped'`
			);
			expect(planned[0]!.planned).toBe(22);
			expect(snapshot.adherence).toMatchObject({ ...planned[0], pct: 100 });

			// Effectiveness: each lift's e1RM series, the best of its earlier half against its later.
			const sets = await blockSets(db, owner);
			const exercises = await getExercisesByIds(
				owner,
				sets.map((s) => s.exercise),
				{ db }
			);
			expect(snapshot.effectiveness).toHaveLength(3);
			for (const e of snapshot.effectiveness) {
				const theirs = sets.filter((s) => s.exercise === e.exercise);
				const points = strength.e1rmSeries(theirs, exercises.get(e.exercise)!, TZ);
				const half = Math.floor(points.length / 2);
				const best = (list: typeof points) => Math.max(...list.map((p) => p.value));
				expect(e.exposures).toBe(points.length);
				expect(e.firstKg).toBeCloseTo(best(points.slice(0, half)), 2);
				expect(e.lastKg).toBeCloseTo(best(points.slice(points.length - half)), 2);
				// +2.5 kg a week at the same reps and RPE: every lift progressed.
				expect(e.verdict).toBe('progressed');
			}

			// Hard sets achieved per group and week, against M3's hardSets over the same rows.
			const weeks = { from: BLOCK.from, to: BLOCK.to, count: 4 };
			const window = {
				weeks,
				inProgress: { weekStart: '2026-11-23', through: '2026-11-23', days: 1 }
			};
			const hard = strength.weeklyHardSets(sets, exercises, TZ, window);
			const achieved = snapshot.volume.filter((r) => r.achieved > 0);
			expect(achieved.length).toBeGreaterThan(0);
			for (const row of achieved) {
				const n = (Date.parse(row.weekStartsOn) - Date.parse(BLOCK.from)) / 604_800_000;
				expect(row.achieved).toBeCloseTo(hard[n]!.groups[row.group]!, 2);
			}
			// Planned hard sets and the range per group and week, against targets.ts over the plan.
			const targets = await getMuscleTargets(owner, BLOCK, { db });
			expect(snapshot.volume.some((r) => r.planned !== null)).toBe(true);
			for (const row of snapshot.volume) {
				const week = targets.find((t) => t.weekStart === row.weekStartsOn)!;
				expect(row.planned).toBe(week.planned?.groups[row.group] ?? null);
				const range = week.targets[row.group as keyof typeof week.targets];
				if (range) for (const [i, v] of range.entries()) expect(row.target![i]).toBeCloseTo(v, 2);
				else expect(row.target).toBeNull();
			}

			// Goal progress: the general goal's sessions are the block's counted workouts.
			const { rows: workouts } = await db.execute<{ n: number }>(
				sql`select count(*)::int as n from workouts where owner_id = ${owner}
					and status = 'completed' and deleted_at is null
					and (started_at at time zone ${TZ})::date between ${BLOCK.from} and ${BLOCK.to}`
			);
			const [goal] = await listGoals(owner, { db });
			const goals = snapshot.goals.filter((g) => g.goalId === goal!.id);
			expect(goals.map((g) => g.measure).sort()).toEqual(['none', 'none', 'sessions']);
			expect(goals.every((g) => g.sessions === workouts[0]!.n)).toBe(true);

			// Deload need: four weeks, no fatigue signal, nothing regressed.
			expect(snapshot.deloadNeed).toEqual({ verdict: 'not_needed', reasons: [] });
			expect(snapshot.next).toEqual({
				name: 'Build',
				phase: 'accumulation',
				startsOn: '2026-11-23'
			});
		});
	});

	it('stores it with its snapshot, once, and refuses a block before it is reviewable', async () => {
		await withRollback(async (db) => {
			const { owner, target, deps } = await seed(db, 'block-end');
			expect(await reviewableBlock(owner, TODAY, deps)).toEqual({ ...target, reason: 'all_done' });
			const first = await review(owner, target, deps);
			const again = await review(owner, target, deps);
			expect(first.created).toBe(true);
			expect(again).toMatchObject({ created: false, review: { id: first.review.id } });
			expect(await reviewableBlock(owner, TODAY, deps)).toBeNull();
			const { rows } = await db.execute<Record<string, unknown>>(
				sql`select revision, snapshot_version, block_starts_on::text as starts, block_ends_on::text as ends,
						inputs_digest, snapshot->>'inputsDigest' as digest
					from cycle_reviews where owner_id = ${owner}`
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				revision: 1,
				snapshot_version: 1,
				starts: BLOCK.from,
				ends: BLOCK.to
			});
			expect(rows[0]!.inputs_digest).toBe(rows[0]!.digest);
		});
		await withRollback(async (db) => {
			// Today's last session is still to log: the block's last week is not done.
			const { owner, target, deps } = await seed(db, 'week-almost-complete');
			const refused = await review(owner, target, deps).catch((e: unknown) => e);
			expect(refused).toBeInstanceOf(CycleReviewNotReviewableError);
			expect(refused).toMatchObject({ reason: 'not_reviewable', availableOn: '2026-11-23' });
			expect(await reviewableBlock(owner, TODAY, deps)).toBeNull();
			const { rows } = await db.execute(
				sql`select id from cycle_reviews where owner_id = ${owner}`
			);
			expect(rows).toHaveLength(0);
		});
	});

	it("never offers or reviews a late start's 'Between blocks' bridge", async () => {
		await withRollback(async (db) => {
			const { owner, target, deps } = await seed(db, 'block-end');
			// The block reshaped as next-shape.ts's bridge: a transition of unplanned weeks. Blocks and
			// weeks are history; the guards are lifted inside this rolled-back transaction only.
			await db.execute(
				sql`alter table program_blocks disable trigger program_blocks_refuse_update`
			);
			await db.execute(sql`alter table program_weeks disable trigger program_weeks_refuse_update`);
			await db.execute(
				sql`update program_blocks set phase = 'transition' where lineage_id = ${target.blockLineage}`
			);
			await db.execute(
				sql`update program_weeks w set kind = 'unplanned' from program_blocks b
					where b.id = w.block_id and b.lineage_id = ${target.blockLineage}`
			);
			expect(await reviewableBlock(owner, TODAY, deps)).toBeNull();
			await expect(review(owner, target, deps)).rejects.toBeInstanceOf(ReviewNotFoundError);
		});
	});

	it('proposes the directives as a valid next_cycle whose evidence.source names the review', async () => {
		await withRollback(async (db) => {
			const { owner, target, deps } = await seed(db, 'block-end');
			const { review: stored } = await review(owner, target, deps);
			const row = await proposalRow(db, stored.proposalId!);
			expect(row).toMatchObject({ kind: 'next_cycle', status: 'proposed' });
			expect(row.evidence.source).toEqual({
				kind: 'cycle_review',
				reviewId: stored.id,
				revision: 1
			});
			const { title, rationale, payload } = row;
			expect(validate(proposalSchema, { kind: 'next_cycle', title, rationale, payload }).ok).toBe(
				true
			);

			// The directives follow from the stored snapshot, the block's runs (SQL) and the outline.
			const snapshot = stored.read.legacy ? null! : stored.read.snapshot;
			const { rows: runs } = await db.execute<{ week: string; metres: number }>(
				sql`select to_char(date_trunc('week', (w.started_at at time zone ${TZ})::date), 'YYYY-MM-DD') as week,
						sum(r.distance_m)::float as metres
					from run_records r join workouts w on w.id = r.workout_id
					where w.owner_id = ${owner} and w.status = 'completed' and w.deleted_at is null
					group by 1 order by 1`
			);
			const longest = await db.execute<{ m: number }>(
				sql`select max(r.distance_m)::float as m from run_records r
					join workouts w on w.id = r.workout_id where w.owner_id = ${owner}`
			);
			const running = {
				weeklyMetres: runs.map((r) => r.metres),
				longestRunMetres: longest.rows[0]!.m
			};
			const goals = await listGoals(owner, { db });
			const outline = { phase: 'accumulation' as const, weeks: 4 };
			const directives = directivesFrom({ snapshot, running }, outline, goals);
			expect(row.evidence.directives).toEqual(directives);
			expect(directives).toMatchObject({ fromBlockLineage: target.blockLineage, weeks: 4 });
			expect(payload).toEqual(modifiableSubset(directives));
			expect(row.evidence).toMatchObject({ clamps: [], folded: [] });
		});
	});

	it('folds a next_cycle accepted from the coach into the proposal, within bounds, and supersedes it', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, target, deps } = await seed(db, 'block-end');
			const brief = {
				...{
					fromBlockLineage: target.blockLineage,
					focus: 'Coach: heavier triples',
					phase: 'accumulation'
				},
				...{ weeks: 4, emphasis: [], rotation: [], running: null, ending: 'none' },
				targets: { rpeCap: 9.5, volumeFactor: 0.8, loadStep: 0.025, runVolumeFactor: 1 },
				constraints: ['Keep Tuesdays for the class']
			};
			const { proposal: coach } = await createProposal(
				owner,
				{
					proposal: {
						kind: 'next_cycle',
						title: 'Next block',
						rationale: 'Go heavier',
						payload: brief
					}
				},
				deps
			);
			expect((await acceptProposal(owner, coach.id, deps)).proposal.status).toBe('accepted');

			const { review: stored } = await review(owner, target, deps);
			expect(await proposalRow(db, coach.id)).toMatchObject({
				status: 'superseded',
				superseded_reason: 'folded_into_review'
			});
			const row = await proposalRow(db, stored.proposalId!);
			const base = modifiableSubset(row.evidence.directives);
			expect(row.payload).toMatchObject({
				focus: 'Coach: heavier triples',
				constraints: ['Keep Tuesdays for the class'],
				running: null,
				targets: { ...brief.targets, rpeCap: base.targets.rpeCap }
			});
			expect(row.evidence.folded).toEqual([coach.id]);
			expect(row.evidence.clamps).toEqual([
				{ field: 'targets.rpeCap', asked: 9.5, used: base.targets.rpeCap }
			]);

			const [preview] = (await view(owner, target, db)).previews;
			// The previews plan from the folded subset: its 0.8 scales M3's weekly factors (1, 1, 1.1, 1.1).
			const factors = preview!.block.weeks.map((w) => w.targets.volumeFactor);
			expect(factors).toEqual([0.8, 0.8, 0.88, 0.88]);
			// A refresh keeps what was folded, though the coach's proposal is closed by now.
			await lateSet(db, owner, seeded.exercises.bench_press!);
			const refreshed = await refreshCycleReview(owner, stored.id, { today: TODAY }, deps);
			const again = await proposalRow(db, refreshed.proposalId!);
			expect(again.payload).toMatchObject({ focus: 'Coach: heavier triples' });
			expect(again.evidence.folded).toEqual([coach.id]);
		});
	});
});

describe('the next block preview', () => {
	it('a week late: a one-week bridge, the outline shifted, the whole version valid, nothing before today', async () => {
		await withRollback(async (db) => {
			const { owner, target, deps } = await seed(db, 'block-end');
			await review(owner, target, deps);
			const today = '2026-11-30';
			const { previews } = await view(owner, target, db, today);
			expect(previews.map((p) => p.start)).toEqual(['this_week', 'next_monday']);
			const [thisWeek, nextMonday] = previews as [NextBlockPreview, NextBlockPreview];
			expect(thisWeek.dates.bridge).toEqual({
				startsOn: '2026-11-23',
				endsOn: '2026-11-29',
				weeks: 1
			});
			expect(thisWeek.bridge?.weeks.map((w) => w.kind)).toEqual(['unplanned']);
			expect(thisWeek.dates.block).toMatchObject({
				startsOn: today,
				endsOn: '2026-12-27',
				weeks: 4
			});
			expect(nextMonday.dates.bridge?.weeks).toBe(2);
			expect(nextMonday.dates.block.startsOn).toBe('2026-12-07');
			expect(thisWeek.significantChanges.map((c) => c.kind)).toContain('bridge');
			for (const p of previews) {
				expect(await wholeVersion(db, owner, target, p)).toEqual([]);
				expect(sessionDays(p).length).toBeGreaterThan(0);
				expect(sessionDays(p).every((d) => d >= today)).toBe(true);
				expect(p.fingerprint).toMatch(/\S/);
			}
		});
	});

	it('three weeks late, with no outline left: the bridge, an appended block and this week from today', async () => {
		await withRollback(async (db) => {
			const { owner, target, deps } = await seed(db, 'block-end-late');
			const { review: stored } = await review(owner, target, deps);
			expect(stored.blockEndsOn).toBe('2026-11-01');
			const { previews } = await view(owner, target, db);
			const [thisWeek, nextMonday] = previews as [NextBlockPreview, NextBlockPreview];
			expect(nextMonday.dates.bridge).toEqual({
				startsOn: '2026-11-02',
				endsOn: '2026-11-22',
				weeks: 3
			});
			expect(nextMonday.dates.block.startsOn).toBe('2026-11-23');
			expect(thisWeek.dates.bridge?.weeks).toBe(2);
			expect(thisWeek.dates).toMatchObject({ firstPlannedDay: TODAY, shifted: [], lostWeeks: 0 });
			for (const p of previews) {
				expect(p.dates.block.outline).toBeNull();
				expect(await wholeVersion(db, owner, target, p)).toEqual([]);
				expect(sessionDays(p).every((d) => d >= TODAY)).toBe(true);
			}
		});
	});

	it('is deterministic, and its fingerprint changes with the profile', async () => {
		await withRollback(async (db) => {
			const { owner, target, deps } = await seed(db, 'block-end-late');
			await review(owner, target, deps);
			const first = (await view(owner, target, db)).previews;
			expect((await view(owner, target, db)).previews).toEqual(first);

			await saveSchedule(
				owner,
				{
					daysPerWeek: 5,
					availableDays: ['mon', 'tue', 'wed', 'thu', 'sat'],
					preferredTimes: ['morning', 'evening'],
					sessionMinutes: 75,
					commitments: []
				},
				{ db }
			);
			const changed = (await view(owner, target, db)).previews;
			expect(changed.map((p) => p.fingerprint)).not.toEqual(first.map((p) => p.fingerprint));
		});
	});
});

describe('refreshing and scope', () => {
	it('goes stale after a late set in the block, and a refresh supersedes it and its proposal', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, target, deps } = await seed(db, 'block-end');
			const { review: first } = await review(owner, target, deps);
			expect((await view(owner, target, db)).stale).toBe(false);
			await expect(
				refreshCycleReview(owner, first.id, { today: TODAY }, deps)
			).rejects.toMatchObject({
				reason: 'not_stale'
			});

			await lateSet(db, owner, seeded.exercises.bench_press!);
			expect((await view(owner, target, db)).stale).toBe(true);

			const second = await refreshCycleReview(owner, first.id, { today: TODAY }, deps);
			expect(second.revision).toBe(2);
			expect(await proposalRow(db, first.proposalId!)).toMatchObject({
				status: 'superseded',
				superseded_reason: 'review_refreshed'
			});
			const fresh = await view(owner, target, db);
			expect(fresh).toMatchObject({ stale: false, review: { id: second.id } });
			expect(fresh.decision).toEqual({ state: 'undecided', proposalId: second.proposalId });
		});
	});

	it("never reads, creates or refreshes someone else's review", async () => {
		await withRollback(async (db) => {
			const { owner, target, deps } = await seed(db, 'block-end');
			const { review: stored } = await review(owner, target, deps);
			const stranger = crypto.randomUUID();
			await expect(view(stranger, target, db)).rejects.toBeInstanceOf(ReviewNotFoundError);
			await expect(review(stranger, target, deps)).rejects.toBeInstanceOf(ReviewNotFoundError);
			await expect(
				refreshCycleReview(stranger, stored.id, { today: TODAY }, deps)
			).rejects.toBeInstanceOf(ReviewNotFoundError);
			expect(await reviewableBlock(stranger, TODAY, deps)).toBeNull();
		});
	});
});

describe('the cycle review of an M7 hypertrophy block', () => {
	it('judges each ramp week by its own range, and calls none below target when its planned sets were done', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const hypertrophy = M7_SCENARIOS.hypertrophyBlock();
			const { programId, version } = await storeM7Program(db, owner, hypertrophy, SCENARIO_START);
			const block = version.blocks[0]!;
			await logAsPlanned(
				db,
				owner,
				block.weeks.flatMap((w) => w.sessions)
			);
			const today = addDays(block.endsOn, 3);
			const target = { programId, blockLineage: block.lineage };
			const at = () => new Date(`${today}T20:00:00Z`);
			const { review: stored } = await createCycleReview(
				owner,
				{ ...target, today },
				{ db, now: at }
			);
			const snapshot = stored.read.legacy ? null! : stored.read.snapshot;
			const ramp = block.weeks.filter((w) => w.kind !== 'deload');
			expect(ramp.map((w) => w.targets.setsPerGroup!.min)).toEqual([10, 12, 14, 16]);
			for (const week of ramp) {
				const { min, max } = week.targets.setsPerGroup!;
				const rows = snapshot.volume.filter(
					(r) => r.weekStartsOn === week.startsOn && r.target !== null
				);
				expect(rows.map((r) => r.group).sort()).toEqual([
					'back',
					'chest',
					'hamstrings',
					'hips',
					'quads',
					'shoulders'
				]);
				for (const row of rows) {
					expect(row.target, `${week.startsOn} ${row.group}`).toEqual([min, max]);
					expect(row.achieved).toBeCloseTo(row.planned!, 2);
					expect(row.achieved, `${week.startsOn} ${row.group}`).toBeGreaterThanOrEqual(min);
				}
			}
		});
	});
});
