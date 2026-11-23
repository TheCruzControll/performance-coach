/**
 * The Instrument v2 actions on /design → Buttons, on a phone, in both themes: the one amber
 * primary at 60 px, the quiet, quiet danger, text and link buttons, the round surface-3 icon
 * buttons, and no box-shadow anywhere on a button (no glow). Colours are the rgb strings
 * getComputedStyle returns; the light values follow in brackets in docs/design-system.md.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { gotoHydrated } from './support';

type Theme = 'dark' | 'light';

/** The tokens each theme resolves to, as getComputedStyle reports them. */
const COLOUR: Record<
	Theme,
	{
		surface2: string;
		surface3: string;
		quiet: string;
		tertiary: string;
		danger: string;
		secondary: string;
	}
> = {
	dark: {
		surface2: 'rgb(25, 25, 28)',
		surface3: 'rgb(34, 34, 38)',
		quiet: 'rgb(122, 122, 130)',
		tertiary: 'rgb(134, 134, 142)',
		danger: 'rgb(255, 90, 82)',
		secondary: 'rgb(163, 163, 168)'
	},
	light: {
		surface2: 'rgb(236, 236, 231)',
		surface3: 'rgb(226, 226, 220)',
		quiet: 'rgb(110, 110, 118)',
		tertiary: 'rgb(102, 102, 110)',
		danger: 'rgb(187, 44, 40)',
		secondary: 'rgb(85, 85, 92)'
	}
};

const AMBER = 'rgb(255, 176, 46)';
const ON_AMBER = 'rgb(26, 18, 0)';
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

async function openButtons(page: Page, theme: Theme) {
	await page.addInitScript(
		(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
		theme
	);
	await gotoHydrated(page, '/design');
	if (theme === 'light') await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await expect(page.getByRole('button', { name: 'Start workout', exact: true })).toBeVisible();
}

/** The computed style of a control, and its box, in CSS pixels. */
const paint = (control: Locator) =>
	control.evaluate((el) => {
		const s = getComputedStyle(el);
		const box = el.getBoundingClientRect();
		return {
			width: box.width,
			height: box.height,
			borderRadius: s.borderRadius,
			background: s.backgroundColor,
			color: s.color,
			borderTopColor: s.borderTopColor,
			fontSize: s.fontSize,
			fontWeight: s.fontWeight,
			opacity: s.opacity,
			textDecorationLine: s.textDecorationLine,
			textUnderlineOffset: s.textUnderlineOffset,
			boxShadow: s.boxShadow
		};
	});

for (const theme of ['dark', 'light'] as const) {
	const c = COLOUR[theme];

	test.describe(`/design → Buttons, Instrument v2 (${theme})`, () => {
		test.beforeEach(async ({ page }) => {
			await openButtons(page, theme);
		});

		test('the one primary is a 60 px amber block with 16 px corners and a 600 17 px label', async ({
			page
		}) => {
			const primary = await paint(page.getByRole('button', { name: 'Start workout', exact: true }));
			expect(primary.height).toBeCloseTo(60, 0);
			expect(primary.borderRadius).toBe('16px');
			expect(primary.background).toBe(AMBER);
			expect(primary.color).toBe(ON_AMBER);
			expect(primary.fontWeight).toBe('600');
			expect(primary.fontSize).toBe('17px');
		});

		test('a disabled primary goes quiet on surface-2 with the quiet label, not faded', async ({
			page
		}) => {
			const disabled = await paint(page.getByRole('button', { name: 'Disabled', exact: true }));
			expect(disabled.background).toBe(c.surface2);
			expect(disabled.color).toBe(c.quiet);
			expect(disabled.opacity).toBe('1');
		});

		test('a loading primary keeps its width, is busy, and goes quiet with the tertiary label', async ({
			page
		}) => {
			const loading = page.getByRole('button', { name: 'Waiting for your passkey', exact: true });
			await expect(loading).toHaveAttribute('aria-busy', 'true');
			const styles = await paint(loading);
			expect(styles.background).toBe(c.surface2);
			expect(styles.color).toBe(c.tertiary);
			expect(styles.opacity).toBe('1');
		});

		test('the quiet button is surface-2 with no border, and the quiet danger has the danger label', async ({
			page
		}) => {
			const quiet = await paint(
				page.getByRole('button', { name: 'Plate calculator', exact: true })
			);
			expect(quiet.background).toBe(c.surface2);
			expect(quiet.borderTopColor).toBe(TRANSPARENT);

			const danger = await paint(page.getByRole('button', { name: 'Skip exercise', exact: true }));
			expect(danger.background).toBe(c.surface2);
			expect(danger.color).toBe(c.danger);
		});

		test('the text button has no fill, 15 px secondary text and no underline', async ({ page }) => {
			const ghost = await paint(page.getByRole('button', { name: 'Keep it', exact: true }));
			expect(ghost.background).toBe(TRANSPARENT);
			expect(ghost.color).toBe(c.secondary);
			expect(ghost.fontSize).toBe('15px');
			expect(ghost.textDecorationLine).toBe('none');
		});

		test('the link is an underlined text action, 4 px under the line', async ({ page }) => {
			const link = await paint(page.getByRole('button', { name: 'Add a goal', exact: true }));
			expect(link.background).toBe(TRANSPARENT);
			expect(link.textDecorationLine).toBe('underline');
			expect(link.textUnderlineOffset).toBe('4px');
		});

		test('the lg filled icon button is a 60 px round surface-3 control', async ({ page }) => {
			const plus = await paint(page.getByRole('button', { name: 'Add', exact: true }));
			expect(plus.width).toBeCloseTo(60, 0);
			expect(plus.height).toBeCloseTo(60, 0);
			expect(parseFloat(plus.borderRadius)).toBeGreaterThanOrEqual(30);
			expect(plus.background).toBe(c.surface3);
		});

		test('no button has a box-shadow: no glow on any action', async ({ page }) => {
			const shadows = await page
				.locator('.btn')
				.evaluateAll((els) => els.map((el) => getComputedStyle(el).boxShadow));
			expect(shadows.length).toBeGreaterThan(0);
			expect(shadows.filter((shadow) => shadow !== 'none')).toEqual([]);
		});

		test('a link in running text is underlined in secondary text', async ({ page }) => {
			const inline = await paint(page.locator('a.text-link'));
			expect(inline.color).toBe(c.secondary);
			expect(inline.textDecorationLine).toBe('underline');
			expect(inline.textUnderlineOffset).toBe('4px');
		});
	});
}
