/**
 * Today's Status Display in Graphite 2004 (panels/TodayStatus.svelte through StatusSlot.svelte):
 * with a program and sessions today, the readout names the week, today's session and the week's
 * sessions done, under the week strip, its room held from the first paint so nothing moves when it
 * arrives, and axe-clean in both themes. Today's design shows none of it, not even the room.
 * A dated header elsewhere (a session's date, a version's date and author) stays as the subtitle.
 * Serial: the program is the one owner's (e2e/program-support.ts), as in today-plan.serial.e2e.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { PROGRAM_TZ, seedProgram, type SeededProgram } from './program-support';
import { gotoHydrated, query, resetTrainingProfile, trackConsoleErrors } from './support';

test.use({ timezoneId: PROGRAM_TZ });

const DESIGN_KEY = 'pc:design:v1';

let program: SeededProgram;

test.beforeEach(async ({ request }) => {
	await resetTrainingProfile();
	program = await seedProgram(request, { fixture: 'today', start: 'this_week' });
	await query('update athlete_profiles set onboarding_completed_at = now()');
});

test.afterAll(async () => {
	await resetTrainingProfile();
});

/** Records layout shifts no input explains, from the first paint. */
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

test('Graphite: Today’s readout names the week, today’s session and the week so far', async ({
	page
}) => {
	const errors = trackConsoleErrors(page);
	await page.addInitScript((key) => localStorage.setItem(key, 'graphite'), DESIGN_KEY);
	await watchShifts(page);
	await gotoHydrated(page, '/today');
	await expect(page.locator('html')).toHaveAttribute('data-design', 'graphite');

	const status = page.getByTestId('today-status');
	await expect(status).toBeVisible();
	await expect(status).toHaveAccessibleName('Today’s session');
	await expect(status.locator('.line').first()).toHaveText('Week 1');
	// Today's first session, with the second counted on its line.
	await expect(status.locator('.big')).toHaveText('Full body');
	await expect(status.locator('.line.dim')).toContainText('and 1 more');
	const bar = status.getByRole('progressbar', { name: 'Sessions done this week' });
	await expect(bar).toHaveAttribute('aria-valuenow', '0');
	await expect(bar).toHaveAttribute('aria-valuetext', /^0 of \d+ done$/);
	await expect(status).toContainText('Plan up to date');
	// Under the strip, above today's sessions.
	const strip = (await page.getByTestId('week-strip').boundingBox())!;
	const day = (await page.getByTestId('today-day').boundingBox())!;
	const box = (await status.boundingBox())!;
	expect(box.y).toBeGreaterThan(strip.y + strip.height - 1);
	expect(box.y + box.height).toBeLessThan(day.y + 1);
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	expect(await shifts(page), 'layout shifts no input explains').toEqual([]);
	expect(errors).toEqual([]);

	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await gotoHydrated(page, '/today');
		await expect(status).toBeVisible();
		await page.waitForFunction(() => document.fonts.status === 'loaded');
		await page.waitForTimeout(400); // entrance transitions settle: contrast on final colours
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		expect(
			violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`),
			theme
		).toEqual([]);
	}
});

test('today’s design: no readout and no room for one, the plan as it was', async ({ page }) => {
	await gotoHydrated(page, '/today');
	await expect(page.locator('html')).not.toHaveAttribute('data-design', /.*/);
	await expect(page.getByTestId('today-day').getByTestId('session-card')).toHaveCount(2);
	await expect(page.getByTestId('today-status')).toHaveCount(0);
	await expect(page.locator('[data-ui="status-room"]')).toHaveCount(0);
});

test('Graphite: a session’s date and a version’s date and author stay, as the subtitle', async ({
	page
}) => {
	await page.addInitScript((key) => localStorage.setItem(key, 'graphite'), DESIGN_KEY);
	for (const path of [
		`/train/session/${program.sessions[0]!.lineage}`,
		`/train/history/${program.version}`
	]) {
		await gotoHydrated(page, path);
		await expect(page.locator('html')).toHaveAttribute('data-design', 'graphite');
		const subtitle = page.locator('[data-ui="page-header"] .eyebrow');
		await expect(subtitle, path).toBeVisible();
		await expect(subtitle, path).toHaveAttribute('data-date', 'true');
		await expect(subtitle, path).not.toBeEmpty();
	}
});
