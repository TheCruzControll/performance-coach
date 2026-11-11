/**
 * The design switch (src/lib/client/design.ts): today's design stays the default and loads none of
 * the Graphite 2004 preview; ?design=graphite and Profile → Appearance → Design switch to it before
 * first paint and back; the choice is remembered on this device; and Graphite passes axe on the
 * main screens in both themes. The desktop window is design-switch.desktop.e2e.ts.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { audit } from './a11y-suite';
import { gotoHydrated, signedOut, TABS } from './support';

/** Graphite's stylesheet and font as the build names them (src/lib/client/design.ts DESIGN_ASSET). */
const GRAPHITE_FILE = /\/(graphite|source-sans-3-latin-wght-normal)\.[\w-]+\.(css|woff2)$/;
const DESIGN_KEY = 'pc:design:v1';
/** The accent each design paints with: volt today, Aqua in Graphite. */
const ACCENT = { current: '#c8f031', graphite: '#1a6bd6' } as const;

/** Every Graphite file this context requests, the service worker's included. */
function graphiteRequests(context: BrowserContext): string[] {
	const seen: string[] = [];
	context.on('request', (request) => {
		const { pathname } = new URL(request.url());
		if (GRAPHITE_FILE.test(pathname)) seen.push(pathname);
	});
	return seen;
}

/** The font families with a face this page has loaded. */
const loadedFaces = (page: Page) =>
	page.evaluate(() =>
		[...document.fonts]
			.filter((face) => face.status === 'loaded')
			.map((face) => face.family.replace(/["']/g, ''))
	);

const accent = (page: Page) =>
	page.evaluate(() =>
		getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim()
	);

/** The design the page shows: its attribute, the accent it paints and the face its text is set in. */
async function expectDesign(page: Page, design: 'current' | 'graphite') {
	const html = page.locator('html');
	if (design === 'graphite') await expect(html).toHaveAttribute('data-design', 'graphite');
	else await expect(html).not.toHaveAttribute('data-design', /.*/);
	await expect.poll(() => accent(page)).toBe(ACCENT[design]);
	await page.waitForFunction(() => document.fonts.status === 'loaded');
	const font = await page.evaluate(() =>
		getComputedStyle(document.body).fontFamily.split(',')[0]!.replace(/["']/g, '').trim()
	);
	expect(font).toBe(design === 'graphite' ? 'Source Sans 3' : 'Mona Sans');
	await expect(page.locator('link[data-design]')).toHaveCount(design === 'graphite' ? 2 : 0);
}

test('today’s design is the default and loads none of Graphite, not even into the offline cache', async ({
	page,
	context
}) => {
	const requested = graphiteRequests(context);
	await gotoHydrated(page, '/today');
	await expectDesign(page, 'current');
	expect(await loadedFaces(page)).not.toContain('Source Sans 3');

	// The service worker installs (src/lib/client/service-worker.ts) and precaches the build.
	await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
		timeout: 15_000
	});
	const cached = await page.evaluate(async () => {
		const urls: string[] = [];
		for (const name of await caches.keys()) {
			for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
		}
		return urls.map((url) => new URL(url).pathname);
	});
	expect(
		cached.some((path) => path.endsWith('.woff2')),
		'the precache holds today’s font'
	).toBe(true);
	expect(cached.filter((path) => GRAPHITE_FILE.test(path))).toEqual([]);
	expect(requested).toEqual([]);
});

test('?design=graphite switches this device to Graphite, remembered until ?design=current', async ({
	page,
	context
}) => {
	const requested = graphiteRequests(context);
	await gotoHydrated(page, '/today?design=graphite');
	await expectDesign(page, 'graphite');
	expect(requested.some((path) => path.endsWith('.css'))).toBe(true);
	expect(requested.some((path) => path.endsWith('.woff2'))).toBe(true);
	expect(await loadedFaces(page)).toContain('Source Sans 3');

	// A later visit with no parameter, and a page the app navigates to, keep it.
	await gotoHydrated(page, '/train');
	await expectDesign(page, 'graphite');
	await page
		.getByRole('navigation', { name: 'Primary' })
		.getByRole('link', { name: 'Profile' })
		.click();
	await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
	await expectDesign(page, 'graphite');

	await gotoHydrated(page, '/train?design=current');
	await expectDesign(page, 'current');
	await gotoHydrated(page, '/today');
	await expectDesign(page, 'current');
	expect(await page.evaluate((key) => localStorage.getItem(key), DESIGN_KEY)).toBe('current');
});

test('Profile → Appearance → Design switches at once, survives a reload, and switches back', async ({
	page
}) => {
	await gotoHydrated(page, '/profile');
	const control = page.getByRole('radiogroup', { name: 'Design' });
	await expect(control).toBeVisible();
	await expect(page.getByText('Graphite 2004 is a preview of the proposed design.')).toBeVisible();
	const current = control.getByRole('radio', { name: 'Current', exact: true });
	const graphite = control.getByRole('radio', { name: 'Graphite 2004', exact: true });
	await expect(current).toBeChecked();

	// A 44 px target: a tap just above the option's face, inside its hit area, still chooses it.
	// The control sits below the fold, and a raw tap does not scroll: bring it clear of the tab bar.
	await graphite.evaluate((option) => option.scrollIntoView({ block: 'center' }));
	const face = (await graphite.boundingBox())!;
	expect(face.height).toBeLessThan(44);
	await page.mouse.click(face.x + face.width / 2, face.y - (44 - face.height) / 2 + 2);
	await expect(graphite).toBeChecked();
	await expectDesign(page, 'graphite');

	await page.reload();
	await page.waitForLoadState('networkidle');
	await expectDesign(page, 'graphite');
	await expect(graphite).toBeChecked();

	await current.click();
	await expect(current).toBeChecked();
	await expectDesign(page, 'current');
	await page.reload();
	await page.waitForLoadState('networkidle');
	await expectDesign(page, 'current');
	await expect(current).toBeChecked();
});

test.describe('with the network in the test’s hands', () => {
	// page.route never sees a request the service worker answers.
	test.use({ serviceWorkers: 'block' });

	test('Graphite applies before first paint: nothing paints until its stylesheet arrives', async ({
		page
	}) => {
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(/\/graphite\.[\w-]+\.css$/, async (route) => {
			await held;
			await route.continue();
		});
		await page.goto('/today?design=graphite', { waitUntil: 'commit' });
		// The parser has reached the page's content while the stylesheet is still held (polled on a
		// timer: no animation frame runs while rendering is blocked).
		await page.waitForFunction(() => document.querySelector('main') !== null, null, {
			polling: 100
		});
		await page.waitForTimeout(500);
		const paints = () =>
			page.evaluate(() => performance.getEntriesByName('first-contentful-paint').length);
		expect(await paints(), 'nothing painted in today’s design while Graphite loads').toBe(0);

		release();
		await expectDesign(page, 'graphite');
		const measured = await page.evaluate(() =>
			PerformanceObserver.supportedEntryTypes.includes('paint')
		);
		if (measured) await expect.poll(paints).toBe(1);
	});
});

/** The screens Graphite is audited on: the five tabs and the design system's own page. */
const SCREENS = [...TABS.map((tab) => tab.path), '/design'];

for (const theme of ['dark', 'light'] as const) {
	test.describe(`accessibility (axe, Graphite, ${theme} theme)`, () => {
		test.beforeEach(async ({ page }) => {
			await page.addInitScript(
				([t, key]) => {
					localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t }));
					localStorage.setItem(key!, 'graphite');
				},
				[theme, DESIGN_KEY]
			);
		});

		const settle = async (page: Page) => {
			await expect(page.locator('html')).toHaveAttribute('data-design', 'graphite');
			if (theme === 'light')
				await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
			await expect.poll(() => accent(page)).toBe(ACCENT.graphite);
			await page.waitForFunction(() => document.fonts.status === 'loaded');
			// Entrance transitions settle, so contrast is measured on the final colours.
			await page.waitForTimeout(400);
		};

		for (const path of SCREENS) {
			test(`${path} has no WCAG A/AA violations`, async ({ page }) => {
				expect((await page.goto(path))?.status(), path).toBe(200);
				await page.waitForLoadState('networkidle');
				if (path === '/profile') await expect(page.getByTestId('db-status')).toBeVisible();
				await settle(page);
				expect(await audit(page)).toEqual([]);
			});
		}

		test.describe('signed out', () => {
			test.use({ storageState: signedOut });
			test('/ has no WCAG A/AA violations', async ({ page }) => {
				await page.goto('/');
				await page.waitForLoadState('networkidle');
				await settle(page);
				expect(await audit(page)).toEqual([]);
			});
		});
	});
}
