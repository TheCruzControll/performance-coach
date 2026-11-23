/**
 * The Instrument v2 rows and toasts on /design, on a phone, in both themes. Data: a list row is
 * a 60 px row with a hairline under it, none under a list's last row; its value sits before the
 * chevron; a danger row's title is the danger colour with no chevron; no row draws a tile.
 * Feedback: a toast is a surface-2 line with 16 px corners and no icon unless it is a danger
 * toast; the undo is a strong text link; the confirm sheet's discard is a quiet danger block.
 * Colours are the rgb strings getComputedStyle returns.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { gotoHydrated, toastWith } from './support';

type Theme = 'dark' | 'light';

const COLOUR: Record<
	Theme,
	{
		surface2: string;
		text: string;
		secondary: string;
		tertiary: string;
		danger: string;
		hairline: string;
	}
> = {
	dark: {
		surface2: 'rgb(25, 25, 28)',
		text: 'rgb(242, 242, 238)',
		secondary: 'rgb(163, 163, 168)',
		tertiary: 'rgb(134, 134, 142)',
		danger: 'rgb(255, 90, 82)',
		hairline: 'rgba(255, 255, 255, 0.07)'
	},
	light: {
		surface2: 'rgb(236, 236, 231)',
		text: 'rgb(17, 17, 19)',
		secondary: 'rgb(85, 85, 92)',
		tertiary: 'rgb(102, 102, 110)',
		danger: 'rgb(187, 44, 40)',
		hairline: 'rgba(17, 17, 19, 0.08)'
	}
};

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

async function openTab(page: Page, theme: Theme, tab: 'Data' | 'Feedback') {
	await page.addInitScript(
		(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
		theme
	);
	await gotoHydrated(page, '/design');
	if (theme === 'light') await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await page.getByRole('tab', { name: tab }).click();
}

/** The computed style and box of an element, in CSS pixels. */
const paint = (el: Locator) =>
	el.evaluate((node) => {
		const s = getComputedStyle(node);
		const box = node.getBoundingClientRect();
		return {
			width: box.width,
			height: box.height,
			borderRadius: s.borderRadius,
			background: s.backgroundColor,
			color: s.color,
			borderTopWidth: s.borderTopWidth,
			borderBottomColor: s.borderBottomColor,
			fontSize: s.fontSize,
			fontWeight: s.fontWeight,
			textDecorationLine: s.textDecorationLine,
			boxShadow: s.boxShadow
		};
	});

for (const theme of ['dark', 'light'] as const) {
	const c = COLOUR[theme];

	test.describe(`/design → Data, list rows (${theme})`, () => {
		test.beforeEach(async ({ page }) => {
			await openTab(page, theme, 'Data');
		});

		test('a list row is at least 60 px tall with a hairline under it, and a list’s last row has none', async ({
			page
		}) => {
			await expect(page.locator('ul.list > li')).toHaveCount(6);
			const plain = await paint(
				page.getByRole('button', { name: 'Exercise library', exact: true })
			);
			expect(plain.height).toBeGreaterThanOrEqual(60);
			expect(plain.borderTopWidth).toBe('0px');
			expect(plain.borderBottomColor).toBe(c.hairline);
			expect(plain.background).toBe(TRANSPARENT);

			const last = await paint(page.getByRole('button', { name: 'Sign out', exact: true }));
			expect(last.borderBottomColor).toBe(TRANSPARENT);
		});

		test('a value sits before the chevron in secondary text', async ({ page }) => {
			const units = page.getByRole('button', { name: /^Units/ });
			const value = await paint(units.locator('.value'));
			expect(value.fontSize).toBe('15px');
			expect(value.color).toBe(c.secondary);
			await expect(units.locator('.chevron')).toHaveCount(1);
			await expect(units.locator('.value')).toHaveText('kg, km');
		});

		test('a danger row’s title is the danger colour and has no chevron', async ({ page }) => {
			const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
			await expect(signOut.locator('.chevron')).toHaveCount(0);
			const title = await paint(signOut.locator('.title'));
			expect(title.color).toBe(c.danger);
		});

		test('the current row is a surface-2 tint with a 600 title', async ({ page }) => {
			const current = page.getByRole('button', { name: 'Passkeys', exact: true });
			await expect(current).toHaveAttribute('aria-current', 'page');
			const row = await paint(current);
			expect(row.background).toBe(c.surface2);
			const title = await paint(current.locator('.title'));
			expect(title.fontWeight).toBe('600');
		});

		test('a disabled row says Soon and has no chevron', async ({ page }) => {
			const soon = page.locator('[aria-disabled="true"]', { hasText: 'Rest timer' });
			await expect(soon).toContainText('Soon');
			await expect(soon.locator('.chevron')).toHaveCount(0);
		});

		test('no row draws an icon tile', async ({ page }) => {
			await expect(page.locator('ul.list > li')).toHaveCount(6);
			await expect(page.locator('ul.list .tile')).toHaveCount(0);
		});
	});

	test.describe(`/design → Feedback, toasts and the confirm sheet (${theme})`, () => {
		test.beforeEach(async ({ page }) => {
			await openTab(page, theme, 'Feedback');
		});

		test('a neutral toast is a surface-2 line with 16 px corners, no icon and no shadow', async ({
			page
		}) => {
			await page.getByRole('button', { name: 'Neutral toast', exact: true }).click();
			const line = toastWith(page, 'Long run shortened to 45 min');
			await expect(line).toBeVisible();
			await expect(line.locator('.alert')).toHaveCount(0);
			const styles = await paint(line);
			expect(styles.background).toBe(c.surface2);
			expect(styles.borderRadius).toBe('16px');
			expect(styles.color).toBe(c.text);
			expect(styles.boxShadow).toBe('none');
			expect((await paint(line.locator('.message'))).fontSize).toBe('15px');
		});

		test('a danger toast’s first svg is the alert in the danger colour', async ({ page }) => {
			await page.getByRole('button', { name: 'Error toast', exact: true }).click();
			const line = toastWith(page, 'Sync failed');
			await expect(line).toBeVisible();
			const glyph = line.locator('svg').first();
			expect(await glyph.evaluate((el) => getComputedStyle(el).color)).toBe(c.danger);
		});

		test('an undo is a strong text link at the end of the line, not a button', async ({ page }) => {
			await page.getByRole('button', { name: 'Undo toast', exact: true }).click();
			const line = toastWith(page, 'Upper body moved to Saturday');
			const undo = line.getByRole('button', { name: 'Undo', exact: true });
			await expect(undo).toBeVisible();
			const styles = await paint(undo);
			expect(styles.fontWeight).toBe('600');
			expect(styles.color).toBe(c.text);
			expect(styles.textDecorationLine).toBe('underline');
			expect(styles.background).toBe(TRANSPARENT);
		});

		test('the confirm sheet’s discard is a 60 px quiet danger block, and Keep it is a text button', async ({
			page
		}) => {
			await page.getByTestId('open-confirm').click();
			const dialog = page.getByRole('dialog', {
				name: 'Discard this workout and the six sets you logged?'
			});
			await expect(dialog).toBeVisible();

			const discard = await paint(
				dialog.getByRole('button', { name: 'Discard workout', exact: true })
			);
			expect(discard.height).toBeCloseTo(60, 0);
			expect(discard.background).toBe(c.surface2);
			expect(discard.color).toBe(c.danger);

			const keep = await paint(dialog.getByRole('button', { name: 'Keep it', exact: true }));
			expect(keep.background).toBe(TRANSPARENT);
			expect(keep.color).toBe(c.secondary);
		});
	});
}
