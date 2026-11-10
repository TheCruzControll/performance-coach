/**
 * The coach's write-up on a review (src/routes/(app)/progress/reviews/[[key]]/CoachWriteUp.svelte,
 * POST and GET /api/reviews/narrate), with the MockProvider:
 * - a weekly and a cycle review are written up once, on opening; the write-up's numbers equal the
 *   SQL oracle; the box it arrives in never moves or grows
 * - 'review-ungrounded': the policy's replacement shows, never the fact as the model stated it
 * - the 'slow' fault: closing the page mid-run and reopening the review shows the stored
 *   write-up, with one run in the database; a second tab during the run shows the writing state,
 *   then the write-up, without a second run
 * - switched off, not launched or over budget: the designed notice, the review intact, no run; a
 *   failure: Retry, which writes it up
 * - refreshed out of date: the same page key, the live revision written up in its place
 * - Discuss opens a new conversation whose entry is weekly_review with the review's ref (SQL),
 *   listed in Recent conversations
 * - axe in both themes, and the screens at 393 × 659 and 1440 × 900
 *
 * Serial: the history and the coach rows are the one owner's, which every browser shares.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays, mondayOf } from '../src/lib/domain/calendar';
import { setCoachFault } from './coach-support';
import { DESKTOP, boxOf, expectNoSideScroll } from './desktop';
import { adherence } from './oracles/general';
import {
	ANALYTICS_TZ,
	auditBothThemes,
	query,
	resetReviews,
	seedReview,
	type SeededReview
} from './review-support';
import { captureScreen, gotoHydrated, SAME_ORIGIN } from './support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

const LIST = '/progress/reviews';
/** The fact 'review-ungrounded' states (agent/provider/mock-scripts/reviews.ts UNGROUNDED_FACT). */
const UNGROUNDED_FACT = 'You squatted 312 kg for 9 reps on Tuesday.';
const UNCHECKED = 'Not checked against your data.';

const writeUp = (page: Page) => page.getByTestId('review-write-up');
const written = (page: Page) =>
	expect(writeUp(page)).toHaveAttribute('data-state', 'written', { timeout: 30_000 });

/** Create a review through the list's form action, as a no-JS post does: its page key. */
async function create(request: APIRequestContext, seeded: SeededReview): Promise<string> {
	const form: { action: string; data: Record<string, string> } =
		seeded.review.kind === 'weekly'
			? { action: 'create', data: { weekStartsOn: seeded.review.weekStartsOn } }
			: {
					action: 'createCycle',
					data: { programId: seeded.programId!, blockLineage: seeded.review.blockLineageId }
				};
	const response = await request.post(`${LIST}?/${form.action}`, {
		headers: SAME_ORIGIN,
		form: form.data,
		maxRedirects: 0
	});
	expect(response.status(), `creating the ${seeded.review.kind} review`).toBe(303);
	return new URL(response.headers().location!, 'https://coach.test').pathname;
}

/** Every run, with its thread's entry: one write-up is one run in its own thread. */
const runs = () =>
	query<{ status: string; from: string }>(
		`select r.status, t.entry->>'from' as from from agent_runs r
		join coach_threads t on t.id = r.thread_id order by r.started_at`
	);

/** The live weekly or cycle review's stored write-up, read in SQL. */
async function narrative(kind: 'weekly' | 'cycle'): Promise<string | null> {
	const [row] = await query<{ narrative: string | null }>(
		`select narrative from ${kind}_reviews where superseded_at is null`
	);
	return row?.narrative ?? null;
}

/** 'Completed that week: 5 sessions of 6 sessions planned.' as [completed, planned]. */
async function completedOfPlanned(page: Page, period: string): Promise<[number, number]> {
	const text = (await writeUp(page).textContent()) ?? '';
	const match = new RegExp(`Completed ${period}: (\\d+)\\D+(\\d+)`).exec(text);
	expect(match, `the write-up says what was completed ${period}`).not.toBeNull();
	return [Number(match![1]), Number(match![2])];
}

test.afterAll(async ({ request }) => {
	await resetReviews(request);
});

test.describe('a weekly review', () => {
	let seeded: SeededReview;
	let url: string;

	test.beforeEach(async ({ request }) => {
		seeded = await seedReview(request, 'week-complete');
		url = await create(request, seeded);
	});

	test('is written up once on opening, its numbers the review’s, in a box that never moves', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, url);
		const before = await boxOf(writeUp(page));
		await written(page);
		await expect(writeUp(page).getByTestId('answer-block').first()).toBeVisible();
		const after = await boxOf(writeUp(page));
		expect(after.y, 'the write-up moved').toBeCloseTo(before.y, 0);
		expect(after.height, 'the write-up’s box grew').toBeCloseTo(before.height, 0);

		const week = seeded.review.kind === 'weekly' ? seeded.review.weekStartsOn : '';
		const [oracle] = await adherence(week, addDays(week, 6), seeded.today);
		expect(await completedOfPlanned(page, 'that week')).toEqual([
			oracle!.completed,
			oracle!.planned
		]);
		await expect(page.getByTestId('review-count-completed')).toHaveAttribute(
			'data-value',
			String(oracle!.completed)
		);
		expect(await runs()).toEqual([{ status: 'completed', from: 'weekly_review_writeup' }]);
		expect(await narrative('weekly')).toMatch(/^Note: Here is your week/);

		// Reopened: the stored write-up, no second run.
		await gotoHydrated(page, url);
		await written(page);
		expect(await runs()).toHaveLength(1);

		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'review-write-up');
		await auditBothThemes(page, 'the weekly review’s write-up');
	});

	test('Discuss opens a new conversation about the review, listed in Recent', async ({ page }) => {
		await gotoHydrated(page, url);
		await written(page);
		await writeUp(page).getByTestId('review-discuss').click();
		await expect(page).toHaveURL(/\/coach\?/);
		const ask = new URL(page.url());
		const key = url.split('/').at(-1)!;
		expect(ask.searchParams.get('from')).toBe('weekly_review');
		expect(ask.searchParams.get('ref')).toBe(`review:${key}`);
		await expect(page.getByTestId('context-chip')).toHaveText(/From your weekly review/);
		const composer = page.getByRole('form', { name: 'Message your coach' });
		await expect(composer.getByRole('textbox', { name: 'Message' })).toHaveValue(
			'Can we go through my weekly review?'
		);

		await composer.getByRole('button', { name: 'Send' }).click();
		await expect(page.getByTestId('owner-message')).toContainText('Can we go through my weekly');
		await expect(composer.getByRole('button', { name: 'Send' })).toBeVisible({ timeout: 30_000 });
		const [thread] = await query<{ id: string; entry: unknown }>(
			`select id::text, entry from coach_threads order by created_at desc limit 1`
		);
		expect(thread!.entry).toEqual({ from: 'weekly_review', ref: { type: 'review', id: key } });
		await gotoHydrated(page, '/coach');
		await expect(page.locator(`a[href="/coach/${thread!.id}"]`)).toBeVisible();
	});

	test('an ungrounded fact shows as the policy’s replacement, never as stated', async ({
		page,
		request
	}) => {
		await setCoachFault(request, 'none', { script: 'review-ungrounded' });
		await gotoHydrated(page, url);
		await written(page);
		const blocks = writeUp(page).getByTestId('answer-block');
		await expect(blocks.filter({ hasText: UNCHECKED })).toHaveCount(1);
		await expect(writeUp(page).locator('[data-kind="fact"]')).toHaveCount(0);
		await expect(page.locator('main')).not.toContainText(`Fact: ${UNGROUNDED_FACT}`);
		expect(await narrative('weekly')).not.toContain(`Fact: ${UNGROUNDED_FACT}`);
	});

	test('closed mid-run, the write-up is stored all the same, and reopening shows it', async ({
		browser,
		request
	}) => {
		await setCoachFault(request, 'slow');
		const context = await browser.newContext();
		const page = await context.newPage();
		await gotoHydrated(page, url);
		await expect(writeUp(page)).toHaveAttribute('data-state', 'writing');
		await expect.poll(async () => (await runs()).length, { timeout: 15_000 }).toBe(1);
		await context.close();

		// The run outlives the page that asked for it.
		await expect.poll(() => narrative('weekly'), { timeout: 30_000 }).not.toBeNull();
		const reopened = await browser.newPage();
		await gotoHydrated(reopened, url);
		await written(reopened);
		const stored = (await narrative('weekly'))!;
		await expect(writeUp(reopened)).toContainText(stored.split('\n\n')[0]!.replace(/^\w+: /, ''));
		expect(await runs()).toEqual([{ status: 'completed', from: 'weekly_review_writeup' }]);
		await reopened.close();
	});

	test('a second tab during the run waits for the same write-up, with no second run', async ({
		browser,
		request
	}) => {
		await setCoachFault(request, 'slow');
		const first = await browser.newPage();
		await gotoHydrated(first, url);
		await expect.poll(async () => (await runs()).length, { timeout: 15_000 }).toBe(1);

		const second = await browser.newPage();
		await gotoHydrated(second, url);
		await expect(writeUp(second)).toHaveAttribute('data-state', 'writing');
		await expect(writeUp(second)).toContainText('Your coach is writing this up…');
		await written(first);
		await written(second);
		expect(await runs()).toHaveLength(1);
		await first.close();
		await second.close();
	});

	for (const [fault, words] of [
		['disabled', 'The coach is switched off'],
		['not_launched', 'Your coach is getting ready'],
		['budget', 'Today’s coach budget is used up']
	] as const) {
		test(`${fault}: the designed notice, the review intact, nothing run`, async ({
			page,
			request
		}) => {
			await setCoachFault(request, fault);
			const before = (await runs()).length;
			await gotoHydrated(page, url);
			const notice = writeUp(page).getByTestId('write-up-notice');
			await expect(notice).toContainText(words, { timeout: 15_000 });
			await expect(notice).toContainText('The figures above are complete.');
			await expect(writeUp(page).getByTestId('write-up-retry')).toHaveCount(0);
			await expect(page.getByTestId('review-summary')).toBeVisible();
			await expect(page.getByTestId('review-count-completed')).toBeVisible();
			expect(await runs()).toHaveLength(before);
			expect(await narrative('weekly')).toBeNull();
		});
	}

	test('a failure says so with Retry, which writes it up', async ({ page, request }, testInfo) => {
		await setCoachFault(request, 'error');
		await gotoHydrated(page, url);
		const notice = writeUp(page).getByTestId('write-up-notice');
		await expect(notice).toContainText('Couldn’t write this up', { timeout: 30_000 });
		await captureScreen(page, testInfo, 'review-write-up-failed');
		await auditBothThemes(page, 'the write-up’s failure');

		await setCoachFault(request, 'none');
		await writeUp(page).getByTestId('write-up-retry').click();
		await written(page);
		expect(await narrative('weekly')).not.toBeNull();
	});

	test('refreshed, the live revision is written up in its place', async ({ page }) => {
		await gotoHydrated(page, url);
		await written(page);
		const week = seeded.review.kind === 'weekly' ? seeded.review.weekStartsOn : '';
		// Edit one of the week's logged sets, so the review is out of date.
		await query(
			`update set_records set rpe = 9, updated_at = now() where id = (
				select s.id from set_records s
				join workouts w on w.id = s.workout_id
				join athlete_profiles p on p.owner_id = s.owner_id
				where w.status = 'completed' and w.deleted_at is null and s.deleted_at is null
					and not s.is_warmup and not s.is_skipped
					and (s.performed_at at time zone p.time_zone)::date between $1::date and $2::date
				order by s.performed_at, s.id limit 1)`,
			[week, addDays(week, 6)]
		);
		await gotoHydrated(page, url);
		await written(page);
		await page.getByTestId('review-stale').getByTestId('review-refresh').click();
		await expect(page.getByTestId('review-stale')).toHaveCount(0);
		// The same page key, a new revision: its own write-up, asked for once.
		await expect.poll(() => narrative('weekly'), { timeout: 30_000 }).not.toBeNull();
		await written(page);
		expect(await runs()).toHaveLength(2);
	});
});

test.describe('a cycle review', () => {
	let seeded: SeededReview;
	let url: string;

	test.beforeAll(async ({ request }) => {
		seeded = await seedReview(request, 'block-end');
		url = await create(request, seeded);
	});

	test('is written up on opening, from its last week’s figures', async ({ page }) => {
		await gotoHydrated(page, url);
		await written(page);
		// The mock reads the last complete week before today (mock-scripts/reviews.ts).
		const week = mondayOf(addDays(seeded.today, -7));
		const [oracle] = await adherence(week, addDays(week, 6), seeded.today);
		expect(await completedOfPlanned(page, 'in its last week')).toEqual([
			oracle!.completed,
			oracle!.planned
		]);
		expect(await runs()).toEqual([{ status: 'completed', from: 'cycle_review_writeup' }]);
		await expect(writeUp(page).getByTestId('review-discuss')).toHaveAttribute(
			'href',
			/from=cycle_review&ref=review%3Ac-/
		);
	});

	test.describe('on a desktop window', () => {
		test.use({ ...DESKTOP });

		test('the write-up sits in the review’s column, with no side scroll', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, url);
			await written(page);
			const review = await boxOf(page.getByTestId('cycle-review'));
			const box = await boxOf(writeUp(page));
			expect(box.x).toBeGreaterThanOrEqual(review.x - 1);
			expect(box.x + box.width).toBeLessThanOrEqual(review.x + review.width + 1);
			await expectNoSideScroll(page);
			await captureScreen(page, testInfo, 'review-write-up-desktop');
		});
	});
});
