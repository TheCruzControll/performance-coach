/**
 * Profile → Equipment, the first training-profile section edited at /profile/[section]. Serial
 * (one test at a time, after the functional suites): every test starts from a blank training
 * profile, which every browser and worker shares.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
	captureScreen,
	gotoHydrated,
	profileAction,
	query,
	resetTrainingProfile,
	toastWith,
	trackConsoleErrors
} from './support';

/** The URL pattern of a module's chunk in the build under test, from Vite's manifest. */
function chunkOf(source: string): string {
	const manifest = JSON.parse(
		readFileSync(
			path.resolve(import.meta.dirname, '../.svelte-kit/output/client/.vite/manifest.json'),
			'utf8'
		)
	) as Record<string, { file: string } | undefined>;
	const chunk = manifest[source];
	if (!chunk) throw new Error(`${source} is not in the build under test`);
	return `**/${chunk.file}`;
}

const EDITOR = 'src/lib/ui/profile/EquipmentEditor.svelte';

/** The editor has loaded in place of the skeleton. */
async function editorReady(page: Page) {
	await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
}

const place = (page: Page, name: string) => page.getByRole('radio', { name });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

test('Profile lists the equipment section, and it opens the editor', async ({ page }) => {
	const errors = trackConsoleErrors(page);
	await gotoHydrated(page, '/profile');
	await expect(page.getByText('Soon')).toHaveCount(0);
	// Security and the device preferences stay on Profile.
	await expect(page.getByTestId('security-link')).toBeVisible();
	await expect(page.getByTestId('theme-control')).toBeVisible();

	const row = page
		.getByRole('region', { name: 'Training profile' })
		.getByRole('link', { name: /Equipment/ });
	await expect(row).toHaveAttribute('href', '/profile/equipment');
	await row.click();
	await expect(page).toHaveURL('/profile/equipment');
	await expect(page.getByRole('heading', { level: 1, name: 'Equipment' })).toBeVisible();
	await editorReady(page);
	await expect(place(page, 'Commercial gym')).not.toBeChecked();
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth
	}));
	expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
	expect(errors).toEqual([]);
});

test('equipment saves, and is still there after a reload and in Postgres', async ({
	page
}, testInfo) => {
	await page.goto('/profile/equipment');
	await editorReady(page);
	await place(page, 'Commercial gym').check();
	const kit = page.getByRole('group', { name: 'What’s there?' });
	await kit.getByRole('checkbox', { name: 'Barbell & plates' }).check();
	await kit.getByRole('checkbox', { name: 'Squat rack' }).check();
	const atHome = page.getByRole('switch', { name: 'I also train at home' });
	await atHome.check();
	const home = page.getByRole('group', { name: 'At home' });
	await home.getByRole('checkbox', { name: 'Dumbbells' }).check();
	// Off hides and empties the home list; on again, before saving, brings the same kit back.
	await atHome.uncheck();
	await expect(home).toHaveCount(0);
	await atHome.check();
	await expect(home.getByRole('checkbox', { name: 'Dumbbells' })).toBeChecked();
	const notes = page.getByRole('textbox', { name: /Anything else/ });
	await notes.fill('Rack is free before 7am');

	// At the end of the page, the last field clears the Save bar.
	const save = page.getByTestId('save-section');
	await notes.scrollIntoViewIfNeeded();
	await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
	const field = (await notes.boundingBox())!;
	expect(field.y + field.height).toBeLessThanOrEqual((await save.boundingBox())!.y);

	// From the keyboard: the button is disabled while it saves, and gets its focus back after.
	await save.focus();
	await page.keyboard.press('Enter');
	await expect(toastWith(page, 'Saved')).toBeVisible();
	await expect(save).toBeFocused();
	await page.evaluate(() => scrollTo(0, 0));
	await captureScreen(page, testInfo, 'profile-equipment');
	expect(
		await query('select gym_type, equipment, home_equipment, notes from equipment_profiles')
	).toEqual([
		{
			gym_type: 'commercial',
			equipment: ['barbell', 'squat_rack'],
			home_equipment: ['dumbbells'],
			notes: 'Rack is free before 7am'
		}
	]);

	await page.reload();
	await editorReady(page);
	await expect(place(page, 'Commercial gym')).toBeChecked();
	await expect(kit.getByRole('checkbox', { name: 'Barbell & plates' })).toBeChecked();
	await expect(kit.getByRole('checkbox', { name: 'Squat rack' })).toBeChecked();
	await expect(kit.getByRole('checkbox', { name: 'Bench' })).not.toBeChecked();
	await expect(page.getByRole('switch', { name: 'I also train at home' })).toBeChecked();
	await expect(home.getByRole('checkbox', { name: 'Dumbbells' })).toBeChecked();
	await expect(notes).toHaveValue('Rack is free before 7am');

	// Nothing unsaved: leaving asks nothing.
	await page.getByTestId('back-to-profile').click();
	await expect(page).toHaveURL('/profile');
});

test('offline, Save says it can’t reach the server and keeps the change; online, it saves', async ({
	page,
	context
}) => {
	await page.goto('/profile/equipment');
	await editorReady(page);
	await place(page, 'Home or garage gym').check();
	await context.setOffline(true);
	await page.getByTestId('save-section').click();
	await expect(page.getByTestId('save-error')).toContainText('Can’t reach the server');
	await expect(place(page, 'Home or garage gym')).toBeChecked();
	expect(await query('select gym_type from equipment_profiles')).toEqual([]);

	await context.setOffline(false);
	await page.getByTestId('save-section').click();
	await expect(toastWith(page, 'Saved')).toBeVisible();
	await expect(page.getByTestId('save-error')).toHaveCount(0);
	expect(await query('select gym_type from equipment_profiles')).toEqual([{ gym_type: 'home' }]);
});

test.describe('with the network in the test’s hands', () => {
	// page.route never sees a request the service worker answers, and it precaches every chunk.
	test.use({ serviceWorkers: 'block' });

	test('a save that ends in a redirect (signed out elsewhere) goes through, unasked', async ({
		page
	}) => {
		await page.goto('/profile/equipment');
		await editorReady(page);
		await place(page, 'Home or garage gym').check();
		// What the guard answers a form action once the session has ended (src/lib/server/auth).
		await page.route(
			(url) => url.pathname === '/profile/equipment' && url.search === '?/save',
			(route) => route.fulfill({ json: { type: 'redirect', status: 303, location: '/today' } })
		);
		await page.getByTestId('save-section').click();
		await expect(page).toHaveURL('/today');
		await expect(page.getByTestId('discard-sheet')).toHaveCount(0);
		await expect(toastWith(page, 'Saved')).toHaveCount(0);
	});

	test('an editor that does not load shows a designed error, and Retry loads it', async ({
		page
	}) => {
		const chunk = chunkOf(EDITOR);
		await page.route(chunk, (route) => route.abort());
		await page.goto('/profile/equipment');
		await expect(page.getByTestId('editor-error')).toContainText('This section didn’t load');
		await expect(page.getByTestId('section-editor')).toHaveAttribute('aria-busy', 'false');
		await expect(page.getByTestId('save-section')).toBeDisabled();

		await page.unroute(chunk);
		await page.getByRole('button', { name: 'Retry' }).click();
		await editorReady(page);
		await expect(place(page, 'Commercial gym')).toBeVisible();
		await expect(page.getByTestId('save-section')).toBeEnabled();
	});

	test('the editor takes the skeleton’s place without moving anything', async ({ page }) => {
		await page.addInitScript(() => {
			const shifts: number[] = [];
			Object.assign(window, { __shifts: shifts });
			if (!PerformanceObserver.supportedEntryTypes.includes('layout-shift')) return; // WebKit
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries())
					shifts.push((entry as unknown as { value: number }).value);
			}).observe({ type: 'layout-shift', buffered: true });
		});
		// Hold the editor back, so the skeleton is on screen first.
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(chunkOf(EDITOR), async (route) => {
			await held;
			await route.continue();
		});
		await page.goto('/profile/equipment', { waitUntil: 'domcontentloaded' });
		const region = page.getByTestId('section-editor');
		const save = page.getByTestId('save-section');
		await expect(region).toHaveAttribute('aria-busy', 'true');
		await page.evaluate(() => document.fonts.ready);
		const shifts = () =>
			page.evaluate(() => (window as unknown as { __shifts: number[] }).__shifts);
		const before = {
			top: (await region.boundingBox())!.y,
			save: await save.boundingBox(),
			shifts: (await shifts()).length
		};

		release();
		await editorReady(page);
		expect((await region.boundingBox())!.y).toBe(before.top);
		expect(await save.boundingBox()).toEqual(before.save);
		expect((await shifts()).slice(before.shifts)).toEqual([]);
	});
});

test('leaving with unsaved changes asks first: Keep editing stays, Discard leaves', async ({
	page,
	request
}) => {
	await profileAction(request, '/profile/equipment?/save', {
		gymType: 'strength',
		equipment: ['barbell'],
		homeEquipment: [],
		notes: null
	});
	await gotoHydrated(page, '/profile');
	await page.getByRole('link', { name: /Equipment/ }).click();
	await editorReady(page);
	await expect(place(page, 'Strength club')).toBeChecked();
	await place(page, 'Minimal or travel').check();

	const sheet = page.getByTestId('discard-sheet');
	await page.getByTestId('back-to-profile').click();
	await expect(sheet.getByRole('heading', { name: 'Discard your changes?' })).toBeVisible();
	await expect(page).toHaveURL('/profile/equipment');
	await sheet.getByRole('button', { name: 'Keep editing' }).click();
	await expect(sheet).toBeHidden();
	await expect(place(page, 'Minimal or travel')).toBeChecked();

	// Discard goes where the tab bar was going, and stores nothing.
	await page
		.getByRole('navigation', { name: 'Primary' })
		.getByRole('link', { name: 'Today' })
		.click();
	await expect(sheet).toBeVisible();
	await sheet.getByRole('button', { name: 'Discard changes' }).click();
	await expect(page).toHaveURL('/today');
	expect(await query('select gym_type, equipment from equipment_profiles')).toEqual([
		{ gym_type: 'strength', equipment: ['barbell'] }
	]);

	// Back (the iOS swipe) asks too, and Discard then goes back.
	await page.evaluate(() => history.back());
	await expect(page).toHaveURL('/profile/equipment');
	await editorReady(page);
	await expect(place(page, 'Strength club')).toBeChecked();
	await place(page, 'Minimal or travel').check();
	await page.evaluate(() => history.back());
	await expect(sheet).toBeVisible();
	await expect(page).toHaveURL('/profile/equipment');
	await sheet.getByRole('button', { name: 'Discard changes' }).click();
	await expect(page).toHaveURL('/profile');
});

test('only the listed sections exist: any other key is the 404 page', async ({ page }) => {
	expect((await page.goto('/profile/equipment'))?.status()).toBe(200);
	for (const key of ['unknown', 'constructor']) {
		const response = await page.goto(`/profile/${key}`);
		expect(response?.status(), key).toBe(404);
		await expect(page.getByTestId('error-view')).toHaveAttribute('data-kind', 'not-found');
		await expect(page.getByRole('heading', { level: 1, name: 'Not found' })).toBeVisible();
	}
});
