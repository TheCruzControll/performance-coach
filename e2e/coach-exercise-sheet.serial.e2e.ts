/**
 * An exercise source in a coach answer (src/routes/(app)/coach/[[thread]]/Thread.svelte) opens
 * M4's exercise history sheet (src/lib/ui/workout/ExerciseHistorySheet.svelte) by exercise id
 * alone, over the conversation: shallow-routed so Back closes it and a reload shows the
 * conversation without it. A history request that fails shows the sheet's designed error, and
 * offline it says the history needs a connection, each with a Retry that recovers. The sheet's
 * code arrives on the first tap; a failed fetch is the chunk-failed toast, whose Retry opens it.
 *
 * Serial: the coach rows are the one owner's (e2e/coach-support.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { COACH_TZ, openThread, resetCoach, seedCoach, type SeededCoach } from './coach-support';
import { DESKTOP, expectMainCentred, expectNoSideScroll, tokenPx } from './desktop';
import { captureScreen, toastWith, trackConsoleErrors } from './support';

const CLIENT = path.resolve(import.meta.dirname, '../.svelte-kit/output/client');
const SHEET_SOURCE = 'src/lib/ui/workout/ExerciseHistorySheet.svelte';
const HISTORY_API = '**/api/exercises/*/history*';

/** The sheet's chunk in the build under test, from Vite's manifest. */
function sheetChunk(): string {
	const manifest = JSON.parse(readFileSync(`${CLIENT}/.vite/manifest.json`, 'utf8')) as Record<
		string,
		{ file: string } | undefined
	>;
	const chunk = manifest[SHEET_SOURCE];
	if (!chunk) throw new Error(`${SHEET_SOURCE} is not in the build under test`);
	return chunk.file;
}

test.use({ timezoneId: COACH_TZ });
// page.route never sees a request from a page the service worker controls on WebKit.
test.use({ serviceWorkers: 'block' });

let seeded: SeededCoach;
test.beforeEach(async ({ request }) => {
	seeded = await seedCoach(request, 'bench-month');
});

test.afterAll(async ({ request }) => {
	await resetCoach(request);
});

const sheet = (page: Page) => page.getByTestId('exercise-history-sheet');
const sessions = (page: Page) => sheet(page).getByTestId('history-session');
const benchSource = (page: Page) =>
	page
		.getByTestId('coach-message')
		.getByRole('list', { name: 'Sources' })
		.getByRole('button', { name: 'Bench press, Exercise', exact: true });

const threadPath = () => `/coach/${seeded.threads.bench}`;

/** The seeded month of bench press: four sessions of 3 × 5, newest (87.5 kg) first. */
async function expectBenchMonth(page: Page) {
	await expect(sheet(page)).toBeVisible();
	await expect(sheet(page).getByRole('heading', { name: 'Bench press' })).toBeVisible();
	await expect(sessions(page)).toHaveCount(4);
	for (const [n, kg] of ['87.5', '85', '82.5', '80'].entries()) {
		await expect(sessions(page).nth(n).getByTestId('history-set')).toHaveText([
			new RegExp(`Set 1\\s*${kg} kg × 5 reps · RPE 8\\s*$`),
			new RegExp(`Set 2\\s*${kg} kg × 5 reps · RPE 8\\s*$`),
			new RegExp(`Set 3\\s*${kg} kg × 5 reps · RPE 8\\s*$`)
		]);
	}
	await expect(sheet(page).getByTestId('history-best')).toContainText(/^Estimated 1RM · [\d.]+ kg/);
}

/** axe on the page as it is (the sheet open), in the dark and the light theme. */
async function auditThemes(page: Page, state: string) {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate((t) => {
			if (t === 'dark') delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = t;
		}, theme);
		await page.waitForTimeout(400); // transitions settle: contrast on final colours
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) =>
			v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
		);
		expect(found, `axe, ${state}, ${theme}`).toEqual([]);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

test('the Bench press source opens its history over the conversation; Back closes it, and a reload shows the conversation without it', async ({
	page
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	await openThread(page, seeded.threads.bench!);
	await benchSource(page).click();
	await expectBenchMonth(page);
	await expect(page).toHaveURL(threadPath());
	await expect(page.getByTestId('thread')).toBeAttached();
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, 'coach-exercise-sheet');
	await auditThemes(page, 'ready');

	await page.goBack();
	await expect(sheet(page)).toBeHidden();
	await expect(page).toHaveURL(threadPath());
	await expect(page.getByTestId('owner-message')).toBeVisible();

	await benchSource(page).click();
	await expect(sessions(page)).toHaveCount(4);
	await page.reload();
	await expect(page.getByTestId('coach-message')).toContainText('Bench press');
	await page.waitForLoadState('networkidle');
	await expect(sheet(page)).toHaveCount(0);

	// Closing it is Back too, focus returns to the source, and the reloaded entry's sheet stays gone.
	await benchSource(page).click();
	await expect(sessions(page)).toHaveCount(4);
	await sheet(page).getByRole('button', { name: 'Close' }).click();
	await expect(sheet(page)).toBeHidden();
	await expect(page).toHaveURL(threadPath());
	await expect(benchSource(page), 'focus returns to the source').toBeFocused();
	await page.waitForTimeout(500);
	await expect(sheet(page)).toBeHidden();
	expect(errors).toEqual([]);
});

test('a history request answering 500 shows the error with Retry, which recovers', async ({
	page
}, testInfo) => {
	await openThread(page, seeded.threads.bench!);
	await page.route(HISTORY_API, (route) => route.fulfill({ status: 500, json: { error: 'x' } }));
	await benchSource(page).click();
	const error = sheet(page).getByTestId('exercise-history-error');
	await expect(error).toContainText('Couldn’t load this history');
	await expect(sheet(page).getByRole('heading', { name: 'Exercise history' })).toBeVisible();
	await captureScreen(page, testInfo, 'coach-exercise-sheet-error');
	await auditThemes(page, 'error');

	await page.unrouteAll({ behavior: 'ignoreErrors' });
	await error.getByRole('button', { name: 'Try again' }).click();
	await expectBenchMonth(page);
	await expect(error).toHaveCount(0);
});

test('offline it says the history needs a connection, and Retry recovers once back online', async ({
	page,
	context
}, testInfo) => {
	await openThread(page, seeded.threads.bench!);
	// Its code arrives online first: offline, with the service worker blocked, nothing would.
	await benchSource(page).click();
	await expect(sessions(page)).toHaveCount(4);
	await sheet(page).getByRole('button', { name: 'Close' }).click();
	await expect(sheet(page)).toBeHidden();

	await context.setOffline(true);
	await benchSource(page).click();
	const offline = sheet(page).getByTestId('exercise-history-offline');
	await expect(offline).toContainText('Exercise history needs a connection');
	await expect(offline).toContainText('It isn’t kept on this device.');
	await expect(sessions(page)).toHaveCount(0);
	await captureScreen(page, testInfo, 'coach-exercise-sheet-offline');
	await auditThemes(page, 'offline');

	// Still offline, Retry keeps the state; back online, it loads.
	await offline.getByRole('button', { name: 'Try again' }).click();
	await expect(offline).toContainText('Exercise history needs a connection');
	await context.setOffline(false);
	await offline.getByRole('button', { name: 'Try again' }).click();
	await expectBenchMonth(page);
});

test('the sheet’s code failing to load is the chunk-failed toast, whose Retry opens it', async ({
	page
}) => {
	const chunk = `**/${sheetChunk()}`;
	await page.route(chunk, (route) => route.abort());
	await openThread(page, seeded.threads.bench!);
	// Fetched as a module, never as a modulepreload, which WebKit would never fetch again.
	await expect(page.locator(`link[rel="modulepreload"][href$="/${sheetChunk()}"]`)).toHaveCount(0);

	await benchSource(page).click();
	const failed = toastWith(page, 'Couldn’t load this part of the coach');
	await expect(failed).toBeVisible();
	await expect(sheet(page)).toHaveCount(0);
	await expect(page.getByTestId('thread')).not.toHaveAttribute('aria-busy', 'true');

	// In place on WebKit; on Chromium, which keeps the failed fetch, through a reload of the
	// conversation that opens the sheet once its code arrives.
	await page.unroute(chunk);
	await failed.getByRole('button', { name: 'Try again' }).click();
	await expectBenchMonth(page);
	await expect(page).toHaveURL(threadPath());

	await page.keyboard.press('Escape');
	await expect(sheet(page)).toBeHidden();
	await expect(page).toHaveURL(threadPath());
	await expect(page.getByTestId('owner-message')).toBeVisible();
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test('the sheet is a centred dialog over the readable column, opened and closed by keyboard', async ({
		page
	}, testInfo) => {
		await openThread(page, seeded.threads.bench!);
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));
		const source = benchSource(page);

		for (let i = 0; i < 60 && !(await source.evaluate((el) => el === document.activeElement)); i++)
			await page.keyboard.press('Tab');
		await expect(source).toBeFocused();
		expect(await source.evaluate((el) => el.matches(':focus-visible'))).toBe(true);

		await page.keyboard.press('Enter');
		const dialog = page.getByRole('dialog', { name: 'Bench press' });
		await expect(dialog).toBeVisible();
		await expectBenchMonth(page);
		const box = (await sheet(page).locator('.sheet').boundingBox())!;
		expect(box.width, 'a dialog, never a stretched phone sheet').toBeLessThanOrEqual(512);
		expect(Math.abs(box.x + box.width / 2 - 720), 'centred in the window').toBeLessThanOrEqual(10);
		expect(box.y + box.height, 'clear of the window’s bottom edge').toBeLessThan(900);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-exercise-sheet-desktop');
		await auditThemes(page, 'desktop');

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(source).toBeFocused();
		await expect(page).toHaveURL(threadPath());
	});
});
