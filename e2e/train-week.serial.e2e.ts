/**
 * Train's week (src/routes/(app)/train): the current program's block and week, server-rendered,
 * with strength, running and Muay Thai on their days, the week-1 baseline brief, week navigation
 * that keeps focus and shows a pending state, and the designed rest-day, not-started,
 * not-planned-yet, first-block-complete, no-program, error and offline states. Serial: programs
 * are the one owner's, which every browser and worker shares. Fixture programs come from the
 * test-only route at dates the server computes (e2e/program-support.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { longDate, shortDate } from '../src/lib/ui/program/words';
import { PROGRAM_TZ, seedProgram, type SeededProgram } from './program-support';
import { captureScreen, gotoHydrated, resetTrainingProfile, trackConsoleErrors } from './support';

test.use({ timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

/** Count layout shifts that no input explains (CLS), where the browser reports them. */
async function watchShifts(page: Page) {
	await page.addInitScript(() => {
		const shifts: number[] = [];
		Object.assign(window, { __shifts: shifts });
		if (!PerformanceObserver.supportedEntryTypes.includes('layout-shift')) return;
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries() as (PerformanceEntry & {
				value: number;
				hadRecentInput: boolean;
			})[]) {
				if (!entry.hadRecentInput) shifts.push(entry.value);
			}
		}).observe({ type: 'layout-shift', buffered: true });
	});
}
const shifts = (page: Page) =>
	page.evaluate(() => (window as unknown as { __shifts: number[] }).__shifts);

async function audit(page: Page): Promise<string[]> {
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(400); // entrance transitions settle: contrast on final colours
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

const position = (page: Page) => page.getByTestId('program-position');
const strip = (page: Page) => page.getByTestId('week-strip');
const days = (page: Page) => strip(page).getByRole('radio');
const cards = (page: Page) => page.getByTestId('session-card');
const weekRegion = (page: Page) => page.getByTestId('train-week');

/** The day's radio in the strip, by its date. */
const dayOf = (page: Page, date: string) =>
	strip(page).getByRole('radio', { name: new RegExp(`^${longDate(date)}\\b`) });

/** Each card's title and line, in order. */
const cardTexts = (page: Page) =>
	cards(page).evaluateAll((all) =>
		all.map((card) => [...card.querySelectorAll('.title, .line')].map((n) => n.textContent))
	);

/** Change week from the keyboard (WebKit focuses no link on a click): the link keeps focus. */
async function press(link: Locator) {
	await link.focus();
	await link.press('Enter');
}

test.describe('a program this week', () => {
	let seeded: SeededProgram;
	test.beforeEach(async ({ request }) => {
		seeded = await seedProgram(request, { fixture: 'hybrid', start: 'this_week' });
	});

	test('strength, running and Muay Thai sit on their days; a tapped day shows its sessions; a rest day is designed', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await watchShifts(page);
		await gotoHydrated(page, '/train');

		const header = page.getByTestId('program-header');
		await expect(header.getByRole('heading', { level: 2 })).toHaveText(
			'Strength, running and Muay Thai'
		);
		await expect(position(page)).toHaveText('Baseline week · Week 1 of 5');
		await expect(header.getByRole('link', { name: 'Week 1, this week' })).toHaveAttribute(
			'aria-current',
			'page'
		);
		await expect(page.getByTestId('baseline-brief')).toContainText(
			'Record the weight, reps and RPE of every set.'
		);

		// Monday first, the server's today selected and marked; each day names what it holds.
		await expect(strip(page)).toHaveAttribute('aria-label', 'Week 1');
		const names = await days(page).evaluateAll((all) =>
			all.map((d) => d.getAttribute('aria-label'))
		);
		const week = Array.from({ length: 7 }, (_, i) => addDays(seeded.weekStart, i));
		expect(names.map((n) => n!.replace(', today', ''))).toEqual(
			week.map(
				(date, i) =>
					`${longDate(date)}, ${['1 session', '1 session', '1 session', '2 sessions'][i] ?? 'no sessions'}`
			)
		);
		await expect(dayOf(page, seeded.today)).toHaveAttribute('aria-checked', 'true');
		await expect(dayOf(page, seeded.today)).toHaveAttribute('aria-current', 'date');

		await dayOf(page, week[0]!).click();
		await expect(page.getByTestId('day-sessions').getByRole('heading')).toHaveText(
			longDate(week[0]!)
		);
		expect(await cardTexts(page)).toEqual([
			['Full body', 'Strength · 60 min · Moderate · Morning']
		]);
		await expect(cards(page)).toContainText('Baseline');

		await dayOf(page, week[1]!).click();
		expect(await cardTexts(page)).toEqual([
			['Muay Thai class', 'Muay Thai · 90 min · Hard · Evening']
		]);
		await expect(cards(page)).not.toContainText('Baseline');

		await dayOf(page, week[2]!).click();
		expect(await cardTexts(page)).toEqual([['Intervals', 'Intervals · 45 min · Hard · Morning']]);

		await dayOf(page, week[3]!).click();
		expect(await cardTexts(page)).toEqual([
			['Easy run', 'Easy run · 30 min · Easy · Morning'],
			['Muay Thai class', 'Muay Thai · 90 min · Hard · Evening']
		]);
		await captureScreen(page, testInfo, 'train-week');

		// A rest day: designed, never a blank card list.
		await dayOf(page, week[4]!).click();
		await expect(cards(page)).toHaveCount(0);
		await expect(page.getByTestId('rest-day')).toContainText('Rest day');
		await expect(page.getByTestId('rest-day')).toContainText('Nothing else is planned this week.');
		await expect(page.getByTestId('open-plates')).toBeVisible(); // the tools stay
		await captureScreen(page, testInfo, 'train-rest-day');

		expect(await shifts(page), 'layout shifts no input explains').toEqual([]);
		expect(errors).toEqual([]);

		for (const theme of ['dark', 'light'] as const) {
			await page.evaluate(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await gotoHydrated(page, '/train');
			expect(await audit(page), `axe, ${theme}`).toEqual([]);
		}
	});

	test('the next week loads from the server, with ?week in the URL and focus kept; a reload keeps it', async ({
		page
	}) => {
		await gotoHydrated(page, '/train');
		const next = page.getByTestId('next-week');
		const data = page.waitForResponse((r) => r.url().includes('/train/__data.json'));
		await press(next);
		expect((await data).status()).toBe(200);
		await expect(page).toHaveURL(/\/train\?week=2$/);
		await expect(position(page)).toHaveText('Accumulation · Week 2 of 5');
		await expect(next).toBeFocused();
		await expect(page.getByTestId('baseline-brief')).toHaveCount(0);
		await expect(strip(page)).toHaveAttribute('aria-label', 'Week 2');
		await expect(dayOf(page, addDays(seeded.weekStart, 7))).toBeVisible();
		await expect(page.getByRole('link', { name: /^Week 2$/ })).toHaveAttribute(
			'aria-current',
			'page'
		);

		// The weekday the owner picked stays picked from week to week.
		await dayOf(page, addDays(seeded.weekStart, 9)).click();
		await press(next);
		await expect(position(page)).toHaveText('Accumulation · Week 3 of 5');
		await expect(dayOf(page, addDays(seeded.weekStart, 16))).toHaveAttribute(
			'aria-checked',
			'true'
		);
		expect(await cardTexts(page)).toEqual([['Intervals', 'Intervals · 45 min · Hard · Morning']]);

		await page.reload();
		await expect(page).toHaveURL(/\/train\?week=3$/);
		await expect(position(page)).toHaveText('Accumulation · Week 3 of 5');

		// A pill goes straight to its week; previous steps back.
		await press(page.getByRole('link', { name: /^Week 5$/ }));
		await expect(position(page)).toHaveText('Accumulation · Week 5 of 5');
		await expect(page.getByTestId('next-week')).toHaveCount(0); // the plan ends here
		await press(page.getByTestId('previous-week'));
		await expect(position(page)).toHaveText('Accumulation · Week 4 of 5');
		await expect(page.getByTestId('previous-week')).toBeFocused();
	});

	test('while the next week loads, the week is busy and nothing moves', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, '/train');
		await dayOf(page, seeded.weekStart).click(); // Monday: a card to watch
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route('**/__data.json*', async (route) => {
			await held;
			await route.continue();
		});
		const boxes = () =>
			Promise.all([strip(page), page.getByTestId('day-sessions')].map((l) => l.boundingBox()));
		const before = await boxes();

		await press(page.getByTestId('next-week'));
		await expect(weekRegion(page)).toHaveAttribute('aria-busy', 'true');
		await expect(page.getByRole('link', { name: /^Week 2$/ })).toHaveAttribute('aria-busy', 'true');
		await expect(page.getByRole('status').filter({ hasText: 'Loading the week' })).toHaveCount(1);
		await page.waitForTimeout(500); // past the dimming's delay
		expect(await boxes(), 'the strip and the cards keep their place and size').toEqual(before);
		await captureScreen(page, testInfo, 'train-pending');

		release();
		await expect(weekRegion(page)).toHaveAttribute('aria-busy', 'false');
		await expect(position(page)).toHaveText('Accumulation · Week 2 of 5');
		await expect(page.getByTestId('next-week')).toBeFocused();
	});

	// A week whose data request fails (500) is the (app) layout's error view, inside the shell:
	// SvelteKit renders a failed client navigation there. Train's own error card, for a server
	// read that fails, is the load's fail-soft payload (tests/integration/training/train-load.test.ts).
	test('a week whose data fails to load shows the shell’s error view, whose Try again loads it', async ({
		page
	}) => {
		await gotoHydrated(page, '/train');
		await page.route('**/__data.json*', (route) =>
			route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'Something went wrong on our side.', requestId: 'e2e' })
			})
		);
		await press(page.getByTestId('next-week'));
		const error = page.getByTestId('error-view');
		await expect(error).toBeVisible();
		await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
		await expect(error).toContainText('Something went wrong');
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

		await page.unrouteAll({ behavior: 'ignoreErrors' });
		await error.getByRole('button', { name: 'Try again' }).click();
		await expect(position(page)).toHaveText('Accumulation · Week 2 of 5');
		await expect(page).toHaveURL(/\/train\?week=2$/);
	});

	test.describe('offline', () => {
		// The page's own requests, which every engine can take offline (WebKit cannot take a
		// service worker's); offline.e2e.ts covers Train under the service worker on Chromium.
		test.use({ serviceWorkers: 'block' });

		test('changing week shows the designed offline state, never a 500', async ({
			page,
			context
		}) => {
			await gotoHydrated(page, '/train');
			await context.setOffline(true);
			await press(page.getByTestId('next-week'));
			await expect(page.getByTestId('offline-state')).toBeVisible();
			await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
			await expect(page.locator('body')).not.toContainText(/internal error/i);
			await context.setOffline(false);
		});
	});

	test('?week past the plan is not planned yet; a malformed ?week is the current week', async ({
		page
	}) => {
		await gotoHydrated(page, '/train?week=99');
		await expect(position(page)).toHaveText('Week 99 · Not planned yet');
		await expect(page.getByTestId('train-not-planned')).toContainText(
			'Week 99 is past the end of your plan.'
		);
		await expect(strip(page)).toHaveCount(0);

		// While this week loads, the link that asked for it keeps the focus: only the week's strip
		// and cards go inert, never the state card.
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route('**/__data.json*', async (route) => {
			await held;
			await route.continue();
		});
		const back = page.getByRole('link', { name: 'Back to this week' });
		await press(back);
		await expect(weekRegion(page)).toHaveAttribute('aria-busy', 'true');
		await expect(back).toBeFocused();
		release();
		await expect(page).toHaveURL(/\/train$/);
		await expect(position(page)).toHaveText('Baseline week · Week 1 of 5');

		await gotoHydrated(page, '/train?week=abc');
		await expect(position(page)).toHaveText('Baseline week · Week 1 of 5');
		await expect(dayOf(page, seeded.today)).toHaveAttribute('aria-checked', 'true');
	});

	test('on a desktop window the week sits centred at a readable width', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 1440, height: 900 });
		await gotoHydrated(page, '/train');
		const main = await page.locator('main').boundingBox();
		expect(main!.width).toBeLessThanOrEqual(34 * 16);
		expect(Math.abs(main!.x - (1440 - main!.x - main!.width))).toBeLessThanOrEqual(1);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
		).toBe(true);
		await captureScreen(page, testInfo, 'train-week-desktop');
	});
});

test('a program that starts next Monday says so, and shows week 1 from its first day', async ({
	page,
	request
}) => {
	const seeded = await seedProgram(request, { fixture: 'hybrid', start: 'next_week' });
	await gotoHydrated(page, '/train');
	await expect(page.getByTestId('program-status')).toHaveText(
		`Starts ${shortDate(seeded.weekStart)}`
	);
	await expect(position(page)).toHaveText('Baseline week · Week 1 of 5');
	await expect(dayOf(page, seeded.weekStart)).toHaveAttribute('aria-checked', 'true');
	await expect(strip(page).locator('[aria-current="date"]')).toHaveCount(0);
	await expect(page.getByTestId('previous-week')).toHaveCount(0);
});

test('once the planned weeks are over, the first block is complete: a summary, never a fake session', async ({
	page,
	request
}, testInfo) => {
	const seeded = await seedProgram(request, { fixture: 'one-week', start: 'last_week' });
	await gotoHydrated(page, '/train');
	await expect(position(page)).toHaveText('First block complete');
	const done = page.getByTestId('train-block-complete');
	await expect(done).toContainText(
		`You trained through every planned week, ${shortDate(seeded.weekStart)} – ${shortDate(addDays(seeded.weekStart, 6))}.`
	);
	await expect(done).toContainText(
		'Your next block is planned from how this one went, starting with Accumulation.'
	);
	await expect(cards(page)).toHaveCount(0);
	await expect(strip(page)).toHaveCount(0);
	await captureScreen(page, testInfo, 'train-block-complete');
	expect(await audit(page)).toEqual([]);

	await page.getByTestId('train-next').click();
	await expect(page).toHaveURL(/\/train\?week=1$/);
	await expect(position(page)).toHaveText('Baseline week · Week 1 of 1');
});

test('with no program, Train says what comes first and links to it', async ({ page }, testInfo) => {
	await gotoHydrated(page, '/train');
	const empty = page.getByTestId('train-empty');
	await expect(empty.getByRole('heading', { name: 'No program yet' })).toBeVisible();
	await expect(empty).toContainText('Finish your training profile first');
	await expect(page.getByTestId('train-next')).toHaveAttribute('href', '/profile');
	await expect(page.getByTestId('program-header')).toHaveCount(0);
	await expect(page.getByTestId('open-plates')).toBeVisible();
	await captureScreen(page, testInfo, 'train-empty');
});
