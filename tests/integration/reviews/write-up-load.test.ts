/**
 * The write-up as the reviews screen first shows it (load.ts reviewNarration, review-narrative-ui)
 * on real Postgres, with the environment's MockProvider:
 * - a review with none is requested on idle (writing, ask), with Discuss from weekly_review about
 *   the review's page key
 * - once written: the stored text, and the run's display blocks whose released text it is
 * - a coach that is not launched or is switched off: its notice, so the page asks nothing
 * - after a failed write-up, asking again (Retry) writes it up
 * - loadReviews attaches it to the selected review
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
	clearMockOverrides,
	setMockOverrides
} from '../../../src/lib/server/agent/provider/faults';
import { narrateReview, releasedText } from '../../../src/lib/server/agent/reviews/narrate';
import type { Executor } from '../../../src/lib/server/db';
import { resetEnvCache } from '../../../src/lib/server/env';
import { createWeeklyReview } from '../../../src/lib/server/services/reviews';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import {
	loadReviews,
	reviewNarration
} from '../../../src/routes/(app)/progress/reviews/[[key]]/load';
import { noticeOf } from '../../../src/routes/(app)/progress/reviews/[[key]]/write-up';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const TODAY = '2026-11-17';
const REVIEWED = '2026-11-09';
const NOW = atLocal(TODAY, '12:00', TZ);
const now = () => NOW;

const before = process.env.ENABLE_TEST_ROUTES;
beforeAll(() => {
	// The test route's overrides (provider/faults.ts) are read only where test routes are enabled.
	process.env.ENABLE_TEST_ROUTES = 'true';
	resetEnvCache();
});
afterEach(() => clearMockOverrides());
afterAll(() => {
	if (before === undefined) delete process.env.ENABLE_TEST_ROUTES;
	else process.env.ENABLE_TEST_ROUTES = before;
	resetEnvCache();
});

async function seedWeek(db: Executor) {
	const owner = await makeOwner(db);
	await seedAnalyticsFixture(owner, 'week-complete', { timeZone: TZ, now: NOW }, { db });
	const { review } = await createWeeklyReview(
		owner,
		{ weekStartsOn: REVIEWED, today: TODAY },
		{ db, now }
	);
	return { owner, selected: { kind: 'weekly' as const, id: review.id, key: `w-${REVIEWED}` } };
}

describe('reviewNarration', () => {
	it('asks for a write-up on idle, then shows the stored text over the run’s blocks', async () => {
		await withRollback(async (db) => {
			const { owner, selected } = await seedWeek(db);
			const first = await reviewNarration(owner, selected, { db });
			expect(first.view).toEqual({ state: 'writing', ask: true });
			const discuss = new URL(first.discuss, 'https://coach.test');
			expect(discuss.pathname).toBe('/coach');
			expect(Object.fromEntries(discuss.searchParams)).toEqual({
				ask: 'Can we go through my weekly review?',
				from: 'weekly_review',
				ref: `review:w-${REVIEWED}`
			});

			const done = await narrateReview(owner, selected, { db, now });
			expect(done.outcome).toBe('written');
			const { view } = await reviewNarration(owner, selected, { db });
			expect(view.state).toBe('written');
			if (view.state !== 'written' || done.outcome !== 'written') return;
			expect(view.text).toBe(done.narrative);
			expect(view.blocks.length).toBeGreaterThan(0);
			expect(releasedText(view.blocks)).toBe(view.text);
		});
	});

	it('a coach that is not launched or switched off is its notice: nothing to ask', async () => {
		await withRollback(async (db) => {
			const { owner, selected } = await seedWeek(db);
			setMockOverrides({ unavailable: 'not_launched' });
			expect((await reviewNarration(owner, selected, { db })).view).toEqual(
				noticeOf('not_launched')
			);
			setMockOverrides({ unavailable: 'disabled' });
			expect((await reviewNarration(owner, selected, { db })).view).toEqual(noticeOf('disabled'));
		});
	});

	it('after a failed write-up, asking again (Retry) writes it up', async () => {
		await withRollback(async (db) => {
			const { owner, selected } = await seedWeek(db);
			setMockOverrides({ fault: { kind: 'server_error' } });
			expect(await narrateReview(owner, selected, { db, now })).toMatchObject({
				outcome: 'failed'
			});
			expect((await reviewNarration(owner, selected, { db })).view).toEqual({
				state: 'writing',
				ask: true
			});
			clearMockOverrides();
			expect(await narrateReview(owner, selected, { db, now })).toMatchObject({
				outcome: 'written'
			});
			expect((await reviewNarration(owner, selected, { db })).view.state).toBe('written');
		});
	});

	it('is the selected review’s in loadReviews', async () => {
		await withRollback(async (db) => {
			const { owner } = await seedWeek(db);
			const origin = {
				requestId: crypto.randomUUID(),
				method: 'GET',
				path: `/progress/reviews/w-${REVIEWED}`,
				routeId: '/(app)/progress/reviews/[[key]]',
				appVersion: 'test'
			};
			const data = await loadReviews(owner, { key: `w-${REVIEWED}`, origin }, NOW, { db });
			if (data.failed) throw new Error('expected the reviews screen');
			expect(data.selected?.narration?.view).toEqual({ state: 'writing', ask: true });
		});
	});
});
