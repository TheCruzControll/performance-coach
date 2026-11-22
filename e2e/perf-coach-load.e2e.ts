import { expect, test, type APIRequestContext } from '@playwright/test';
import { COACH_TZ, postTurn, resetCoach, seedCoach } from './coach-support';
import { expectLoadBudget, GUARD_MS, type Seeded } from './load-budget';
import { query } from './support';

/**
 * The main-thread budget while the coach screens as M5 finished them load (e2e/load-budget.ts:
 * median blocking time of 5 cold loads at 4× CPU, within GUARD_MS), each also held to MAX_SHIFT.
 * They are measured on coach fixtures (e2e/coach-support.ts) in the zone they were seeded in: a long
 * conversation (long-thread, a full page of the thread view and one more exchange) and the
 * Proposals inbox with two proposals waiting, proposed by the composer's real turns. Seeding a
 * coach fixture blanks the training profile (resetCoach), which each test puts back the same way
 * after its loads. perf.e2e.ts measures the app's other screens the same way; perf-coach.e2e.ts
 * measures the 60-message conversation and an answer streaming.
 */
/** The long-thread fixture's conversation, with its newest page of messages on screen. */
const COACH_THREAD = '/coach/<long thread>';
/** The Proposals inbox with the swap and the next cycle waiting, each from its own conversation. */
const COACH_INBOX = '/coach/proposals (inbox)';
/** The turns that propose the inbox's two changes on the split-squat-week fixture. */
const COACH_PROPOSALS = ['I hate Bulgarian split squats, so replace them', 'Plan my next cycle'];
const COACH_SCREENS = [COACH_THREAD, COACH_INBOX];

/** The coach screen `path` on its fixture: the URL to load, and the coach emptied after. */
async function seedCoachScreen(path: string, request: APIRequestContext): Promise<Seeded> {
	const restore = () => resetCoach(request);
	const context = { timezoneId: COACH_TZ };
	if (path === COACH_THREAD) {
		const { threads } = await seedCoach(request, 'long-thread');
		return { url: `/coach/${threads.long}`, restore, shows: 'coach-message', context };
	}
	await seedCoach(request, 'split-squat-week');
	for (const text of COACH_PROPOSALS) {
		const turn = await postTurn(request, text);
		expect(turn.status, text).toBe(200);
		expect(turn.events.at(-1), text).toEqual({ type: 'done', status: 'completed' });
	}
	const [waiting] = await query<{ n: number }>(
		`select count(*)::int as n from coach_proposals where status = 'proposed'`
	);
	expect(waiting?.n, 'proposals waiting in the inbox').toBe(COACH_PROPOSALS.length);
	return { url: '/coach/proposals', restore, shows: 'inbox-row', context };
}

test.describe('main-thread budget (4× CPU)', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CPU throttling uses CDP');

	for (const path of COACH_SCREENS) {
		test(`${path} blocks the main thread ≤ ${GUARD_MS} ms while loading`, async ({
			browser,
			request
		}, testInfo) => {
			await expectLoadBudget(path, await seedCoachScreen(path, request), {
				browser,
				testInfo,
				maxShift: true
			});
		});
	}
});
