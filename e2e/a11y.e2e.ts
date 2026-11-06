/**
 * Automated accessibility audit (axe-core, WCAG 2.1 A/AA) of every screen in BOTH themes.
 * Lighthouse only audits the default (dark) theme, so light mode needs its own run: this is it.
 * Includes interactive states that only exist after a tap (the plate-calculator sheet, the
 * /design component tabs).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { signedOut, TABS } from './support';

const SCREENS = [
	...TABS.map((t) => t.path),
	'/profile/security',
	'/profile/goals',
	'/profile/equipment',
	'/profile/strength',
	'/profile/experience',
	'/profile/basics',
	'/profile/specifics',
	'/profile/body',
	'/profile/injuries',
	'/profile/exercises',
	'/profile/schedule',
	'/offline',
	'/design'
];
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
				// An error page in its place would pass the audit: the screen itself must load.
				expect((await page.goto(path))?.status(), path).toBe(200);
				await page.waitForLoadState('networkidle');
				if (path === '/profile') await expect(page.getByTestId('db-status')).toBeVisible();
				// A Profile section's editor loads after the screen, in place of its skeleton.
				const editor = page.getByTestId('section-editor');
				if (await editor.count()) await expect(editor).toHaveAttribute('aria-busy', 'false');
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

		test('a Profile section asking to discard its changes has no violations', async ({ page }) => {
			await page.goto('/profile/equipment');
			await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
			// A change that is never saved: nothing reaches the database.
			await page.getByRole('radio', { name: 'Strength club' }).check();
			await page.getByTestId('back-to-profile').click();
			await expect(page.getByTestId('discard-sheet')).toBeVisible();
			await page.waitForTimeout(500);
			expect(await audit(page)).toEqual([]);
		});

		test('Strength’s week-one explainer, both kinds of lift and an error have no violations', async ({
			page
		}) => {
			await page.goto('/profile/strength');
			await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
			// Changes that are never saved: the browser refuses the invalid one before posting.
			const unknown = page.getByRole('switch', { name: 'I don’t know my 1RMs' });
			await unknown.check();
			await expect(page.getByTestId('baselines-explainer')).toBeVisible();
			await page.waitForTimeout(300);
			expect(await audit(page), 'explainer').toEqual([]);

			await unknown.uncheck();
			await page.getByRole('button', { name: 'Back squat', exact: true }).click();
			const squat = page.getByRole('region', { name: 'Back squat' });
			await squat.getByRole('radio', { name: 'Tested max' }).check();
			await squat.getByRole('textbox', { name: '1RM' }).fill('600');
			await page.getByRole('button', { name: 'Bench press', exact: true }).click();
			const bench = page.getByRole('region', { name: 'Bench press' });
			await bench.getByRole('radio', { name: 'From a recent set' }).check();
			await bench.getByRole('textbox', { name: 'Weight' }).fill('100');
			await bench.getByRole('textbox', { name: 'Reps' }).fill('5');
			await page.getByTestId('save-section').click();
			await expect(squat.getByRole('alert')).toBeVisible();
			await expect(bench.getByTestId('baseline-estimate')).toContainText('estimated 1RM');
			await page.waitForTimeout(300);
			expect(await audit(page), 'lifts').toEqual([]);
		});

		test('the goal sheet, blank and showing its errors, has no violations', async ({ page }) => {
			await page.goto('/profile/goals');
			await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
			// The browser refuses the blank goal before posting: nothing reaches the database.
			await page.getByTestId('goal-path-event').or(page.getByTestId('add-goal')).click();
			const sheet = page.getByTestId('goal-sheet');
			await expect(sheet.getByRole('heading', { name: 'New goal' })).toBeVisible();
			await page.waitForTimeout(500);
			expect(await audit(page), 'blank').toEqual([]);
			await sheet.getByRole('button', { name: 'Save goal' }).click();
			await expect(sheet.getByRole('alert').first()).toBeVisible();
			await page.waitForTimeout(300);
			expect(await audit(page), 'errors').toEqual([]);
		});

		test('an injury card with an error and a resolved badge has no violations', async ({
			page
		}) => {
			await page.goto('/profile/injuries');
			await page.waitForLoadState('networkidle');
			await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
			// Changes that are never saved: the browser refuses the card before posting it.
			await page.getByRole('button', { name: /^Add (an injury or limitation|another)$/ }).click();
			const card = page.getByTestId('injury').last();
			await card.getByRole('switch', { name: 'Still affecting training' }).uncheck();
			await expect(card.getByTestId('injury-resolved')).toBeVisible();
			await page.getByTestId('save-section').click();
			await expect(card.getByRole('group', { name: 'Where?' }).getByRole('alert')).toBeVisible();
			await page.waitForTimeout(300);
			expect(await audit(page)).toEqual([]);
		});

		test('Schedule’s stepper and commitment errors have no violations', async ({ page }) => {
			await page.goto('/profile/schedule');
			await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
			// Never saved: the browser refuses both errors before posting.
			const free = page.getByRole('group', { name: 'Days you can train' });
			for (const day of ['Monday', 'Wednesday', 'Friday']) {
				await free.getByRole('checkbox', { name: day }).check();
			}
			await page.getByRole('button', { name: 'Increase Training days a week' }).click();
			await page.getByTestId('add-commitment').click();
			await page.getByTestId('save-section').click();
			await expect(page.getByRole('spinbutton', { name: 'Training days a week' })).toHaveAttribute(
				'aria-invalid',
				'true'
			);
			await expect(page.getByTestId('commitment').getByRole('alert').first()).toBeVisible();
			await page.waitForTimeout(300);
			expect(await audit(page)).toEqual([]);
		});

		test('every /design component group has no violations', async ({ page }) => {
			await page.goto('/design');
			const loaded = {
				Inputs: page.getByRole('spinbutton', { name: 'Reps' }),
				Data: page.getByRole('heading', { name: 'List row' }),
				Feedback: page.getByRole('button', { name: 'Bottom sheet' }),
				Plan: page.getByRole('heading', { name: 'Session card' })
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
