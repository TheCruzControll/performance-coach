/**
 * A session's detail and History in a desktop window (docs/design-system.md, Responsive layout →
 * Screens). The session is wide: its side column (the edits, the details, the baseline callout)
 * sits left of its main column (the exercises, the run, a class's metrics), and each edit sheet
 * opens as a centred dialog. History is split: the list beside the version picked, which stays in
 * the URL. The program components adapt to their column with container queries (ExerciseBlock,
 * RunSegments, SessionDetails, BaselineCallout). Every designed state keeps its frame: not found,
 * a failed load, offline, an older version, a tapped card loading, 'no changes yet' and a failed
 * 'Show older versions'. Serial: programs are the one owner's (e2e/program-support.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { longDate, shortDate } from '../src/lib/ui/program/words';
import {
	BELOW_DESKTOP_WIDTH,
	DESKTOP,
	DESKTOP_WIDTHS,
	boxOf,
	expectInColumn,
	expectMainCentred,
	expectNoShift,
	expectNoSideScroll,
	layoutWidth,
	tokenPx
} from './desktop';
import { PROGRAM_TZ, seedProgram, type SeededProgram, type SeededSession } from './program-support';
import {
	captureScreen,
	gotoHydrated,
	resetTrainingProfile,
	SAME_ORIGIN,
	toastWith,
	trackConsoleErrors
} from './support';

test.use({ ...DESKTOP, timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

const THEMES = ['dark', 'light'] as const;
type Theme = (typeof THEMES)[number];

const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const side = (page: Page) => page.getByTestId('session-side');
const main = (page: Page) => page.getByTestId('session-main');
const edits = (page: Page) => page.getByRole('group', { name: 'Change this session' });
const cards = (page: Page) => page.getByTestId('session-card');
const exercise = (page: Page, name: string) =>
	page.getByTestId('exercise').filter({ has: page.getByRole('heading', { name, exact: true }) });
const list = (page: Page) => page.getByTestId('history-list');
const versions = (page: Page) => page.getByTestId('version');
const versionLink = (page: Page, n: number) =>
	page.getByTestId('version-link').filter({ hasText: new RegExp(`^\\s*Version ${n}\\b`) });
const dayOf = (page: Page, date: string) =>
	page.getByTestId('week-strip').getByRole('radio', { name: new RegExp(`^${longDate(date)}\\b`) });
const save = (dialog: Locator) => dialog.getByTestId('edit-save');

/**
 * axe (WCAG 2.1 A/AA) and a screenshot of the page as it stands, in each theme, switched in place
 * so a state that is hard to reach again (a failed load, offline, a held request) is checked in
 * both.
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
			`train-detail-desktop-${name}${theme === 'light' ? '-light' : ''}`
		);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** `left` lies wholly left of `right`, and their tops are level (±1 px). */
async function expectBeside(left: Locator, right: Locator) {
	const [a, b] = [await boxOf(left), await boxOf(right)];
	expect(a.x + a.width, `${left} ends before ${right} starts`).toBeLessThanOrEqual(b.x);
	expect(Math.abs(a.y - b.y), `${left} and ${right} start level`).toBeLessThanOrEqual(1);
}

/** `right` starts at or right of `left`'s right edge, and they overlap vertically. */
async function expectRightOf(right: Locator, left: Locator) {
	const [a, b] = [await boxOf(left), await boxOf(right)];
	expect(b.x, `${right} starts right of ${left}`).toBeGreaterThanOrEqual(a.x + a.width - 1);
	expect(b.y < a.y + a.height && a.y < b.y + b.height, `${right} and ${left} share a row`).toBe(
		true
	);
}

/** `below` starts under `above`'s bottom edge. */
async function expectBelow(below: Locator, above: Locator) {
	const [a, b] = [await boxOf(above), await boxOf(below)];
	expect(b.y, `${below} starts under ${above}`).toBeGreaterThanOrEqual(a.y + a.height - 1);
}

/**
 * The session's two columns: centred at --content-wide beside the rail, the side column (at
 * least --content-list) left of the main one (at most --content-readable), nothing sideways.
 */
async function expectSessionColumns(page: Page) {
	await expectMainCentred(page, await tokenPx(page, '--content-wide'));
	await expectBeside(side(page), main(page));
	expect((await boxOf(side(page))).width).toBeGreaterThanOrEqual(
		(await tokenPx(page, '--content-list')) - 1
	);
	expect((await boxOf(main(page))).width).toBeLessThanOrEqual(
		(await tokenPx(page, '--content-readable')) + 1
	);
	await expectNoSideScroll(page);
}

/** A readable screen (a 404, an error, offline): the readable column, centred beside the rail. */
async function expectReadable(page: Page) {
	await expectMainCentred(page, await tokenPx(page, '--content-readable'));
	await expectNoSideScroll(page);
}

/** The sheet's visible panel is centred in the window, at most 32rem wide, with no handle. */
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

/** Move a session through the session screen's own action, as the Move sheet posts it. */
async function moveThroughAction(
	request: APIRequestContext,
	lineage: string,
	toDate: string,
	version: number
) {
	const response = await request.post(`/train/session/${lineage}?/move`, {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: { payload: JSON.stringify({ sessionLineage: lineage, toDate, version }) }
	});
	expect(await response.json()).toMatchObject({ type: 'success' });
}

/** Hold every request `matches` names until `release` is called. */
async function hold(page: Page, matches: string | ((url: URL) => boolean)) {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route(matches, async (route) => {
		await held;
		await route.continue();
	});
	return release;
}

test.describe('a program that starts next week', () => {
	let seeded: SeededProgram;
	/** The `n`th session titled `title` in version 1 (week order). */
	const titled = (title: string, n = 0): SeededSession =>
		seeded.sessions.filter((s) => s.title === title)[n]!;
	const open = (session: SeededSession) => `/train/session/${session.lineage}`;

	test.beforeEach(async ({ request }) => {
		seeded = await seedProgram(request, { fixture: 'hybrid', start: 'next_week' });
	});

	test('a strength session: the edits, details and callout beside the exercises, nothing moving as it loads', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		// Server-rendered in its final layout: nothing moves while it hydrates and Swap's
		// alternatives stream in.
		await page.goto(open(titled('Full body')), { waitUntil: 'domcontentloaded' });
		await page.waitForFunction(() => document.fonts.status === 'loaded');
		await expectNoShift(page, {
			boxes: [side(page), main(page)],
			action: () => page.waitForLoadState('networkidle')
		});
		await expectSessionColumns(page);
		await expect(main(page).getByTestId('exercise')).toHaveCount(4);
		await expect(side(page).getByTestId('session-facts')).toBeVisible();
		await expect(side(page).getByTestId('baseline-callout')).toBeVisible();
		await expectInColumn(page, edits(page), side(page), [main(page)]);

		// WIDE_EXERCISE: in the main column the coach's words sit beside the sets.
		const squat = exercise(page, 'Back squat');
		const sets = squat.getByRole('list', { name: 'Back squat: sets' });
		const note = squat.locator('.note');
		await expectRightOf(note, sets);

		// WIDE_CALLOUT is the card's width, not the window's: in the side column its steps stay
		// under the why; in a tablet's readable column they sit beside it.
		const callout = page.getByTestId('baseline-callout');
		await expectBelow(callout.locator('ol'), callout.locator('p').first());

		// Hover and focus; Tab goes side column (Move, Skip) then main (each exercise's edits).
		const move = page.getByTestId('move-session');
		const background = () => move.evaluate((el) => getComputedStyle(el).backgroundColor);
		const resting = await background();
		await move.hover();
		await expect.poll(background, { message: 'a hover state' }).not.toBe(resting);
		await page.mouse.move(5, 5);
		await move.focus();
		for (const target of [
			page.getByTestId('skip-session'),
			page.getByRole('button', { name: 'Adjust Power clean', exact: true }),
			page.getByRole('button', { name: 'Swap Power clean', exact: true })
		]) {
			await page.keyboard.press('Tab');
			await expect(target).toBeFocused();
			expect(await target.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
			expect(await target.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
		}
		await auditBothThemes(page, testInfo, 'strength');

		for (const width of DESKTOP_WIDTHS) {
			await page.setViewportSize({ width, height: 900 });
			await expectSessionColumns(page);
		}
		// At 1024 px the main column is narrower than WIDE_EXERCISE: the note goes under the sets.
		await page.setViewportSize({ width: DESKTOP_WIDTHS[0], height: 900 });
		await expectBelow(note, sets);
		await page.setViewportSize({ width: BELOW_DESKTOP_WIDTH, height: 900 });
		await expectNoSideScroll(page);
		await expectRightOf(callout.locator('ol'), callout.locator('p').first());
		expect(errors).toEqual([]);
	});

	test('an interval run: its steps in the main column, each segment on one line', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, open(titled('Intervals')));
		await expectSessionColumns(page);
		await expect(main(page).getByTestId('run-step')).toHaveCount(3);
		await expectInColumn(page, edits(page), side(page), [main(page)]);

		// WIDE_RUN: the pace and effort at the end of the segment's line.
		const interval = main(page).getByTestId('run-step').nth(1).getByRole('listitem').first();
		await expectRightOf(interval.locator('.effort'), interval.locator('.headline'));
		await auditBothThemes(page, testInfo, 'run');
	});

	test('a Muay Thai class: its metrics take the main column, beside its edits', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, open(titled('Muay Thai class')));
		await expectSessionColumns(page);
		const details = main(page).getByTestId('session-facts');
		await expect(details.locator('.metric')).toHaveCount(4);
		await expectInColumn(page, edits(page), side(page), [main(page)]);
		// WIDE_DETAILS: the two stats stack beside the metrics.
		await expectRightOf(details.locator('dl'), details.getByRole('list').first());
		await auditBothThemes(page, testInfo, 'muay-thai');
	});

	test('each edit sheet opens as a centred dialog and saves a new version', async ({ page }) => {
		const full = titled('Full body');
		await gotoHydrated(page, open(full));

		const move = page.getByRole('dialog', { name: 'Move session' });
		await page.getByTestId('move-session').click();
		await expectCentredDialog(page, move);
		await move
			.getByRole('radio', { name: new RegExp(`^${shortDate(addDays(seeded.weekStart, 2))}\\b`) })
			.check();
		await save(move).click();
		await expect(toastWith(page, 'Moved to Wednesday · version 2')).toBeVisible();
		await expect(move).toBeHidden();

		const swap = page.getByRole('dialog', { name: 'Swap exercise' });
		await page.getByRole('button', { name: 'Swap Back squat', exact: true }).click();
		await expectCentredDialog(page, swap);
		await swap.getByRole('radio').first().check();
		await save(swap).click();
		await expect(toastWith(page, /this session only · version 3/)).toBeVisible();
		await expect(swap).toBeHidden();

		const adjust = page.getByRole('dialog', { name: 'Adjust' });
		await gotoHydrated(page, open(titled('Intervals')));
		await page.getByTestId('adjust-session').click();
		await expectCentredDialog(page, adjust);
		await adjust.getByRole('button', { name: 'Decrease Repeats' }).click();
		await save(adjust).click();
		await expect(toastWith(page, 'Adjusted Intervals · version 4')).toBeVisible();
		await expect(main(page).getByTestId('run')).toContainText('Repeat 5 times');

		const skip = page.getByRole('dialog', { name: 'Skip session' });
		await gotoHydrated(page, open(titled('Easy run')));
		await page.getByTestId('skip-session').click();
		await expectCentredDialog(page, skip);
		await save(skip).click();
		await expect(toastWith(page, 'Skipped Easy run · version 5')).toBeVisible();
		await expect(side(page).getByTestId('session-skipped')).toBeVisible();
		await expectSessionColumns(page);
	});

	test('an unknown session or version is the 404 page, centred in the readable column', async ({
		page
	}, testInfo) => {
		for (const [path, name] of [
			[`/train/session/${crypto.randomUUID()}`, 'session-404'],
			['/train/history/999', 'history-404']
		] as const) {
			const response = await page.goto(path);
			expect(response?.status(), path).toBe(404);
			await expect(page.getByTestId('error-view')).toHaveAttribute('data-kind', 'not-found');
			await expectReadable(page);
			await auditBothThemes(page, testInfo, name);
		}
	});

	test('?v=1 tops the main column with the older-version banner, linking to the current one', async ({
		page,
		request
	}, testInfo) => {
		const full = titled('Full body');
		await moveThroughAction(request, full.lineage, addDays(seeded.weekStart, 2), 1);
		await gotoHydrated(page, `${open(full)}?v=1`);
		const banner = page.getByTestId('older-version');
		await expect(banner).toContainText('Older version · read-only');
		const [bannerBox, column] = [await boxOf(banner), await boxOf(main(page))];
		expect(Math.abs(bannerBox.x - column.x), 'across the main column').toBeLessThanOrEqual(1);
		expect(Math.abs(bannerBox.width - column.width), 'its full width').toBeLessThanOrEqual(1);
		await expectBelow(main(page), banner);
		await expectBeside(side(page), banner);
		await expectNoSideScroll(page);
		await auditBothThemes(page, testInfo, 'older-version');

		await banner.getByTestId('current-version').click();
		await expect(page).toHaveURL(new RegExp(`${open(full)}$`));
		await expect(banner).toHaveCount(0);
		await expectSessionColumns(page);
	});

	test.describe('with the network in the test’s hands', () => {
		// page.route never sees a request from a page the service worker controls on WebKit.
		test.use({ serviceWorkers: 'block' });

		test.afterEach(async ({ page }) => {
			await page.unrouteAll({ behavior: 'ignoreErrors' });
		});

		test('a tapped card is busy while its session loads, on Train and in History’s week', async ({
			page,
			request
		}, testInfo) => {
			const full = titled('Full body');
			await gotoHydrated(page, '/train?week=2');
			await dayOf(page, addDays(seeded.weekStart, 10)).click();
			const easy = cards(page).filter({ hasText: 'Easy run' });
			let release = await hold(page, '**/train/session/*/__data.json*');
			await easy.click();
			await expect(easy).toHaveAttribute('aria-busy', 'true');
			await auditBothThemes(page, testInfo, 'train-pending');
			release();
			await expect(heading(page)).toHaveText('Easy run');
			await expectSessionColumns(page);
			await page.unrouteAll({ behavior: 'wait' });

			await moveThroughAction(request, full.lineage, addDays(seeded.weekStart, 2), 1);
			await gotoHydrated(page, '/train/history/1');
			const card = cards(page).filter({ hasText: 'Full body' });
			await expect(card).toHaveAttribute('href', `${open(full)}?v=1`);
			release = await hold(page, '**/train/session/*/__data.json*');
			await card.click();
			await expect(card).toHaveAttribute('aria-busy', 'true');
			await auditBothThemes(page, testInfo, 'history-pending');
			release();
			await expect(page.getByTestId('older-version')).toContainText('Version 1 of your plan');
			await expectSessionColumns(page);
		});

		test('a session whose data fails to load shows the designed error, whose Try again loads it', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, '/train');
			await page.route('**/train/session/*/__data.json*', (route) =>
				route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ message: 'Something went wrong on our side.', requestId: 'e2e' })
				})
			);
			await cards(page).first().click();
			const error = page.getByTestId('error-view');
			await expect(error).toContainText('Something went wrong');
			await expectReadable(page);
			await auditBothThemes(page, testInfo, 'session-error');

			await page.unrouteAll({ behavior: 'ignoreErrors' });
			await error.getByRole('button', { name: 'Try again' }).click();
			await expect(side(page)).toBeVisible();
			await expectSessionColumns(page);
		});
	});

	test.describe('offline', () => {
		test.use({ serviceWorkers: 'block' });

		test('opening a session offline shows the designed offline state, never a 500', async ({
			page,
			context
		}, testInfo) => {
			await gotoHydrated(page, '/train');
			await context.setOffline(true);
			await cards(page).first().click();
			await expect(page.getByTestId('offline-state')).toBeVisible();
			await expect(page.locator('body')).not.toContainText(/internal error/i);
			await expectReadable(page);
			await auditBothThemes(page, testInfo, 'offline');
			await context.setOffline(false);
		});
	});

	test.describe('History, changed twice', () => {
		test.beforeEach(async ({ request }) => {
			const full = titled('Full body').lineage;
			await moveThroughAction(request, full, addDays(seeded.weekStart, 2), 1);
			await moveThroughAction(request, full, addDays(seeded.weekStart, 4), 2);
		});

		test('the list sits beside the version picked, which stays in the URL', async ({
			page
		}, testInfo) => {
			const errors = trackConsoleErrors(page);
			await gotoHydrated(page, '/train/history');
			await expectMainCentred(page, await tokenPx(page, '--content-wide'));
			await expectBeside(list(page), page.getByTestId('history-pick'));
			expect((await boxOf(list(page))).width).toBeLessThanOrEqual(
				(await tokenPx(page, '--content-list')) + 1
			);
			const before = await boxOf(list(page));

			// Picking a row keeps the list where it was, the row marked as the page shown.
			for (const n of [2, 1]) {
				await versionLink(page, n).click();
				await expect(page).toHaveURL(new RegExp(`/train/history/${n}$`));
				await expect(heading(page)).toHaveText(`Version ${n}`);
				await expect(versionLink(page, n)).toHaveAttribute('aria-current', 'page');
				await expect(
					page.getByTestId('version-link').and(page.locator('[aria-current]'))
				).toHaveCount(1);
				const after = await boxOf(list(page));
				for (const key of ['x', 'y', 'width'] as const) {
					expect(Math.abs(after[key] - before[key]), `the list's ${key} stays`).toBeLessThanOrEqual(
						1
					);
				}
				await expectBeside(list(page), page.getByTestId('version-detail'));
			}
			await expect(page.getByTestId('older-version')).toBeVisible();

			// Back, forward and reload keep the version picked.
			await page.goBack();
			await expect(page).toHaveURL(/\/train\/history\/2$/);
			await expect(heading(page)).toHaveText('Version 2');
			await expect(versionLink(page, 2)).toHaveAttribute('aria-current', 'page');
			await page.goForward();
			await expect(heading(page)).toHaveText('Version 1');
			await page.reload();
			await page.waitForLoadState('networkidle');
			await expect(heading(page)).toHaveText('Version 1');
			await expect(versionLink(page, 1)).toHaveAttribute('aria-current', 'page');
			await expect(versions(page)).toHaveCount(3);

			// From the keyboard: Tab reaches the next version, with a focus ring, and Enter opens it.
			await versionLink(page, 3).focus();
			await page.keyboard.press('Tab');
			const link = versionLink(page, 2);
			await expect(link).toBeFocused();
			expect(await link.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
			expect(await link.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
			await page.keyboard.press('Enter');
			await expect(heading(page)).toHaveText('Version 2');
			await expectBeside(list(page), page.getByTestId('version-detail'));

			for (const width of [...DESKTOP_WIDTHS, BELOW_DESKTOP_WIDTH]) {
				await page.setViewportSize({ width, height: 900 });
				await expectNoSideScroll(page);
			}
			// Below 1024 px the version stands alone, as on a phone.
			await expect(list(page)).toBeHidden();
			await page.setViewportSize(DESKTOP.viewport);
			await auditBothThemes(page, testInfo, 'history');
			expect(errors).toEqual([]);
		});
	});

	test('with only version 1, ‘no changes yet’ sits beside the list', async ({ page }, testInfo) => {
		await gotoHydrated(page, '/train/history');
		const empty = page.getByTestId('history-empty');
		await expect(empty).toContainText('No changes yet');
		await expect(versions(page)).toHaveCount(1);
		await expect(page.getByTestId('history-pick')).toHaveCount(0);
		await expectBeside(list(page), empty);
		await expectMainCentred(page, await tokenPx(page, '--content-wide'));
		await expectNoSideScroll(page);
		await auditBothThemes(page, testInfo, 'history-empty');
	});

	test.describe('22 versions', () => {
		// page.route never sees a request from a page the service worker controls on WebKit.
		test.use({ serviceWorkers: 'block' });

		test.beforeEach(async ({ request }) => {
			const full = titled('Full body').lineage;
			for (let n = 1; n <= 21; n++) {
				await moveThroughAction(
					request,
					full,
					n % 2 ? addDays(seeded.weekStart, 2) : seeded.weekStart,
					n
				);
			}
		});

		test.afterEach(async ({ page }) => {
			await page.unrouteAll({ behavior: 'ignoreErrors' });
		});

		/** 'Show older versions': the route's load for the next page, ?before=<cursor>. */
		const isOlder = (url: URL) =>
			url.pathname === '/train/history/__data.json' && url.searchParams.has('before');

		test('older versions load in place, and picking one keeps them; a failure says so under the list', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, '/train/history/22');
			await expect(versions(page)).toHaveCount(20);
			const older = page.getByTestId('show-older');
			await expectBelow(older, versions(page).last());

			// The load's own soft failure, once: a 200 whose page data is { state: 'error' }, as
			// when the database read fails (devalue's flattened form, in place of the real node's).
			await page.route(
				isOlder,
				async (route) => {
					const response = await route.fetch();
					const body = (await response.json()) as { nodes: { data: unknown }[] };
					body.nodes.at(-1)!.data = [{ state: 1 }, 'error'];
					await route.fulfill({ response, json: body });
				},
				{ times: 1 }
			);
			await older.click();
			const failed = page.getByTestId('older-failed');
			await expect(failed).toContainText('Couldn’t load older versions');
			const [box, column] = [await boxOf(failed), await boxOf(list(page))];
			expect(box.x + box.width, 'inside the list’s column').toBeLessThanOrEqual(
				column.x + column.width + 1
			);
			await expectBelow(failed, older);
			await expectNoSideScroll(page);
			await auditBothThemes(page, testInfo, 'older-failed');

			await failed.getByRole('button', { name: 'Retry' }).click();
			await expect(versions(page)).toHaveCount(22);
			await expect(failed).toHaveCount(0);
			await expect(heading(page)).toHaveText('Version 22');

			// Version 1, from the page loaded in place: the list keeps every page.
			await versionLink(page, 1).click();
			await expect(heading(page)).toHaveText('Version 1');
			await expect(versions(page)).toHaveCount(22);
			await expect(versionLink(page, 1)).toHaveAttribute('aria-current', 'page');
			await page.goBack();
			await expect(heading(page)).toHaveText('Version 22');
			await expect(versions(page)).toHaveCount(22);
			await page.goForward();
			await expect(heading(page)).toHaveText('Version 1');
			await expect(versions(page)).toHaveCount(22);
		});
	});
});
