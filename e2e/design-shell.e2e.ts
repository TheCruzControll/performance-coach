/**
 * Graphite 2004's shell and Status Display at the iPhone size (graphite.css: the `nav`,
 * `page-header`, `rest` and `status` hooks): the glossy tab bar with the current tab in the
 * selection well and its glyph filled, at the bar's height today's design has; the large title with
 * Today's date as its subtitle and no other eyebrow; the rest timer as the Status Display; and the
 * run view's pace in a Status Display that today's design never shows. Today's design keeps every
 * one of these as it was. The desktop window is design-shell.desktop.e2e.ts; Today's display needs
 * a program (design-status.serial.e2e.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import type { RunKit } from '../src/lib/domain/workout';
import { openWorkoutPanel } from './design-workout';
import { expectNoSideScroll, tokenPx } from './desktop';
import { gotoHydrated, trackConsoleErrors } from './support';
import { gotoWorkout, seedWorkout, workoutDay } from './workout-support';

const DESIGN_KEY = 'pc:design:v1';
type Design = 'current' | 'graphite';

/** Chooses the design before any page loads, as Profile → Appearance → Design saves it. */
const choose = (page: Page, design: Design) =>
	page.addInitScript(([key, d]) => localStorage.setItem(key!, d!), [DESIGN_KEY, design]);

const nav = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const style = (page: Page, selector: string, property: string) =>
	page
		.locator(selector)
		.first()
		.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

async function settle(page: Page, design: Design) {
	const html = page.locator('html');
	if (design === 'graphite') await expect(html).toHaveAttribute('data-design', 'graphite');
	else await expect(html).not.toHaveAttribute('data-design', /.*/);
	await page.waitForFunction(() => document.fonts.status === 'loaded');
}

test.describe('the tab bar', () => {
	for (const design of ['current', 'graphite'] as const) {
		test(`${design}: the current tab, the bar's height and 44 px tabs`, async ({ page }) => {
			const errors = trackConsoleErrors(page);
			await choose(page, design);
			await gotoHydrated(page, '/today');
			await settle(page, design);
			expect(page.viewportSize()!.width).toBeLessThan(1024);

			const bar = nav(page);
			const current = bar.getByRole('link', { name: 'Today' });
			await expect(current).toHaveAttribute('aria-current', 'page');
			const barImage = await style(page, '[data-ui="nav"]', 'background-image');
			const wellImage = await current.evaluate((a) => getComputedStyle(a).backgroundImage);
			const glyphFill = await current
				.locator('svg')
				.evaluate((svg) => getComputedStyle(svg).fillOpacity);
			if (design === 'graphite') {
				// The bar material and the selection well are gradients; the current glyph fills in.
				expect(barImage).toContain('linear-gradient');
				expect(wellImage).toContain('linear-gradient');
				expect(glyphFill).toBe('0.22');
				const other = bar.getByRole('link', { name: 'Train' });
				expect(await other.evaluate((a) => getComputedStyle(a).backgroundImage)).toBe('none');
			} else {
				expect(barImage).toBe('none');
				expect(wellImage).toBe('none');
				expect(glyphFill).toBe('1');
			}

			// The bar is as tall in both designs (--nav-height), so the content clears it the same.
			const box = (await bar.boundingBox())!;
			// --nav-height, and the 1 px edge above it in both.
			expect(box.height).toBeCloseTo((await tokenPx(page, '--nav-height')) + 1, 0);
			expect(Math.round(box.y + box.height)).toBe(page.viewportSize()!.height);
			for (const tab of await bar.getByRole('link').all()) {
				const target = (await tab.boundingBox())!;
				expect(target.height, (await tab.textContent()) ?? '').toBeGreaterThanOrEqual(44);
				expect(target.width, (await tab.textContent()) ?? '').toBeGreaterThanOrEqual(44);
			}
			await expectNoSideScroll(page);
			expect(errors).toEqual([]);
		});
	}
});

test.describe('the page header', () => {
	for (const design of ['current', 'graphite'] as const) {
		test(`${design}: where the date and the other eyebrows go`, async ({ page }) => {
			await choose(page, design);
			await gotoHydrated(page, '/today');
			await settle(page, design);
			const header = page.locator('[data-ui="page-header"]');
			const title = header.getByRole('heading', { level: 1, name: 'Today' });
			const date = header.locator('.eyebrow');
			// The date renders once the page knows the device's time zone.
			await expect(date).toHaveText(/^\w+day \d{1,2} \w+$/);
			const above = (await date.boundingBox())!.y < (await title.boundingBox())!.y;
			// Today's design: the eyebrow above the title. Graphite: the date is the subtitle under it.
			expect(above).toBe(design === 'current');
			if (design === 'graphite') {
				expect(await date.evaluate((p) => getComputedStyle(p).textTransform)).toBe('none');
				expect(await title.evaluate((h) => getComputedStyle(h).fontSize)).toBe('34px');
			}

			await gotoHydrated(page, '/train');
			const eyebrow = page.locator('[data-ui="page-header"] .eyebrow');
			await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
			if (design === 'graphite') await expect(eyebrow).toBeHidden();
			else await expect(eyebrow).toHaveText('Program');
		});
	}
});

test.describe('the rest timer', () => {
	for (const design of ['current', 'graphite'] as const) {
		test(`${design}: the time left as the big numeral, its controls 44 px`, async ({ page }) => {
			await choose(page, design);
			const panel = await openWorkoutPanel(page);
			await settle(page, design);
			const timer = panel.getByTestId('rest-running').getByTestId('rest-timer');
			await timer.scrollIntoViewIfNeeded();
			const look = await timer.evaluate((el) => ({
				image: getComputedStyle(el).backgroundImage,
				align: getComputedStyle(el).textAlign
			}));
			const time = timer.getByTestId('rest-time');
			await expect(time).toHaveAttribute('role', 'timer');
			if (design === 'graphite') {
				// The readout's backlit glass, the numeral centred and large.
				expect(look.image).toContain('linear-gradient');
				expect(look.align).toBe('center');
				expect(await time.evaluate((t) => getComputedStyle(t).fontSize)).toBe('44px');
				const strip = timer.locator('.controls');
				expect((await strip.boundingBox())!.y).toBeGreaterThan((await time.boundingBox())!.y);
			} else {
				expect(look.image).toBe('none');
			}
			for (const control of await timer.getByRole('button').all()) {
				const box = (await control.boundingBox())!;
				expect(box.height, (await control.innerText()) || 'a rest control').toBeGreaterThanOrEqual(
					44
				);
			}
		});
	}
});

test.describe('the run view’s Status Display', () => {
	// gotoWorkout holds the sync with page.route, which never sees a service worker's requests.
	test.use({ serviceWorkers: 'block' });

	let kit: RunKit;
	test.beforeAll(async () => {
		const { run } = await workoutDay();
		kit = { ...run, plannedLineage: null, plannedSessionId: null, programId: null };
	});

	for (const design of ['current', 'graphite'] as const) {
		test(`${design}: the run’s pace on the readout, only in Graphite`, async ({ page }) => {
			await choose(page, design);
			await seedWorkout(page, kit);
			await gotoWorkout(page, 'run');
			await expect(page.getByTestId('run-entry')).toBeVisible();
			await settle(page, design);
			const status = page.getByTestId('run-status');
			if (design === 'current') {
				// Nothing of it, not even its room: the entry leads, as it always has.
				await expect(page.getByTestId('run-totals')).toBeVisible();
				await expect(status).toHaveCount(0);
				await expect(page.locator('[data-ui="status-room"]')).toHaveCount(0);
				return;
			}
			await expect(status).toBeVisible();
			await expect(status).toHaveAccessibleName('Run status');
			await expect(status.locator('.line').first()).toHaveText(/^Segment 1 of \d+ · /);
			// No pace before a segment gives one: a dash, never an invented number.
			await expect(status.locator('.big')).toHaveText('—');
			await expect(status.getByRole('progressbar', { name: 'Segments logged' })).toHaveAttribute(
				'aria-valuenow',
				'0'
			);
			// First on a phone: above the entry.
			const entry = (await page.getByTestId('run-entry').boundingBox())!;
			expect((await status.boundingBox())!.y).toBeLessThan(entry.y);
			await expectNoSideScroll(page);
		});
	}
});
