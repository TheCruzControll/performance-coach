/**
 * 'What the coach knows' (src/routes/(app)/coach/[[thread]]/KnowsSheet.svelte), opened from the
 * Coach header and read from the coaching memory (GET /api/coach/memory):
 * - 'I hate Bulgarian split squats' is saved to Profile → Exercises; a new conversation's panel
 *   shows the dislike, and 'Which exercises do I avoid?' there cites it while that conversation
 *   holds none of the old one's messages: context persists through structured memory, not chat
 * - the knee-pain fixture's report is under 'Recent pain reports', opening its workout in History
 * - a fresh owner sees 'The coach doesn’t know much yet', with Profile → Goals and Equipment
 * - loading rows while the read is held; a 500 offers Retry, which loads it
 * - axe in both themes, on an iPhone and on a desktop window, where the sheet is a centred dialog
 *   with focus rings and hover
 *
 * Serial: the coach rows and the faults are the one owner's and the one server's
 * (e2e/coach-support.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { COACH_TZ, ownerMessages, query, resetCoach, seedCoach } from './coach-support';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { captureScreen, gotoHydrated, trackConsoleErrors } from './support';

test.use({ timezoneId: COACH_TZ });

test.beforeEach(async ({ request }) => {
	await resetCoach(request);
});

test.afterAll(async ({ request }) => {
	await resetCoach(request);
});

const DISLIKE = 'I hate Bulgarian split squats';
const AVOID = 'Which exercises do I avoid?';
const SPLIT_SQUAT = /Bulgarian split squat/i;

const sheet = (page: Page) => page.getByTestId('knows-sheet');
const composer = (page: Page) => page.getByRole('form', { name: 'Message your coach' });

async function openKnows(page: Page, path = '/coach') {
	await gotoHydrated(page, path);
	await page.getByRole('button', { name: 'What it knows' }).click();
	await expect(sheet(page)).toBeVisible();
}

/** Ask the coach and wait for the whole answer. */
async function ask(page: Page, text: string) {
	await composer(page).getByRole('textbox', { name: 'Message' }).fill(text);
	await composer(page).getByRole('button', { name: 'Send' }).click();
	await expect(page).toHaveURL(/\/coach\/[0-9a-f-]{36}$/);
	await expect(composer(page).getByRole('button', { name: 'Send' })).toBeVisible({
		timeout: 20_000
	});
	await expect(page.getByTestId('live-answer')).not.toHaveAttribute('aria-busy', 'true');
}

const threadOf = (page: Page) => new URL(page.url()).pathname.split('/').at(-1)!;

/** axe on the open sheet in the dark and the light theme. */
async function auditSheet(page: Page) {
	await gotoHydrated(page, '/coach');
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await openKnows(page);
		await expect(page.getByTestId('knows-loading')).toHaveCount(0);
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(400); // the sheet's entrance settles: contrast on final colours
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) =>
			v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
		);
		expect(found, `axe on the memory sheet, ${theme}`).toEqual([]);
	}
}

test('a dislike said to the coach is in Profile, and a new conversation knows it without the old messages', async ({
	page
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/coach');
	await ask(page, DISLIKE);
	const first = threadOf(page);
	await expect(page.getByTestId('live-answer')).toContainText('Noted: you dislike');

	// Profile → Exercises holds it, as the owner's own dislike.
	await gotoHydrated(page, '/profile/exercises');
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
	await expect(
		page.getByRole('list', { name: 'Exercises you’d rather swap out', exact: true })
	).toContainText(SPLIT_SQUAT);

	// A new conversation: its panel shows the dislike, with Profile → Exercises to change it.
	await openKnows(page);
	const preferences = page.getByTestId('knows-preferences');
	await expect(preferences).toContainText(SPLIT_SQUAT);
	await expect(preferences).toContainText('Dislikes');
	await expect(preferences.getByRole('link', { name: 'Edit in Profile' })).toHaveAttribute(
		'href',
		'/profile/exercises'
	);
	await expect(page.getByTestId('knows-decisions')).toContainText(SPLIT_SQUAT);
	await expect(sheet(page)).not.toContainText(DISLIKE);
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, 'coach-memory-panel');
	await sheet(page).getByRole('button', { name: 'Close' }).click();
	await expect(sheet(page)).toBeHidden();

	await ask(page, AVOID);
	const second = threadOf(page);
	expect(second).not.toBe(first);
	const answer = page.getByTestId('live-answer');
	await expect(answer).toContainText(SPLIT_SQUAT);
	await expect(
		answer.getByRole('list', { name: 'Sources' }).getByRole('link', { name: SPLIT_SQUAT })
	).toHaveAttribute('href', '/profile/exercises');

	// The new conversation holds only its own question: nothing of the old one was replayed.
	expect((await ownerMessages(second)).map((m) => m.text)).toEqual([AVOID]);
	const stored = await query<{ text: string }>(
		`select content::text as text from coach_messages where thread_id = $1`,
		[second]
	);
	expect(stored.length).toBeGreaterThan(0);
	expect(stored.filter((m) => m.text.includes(DISLIKE))).toEqual([]);
	expect(errors).toEqual([]);
});

test('the knee-pain report is under recent pain reports and opens its workout in History', async ({
	page,
	request
}, testInfo) => {
	await seedCoach(request, 'knee-pain');
	const [report] = await query<{ workoutId: string }>(
		`select workout_id::text as "workoutId" from pain_reports`
	);
	await openKnows(page);
	const pain = page.getByTestId('knows-pain');
	await expect(pain).toContainText('Back squat · Knee');
	await expect(pain).toContainText('Moderate · Ended the workout');
	await expect(pain.getByRole('link', { name: 'Edit in Profile' })).toHaveCount(0);
	await captureScreen(page, testInfo, 'coach-memory-panel-pain');
	const link = pain.getByRole('link', { name: /Back squat/ });
	await expect(link).toHaveAttribute('href', `/progress/workouts/${report!.workoutId}`);
	await link.click();
	await expect(page).toHaveURL(`/progress/workouts/${report!.workoutId}`);
});

test('a fresh owner sees that the coach doesn’t know much yet, with Goals and Equipment', async ({
	page
}, testInfo) => {
	await openKnows(page);
	const empty = page.getByTestId('knows-empty');
	await expect(empty).toContainText('The coach doesn’t know much yet');
	await expect(empty.getByRole('link', { name: 'Equipment' })).toHaveAttribute(
		'href',
		'/profile/equipment'
	);
	await captureScreen(page, testInfo, 'coach-memory-panel-empty');
	await empty.getByRole('link', { name: 'Goals' }).click();
	await expect(page).toHaveURL('/profile/goals');
});

test('the memory sheet has no WCAG A/AA violations in either theme', async ({ page, request }) => {
	await seedCoach(request, 'knee-pain');
	await auditSheet(page);
});

test.describe('with the network in the test’s hands', () => {
	// page.route never sees a request from a page the service worker controls on WebKit.
	test.use({ serviceWorkers: 'block' });

	test('loading rows while the read is held; a 500 offers Retry, which loads it', async ({
		page
	}, testInfo) => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let answered = 0;
		await page.route('**/api/coach/memory', async (route) => {
			answered += 1;
			if (answered === 1) {
				await held;
				return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
			}
			return route.continue();
		});

		await openKnows(page);
		const loading = page.getByTestId('knows-loading');
		await expect(loading).toHaveAttribute('aria-busy', 'true');
		await expect(loading).toContainText('Loading what the coach knows…');
		await page.evaluate(async () => {
			while (document.fonts.status !== 'loaded') await new Promise((r) => setTimeout(r, 20));
		});
		await captureScreen(page, testInfo, 'coach-memory-panel-loading');
		release();

		const failed = page.getByTestId('knows-failed');
		await expect(failed).toContainText('Couldn’t load what the coach knows');
		await captureScreen(page, testInfo, 'coach-memory-panel-failed');
		await failed.getByRole('button', { name: 'Try again' }).click();
		await expect(page.getByTestId('knows-empty')).toBeVisible();
		await expect(failed).toHaveCount(0);
		expect(answered).toBe(2);
	});
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test('the sheet is a centred dialog, with focus rings and hover on its links', async ({
		page,
		request
	}, testInfo) => {
		await seedCoach(request, 'knee-pain');
		await openKnows(page);
		const pain = page.getByTestId('knows-pain');
		await expect(pain).toContainText('Back squat · Knee');

		const box = (await sheet(page).locator('.sheet').boundingBox())!;
		const window = (await sheet(page).boundingBox())!;
		expect(Math.abs(box.x + box.width / 2 - (window.x + window.width / 2))).toBeLessThanOrEqual(1);
		expect(box.y).toBeGreaterThan(0);

		// Tab from Close reaches the report's link by keyboard, which is what shows the ring.
		const link = pain.getByRole('link', { name: /Back squat/ });
		await sheet(page).getByRole('button', { name: 'Close' }).focus();
		for (let i = 0; i < 10 && !(await link.evaluate((el) => el === document.activeElement)); i++)
			await page.keyboard.press('Tab');
		await expect(link).toBeFocused();
		await expect
			.poll(() => link.evaluate((el) => getComputedStyle(el).outlineStyle))
			.not.toBe('none');
		await page.mouse.move(0, 0);
		const resting = await link.evaluate((el) => getComputedStyle(el).backgroundColor);
		await link.hover();
		await expect
			.poll(() => link.evaluate((el) => getComputedStyle(el).backgroundColor))
			.not.toBe(resting);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-memory-panel-desktop');
	});

	test('the memory sheet has no WCAG A/AA violations on a desktop window in either theme', async ({
		page,
		request
	}) => {
		await seedCoach(request, 'knee-pain');
		await auditSheet(page);
	});
});
