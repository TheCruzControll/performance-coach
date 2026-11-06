/**
 * Automated accessibility audit (axe-core, WCAG 2.1 A/AA) of every screen in BOTH themes.
 * Lighthouse only audits the default (dark) theme, so light mode needs its own run: this is it.
 * Includes interactive states that only exist after a tap (the plate-calculator sheet, the
 * /design component tabs).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signedOut, TABS } from './support';

const SCREENS = [...TABS.map((t) => t.path), '/profile/security', '/offline', '/design'];
/** Screens a signed-out browser sees (setup and recovery-session screens are audited in
 * auth.setup.ts and auth.e2e.ts, the only places they exist). */
const SIGNED_OUT_SCREENS = ['/', '/recover'];
const THEMES = ['dark', 'light'] as const;

async function audit(page: Page): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

for (const theme of THEMES) {
	test.describe(`accessibility (axe, ${theme} theme)`, () => {
		test.beforeEach(async ({ page }) => {
			// The stored preference is applied before first paint by the inline theme script.
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
		});

		test.describe('signed out', () => {
			test.use({ storageState: signedOut });
			for (const path of SIGNED_OUT_SCREENS) {
				test(`${path} has no WCAG A/AA violations`, async ({ page }) => {
					await page.goto(path);
					await page.waitForLoadState('networkidle');
					const html = page.locator('html');
					if (theme === 'light') await expect(html).toHaveAttribute('data-theme', 'light');
					await page.evaluate(() => document.fonts.ready);
					await page.waitForTimeout(400);
					expect(await audit(page)).toEqual([]);
				});
			}
		});

		for (const path of SCREENS) {
			test(`${path} has no WCAG A/AA violations`, async ({ page }) => {
				await page.goto(path);
				await page.waitForLoadState('networkidle');
				if (path === '/profile') await expect(page.getByTestId('db-status')).toBeVisible();
				const html = page.locator('html');
				if (theme === 'light') await expect(html).toHaveAttribute('data-theme', 'light');
				else await expect(html).not.toHaveAttribute('data-theme', /.*/);
				// Let entrance transitions settle so contrast is measured on final colours.
				await page.evaluate(() => document.fonts.ready);
				await page.waitForTimeout(400);
				expect(await audit(page)).toEqual([]);
			});
		}

		test('the plate calculator sheet has no violations', async ({ page }) => {
			await page.goto('/train');
			// Hydrated first: a tap on the server-rendered row before then does nothing.
			await page.waitForLoadState('networkidle');
			await page.getByTestId('open-plates').click();
			await expect(page.getByTestId('plates-result')).toBeVisible();
			await page.waitForTimeout(500);
			expect(await audit(page)).toEqual([]);
		});

		test('every /design component group has no violations', async ({ page }) => {
			await page.goto('/design');
			const loaded = {
				Inputs: page.getByRole('spinbutton', { name: 'Reps' }),
				Data: page.getByRole('heading', { name: 'List row' }),
				Feedback: page.getByRole('button', { name: 'Bottom sheet' })
			};
			for (const [tab, ready] of Object.entries(loaded)) {
				await page.getByRole('tab', { name: tab }).click();
				await expect(ready).toBeVisible();
				await page.waitForTimeout(300);
				expect(await audit(page), tab).toEqual([]);
			}
		});
	});
}
