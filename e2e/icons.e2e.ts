/**
 * Icons draw from one hashed, immutable, precached SVG sprite (`<use href="sprite#name">`), so no
 * route ships icon path data in its JavaScript (`pnpm budgets` guards the JS side). Here, in the
 * browser: every icon on every tab, Profile and /design draws, from the sprite; /design's gallery
 * names every icon; a label still makes an icon an image with that name; a sprite that arrives
 * late moves nothing; and offline, the precached sprite still draws every tab's icons.
 * Runs on Chromium and WebKit (the offline test on Chromium, as in offline.e2e.ts); it opts
 * into the desktop projects once they exist.
 */
import { expect, test, type Page } from '@playwright/test';
import { ICON_NAMES } from '../src/lib/ui/icons/names';
import { captureScreen, TABS, trackConsoleErrors } from './support';

/** The sprite Vite emits: hashed and immutable (never a data: URL, which <use> cannot draw). */
const SPRITE = /^(https?:\/\/[^/]+)?\/_app\/immutable\/assets\/sprite\.[\w-]+\.svg$/;

const visibleIcons = (page: Page) => page.locator('svg.icon:visible');

/**
 * Icons on screen that do not draw yet, by their <use> reference: a box with neither width nor
 * height. (getBBox leaves out the stroke, so a line such as `minus` has a width but no height.)
 */
function undrawn(page: Page) {
	return visibleIcons(page).evaluateAll((svgs) =>
		svgs.flatMap((svg) => {
			const use = svg.querySelector('use');
			const box = use?.getBBox();
			return box && box.width + box.height > 0 ? [] : [use?.getAttribute('href') ?? 'no <use>'];
		})
	);
}

async function expectEveryIconDrawn(page: Page) {
	await expect(visibleIcons(page).first()).toBeVisible();
	await expect
		.poll(() => undrawn(page), { message: 'every icon on screen draws a non-empty box' })
		.toEqual([]);
}

/** Every icon on screen is one <use> of a symbol the sprite has, and carries no path data. */
async function expectEveryIconFromSprite(page: Page, symbols: Set<string>) {
	const refs = await visibleIcons(page).evaluateAll((svgs) =>
		svgs.map((svg) => ({
			uses: svg.querySelectorAll('use').length,
			paths: svg.querySelectorAll('path').length,
			href: svg.querySelector('use')?.getAttribute('href') ?? ''
		}))
	);
	expect(refs.length).toBeGreaterThan(0);
	for (const { uses, paths, href } of refs) {
		expect({ uses, paths }, href).toEqual({ uses: 1, paths: 0 });
		const [file, name] = href.split('#');
		expect(file, href).toMatch(SPRITE);
		expect(symbols.has(name!), `the sprite has a symbol for ${href}`).toBe(true);
	}
}

async function spriteSymbols(page: Page, url: string): Promise<Set<string>> {
	const response = await page.request.get(url);
	expect(response.ok()).toBe(true);
	expect(response.headers()['content-type']).toMatch(/^image\/svg\+xml/);
	return new Set([...(await response.text()).matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]!));
}

/** The sprite the first icon on screen draws from (as an absolute URL). */
async function spriteUrlOf(page: Page) {
	const href = await visibleIcons(page)
		.first()
		.evaluate((svg) => svg.querySelector('use')?.getAttribute('href') ?? '');
	const file = href.split('#')[0]!;
	expect(file, 'icons draw with <use> from the hashed sprite file').toMatch(SPRITE);
	return new URL(file, page.url()).href;
}

const gallery = (page: Page) =>
	page.locator('section', { has: page.getByRole('heading', { name: 'Icons', exact: true }) });

test.describe('icons', () => {
	test('every tab, Profile and /design draw each icon from the sprite', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await page.goto('/today');
		const symbols = await spriteSymbols(page, await spriteUrlOf(page));
		expect([...symbols]).toEqual(ICON_NAMES);

		for (const tab of TABS) {
			await page.goto(tab.path);
			await expect(page.getByRole('heading', { level: 1, name: tab.heading })).toBeVisible();
			if (tab.path === '/profile') await expect(page.getByTestId('db-status')).toBeVisible();
			await expectEveryIconFromSprite(page, symbols);
			await expectEveryIconDrawn(page);
			// Five bottom-nav icons, each drawn: the tab bar is the icon set's busiest surface.
			const nav = page.getByRole('navigation', { name: 'Primary' });
			await expect(nav.locator('svg.icon')).toHaveCount(TABS.length);
			await captureScreen(page, testInfo, `icons${tab.path.replaceAll('/', '-')}`);
		}

		await page.goto('/design');
		await expect(gallery(page).locator('svg.icon')).toHaveCount(ICON_NAMES.length);
		await expectEveryIconFromSprite(page, symbols);
		await expectEveryIconDrawn(page);
		await gallery(page).scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'icons-design-gallery');
		expect(errors).toEqual([]);
	});

	test('/design’s gallery names every icon; a label makes an icon an image with that name', async ({
		page
	}) => {
		await page.goto('/design');
		const images = gallery(page).getByRole('img');
		await expect(images).toHaveCount(ICON_NAMES.length);
		for (const name of ICON_NAMES) {
			const icon = gallery(page).getByRole('img', { name, exact: true });
			await expect(icon).toBeVisible();
			await expect(icon).not.toHaveAttribute('aria-hidden', /.*/);
			await expect(icon.locator('use')).toHaveAttribute('href', new RegExp(`#${name}$`));
		}
		// Unlabelled icons stay decorative: hidden from assistive technology, no role.
		await page.goto('/today');
		const navIcons = page.getByRole('navigation', { name: 'Primary' }).locator('svg.icon');
		await expect(navIcons).toHaveCount(TABS.length);
		for (const icon of await navIcons.all()) {
			await expect(icon).toHaveAttribute('aria-hidden', 'true');
			await expect(icon).not.toHaveAttribute('role', /.*/);
		}
	});

	test('a sprite that arrives late moves nothing: icons keep their boxes', async ({
		page,
		browserName
	}) => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		let requested = false;
		await page.route(SPRITE, async (route) => {
			requested = true;
			await held;
			await route.continue();
		});
		// Requests in flight, and when that last changed: to tell when only the sprite is left.
		let inflight = 0;
		let changedAt = Date.now();
		const track = (delta: number) => () => {
			inflight += delta;
			changedAt = Date.now();
		};
		page.on('request', track(1));
		page.on('requestfinished', track(-1));
		page.on('requestfailed', track(-1));
		// Not `load`: the held sprite would hold the load event too.
		await page.goto('/today', { waitUntil: 'domcontentloaded' });
		const nav = page.getByRole('navigation', { name: 'Primary' });
		await expect(nav.locator('svg.icon')).toHaveCount(TABS.length);
		const boxes = () =>
			visibleIcons(page).evaluateAll((svgs) =>
				svgs.map((svg) => {
					const { x, y, width, height } = svg.getBoundingClientRect();
					return { x, y, width, height };
				})
			);
		// Let everything else finish first (the code hydrates, the fonts swap in with a layout
		// shift of their own), so that whatever moves after the release is the sprite's doing.
		await expect.poll(() => requested, { message: 'the page asks for the sprite' }).toBe(true);
		await expect
			.poll(() => inflight === 1 && Date.now() - changedAt > 500, {
				message: 'only the held sprite is still loading'
			})
			.toBe(true);
		const releasedAt = await page.evaluate(async () => {
			await document.fonts.ready;
			await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			return performance.now();
		});
		const before = await boxes();
		expect((await undrawn(page)).length, 'nothing draws while the sprite is held').toBe(
			before.length
		);
		release();
		await expectEveryIconDrawn(page);
		expect(await boxes()).toEqual(before);
		if (browserName === 'chromium') {
			// Layout Instability is Chromium's: no shift once the sprite has arrived.
			const shift = await page.evaluate(
				(since) =>
					new Promise<number>((resolve) => {
						new PerformanceObserver((list) => {
							resolve(
								list
									.getEntries()
									.filter((e) => e.startTime >= since)
									.reduce((sum, e) => sum + (e as unknown as { value: number }).value, 0)
							);
						}).observe({ type: 'layout-shift', buffered: true });
						setTimeout(() => resolve(0), 500);
					}),
				releasedAt
			);
			expect(shift).toBe(0);
		}
	});

	test('offline, switching tabs still draws every icon: the sprite is precached', async ({
		page,
		context,
		browserName
	}) => {
		test.skip(browserName !== 'chromium', 'offline emulation is Chromium-only');
		await page.goto('/today');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		const sprite = await spriteUrlOf(page);
		expect(
			await page.evaluate(async (url) => (await caches.match(url))?.ok ?? false, sprite),
			'the service worker precached the sprite at install'
		).toBe(true);

		await context.setOffline(true);
		const nav = page.getByRole('navigation', { name: 'Primary' });
		for (const tab of [...TABS.slice(1), TABS[0]]) {
			await nav.getByRole('link', { name: tab.label }).click();
			await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
			await expect(page.getByRole('heading', { level: 1, name: tab.heading })).toBeVisible();
			await expectEveryIconDrawn(page);
		}
		// A fresh document offline (the precached offline screen) draws from the precache too.
		await nav.getByRole('link', { name: 'Profile' }).click();
		await page.reload();
		await expect(page.getByTestId('offline-state')).toBeVisible();
		expect(await spriteUrlOf(page)).toBe(sprite);
		await expectEveryIconDrawn(page);
		await context.setOffline(false);
	});
});
