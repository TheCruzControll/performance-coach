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
import {
	captureScreen,
	gotoHydrated,
	PROFILE,
	SCREENS,
	TABS,
	toastWith,
	trackConsoleErrors
} from './support';

/**
 * The app shell in a desktop window (docs/design-system.md, Responsive layout → Shell): from
 * 1024 px the primary navigation is a rail on the canvas at the left, with no brand mark, and the
 * content is centred beside it, its text at most 200 px from the rail. Layout is checked only on screens that stay readable by contract
 * (Coach, Security) and on app-level chrome (a toast), so the slices that later make other
 * screens wide or split never need to edit this spec.
 */
test.use(DESKTOP);

const THEMES = ['dark', 'light'] as const;
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

test.describe('the rail from 1024 px', () => {
	test('is a full-height rail on the canvas at the left, a hairline at its right and no brand mark, and nothing is fixed to the bottom edge', async ({
		page
	}) => {
		await gotoHydrated(page, '/today');
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

		// No mark drawn above the tabs, and no markup but the list of destinations.
		const marks = await rail.evaluate((el) =>
			['::before', '::after'].map((pseudo) => getComputedStyle(el, pseudo).content)
		);
		expect(marks, 'no brand mark').toEqual(['none', 'none']);
		expect(await rail.evaluate((el) => [...el.children].map((child) => child.tagName))).toEqual([
			'UL'
		]);

		// The canvas, not a surface, with the hairline at its right, in either theme.
		for (const theme of THEMES) {
			await openInTheme(page, '/today', theme);
			const light = theme === 'light';
			await expect(rail, theme).toHaveCSS(
				'background-color',
				light ? 'rgb(244, 244, 240)' : 'rgb(10, 10, 11)'
			);
			await expect(rail, theme).toHaveCSS(
				'border-right-color',
				light ? 'rgba(17, 17, 19, 0.08)' : 'rgba(255, 255, 255, 0.07)'
			);
		}

		// The avatar at the foot: its bottom within 40 px of the window's.
		const avatar = await boxOf(rail.getByTestId('rail-avatar'));
		const foot = page.viewportSize()!.height - (avatar.y + avatar.height);
		expect(foot, `the avatar ends ${foot}px above the window's foot`).toBeLessThanOrEqual(40);
		expect(foot).toBeGreaterThanOrEqual(0);

		// On Profile the avatar is current, and no tab is.
		await rail.getByTestId('rail-avatar').click();
		await expect(page.getByRole('heading', { level: 1, name: PROFILE.heading })).toBeVisible();
		await expect(rail.getByTestId('rail-avatar')).toHaveAttribute('aria-current', 'page');
		await expect(rail.locator('[aria-current="page"]')).toHaveCount(1);
	});

	test('keeps the four tabs and Profile in order, one current, and moves between the tabs', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await gotoHydrated(page, '/today');
		const rail = railOf(page);
		const links = rail.getByRole('link');
		await expect(links).toHaveText([...TABS, PROFILE].map((tab) => tab.label));
		for (const tab of TABS) {
			const box = await boxOf(rail.getByRole('link', { name: tab.label }));
			expect(box.width).toBeGreaterThanOrEqual(44);
			expect(box.height).toBeGreaterThanOrEqual(44);
		}
		// The avatar is a 32 px circle; its ::after reaches 6 px past the edge, so a point 5 px
		// outside the circle still lands on the link (a 44 px hit area).
		const avatar = rail.getByTestId('rail-avatar');
		const circle = await boxOf(avatar);
		expect(Math.round(circle.width)).toBe(32);
		expect(Math.round(circle.height)).toBe(32);
		const hit = await avatar.evaluate(
			(link, { x, y }) => {
				const at = document.elementFromPoint(x, y);
				return at !== null && link.contains(at);
			},
			{ x: circle.x + circle.width + 5, y: circle.y + circle.height / 2 }
		);
		expect(hit, 'a point 5 px outside the avatar hits its link').toBe(true);
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

	test('a mouse hover lifts the text of a destination that is not current', async ({ page }) => {
		await page.goto('/today');
		await page.waitForLoadState('networkidle');
		const train = railOf(page).getByRole('link', { name: 'Train' });
		const colour = () => train.evaluate((el) => getComputedStyle(el).color);
		const resting = await colour();
		await train.hover();
		await expect.poll(colour).not.toBe(resting);
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
								? (el.getAttribute('aria-label') ?? el.textContent!.trim())
								: el.closest('main#main')
									? 'main'
									: el.outerHTML.slice(0, 60)
					),
			TABBABLE
		);
		expect(order).toEqual(['skip', ...TABS.map((tab) => tab.label), PROFILE.label, 'main']);
	});

	test('Tab goes from the skip link through the rail to the content, each with a ring', async ({
		page
	}) => {
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
							? (el.getAttribute('aria-label') ?? el.textContent!.trim())
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
		expect(stops).toEqual(['skip', ...TABS.map((tab) => tab.label), PROFILE.label, 'main']);
	});

	test('the skip link lands in the content, past the rail', async ({ page }) => {
		await page.goto('/today');
		await page.waitForLoadState('networkidle');
		const skip = page.getByRole('link', { name: 'Skip to content' });
		await skip.focus();
		await page.keyboard.press('Enter');
		await expect(mainOf(page)).toBeFocused();
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

test('the rail requests nothing a phone does not, and no brand mark', async ({
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

	// The same screen in a phone-width window, nothing else changed: no rail.
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

	expect([...desktop].filter((path) => path.startsWith('/brand/mark-'))).toEqual([]);
	expect([...desktop].filter((path) => !narrow.has(path))).toEqual([]);
	expect([...narrow].filter((path) => !desktop.has(path))).toEqual([]);
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

	test('at 1440 px a readable screen is 560 px of text starting 200 px right of the rail', async ({
		page
	}) => {
		// Coach is readable by contract (Today is wide once it has a program).
		await page.goto('/coach');
		await page.evaluate(() => document.fonts.ready);
		const [rail, main] = [await boxOf(railOf(page)), await boxOf(mainOf(page))];
		const railRight = rail.x + rail.width;
		expect(Math.abs(main.width - 616), `main is ${main.width}px wide`).toBeLessThanOrEqual(1);
		expect(
			Math.abs(main.x - railRight - 172),
			`main starts ${main.x - railRight}px out`
		).toBeLessThanOrEqual(1);
		const title = await boxOf(mainOf(page).getByRole('heading', { level: 1 }));
		expect(Math.abs(title.x - 288), `the title starts at ${title.x}px`).toBeLessThanOrEqual(1);
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
		for (const tab of SCREENS) {
			await page.goto(tab.path);
			await page.evaluate(() => document.fonts.ready);
			for (const width of DESKTOP_WIDTHS) {
				await page.setViewportSize({ width, height: 900 });
				await expectNoSideScroll(page);
			}
			await page.setViewportSize(DESKTOP.viewport);
		}
	});

	test('just below 1024 px the bar is back at the bottom, full width, and not glass', async ({
		page
	}) => {
		await page.setViewportSize({ width: BELOW_DESKTOP_WIDTH, height: 900 });
		await page.goto('/today');
		const box = await boxOf(railOf(page));
		expect(Math.round(box.y + box.height)).toBe(900);
		expect(Math.round(box.width)).toBe(await layoutWidth(page));
		await expect(railOf(page)).toHaveCSS('backdrop-filter', 'none');
		await expectNoSideScroll(page);
	});

	test('on a tablet every tab gets the readable column, whatever a screen declares', async ({
		page
	}) => {
		// Wider than the phone's column, still the bottom bar: wide and split start at 1024 px.
		await page.setViewportSize({ width: 800, height: 900 });
		await page.goto('/today');
		const readable = await tokenPx(page, '--content-readable');
		for (const tab of SCREENS) {
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
		context
	}) => {
		await page.goto('/coach');
		await workerActivated(page);
		await context.setOffline(true);
		await page.reload();
		await page.waitForLoadState('networkidle');
		const notice = page.getByTestId('offline-state');
		await expect(notice).toContainText('Coach needs a connection');
		const main = await boxOf(mainOf(page));
		const box = await boxOf(notice);
		expect(box.x).toBeGreaterThanOrEqual(main.x - 1);
		expect(box.x + box.width).toBeLessThanOrEqual(main.x + main.width + 1);
		await expectMainCentred(page, await tokenPx(page, '--content-readable'));

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
