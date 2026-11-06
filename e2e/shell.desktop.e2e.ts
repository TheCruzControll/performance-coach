import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
	BELOW_DESKTOP_WIDTH,
	DESKTOP,
	DESKTOP_WIDTHS,
	expectCentredOver,
	expectNoSideScroll,
	pixelAt
} from './desktop';
import { captureScreen, gotoHydrated, TABS, toastWith, trackConsoleErrors } from './support';

/**
 * The app shell in a desktop window (docs/design-system.md, Responsive layout → Shell): from
 * 1024 px the primary navigation is a solid rail at the left, under the brand mark, and the
 * content is centred beside it. Layout is checked only on screens that stay readable by contract
 * (Coach, Security) and on app-level chrome (a toast), so the slices that later make other
 * screens wide or split never need to edit this spec.
 */
test.use(DESKTOP);

const THEMES = ['dark', 'light'] as const;
const BRAND_MARKS = ['/brand/mark-arc.svg', '/brand/mark-track.svg'];
/** Anything Tab stops at, unless disabled or taken out of the order. */
const TABBABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
	'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const railOf = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const mainOf = (page: Page) => page.locator('main#main');

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

/** The service worker is installed (the precache filled) and activated. */
const workerActivated = (page: Page) =>
	expect
		.poll(
			() =>
				page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state),
			{ message: 'the service worker is activated', timeout: 15_000 }
		)
		.toBe('activated');

/** A length token (e.g. `--rail-width: 5.5rem`) in CSS pixels. */
const tokenPx = (page: Page, token: string) =>
	page.evaluate((name) => {
		const probe = document.createElement('div');
		probe.style.width = `var(${name})`;
		document.body.append(probe);
		const width = probe.getBoundingClientRect().width;
		probe.remove();
		return width;
	}, token);

/**
 * The width the page lays out in: the window's, less the gutter base.css keeps for a classic
 * scrollbar (`scrollbar-gutter: stable`), which headless Chromium reserves without drawing.
 */
const layoutWidth = (page: Page) =>
	page.evaluate(() => document.documentElement.getBoundingClientRect().width);

async function boxOf(locator: Locator) {
	const box = await locator.boundingBox();
	expect(box, `${locator} is on the page`).not.toBeNull();
	return box!;
}

/** Fixed elements other than the rail whose bottom edge is the window's. */
const fixedToBottom = (page: Page) =>
	page.evaluate(() =>
		[...document.querySelectorAll('body *')]
			.filter((el) => !el.closest('.app-nav') && getComputedStyle(el).position === 'fixed')
			.map((el) => ({ el, box: el.getBoundingClientRect() }))
			.filter(({ box }) => box.width > 0 && box.height > 0 && box.bottom >= innerHeight - 1)
			.map(({ el }) => el.outerHTML.slice(0, 80))
	);

/** `<main>` is centred in the area right of the rail (both gaps within 1 px) and `width` wide. */
async function expectMainCentred(page: Page, width: number) {
	const rail = await boxOf(railOf(page));
	const main = await boxOf(mainOf(page));
	const left = main.x - (rail.x + rail.width);
	const right = (await layoutWidth(page)) - (main.x + main.width);
	expect(Math.abs(left - right), `gaps beside main: ${left} and ${right}`).toBeLessThanOrEqual(1);
	expect(Math.abs(main.width - width), `main is ${main.width}px wide`).toBeLessThanOrEqual(1);
}

/** The nearest rgb() of a colour expression, as this page resolves it on the rail. */
const colourOf = (page: Page, expression: string) =>
	page.evaluate((value) => {
		const probe = document.createElement('div');
		probe.style.color = value;
		document.querySelector('.app-nav')!.append(probe);
		const rgb = getComputedStyle(probe)
			.color.match(/[\d.]+/g)!
			.map(Number);
		probe.remove();
		return rgb.slice(0, 3) as [number, number, number];
	}, expression);

const near = (actual: number[], expected: number[]) =>
	actual.every((channel, i) => Math.abs(channel - expected[i]!) <= 8);

test.describe('the rail from 1024 px', () => {
	test('is a solid, full-height rail at the left, and nothing is fixed to the bottom edge', async ({
		page
	}) => {
		await page.goto('/today');
		const rail = railOf(page);
		const box = await boxOf(rail);
		expect(box.x).toBe(0);
		expect(box.y).toBe(0);
		expect(box.height).toBe(page.viewportSize()!.height);
		expect(Math.abs(box.width - (await tokenPx(page, '--rail-width')))).toBeLessThanOrEqual(1);
		const glass = await rail.evaluate((el) => {
			const style = getComputedStyle(el) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
			return [style.backdropFilter || 'none', style.webkitBackdropFilter || 'none'];
		});
		expect(glass).toEqual(['none', 'none']);
		expect(await fixedToBottom(page)).toEqual([]);
	});

	test('keeps the five destinations in order, one current, and moves between them', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await gotoHydrated(page, '/today');
		const rail = railOf(page);
		const links = rail.getByRole('link');
		await expect(links).toHaveText(TABS.map((tab) => tab.label));
		for (const link of await links.all()) {
			const box = await boxOf(link);
			expect(box.width).toBeGreaterThanOrEqual(44);
			expect(box.height).toBeGreaterThanOrEqual(44);
		}
		await expect(rail.locator('[aria-current="page"]')).toHaveCount(1);

		for (const tab of [...TABS.slice(1), TABS[0]]) {
			await rail.getByRole('link', { name: tab.label }).click();
			await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
			await expect(page.getByRole('heading', { level: 1, name: tab.heading })).toBeVisible();
			await expect(rail.getByRole('link', { name: tab.label })).toHaveAttribute(
				'aria-current',
				'page'
			);
			await expect(rail.locator('[aria-current="page"]')).toHaveCount(1);
			expect(await fixedToBottom(page), tab.path).toEqual([]);
			await captureScreen(page, testInfo, `desktop-${tab.path.slice(1)}`);
		}
		expect(errors).toEqual([]);
	});

	test('a mouse hover tints a destination that is not current', async ({ page, browserName }) => {
		test.skip(browserName !== 'chromium', 'hover is asserted on Chromium');
		await page.goto('/today');
		await page.waitForLoadState('networkidle');
		const train = railOf(page).getByRole('link', { name: 'Train' });
		const glyph = train.locator('.glyph');
		const background = () => glyph.evaluate((el) => getComputedStyle(el).backgroundColor);
		const resting = await background();
		await train.hover();
		await expect.poll(background).not.toBe(resting);
	});
});

test.describe('keyboard', () => {
	test('in the document the skip link comes first, then the rail, then the content', async ({
		page
	}) => {
		await page.goto('/today');
		const order = await page.evaluate(
			(selector) =>
				[...document.querySelectorAll<HTMLElement>(selector)]
					.filter((el) => el.checkVisibility())
					.slice(0, 7)
					.map((el) =>
						el.matches('.skip-link')
							? 'skip'
							: el.closest('.app-nav')
								? el.textContent!.trim()
								: el.closest('main#main')
									? 'main'
									: el.outerHTML.slice(0, 60)
					),
			TABBABLE
		);
		expect(order).toEqual(['skip', ...TABS.map((tab) => tab.label), 'main']);
	});

	test('Tab goes from the skip link through the rail to the content, each with a ring', async ({
		page,
		browserName
	}) => {
		// macOS WebKit tabs only between text fields unless Full Keyboard Access is on; the
		// document order above holds there too.
		test.skip(browserName !== 'chromium', 'Tab order is asserted on Chromium');
		await page.goto('/today');
		await page.waitForLoadState('networkidle');
		const focused = () =>
			page.evaluate(() => {
				const el = document.activeElement as HTMLElement;
				const { outlineStyle, outlineWidth } = getComputedStyle(el);
				return {
					where: el.matches('.skip-link')
						? 'skip'
						: el.closest('.app-nav')
							? el.textContent!.trim()
							: el.closest('main#main')
								? 'main'
								: el.tagName,
					ring: outlineStyle !== 'none' ? parseFloat(outlineWidth) : 0
				};
			});
		const stops: string[] = [];
		for (let i = 0; i < 7; i++) {
			await page.keyboard.press('Tab');
			const { where, ring } = await focused();
			stops.push(where);
			if (where !== 'main') expect(ring, `${where} shows a focus ring`).toBeGreaterThanOrEqual(2);
		}
		expect(stops).toEqual(['skip', ...TABS.map((tab) => tab.label), 'main']);
	});

	test('the skip link lands in the content, past the rail', async ({ page, browserName }) => {
		await page.goto('/today');
		await page.waitForLoadState('networkidle');
		const skip = page.getByRole('link', { name: 'Skip to content' });
		await skip.focus();
		await page.keyboard.press('Enter');
		await expect(mainOf(page)).toBeFocused();
		if (browserName !== 'chromium') return; // Tab order: Chromium, as above
		await page.keyboard.press('Tab');
		const first = await page.evaluate(
			(selector) =>
				[...document.querySelectorAll<HTMLElement>(`main#main :is(${selector})`)].find((el) =>
					el.checkVisibility()
				) === document.activeElement,
			TABBABLE
		);
		expect(first, 'the next Tab reaches the first control in the content').toBe(true);
	});
});

for (const theme of THEMES) {
	test(`the brand mark tops the rail and follows the ${theme} theme`, async ({ page }) => {
		await openInTheme(page, '/coach', theme);
		const rail = railOf(page);
		const mark = await rail.evaluate((el) => {
			const box = (pseudo: string) => {
				const style = getComputedStyle(el, pseudo);
				return {
					x: parseFloat(style.left),
					y: parseFloat(style.top),
					size: parseFloat(style.width),
					height: parseFloat(style.height),
					mask: style.maskImage || style.getPropertyValue('-webkit-mask-image'),
					events: style.pointerEvents
				};
			};
			return { track: box('::before'), arc: box('::after') };
		});
		expect(mark.track.mask).toContain('/brand/mark-track.svg');
		expect(mark.arc.mask).toContain('/brand/mark-arc.svg');
		expect({ ...mark.arc, mask: '' }).toEqual({ ...mark.track, mask: '' });
		expect(mark.track.height).toBe(mark.track.size);
		expect(mark.track.events).toBe('none');
		// Decorative: no markup of its own, only the list of destinations.
		expect(await rail.evaluate((el) => [...el.children].map((child) => child.tagName))).toEqual([
			'UL'
		]);

		// The favicon's geometry (a 64-unit viewBox): the ring's centre is at 32, its radius 22.
		const { x, y, size } = mark.track;
		const shot = await page.screenshot({
			clip: { x: 0, y: 0, width: Math.ceil(x * 2 + size), height: Math.ceil(y + size) + 8 },
			animations: 'disabled'
		});
		const pixel = (u: number, v: number) =>
			pixelAt(page, shot, Math.floor(x + (u * size) / 64), Math.floor(y + (v * size) / 64));
		const surface = await colourOf(page, 'var(--color-surface-1)');
		const text = await colourOf(page, 'var(--color-text)');
		const samples: [string, number[], number[]][] = [
			['the centre shows the rail', await pixel(32, 32), surface],
			[
				'the top of the ring is the arc',
				await pixel(32, 10),
				await colourOf(page, 'var(--color-accent)')
			],
			[
				'the ring past the arc is the track',
				await pixel(54, 32),
				surface.map((channel, i) => channel * 0.82 + text[i]! * 0.18)
			]
		];
		for (const [what, actual, expected] of samples) {
			expect(near(actual, expected), `${what}: ${actual} ≈ ${expected.map(Math.round)}`).toBe(true);
		}
	});
}

test('the brand mark adds no request beyond its two precached files', async ({
	page,
	context,
	browser
}) => {
	const requested = (p: Page) => {
		const paths = new Set<string>();
		p.on('request', (request) => {
			const url = new URL(request.url());
			// Code chunks arrive on their own schedule (idle-time imports); the layout is CSS.
			if (request.method() === 'GET' && !/^\/_app\/.+\.js$/.test(url.pathname)) {
				paths.add(url.pathname);
			}
		});
		return paths;
	};
	const desktop = requested(page);
	await page.goto('/coach');
	await page.waitForLoadState('networkidle');

	// The same screen in a phone-width window, nothing else changed: no rail, no mark.
	const phoneContext = await browser.newContext({
		...DESKTOP,
		viewport: { width: 393, height: 900 },
		storageState: await context.storageState()
	});
	const phone = await phoneContext.newPage();
	const narrow = requested(phone);
	await phone.goto('/coach');
	await phone.waitForLoadState('networkidle');
	await phoneContext.close();

	expect([...desktop].filter((path) => !narrow.has(path)).sort()).toEqual(BRAND_MARKS);
	expect([...narrow].filter((path) => !desktop.has(path))).toEqual([]);

	// Precached with the other static files, so the mark renders offline too.
	await workerActivated(page);
	await expect
		.poll(() =>
			page.evaluate(async (paths) => {
				const found: string[] = [];
				for (const path of paths) if ((await caches.match(path))?.ok) found.push(path);
				return found;
			}, BRAND_MARKS)
		)
		.toEqual(BRAND_MARKS);
});

test.describe('the content column and its chrome', () => {
	test('Coach and Security keep the readable column, centred beside the rail', async ({ page }) => {
		await page.goto('/coach');
		const readable = await tokenPx(page, '--content-readable');
		await expectMainCentred(page, readable);
		await page.goto('/profile/security');
		await expect(page.getByRole('heading', { level: 1, name: 'Security' })).toBeVisible();
		await expectMainCentred(page, readable);
	});

	test('a screen that declares wide or split gets the wider column', async ({ page }) => {
		await page.goto('/coach');
		await page.waitForLoadState('networkidle');
		const wrapper = page.locator('main#main .coach');
		await wrapper.evaluate((el) => el.setAttribute('data-layout', 'wide'));
		await expectMainCentred(page, await tokenPx(page, '--content-wide'));

		await wrapper.evaluate((el) => el.setAttribute('data-layout', 'split'));
		await expectMainCentred(page, await tokenPx(page, '--content-wide'));
		const [list, detail] = await wrapper.locator(':scope > *').all();
		const a = await boxOf(list!);
		const b = await boxOf(detail!);
		expect(Math.abs(a.width - (await tokenPx(page, '--content-list')))).toBeLessThanOrEqual(1);
		expect(b.x, 'the detail sits beside the list').toBeGreaterThanOrEqual(a.x + a.width);
		expect(Math.abs(b.y - a.y), 'both columns start at the top').toBeLessThanOrEqual(1);
	});

	test('Coach’s composer is centred over the column, above the bottom edge, over no prompt', async ({
		page
	}) => {
		await page.goto('/coach');
		await page.evaluate(() => document.fonts.ready);
		const composer = page.getByRole('form', { name: 'Message your coach' });
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));
		await expectCentredOver(page, composer, mainOf(page));
		const bar = await boxOf(composer);
		for (const prompt of await page.locator('.prompt').all()) {
			const box = await boxOf(prompt);
			expect(
				box.y + box.height,
				`${await prompt.textContent()} ends above the composer`
			).toBeLessThanOrEqual(bar.y);
		}
	});

	test.describe('a toast', () => {
		// No service worker, so the routes below hold on every engine.
		test.use({ serviceWorkers: 'block' });

		test('Security’s offline sign-out toast is centred over the column', async ({
			page,
			context
		}) => {
			await page.goto('/profile/security');
			await page.waitForLoadState('networkidle');
			// Never reach the server: this browser's session is shared with other specs.
			await context.route('**/api/auth/signout', (route) => route.abort('internetdisconnected'));
			await context.setOffline(true);
			await page.getByTestId('sign-out').click();
			const toast = toastWith(page, 'Can’t reach the server to sign out');
			await expect(toast).toBeVisible();
			await expectMainCentred(page, await tokenPx(page, '--content-readable'));
			await expectCentredOver(page, toast, mainOf(page));
			await context.setOffline(false);
		});

		test('outside the shell, /design’s toast is centred in the window', async ({ page }) => {
			await gotoHydrated(page, '/design');
			await page.getByRole('tab', { name: 'Feedback' }).click();
			await page.getByRole('button', { name: 'Toast', exact: true }).click();
			const toast = toastWith(page, 'Set logged');
			await expect(toast).toBeVisible();
			const box = await boxOf(toast);
			const centre = box.x + box.width / 2;
			expect(Math.abs(centre - (await layoutWidth(page)) / 2)).toBeLessThanOrEqual(1);
		});
	});
});

test.describe('every width and state', () => {
	test('no tab scrolls sideways from 1024 to 1920 px', async ({ page }) => {
		for (const tab of TABS) {
			await page.goto(tab.path);
			await page.evaluate(() => document.fonts.ready);
			for (const width of DESKTOP_WIDTHS) {
				await page.setViewportSize({ width, height: 900 });
				await expectNoSideScroll(page);
			}
			await page.setViewportSize(DESKTOP.viewport);
		}
	});

	test('just below 1024 px the glass bar is back at the bottom, full width', async ({ page }) => {
		await page.setViewportSize({ width: BELOW_DESKTOP_WIDTH, height: 900 });
		await page.goto('/today');
		const box = await boxOf(railOf(page));
		expect(Math.round(box.y + box.height)).toBe(900);
		expect(Math.round(box.width)).toBe(await layoutWidth(page));
		const glass = await railOf(page).evaluate((el) => {
			const style = getComputedStyle(el) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
			return style.backdropFilter || style.webkitBackdropFilter || 'none';
		});
		expect(glass).toContain('blur(');
		await expectNoSideScroll(page);
	});

	test('on a tablet every tab gets the readable column, whatever a screen declares', async ({
		page
	}) => {
		// Wider than the phone's column, still the bottom bar: wide and split start at 1024 px.
		await page.setViewportSize({ width: 800, height: 900 });
		await page.goto('/today');
		const readable = await tokenPx(page, '--content-readable');
		for (const tab of TABS) {
			await page.goto(tab.path);
			await page
				.locator('main#main > :last-child')
				.evaluate((el) => el.setAttribute('data-layout', 'wide'));
			const main = await boxOf(mainOf(page));
			expect(Math.abs(main.width - readable), `${tab.path}: ${main.width}px`).toBeLessThanOrEqual(
				1
			);
		}
	});

	test('offline, Coach reloads from the precache with its notice in the column and the rail working', async ({
		page,
		context,
		browserName
	}) => {
		test.skip(browserName !== 'chromium', 'offline emulation is Chromium-only');
		await page.goto('/coach');
		await workerActivated(page);
		await context.setOffline(true);
		await page.reload();
		await page.waitForLoadState('networkidle');
		const notice = page.getByTestId('offline-state');
		await expect(notice).toContainText("You're offline");
		const main = await boxOf(mainOf(page));
		const box = await boxOf(notice);
		expect(box.x).toBeGreaterThanOrEqual(main.x - 1);
		expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 1);
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));

		// The mark's masks come from the precache: the ring's top is still the accent.
		const rail = await boxOf(railOf(page));
		const shot = await page.screenshot({ clip: { x: 0, y: 0, width: rail.width, height: 120 } });
		const top = await railOf(page).evaluate((el) => {
			const style = getComputedStyle(el, '::after');
			const size = parseFloat(style.width);
			return [
				Math.floor(parseFloat(style.left) + size / 2),
				Math.floor(parseFloat(style.top) + (10 * size) / 64)
			] as [number, number];
		});
		expect(
			near(await pixelAt(page, shot, ...top), await colourOf(page, 'var(--color-accent)'))
		).toBe(true);

		await railOf(page).getByRole('link', { name: 'Train' }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
		await context.setOffline(false);
	});

	for (const theme of THEMES) {
		test(`Today and Coach have no WCAG A/AA violations in the ${theme} theme`, async ({
			page
		}, testInfo) => {
			for (const path of ['/today', '/coach']) {
				await openInTheme(page, path, theme);
				await page.waitForTimeout(400);
				const { violations } = await new AxeBuilder({ page })
					.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
					.analyze();
				expect(
					violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`)),
					path
				).toEqual([]);
			}
			if (theme === 'light') {
				await openInTheme(page, '/today', theme);
				await captureScreen(page, testInfo, 'desktop-today-light');
			}
		});
	}
});
