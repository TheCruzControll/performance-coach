/**
 * Automated accessibility audit (axe-core, WCAG 2.1 A/AA) of every screen in BOTH themes.
 * Lighthouse only audits the default (dark) theme, so light mode needs its own run: this is it.
 * Includes interactive states that only exist after a tap (the plate-calculator sheet, the
 * /design component tabs).
 *
 * Not a spec: a11y-dark.e2e.ts and a11y-light.e2e.ts each run `a11ySuite` for one theme, so
 * the two halves can run in parallel; both run the same tests (scripts/playwright-projects.test.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { contrast } from '../src/lib/ui/charts/palette-check';
import { COACH_A11Y } from './coach-a11y';
import { answerHistory, openWorkoutPanel, pick } from './design-workout';
import { isDesktopPage } from './desktop';
import { gotoHydrated, signedOut, TABS } from './support';

export const SCREENS = [
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
	// Every onboarding step an empty profile has (specifics is audited in onboarding.serial).
	'/onboarding',
	...['goals', 'experience', 'strength', 'equipment', 'injuries'].map((s) => `/onboarding/${s}`),
	...['exercises', 'schedule', 'body', 'review'].map((s) => `/onboarding/${s}`),
	'/offline',
	'/design'
];
/** Screens a signed-out browser sees (setup and recovery-session screens are audited in
 * auth.setup.ts and auth.e2e.ts, the only places they exist). */
export const SIGNED_OUT_SCREENS = ['/', '/recover'];

export async function audit(page: Page): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

/** A computed `rgb(r, g, b)` or `rgba(r, g, b, a)` as channels (0-255) and alpha (0-1). */
function channels(colour: string): number[] {
	const match = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(colour);
	if (!match) throw new Error(`not a computed rgb() colour: ${colour}`);
	return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1)];
}

/** `top` painted over an opaque `bottom`. */
const paint = (top: number[], bottom: number[]) =>
	[0, 1, 2].map((i) => top[i]! * top[3]! + bottom[i]! * (1 - top[3]!)).concat(1);

const hex = (rgb: number[]) =>
	'#' +
	rgb
		.slice(0, 3)
		.map((c) => Math.round(c).toString(16).padStart(2, '0'))
		.join('');

/**
 * Whether a ring reaches WCAG's 3:1 (1.4.11, 2.4.13) against what is behind it: the ancestors'
 * backgrounds, nearest first, painted from the first opaque one up, then the ring over them.
 */
function focusRingContrast(ring: string, backgrounds: string[]): string {
	const layers = backgrounds.map(channels);
	const base = layers.findIndex((layer) => layer[3] === 1);
	if (base < 0) throw new Error('no opaque background behind the ring');
	const behind = layers
		.slice(0, base)
		.reduceRight((under, layer) => paint(layer, under), layers[base]!);
	const ratio = contrast(hex(paint(channels(ring), behind)), hex(behind));
	return ratio >= 3 ? '≥ 3:1' : `${ratio.toFixed(2)}:1`;
}

/** Every axe test, for one theme: the body of each theme's spec file. */
export function a11ySuite(theme: 'dark' | 'light'): void {
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
				// Today on a blank profile: its setup card.
				if (path === '/today') await expect(page.getByTestId('today-setup')).toBeVisible();
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

		test('the keyboard focus ring reaches 3:1 against the page behind it', async ({ page }) => {
			await gotoHydrated(page, '/design');
			if (theme === 'light')
				await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
			// Arrow keys move the tablist's focus, so the ring shows as it does from the keyboard.
			const buttons = page.getByRole('tab', { name: 'Buttons' });
			await buttons.focus();
			await page.keyboard.press('ArrowRight');
			await page.keyboard.press('ArrowLeft');
			await expect(buttons).toBeFocused();
			const { outline, style, layers } = await buttons.evaluate((el) => {
				const css = getComputedStyle(el);
				// The ring is drawn outside the tab, over its ancestors' backgrounds.
				const backgrounds: string[] = [];
				for (let node = el.parentElement; node; node = node.parentElement) {
					backgrounds.push(getComputedStyle(node).backgroundColor);
				}
				return { outline: css.outlineColor, style: css.outlineStyle, layers: backgrounds };
			});
			expect(style).toBe('solid');
			expect(focusRingContrast(outline, layers), `${outline} on ${layers.join(' / ')}`).toBe(
				'≥ 3:1'
			);
		});

		test('a Profile section asking to discard its changes has no violations', async ({ page }) => {
			await page.goto('/profile/equipment');
			await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
			// A change that is never saved: nothing reaches the database.
			await page.getByRole('radio', { name: 'Strength club' }).check();
			// Leaving: Back on a phone; from 1024 px, where Back is hidden, another section.
			const leave = isDesktopPage(page)
				? page.getByRole('navigation', { name: 'Training profile' }).getByTestId('section-goals')
				: page.getByTestId('back-to-profile');
			await leave.click();
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
			// The tabs only switch once the page has hydrated: a tap before then changes nothing.
			await gotoHydrated(page, '/design');
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

		test.describe('/design → Workout', () => {
			// The history sheet's answer comes from page.route, which WebKit's service worker hides.
			test.use({ serviceWorkers: 'block' });

			// One test per state, each on a fresh panel: on WebKit a tap on /design takes about 1.5 s
			// and an audit over 3 s, so every state in one test ran past its 30 s, and no state's
			// audit depends on the taps before it.
			const states: [string, string, string, string][] = [
				['Barbell', 'Baseline', 'Superset partner', 'as it opens'],
				['Time', 'Swapped', 'Between exercises', 'swapped, between exercises'],
				['Assisted', 'Stopped', 'All done', 'stopped, all done'],
				['Distance', 'Checking', 'Superset partner', 'checking last time']
			];
			for (const [logger, card, upNext, name] of states) {
				test(`the workout panel, ${name}, has no violations`, async ({ page }) => {
					const panel = await openWorkoutPanel(page);
					await pick(panel, 'logger-kind', logger);
					await pick(panel, 'card-kind', card);
					await pick(panel, 'up-next-kind', upNext);
					await page.waitForTimeout(300);
					expect(await audit(page), name).toEqual([]);
				});
			}

			test('missed reps open, the history sheet over it, has no violations', async ({ page }) => {
				await answerHistory(page);
				const panel = await openWorkoutPanel(page);
				// The panel as the last state left it, as when every state shared one test.
				await pick(panel, 'card-kind', 'Checking');
				await pick(panel, 'logger-kind', 'Barbell');
				await panel.getByTestId('missed-toggle').click();
				await panel.getByTestId('open-history').click();
				await expect(page.getByTestId('history-best')).toBeVisible();
				await page.waitForTimeout(300);
				expect(await audit(page), 'missed reps open, the history sheet over it').toEqual([]);
			});
		});

		for (const coach of COACH_A11Y) {
			test(`${coach.name} has no violations`, async ({ page }) => {
				await coach.open(page);
				await page.waitForTimeout(300);
				expect(await audit(page)).toEqual([]);
			});
		}
	});
}
