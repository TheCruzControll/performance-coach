/**
 * Weekly reviews on real Postgres (services/reviews/weekly.ts, the M6 plan's
 * weekly-review-service), from the review fixtures seeded directly at a forced today:
 * - the figures equal the domain functions over rows read here in SQL
 * - a review is stored with its snapshot, digest and versions, once
 * - a week in progress is refused until every session is done or skipped
 * - next week's changes become an M5 program_adjustment whose evidence.source names the review,
 *   and getProposalView's origin links back to it
 * - a late review, a planned deload next week and a week with no program propose nothing
 * - a late set makes the review stale; a refresh supersedes it and its open proposal, keeping
 *   both of each, while an applied decision refuses the refresh
 * - everything is owner-scoped
 * Today is Tuesday 17 Nov 2026 in Los Angeles: the reviewed week is 9–15 Nov.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { METRICS } from '../../../src/lib/domain/analytics/metrics';
import * as strength from '../../../src/lib/domain/analytics/strength';
import { classifyTrend } from '../../../src/lib/domain/analytics/trend';
import { ANALYTICS_VERSION } from '../../../src/lib/domain/analytics/version';
import { proposalSchema } from '../../../src/lib/domain/coach/proposals';
import { trendCall, TRAILING_WEEKS } from '../../../src/lib/domain/programming/review/weekly';
import { validate } from '../../../src/lib/domain/validation';
import type { Executor } from '../../../src/lib/server/db';
import { getMuscleTargets } from '../../../src/lib/server/services/analytics/targets';
import {
	acceptProposal,
	createProposal,
	getProposalView
} from '../../../src/lib/server/services/coach/proposals';
import { CoachInputError } from '../../../src/lib/server/services/coach/shared';
import { getExercisesByIds } from '../../../src/lib/server/services/exercises/index';
import {
	createWeeklyReview,
	getWeeklyReviewView,
	refreshWeeklyReview,
	reviewableWeek,
	ReviewNotFoundError,
	WeeklyReviewNotReviewableError,
	WeeklyReviewRefreshError
} from '../../../src/lib/server/services/reviews';
import {
	editSet,
	finishWorkout,
	logSet,
	recordRecoveryNote,
	startWorkout
} from '../../../src/lib/server/services/training/log';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import type { ReviewFixtureResult } from '../../../src/lib/server/test-support/analytics-fixtures/reviews';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const TODAY = '2026-11-17';
const THIS_WEEK = '2026-11-16';
const REVIEWED = '2026-11-09';
const NOW = atLocal(TODAY, '12:00', TZ);
const now = () => NOW;

type Seeded = ReviewFixtureResult & { exercises: Record<string, string> };

/**
 * M6's checkWeek path (the context reads skipped): with M7's judge the hard week's next week has
 * no move a finding would not name (m7/24), so these tests of the proposal's storage keep M6's.
 */
const M6_PATH = { reader: async () => null };

async function seed(db: Executor, fixture: string, context?: typeof M6_PATH) {
	const owner = await makeOwner(db);
	const seeded = (await seedAnalyticsFixture(
		owner,
		fixture,
		{ timeZone: TZ, now: NOW },
		{ db }
	)) as unknown as Seeded;
	return { owner, seeded, deps: { db, now, ...(context && { context }) } };
}

const review = (owner: string, deps: { db: Executor; now?: () => Date }, weekStartsOn = REVIEWED) =>
	createWeeklyReview(owner, { weekStartsOn, today: TODAY }, deps);

/** A bench set logged now in an ad hoc workout on the reviewed week's Wednesday. */
async function lateSet(db: Executor, owner: string, benchId: string) {
	const at = atLocal(addDays(REVIEWED, 2), '18:00', TZ);
	const clientId = crypto.randomUUID();
	const workout = { clientId, kind: 'strength', discipline: 'strength', sessionType: 'strength' };
	await startWorkout(
		owner,
		{ ...workout, title: 'Extra bench', plannedSessionId: null, startedAt: at.toISOString() },
		{ db }
	);
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

/** The owner's weekly review rows of the week, oldest revision first. */
async function reviewRows(db: Executor, owner: string, week = REVIEWED) {
	const { rows } = await db.execute<{
		id: string;
		revision: number;
		superseded_by: string | null;
		proposal_id: string | null;
		snapshot_version: number;
		analytics_version: number;
		inputs_digest: string;
		program_id: string | null;
		version_id: string | null;
		snapshot: { inputsDigest: string; noProposal: string | null };
	}>(
		sql`select * from weekly_reviews where owner_id = ${owner} and week_starts_on = ${week}
			order by revision`
	);
	return rows;
}

async function proposalRow(db: Executor, id: string) {
	const { rows } = await db.execute<{
		kind: string;
		status: string;
		superseded_reason: string | null;
		title: string;
		rationale: string;
		payload: unknown;
		evidence: { source: Record<string, unknown> };
		thread_id: string | null;
		run_id: string | null;
		tool_use_id: string | null;
		base_version_id: string | null;
		revision_of: string | null;
	}>(sql`select * from coach_proposals where id = ${id}`);
	return rows[0]!;
}

const currentVersion = async (db: Executor, owner: string) =>
	(
		await db.execute<{ program_id: string; version_id: string }>(
			sql`select id as program_id, current_version_id as version_id from programs
				where owner_id = ${owner} and status = 'active'`
		)
	).rows[0]!;

describe('creating a weekly review', () => {
	it('computes adherence, RPE deviation, verdicts and hard sets as the domain functions do over SQL rows', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seed(db, 'week-complete');
			const { review: stored } = await review(owner, deps);
			const view = await getWeeklyReviewView(owner, REVIEWED, deps);
			const finding = (id: string) =>
				view.sections.flatMap((s) => s.findings).find((f) => f.id === id)!;
			const figure = (id: string, label: string) =>
				finding(id).figures.find((f) => f.label === label)!.value;
			const sunday = addDays(REVIEWED, 6);

			// Planned against completed: the current version's sessions of the week and their workouts.
			const { rows: planned } = await db.execute<{ planned: number; completed: number }>(
				sql`select count(*)::int as planned, count(*) filter (where exists (
						select 1 from workouts x where x.planned_lineage_id = s.lineage_id
						and x.status = 'completed' and x.deleted_at is null))::int as completed
					from programs p
					join program_version_weeks vw on vw.version_id = p.current_version_id
					join program_weeks w on w.id = vw.week_id
					join planned_sessions s on s.week_id = w.id
					where p.owner_id = ${owner} and s.scheduled_on between ${REVIEWED} and ${sunday}
						and s.status <> 'skipped'`
			);
			expect(planned[0]!.planned).toBe(6);
			expect(stored.read.legacy).toBe(false);
			const snapshot = view.snapshot!;
			expect(snapshot.adherence).toMatchObject({
				planned: planned[0]!.planned,
				completed: planned[0]!.completed,
				pct: 100
			});
			expect(figure('adherence', 'Completed')).toBe(planned[0]!.completed);

			// RPE against target, per lift, over the week's prescribed sets.
			const { rows: deviations } = await db.execute<{ exercise: string; deviation: number }>(
				sql`select r.exercise_id::text as exercise, avg(r.rpe - sp.target_rpe)::float as deviation
					from set_records r
					join workouts x on x.id = r.workout_id and x.status = 'completed' and x.deleted_at is null
					join planned_exercises pe on pe.session_id = x.planned_session_id
						and pe.lineage_id = r.planned_exercise_lineage_id
					join set_prescriptions sp on sp.planned_exercise_id = pe.id and sp.position = 1
					where r.owner_id = ${owner} and r.deleted_at is null
						and (r.performed_at at time zone ${TZ})::date between ${REVIEWED} and ${sunday}
					group by r.exercise_id`
			);
			expect(deviations).toHaveLength(3);
			for (const { exercise, deviation } of deviations)
				expect(figure(`rpe:${exercise}`, 'Mean deviation')).toBeCloseTo(deviation, 6);
			// The fixture's hard week: bench a whole RPE easier than prescribed.
			expect(deviations.map((d) => d.deviation).sort()).toEqual([-1, 0, 0]);

			// Every set of the weeks read, as the strength functions read them.
			const from = addDays(REVIEWED, -7 * TRAILING_WEEKS);
			const { rows: sets } = await db.execute<Record<string, unknown>>(
				sql`select r.id::text as id, r.workout_id as "workoutId", r.exercise_id as exercise,
						r.planned_exercise_lineage_id as "plannedLineage", r.set_index as "setIndex",
						r.weight::float as weight, r.unit, r.assistance, r.reps, r.missed_reps as "missedReps",
						r.seconds, r.metres, r.rpe::float as rpe, r.is_warmup as "isWarmup",
						r.is_extra as "isExtra", r.is_skipped as "isSkipped", r.performed_at as "performedAt",
						r.deleted_at as "deletedAt"
					from set_records r
					join workouts x on x.id = r.workout_id and x.status = 'completed' and x.deleted_at is null
					where r.owner_id = ${owner} and r.deleted_at is null
						and (r.performed_at at time zone ${TZ})::date between ${from} and ${sunday}`
			);
			// A raw query returns instants as text: the functions read Dates.
			const facts = sets.map((s) => ({
				...s,
				performedAt: new Date(s.performedAt as string),
				deletedAt: null
			})) as unknown as strength.StrengthFact[];
			const exercises = await getExercisesByIds(
				owner,
				facts.map((s) => s.exercise),
				{ db }
			);
			const weeks = { from, to: sunday, count: TRAILING_WEEKS + 1 };
			const window = { weeks, inProgress: { weekStart: THIS_WEEK, through: THIS_WEEK, days: 1 } };

			// The tonnage verdict over the nine weeks.
			const tonnage = strength
				.weeklyTonnage(facts, exercises, TZ, window)
				.filter((p) => !p.inProgress);
			const trend = classifyTrend(tonnage, {
				direction: METRICS.tonnage.direction,
				mpc: METRICS.tonnage.mpc
			});
			expect(finding('verdicts:tonnage').verdict).toEqual({
				level: trendCall(trend)[0],
				words: trendCall(trend)[1]
			});
			expect(figure('verdicts:tonnage', 'Change')).toBeCloseTo(trend.change!, 6);

			// Hard sets per group against the week's targets, which targets.ts scales.
			const [target] = await getMuscleTargets(owner, { from: REVIEWED, to: sunday }, { db });
			const hard = strength.weeklyHardSets(facts, exercises, TZ, window)[TRAILING_WEEKS]!;
			const [groups] = strength.muscleGroupWeeks([hard], new Map([[REVIEWED, target!.targets]]));
			expect(groups!.groups.length).toBeGreaterThan(0);
			for (const g of groups!.groups) {
				expect(figure(`volume:sets:${g.group}`, 'Done')).toBeCloseTo(g.sets, 6);
				if (g.target)
					expect(finding(`volume:sets:${g.group}`).verdict.words).toContain(
						`${g.target[0]}–${g.target[1]}`
					);
			}
		});
	});

	it('stores it with its snapshot, inputs digest and versions, once', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seed(db, 'week-complete', M6_PATH);
			const first = await review(owner, deps);
			const again = await review(owner, deps);
			expect(first.created).toBe(true);
			expect(again).toMatchObject({ created: false, review: { id: first.review.id } });

			const rows = await reviewRows(db, owner);
			expect(rows).toHaveLength(1);
			const [row] = rows;
			const current = await currentVersion(db, owner);
			expect(row).toMatchObject({
				id: first.review.id,
				revision: 1,
				snapshot_version: 1,
				analytics_version: ANALYTICS_VERSION,
				program_id: current.program_id,
				version_id: current.version_id
			});
			expect(row!.inputs_digest).toMatch(/^[0-9a-f]{16}$/);
			expect(row!.snapshot.inputsDigest).toBe(row!.inputs_digest);
			const { rows: proposals } = await db.execute(
				sql`select id from coach_proposals where owner_id = ${owner}`
			);
			expect(proposals).toHaveLength(1);
		});
	});

	it('refuses a week in progress as not_reviewable until every session is done or skipped', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seed(db, 'week-almost-complete');
			const refused = await review(owner, deps, THIS_WEEK).catch((e: unknown) => e);
			expect(refused).toBeInstanceOf(WeeklyReviewNotReviewableError);
			expect(refused).toMatchObject({ reason: 'not_reviewable', availableOn: '2026-11-23' });
			expect(await reviewRows(db, owner, THIS_WEEK)).toHaveLength(0);
			expect(await reviewableWeek(owner, TODAY, deps)).toEqual({
				weekStartsOn: REVIEWED,
				reason: 'ended'
			});
		});
		await withRollback(async (db) => {
			// The same week with today's last session logged too: every session done.
			const { owner, deps } = await seed(db, 'block-end');
			expect(await reviewableWeek(owner, TODAY, deps)).toEqual({
				weekStartsOn: THIS_WEEK,
				reason: 'all_done'
			});
			const { created, review: stored } = await review(owner, deps, THIS_WEEK);
			expect(created).toBe(true);
			// Next week is the outline's: the cycle review's to plan.
			expect(stored.proposalId).toBeNull();
			expect(stored.read.legacy || stored.read.snapshot.noProposal).toBe('boundary');
		});
	});
});

describe("next week's proposal", () => {
	it('is an M5 program_adjustment whose evidence.source names the review, with an origin linking back', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, deps } = await seed(db, 'week-complete', M6_PATH);
			const { review: stored } = await review(owner, deps);
			expect(stored.proposalId).not.toBeNull();
			const row = await proposalRow(db, stored.proposalId!);
			const current = await currentVersion(db, owner);
			expect(row).toMatchObject({
				kind: 'program_adjustment',
				status: 'proposed',
				base_version_id: current.version_id,
				thread_id: null,
				run_id: null,
				tool_use_id: null
			});
			expect(row.evidence.source).toEqual({
				kind: 'weekly_review',
				reviewId: stored.id,
				revision: 1,
				weekStartsOn: REVIEWED
			});
			const parsed = validate(proposalSchema, {
				kind: row.kind,
				title: row.title,
				rationale: row.rationale,
				payload: row.payload
			});
			expect(parsed.ok).toBe(true);

			const view = await getProposalView(owner, stored.proposalId!, deps);
			expect(view.origin).toEqual({
				kind: 'weekly_review',
				reviewId: stored.id,
				href: `/progress/reviews/w-${REVIEWED}`,
				weekStartsOn: REVIEWED,
				source: { type: 'review', id: `w-${REVIEWED}`, label: 'Weekly review' }
			});

			// Friday's sparring follows Thursday's heavy deadlifts: it moves to Saturday. Bench felt an
			// RPE easier, but its lines are RPE-based at the week's cap of 8, so it holds.
			const ops = (row.payload as { ops: Record<string, unknown>[] }).ops;
			expect(ops).toEqual([expect.objectContaining({ op: 'move', toDate: '2026-11-21' })]);
			const benchLines = await db.execute<{ lineage: string }>(
				sql`select lineage_id::text as lineage from planned_exercises
					where exercise_id = ${seeded.exercises.bench_press}`
			);
			const bench = new Set(benchLines.rows.map((r) => r.lineage));
			expect(ops.some((op) => bench.has(op.plannedExerciseLineage as string))).toBe(false);
		});
	});

	it('proposes bench +2.5 kg on a load-based line that felt easier', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, deps } = await seed(db, 'week-complete');
			const current = await currentVersion(db, owner);
			// Thursday's bench, still ahead, gains a second line at a fixed 85 kg (history rows are
			// never updated, so it is inserted beside the RPE-based one).
			const { rows } = await db.execute<{ id: string; lineage: string }>(
				sql`select pe.id::text as id, pe.lineage_id::text as lineage from planned_exercises pe
					join planned_sessions ps on ps.id = pe.session_id
					join program_version_weeks vw on vw.week_id = ps.week_id
					where vw.version_id = ${current.version_id} and ps.scheduled_on = '2026-11-19'
						and pe.exercise_id = ${seeded.exercises.bench_press}`
			);
			expect(rows).toHaveLength(1);
			await db.execute(
				sql`insert into set_prescriptions (planned_exercise_id, position, role, sets, reps_min,
						reps_max, target_rpe, load_kind, load_value, load_unit, rest_seconds)
					values (${rows[0]!.id}, 2, 'working', 3, 5, 5, 8, 'absolute', 85, 'kg', 150)`
			);
			const { review: stored } = await review(owner, deps);
			const ops = (
				(await proposalRow(db, stored.proposalId!)).payload as {
					ops: Record<string, unknown>[];
				}
			).ops;
			expect(ops).toContainEqual(
				expect.objectContaining({
					op: 'adjust_set',
					plannedExerciseLineage: rows[0]!.lineage,
					position: 2,
					loadValue: 87.5
				})
			);
		});
	});

	it("refuses rules provenance on a conversation's proposal", async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seed(db, 'week-complete', M6_PATH);
			const { review: stored } = await review(owner, deps);
			const { payload, title, rationale } = await proposalRow(db, stored.proposalId!);
			const both = createProposal(
				owner,
				{
					proposal: { kind: 'program_adjustment', title, rationale, payload },
					origin: { threadId: crypto.randomUUID(), runId: crypto.randomUUID(), toolUseId: 't' },
					provenance: { kind: 'weekly_review', reviewId: stored.id, revision: 1 }
				},
				deps
			);
			await expect(both).rejects.toBeInstanceOf(CoachInputError);
		});
	});

	it('is not made by a late review, which says why', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, deps } = await seed(db, 'week-late');
			const week = seeded.review.kind === 'weekly' ? seeded.review.weekStartsOn : '';
			expect(week).toBe('2026-11-02');
			const { review: stored } = await review(owner, deps, week);
			expect(stored.proposalId).toBeNull();
			const view = await getWeeklyReviewView(owner, week, deps);
			expect(view).toMatchObject({ late: true, boundary: false, proposal: null });
			expect(view.decision).toEqual({ state: 'none' });
			expect(view.noProposal).toEqual({
				reason: 'late',
				words: 'Next week ended on 2026-11-15, before this review: nothing is left to change.'
			});
		});
	});

	it('takes no −40 % ops when next week is already a planned deload', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seed(db, 'next-week-deload');
			const { review: stored } = await review(owner, deps);
			const snapshot = stored.read.legacy ? null : stored.read.snapshot;
			expect(snapshot?.next).toEqual({ weekStartsOn: THIS_WEEK, state: 'planned', kind: 'deload' });
			const ops = stored.proposalId
				? (((await proposalRow(db, stored.proposalId)).payload as { ops: { sets?: number }[] })
						.ops ?? [])
				: [];
			expect(ops.filter((op) => op.sets !== undefined)).toEqual([]);
			// Only M7's move: Strength B, on legs the hard week left overloaded, away from Friday's
			// sparring (M6's checkWeek saw nothing at RPE 6, so proposed nothing).
			expect(ops.map((op) => (op as { op: string }).op)).toEqual(['move']);
			expect(snapshot?.noProposal).toBeNull();
		});
	});

	it('is not made with no program', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { review: stored } = await review(owner, { db, now });
			expect(stored.proposalId).toBeNull();
			expect(stored.programId).toBeNull();
			const view = await getWeeklyReviewView(owner, REVIEWED, { db });
			expect(view.noProposal?.reason).toBe('no_program');
			expect(view.snapshot!.adherence).toMatchObject({ planned: 0, completed: 0 });
		});
	});
});

describe('refreshing a weekly review', () => {
	it('goes stale after a late set; a refresh supersedes it, keeping both rows and both proposals', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, deps } = await seed(db, 'week-complete', M6_PATH);
			const { review: first } = await review(owner, deps);
			expect((await getWeeklyReviewView(owner, REVIEWED, deps)).stale).toBe(false);
			await expect(
				refreshWeeklyReview(owner, first.id, { today: TODAY }, deps)
			).rejects.toMatchObject({
				reason: 'not_stale'
			});

			await lateSet(db, owner, seeded.exercises.bench_press!);
			const stale = await getWeeklyReviewView(owner, REVIEWED, deps);
			expect(stale.stale).toBe(true);
			expect(stale.laterChanges).toBeGreaterThanOrEqual(1);

			const second = await refreshWeeklyReview(owner, first.id, { today: TODAY }, deps);
			expect(second.revision).toBe(2);
			const rows = await reviewRows(db, owner);
			expect(rows.map((r) => [r.revision, r.superseded_by])).toEqual([
				[1, second.id],
				[2, null]
			]);
			expect(rows[1]!.inputs_digest).not.toBe(rows[0]!.inputs_digest);
			const old = await proposalRow(db, first.proposalId!);
			expect(old).toMatchObject({ status: 'superseded', superseded_reason: 'review_refreshed' });
			const fresh = await proposalRow(db, second.proposalId!);
			expect(fresh.status).toBe('proposed');
			expect(fresh.evidence.source).toMatchObject({ reviewId: second.id, revision: 2 });

			const view = await getWeeklyReviewView(owner, REVIEWED, deps);
			expect(view).toMatchObject({ stale: false, laterChanges: 0, review: { id: second.id } });
			expect(view.decision).toEqual({ state: 'undecided', proposalId: second.proposalId });
			// The superseded revision never changes again.
			await expect(refreshWeeklyReview(owner, first.id, { today: TODAY }, deps)).rejects.toThrow(
				/superseded/
			);
		});
	});

	it('goes stale when a set it read is edited, though no fact is added or removed', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seed(db, 'week-complete');
			await review(owner, deps);
			const { rows } = await db.execute<{ id: string; weight: string }>(
				sql`select r.client_mutation_id::text as id, r.weight from set_records r
					where r.owner_id = ${owner} and r.deleted_at is null
						and (r.performed_at at time zone ${TZ})::date between ${REVIEWED} and ${addDays(REVIEWED, 6)}
					order by r.performed_at limit 1`
			);
			// The same set, an RPE harder: an edit, with the same ids before and after.
			const edited = {
				...{ weight: Number(rows[0]!.weight), assistance: null, unit: 'kg', reps: 5 },
				...{ missedReps: 0, seconds: null, metres: null, rpe: 9.5 },
				...{ isWarmup: false, isExtra: false, isSkipped: false }
			};
			expect((await editSet(owner, rows[0]!.id, edited, { db })).changed).toBe(true);
			const view = await getWeeklyReviewView(owner, REVIEWED, deps);
			expect(view.stale).toBe(true);
			expect(view.laterChanges).toBeGreaterThanOrEqual(1);
		});
	});

	it('goes stale when a check-in for the week is logged after it', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seed(db, 'week-complete');
			await review(owner, deps);
			const values = { notedOn: addDays(REVIEWED, 6), sleepHours: 5, soreness: 4 };
			const checkIn = { ...values, energy: 2, stress: null, note: null };
			await recordRecoveryNote(
				owner,
				{ clientMutationId: crypto.randomUUID(), ...checkIn },
				{ db }
			);
			const view = await getWeeklyReviewView(owner, REVIEWED, deps);
			expect(view.stale).toBe(true);
			expect(view.laterChanges).toBeGreaterThanOrEqual(1);
		});
	});

	it("is allowed while the owner's revision is undecided, and refused once it is applied", async () => {
		await withRollback(async (db) => {
			const { owner, seeded, deps } = await seed(db, 'week-complete', M6_PATH);
			const { review: first } = await review(owner, deps);
			const head = await proposalRow(db, first.proposalId!);
			const [move] = (head.payload as { ops: Record<string, unknown>[] }).ops;
			const { proposal: revision } = await createProposal(
				owner,
				{
					proposal: {
						kind: 'program_adjustment',
						title: head.title,
						rationale: head.rationale,
						payload: { ops: [{ ...move, toDate: '2026-11-22' }] }
					},
					revises: first.proposalId,
					provenance: {
						kind: 'weekly_review',
						reviewId: first.id,
						revision: 1,
						weekStartsOn: REVIEWED,
						modifiedBy: 'owner'
					}
				},
				deps
			);
			const before = await getWeeklyReviewView(owner, REVIEWED, deps);
			expect(before.decision).toEqual({ state: 'undecided', proposalId: revision.id });
			expect(before.proposal?.id).toBe(revision.id);

			await lateSet(db, owner, seeded.exercises.bench_press!);
			const second = await refreshWeeklyReview(owner, first.id, { today: TODAY }, deps);
			expect(await proposalRow(db, revision.id)).toMatchObject({
				status: 'superseded',
				superseded_reason: 'review_refreshed'
			});

			const accepted = await acceptProposal(owner, second.proposalId!, deps);
			expect(accepted.proposal.status).toBe('applied');
			await lateSet(db, owner, seeded.exercises.bench_press!);
			expect((await getWeeklyReviewView(owner, REVIEWED, deps)).decision.state).toBe('applied');
			const refused = refreshWeeklyReview(owner, second.id, { today: TODAY }, deps);
			await expect(refused).rejects.toBeInstanceOf(WeeklyReviewRefreshError);
			await expect(refused).rejects.toMatchObject({ reason: 'decided' });
			expect(await reviewRows(db, owner)).toHaveLength(2);
		});
	});
});

describe('owner scope', () => {
	it("never reads or refreshes someone else's review", async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seed(db, 'week-complete');
			const { review: stored } = await review(owner, deps);
			// The app has one owner: anyone else is a stranger's id.
			const stranger = crypto.randomUUID();
			await expect(getWeeklyReviewView(stranger, REVIEWED, deps)).rejects.toBeInstanceOf(
				ReviewNotFoundError
			);
			await expect(
				refreshWeeklyReview(stranger, stored.id, { today: TODAY }, deps)
			).rejects.toBeInstanceOf(ReviewNotFoundError);
			await expect(getProposalView(stranger, stored.proposalId!, deps)).rejects.toThrow(
				/not found/
			);
		});
	});
});
