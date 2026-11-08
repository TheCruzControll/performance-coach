/**
 * Train in a desktop window (docs/design-system.md, Responsive layout → Screens): a wide screen.
 * The program header and the week strip span the content, the selected day's sessions sit in the
 * main column beside the week's brief and the tools, and every designed state keeps that frame:
 * a week loading, a failed load, offline, no program, a rest day, not started, beyond the plan,
 * the first block complete, and the plate calculator's and plan's chunks failing. The program
 * components adapt to their column with container queries (WeekStrip, SessionCard,
 * ProgramHeader). Serial: programs are the one owner's (e2e/program-support.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { longDate, shortDate } from '../src/lib/ui/program/words';
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
import { PROGRAM_TZ, seedProgram, type SeededProgram } from './program-support';
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

const strip = (page: Page) => page.getByTestId('week-strip');
const daySessions = (page: Page) => page.getByTestId('day-sessions');
const cards = (page: Page) => page.getByTestId('session-card');
const tools = (page: Page) => page.getByRole('region', { name: 'Tools' });
const header = (page: Page) => page.getByTestId('program-header');
const position = (page: Page) => page.getByTestId('program-position');
const weekRegion = (page: Page) => page.getByTestId('train-week');
const dayOf = (page: Page, date: string) =>
	strip(page).getByRole('radio', { name: new RegExp(`^${longDate(date)}\\b`) });

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

/** `main` lies wholly left of `side`, and their tops are level (±1 px). */
async function expectBeside(main: Locator, side: Locator) {
	const [left, right] = [await boxOf(main), await boxOf(side)];
	expect(left.x + left.width, `${main} ends before ${side} starts`).toBeLessThanOrEqual(right.x);
	expect(Math.abs(left.y - right.y), `${main} and ${side} start level`).toBeLessThanOrEqual(1);
}

/** The screen is wide (centred beside the rail at --content-wide) and nothing scrolls sideways. */
async function expectWideFrame(page: Page) {
	await expectMainCentred(page, await tokenPx(page, '--content-wide'));
	await expectNoSideScroll(page);
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

	test('the strip spans the content, the day’s sessions sit beside the brief and the tools', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await gotoHydrated(page, '/train');
		await expectWideFrame(page);
		const readable = await tokenPx(page, '--content-readable');

		// The header and the strip span the content: wider than any readable column.
		const top = await boxOf(header(page));
		const week = await boxOf(strip(page));
		expect(Math.abs(week.width - top.width), 'the strip spans the header’s width').toBeLessThan(1);
		expect(week.width, 'wider than a readable column').toBeGreaterThan(readable);
		await expect(dayOf(page, seeded.today)).toHaveAttribute('aria-current', 'date');
		await expect(dayOf(page, seeded.today)).toHaveAttribute('aria-checked', 'true');

		// Sessions in the main column (at most readable), the brief then the tools beside them.
		const brief = page.getByTestId('baseline-brief');
		await expectBeside(daySessions(page), brief);
		expect((await boxOf(daySessions(page))).width).toBeLessThanOrEqual(readable + 1);
		const [briefBox, toolsBox] = [await boxOf(brief), await boxOf(tools(page))];
		expect(Math.abs(briefBox.x - toolsBox.x), 'the tools share the brief’s column').toBeLessThan(1);
		expect(toolsBox.y, 'the tools come under the brief').toBeGreaterThan(
			briefBox.y + briefBox.height
		);

		// A tapped day updates the session column, which stays in place.
		const days = Array.from({ length: 7 }, (_, i) => addDays(seeded.weekStart, i));
		const column = await boxOf(daySessions(page));
		await dayOf(page, days[3]!).click();
		await expect(daySessions(page).getByRole('heading')).toHaveText(longDate(days[3]!));
		await expect(cards(page)).toHaveCount(2);
		const after = await boxOf(daySessions(page));
		expect([after.x, after.y, after.width]).toEqual([column.x, column.y, column.width]);

		// A session card has a hover state and a focus ring.
		const card = cards(page).first();
		const border = () => card.evaluate((el) => getComputedStyle(el).borderColor);
		const resting = await border();
		await card.hover();
		await expect.poll(border, { message: 'a hover state' }).not.toBe(resting);
		await page.mouse.move(5, 5);

		// Arrow keys move through the strip; Tab goes strip → sessions → the tools' column.
		await dayOf(page, days[3]!).focus();
		await page.keyboard.press('ArrowRight');
		await expect(dayOf(page, days[4]!)).toBeFocused();
		await expect(dayOf(page, days[4]!)).toHaveAttribute('aria-checked', 'true');
		await expect(page.getByTestId('rest-day')).toBeVisible();
		await page.keyboard.press('ArrowLeft');
		await expect(dayOf(page, days[3]!)).toBeFocused();
		await expect(cards(page)).toHaveCount(2);
		for (const target of [
			cards(page).nth(0),
			cards(page).nth(1),
			page.getByTestId('open-plates')
		]) {
			await page.keyboard.press('Tab');
			await expect(target).toBeFocused();
			expect(
				await target.evaluate((el) => getComputedStyle(el).outlineStyle),
				`${target} shows a focus ring`
			).not.toBe('none');
		}
		// Tools follow the whole brief, so only the columns are checked here, not level tops.
		const [lastCard, plates] = [
			await boxOf(cards(page).nth(1)),
			await boxOf(page.getByTestId('open-plates'))
		];
		expect(lastCard.x + lastCard.width, 'sessions sit left of the tools').toBeLessThanOrEqual(
			plates.x
		);

		for (const width of [...DESKTOP_WIDTHS, BELOW_DESKTOP_WIDTH]) {
			await page.setViewportSize({ width, height: 900 });
			await expectNoSideScroll(page);
		}
		await page.setViewportSize(DESKTOP.viewport);
		await auditBothThemes(page, testInfo, 'week');

		// The plan overview opens as a centred dialog.
		await page.getByTestId('open-plan').click();
		await expectCentredDialog(page, page.getByRole('dialog', { name: 'Your plan' }));
		await captureScreen(page, testInfo, 'train-desktop-plan');
		expect(errors).toEqual([]);
	});

	test('a rest day is designed in the session column', async ({ page }, testInfo) => {
		await gotoHydrated(page, '/train');
		await dayOf(page, addDays(seeded.weekStart, 4)).click();
		await expect(page.getByTestId('rest-day')).toContainText('Rest day');
		await expectBeside(daySessions(page), page.getByTestId('baseline-brief'));
		await expectWideFrame(page);
		await auditBothThemes(page, testInfo, 'rest-day');
	});

	test('?week past the plan is not planned yet, its card beside the tools', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, '/train?week=99');
		await expect(position(page)).toHaveText('Week 99 · Not planned yet');
		await expect(strip(page)).toHaveCount(0);
		await expectBeside(page.getByTestId('train-not-planned'), tools(page));
		await expectWideFrame(page);
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
			await dayOf(page, addDays(seeded.weekStart, 7)).click(); // Monday: a card to watch
			const boxes = [strip(page), daySessions(page)];

			for (const [step, landing] of [
				['next-week', 'Accumulation · Week 3 of 5'],
				['previous-week', 'Accumulation · Week 2 of 5']
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
			// An error is not a dashboard: it keeps the readable column.
			await expectMainCentred(page, await tokenPx(page, '--content-readable'));
			await expectNoSideScroll(page);
			await auditBothThemes(page, testInfo, 'error');

			await page.unrouteAll({ behavior: 'ignoreErrors' });
			await error.getByRole('button', { name: 'Try again' }).click();
			await expect(position(page)).toHaveText('Accumulation · Week 2 of 5');
			await expectWideFrame(page);
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

test('a program that starts next Monday says so, its week laid out in columns', async ({
	page,
	request
}, testInfo) => {
	const seeded = await seedProgram(request, { fixture: 'hybrid', start: 'next_week' });
	await gotoHydrated(page, '/train');
	await expect(page.getByTestId('program-status')).toHaveText(
		`Starts ${shortDate(seeded.weekStart)}`
	);
	await expect(strip(page).locator('[aria-current="date"]')).toHaveCount(0);
	await expectBeside(daySessions(page), page.getByTestId('baseline-brief'));
	await expectWideFrame(page);
	await auditBothThemes(page, testInfo, 'not-started');
});

test('the first block complete: its summary beside the tools', async ({
	page,
	request
}, testInfo) => {
	await seedProgram(request, { fixture: 'one-week', start: 'last_week' });
	await gotoHydrated(page, '/train');
	await expect(position(page)).toHaveText('First block complete');
	await expectBeside(page.getByTestId('train-block-complete'), tools(page));
	await expectWideFrame(page);
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

test('with no program, its card and the way to Today’s Build sit beside the tools', async ({
	page,
	request
}, testInfo) => {
	await completeProfile(request);
	await gotoHydrated(page, '/train');
	const empty = page.getByTestId('train-empty');
	await expect(empty.getByRole('heading', { name: 'No program yet' })).toBeVisible();
	await expect(page.getByTestId('train-next')).toHaveAttribute('href', '/today');
	await expect(page.getByTestId('train-next')).toContainText('Build my program');
	await expect(header(page)).toHaveCount(0);
	await expectBeside(empty, tools(page));
	await expectWideFrame(page);
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

	test('the plate calculator’s Retry notice sits in the tools’ column; Retry opens a centred dialog', async ({
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

		await page.getByTestId('open-plates').click();
		const notice = page
			.getByRole('alert')
			.filter({ hasText: 'Couldn’t open the plate calculator' });
		await expect(notice).toBeVisible();
		const [box, column] = [await boxOf(notice), await boxOf(tools(page))];
		expect(box.x).toBeGreaterThanOrEqual(column.x - 1);
		expect(box.x + box.width).toBeLessThanOrEqual(column.x + column.width + 1);
		await expectNoSideScroll(page);
		await auditBothThemes(page, testInfo, 'plates-retry');

		// Back online, Retry opens the sheet (in place, or by reloading with ?tool=plates).
		failing = false;
		await notice.getByRole('button', { name: 'Retry' }).click();
		await expectCentredDialog(page, page.getByRole('dialog', { name: 'Plate calculator' }));
	});

	test('the plan’s Retry notice sits under Plan in the header; Retry opens a centred dialog', async ({
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

		const plan = page.getByTestId('open-plan');
		await plan.click();
		const notice = page.getByRole('alert').filter({ hasText: 'Couldn’t open your plan' });
		await expect(notice).toBeVisible();
		const [box, opener, top] = [await boxOf(notice), await boxOf(plan), await boxOf(header(page))];
		expect(box.y, 'under Plan').toBeGreaterThanOrEqual(opener.y + opener.height - 1);
		expect(box.x + box.width, 'inside the header').toBeLessThanOrEqual(top.x + top.width + 1);
		await expectNoSideScroll(page);
		await auditBothThemes(page, testInfo, 'plan-retry');

		await page.unroute(chunk);
		await notice.getByRole('button', { name: 'Retry' }).click();
		await expectCentredDialog(page, page.getByRole('dialog', { name: 'Your plan' }));
	});
});
