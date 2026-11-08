/**
 * Today once a program exists (src/routes/(app)/today/panels/Program.svelte, plan.server.ts):
 * the week on a WeekStrip with today selected and today's sessions, each opening its detail, and
 * 'Up next' across weeks. The designed rest-day, starts-Monday, block-complete, skipped, failed
 * and offline states. M2's goals stay below; its static week shape and schedule step aside.
 * Serial: programs are the one owner's, which every browser and worker shares. Fixture programs
 * come from the test-only route at dates the server computes (e2e/program-support.ts), so these
 * hold on any weekday, Sunday included.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { longDate } from '../src/lib/ui/program/words';
import { DESKTOP, expectMainCentred, expectNoSideScroll, tokenPx } from './desktop';
import { PROGRAM_TZ, seedProgram, type ProgramStart, type SeededProgram } from './program-support';
import type { ProgramFixture } from '../src/lib/server/test-support/program-fixtures';
import {
	captureScreen,
	gotoHydrated,
	query,
	resetTrainingProfile,
	toastWith,
	trackConsoleErrors
} from './support';

test.use({ timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test.afterAll(async () => {
	await resetTrainingProfile();
});

/** A program stored by the fixture route, with onboarding complete so Today shows it. */
async function seed(
	request: APIRequestContext,
	fixture: ProgramFixture,
	start: ProgramStart
): Promise<SeededProgram> {
	const seeded = await seedProgram(request, { fixture, start });
	await query('update athlete_profiles set onboarding_completed_at = now()');
	return seeded;
}

/** The sessions after the server's today, in date order (plan order within a day). */
const after = (seeded: SeededProgram) =>
	seeded.sessions.filter((s) => s.date > seeded.today).sort((a, b) => a.date.localeCompare(b.date));

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
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	await page.waitForTimeout(400); // entrance transitions settle: contrast on final colours
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

/** Axe in the dark and light themes, Today reloaded in each. */
async function auditThemes(page: Page) {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await gotoHydrated(page, '/today');
		const html = page.locator('html');
		if (theme === 'light') await expect(html).toHaveAttribute('data-theme', 'light');
		else await expect(html).not.toHaveAttribute('data-theme', /.*/);
		expect(await audit(page), `axe, ${theme}`).toEqual([]);
	}
}

const plan = (page: Page) => page.getByTestId('today-plan');
const strip = (page: Page) => page.getByTestId('week-strip');
const cards = (page: Page) => page.getByTestId('today-day').getByTestId('session-card');
const upNext = (page: Page) => page.getByTestId('up-next-card');
const titles = (cards: ReturnType<typeof upNext>) =>
	cards.evaluateAll((all) => all.map((c) => c.querySelector('.title')!.textContent));
const todayTab = (page: Page) =>
	page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Today' });

test.describe('a program with sessions today', () => {
	let seeded: SeededProgram;
	test.beforeEach(async ({ request }) => {
		seeded = await seed(request, 'today', 'this_week');
	});

	test('Today lists today’s sessions, each opening its detail, and Up next in date order across weeks', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await watchShifts(page);
		await gotoHydrated(page, '/today');

		// The program's week replaces M2's week shape; the goals stay, the schedule steps aside.
		await expect(strip(page)).toHaveAttribute('aria-label', 'Week 1');
		const today = strip(page).getByRole('radio', {
			name: new RegExp(`^${longDate(seeded.today)}`)
		});
		await expect(today).toHaveAttribute('aria-current', 'date');
		await expect(today).toHaveAttribute('aria-checked', 'true');
		await expect(page.getByRole('list', { name: 'This week' })).toHaveCount(0);
		await expect(page.getByTestId('today-goals')).toBeVisible();
		await expect(page.getByTestId('today-schedule')).toHaveCount(0);

		await expect(page.getByTestId('today-day').getByRole('heading', { level: 2 })).toHaveText(
			longDate(seeded.today)
		);
		await expect(cards(page)).toHaveCount(2);
		expect(await titles(cards(page))).toEqual(['Full body', 'Muay Thai class']);
		await expect(cards(page).first()).toContainText('Baseline');
		// Nothing else is planned this week after today: Up next is next week's first three.
		expect(await titles(upNext(page))).toEqual(
			after(seeded)
				.slice(0, 3)
				.map((s) => s.title)
		);
		const target = (await cards(page).first().boundingBox())!;
		expect(target.height).toBeGreaterThanOrEqual(44);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'today-session');
		expect(await shifts(page), 'layout shifts no input explains').toEqual([]);

		const strength = seeded.sessions.find(
			(s) => s.date === seeded.today && s.title === 'Full body'
		)!;
		await cards(page).first().click();
		await expect(page).toHaveURL(`/train/session/${strength.lineage}`);
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('Full body');
		expect(errors).toEqual([]);

		await auditThemes(page);
	});

	test('skipping today’s session from its detail brings Today back with it Skipped, Up next unchanged', async ({
		page
	}) => {
		await gotoHydrated(page, '/today');
		const next = await titles(upNext(page));
		await cards(page).first().click();
		await page.getByTestId('skip-session').click();
		const sheet = page.getByRole('dialog', { name: 'Skip session' });
		await expect(sheet.getByLabel(/^Reason/)).toBeVisible();
		await sheet.getByTestId('edit-save').click();
		await expect(toastWith(page, 'Skipped Full body · version 2')).toBeVisible();

		await todayTab(page).click();
		await expect(page).toHaveURL('/today');
		await expect(cards(page).first()).toContainText('Skipped');
		await expect(cards(page).nth(1)).not.toContainText('Skipped');
		expect(await titles(upNext(page))).toEqual(next);
		const day = strip(page).getByRole('radio', { name: new RegExp(`^${longDate(seeded.today)}`) });
		await expect(day).toHaveAccessibleName(/1 skipped/);
	});

	test.describe('with the network in the test’s hands', () => {
		// page.route never sees a request from a page the service worker controls on WebKit.
		test.use({ serviceWorkers: 'block' });

		// A failed client navigation is the (app) layout's error view, inside the shell; the plan's
		// own designed error, for a server read that fails, is the streamed fail-soft payload
		// (tests/integration/training/today-load.test.ts).
		test('a client navigation whose data fails shows the designed error, whose Try again recovers', async ({
			page
		}) => {
			await gotoHydrated(page, '/train');
			await page.route('**/today/__data.json*', (route) =>
				route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ message: 'Something went wrong on our side.', requestId: 'e2e' })
				})
			);
			await todayTab(page).click();
			const error = page.getByTestId('error-view');
			await expect(error).toBeVisible();
			await expect(error).toContainText('Something went wrong');
			await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

			await page.unrouteAll({ behavior: 'ignoreErrors' });
			await error.getByRole('button', { name: 'Try again' }).click();
			await expect(cards(page)).toHaveCount(2);
			await expect(plan(page)).not.toHaveAttribute('aria-busy', 'true');
		});

		test('offline, going to Today shows the designed offline state, never a 500', async ({
			page,
			context
		}) => {
			await gotoHydrated(page, '/train');
			await context.setOffline(true);
			await todayTab(page).click();
			await expect(page.getByTestId('offline-state')).toBeVisible();
			await expect(page.locator('body')).not.toContainText(/internal error/i);
			await context.setOffline(false);
		});
	});

	test.describe('in a desktop window', () => {
		test.use(DESKTOP);

		test('the plan sits in the wide column, and a session card has hover and focus states', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, '/today');
			await expect(cards(page)).toHaveCount(2);
			await expectMainCentred(page, await tokenPx(page, '--content-wide'));
			await expectNoSideScroll(page);
			const main = (await page.locator('main#main').boundingBox())!;
			const box = (await plan(page).boundingBox())!;
			expect(box.x).toBeGreaterThanOrEqual(main.x - 1);
			expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 1);
			const card = cards(page).first();
			const border = () => card.evaluate((el) => getComputedStyle(el).borderColor);
			const resting = await border();
			await card.hover();
			await expect.poll(border).not.toBe(resting);
			await card.focus();
			await expect(card).toBeFocused();
			await captureScreen(page, testInfo, 'today-session-desktop');
		});
	});
});

test('a rest day says so and names the next session', async ({ page, request }, testInfo) => {
	const seeded = await seed(request, 'today-rest', 'this_week');
	await gotoHydrated(page, '/today');
	await expect(cards(page)).toHaveCount(0);
	const rest = page.getByTestId('today-rest');
	await expect(rest).toContainText('Rest day');
	const next = after(seeded)[0]!;
	await expect(rest).toContainText(`Next: ${next.title}`);
	await expect(upNext(page).first()).toContainText(next.title);
	await captureScreen(page, testInfo, 'today-rest');
	await auditThemes(page);
});

test('a program that starts next week says when, with week 1’s first session', async ({
	page,
	request
}, testInfo) => {
	const seeded = await seed(request, 'hybrid', 'next_week');
	const first = [...seeded.sessions].sort((a, b) => a.date.localeCompare(b.date))[0]!;
	await gotoHydrated(page, '/today');
	const starts = page.getByTestId('today-starts');
	await expect(starts.getByRole('heading', { level: 2 })).toHaveText('Starts Monday');
	await expect(starts).toContainText(`Week 1 begins ${longDate(seeded.weekStart)}`);
	await expect(starts).toContainText(`First up: ${first.title}`);
	// Week 1 is on the strip, from its first day, which shows its session.
	await expect(strip(page)).toHaveAttribute('aria-label', 'Week 1');
	await expect(page.getByTestId('today-day').getByRole('heading', { level: 2 })).toHaveText(
		longDate(first.date)
	);
	expect(await titles(cards(page))).toEqual([first.title]);
	await expect(upNext(page).first()).toContainText(first.title);
	await captureScreen(page, testInfo, 'today-starts');
	await auditThemes(page);
});

test('a finished first block shows ‘Nothing planned yet’, an empty Up next and the way to Train', async ({
	page,
	request
}, testInfo) => {
	await seed(request, 'one-week', 'last_week');
	await gotoHydrated(page, '/today');
	const complete = page.getByTestId('today-block-complete');
	await expect(complete.getByRole('heading')).toHaveText('Nothing planned yet');
	await expect(complete).toContainText('Your next block is planned from how this one went.');
	await expect(upNext(page)).toHaveCount(0);
	await expect(page.getByTestId('today-up-next-empty')).toBeVisible();
	await expect(strip(page)).toHaveCount(0);
	await captureScreen(page, testInfo, 'today-block-complete');
	await auditThemes(page);

	await page.getByTestId('today-train-link').click();
	await expect(page).toHaveURL('/train');
	await expect(page.getByTestId('train-block-complete')).toBeVisible();
});
