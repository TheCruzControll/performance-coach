/**
 * The legacy components on /design, on a phone, in both themes (Instrument v2, v2/02d). v2 draws no
 * cards, chips, segmented controls or stat tiles, so these lose their fills, pills, tint and amber
 * and keep their boxes: a card its padding and a hairline outline, a chip its 28 px height, a badge
 * its 22 px, a segmented track its 44 px (the default size, md; the compact sm track is 36 px and
 * sits on /design's Inputs tab), a stat its padding. Colours are the rgb strings
 * getComputedStyle returns.
 */
import { expect, test, type Page } from '@playwright/test';
import { gotoHydrated } from './support';

type Theme = 'dark' | 'light';

const COLOUR: Record<
	Theme,
	{
		text: string;
		surface2: string;
		inverse: string;
		onInverse: string;
		secondary: string;
		tertiary: string;
		positive: string;
		hairline: string;
	}
> = {
	dark: {
		text: 'rgb(242, 242, 238)',
		surface2: 'rgb(25, 25, 28)',
		inverse: 'rgb(242, 242, 238)',
		onInverse: 'rgb(17, 17, 19)',
		secondary: 'rgb(163, 163, 168)',
		tertiary: 'rgb(134, 134, 142)',
		positive: 'rgb(127, 212, 154)',
		hairline: 'rgba(255, 255, 255, 0.07)'
	},
	light: {
		text: 'rgb(17, 17, 19)',
		surface2: 'rgb(236, 236, 231)',
		inverse: 'rgb(17, 17, 19)',
		onInverse: 'rgb(242, 242, 238)',
		secondary: 'rgb(85, 85, 92)',
		tertiary: 'rgb(102, 102, 110)',
		positive: 'rgb(27, 115, 64)',
		hairline: 'rgba(17, 17, 19, 0.08)'
	}
};

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

async function openDesign(page: Page, theme: Theme, tab?: 'Data') {
	await page.addInitScript(
		(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
		theme
	);
	await gotoHydrated(page, '/design');
	if (theme === 'light') await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	if (tab) await page.getByRole('tab', { name: tab }).click();
}

for (const theme of ['dark', 'light'] as const) {
	const c = COLOUR[theme];

	test.describe(`/design → Data, legacy components (${theme})`, () => {
		test.beforeEach(async ({ page }) => {
			await openDesign(page, theme, 'Data');
		});

		test('the tab indicator is the text colour, never amber', async ({ page }) => {
			await expect(page.getByRole('tablist').locator('.indicator')).toHaveCSS(
				'background-color',
				c.text
			);
		});

		test('a stat tile loses its fill and keeps its padding and value weight', async ({ page }) => {
			const panel = page.getByRole('tabpanel');
			const stat = panel.locator('.stat[data-level="1"]').first();
			const css = await stat.evaluate((el) => {
				const s = getComputedStyle(el);
				return { background: s.backgroundColor, paddingTop: s.paddingTop, shadow: s.boxShadow };
			});
			expect(css.background).toBe(TRANSPARENT);
			expect(css.paddingTop).toBe('16px');
			expect(css.shadow).toBe('none');
			await expect(stat.locator('.value')).toHaveCSS('font-weight', '600');

			const level2 = panel.locator('.stat[data-level="2"]').first();
			await expect(level2).toHaveCSS('background-color', TRANSPARENT);
		});

		test('a badge is a word on its line: no fill, no outline, and its 22 px line', async ({
			page
		}) => {
			const panel = page.getByRole('tabpanel');
			const badge = panel.locator('[data-ui="badge"]').first();
			await expect(badge).toHaveCSS('background-color', TRANSPARENT);
			await expect(badge).toHaveCSS('box-shadow', 'none');
			expect((await badge.boundingBox())!.height).toBe(22);

			const soon = panel.locator('[data-ui="badge"][data-tone="neutral"]', { hasText: 'Soon' });
			await expect(soon.first()).toHaveCSS('color', c.tertiary);

			const positive = panel.locator('[data-ui="badge"][data-tone="positive"]');
			await expect(positive).toHaveCSS('color', c.positive);
			await expect(positive).toHaveCSS('background-color', TRANSPARENT);
		});

		test('a chip is plain secondary text: no outline, no pill, its 28 px line kept', async ({
			page
		}) => {
			const chip = page.locator('.chip').filter({ hasText: 'Barbell' });
			await expect(chip).toHaveCSS('border-top-width', '0px');
			await expect(chip).toHaveCSS('background-color', TRANSPARENT);
			await expect(chip).toHaveCSS('color', c.secondary);
			// The 1 px the border took stays in the padding, so the text keeps its place.
			await expect(chip).toHaveCSS('padding-left', '13px');
			expect((await chip.boundingBox())!.height).toBe(28);
		});

		test('a segmented control has no outline, a surface-2 track and an inverse thumb', async ({
			page
		}) => {
			const control = page.getByRole('radiogroup', { name: 'Range' });
			await expect(control).toHaveCSS('border-top-width', '0px');
			await expect(control).toHaveCSS('background-color', c.surface2);
			// The default size (md, DataPanel's Range): a 44 px track. The compact size (sm, 36 px) is
			// InputsPanel's, and its options' hit areas stay 44 px (shell.e2e.ts).
			expect((await control.boundingBox())!.height).toBe(44);

			await expect(control.locator('.thumb')).toHaveCSS('background-color', c.inverse);
			await expect(control.getByRole('radio', { checked: true })).toHaveCSS('color', c.onInverse);
		});

		test("a section heading is v2's group heading: 15 px, weight 400, tertiary", async ({
			page
		}) => {
			const heading = page.getByRole('heading', { name: 'Stat', exact: true });
			await expect(heading).toHaveCSS('font-size', '15px');
			await expect(heading).toHaveCSS('font-weight', '400');
			await expect(heading).toHaveCSS('color', c.tertiary);
		});
	});

	test.describe(`/design, legacy cards (${theme})`, () => {
		test('a card keeps its padding and a hairline outline, with no fill or shadow', async ({
			page
		}) => {
			await openDesign(page, theme);
			const card = page.locator('.surface').filter({ hasText: 'Discipline surface' });
			await expect(card).toHaveCSS('background-color', TRANSPARENT);
			await expect(card).toHaveCSS('border-top-width', '1px');
			await expect(card).toHaveCSS('border-top-color', c.hairline);
			await expect(card).toHaveCSS('border-radius', '20px');
			await expect(card).toHaveCSS('box-shadow', 'none');
			await expect(card).toHaveCSS('padding-top', '16px');

			const title = card.getByRole('heading', { name: 'Discipline surface' });
			await expect(title).toHaveCSS('font-size', '17px');
			await expect(title).toHaveCSS('font-weight', '600');
		});
	});
}
