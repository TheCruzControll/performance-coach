/**
 * Program history (src/routes/(app)/train/history/[[version]]): every version newest first, 20 at
 * a time, with its date, who made it and each decision's why; any version opens as a read-only
 * week whose sessions open as they were then. Train's History action and a tapped version are
 * busy until the next page renders, as 'Show older versions' is while its page loads, whose
 * failure has an inline Retry. Only version 1 is 'no changes yet'. Not-found, failed-load and
 * offline states are designed.
 *
 * The program is seeded next week (PROGRAM_TZ), so every one of its days is ahead on any weekday,
 * and changed through the session screen's own move action. Serial: programs are the one owner's
 * (e2e/program-support.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { longDate } from '../src/lib/ui/program/words';
import { DESKTOP, expectMainCentred, expectNoSideScroll, tokenPx } from './desktop';
import { PROGRAM_TZ, seedProgram, type SeededProgram, type SeededSession } from './program-support';
import {
	captureScreen,
	gotoHydrated,
	resetTrainingProfile,
	SAME_ORIGIN,
	toastWith,
	trackConsoleErrors
} from './support';

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

/** axe on `path` in the dark and the light theme. */
async function auditThemes(page: Page, path: string) {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await gotoHydrated(page, path);
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(400); // entrance transitions settle: contrast on final colours
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) =>
			v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
		);
		expect(found, `axe, ${theme}`).toEqual([]);
	}
}

/** Move a session through the session screen's own action, as the Move sheet posts it. */
async function moveThroughAction(
	request: APIRequestContext,
	lineage: string,
	toDate: string,
	version: number,
	reason?: string
) {
	const response = await request.post(`/train/session/${lineage}?/move`, {
		headers: { ...SAME_ORIGIN, accept: 'application/json', 'x-sveltekit-action': 'true' },
		multipart: {
			payload: JSON.stringify({ sessionLineage: lineage, toDate, version, reason })
		}
	});
	expect(await response.json()).toMatchObject({ type: 'success' });
}

const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const versions = (page: Page) => page.getByTestId('version');
const versionLink = (page: Page, n: number) =>
	page.getByTestId('version-link').filter({ hasText: new RegExp(`^\\s*Version ${n}\\b`) });
const dayOf = (page: Page, date: string) =>
	page.getByTestId('week-strip').getByRole('radio', { name: new RegExp(`^${longDate(date)}\\b`) });
const cards = (page: Page) => page.getByTestId('session-card');

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

	test.beforeEach(async ({ request }) => {
		seeded = await seedProgram(request, { fixture: 'hybrid', start: 'next_week' });
	});

	test.describe('changed twice', () => {
		const wednesday = () => addDays(seeded.weekStart, 2);
		const friday = () => addDays(seeded.weekStart, 4);

		test.beforeEach(async ({ request }) => {
			const full = titled('Full body').lineage;
			await moveThroughAction(request, full, wednesday(), 1, 'Work trip on Monday');
			await moveThroughAction(request, full, friday(), 2);
		});

		test('History lists every version newest first, with its date, who made it and each why', async ({
			page
		}, testInfo) => {
			const errors = trackConsoleErrors(page);
			await watchShifts(page);
			await gotoHydrated(page, '/train/history');
			await expect(heading(page)).toHaveText('History');
			await expect(page.getByTestId('history-empty')).toHaveCount(0);

			await expect(versions(page)).toHaveCount(3);
			const links = page.getByTestId('version-link');
			await expect(links.nth(0)).toContainText(/Version 3\s*Current/);
			await expect(links.nth(0)).toContainText('Moved Full body from Wed to Fri');
			await expect(links.nth(0)).toContainText(/· You\s*$/);
			await expect(links.nth(1)).toContainText('Moved Full body from Mon to Wed');
			await expect(links.nth(1)).not.toContainText('Current');
			await expect(links.nth(2)).toContainText('Your first program');
			await expect(links.nth(2)).toContainText(/· Programming rules\s*$/);
			// Each 'when' is a date and a time, in the owner's zone (the integration tests pin it).
			await expect(links.nth(0)).toContainText(
				/\b[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2} · \d\d:\d\d · You/
			);

			const why = (n: number) => versions(page).nth(n).getByTestId('decision');
			await expect(why(0)).toHaveText(['You moved Full body from Wed to Fri. No reason given.']);
			await expect(why(1)).toHaveText([
				'You moved Full body from Mon to Wed. Work trip on Monday.'
			]);
			await expect(why(2)).toHaveCount(5);
			await expect(why(2).nth(2)).toContainText('Muay Thai stays on Tuesday and Thursday evenings');
			await expect(why(2).nth(2)).toContainText(
				'Your classes are fixed, so they were placed before anything else.'
			);
			await expect(page.getByTestId('show-older')).toHaveCount(0);
			await captureScreen(page, testInfo, 'train-history');

			expect(await shifts(page), 'layout shifts no input explains').toEqual([]);
			expect(errors).toEqual([]);
			await auditThemes(page, '/train/history');
		});

		test('version 1 opens read-only, with the session on its first day, and its sessions open as they were', async ({
			page
		}, testInfo) => {
			await watchShifts(page);
			const full = titled('Full body');
			await gotoHydrated(page, '/train/history');
			await versionLink(page, 1).click();
			await expect(heading(page)).toHaveText('Version 1');
			await expect(page).toHaveURL(/\/train\/history\/1$/);
			await expect(page.getByTestId('older-version')).toContainText('Older version · read-only');
			await expect(page.getByTestId('version-changes')).toContainText('Your first program');

			// Monday, as version 1 planned it, and no edit anywhere.
			await expect(dayOf(page, seeded.weekStart)).toHaveAttribute('aria-checked', 'true');
			const card = cards(page).filter({ hasText: 'Full body' });
			await expect(card).toHaveAttribute('href', `/train/session/${full.lineage}?v=1`);
			await expect(card).not.toContainText('Moved');
			await expect(page.getByRole('button', { name: /move|skip|swap/i })).toHaveCount(0);
			await captureScreen(page, testInfo, 'train-history-v1');
			expect(await shifts(page), 'layout shifts no input explains').toEqual([]);
			await auditThemes(page, '/train/history/1');

			await gotoHydrated(page, '/train/history/1');
			await cards(page).filter({ hasText: 'Full body' }).click();
			await expect(page.getByTestId('older-version')).toContainText('Version 1 of your plan');
			await expect(page.getByTestId('move-session')).toHaveCount(0);

			// The current version is as it was: Full body on Friday, moved, and Monday a rest day.
			await gotoHydrated(page, '/train');
			await dayOf(page, seeded.weekStart).click();
			await expect(page.getByTestId('rest-day')).toBeVisible();
			await dayOf(page, addDays(seeded.weekStart, 4)).click();
			await expect(cards(page).filter({ hasText: 'Full body' })).toContainText('Moved from Mon');
		});

		test('an edit opens on the day it changed; the current one says it is current', async ({
			page
		}) => {
			await gotoHydrated(page, '/train/history/3');
			await expect(page.getByTestId('current-version')).toContainText('Your current plan');
			await expect(page.getByTestId('older-version')).toHaveCount(0);
			await expect(dayOf(page, addDays(seeded.weekStart, 4))).toHaveAttribute(
				'aria-checked',
				'true'
			);
			const card = cards(page).filter({ hasText: 'Full body' });
			await expect(card).toContainText('Moved from Mon');
			await expect(card).toHaveAttribute('href', `/train/session/${titled('Full body').lineage}`);
		});

		test.describe('with the network in the test’s hands', () => {
			// page.route never sees a request from a page the service worker controls on WebKit.
			test.use({ serviceWorkers: 'block' });

			test('Train’s History action, then a tapped version, is busy until its page renders', async ({
				page
			}) => {
				await gotoHydrated(page, '/train');
				const action = page.getByTestId('open-history');
				let release = await hold(page, '**/train/history/__data.json*');
				await action.click();
				await expect(action).toHaveAttribute('aria-busy', 'true');
				release();
				await expect(heading(page)).toHaveText('History');
				await page.unrouteAll({ behavior: 'ignoreErrors' });

				release = await hold(page, '**/train/history/1/__data.json*');
				await versionLink(page, 1).click();
				await expect(versionLink(page, 1)).toHaveAttribute('aria-busy', 'true');
				await expect(versionLink(page, 2)).not.toHaveAttribute('aria-busy');
				release();
				await expect(heading(page)).toHaveText('Version 1');
				await page.unrouteAll({ behavior: 'ignoreErrors' });

				// Back to the list, which is no longer busy.
				await page.getByTestId('back-to-history').click();
				await expect(heading(page)).toHaveText('History');
				await expect(versionLink(page, 1)).not.toHaveAttribute('aria-busy');
			});

			// A failed client navigation is the (app) layout's error view, inside the shell. History's
			// own error, for a server read that fails, is the load's fail-soft payload
			// (tests/integration/training/history-load.test.ts).
			test('History whose data fails to load shows the designed error, whose Try again loads it', async ({
				page
			}) => {
				await gotoHydrated(page, '/train');
				await page.route('**/train/history/__data.json*', (route) =>
					route.fulfill({
						status: 500,
						contentType: 'application/json',
						body: JSON.stringify({ message: 'Something went wrong on our side.', requestId: 'e2e' })
					})
				);
				await page.getByTestId('open-history').click();
				const error = page.getByTestId('error-view');
				await expect(error).toContainText('Something went wrong');
				await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

				await page.unrouteAll({ behavior: 'ignoreErrors' });
				await error.getByRole('button', { name: 'Try again' }).click();
				await expect(heading(page)).toHaveText('History');
				await expect(versions(page)).toHaveCount(3);
			});
		});

		test.describe('offline', () => {
			test.use({ serviceWorkers: 'block' });

			test('opening History offline shows the designed offline state, never a 500', async ({
				page,
				context
			}) => {
				await gotoHydrated(page, '/train');
				await context.setOffline(true);
				await page.getByTestId('open-history').click();
				await expect(page.getByTestId('offline-state')).toBeVisible();
				await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
				await expect(page.locator('body')).not.toContainText(/internal error/i);
				await context.setOffline(false);
			});
		});

		test.describe('on a desktop window', () => {
			test.use(DESKTOP);

			// History is a split screen (data-layout="split"): up to --content-wide, centred beside
			// the rail. train-detail-desktop.serial.e2e.ts lays out its columns.
			test('History sits in the split column, with hover and focus states on each version', async ({
				page
			}, testInfo) => {
				await gotoHydrated(page, '/train/history');
				await expectMainCentred(page, await tokenPx(page, '--content-wide'));
				await expectNoSideScroll(page);

				const card = versions(page).first();
				const border = () => card.evaluate((el) => getComputedStyle(el).borderColor);
				const resting = await border();
				await versionLink(page, 3).hover();
				await expect.poll(border).not.toBe(resting);
				await page.mouse.move(720, 880);

				const link = versionLink(page, 3);
				for (
					let i = 0;
					i < 12 && !(await link.evaluate((a) => a === document.activeElement));
					i++
				) {
					await page.keyboard.press('Tab');
				}
				await expect(link).toBeFocused();
				expect(await link.evaluate((a) => a.matches(':focus-visible'))).toBe(true);
				expect(await link.evaluate((a) => getComputedStyle(a).outlineStyle)).toBe('solid');
				await captureScreen(page, testInfo, 'train-history-desktop');

				await gotoHydrated(page, '/train/history/1');
				await expectMainCentred(page, await tokenPx(page, '--content-wide'));
				await expectNoSideScroll(page);
				await captureScreen(page, testInfo, 'train-history-v1-desktop');
			});
		});
	});

	test('with only version 1 there are no changes yet', async ({ page }, testInfo) => {
		await gotoHydrated(page, '/train/history');
		await expect(page.getByTestId('history-empty')).toContainText('No changes yet');
		await expect(versions(page)).toHaveCount(1);
		await expect(versionLink(page, 1)).toContainText(/Version 1\s*Current/);
		await captureScreen(page, testInfo, 'train-history-empty');
		await auditThemes(page, '/train/history');
	});

	test('a move’s toast links to History, which lists the new version first', async ({ page }) => {
		await gotoHydrated(page, `/train/session/${titled('Full body').lineage}`);
		await page.getByTestId('move-session').click();
		const sheet = page.getByRole('dialog', { name: 'Move session' });
		await sheet.getByRole('radio').nth(1).check(); // Wednesday
		await sheet.getByTestId('edit-save').click();
		const toast = toastWith(page, 'Moved to Wednesday · version 2');
		await toast.getByRole('button', { name: 'History' }).click();
		await expect(heading(page)).toHaveText('History');
		await expect(versionLink(page, 2)).toContainText(/Version 2\s*Current/);
	});

	test('an unknown or malformed version is the 404 page, in the shell', async ({ page }) => {
		for (const path of ['/train/history/999', '/train/history/sample', '/train/history/0']) {
			const response = await page.goto(path);
			expect(response?.status(), path).toBe(404);
			await expect(page.getByTestId('error-view'), path).toHaveAttribute('data-kind', 'not-found');
			await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
		}
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

		/** 'Show older versions': the route's load for the next page, ?before=<cursor>. */
		const isOlder = (url: URL) =>
			url.pathname === '/train/history/__data.json' && url.searchParams.has('before');

		test('the first 20 are listed; Show older versions is busy while it loads, then lists v2 and v1', async ({
			page
		}) => {
			await gotoHydrated(page, '/train/history');
			await expect(versions(page)).toHaveCount(20);
			await expect(versionLink(page, 22)).toContainText('Current');
			await expect(versionLink(page, 2)).toHaveCount(0);

			const older = page.getByTestId('show-older');
			const release = await hold(page, isOlder);
			await older.click();
			await expect(older).toHaveAttribute('aria-busy', 'true');
			await expect(older).toBeDisabled();
			await expect(page.getByRole('status').filter({ hasText: 'Loading older' })).toHaveCount(1);
			release();
			await expect(versions(page)).toHaveCount(22);
			await expect(page.getByTestId('version-link').nth(20)).toContainText('Version 2');
			await expect(page.getByTestId('version-link').nth(21)).toContainText('Version 1');
			await expect(older).toHaveCount(0); // version 1 is listed: nothing older
			await expect(page.getByTestId('history-empty')).toHaveCount(0);
		});

		test('Show older versions that fails says so inline, and its Retry lists them', async ({
			page
		}) => {
			await gotoHydrated(page, '/train/history');
			// The load's own soft failure, once: a 200 whose page data is { state: 'error' }, as when
			// the database read fails (devalue's flattened form, in place of the real page node's).
			await page.route(
				isOlder,
				async (route) => {
					const response = await route.fetch();
					const body = (await response.json()) as { nodes: { data: unknown }[] };
					const node = body.nodes.at(-1)!;
					node.data = [{ state: 1 }, 'error'];
					await route.fulfill({ response, json: body });
				},
				{ times: 1 }
			);
			await page.getByTestId('show-older').click();
			const failed = page.getByTestId('older-failed');
			await expect(failed).toContainText('Couldn’t load older versions');
			await expect(versions(page)).toHaveCount(20);
			await expect(page.getByTestId('show-older')).toBeEnabled();

			await failed.getByRole('button', { name: 'Retry' }).click();
			await expect(versions(page)).toHaveCount(22);
			await expect(failed).toHaveCount(0);
		});
	});
});
