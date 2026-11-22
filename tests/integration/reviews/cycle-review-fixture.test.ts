/**
 * The block-reviewed fixture (src/lib/server/test-support/analytics-fixtures/cycle-reviews.ts)
 * on real Postgres: block-end with its block reviewed, so the screen gallery has a stored cycle
 * review to open. Read back in SQL.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import type { CycleReviewedResult } from '../../../src/lib/server/test-support/analytics-fixtures/cycle-reviews';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const SUNDAY = '2026-11-22';

describe('block-reviewed fixture', () => {
	it('stores one live cycle review of block-end’s block and returns its id', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const seeded = (await seedAnalyticsFixture(
				owner,
				'block-reviewed',
				{ timeZone: TZ, now: atLocal(SUNDAY, '12:00', TZ) },
				{ db }
			)) as unknown as CycleReviewedResult;
			expect(seeded.review.kind).toBe('cycle');
			const { rows } = await db.execute<{ id: string; block: string; program: string }>(
				sql`select id::text, block_lineage_id::text as block, program_id::text as program
					from cycle_reviews where owner_id = ${owner} and superseded_by is null`
			);
			const block = seeded.review.kind === 'cycle' ? seeded.review.blockLineageId : '';
			expect(rows).toEqual([{ id: seeded.cycleReviewId, block, program: seeded.programId }]);
		});
	});
});
