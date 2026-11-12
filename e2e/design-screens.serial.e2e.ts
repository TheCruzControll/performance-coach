/**
 * Today in Graphite 2004 (graphite.css, Screens; panels/WeekLegend.svelte through StatusSlot):
 * with a program, the week strip is one box with full day names and a legend under it naming each
 * discipline its dots show, its room held from the first paint so nothing moves when it arrives;
 * today's session and its Start workout share one box, and it passes axe in both themes. Today's
 * design shows no legend, nor its room, and keeps the session card on its own.
 * Serial: the program is the one owner's (e2e/program-support.ts), as in design-status.serial.
 */
import { expect, test, type Page } from '@playwright/test';
import { audit } from './a11y-suite';
import { PROGRAM_TZ, seedProgram } from './program-support';
import { gotoHydrated, query, resetTrainingProfile, trackConsoleErrors } from './support';

test.use({ timezoneId: PROGRAM_TZ });

const DESIGN_KEY = 'pc:design:v1';
/** The legend's words for each discipline colour (week-legend.ts). */
const LABEL: Record<string, string> = {
	strength: 'Strength',
	running: 'Running',
	combat: 'Muay Thai',
	hypertrophy: 'Hypertrophy',
	conditioning: 'Conditioning'
};

test.beforeEach(async ({ request }) => {
	await resetTrainingProfile();
	await seedProgram(request, { fixture: 'today', start: 'this_week' });
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

/** The disciplines the strip's dots show, in the legend's order, from their colours. */
const stripTones = (page: Page) =>
	page
		.getByTestId('week-strip')
		.locator('.dot')
		.evaluateAll((dots, order) => {
			const tones = new Set(
				dots.map((dot) => /--color-(\w+)/.exec((dot as HTMLElement).style.cssText)?.[1])
			);
			return order.filter((tone) => tones.has(tone));
		}, Object.keys(LABEL));

test('Graphite: the strip’s legend and the session box, with nothing moving', async ({ page }) => {
	const errors = trackConsoleErrors(page);
	await page.addInitScript((key) => localStorage.setItem(key, 'graphite'), DESIGN_KEY);
	await watchShifts(page);
	await gotoHydrated(page, '/today');
	await expect(page.locator('html')).toHaveAttribute('data-design', 'graphite');

	const strip = page.getByTestId('week-strip');
	for (const name of await strip.locator('.short').all()) await expect(name).toBeVisible();
	const legend = page.getByTestId('week-legend');
	await expect(legend).toBeVisible();
	const tones = await stripTones(page);
	expect(tones.length).toBeGreaterThan(0);
	const skipped = (await strip.locator('.dot.ring').count()) > 0 ? ['Skipped'] : [];
	await expect(legend.getByRole('listitem', { includeHidden: true })).toHaveText([
		...tones.map((tone) => LABEL[tone]!),
		...skipped
	]);
	// Under the strip, close to it, and above the day.
	const stripBox = (await strip.boundingBox())!;
	const legendBox = (await legend.boundingBox())!;
	expect(legendBox.y).toBeGreaterThanOrEqual(stripBox.y + stripBox.height);
	expect(legendBox.y - (stripBox.y + stripBox.height)).toBeLessThanOrEqual(12);
	const day = (await page.getByTestId('today-day').boundingBox())!;
	expect(legendBox.y + legendBox.height).toBeLessThanOrEqual(day.y);

	// Today's session: the card and its Start workout in one box.
	const session = page.getByTestId('today-session').first();
	const look = await session.evaluate((el) => {
		const card = el.querySelector<HTMLElement>('.card')!;
		return {
			box: getComputedStyle(el).borderTopWidth,
			card: getComputedStyle(card).borderTopWidth
		};
	});
	expect(look).toEqual({ box: '1px', card: '0px' });
	const start = (await session.locator('[data-ui="button"]').boundingBox())!;
	const box = (await session.boundingBox())!;
	expect(start.x).toBeGreaterThan(box.x);
	expect(start.x + start.width).toBeLessThan(box.x + box.width);
	expect(start.height).toBeGreaterThanOrEqual(44);

	await page.waitForFunction(() => document.fonts.status === 'loaded');
	expect(
		await page.evaluate(() => (window as unknown as { __shifts: number[] }).__shifts),
		'layout shifts no input explains'
	).toEqual([]);
	// axe in both themes, the legend and the session box on screen.
	const found = (await audit(page)).map((v) => `dark: ${v}`);
	await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
	await page.waitForTimeout(400);
	found.push(...(await audit(page)).map((v) => `light: ${v}`));
	expect(found).toEqual([]);
	expect(errors).toEqual([]);
});

test('today’s design: no legend and no room for it, the session card on its own', async ({
	page
}) => {
	await gotoHydrated(page, '/today');
	await expect(page.locator('html')).not.toHaveAttribute('data-design', /.*/);
	await expect(page.getByTestId('today-day').getByTestId('session-card')).toHaveCount(2);
	await expect(page.getByTestId('week-legend')).toHaveCount(0);
	await expect(page.locator('[data-ui="status-room"]')).toHaveCount(0);
	expect(
		await page
			.getByTestId('today-session')
			.first()
			.evaluate((el) => getComputedStyle(el).borderTopWidth)
	).toBe('0px');
});
