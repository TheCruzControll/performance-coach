/**
 * The cycle review's next-block card on real Postgres (next-cycle-ui): the card's view over a real
 * review (next-cycle-data.ts) and its form posted to forms/reviews.ts decideCycle, from the
 * block-end fixture seeded on Wednesday 18 Nov 2026 in Los Angeles (its block ends this Sunday,
 * so only 'Next Monday' is on offer):
 * - the card offers what the review would rotate, by the ids the decision keeps them by, with
 *   the preview's fingerprint for its start
 * - Start plans one version and says so, a second tap returns the same and writes nothing, and a
 *   preview gone stale is a 409 that says it was refreshed
 * - a deload placed in the first or the last week (block-end's next block has none by the rules)
 *   is planned that way, and the revision's ending and constraints say so
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../src/lib/server/db';
import {
	decideCycle,
	PLAN_OVERVIEW_HREF,
	PREVIEW_REFRESHED
} from '../../../src/lib/server/forms/reviews';
import { saveSchedule } from '../../../src/lib/server/services/profile/index';
import { getProgramVersion } from '../../../src/lib/server/services/programs/index';
import { createCycleReview, getCycleReviewView } from '../../../src/lib/server/services/reviews';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import type { ReviewFixtureResult } from '../../../src/lib/server/test-support/analytics-fixtures/reviews';
import { nextCycleView } from '../../../src/routes/(app)/progress/reviews/[[key]]/next-cycle-data';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const TODAY = '2026-11-18';
const now = () => atLocal(TODAY, '12:00', TZ);

/** block-end seeded on TODAY with bench stalled (so the rules rotate it), and its review. */
async function reviewed(db: Executor) {
	const owner = await makeOwner(db);
	const seeded = (await seedAnalyticsFixture(
		owner,
		'block-end',
		{ timeZone: TZ, now: now() },
		{
			db
		}
	)) as unknown as ReviewFixtureResult & { exercises: Record<string, string> };
	await db.execute(
		sql`update set_records set weight = 80 where exercise_id = ${seeded.exercises.bench_press}`
	);
	const programId = seeded.programId!;
	const v1 = await getProgramVersion(owner, programId, 1, { db });
	const target = { programId, blockLineage: v1.blocks[0]!.lineage };
	const { review } = await createCycleReview(owner, { ...target, today: TODAY }, { db, now });
	const view = () => getCycleReviewView(owner, { ...target, today: TODAY }, { db, now });
	return { owner, seeded, programId, review, view };
}
type Reviewed = Awaited<ReturnType<typeof reviewed>>;

/** The card's form as a browser posts it for the card's only start. */
async function form(r: Reviewed, fields: [string, string][] = []) {
	const card = nextCycleView(await r.view(), { today: TODAY, programStartsOn: null })!;
	const [preview] = card.previews;
	const body = new FormData();
	body.set('reviewId', r.review.id);
	body.set('start', preview!.start);
	for (const p of card.previews) body.set(`fingerprint:${p.start}`, p.fingerprint);
	for (const [name, value] of fields) body.append(name, value);
	return { card, body };
}

async function versionCount(db: Executor, programId: string) {
	const { rows } = await db.execute<{ n: number }>(
		sql`select count(*)::int as n from program_versions where program_id = ${programId}`
	);
	return rows[0]!.n;
}

describe("the next block's card", () => {
	it('offers what the rules rotate by its id, and Start plans one version, once', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db);
			const { card, body } = await form(r);
			expect(card.state).toBe('open');
			expect(card.previews.map((p) => [p.start, p.hint])).toEqual([
				['next_monday', 'Starts Mon 23 Nov']
			]);
			expect(card.rotated).toContainEqual(
				expect.objectContaining({
					value: r.seeded.exercises.bench_press,
					label: 'Keep Bench press'
				})
			);

			const deps = { db, now };
			const started = await decideCycle(r.owner, { form: body }, deps);
			expect(started).toEqual({
				outcome: 'applied',
				words: 'Next block planned · version 2',
				href: PLAN_OVERVIEW_HREF
			});
			// A second tap (another tab, a retry) returns the same and plans nothing more.
			expect(await decideCycle(r.owner, { form: body }, deps)).toEqual(started);
			expect(await versionCount(db, r.programId)).toBe(2);
			expect(nextCycleView(await r.view(), { today: TODAY, programStartsOn: null })).toMatchObject({
				state: 'applied',
				title: 'Next block planned · version 2',
				previews: []
			});
		});
	});

	it('a preview gone stale is a 409 that says it was refreshed, and plans nothing', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db);
			const { body } = await form(r);
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
			const refused = await decideCycle(r.owner, { form: body }, { db, now });
			expect(refused).toMatchObject({
				status: 409,
				data: { reason: 'profile', message: PREVIEW_REFRESHED }
			});
			expect(await versionCount(db, r.programId)).toBe(1);
		});
	});

	it.each([
		['first', 0, 'none'],
		['last', 3, 'deload']
	] as const)('the deload placed %s is planned that way', async (deload, week, ending) => {
		await withRollback(async (db) => {
			const r = await reviewed(db);
			const { body } = await form(r, [['deload', deload]]);
			const started = await decideCycle(r.owner, { form: body }, { db, now });
			expect(started).toMatchObject({ outcome: 'applied' });

			const v2 = await getProgramVersion(r.owner, r.programId, 2, { db });
			const kinds = v2.blocks[1]!.weeks.map((w) => w.kind);
			expect(kinds).toHaveLength(4);
			expect(kinds.flatMap((k, i) => (k === 'deload' ? [i] : []))).toEqual([week]);

			const { rows } = await db.execute<{ payload: { ending: string; constraints: string[] } }>(
				sql`select payload from coach_proposals
					where owner_id = ${r.owner} and status = 'applied' and revision_of is not null`
			);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.payload.ending).toBe(ending);
			expect(rows[0]!.payload.constraints.includes('Open with a deload week')).toBe(
				deload === 'first'
			);
		});
	});
});
