/**
 * The screens on main that M2 and M3 are not rewriting, in a desktop window
 * (docs/design-system.md, Responsive layout → Screens): Progress is wide, its three tiles in one
 * row over a wider panel; Coach and Security keep the readable column, Coach's suggestions in two
 * columns; the design gallery widens with its groups side by side; error and offline states stay
 * centred, inside the shell and outside it.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
	BELOW_DESKTOP_WIDTH,
	DESKTOP,
	DESKTOP_WIDTHS,
	expectCentredOver,
	expectMainCentred,
	expectNoSideScroll,
	layoutWidth,
	tokenPx
} from './desktop';
import { captureScreen, gotoHydrated } from './support';

test.use(DESKTOP);

const THEMES = ['dark', 'light'] as const;

/** Every screen this spec lays out, with the name its screenshots are filed under. */
const SCREENS = [
	{ path: '/progress', name: 'progress' },
	{ path: '/coach', name: 'coach' },
	{ path: '/profile/security', name: 'security' },
	{ path: '/design', name: 'design' },
	{ path: '/today/unknown', name: 'not-found-in-shell' },
	{ path: '/nothing-here', name: 'not-found' },
	{ path: '/offline', name: 'offline' }
] as const;

/** Anything Tab stops at, unless disabled or taken out of the order. */
const TABBABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
	'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const mainOf = (page: Page) => page.locator('main#main');

async function boxOf(locator: Locator) {
	const box = await locator.boundingBox();
	expect(box, `${locator} is on the page`).not.toBeNull();
	return box!;
}

const centreX = (box: { x: number; width: number }) => box.x + box.width / 2;

/** Open a screen in a theme: the stored preference applies before first paint. */
async function openInTheme(page: Page, path: string, theme: (typeof THEMES)[number]) {
	await page.addInitScript(
		(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
		theme
	);
	await page.goto(path);
	await page.waitForLoadState('networkidle');
	if (theme === 'light') await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await page.evaluate(() => document.fonts.ready);
}

/** A section of /design, by its heading. */
const gallerySection = (page: Page, title: string) =>
	page.locator('main#main > section').filter({
		has: page.getByRole('heading', { level: 2, name: title, exact: true })
	});

test.describe('Progress', () => {
	test('is wide: the three tiles share one row over a panel wider than the readable column', async ({
		page
	}) => {
		await gotoHydrated(page, '/progress');
		await expectMainCentred(page, await tokenPx(page, '--content-wide'));
		const readable = await tokenPx(page, '--content-readable');
		for (const tab of ['Strength', 'Running', 'General']) {
			await page.getByRole('tab', { name: tab }).click();
			const panel = page.getByRole('tabpanel');
			const tiles = await panel.locator('.metrics > *').all();
			expect(tiles, tab).toHaveLength(3);
			const boxes = [];
			for (const tile of tiles) boxes.push(await boxOf(tile));
			for (const [i, box] of boxes.entries()) {
				expect(
					Math.abs(box.y - boxes[0]!.y),
					`${tab}: tile ${i + 1} is in the first row`
				).toBeLessThanOrEqual(1);
				if (i > 0)
					expect(box.x, `${tab}: tile ${i + 1} is right of the one before`).toBeGreaterThan(
						boxes[i - 1]!.x + boxes[i - 1]!.width
					);
			}
			const chart = await boxOf(panel.locator('.metrics + *'));
			expect(chart.width, `${tab}: the chart panel is wider than 40rem`).toBeGreaterThan(readable);
			const row = boxes.at(-1)!.x + boxes.at(-1)!.width - boxes[0]!.x;
			expect(Math.abs(row - chart.width), `${tab}: the tiles span the panel`).toBeLessThanOrEqual(
				1
			);
		}
	});
});

test.describe('Coach', () => {
	test('its suggestions sit in two columns, under a composer centred over the column', async ({
		page
	}) => {
		await gotoHydrated(page, '/coach');
		await page.evaluate(() => document.fonts.ready);
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));
		const prompts = await page.locator('.prompt').all();
		expect(prompts).toHaveLength(4);
		const boxes = [];
		for (const prompt of prompts) boxes.push(await boxOf(prompt));
		const [a, b, c, d] = boxes as [
			(typeof boxes)[0],
			(typeof boxes)[0],
			(typeof boxes)[0],
			(typeof boxes)[0]
		];
		expect(Math.abs(a.y - b.y), 'the first two share a row').toBeLessThanOrEqual(1);
		expect(Math.abs(c.y - d.y), 'the last two share a row').toBeLessThanOrEqual(1);
		expect(c.y, 'the second row is below the first').toBeGreaterThanOrEqual(a.y + a.height);
		expect(b.x, 'the second column is right of the first').toBeGreaterThan(a.x + a.width);
		expect(Math.abs(a.x - c.x) + Math.abs(b.x - d.x), 'two aligned columns').toBeLessThanOrEqual(2);
		expect(Math.abs(a.width - b.width), 'columns of equal width').toBeLessThanOrEqual(1);

		const composer = page.getByRole('form', { name: 'Message your coach' });
		await expectCentredOver(page, composer, mainOf(page));
		const bar = await boxOf(composer);
		for (const box of boxes) expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
	});

	test('just below 1024 px the suggestions are one column again', async ({ page }) => {
		await page.setViewportSize({ width: BELOW_DESKTOP_WIDTH, height: 900 });
		await gotoHydrated(page, '/coach');
		const boxes = [];
		for (const prompt of await page.locator('.prompt').all()) boxes.push(await boxOf(prompt));
		expect(boxes).toHaveLength(4);
		for (const [i, box] of boxes.entries()) {
			expect(
				Math.abs(box.x - boxes[0]!.x),
				`prompt ${i + 1} starts the one column`
			).toBeLessThanOrEqual(1);
			if (i > 0) expect(box.y).toBeGreaterThanOrEqual(boxes[i - 1]!.y + boxes[i - 1]!.height);
		}
	});
});

test.describe('Security', () => {
	const SECTIONS = ['Passkeys', 'Signed-in devices', 'Recovery codes', 'Recent activity'];

	test('keeps the readable column, its four sections and Sign out reading in order', async ({
		page
	}) => {
		await gotoHydrated(page, '/profile/security');
		await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
		const readable = await tokenPx(page, '--content-readable');
		await expectMainCentred(page, readable);
		expect((await boxOf(mainOf(page))).width).toBeLessThanOrEqual(readable + 1);

		const headings = mainOf(page).getByRole('heading', { level: 2 });
		await expect(headings).toHaveText(SECTIONS);
		let bottom = 0;
		for (const title of SECTIONS) {
			const box = await boxOf(page.getByRole('region', { name: title }));
			expect(box.y, `${title} starts below what comes before it`).toBeGreaterThanOrEqual(bottom);
			bottom = box.y + box.height;
		}
		const signOut = await boxOf(page.getByTestId('sign-out'));
		expect(signOut.y, 'Sign out comes last').toBeGreaterThanOrEqual(bottom);
	});

	test('Tab runs through passkeys, then devices, then codes, then Sign out', async ({
		page,
		browserName
	}) => {
		// macOS WebKit tabs only between text fields unless Full Keyboard Access is on; the
		// reading order above holds there too.
		test.skip(browserName !== 'chromium', 'Tab order is asserted on Chromium');
		await gotoHydrated(page, '/profile/security');
		// Where each control is: the section it belongs to, or Sign out.
		const where = (selector: string) =>
			page.evaluate(
				(sel) =>
					[...document.querySelectorAll<HTMLElement>(`main#main :is(${sel})`)]
						.filter((el) => el.checkVisibility())
						.map((el) =>
							el.dataset.testid === 'sign-out'
								? 'Sign out'
								: (el.closest('section')?.querySelector('h2')?.textContent?.trim() ?? 'header')
						),
				selector
			);
		const dedupe = (list: string[]) => list.filter((item, i) => item !== list[i - 1]);
		const expected = dedupe((await where(TABBABLE)).filter((item) => item !== 'header'));
		expect(expected).toEqual(expect.arrayContaining(['Passkeys', 'Recovery codes', 'Sign out']));

		await mainOf(page).focus();
		const stops: string[] = [];
		for (let i = 0; i < 40 && stops.at(-1) !== 'Sign out'; i++) {
			await page.keyboard.press('Tab');
			stops.push(
				await page.evaluate(() => {
					const el = document.activeElement as HTMLElement;
					if (el.dataset.testid === 'sign-out') return 'Sign out';
					return el.closest('section')?.querySelector('h2')?.textContent?.trim() ?? 'header';
				})
			);
		}
		expect(dedupe(stops.filter((stop) => stop !== 'header'))).toEqual(expected);
	});
});

test.describe('the design gallery', () => {
	test('widens, with Color and Type side by side', async ({ page }) => {
		await gotoHydrated(page, '/design');
		const main = await boxOf(mainOf(page));
		expect(main.width, 'up to --content-wide').toBeLessThanOrEqual(
			(await tokenPx(page, '--content-wide')) + 1
		);
		expect(main.width, 'wider than the phone column').toBeGreaterThan(
			await tokenPx(page, '--content-readable')
		);
		expect(Math.abs(centreX(main) - (await layoutWidth(page)) / 2)).toBeLessThanOrEqual(1);

		const color = await boxOf(gallerySection(page, 'Color'));
		const type = await boxOf(gallerySection(page, 'Type'));
		expect(Math.abs(color.y - type.y), 'Color and Type start level').toBeLessThanOrEqual(1);
		expect(type.x, 'Type sits right of Color').toBeGreaterThanOrEqual(color.x + color.width);

		// The icon grid takes the full width: more icons to a row than the phone column holds.
		const icons = await boxOf(gallerySection(page, 'Icons'));
		expect(Math.abs(icons.x - color.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(icons.x + icons.width - (type.x + type.width))).toBeLessThanOrEqual(1);
	});

	test('is one column just below 1024 px', async ({ page }) => {
		await page.setViewportSize({ width: BELOW_DESKTOP_WIDTH, height: 900 });
		await gotoHydrated(page, '/design');
		const color = await boxOf(gallerySection(page, 'Color'));
		const type = await boxOf(gallerySection(page, 'Type'));
		expect(Math.abs(color.x - type.x)).toBeLessThanOrEqual(1);
		expect(type.y, 'Type comes under Color').toBeGreaterThanOrEqual(color.y + color.height);
	});
});

test.describe('error and offline states', () => {
	test('a 404 inside the shell is centred in the readable column', async ({ page }) => {
		await page.goto('/today/unknown');
		await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));
		const view = await boxOf(page.getByTestId('error-view'));
		expect(Math.abs(centreX(view) - centreX(await boxOf(mainOf(page))))).toBeLessThanOrEqual(1);
	});

	test('a 404 outside the shell is centred in the window at the readable width', async ({
		page
	}) => {
		await page.goto('/nothing-here');
		await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
		await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
		const view = await boxOf(page.getByTestId('error-view'));
		expect(view.width, 'no wider than the readable column').toBeLessThanOrEqual(
			(await tokenPx(page, '--content-readable')) + 1
		);
		expect(Math.abs(centreX(view) - (await layoutWidth(page)) / 2)).toBeLessThanOrEqual(1);
		const middle = view.y + view.height / 2;
		expect(Math.abs(middle - page.viewportSize()!.height / 2)).toBeLessThanOrEqual(1);
	});

	test('/offline is centred in the readable column', async ({ page }) => {
		await page.goto('/offline');
		const state = page.getByTestId('offline-state');
		await expect(state).toBeVisible();
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));
		expect(
			Math.abs(centreX(await boxOf(state)) - centreX(await boxOf(mainOf(page))))
		).toBeLessThanOrEqual(1);
	});
});

test.describe('every screen', () => {
	test('scrolls nothing sideways from 1024 to 1920 px', async ({ page }) => {
		for (const { path } of SCREENS) {
			await page.goto(path);
			await page.evaluate(() => document.fonts.ready);
			for (const width of DESKTOP_WIDTHS) {
				await page.setViewportSize({ width, height: 900 });
				await expectNoSideScroll(page);
			}
			await page.setViewportSize(DESKTOP.viewport);
		}
	});

	for (const theme of THEMES) {
		test(`has no WCAG A/AA violations in the ${theme} theme`, async ({ page }, testInfo) => {
			for (const { path, name } of SCREENS) {
				await openInTheme(page, path, theme);
				await page.waitForTimeout(400);
				const { violations } = await new AxeBuilder({ page })
					.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
					.analyze();
				expect(
					violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`)),
					path
				).toEqual([]);
				await captureScreen(page, testInfo, `desktop-${name}${theme === 'light' ? '-light' : ''}`);
			}
		});
	}
});
