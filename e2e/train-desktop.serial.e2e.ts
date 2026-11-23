/**
 * Train in a desktop window (docs/design-system.md, Responsive layout → Screens): a readable
 * screen (Instrument v2, Paper 11 · Desktop). The week's top line, its title, one 60 px line per
 * session, the week's one line and More stand in the 560 px column, 200 px from the rail, and every
 * designed state keeps that frame at the column's top: a week loading, a failed load, offline, no
 * program, a rest day, not started, beyond the plan, the first block complete, and the plate
 * calculator's and plan's chunks failing (their notices under their rows in More). The picked
 * session's column at the right arrives with v2/08. Serial: programs are the one owner's
 * (e2e/program-support.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { longDate } from '../src/lib/ui/program/words';
import {
	BELOW_DESKTOP_WIDTH,
	DESKTOP,
	DESKTOP_WIDTHS,
	boxOf,
	expectMainCentred,
	expectNoShift,
	expectNoSideScroll,
	layoutWidth,
	tokenPx
} from './desktop';
import {
	dayLines,
	openMore,
	PROGRAM_TZ,
	seedProgram,
	sessionLine,
	type SeededProgram
} from './program-support';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	resetTrainingProfile,
	SAME_ORIGIN,
	trackConsoleErrors
} from './support';

test.use({ ...DESKTOP, timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

const THEMES = ['dark', 'light'] as const;
type Theme = (typeof THEMES)[number];

const lines = (page: Page) => page.getByTestId('week-lines');
const cards = (page: Page) => page.getByTestId('session-card');
const header = (page: Page) => page.getByTestId('program-header');
const position = (page: Page) => page.getByTestId('program-position');
const weekRegion = (page: Page) => page.getByTestId('train-week');
const more = (page: Page) => page.getByTestId('open-more');
const mainBox = (page: Page) => boxOf(page.locator('main#main'));

/** Change week from the keyboard (WebKit focuses no link on a click): the link keeps focus. */
async function press(link: Locator) {
	await link.focus();
	await link.press('Enter');
}

/**
 * axe (WCAG 2.1 A/AA) and a screenshot of the page as it stands, in each theme, switched in place
 * so a state that is hard to reach again (a failed load, offline) is checked in both.
 */
async function auditBothThemes(
	page: Page,
	testInfo: Parameters<typeof captureScreen>[1],
	name: string
) {
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	for (const theme of THEMES) {
		await page.evaluate((t: Theme) => {
			if (t === 'dark') delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = t;
		}, theme);
		await page.waitForTimeout(400); // colour transitions settle: contrast on final colours
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		expect(
			violations.flatMap((v) =>
				v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
			),
			`axe, ${name}, ${theme}`
		).toEqual([]);
		await captureScreen(
			page,
			testInfo,
			`train-desktop-${name}${theme === 'light' ? '-light' : ''}`
		);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/**
 * The screen is readable (--content-readable, centred beside the rail but at most 200 px from it
 * to the text, as expectMainCentred places every screen), nothing sits right of main, and nothing
 * scrolls sideways.
 */
async function expectReadableFrame(page: Page) {
	await expectMainCentred(page, await tokenPx(page, '--content-readable'));
	const main = await mainBox(page);
	const right = await page
		.locator('main#main')
		.evaluate((el) =>
			Math.max(...[...el.querySelectorAll('*')].map((n) => n.getBoundingClientRect().right))
		);
	expect(right, 'nothing right of main').toBeLessThanOrEqual(main.x + main.width + 1);
	await expectNoSideScroll(page);
}

/** Each of `parts` starts at the same left edge (±1 px). */
async function expectSameLeft(parts: Locator[]) {
	const xs = await Promise.all(parts.map(async (part) => (await boxOf(part)).x));
	for (const [i, x] of xs.entries())
		expect(Math.abs(x - xs[0]!), `${parts[i]} starts on the column's edge`).toBeLessThanOrEqual(1);
}

/** A state stands at the column's top on a desktop (on a phone at its foot), not further down. */
async function expectAtTop(page: Page, state: Locator) {
	const [main, box] = [await mainBox(page), await boxOf(state)];
	expect(box.y - main.y, `${state} at the column's top`).toBeLessThan(160);
}

/** The sheet's visible panel is centred in the window, at most 32rem wide. */
async function expectCentredDialog(page: Page, dialog: Locator) {
	await expect(dialog).toBeVisible();
	const panel = dialog.locator('.sheet');
	await expect
		.poll(() => panel.evaluate((el) => el.getAnimations().length), { message: 'opened' })
		.toBe(0);
	const box = await boxOf(panel);
	const off = box.x + box.width / 2 - (await layoutWidth(page)) / 2;
	expect(Math.abs(off), `the dialog is ${off.toFixed(1)}px off the window's centre`).toBeLessThan(
		1.5
	);
	expect(box.width, 'at most 32rem wide').toBeLessThanOrEqual(32 * 16 + 1);
	await expect(dialog.locator('.handle')).toBeHidden();
}

test.describe('a program this week', () => {
	let seeded: SeededProgram;
	test.beforeEach(async ({ request }) => {
		seeded = await seedProgram(request, { fixture: 'hybrid', start: 'this_week' });
	});

	test('the week is one readable column: lines, the note line and More', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await gotoHydrated(page, '/train');
		await expectReadableFrame(page);

		// One column: the top line, the lines, the week's one line and More share its left edge.
		await expectSameLeft([header(page), lines(page), page.getByTestId('week-line'), more(page)]);
		await expect(dayLines(page, seeded.today).first().locator('.day')).toHaveText('Today');
		await expect(lines(page).locator('[data-date]')).toHaveCount(8);

		// A session's line has a hover state and a focus ring.
		const line = cards(page).first();
		const colour = () => line.locator('.title').evaluate((el) => getComputedStyle(el).color);
		const resting = await colour();
		await line.hover();
		await expect.poll(colour, { message: 'a hover state' }).not.toBe(resting);
		await page.mouse.move(5, 5);

		// Tab goes from the arrows through each session's line, then the week's line and More.
		await page.getByTestId('next-week').focus();
		for (let n = 0; n < 5; n++) {
			await page.keyboard.press('Tab');
			await expect(cards(page).nth(n)).toBeFocused();
			expect(
				await cards(page)
					.nth(n)
					.evaluate((el) => getComputedStyle(el).outlineStyle),
				'a session line shows a focus ring'
			).not.toBe('none');
		}
		await page.keyboard.press('Tab');
		await expect(page.getByTestId('week-line')).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(more(page)).toBeFocused();

		for (const width of [...DESKTOP_WIDTHS, BELOW_DESKTOP_WIDTH]) {
			await page.setViewportSize({ width, height: 900 });
			await expectNoSideScroll(page);
		}
		await page.setViewportSize(DESKTOP.viewport);
		await auditBothThemes(page, testInfo, 'week');

		// More opens its rows in the column; the plan overview opens as a centred dialog.
		await openMore(page);
		await expectSameLeft([lines(page), page.getByTestId('more-tools')]);
		await page.getByTestId('open-plan').click();
		await expectCentredDialog(page, page.getByRole('dialog', { name: 'Your plan' }));
		await captureScreen(page, testInfo, 'train-desktop-plan');
		expect(errors).toEqual([]);
	});

	test('a rest day is a line of the week, in the column', async ({ page }, testInfo) => {
		await gotoHydrated(page, '/train');
		const rest = dayLines(page, addDays(seeded.weekStart, 4));
		await expect(rest).toHaveAttribute('data-testid', 'rest-day');
		await expect(rest).toHaveAttribute(
			'aria-label',
			`${longDate(addDays(seeded.weekStart, 4))}, rest`
		);
		await expectSameLeft([rest, sessionLine(page, 'Full body', seeded.weekStart)]);
		expect(Math.round((await boxOf(rest)).height)).toBe(60);
		await expectReadableFrame(page);
		await auditBothThemes(page, testInfo, 'rest-day');
	});

	test('?week past the plan is not planned yet: its statement at the column’s top', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, '/train?week=99');
		await expect(position(page)).toHaveText('Week 99');
		await expect(lines(page)).toHaveCount(0);
		const state = page.getByTestId('train-not-planned');
		await expectAtTop(page, state);
		// Its next step is the way back, under it; More is not drawn on another week.
		const next = page.getByTestId('train-next');
		await expect(next).toHaveText('Back to this week');
		expect((await boxOf(next)).y).toBeGreaterThanOrEqual((await boxOf(state)).y);
		await expect(more(page)).toHaveCount(0);
		await expectReadableFrame(page);
		await auditBothThemes(page, testInfo, 'not-planned');
	});

	test.describe('with the network in the test’s hands', () => {
		// page.route never sees a request from a page the service worker controls on WebKit.
		test.use({ serviceWorkers: 'block' });

		test.afterEach(async ({ page }) => {
			await page.unrouteAll({ behavior: 'ignoreErrors' });
		});

		/** Hold every __data.json until the returned release is called. */
		async function holdData(page: Page) {
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route('**/__data.json*', async (route) => {
				await held;
				await route.continue();
			});
			return release;
		}

		test('the next and the previous week load in place: busy, and nothing moves', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, '/train?week=2');
			const boxes = [page.getByTestId('week-title'), lines(page)];

			for (const [step, landing] of [
				['next-week', 'Week 3 of 5 · Accumulation'],
				['previous-week', 'Week 2 of 5 · Accumulation']
			] as const) {
				const release = await holdData(page);
				await expectNoShift(page, {
					boxes,
					action: async () => {
						await press(page.getByTestId(step));
						await expect(weekRegion(page)).toHaveAttribute('aria-busy', 'true');
						await page.waitForTimeout(500); // past the dimming's delay
					}
				});
				if (step === 'next-week') await captureScreen(page, testInfo, 'train-desktop-pending');
				release();
				await expect(weekRegion(page)).toHaveAttribute('aria-busy', 'false');
				await expect(position(page)).toHaveText(landing);
				await expect(page.getByTestId(step)).toBeFocused();
				await page.unrouteAll({ behavior: 'wait' });
			}
		});

		test('a week whose data fails to load shows the error view, whose Try again loads it', async ({
			page
		}, testInfo) => {
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
			await expect(error).toContainText('Something went wrong');
			// An error keeps the readable column, as Train itself does.
			await expectMainCentred(page, await tokenPx(page, '--content-readable'));
			await expectNoSideScroll(page);
			await auditBothThemes(page, testInfo, 'error');

			await page.unrouteAll({ behavior: 'ignoreErrors' });
			await error.getByRole('button', { name: 'Try again' }).click();
			await expect(position(page)).toHaveText('Week 2 of 5 · Accumulation');
			await expectReadableFrame(page);
		});
	});

	test.describe('offline', () => {
		test.use({ serviceWorkers: 'block' });

		test('changing week shows the designed offline state, never a 500', async ({
			page,
			context
		}, testInfo) => {
			await gotoHydrated(page, '/train');
			await context.setOffline(true);
			await press(page.getByTestId('next-week'));
			await expect(page.getByTestId('offline-state')).toBeVisible();
			await expect(page.locator('body')).not.toContainText(/internal error/i);
			await expectMainCentred(page, await tokenPx(page, '--content-readable'));
			await expectNoSideScroll(page);
			await auditBothThemes(page, testInfo, 'offline');
			await context.setOffline(false);
		});
	});
});

test('a program that starts next Monday says so, its week in the column', async ({
	page,
	request
}, testInfo) => {
	const seeded = await seedProgram(request, { fixture: 'hybrid', start: 'next_week' });
	await gotoHydrated(page, '/train');
	await expect(page.getByTestId('program-status')).toHaveText(
		`Starts ${longDate(seeded.weekStart)}`
	);
	await expect(
		lines(page)
			.locator('.day')
			.filter({ hasText: /^Today$/ })
	).toHaveCount(0);
	await expectSameLeft([header(page), lines(page), more(page)]);
	await expectReadableFrame(page);
	await auditBothThemes(page, testInfo, 'not-started');
});

test('the first block complete: its statement at the column’s top, More under it', async ({
	page,
	request
}, testInfo) => {
	await seedProgram(request, { fixture: 'one-week', start: 'last_week' });
	await gotoHydrated(page, '/train');
	await expect(header(page)).toHaveCount(0);
	const done = page.getByTestId('train-block-complete');
	await expectAtTop(page, done);
	await expect(done.getByTestId('train-next')).toHaveText('Review the block');
	expect((await boxOf(more(page))).y).toBeGreaterThanOrEqual(
		(await boxOf(done)).y + (await boxOf(done)).height - 1
	);
	await expectReadableFrame(page);
	await auditBothThemes(page, testInfo, 'block-complete');
});

/** The least a finished training profile needs (one goal and a schedule), then Finish. */
async function completeProfile(request: APIRequestContext) {
	const general = (title: string, disciplines: string[]) => ({
		kind: 'general',
		title,
		disciplines,
		focus: title,
		measure: 'Train every planned week'
	});
	await profileAction(request, '/profile/goals?/saveGoal', general('Stay strong', ['strength']));
	await profileAction(request, '/profile/schedule?/save', {
		daysPerWeek: 3,
		availableDays: [],
		preferredTimes: [],
		sessionMinutes: 60,
		commitments: []
	});
	const finish = await request.post('/onboarding/review?/complete', {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: '{}' }
	});
	expect(await finish.json()).toMatchObject({ type: 'redirect', location: '/today' });
}

test('with no program, its statement and the way to Today’s Build sit at the column’s top', async ({
	page,
	request
}, testInfo) => {
	await completeProfile(request);
	await gotoHydrated(page, '/train');
	const empty = page.getByTestId('train-empty');
	await expect(empty.getByRole('heading', { name: 'No plan yet' })).toBeVisible();
	await expect(empty).toContainText('Your profile is ready, so I can plan week 1.');
	const next = empty.getByTestId('train-next');
	await expect(next).toHaveAttribute('href', '/today');
	await expect(next).toHaveText('Build my program');
	await expect(header(page)).toHaveCount(0);
	await expectAtTop(page, empty);
	expect((await boxOf(more(page))).y).toBeGreaterThanOrEqual(
		(await boxOf(empty)).y + (await boxOf(empty)).height - 1
	);
	await expectReadableFrame(page);
	await auditBothThemes(page, testInfo, 'no-program');
});

test.describe('the lazy sheets’ chunks failing', () => {
	// page.route never sees a request the service worker answers, and it precaches every chunk.
	test.use({ serviceWorkers: 'block' });

	test.beforeEach(async ({ request }) => {
		await seedProgram(request, { fixture: 'hybrid', start: 'this_week' });
	});

	test.afterEach(async ({ page }) => {
		await page.unrouteAll({ behavior: 'ignoreErrors' });
	});

	/** The notice lies under `row`, inside More's list. */
	async function expectUnder(page: Page, notice: Locator, row: Locator) {
		const [box, opener, list] = [
			await boxOf(notice),
			await boxOf(row),
			await boxOf(page.getByTestId('more-tools'))
		];
		expect(box.y, `under ${row}`).toBeGreaterThanOrEqual(opener.y + opener.height - 1);
		expect(box.x).toBeGreaterThanOrEqual(list.x - 1);
		expect(box.x + box.width, 'inside More').toBeLessThanOrEqual(list.x + list.width + 1);
	}

	test('the plate calculator’s Retry notice sits under its row in More; Retry opens a centred dialog', async ({
		page
	}, testInfo) => {
		// Only the plate sheet's chunk carries this line (plate-calculator.e2e.ts).
		const SHEET_MARKUP = 'Per side, heaviest plate first.';
		let failing = false;
		await page.route('**/_app/immutable/**/*.js', async (route) => {
			const response = await route.fetch().catch(() => null);
			if (!response) return route.abort('internetdisconnected');
			const body = await response.text();
			if (failing && body.includes(SHEET_MARKUP)) return route.abort('internetdisconnected');
			await route.fulfill({ response, body });
		});
		await gotoHydrated(page, '/train');
		failing = true;

		await openMore(page);
		await page.getByTestId('open-plates').click();
		const notice = page
			.getByRole('alert')
			.filter({ hasText: 'Couldn’t open the plate calculator' });
		await expect(notice).toBeVisible();
		await expectUnder(page, notice, page.getByTestId('open-plates'));
		await expectNoSideScroll(page);
		await auditBothThemes(page, testInfo, 'plates-retry');

		// Back online, Retry opens the sheet (in place, or by reloading with ?tool=plates).
		failing = false;
		await notice.getByRole('button', { name: 'Try again' }).click();
		await expectCentredDialog(page, page.getByRole('dialog', { name: 'Plate calculator' }));
	});

	test('the plan’s Retry notice sits under its row in More; Retry opens a centred dialog', async ({
		page
	}, testInfo) => {
		const manifest = JSON.parse(
			readFileSync(
				path.resolve(import.meta.dirname, '../.svelte-kit/output/client/.vite/manifest.json'),
				'utf8'
			)
		) as Record<string, { file: string } | undefined>;
		const file = manifest['src/lib/ui/program/PlanOverviewSheet.svelte']?.file;
		expect(file, 'the plan sheet is in the build under test').toBeTruthy();
		const chunk = `**/${file}`;
		await page.route(chunk, (route) => route.abort('internetdisconnected'));
		await gotoHydrated(page, '/train');

		await openMore(page);
		const plan = page.getByTestId('open-plan');
		await plan.click();
		const notice = page.getByRole('alert').filter({ hasText: 'Couldn’t open your plan' });
		await expect(notice).toBeVisible();
		await expectUnder(page, notice, plan);
		await expectNoSideScroll(page);
		await auditBothThemes(page, testInfo, 'plan-retry');

		await page.unroute(chunk);
		await notice.getByRole('button', { name: 'Try again' }).click();
		await expectCentredDialog(page, page.getByRole('dialog', { name: 'Your plan' }));
	});
});
