/**
 * Graphite 2004's screens at the iPhone size (graphite.css, Screens): the workout's RPE grid as
 * connected plastic keys with the answer in the well, the set states as rows with Now in the Aqua
 * wash, and Complete set on the bar material; the week strip with full day names and the chosen
 * date in the well; estimates as a dashed line and measured values as labelled squares; the
 * proposal under a silver strip; Progress's view tabs and period control as one kind of segmented
 * control; Profile's preferences as rows of one box; and the Coach composer docked on the tab bar.
 * Today's design keeps every one of them as it was, and each Graphite screen passes axe in both
 * themes. Today's legend and session box need a program (design-screens.serial.e2e.ts); the
 * desktop window is design-screens.desktop.e2e.ts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { audit, SCREENS } from './a11y-suite';
import { expectLineCharts, lineBody, openCharts } from './charts';
import { openWorkoutPanel } from './design-workout';
import { expectNoSideScroll } from './desktop';
import { gotoHydrated, trackConsoleErrors } from './support';

const DESIGN_KEY = 'pc:design:v1';
const DESIGNS = ['current', 'graphite'] as const;
type Design = (typeof DESIGNS)[number];

/** Chooses the design before any page loads, as Profile → Appearance → Design saves it. */
const choose = (page: Page, design: Design) =>
	page.addInitScript(([key, d]) => localStorage.setItem(key!, d!), [DESIGN_KEY, design]);

async function settle(page: Page, design: Design) {
	const html = page.locator('html');
	if (design === 'graphite') await expect(html).toHaveAttribute('data-design', 'graphite');
	else await expect(html).not.toHaveAttribute('data-design', /.*/);
	await page.waitForFunction(() => document.fonts.status === 'loaded');
}

const css = (locator: Locator, property: string) =>
	locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

async function expectTargets(targets: Locator) {
	for (const target of await targets.all()) {
		const box = (await target.boundingBox())!;
		const name = (await target.textContent())?.trim() ?? 'a target';
		expect(box.height, name).toBeGreaterThanOrEqual(44);
		expect(box.width, name).toBeGreaterThanOrEqual(44);
	}
}

test.describe('the workout', () => {
	for (const design of DESIGNS) {
		test(`${design}: the RPE grid, the set states and the action bar`, async ({ page }) => {
			const errors = trackConsoleErrors(page);
			await choose(page, design);
			const panel = await openWorkoutPanel(page);
			await settle(page, design);

			const rpe = panel.getByTestId('rpe-chips').first();
			const faces = rpe.locator('.face');
			await expect(faces).toHaveCount(10);
			// Two rows of five, every key a 44 px target, in both designs.
			const first = (await faces.nth(0).boundingBox())!;
			const sixth = (await faces.nth(5).boundingBox())!;
			expect(sixth.y).toBeGreaterThan(first.y + first.height - 1);
			await expectTargets(rpe.locator('.chip'));

			await rpe.getByRole('radio', { name: '8', exact: true }).check();
			const chosen = rpe.locator('.input:checked + .face');
			const other = faces.nth(0);
			const rows = panel.getByTestId('set-rows');
			const now = rows.locator('[data-testid="set"][data-state="current"] > .set');
			const logger = panel.getByTestId('set-logger').first();
			if (design === 'graphite') {
				// Connected: a 1 px seam between plastic keys; the answer in the selection well.
				expect(await css(rpe.locator('.chips'), 'row-gap')).toBe('1px');
				expect(await css(other, 'background-image')).toContain('linear-gradient');
				expect(await css(chosen, 'background-image')).toContain('linear-gradient');
				expect(await css(chosen, 'background-image')).not.toBe(
					await css(other, 'background-image')
				);
				expect(await css(chosen, 'color')).not.toBe(await css(other, 'color'));
				// Now: the Aqua wash, no ring.
				expect(await css(now, 'border-top-color')).toBe('rgba(0, 0, 0, 0)');
				expect(await css(now, 'background-color')).not.toBe('rgba(0, 0, 0, 0)');
				// Complete set on the bar: the logger's foot is the bar material.
				expect(await css(logger, 'background-image')).toContain('linear-gradient');
			} else {
				expect(await css(other, 'background-image')).toBe('none');
				expect(await css(chosen, 'background-image')).toBe('none');
				expect(await css(now, 'border-top-color')).not.toBe('rgba(0, 0, 0, 0)');
				expect(await css(logger, 'background-image')).toBe('none');
			}
			await expectNoSideScroll(page);
			expect(errors).toEqual([]);
		});
	}
});

test.describe('the week strip, the line chart and the proposal on /design', () => {
	for (const design of DESIGNS) {
		test(`${design}: day names, the chosen date, dashed estimates and the strip`, async ({
			page
		}) => {
			await choose(page, design);
			await gotoHydrated(page, '/design');
			await settle(page, design);

			await page.getByRole('tab', { name: 'Plan' }).click();
			const strip = page.getByTestId('week-strip');
			await expect(strip).toBeVisible();
			const chosenDate = strip.locator('.day[aria-checked="true"] .date');
			if (design === 'graphite') {
				// Every day by its name ('Wed'), the chosen date in the selection well.
				await expect(strip.locator('.short')).toHaveCount(7);
				for (const name of await strip.locator('.short').all()) await expect(name).toBeVisible();
				for (const letter of await strip.locator('.letter').all())
					await expect(letter).toBeHidden();
				expect(await css(chosenDate, 'background-image')).toContain('linear-gradient');
				expect(await css(strip, 'border-top-width')).toBe('1px');
			} else {
				expect(await css(chosenDate, 'background-image')).toBe('none');
				expect(await css(strip, 'border-top-width')).toBe('0px');
			}
			await expectTargets(strip.getByRole('radio'));

			await page.getByRole('tab', { name: 'Coach' }).click();
			const proposal = page.getByTestId('proposal-live');
			await expect(proposal).toBeVisible();
			const head = proposal.locator(':scope > .head');
			const accept = proposal.getByTestId('proposal-accept');
			if (design === 'graphite') {
				expect(await css(head, 'background-image')).toContain('linear-gradient');
				expect(await css(proposal, 'border-left-width')).toBe('1px');
				expect(await css(accept, 'background-image')).toContain('linear-gradient');
			} else {
				expect(await css(head, 'background-image')).toBe('none');
				expect(await css(proposal, 'border-left-width')).toBe('3px');
			}

			await openCharts(page);
			await expectLineCharts(page);
			const kinds = lineBody(page, 'line-kinds');
			const plain = lineBody(page, 'line-single');
			const dash = (body: Locator) =>
				css(body.getByTestId('line-path').first(), 'stroke-dasharray');
			const measured = kinds.locator('[data-testid="line-mark"][data-kind="measured"]').first();
			const label = () =>
				measured.evaluate((el) => getComputedStyle(el, '::after').getPropertyValue('content'));
			if (design === 'graphite') {
				// Estimates dash the line; a chart of plain values keeps it solid.
				expect(await dash(kinds)).not.toBe('none');
				expect(await dash(plain)).toBe('none');
				expect(await css(measured, 'rotate')).toBe('none');
				expect(await label()).toBe('"measured"');
			} else {
				expect(await dash(kinds)).toBe('none');
				expect(await css(measured, 'rotate')).toBe('45deg');
				expect(await label()).toBe('none');
			}
			await expectNoSideScroll(page);
		});
	}
});

test.describe('Progress, Profile and Coach', () => {
	for (const design of DESIGNS) {
		test(`${design}: the view tabs, the preference rows and the docked composer`, async ({
			page
		}) => {
			const errors = trackConsoleErrors(page);
			await choose(page, design);

			await gotoHydrated(page, '/progress');
			await settle(page, design);
			const views = page.getByRole('navigation', { name: 'Progress views' });
			const current = views.locator('a[aria-current="page"]');
			const period = page.getByTestId('progress-period').locator('nav.picker > ul');
			if (design === 'graphite') {
				// One connected control each, the current choice in the well.
				expect(await css(views, 'background-image')).toContain('linear-gradient');
				expect(await css(current, 'background-image')).toContain('linear-gradient');
				expect(await css(period, 'background-image')).toContain('linear-gradient');
			} else {
				expect(await css(views, 'background-image')).toBe('none');
				expect(await css(current, 'background-image')).toBe('none');
			}
			await expectTargets(views.getByRole('link'));
			await expectTargets(page.getByTestId('progress-period').locator('a.period'));
			await expectNoSideScroll(page);

			await gotoHydrated(page, '/profile');
			const second = page.locator('.prefs > .pref').nth(1);
			await expect(second).toBeVisible();
			expect(await css(second, 'border-top-width')).toBe(design === 'graphite' ? '1px' : '0px');

			await gotoHydrated(page, '/coach');
			const composer = page.getByRole('form', { name: 'Message your coach' });
			const nav = page.getByRole('navigation', { name: 'Primary' });
			await expect(composer).toBeVisible();
			const box = (await composer.boundingBox())!;
			const bar = (await nav.boundingBox())!;
			const width = page.viewportSize()!.width;
			if (design === 'graphite') {
				// One dock: the composer full-bleed, standing on the tab bar.
				expect(Math.abs(box.y + box.height - bar.y)).toBeLessThanOrEqual(1);
				expect(Math.round(box.width)).toBe(width);
				expect(await css(composer, 'background-image')).toContain('linear-gradient');
				// Writing: the well takes the focus ring, and the bar's top edge stays as it was.
				const edge = await css(composer, 'border-top-color');
				await composer.getByRole('textbox').focus();
				await page.waitForTimeout(300); // past Composer's border transition
				expect(await css(composer, 'border-top-color')).toBe(edge);
				await composer.getByRole('textbox').blur();
			} else {
				expect(box.y + box.height).toBeLessThan(bar.y - 4);
				expect(box.width).toBeLessThan(width);
			}
			const input = (await composer.getByRole('textbox').boundingBox())!;
			expect(input.height).toBeGreaterThanOrEqual(44);
			await expectNoSideScroll(page);
			expect(errors).toEqual([]);
		});
	}
});

test.describe('onboarding', () => {
	for (const design of DESIGNS) {
		test(`${design}: the step track and the 'What we’ll ask' box`, async ({ page }) => {
			await choose(page, design);
			await gotoHydrated(page, '/onboarding');
			await settle(page, design);
			const graphite = design === 'graphite';
			// The outline: one box of rows in Graphite, a bare list in today's design.
			const ahead = page.getByRole('list', { name: 'What we’ll ask' });
			await expect(ahead).toBeVisible();
			expect(await css(ahead, 'border-top-width')).toBe(graphite ? '1px' : '0px');
			expect(await css(ahead.getByRole('listitem').nth(1), 'border-top-width')).toBe(
				graphite ? '1px' : '0px'
			);
			// The track: an inset well around the segments in Graphite.
			const track = page.getByTestId('step-progress');
			expect(await css(track, 'padding-top')).toBe(graphite ? '2px' : '0px');
			const current = await css(track.locator('.segment.current'), 'background-image');
			if (graphite) expect(current).toContain('linear-gradient');
			else expect(current).toBe('none');
		});
	}
});

test.describe('axe in Graphite', () => {
	for (const theme of ['dark', 'light'] as const) {
		test(`the restyled screens pass axe (${theme})`, async ({ page }) => {
			await page.addInitScript(
				([key, t]) => {
					localStorage.setItem(key!, 'graphite');
					localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t }));
				},
				[DESIGN_KEY, theme]
			);
			const found: string[] = [];
			for (const path of ['/progress', '/profile', '/coach']) {
				await gotoHydrated(page, path);
				await settle(page, 'graphite');
				await page.waitForTimeout(400); // entrance transitions settle: contrast on final colours
				found.push(...(await audit(page)).map((v) => `${path}: ${v}`));
			}
			await openWorkoutPanel(page);
			await settle(page, 'graphite');
			await page
				.getByTestId('rpe-chips')
				.first()
				.getByRole('radio', { name: '8', exact: true })
				.check();
			await page.waitForTimeout(400);
			found.push(...(await audit(page)).map((v) => `/design workout: ${v}`));
			for (const tab of ['Plan', 'Coach']) {
				await page.getByRole('tab', { name: tab }).click();
				await expect(page.getByRole('tabpanel', { name: tab })).toBeVisible();
				await page.waitForTimeout(400);
				found.push(...(await audit(page)).map((v) => `/design ${tab}: ${v}`));
			}
			expect(found).toEqual([]);
		});

		for (const path of SCREENS.filter((p) => p.startsWith('/onboarding'))) {
			test(`${path} passes axe (${theme})`, async ({ page }) => {
				await page.addInitScript(
					([key, t]) => {
						localStorage.setItem(key!, 'graphite');
						localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t }));
					},
					[DESIGN_KEY, theme]
				);
				await gotoHydrated(page, path);
				await settle(page, 'graphite');
				// A step's editor loads after the screen, in place of its skeleton.
				const editor = page.getByTestId('section-editor');
				if (await editor.count()) await expect(editor).toHaveAttribute('aria-busy', 'false');
				await page.waitForTimeout(400); // entrance transitions settle: contrast on final colours
				expect(await audit(page)).toEqual([]);
			});
		}
	}
});
