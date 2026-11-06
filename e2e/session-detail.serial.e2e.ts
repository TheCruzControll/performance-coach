/**
 * A planned session (src/routes/(app)/train/session/[key]): exactly what to do, server-rendered
 * and addressed by lineage. A week-1 strength session works up to its top sets and says what to
 * record; a run is its steps in the owner's unit; Muay Thai is its evening class, effort and
 * metrics. ?v=1 is an older version, read-only. The tapped card on Train is busy while the
 * session loads, and Back returns to the same week and day. Not-found, failed-load and offline
 * states are designed. Serial: programs are the one owner's (e2e/program-support.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { BASELINE_INSTRUCTION } from '../src/lib/domain/training/describe';
import { LOCAL_DATABASE_URLS } from '../src/lib/server/db/migrate';
import { createDatabase, createPool } from '../src/lib/server/db/client';
import { skipSession } from '../src/lib/server/services/programs/edits';
import { longDate } from '../src/lib/ui/program/words';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { PROGRAM_TZ, seedProgram, type SeededProgram, type SeededSession } from './program-support';
import {
	captureScreen,
	gotoHydrated,
	query,
	resetTrainingProfile,
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

/**
 * Version 2 of the seeded program, with `lineage` skipped, through the owner's skip edit as the
 * session screen's Skip (m3/45) will call it: no route makes a version yet.
 */
async function skipInVersion2(lineage: string, today: string) {
	const pool = createPool(process.env.E2E_DATABASE_URL || LOCAL_DATABASE_URLS.e2e, { max: 1 });
	try {
		const [owner] = await query<{ id: string }>('select id from owners');
		const at = { version: 1, today };
		await skipSession(owner!.id, { sessionLineage: lineage }, at, { db: createDatabase(pool) });
	} finally {
		await pool.end();
	}
}

const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const eyebrow = (page: Page) => page.locator('header.page-header .eyebrow');
const cards = (page: Page) => page.getByTestId('session-card');
const exercise = (page: Page, name: string) =>
	page.getByTestId('exercise').filter({ has: page.getByRole('heading', { name }) });
const sets = (page: Page, name: string) =>
	exercise(page, name)
		.getByRole('list', { name: `${name}: sets` })
		.getByRole('listitem');
const dayOf = (page: Page, date: string) =>
	page.getByTestId('week-strip').getByRole('radio', { name: new RegExp(`^${longDate(date)}\\b`) });

test.describe('a program that starts next week', () => {
	let seeded: SeededProgram;
	/** The `n`th session titled `title` in version 1 (week order). */
	const titled = (title: string, n = 0): SeededSession =>
		seeded.sessions.filter((s) => s.title === title)[n]!;
	const open = (session: SeededSession) => `/train/session/${session.lineage}`;

	test.beforeEach(async ({ request }) => {
		seeded = await seedProgram(request, { fixture: 'hybrid', start: 'next_week' });
	});

	test('a week-1 strength session works up to its top sets, with back-offs and what to record', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await watchShifts(page);
		const strength = titled('Full body');
		await gotoHydrated(page, open(strength));

		await expect(heading(page)).toHaveText('Full body');
		await expect(eyebrow(page)).toHaveText(`${longDate(strength.date)} · Morning`);
		await expect(page.getByTestId('session-facts').getByRole('listitem')).toHaveText([
			/^Duration\s*60\s*min\s*$/,
			/^Target RPE\s*7\s*Moderate\s*$/
		]);
		await expect(page.getByTestId('baseline-callout')).toContainText(BASELINE_INSTRUCTION);
		await expect(page.getByTestId('exercise').getByRole('heading')).toHaveText([
			'Power clean',
			'Back squat',
			'Bench press',
			'Barbell row'
		]);

		const squat = sets(page, 'Back squat');
		await expect(squat).toHaveCount(2);
		await expect(squat.nth(0)).toContainText('Work up to a set of 5 @ RPE 7');
		await expect(squat.nth(0)).toContainText(BASELINE_INSTRUCTION);
		await expect(squat.nth(0)).toContainText('Rest 3:00');
		await expect(squat.nth(1)).toContainText('2 × 5 @ RPE 7');
		await expect(squat.nth(1)).toContainText('72 % of your week-1 estimate · Rest 2:00');
		// A measured 1RM gives a load; an estimate not yet logged never does.
		await expect(squat.locator('.load')).toHaveCount(0);
		await expect(sets(page, 'Bench press').first()).toContainText('3 × 5 @ RPE 7');
		await expect(sets(page, 'Bench press').first().locator('.load')).toHaveText('70 kg');
		await expect(sets(page, 'Bench press').first()).toContainText('70 % of your measured 1RM');
		// Accessories: sets × reps @ RPE, rest and tempo.
		await expect(sets(page, 'Barbell row').first()).toContainText('3 × 8–10 @ RPE 7');
		await expect(sets(page, 'Barbell row').first()).toContainText('Rest 1:30 · Tempo 2010');
		await captureScreen(page, testInfo, 'session-strength');

		expect(await shifts(page), 'layout shifts no input explains').toEqual([]);
		expect(errors).toEqual([]);
		await auditThemes(page, open(strength));
	});

	test('a run is its warm-up, grouped repeats and cool-down, paced in the owner’s unit', async ({
		page
	}, testInfo) => {
		await watchShifts(page);
		await query(`update athlete_profiles set distance_unit = 'mi'`);
		const run = titled('Intervals');
		await gotoHydrated(page, open(run));

		await expect(heading(page)).toHaveText('Intervals');
		const steps = page.getByTestId('run-step');
		await expect(steps).toHaveCount(3);
		await expect(steps.nth(0)).toHaveText(/^\s*Warm-up 10:00\s*RPE 3\s*$/);
		await expect(steps.nth(1)).toContainText('Repeat 6 times');
		await expect(steps.nth(1).getByRole('listitem')).toHaveText([
			/^\s*Interval 400 m\s*6:02–6:26 \/mi\s*$/,
			/^\s*Recovery 1:30\s*RPE 2\s*$/
		]);
		await expect(steps.nth(2)).toHaveText(/^\s*Cool-down 10:00\s*HR zone 2\s*$/);
		await expect(page.getByTestId('baseline-callout')).toHaveCount(0);
		await captureScreen(page, testInfo, 'session-run');

		expect(await shifts(page), 'layout shifts no input explains').toEqual([]);
		await auditThemes(page, open(run));
	});

	test('the Muay Thai class is its evening, its duration, its target RPE and its metrics', async ({
		page
	}, testInfo) => {
		await watchShifts(page);
		const thai = titled('Muay Thai class');
		await gotoHydrated(page, open(thai));

		await expect(heading(page)).toHaveText('Muay Thai class');
		await expect(eyebrow(page)).toHaveText(`${longDate(thai.date)} · Evening`);
		await expect(page.getByTestId('session-detail')).toContainText('Muay Thai · Class');
		await expect(page.getByTestId('session-facts').getByRole('listitem')).toHaveText([
			/^Duration\s*90\s*min\s*$/,
			/^Target RPE\s*7\s*Hard\s*$/
		]);
		const metrics = page.getByTestId('session-facts').locator('.metric');
		await expect(metrics).toHaveText([
			/^Rounds\s*6$/,
			/^Round length\s*3 min$/,
			/^Sparring\s*No$/,
			/^Focus\s*Teeps and checks$/
		]);
		await expect(page.getByTestId('exercises')).toHaveCount(0);
		await captureScreen(page, testInfo, 'session-muay-thai');

		expect(await shifts(page), 'layout shifts no input explains').toEqual([]);
		await auditThemes(page, open(thai));
	});

	test('an unknown or malformed session or version is the 404 page, in the shell', async ({
		page
	}) => {
		const strength = open(titled('Full body'));
		for (const path of [
			`/train/session/${crypto.randomUUID()}`,
			'/train/session/sample',
			`${strength}?v=abc`,
			`${strength}?v=9`
		]) {
			const response = await page.goto(path);
			expect(response?.status(), path).toBe(404);
			await expect(page.getByTestId('error-view'), path).toHaveAttribute('data-kind', 'not-found');
			await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
		}
	});

	test('?v=1 is the older version, read-only, with the way to the current one', async ({
		page
	}) => {
		const strength = titled('Full body');
		await skipInVersion2(strength.lineage, seeded.today);

		await gotoHydrated(page, `${open(strength)}?v=1`);
		const banner = page.getByTestId('older-version');
		await expect(banner).toContainText('Older version · read-only');
		await expect(banner).toContainText('Version 1 of your plan');
		await expect(page.getByTestId('session-status')).toHaveCount(0); // planned, in version 1

		await banner.getByTestId('current-version').click();
		await expect(page).toHaveURL(new RegExp(`${open(strength)}$`));
		await expect(page.getByTestId('older-version')).toHaveCount(0);
		await expect(page.getByTestId('session-status')).toHaveText('Skipped');
	});

	test.describe('with the network in the test’s hands', () => {
		// page.route never sees a request from a page the service worker controls on WebKit, even
		// one the worker leaves to the network (__data.json), and the worker takes control of Train
		// during gotoHydrated (clients.claim). Chromium routes that request either way.
		test.use({ serviceWorkers: 'block' });

		test('the tapped card is busy until its session renders; Back returns to the same week and day', async ({
			page
		}) => {
			await gotoHydrated(page, '/train?week=2');
			const thursday = addDays(seeded.weekStart, 10);
			await dayOf(page, thursday).click();
			const easy = cards(page).filter({ hasText: 'Easy run' });
			const thai = cards(page).filter({ hasText: 'Muay Thai class' });
			await expect(easy).toHaveAttribute('href', open(titled('Easy run', 1)));

			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route('**/train/session/*/__data.json*', async (route) => {
				await held;
				await route.continue();
			});
			await easy.click();
			await expect(easy).toHaveAttribute('aria-busy', 'true');
			await expect(thai).not.toHaveAttribute('aria-busy');
			release();
			await expect(heading(page)).toHaveText('Easy run');
			await expect(page).toHaveURL(new RegExp(`${open(titled('Easy run', 1))}$`));
			await page.unrouteAll({ behavior: 'ignoreErrors' });

			// The browser's Back (an iPhone's swipe): the week and the day the owner picked.
			await page.goBack();
			await expect(page).toHaveURL(/\/train\?week=2$/);
			await expect(dayOf(page, thursday)).toHaveAttribute('aria-checked', 'true');

			// The screen's own Back does the same.
			await easy.click();
			await expect(heading(page)).toHaveText('Easy run');
			await page.getByTestId('back-to-train').click();
			await expect(page).toHaveURL(/\/train\?week=2$/);
			await expect(dayOf(page, thursday)).toHaveAttribute('aria-checked', 'true');
			await expect(easy).not.toHaveAttribute('aria-busy');
		});

		// A session whose data request fails (500) is the (app) layout's error view, inside the shell,
		// as SvelteKit renders a failed client navigation. The screen's own error, for a server read
		// that fails, is the load's fail-soft payload (tests/integration/training/session-load.test.ts).
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
			await expect(error).toBeVisible();
			await expect(error).toContainText('Something went wrong');
			await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
			await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
			await captureScreen(page, testInfo, 'session-error');

			await page.unrouteAll({ behavior: 'ignoreErrors' });
			await error.getByRole('button', { name: 'Try again' }).click();
			await expect(heading(page)).toHaveText('Full body');
		});
	});

	test.describe('offline', () => {
		// The page's own requests, which every engine can take offline (WebKit cannot take a
		// service worker's); offline.e2e.ts covers the shell under the service worker on Chromium.
		test.use({ serviceWorkers: 'block' });

		test('opening a session offline shows the designed offline state, never a 500', async ({
			page,
			context
		}) => {
			await gotoHydrated(page, '/train');
			await context.setOffline(true);
			await cards(page).first().click();
			await expect(page.getByTestId('offline-state')).toBeVisible();
			await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
			await expect(page.locator('body')).not.toContainText(/internal error/i);
			await context.setOffline(false);
		});
	});

	test.describe('on a desktop window', () => {
		test.use(DESKTOP);

		test('the session sits centred at a readable width, with hover and focus states', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, open(titled('Full body')));
			// The readable column, centred in the space beside the rail.
			const main = (await page.locator('main#main').boundingBox())!;
			const rail = (await page.getByRole('navigation', { name: 'Primary' }).boundingBox())!;
			expect(main.width).toBeLessThanOrEqual(40 * 16);
			const width = await page.evaluate(
				() => document.documentElement.getBoundingClientRect().width
			);
			const [left, right] = [main.x - (rail.x + rail.width), width - (main.x + main.width)];
			expect(Math.abs(left - right), `gaps beside main: ${left} and ${right}`).toBeLessThanOrEqual(
				1
			);
			await expectNoSideScroll(page);

			// Back has a hover state for the mouse, and a focus ring from the keyboard, where Tab
			// reaches it first after the rail.
			const back = page.getByTestId('back-to-train');
			const colour = () => back.evaluate((a) => getComputedStyle(a).color);
			const resting = await colour();
			await back.hover();
			await expect.poll(colour).not.toBe(resting);
			await page.mouse.move(720, 880);
			for (let i = 0; i < 10 && !(await back.evaluate((a) => a === document.activeElement)); i++) {
				await page.keyboard.press('Tab');
			}
			await expect(back).toBeFocused();
			expect(await back.evaluate((a) => a.matches(':focus-visible'))).toBe(true);
			expect(await back.evaluate((a) => getComputedStyle(a).outlineStyle)).not.toBe('none');
			await captureScreen(page, testInfo, 'session-strength-desktop');
		});
	});
});
