/**
 * Train's week (src/routes/(app)/train, Instrument v2): the current program's week and its place,
 * server-rendered, as one line per session (strength, running and Muay Thai on their days, Rest on
 * a day off), week 1's brief behind the week's one line, the tools behind More, week arrows that
 * keep focus and show a pending state, and the designed not-started, not-planned-yet,
 * first-block-complete, no-program, error and offline states. Serial: programs
 * are the one owner's, which every browser and worker shares. Fixture programs come from the
 * test-only route at dates the server computes (e2e/program-support.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { longDate } from '../src/lib/ui/program/words';
import {
	BELOW_DESKTOP_WIDTH,
	DESKTOP,
	DESKTOP_WIDTHS,
	expectMainCentred,
	expectNoSideScroll,
	tokenPx
} from './desktop';
import {
	dayLines,
	lineDay,
	openMore,
	PROGRAM_TZ,
	seedProgram,
	sessionLine,
	type SeededProgram
} from './program-support';
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
const title = (page: Page) => page.getByTestId('week-title');
const lines = (page: Page) => page.getByTestId('week-lines');
const weekRegion = (page: Page) => page.getByTestId('train-week');

/** Each line's accessible name, in order: 'Monday 9 November, Full body, 60 min'. */
const lineNames = (page: Page) =>
	lines(page)
		.locator('[data-date]')
		.evaluateAll((all) => all.map((line) => line.getAttribute('aria-label')));

/** '9 November': a date without its weekday, as the block-complete summary says it. */
const dayMonth = (date: string) => longDate(date).replace(/^\S+ /, '');

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

	test('strength, running and Muay Thai sit on their days as lines, and a day off says Rest', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await watchShifts(page);
		await gotoHydrated(page, '/train');

		await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeAttached();
		await expect(title(page)).toHaveText('This week');
		await expect(position(page)).toHaveText('Week 1 of 5 · Baseline week');
		await expect(page.getByTestId('program-status')).toHaveText('Five sessions this week');

		// Monday first: one line per session, each named in full; a day of two leaves its second
		// line's day blank, and a day with none is one Rest line.
		await expect(lines(page)).toHaveAttribute('aria-label', 'Week 1');
		const week = Array.from({ length: 7 }, (_, i) => addDays(seeded.weekStart, i));
		// Today's line's name holds the 'Today' it shows.
		const day = (i: number) => lineDay(week[i]!, seeded.today);
		expect(await lineNames(page)).toEqual([
			`${day(0)}, Full body, 60 min`,
			`${day(1)}, Muay Thai class, 90 min`,
			`${day(2)}, Intervals, 45 min`,
			`${day(3)}, Easy run, 30 min`,
			`${day(3)}, Muay Thai class, 90 min`,
			`${day(4)}, rest`,
			`${day(5)}, rest`,
			`${day(6)}, rest`
		]);
		await expect(dayLines(page, week[3]!)).toHaveCount(2);
		await expect(dayLines(page, week[3]!).nth(1).locator('.day')).toHaveText('');
		await expect(dayLines(page, seeded.today).first().locator('.day')).toHaveText('Today');
		await expect(sessionLine(page, 'Full body', week[0])).toHaveAttribute(
			'href',
			/^\/train\/session\/[^/]+$/
		);
		await expect(sessionLine(page, 'Full body', week[0])).toHaveAttribute('data-status', 'planned');
		await captureScreen(page, testInfo, 'train-week');

		// A rest day: a line that says Rest and links nowhere.
		const rest = page.getByTestId('rest-day');
		await expect(rest).toHaveCount(3);
		await expect(rest.first()).toContainText('Rest');
		await expect(rest.first()).not.toHaveAttribute('href');
		await rest.last().scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'train-rest-day');

		// Week 1's brief is behind the week's one line (a finding, if the week had one, names
		// the line first).
		const note = page.getByTestId('week-line');
		await expect(note).toHaveText(/^(What week 1 is for|.+ this week.*)$/);
		await note.click();
		await expect(page.getByTestId('baseline-brief')).toContainText(
			'Log weight, reps and effort for every set'
		);

		// The plan, history and tools are behind More.
		await expect(page.getByTestId('open-more')).toBeVisible();
		await openMore(page);
		await expect(page.getByTestId('open-plates')).toBeVisible();
		await expect(page.getByTestId('open-history')).toBeVisible();

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
		await expect(position(page)).toHaveText('Week 2 of 5 · Accumulation');
		await expect(title(page)).toHaveText('Next week');
		await expect(next).toBeFocused();
		await expect(page.getByTestId('baseline-brief')).toHaveCount(0);
		await expect(lines(page)).toHaveAttribute('aria-label', 'Week 2');
		await expect(dayLines(page, addDays(seeded.weekStart, 7)).first()).toBeVisible();
		// Another week ends with the way back, in More's place.
		await expect(page.getByTestId('back-to-this-week')).toBeVisible();
		await expect(page.getByTestId('open-more')).toHaveCount(0);

		await press(next);
		await expect(position(page)).toHaveText('Week 3 of 5 · Accumulation');
		await expect(title(page)).toHaveText('Week 3');
		await expect(sessionLine(page, 'Intervals', addDays(seeded.weekStart, 16))).toBeVisible();

		await page.reload();
		await expect(page).toHaveURL(/\/train\?week=3$/);
		await expect(position(page)).toHaveText('Week 3 of 5 · Accumulation');

		// Next steps on to the plan's end, where its arrow is off; previous steps back.
		await press(page.getByTestId('next-week'));
		await expect(position(page)).toHaveText('Week 4 of 5 · Accumulation');
		await press(page.getByTestId('next-week'));
		await expect(position(page)).toHaveText('Week 5 of 5 · Accumulation');
		await expect(page.getByTestId('next-week')).toHaveCount(0); // the plan ends here
		await press(page.getByTestId('previous-week'));
		await expect(position(page)).toHaveText('Week 4 of 5 · Accumulation');
		await expect(page.getByTestId('previous-week')).toBeFocused();

		await page.getByTestId('back-to-this-week').click();
		await expect(page).toHaveURL(/\/train$/);
		await expect(title(page)).toHaveText('This week');
		// The link has gone with the week it ended: More, in its place, takes the focus.
		await expect(page.getByTestId('open-more')).toBeVisible();
		await expect(page.getByTestId('open-more')).toBeFocused();
	});

	test.describe('with the network in the test’s hands', () => {
		// page.route never sees a request from a page the service worker controls on WebKit, even
		// one the worker leaves to the network (__data.json), and the worker takes control of Train
		// during gotoHydrated (clients.claim). Chromium routes that request either way.
		test.use({ serviceWorkers: 'block' });

		test('while the next week loads, the week is busy and nothing moves', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, '/train');
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route('**/__data.json*', async (route) => {
				await held;
				await route.continue();
			});
			const boxes = () => Promise.all([title(page), lines(page)].map((l) => l.boundingBox()));
			const before = await boxes();

			await press(page.getByTestId('next-week'));
			await expect(weekRegion(page)).toHaveAttribute('aria-busy', 'true');
			await expect(page.getByRole('status').filter({ hasText: 'Loading the week' })).toHaveCount(1);
			await page.waitForTimeout(500); // past the dimming's delay
			expect(await boxes(), 'the title and the lines keep their place and size').toEqual(before);
			// The week dims (the arrows do not), and takes no input until it arrives.
			const week = weekRegion(page).locator('.week');
			await expect.poll(() => week.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.55');
			await expect(week).toHaveAttribute('inert', '');
			await captureScreen(page, testInfo, 'train-pending');

			release();
			await expect(weekRegion(page)).toHaveAttribute('aria-busy', 'false');
			await expect(position(page)).toHaveText('Week 2 of 5 · Accumulation');
			await expect(page.getByTestId('next-week')).toBeFocused();
		});

		// A week whose data request fails (500) is the (app) layout's error view, inside the shell:
		// SvelteKit renders a failed client navigation there. Train's own error state, for a server
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
			await expect(page).toHaveURL(/\/train\?week=2$/);
			await expect(error).toContainText('Something went wrong');
			await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

			await page.unrouteAll({ behavior: 'ignoreErrors' });
			await error.getByRole('button', { name: 'Try again' }).click();
			await expect(position(page)).toHaveText('Week 2 of 5 · Accumulation');
			await expect(page).toHaveURL(/\/train\?week=2$/);
		});

		test('?week past the plan is not planned yet; a malformed ?week is the current week', async ({
			page
		}) => {
			await gotoHydrated(page, '/train?week=99');
			await expect(position(page)).toHaveText('Week 99');
			await expect(page.getByTestId('train-not-planned')).toContainText('Not planned yet');
			await expect(page.getByTestId('train-not-planned')).toContainText(
				'Week 99 is past the end of your plan.'
			);
			await expect(lines(page)).toHaveCount(0);

			// Its one next step is the way back, drawn once; while this week loads, it keeps the
			// focus: only the week's lines go inert, never the state.
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route('**/__data.json*', async (route) => {
				await held;
				await route.continue();
			});
			const back = page.getByRole('link', { name: 'Back to this week' });
			await expect(back).toHaveCount(1);
			await expect(back).toHaveAttribute('data-testid', 'train-next');
			await press(back);
			await expect(weekRegion(page)).toHaveAttribute('aria-busy', 'true');
			await expect(back).toBeFocused();
			release();
			await expect(page).toHaveURL(/\/train$/);
			await expect(position(page)).toHaveText('Week 1 of 5 · Baseline week');

			await gotoHydrated(page, '/train?week=abc');
			await expect(position(page)).toHaveText('Week 1 of 5 · Baseline week');
			await expect(title(page)).toHaveText('This week');
			await expect(dayLines(page, seeded.today).first().locator('.day')).toHaveText('Today');
		});
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

	test.describe('on a desktop window', () => {
		test.use(DESKTOP);

		// Train is a readable screen (v2/07): the 560 px column, 200 px from the rail, the week's
		// lines in it and nothing scrolling sideways. train-desktop.serial.e2e.ts covers its states.
		test('the week sits in the readable column: 60 px lines, then More under a hairline', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, '/train');
			const readable = await tokenPx(page, '--content-readable');
			const parts = [
				page.getByTestId('program-header'),
				lines(page),
				page.getByTestId('open-more')
			];
			for (const width of DESKTOP_WIDTHS) {
				await page.setViewportSize({ width, height: 900 });
				await expectMainCentred(page);
				const main = (await page.locator('main#main').boundingBox())!;
				for (const part of parts) {
					const box = (await part.boundingBox())!;
					expect(box.x, `${part} at ${width}px`).toBeGreaterThanOrEqual(main.x - 1);
					expect(box.x + box.width, `${part} at ${width}px`).toBeLessThanOrEqual(
						main.x + main.width + 1
					);
				}
				await expectNoSideScroll(page);
			}
			await page.setViewportSize({ width: BELOW_DESKTOP_WIDTH, height: 900 });
			await expectNoSideScroll(page);
			await page.setViewportSize(DESKTOP.viewport);
			await expectMainCentred(page, readable);

			// Each line is 60 px tall; More is a 60 px row under the last, a hairline above it.
			const heights = await lines(page)
				.locator('[data-date]')
				.evaluateAll((all) => all.map((l) => Math.round(l.getBoundingClientRect().height)));
			expect(new Set(heights)).toEqual(new Set([60]));
			const more = page.getByTestId('open-more');
			const week = (await lines(page).boundingBox())!;
			const row = (await more.boundingBox())!;
			expect(row.y).toBeGreaterThanOrEqual(week.y + week.height - 1);
			expect(Math.round(row.height)).toBe(60);
			expect(await more.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('1px');

			// More opens its rows in place, in the column.
			await openMore(page);
			const tools = (await page.getByTestId('more-tools').boundingBox())!;
			expect(Math.abs(tools.x - week.x)).toBeLessThanOrEqual(1);
			expect(tools.y).toBeGreaterThanOrEqual(row.y + row.height - 1);
			await expectNoSideScroll(page);
			await captureScreen(page, testInfo, 'train-week-desktop');
		});
	});
});

test('a program that starts next Monday says so, and shows week 1 from its first day', async ({
	page,
	request
}) => {
	const seeded = await seedProgram(request, { fixture: 'hybrid', start: 'next_week' });
	await gotoHydrated(page, '/train');
	await expect(page.getByTestId('program-status')).toHaveText(
		`Starts ${longDate(seeded.weekStart)}`
	);
	await expect(title(page)).toHaveText('Next week');
	await expect(position(page)).toHaveText('Week 1 of 5 · Baseline week');
	await expect(dayLines(page, seeded.weekStart).first()).toBeVisible();
	await expect(
		lines(page)
			.locator('.day')
			.filter({ hasText: /^Today$/ })
	).toHaveCount(0);
	await expect(page.getByTestId('previous-week')).toHaveCount(0);
	// Week 1 is this week until it starts: More, not the way back.
	await expect(page.getByTestId('open-more')).toBeVisible();
});

test('once the planned weeks are over, the first block is complete: a summary, never a fake session, and the way to its review', async ({
	page,
	request
}, testInfo) => {
	const seeded = await seedProgram(request, { fixture: 'one-week', start: 'last_week' });
	await gotoHydrated(page, '/train');
	await expect(page.getByTestId('program-header')).toHaveCount(0);
	const done = page.getByTestId('train-block-complete');
	await expect(done.getByRole('heading', { name: 'Baseline week is done' })).toBeVisible();
	await expect(done).toContainText(
		`You trained through the whole week, ${dayMonth(seeded.weekStart)} to ${dayMonth(addDays(seeded.weekStart, 6))}.`
	);
	await expect(done).toContainText('I plan Accumulation from how it went.');
	await expect(page.getByTestId('session-card')).toHaveCount(0);
	await expect(lines(page)).toHaveCount(0);
	await captureScreen(page, testInfo, 'train-block-complete');
	expect(await audit(page)).toEqual([]);

	// Its next step is the block's cycle review: the reviews list creates it.
	await expect(page.getByTestId('train-next')).toHaveText('Review the block');
	await page.getByTestId('train-next').click();
	await expect(page).toHaveURL(/\/progress\/reviews$/);
});

test('with no program, Train says what comes first and links to it', async ({ page }, testInfo) => {
	await gotoHydrated(page, '/train');
	const empty = page.getByTestId('train-empty');
	await expect(empty.getByRole('heading', { name: 'No plan yet' })).toBeVisible();
	await expect(empty).toContainText('Finish setting up your profile, then I can plan week 1.');
	await expect(page.getByTestId('train-next')).toHaveText('Finish setup');
	await expect(page.getByTestId('train-next')).toHaveAttribute('href', '/profile');
	await expect(page.getByTestId('program-header')).toHaveCount(0);
	await openMore(page);
	await expect(page.getByTestId('open-plates')).toBeVisible();
	await expect(page.getByTestId('open-plan')).toHaveCount(0);
	await captureScreen(page, testInfo, 'train-empty');
});
