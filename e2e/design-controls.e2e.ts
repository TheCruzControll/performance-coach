/**
 * Graphite 2004's core controls (src/lib/ui/styles/graphite.css, Controls) on /design: the gel
 * primary button, plastic secondary and silver card strip appear only in Graphite, and switching
 * back leaves today's design exactly as it was; the ON/OFF switch flips from anywhere on its 44 px
 * row; the sheet rises on the spring with 10 px corners; and the Inputs and Feedback panels pass
 * axe in Graphite in both themes. The desktop window (hover and keyboard focus) is
 * design-controls.desktop.e2e.ts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { audit } from './a11y-suite';
import { gotoHydrated } from './support';

const DESIGN_KEY = 'pc:design:v1';
/** What each control is checked by: its paint, its corners, its border. */
const PAINT = ['backgroundImage', 'backgroundColor', 'borderTopLeftRadius', 'borderTopColor'];

async function paint(locator: Locator): Promise<Record<string, string>> {
	return locator.evaluate((el, props) => {
		const style = getComputedStyle(el) as unknown as Record<string, string>;
		return Object.fromEntries(props.map((prop) => [prop, style[prop]!]));
	}, PAINT);
}

/** The controls compared across designs: the first of each on /design's Buttons tab and cards. */
function controls(page: Page) {
	const card = page.locator('[data-ui="surface"]', { hasText: 'Discipline surface' }).first();
	const buttons = page.getByRole('tabpanel', { name: 'Buttons' });
	return {
		primary: buttons.getByRole('button', { name: 'Start workout' }),
		secondary: buttons.getByRole('button', { name: 'Plate calculator' }),
		card,
		strip: card.locator('[data-ui="card-head"]')
	};
}

async function paints(page: Page) {
	const all: Record<string, Record<string, string>> = {};
	for (const [name, locator] of Object.entries(controls(page))) all[name] = await paint(locator);
	return all;
}

async function settle(page: Page, design: 'current' | 'graphite') {
	if (design === 'graphite') {
		await expect(page.locator('html')).toHaveAttribute('data-design', 'graphite');
	} else {
		await expect(page.locator('html')).not.toHaveAttribute('data-design', /.*/);
	}
	await page.waitForFunction(() => document.fonts.status === 'loaded');
}

test('Graphite restyles the controls, and today’s design is exactly as it was before and after', async ({
	page
}) => {
	await gotoHydrated(page, '/design');
	await settle(page, 'current');
	const today = await paints(page);
	expect(today.primary!.backgroundImage).toBe('none');
	expect(today.strip!.backgroundImage).toBe('none');

	await gotoHydrated(page, '/design?design=graphite');
	await settle(page, 'graphite');
	const { primary, secondary, strip } = controls(page);
	const graphite = await paints(page);
	// The gel, the plastic and the silver strip are gradients; the corners are crisp.
	expect(graphite.primary!.backgroundImage).toContain('linear-gradient');
	expect(graphite.secondary!.backgroundImage).toContain('linear-gradient');
	expect(graphite.strip!.backgroundImage).toContain('linear-gradient');
	expect(graphite.primary!.borderTopLeftRadius).toBe('6px');
	expect(graphite.card!.borderTopLeftRadius).toBe('6px');
	expect(Math.round((await primary.boundingBox())!.height)).toBe(50);
	expect(Math.round((await secondary.boundingBox())!.height)).toBe(50);
	// The strip spans the box edge to edge, at the top of it.
	const box = (await controls(page).card.boundingBox())!;
	const head = (await strip.boundingBox())!;
	expect(Math.abs(head.x - box.x)).toBeLessThanOrEqual(1);
	expect(Math.abs(head.y - box.y)).toBeLessThanOrEqual(1);
	expect(Math.abs(head.width - box.width)).toBeLessThanOrEqual(2);

	await gotoHydrated(page, '/design?design=current');
	await settle(page, 'current');
	expect(await paints(page)).toEqual(today);
});

test.describe('in Graphite', () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript((key) => localStorage.setItem(key, 'graphite'), DESIGN_KEY);
	});

	test('the switch reads OFF and ON, and its whole 44 px row flips it', async ({ page }) => {
		await gotoHydrated(page, '/design');
		await settle(page, 'graphite');
		await page.getByRole('tab', { name: 'Inputs' }).click();
		const control = page.getByRole('switch', { name: 'I also train at home' });
		const row = page.locator('[data-ui="toggle"]', { has: control });
		const track = row.locator('.track');
		const word = () =>
			track.evaluate((el) => getComputedStyle(el, '::after').content.replace(/["']/g, ''));

		await expect(control).not.toBeChecked();
		expect(await word()).toBe('OFF');
		expect(Math.round((await track.boundingBox())!.width)).toBe(76);
		// The row sits below the fold on a phone; the tap needs it on screen.
		await row.scrollIntoViewIfNeeded();
		const area = (await row.boundingBox())!;
		expect(area.height).toBeGreaterThanOrEqual(44);

		// A tap on the label's side of the row, far from the switch, flips it.
		await page.mouse.click(area.x + 8, area.y + area.height / 2);
		await expect(control).toBeChecked();
		await expect.poll(word).toBe('ON');
		await control.press('Space');
		await expect(control).not.toBeChecked();
		await expect.poll(word).toBe('OFF');
	});

	test('the sheet rises on the spring, with 10 px corners', async ({ page }) => {
		await gotoHydrated(page, '/design');
		await settle(page, 'graphite');
		await page.getByRole('tab', { name: 'Feedback' }).click();
		await page.getByTestId('open-sheet').click();
		const dialog = page.getByRole('dialog', { name: 'Substitute exercise' });
		await expect(dialog).toBeVisible();
		await expect(dialog).toHaveAttribute('data-ui', 'sheet');
		const sheet = dialog.locator(':scope > .sheet');
		const motion = await sheet.evaluate((el) => {
			const style = getComputedStyle(el);
			return { corner: style.borderTopLeftRadius, easing: style.transitionTimingFunction };
		});
		expect(motion.corner).toBe('10px');
		expect(motion.easing).toMatch(/^linear\(/);
		await dialog.getByRole('button', { name: 'Done' }).click();
		await expect(dialog).toBeHidden();
	});
});

for (const theme of ['dark', 'light'] as const) {
	test.describe(`accessibility of Graphite’s controls (axe, ${theme} theme)`, () => {
		test.beforeEach(async ({ page }) => {
			await page.addInitScript(
				([t, key]) => {
					localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t }));
					localStorage.setItem(key!, 'graphite');
				},
				[theme, DESIGN_KEY]
			);
		});

		test('/design → Inputs has no WCAG A/AA violations', async ({ page }) => {
			await gotoHydrated(page, '/design');
			await settle(page, 'graphite');
			await page.getByRole('tab', { name: 'Inputs' }).click();
			await expect(page.getByRole('heading', { name: 'Toggle' })).toBeVisible();
			// Entrance transitions settle, so contrast is measured on the final colours.
			await page.waitForTimeout(400);
			expect(await audit(page)).toEqual([]);
		});

		test('/design → Feedback, its sheet open, has no WCAG A/AA violations', async ({ page }) => {
			await gotoHydrated(page, '/design');
			await settle(page, 'graphite');
			await page.getByRole('tab', { name: 'Feedback' }).click();
			await page.getByTestId('open-sheet').click();
			await expect(page.getByRole('dialog', { name: 'Substitute exercise' })).toBeVisible();
			await page.waitForTimeout(400);
			expect(await audit(page)).toEqual([]);
		});
	});
}
