/**
 * Profile in a desktop window (docs/design-system.md, Responsive layout → Screens): Profile's list
 * 400 px wide beside About this app, and each training-profile section's editor beside the same
 * list, behind a hairline: a 440 px form with Save 260 px wide 40 px under it. Every designed
 * state of the editor is checked in the split layout, with a screenshot and axe in both themes;
 * the phone keeps its list → editor → back flow. Serial (one test at a time, after the functional suites): every test starts from a
 * blank training profile, which every browser and worker shares.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { SECTIONS } from '../src/lib/ui/profile/sections';
import {
	BELOW_DESKTOP_WIDTH,
	DESKTOP,
	DESKTOP_WIDTHS,
	boxOf,
	expectMainCentred,
	expectNoShift,
	expectNoSideScroll,
	tokenPx
} from './desktop';
import {
	captureScreen,
	gotoHydrated,
	query,
	resetTrainingProfile,
	toastWith,
	trackConsoleErrors
} from './support';

const CLIENT = path.resolve(import.meta.dirname, '../.svelte-kit/output/client');

/** The URL pattern of a module's chunk in the build under test, from Vite's manifest. */
function chunkOf(source: string): string {
	const manifest = JSON.parse(readFileSync(`${CLIENT}/.vite/manifest.json`, 'utf8')) as Record<
		string,
		{ file: string } | undefined
	>;
	const chunk = manifest[source];
	if (!chunk) throw new Error(`${source} is not in the build under test`);
	return `**/${chunk.file}`;
}

const THEMES = ['dark', 'light'] as const;

const list = (page: Page) => page.getByRole('navigation', { name: 'Profile' });
const column = (page: Page) => page.getByTestId('section-column');
const editor = (page: Page) => page.getByTestId('section-editor');
const saveBar = (page: Page) => page.getByTestId('save-bar');
const save = (page: Page) => page.getByTestId('save-section');
const place = (page: Page, name: string) => page.getByRole('radio', { name });

/** The editor has loaded under the title. */
async function editorReady(page: Page) {
	await expect(editor(page)).toHaveAttribute('aria-busy', 'false');
}

/** The page's fonts have loaded; never `document.fonts.ready`, which WebKit holds with a request. */
const fontsLoaded = (page: Page) => page.waitForFunction(() => document.fonts.status === 'loaded');

/**
 * axe (WCAG 2.1 A/AA) and a screenshot of the page as it stands, in each theme. `held`: a request
 * is being held, so the screenshot is taken directly (captureScreen waits on `fonts.ready`).
 */
async function auditBothThemes(page: Page, testInfo: TestInfo, name: string, held = false) {
	for (const theme of THEMES) {
		await page.evaluate((t) => {
			if (t === 'dark') delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = t;
		}, theme);
		await page.waitForTimeout(250); // colour transitions
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		expect(
			violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`)),
			`${name} (${theme})`
		).toEqual([]);
		const shot = `${name}-${theme}`;
		if (held) {
			await page.screenshot({
				path: `test-results/screens/${testInfo.project.name}/${shot}.png`,
				animations: 'disabled'
			});
		} else {
			await captureScreen(page, testInfo, shot);
		}
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

/** `inner` lies within `outer`'s left and right edges (±1 px). */
async function expectWithin(page: Page, inner: Locator, outer = column(page)) {
	const [a, b] = [await boxOf(inner), await boxOf(outer)];
	expect(a.x, `${inner} starts inside ${outer}`).toBeGreaterThanOrEqual(b.x - 1);
	expect(a.x + a.width, `${inner} ends inside ${outer}`).toBeLessThanOrEqual(b.x + b.width + 1);
}

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test.describe('in a desktop window', () => {
	test.use(DESKTOP);

	test('Profile shows its list beside About this app, behind a hairline', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await gotoHydrated(page, '/profile');
		await expect(page.getByTestId('db-status')).toBeVisible();
		await expectMainCentred(page, await tokenPx(page, '--content-profile'));
		await expectNoSideScroll(page);

		// Paper, 14 · "Profile, goals": the list 400 px wide in 44 px rows with no chevrons, and
		// the open side 456 px (the list and 56 px) right of it, behind a 1 px hairline.
		const profileList = page.getByTestId('profile-list');
		const listBox = await boxOf(profileList);
		expect(Math.abs(listBox.width - 400), 'the list is 400 px wide').toBeLessThanOrEqual(1);
		const first = await boxOf(profileList.getByRole('link').first());
		expect(Math.abs(first.height - 44), 'a row is 44 px tall').toBeLessThanOrEqual(1);
		await expect(profileList.locator('.chevron').filter({ visible: true })).toHaveCount(0);
		const about = page.getByTestId('system-card').locator('..');
		const aboutBox = await boxOf(about);
		expect(Math.abs(aboutBox.x - listBox.x - 456)).toBeLessThanOrEqual(1);
		await expect(about).toHaveCSS('border-left-width', '1px');
		// Nothing is open on Profile itself: no row is current.
		await expect(profileList.getByRole('link', { name: /Equipment/ })).toBeVisible();
		await expect(profileList.locator('[aria-current]')).toHaveCount(0);
		await auditBothThemes(page, testInfo, 'profile-desktop');
		expect(errors).toEqual([]);
	});

	test('a section opens beside the list, saves from its column, and is still there after a reload and in Postgres', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await gotoHydrated(page, '/profile/equipment');
		await editorReady(page);
		await expectMainCentred(page, await tokenPx(page, '--content-profile'));
		await expectNoSideScroll(page);

		// The list on the left, the open section marked, the editor on the right.
		const current = list(page).getByRole('link', { name: /Equipment/ });
		await expect(current).toHaveAttribute('aria-current', 'page');
		await expect(list(page).locator('[aria-current]')).toHaveCount(1);
		// Every section, Appearance, and Passkeys and recovery.
		await expect(list(page).getByRole('link')).toHaveCount(SECTIONS.length + 2);
		const [nav, editorColumn] = [await boxOf(list(page)), await boxOf(column(page))];
		expect(editorColumn.x).toBeGreaterThanOrEqual(nav.x + nav.width);
		// 576 px, its hairline and 56 px inside it (Profile's measure, layout.css).
		expect(Math.abs(editorColumn.width - 576)).toBeLessThanOrEqual(1);
		// Back is the phone's: the list says where you are.
		await expect(page.getByTestId('back-to-profile')).toBeHidden();
		// Paper, 14 · "Profile, schedule": the title is 32/38, and the form 440 px of the column.
		await expect(page.getByRole('heading', { level: 1, name: 'Equipment' })).toHaveCSS(
			'font-size',
			'32px'
		);
		expect(Math.abs((await boxOf(editor(page))).width - 440)).toBeLessThanOrEqual(1);
		await expectWithin(page, saveBar(page));

		await place(page, 'Commercial gym').check();
		const kit = page.getByRole('group', { name: 'What’s there?' });
		await kit.getByRole('checkbox', { name: 'Barbell & plates' }).check();
		await save(page).click();
		await expect(toastWith(page, 'Saved')).toBeVisible();
		await expectWithin(page, saveBar(page));
		expect(await query('select gym_type, equipment from equipment_profiles')).toEqual([
			{ gym_type: 'commercial', equipment: ['barbell'] }
		]);
		await page.evaluate(() => scrollTo(0, 0));
		await auditBothThemes(page, testInfo, 'profile-equipment-desktop');

		await page.reload();
		await editorReady(page);
		await expect(place(page, 'Commercial gym')).toBeChecked();
		await expect(kit.getByRole('checkbox', { name: 'Barbell & plates' })).toBeChecked();
		expect(errors).toEqual([]);
	});

	test('Save sits 40 px under the form, 260 px wide, and scrolls with it', async ({ page }) => {
		await gotoHydrated(page, '/profile/schedule');
		await editorReady(page);
		// Paper, 14 · "Profile, schedule": not pinned, in the column's flow after the form.
		await expect(saveBar(page)).toHaveCSS('position', 'static');
		const [form, bar, button] = [
			await boxOf(editor(page)),
			await boxOf(saveBar(page)),
			await boxOf(save(page))
		];
		expect(Math.abs(button.width - 260), 'Save is 260 px wide').toBeLessThanOrEqual(1);
		expect(Math.abs(button.x - form.x), 'Save starts where the form does').toBeLessThanOrEqual(1);
		expect(
			Math.abs(bar.y - (form.y + form.height) - 40),
			'Save sits 40 px under the form'
		).toBeLessThanOrEqual(1);
		await expectWithin(page, saveBar(page));

		// Scrolled, it moves with the form.
		await page.evaluate(() => scrollTo(0, 200));
		await expect
			.poll(async () => {
				const [moved, under] = [await boxOf(editor(page)), await boxOf(saveBar(page))];
				return Math.round(under.y - (moved.y + moved.height));
			})
			.toBe(40);
	});

	test('choosing another section asks first with unsaved changes, and simply goes without', async ({
		page
	}) => {
		await gotoHydrated(page, '/profile/equipment');
		await editorReady(page);
		// Without changes: straight there.
		await list(page)
			.getByRole('link', { name: /Schedule/ })
			.click();
		await expect(page).toHaveURL('/profile/schedule');
		await editorReady(page);
		// The sheet loads with the section's editor, so it is in the page, closed.
		await expect(page.getByTestId('discard-sheet')).toBeHidden();
		await expect(list(page).getByRole('link', { name: /Schedule/ })).toHaveAttribute(
			'aria-current',
			'page'
		);

		await list(page)
			.getByRole('link', { name: /Equipment/ })
			.click();
		await expect(page).toHaveURL('/profile/equipment');
		await editorReady(page);
		await place(page, 'Strength club').check();
		const sheet = page.getByTestId('discard-sheet');
		await list(page).getByRole('link', { name: /Goals/ }).click();
		await expect(sheet.getByRole('heading', { name: 'Discard your changes?' })).toBeVisible();
		await expect(page).toHaveURL('/profile/equipment');
		await sheet.getByRole('button', { name: 'Discard changes' }).click();
		await expect(page).toHaveURL('/profile/goals');
		await editorReady(page);
		expect(await query('select gym_type from equipment_profiles')).toEqual([]);
	});

	test('the goal sheet opens centred, and Escape returns focus', async ({ page }) => {
		await gotoHydrated(page, '/profile/goals');
		await editorReady(page);
		const opener = page.getByTestId('goal-path-event');
		await opener.click();
		const dialog = page.getByTestId('goal-sheet');
		await expect(dialog.getByRole('heading', { name: 'New goal' })).toBeVisible();
		await expect(dialog).toHaveClass(/\bvisible\b/);
		const panel = dialog.locator('.sheet');
		await expect.poll(() => panel.evaluate((el) => el.getAnimations().length)).toBe(0);
		const [box, window] = [await boxOf(panel), await boxOf(dialog)];
		expect(Math.abs(box.x + box.width / 2 - (window.x + window.width / 2))).toBeLessThanOrEqual(2);
		expect(Math.abs(box.y + box.height / 2 - (window.y + window.height / 2))).toBeLessThanOrEqual(
			2
		);
		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(opener).toBeFocused();
	});

	test('Tab goes from the list to the editor, then to Save', async ({ page }) => {
		await gotoHydrated(page, '/profile/equipment');
		await editorReady(page);
		const links = list(page).getByRole('link');
		await links.last().focus();
		await page.keyboard.press('Tab');
		const inEditor = () =>
			page.evaluate(() => !!document.activeElement?.closest('[data-testid="section-editor"]'));
		expect(await inEditor(), 'the editor’s first control follows the list').toBe(true);

		await page.getByRole('textbox', { name: /Anything else/ }).focus();
		await page.keyboard.press('Tab');
		await expect(save(page)).toBeFocused();
	});

	test('no section scrolls sideways, at any desktop width or just below', async ({ page }) => {
		test.setTimeout(60_000);
		for (const { key } of SECTIONS) {
			await gotoHydrated(page, `/profile/${key}`);
			await editorReady(page);
			await expectNoSideScroll(page);
		}
		for (const width of [...DESKTOP_WIDTHS, BELOW_DESKTOP_WIDTH]) {
			await page.setViewportSize({ width, height: 900 });
			await gotoHydrated(page, '/profile/schedule');
			await editorReady(page);
			await expectNoSideScroll(page);
		}
	});

	test('saving offline says so in the editor column and keeps the change; online, it saves', async ({
		page,
		context
	}, testInfo) => {
		await gotoHydrated(page, '/profile/equipment');
		await editorReady(page);
		await place(page, 'Home or garage gym').check();
		await context.setOffline(true);
		await save(page).click();
		const error = page.getByTestId('save-error');
		await expect(error).toContainText('Can’t reach the server');
		await expectWithin(page, error);
		await expectWithin(page, saveBar(page));
		await expect(place(page, 'Home or garage gym')).toBeChecked();
		await auditBothThemes(page, testInfo, 'profile-save-offline-desktop');

		await context.setOffline(false);
		await save(page).click();
		await expect(toastWith(page, 'Saved')).toBeVisible();
		await expect(error).toHaveCount(0);
		expect(await query('select gym_type from equipment_profiles')).toEqual([{ gym_type: 'home' }]);
	});

	test('an unknown section is the 404 page, inside the shell and centred', async ({
		page
	}, testInfo) => {
		const response = await page.goto('/profile/unknown');
		expect(response?.status()).toBe(404);
		await expect(page.getByTestId('error-view')).toHaveAttribute('data-kind', 'not-found');
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
		await expect(list(page)).toHaveCount(0);
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));
		await expectWithin(page, page.getByTestId('error-view'), page.locator('main#main'));
		await expectNoSideScroll(page);
		await auditBothThemes(page, testInfo, 'profile-not-found-desktop');
	});

	test.describe('with the network in the test’s hands', () => {
		// page.route never sees a request the service worker answers, and it precaches every chunk.
		test.use({ serviceWorkers: 'block' });

		test('while the editor loads the screen is its title, and the editor arrives under it', async ({
			page
		}, testInfo) => {
			// Name & units: a short editor, inside the room the title's screen keeps.
			const chunk = chunkOf('src/lib/ui/profile/BasicsEditor.svelte');
			let release!: () => void;
			const held = new Promise<void>((resolve) => (release = resolve));
			await page.route(chunk, async (route) => {
				await held;
				await route.continue();
			});
			const asked = page.waitForRequest(chunk);
			await page.goto('/profile/basics', { waitUntil: 'domcontentloaded' });
			await asked;
			await expect(editor(page)).toHaveAttribute('aria-busy', 'true');
			await fontsLoaded(page);
			// No skeleton, and no Save until there is an editor to save.
			await expect(editor(page).locator('.skeleton')).toHaveCount(0);
			await expect(save(page)).toHaveCount(0);
			await auditBothThemes(page, testInfo, 'profile-loading-desktop', true);

			await expectNoShift(page, {
				action: async () => {
					release();
					await editorReady(page);
				},
				boxes: [page.getByRole('heading', { level: 1, name: 'Name and units' })]
			});
			await expect(page.getByTestId('basics-name')).toBeVisible();
			await expectWithin(page, saveBar(page));
		});

		test('an editor that does not load shows its error with Retry in the editor column', async ({
			page
		}, testInfo) => {
			const chunk = chunkOf('src/lib/ui/profile/EquipmentEditor.svelte');
			await page.route(chunk, (route) => route.abort());
			await page.goto('/profile/equipment');
			const error = page.getByTestId('editor-error');
			await expect(error).toContainText('Equipment didn’t load');
			const retry = page.getByRole('button', { name: 'Try again' });
			await expectWithin(page, error);
			await expectWithin(page, retry);
			// No Save without an editor.
			await expect(save(page)).toHaveCount(0);
			await auditBothThemes(page, testInfo, 'profile-editor-error-desktop');

			await page.unroute(chunk);
			await retry.click();
			await editorReady(page);
			await expect(place(page, 'Commercial gym')).toBeVisible();
			await expect(save(page)).toBeEnabled();
		});
	});
});

test.describe('on an iPhone', () => {
	// page.route never sees a request the service worker answers.
	test.use({ serviceWorkers: 'block' });

	test('the list stays on Profile, the loading editor keeps 28rem, and Save comes fixed above the tab bar', async ({
		page
	}) => {
		const chunk = chunkOf('src/lib/ui/profile/EquipmentEditor.svelte');
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(chunk, async (route) => {
			await held;
			await route.continue();
		});
		await page.goto('/profile/equipment', { waitUntil: 'domcontentloaded' });
		await expect(editor(page)).toHaveAttribute('aria-busy', 'true');
		await fontsLoaded(page);
		await expect(list(page)).toBeHidden();
		await expect(page.getByTestId('back-to-profile')).toBeVisible();
		// The title alone: the editor's room is kept, and Save waits for the editor.
		await expect(page.getByRole('heading', { level: 1, name: 'Equipment' })).toHaveCSS(
			'font-size',
			'40px'
		);
		expect(await editor(page).evaluate((el) => getComputedStyle(el).minHeight)).toBe('448px');
		await expect(saveBar(page)).toHaveCount(0);
		release();
		await editorReady(page);
		await expect(saveBar(page)).toHaveCSS('position', 'fixed');
		const [bar, tabs] = [
			await boxOf(saveBar(page)),
			await boxOf(page.getByRole('navigation', { name: 'Primary' }))
		];
		expect(bar.y + bar.height).toBeLessThanOrEqual(tabs.y + 1);
	});
});
