/**
 * What the cycle review screen reads beyond the stored review (services/reviews/cycle.ts, the M6
 * plan's cycle-review-screen), on real Postgres from the review fixtures at a forced today:
 * - unreviewedBlock offers the running block as not reviewable yet (week-almost-complete), the
 *   finished one as reviewable (block-end), and nothing once it is reviewed
 * - getCycleReviewViewById opens the block's live review from any revision's id, with each judged
 *   lift's estimated 1RM per session (the stored e1rm_kg's best of each workout, in SQL) and the
 *   block's weekly run distance (run_records in SQL), in the profile's units
 * Today is Wednesday 18 Nov 2026 in Los Angeles.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../src/lib/server/db';
import {
	createCycleReview,
	getCycleReviewViewById,
	ReviewNotFoundError,
	unreviewedBlock
} from '../../../src/lib/server/services/reviews';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import type { ReviewFixtureResult } from '../../../src/lib/server/test-support/analytics-fixtures/reviews';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const TODAY = '2026-11-18';
/** The fixtures' block: the four weeks ending this Sunday. */
const BLOCK = { from: '2026-10-26', to: '2026-11-22' };
const nowOn = (day: string) => () => atLocal(day, '12:00', TZ);

async function seed(db: Executor, fixture: string) {
	const owner = await makeOwner(db);
	const seeded = (await seedAnalyticsFixture(
		owner,
		fixture,
		{ timeZone: TZ, now: nowOn(TODAY)() },
		{ db }
	)) as unknown as ReviewFixtureResult;
	// The weekly fixtures plan the same block: its lineage, the first planned block's.
	const { rows } = await db.execute<{ lineage: string }>(
		sql`select b.lineage_id::text as lineage from programs p
			join program_version_blocks vb on vb.version_id = p.current_version_id
			join program_blocks b on b.id = vb.block_id
			where p.owner_id = ${owner} and not b.outline order by b.starts_on limit 1`
	);
	const target = { programId: seeded.programId!, blockLineage: rows[0]!.lineage };
	return { owner, target, deps: { db, now: nowOn(TODAY) } };
}

describe('the block the list offers', () => {
	it('running, with a session still to log: offered, not reviewable yet', async () => {
		await withRollback(async (db) => {
			const { owner, target, deps } = await seed(db, 'week-almost-complete');
			expect(await unreviewedBlock(owner, TODAY, deps)).toEqual({
				...target,
				name: 'Base',
				startsOn: BLOCK.from,
				endsOn: BLOCK.to,
				reviewable: false
			});
		});
	});

	it('finished: reviewable; once reviewed, nothing is offered', async () => {
		await withRollback(async (db) => {
			const { owner, target, deps } = await seed(db, 'block-end');
			expect(await unreviewedBlock(owner, TODAY, deps)).toMatchObject({
				...target,
				reviewable: true
			});
			await createCycleReview(owner, { ...target, today: TODAY }, deps);
			expect(await unreviewedBlock(owner, TODAY, deps)).toBeNull();
			expect(await unreviewedBlock(crypto.randomUUID(), TODAY, deps)).toBeNull();
		});
	});
});

describe('the review screen’s view', () => {
	it('opens the live review by id, with each lift’s e1RM per session and the weekly distance', async () => {
		await withRollback(async (db) => {
			const { owner, target, deps } = await seed(db, 'block-end');
			const { review } = await createCycleReview(owner, { ...target, today: TODAY }, deps);
			const view = await getCycleReviewViewById(owner, review.id, TODAY, deps);
			expect(view.review.id).toBe(review.id);
			const progression = view.progression!;
			expect(progression.units).toEqual({ weight: 'kg', distance: 'km' });

			// Each workout's best stored e1RM per exercise in the block, oldest first.
			const { rows } = await db.execute<{ exercise: string; on: string; kg: number }>(
				sql`select s.exercise_id::text as exercise,
						to_char((w.started_at at time zone ${TZ})::date, 'YYYY-MM-DD') as on,
						max(s.e1rm_kg)::float8 as kg
					from set_records s join workouts w on w.id = s.workout_id
					where s.owner_id = ${owner} and s.deleted_at is null and s.e1rm_kg is not null
						and not s.is_warmup and not s.is_skipped
						and w.status = 'completed' and w.deleted_at is null
						and (s.performed_at at time zone ${TZ})::date between ${BLOCK.from} and ${BLOCK.to}
					group by s.exercise_id, w.id, w.started_at order by w.started_at`
			);
			const judged = view.snapshot!.effectiveness.map((e) => e.exercise).sort();
			expect(progression.lifts.map((l) => l.exercise).sort()).toEqual(judged);
			expect(judged).toHaveLength(3);
			for (const lift of progression.lifts) {
				const expected = rows.filter((r) => r.exercise === lift.exercise);
				expect(lift.points.map((p) => p.on)).toEqual(expected.map((r) => r.on));
				lift.points.forEach((p, i) => expect(p.kg).toBeCloseTo(expected[i]!.kg, 1));
			}

			const { rows: runs } = await db.execute<{ week: string; metres: number }>(
				sql`select to_char(date_trunc('week', (w.started_at at time zone ${TZ})::date), 'YYYY-MM-DD') as week,
						sum(r.distance_m)::float8 as metres
					from workouts w join run_records r on r.workout_id = w.id
					where w.owner_id = ${owner} and w.status = 'completed' and w.deleted_at is null
						and (w.started_at at time zone ${TZ})::date between ${BLOCK.from} and ${BLOCK.to}
					group by 1 order by 1`
			);
			expect(runs.length).toBeGreaterThan(0);
			expect(progression.distance!.map((w) => w.weekStartsOn)).toEqual([
				'2026-10-26',
				'2026-11-02',
				'2026-11-09',
				'2026-11-16'
			]);
			for (const week of progression.distance!)
				expect(week.metres, week.weekStartsOn).toBeCloseTo(
					runs.find((r) => r.week === week.weekStartsOn)?.metres ?? 0,
					0
				);
		});
	});

	it('an unknown or someone else’s review is not found', async () => {
		await withRollback(async (db) => {
			const { owner, target, deps } = await seed(db, 'block-end');
			const { review } = await createCycleReview(owner, { ...target, today: TODAY }, deps);
			const stranger = crypto.randomUUID();
			await expect(getCycleReviewViewById(stranger, review.id, TODAY, deps)).rejects.toBeInstanceOf(
				ReviewNotFoundError
			);
			await expect(
				getCycleReviewViewById(owner, crypto.randomUUID(), TODAY, deps)
			).rejects.toBeInstanceOf(ReviewNotFoundError);
		});
	});
});
