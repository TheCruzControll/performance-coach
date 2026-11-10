import { expect, test, type Page } from '@playwright/test';
import { isDesktopPage } from './desktop';
import { captureScreen, gotoHydrated, signedOut, TABS, trackConsoleErrors } from './support';

/**
 * Share of the primary nav's colour channels that two full-viewport screenshots of a screen
 * paint more than an eighth of the range apart: 0 when the nav looks the same in both. Both shots
 * are cropped to the nav's bounding box, so this compares the tab bar on a phone and the rail in a
 * desktop window, never the page beside it.
 */
async function navDifference(page: Page, a: Buffer, b: Buffer): Promise<number> {
	const nav = await page.getByRole('navigation', { name: 'Primary' }).boundingBox();
	expect(nav, 'the primary nav is on the page').not.toBeNull();
	return page.evaluate(
		async ({ first, second, box }) => {
			const pixels = async (base64: string) => {
				const png = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
				const image = await createImageBitmap(new Blob([png], { type: 'image/png' }));
				const scale = image.width / innerWidth;
				const canvas = Object.assign(document.createElement('canvas'), {
					width: Math.max(1, Math.round(box.width * scale)),
					height: Math.max(1, Math.round(box.height * scale))
				});
				const context = canvas.getContext('2d')!;
				context.drawImage(image, -Math.round(box.x * scale), -Math.round(box.y * scale));
				return context.getImageData(0, 0, canvas.width, canvas.height).data;
			};
			const [x, y] = await Promise.all([pixels(first), pixels(second)]);
			const differing = x.filter((value, i) => i % 4 < 3 && Math.abs(value - y[i]!) > 32);
			return differing.length / ((x.length * 3) / 4);
		},
		{ first: a.toString('base64'), second: b.toString('base64'), box: nav! }
	);
}

test.describe('app shell on an iPhone viewport', () => {
	test('the sign-in screen is the landing page; signed in, / goes to Today', async ({
		page,
		browser,
		browserName
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await page.goto('/');
		await expect(page).toHaveURL(/\/today$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
		expect(errors).toEqual([]);

		const context = await browser.newContext({ storageState: signedOut });
		const signIn = await context.newPage();
		const signInErrors = trackConsoleErrors(signIn);
		await signIn.goto('/');
		await expect(
			signIn.getByRole('heading', { level: 1, name: /train with intent/i })
		).toBeVisible();
		await expect(signIn.getByRole('textbox', { name: 'Account' })).toHaveAttribute(
			'autocomplete',
			'username webauthn'
		);

		// Passkey sign-in is offered exactly when the browser has WebAuthn: once hydrated, the
		// screen asks passkeySupport() and otherwise says so and points to recovery. Some of CI's
		// Linux WebKit builds have none, so ask this page the app's own question
		// (@simplewebauthn/browser's browserSupportsWebAuthn), after the network settles: by then
		// the screen has hydrated and loaded the library that answers it.
		await signIn.waitForLoadState('networkidle');
		const webauthn = await signIn.evaluate(
			() => typeof globalThis.PublicKeyCredential === 'function'
		);
		if (browserName === 'chromium') expect(webauthn, 'Chromium always has WebAuthn').toBe(true);
		const passkeySignIn = signIn.getByTestId('passkey-signin');
		const noPasskeys = signIn
			.getByRole('status')
			.filter({ hasText: 'This browser can’t use passkeys' });
		const recovery = signIn.getByRole('link', { name: 'Lost your passkey? Use a recovery code' });
		await expect(recovery).toBeVisible();
		await expect(recovery).toHaveAttribute('href', '/recover');
		if (webauthn) {
			await expect(passkeySignIn).toBeEnabled();
			await expect(noPasskeys).toHaveCount(0);
		} else {
			await expect(noPasskeys).toBeVisible();
			await expect(noPasskeys).toContainText('sign in with a recovery code');
			await expect(passkeySignIn).toBeDisabled();
		}
		await captureScreen(signIn, testInfo, 'landing');

		if (!webauthn) {
			// The way in that is left: the recovery link opens recovery.
			await recovery.click();
			await expect(signIn).toHaveURL(/\/recover$/);
			await expect(
				signIn.getByRole('heading', { level: 1, name: 'Lost your passkey?' })
			).toBeVisible();
		}
		expect(signInErrors).toEqual([]);
		await context.close();
	});

	test('signed in, Today and Train name the training profile as the next step', async ({
		page
	}) => {
		// The functional suites run on a blank training profile: Today starts its setup.
		await page.goto('/today');
		const setup = page.getByTestId('today-setup');
		await expect(setup).toContainText('Set up your training profile');
		await expect(setup.getByRole('link', { name: 'Start setup' })).toHaveAttribute(
			'href',
			'/onboarding'
		);
		// The owner is already signed in with a passkey: never point them back at it.
		await expect(setup).not.toContainText(/passkey|sign.in/i);

		// With no program and the profile not yet complete, Train sends the owner to it.
		await page.goto('/train');
		const empty = page.getByTestId('train-empty');
		await expect(empty).toContainText('Finish your training profile first');
		await expect(page.getByTestId('train-next')).toHaveAttribute('href', '/profile');
		await expect(empty).not.toContainText(/passkey|sign.in/i);
	});

	test('shell renders with the bottom navigation inside the safe viewport', async ({
		page
	}, testInfo) => {
		test.skip(
			isDesktopPage(page),
			'the bar is a phone layout: shell.desktop.e2e.ts checks the rail at desktop width'
		);
		await page.goto('/today');
		const viewport = page.viewportSize();
		expect(viewport?.width).toBeLessThanOrEqual(430);

		const nav = page.getByRole('navigation', { name: 'Primary' });
		await expect(nav).toBeVisible();
		await expect(nav.getByRole('link')).toHaveCount(TABS.length);
		await expect(nav.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');

		// Pinned to the bottom edge, full width, every target at least 44px tall.
		const box = await nav.boundingBox();
		expect(box).not.toBeNull();
		expect(Math.round(box!.y + box!.height)).toBe(viewport!.height);
		expect(Math.round(box!.width)).toBe(viewport!.width);
		for (const link of await nav.getByRole('link').all()) {
			const b = await link.boundingBox();
			expect(b!.height).toBeGreaterThanOrEqual(44);
		}

		// Glass actually blurs: guards against the build pipeline dropping the standard
		// `backdrop-filter` (Chromium and Firefox ignore the -webkit- form).
		const glass = await nav.evaluate((el) => {
			const style = getComputedStyle(el) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
			return style.backdropFilter || style.webkitBackdropFilter || 'none';
		});
		expect(glass).toContain('blur(');
		await captureScreen(page, testInfo, 'today');
	});

	test('bottom navigation moves between all tabs', async ({ page }, testInfo) => {
		const errors = trackConsoleErrors(page);
		await page.goto('/today');
		const nav = page.getByRole('navigation', { name: 'Primary' });

		for (const tab of [...TABS.slice(1), TABS[0]]) {
			await nav.getByRole('link', { name: tab.label }).click();
			await expect(page).toHaveURL(new RegExp(`${tab.path}$`));
			await expect(page.getByRole('heading', { level: 1, name: tab.heading })).toBeVisible();
			await expect(nav.getByRole('link', { name: tab.label })).toHaveAttribute(
				'aria-current',
				'page'
			);
			await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
			if (tab.path === '/today') continue;
			const shot = await captureScreen(page, testInfo, tab.path.slice(1));

			// The shot shows the tab bar as a fresh load of the tab paints it (CI's WebKit once saved
			// tab-change shots without the bar, or with the page showing through it).
			await page.reload();
			await expect(page.getByRole('heading', { level: 1, name: tab.heading })).toBeVisible();
			await page.evaluate(() => document.fonts.ready);
			const fresh = await page.screenshot({ animations: 'disabled' });
			expect(await navDifference(page, shot, fresh), `${tab.label}: tab bar differs`).toBeLessThan(
				0.01
			);
		}
		expect(errors).toEqual([]);
	});

	test('key-screen screenshots wait for the tab change to finish', async ({ page }, testInfo) => {
		// A shot taken during the tab cross-fade can lose the tab bar on WebKit. Slow the fade so
		// it is certainly still running when the next tab's heading shows. Hydrated first: `load`
		// comes before SvelteKit has fetched its root error page and started the router, and a tap
		// before then is a full page load, which has no cross-fade.
		await gotoHydrated(page, '/today');
		await page.addStyleTag({
			content:
				'::view-transition-old(root), ::view-transition-new(root) { animation-duration: 2s !important; }'
		});
		// Checked with the pseudo-class, independently of captureScreen's activeViewTransition test.
		const transitioning = () =>
			page.evaluate(() => document.documentElement.matches(':active-view-transition'));
		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Train' })
			.click();
		await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
		expect(await transitioning(), 'the tab change is still running').toBe(true);

		// Note, instead of saving a picture, whether the tab change was over when it was taken.
		const midTransition: boolean[] = [];
		page.screenshot = async () => {
			midTransition.push(await transitioning());
			return Buffer.alloc(0);
		};
		await captureScreen(page, testInfo, 'train-settled');
		expect(midTransition, 'one shot, taken after the tab change ended').toEqual([false]);
	});

	test('no console errors on any screen, including interactive ones', async ({ page }) => {
		const errors = trackConsoleErrors(page);
		for (const path of [...TABS.map((t) => t.path), '/profile/security', '/design', '/offline']) {
			await page.goto(path);
			await page.waitForLoadState('networkidle');
		}
		await gotoHydrated(page, '/train');
		await page.getByTestId('open-plates').click();
		await expect(page.getByTestId('plates-sheet')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(page.getByTestId('plates-sheet')).toBeHidden();
		expect(errors).toEqual([]);
	});

	test('plate calculator sheet: stepper, unit switch, focus return', async ({ page }, testInfo) => {
		await gotoHydrated(page, '/train');
		const opener = page.getByTestId('open-plates');
		await opener.click();

		const sheet = page.getByRole('dialog', { name: 'Plate calculator' });
		await expect(sheet).toBeVisible();
		await expect(sheet.getByTestId('plates-result')).toContainText('25 · 15');

		await sheet.getByRole('button', { name: 'Increase Target weight' }).click();
		await expect(sheet.getByRole('spinbutton', { name: 'Target weight' })).toHaveAttribute(
			'aria-valuenow',
			'102.5'
		);
		await expect(sheet.getByTestId('plates-result')).toContainText('25 · 15 · 1.25');
		await captureScreen(page, testInfo, 'plate-calculator');

		// Escape while typing cancels the edit only: the sheet (a modal <dialog>) stays open.
		const target = sheet.getByRole('spinbutton', { name: 'Target weight' });
		await target.click();
		await target.fill('140');
		await page.keyboard.press('Escape');
		// A closing sheet stays visible while it animates out, so check its open state too.
		await expect(page.getByTestId('plates-sheet')).toHaveClass(/\bvisible\b/);
		await expect(sheet).toBeVisible();
		await expect(target).toHaveAttribute('aria-valuenow', '102.5');
		await expect(target).not.toBeFocused();

		// A target lighter than the bar is explained, and the stepper cannot go below the bar.
		await sheet.getByRole('radio', { name: '10 kg bar' }).click();
		await target.focus();
		await page.keyboard.press('Home');
		await expect(target).toHaveAttribute('aria-valuenow', '10');
		await sheet.getByRole('radio', { name: '20 kg bar' }).click();
		await expect(sheet.getByTestId('plates-warning')).toContainText('Below the 20 kg bar');
		await expect(target).toHaveAttribute('aria-valuemin', '20');
		await captureScreen(page, testInfo, 'plate-calculator-below-bar');
		await target.fill('100');
		await page.keyboard.press('Enter');
		await expect(sheet.getByTestId('plates-warning')).toHaveCount(0);

		await sheet.getByRole('radio', { name: 'Pounds' }).click();
		await expect(target).toHaveAttribute('aria-valuenow', '220');
		await expect(sheet.getByTestId('plates-result')).toContainText('45 · 35 · 5');

		await sheet.getByRole('button', { name: 'Close' }).click();
		await expect(sheet).toBeHidden();
		await expect(opener).toBeFocused();

		// The calculator's unit switch is local: the app-wide preference is still kg.
		await page.goto('/profile');
		const units = page.getByRole('radiogroup', { name: 'Units' });
		await expect(units.getByRole('radio', { name: 'kg' })).toHaveAttribute('aria-checked', 'true');
	});

	test('a late animation frame never pulls focus back into a stepper the user left', async ({
		page
	}) => {
		// Slow devices (and busy CI) can run a frame scheduled on focus after the user already
		// pressed Escape or Enter. Make every frame late to turn that race into a certainty.
		await page.addInitScript(() => {
			const raf = window.requestAnimationFrame.bind(window);
			window.requestAnimationFrame = (cb) => {
				setTimeout(() => raf(cb), 400);
				return 0;
			};
		});
		// Hydrated first: a tap on the server-rendered row before then does nothing.
		await gotoHydrated(page, '/train');
		await page.getByTestId('open-plates').click();
		const sheet = page.getByRole('dialog', { name: 'Plate calculator' });
		await expect(page.getByTestId('plates-sheet')).toHaveClass(/\bvisible\b/);
		const target = sheet.getByRole('spinbutton', { name: 'Target weight' });

		for (const key of ['Escape', 'Enter']) {
			await target.focus();
			await page.keyboard.type('7');
			await page.keyboard.press(key);
			await page.waitForTimeout(800); // let the late frames run
			await expect(target, `after ${key}`).not.toBeFocused();
		}
		await expect(page.getByTestId('plates-sheet')).toHaveClass(/\bvisible\b/);
	});

	test('leaving a screen while a sheet is open releases the page scroll lock', async ({ page }) => {
		const overflow = () => page.evaluate(() => document.documentElement.style.overflow);

		// Arrive with the sheet opening by itself (Today's shortcut), then go Back.
		await page.goto('/today');
		await page.locator('a[href="/train?tool=plates"]').click();
		const sheet = page.getByRole('dialog', { name: 'Plate calculator' });
		await expect(sheet).toBeVisible();
		expect(await overflow()).toBe('hidden');
		await page.goBack();
		await expect(page).toHaveURL(/\/today$/);
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
		expect(await overflow()).toBe('');

		// Same with the sheet opened by hand after a client-side tab change.
		await page.evaluate(() => Object.assign(window, { __sameDocument: true }));
		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Train' })
			.click();
		await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
		await page.getByTestId('open-plates').click();
		await expect(sheet).toBeVisible();
		expect(await overflow()).toBe('hidden');
		await page.goBack();
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
		expect(await overflow()).toBe('');
		// Still the same document: these were client-side navigations, not reloads.
		expect(await page.evaluate(() => '__sameDocument' in window)).toBe(true);
	});

	test('the theme preference applies before first paint and persists', async ({ page }) => {
		const errors = trackConsoleErrors(page);
		await page.goto('/profile');
		const canvas = () =>
			page.evaluate(() => getComputedStyle(document.body).backgroundColor.replace(/\s/g, ''));
		expect(await canvas()).toBe('rgb(10,10,11)'); // dark by default

		await page.getByTestId('theme-control').getByRole('radio', { name: 'Light' }).click();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

		// After a reload the inline script (allowed by its CSP hash) applies it before paint.
		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		expect(await canvas()).toBe('rgb(244,244,240)');
		await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#f4f4f0');
		await expect(
			page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')
		).toHaveAttribute('content', 'default');

		await page.getByTestId('theme-control').getByRole('radio', { name: 'Dark' }).click();
		await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/);
		await expect(
			page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')
		).toHaveAttribute('content', 'black-translucent');

		// Auto follows the OS while the app is open, browser chrome included.
		const themeColor = page.locator('meta[name="theme-color"]');
		await page.emulateMedia({ colorScheme: 'dark' });
		await page.getByTestId('theme-control').getByRole('radio', { name: 'Auto' }).click();
		await expect(themeColor).toHaveAttribute('content', '#0a0a0b');
		await page.emulateMedia({ colorScheme: 'light' });
		await expect(themeColor).toHaveAttribute('content', '#f4f4f0');
		expect(await canvas()).toBe('rgb(244,244,240)');
		await page.emulateMedia({ colorScheme: 'dark' });
		await expect(themeColor).toHaveAttribute('content', '#0a0a0b');
		// Leaving Auto stops following the OS.
		await page.getByTestId('theme-control').getByRole('radio', { name: 'Dark' }).click();
		await page.emulateMedia({ colorScheme: 'light' });
		await expect(themeColor).toHaveAttribute('content', '#0a0a0b');
		expect(errors).toEqual([]);
	});

	test('no screen scrolls sideways', async ({ page }) => {
		for (const path of [...TABS.map((t) => t.path), '/profile/security', '/design', '/offline']) {
			await page.goto(path);
			await page.evaluate(() => document.fonts.ready);
			const { scrollWidth, innerWidth } = await page.evaluate(() => ({
				scrollWidth: document.documentElement.scrollWidth,
				innerWidth: window.innerWidth
			}));
			expect(scrollWidth, `${path} is ${scrollWidth}px wide`).toBeLessThanOrEqual(innerWidth);
			expect(innerWidth, `${path} widened the layout viewport`).toBe(page.viewportSize()!.width);
		}
	});

	test('signed-out screens do not scroll sideways either', async ({ browser }) => {
		const context = await browser.newContext({ storageState: signedOut });
		const page = await context.newPage();
		for (const path of ['/', '/recover']) {
			await page.goto(path);
			await page.evaluate(() => document.fonts.ready);
			const { scrollWidth, innerWidth } = await page.evaluate(() => ({
				scrollWidth: document.documentElement.scrollWidth,
				innerWidth: window.innerWidth
			}));
			expect(scrollWidth, `${path} is ${scrollWidth}px wide`).toBeLessThanOrEqual(innerWidth);
		}
		await context.close();
	});

	test('nothing sits under fixed chrome at rest', async ({ page, browser }) => {
		const viewport = page.viewportSize()!;

		// Sign-in: both ways in are above the fold.
		const context = await browser.newContext({ storageState: signedOut });
		const signIn = await context.newPage();
		await signIn.goto('/');
		for (const cta of [
			signIn.getByRole('button', { name: /sign in with passkey/i }),
			signIn.getByRole('link', { name: /use a recovery code/i })
		]) {
			const box = await cta.boundingBox();
			expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
		}
		await context.close();

		// Coach: the docked composer does not cover the suggested questions.
		await page.goto('/coach');
		await page.evaluate(() => document.fonts.ready);
		const composer = await page.getByRole('form', { name: 'Message your coach' }).boundingBox();
		for (const prompt of await page.locator('.prompt').all()) {
			const box = await prompt.boundingBox();
			expect(box!.y + box!.height).toBeLessThanOrEqual(composer!.y);
		}
	});

	test('compact segmented controls keep a 44px hit area', async ({ page }) => {
		await page.goto('/profile');
		const options = page.getByTestId('theme-control').getByRole('radio');
		await expect(options).toHaveCount(3);
		// Measure in the middle of the screen, clear of the fixed tab bar.
		await page
			.getByTestId('theme-control')
			.evaluate((el) => el.scrollIntoView({ block: 'center' }));
		for (const option of await options.all()) {
			const box = (await option.boundingBox())!;
			const x = box.x + box.width / 2;
			const mid = box.y + box.height / 2;
			for (const y of [mid - 21, mid + 21]) {
				const hit = await page.evaluate(
					([px, py]) => document.elementFromPoint(px!, py!)?.closest('[role="radio"]')?.textContent,
					[x, y]
				);
				expect(hit?.trim()).toBe((await option.textContent())?.trim());
			}
		}
	});
});

/**
 * The root error page is imported before every page hydrates, so its content loads on demand
 * (src/routes/error-page.ts): with the page on the server and on a server-rendered error, once
 * the app has gone idle, or when an error needs it.
 */
test.describe('the root error page, loaded on demand', () => {
	// Every request reaches page.route: none is answered from the service worker's precache.
	test.use({ serviceWorkers: 'block' });

	/** The error page's own chunk: the only code that hides the shell's offline notice. */
	const ERROR_PAGE_CHUNK = /hideOfflineNotice:!0/;

	/**
	 * Hands the error page's chunk to `handle` (every other script passes) and resolves `served`
	 * once it has been answered.
	 */
	async function onErrorPageChunk(
		page: Page,
		handle: (pass: () => Promise<void>, abort: () => Promise<void>) => Promise<void>
	) {
		let served = false;
		await page.route('**/_app/immutable/**/*.js', async (route) => {
			const response = await route.fetch();
			const body = await response.text();
			const pass = () => route.fulfill({ response, body });
			if (!ERROR_PAGE_CHUNK.test(body)) return pass();
			await handle(
				async () => {
					await pass();
					served = true;
				},
				() => route.abort('connectionrefused')
			);
		});
		return { served: () => served };
	}

	/** Profile's data request fails as a dropped connection: SvelteKit renders the root error page. */
	async function failProfileData(page: Page) {
		await page.route(
			(url) => url.pathname === '/profile/__data.json',
			(route) => route.abort('connectionrefused')
		);
		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Profile' })
			.click();
	}

	test('a server-rendered error page hydrates the markup the server sent', async ({ page }) => {
		await page.addInitScript(() => {
			const removed: string[] = [];
			new MutationObserver((records) => {
				for (const record of records)
					for (const node of record.removedNodes)
						if (
							node instanceof Element &&
							(node.matches('[data-testid="error-view"]') ||
								node.querySelector('[data-testid="error-view"]'))
						)
							removed.push(node.outerHTML.slice(0, 80));
			}).observe(document, { childList: true, subtree: true });
			Object.assign(window, { removed });
		});
		const errors = trackConsoleErrors(page);
		const response = await page.goto('/nothing-here');
		expect(response?.status()).toBe(404);
		expect(await response?.text()).toContain('data-root-error');
		await page.waitForLoadState('networkidle');
		await expect(page.getByRole('heading', { name: 'Nothing here' })).toBeVisible();
		expect(await page.evaluate(() => (window as unknown as { removed: string[] }).removed)).toEqual(
			[]
		);

		// Hydrated: its link is a client-side navigation, not a page load.
		await page.getByRole('link', { name: 'Back to Today' }).click();
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
		expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
		expect(errors).toEqual([]);
	});

	test('once the app has gone idle, an offline error renders without the network', async ({
		page,
		context
	}) => {
		const chunk = await onErrorPageChunk(page, (pass) => pass());
		await gotoHydrated(page, '/today');
		await expect.poll(chunk.served, { message: 'the idle load fetched the page' }).toBe(true);

		await context.setOffline(true);
		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Profile' })
			.click();
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
	});

	test('an error before the page has loaded shows once it arrives', async ({ page }) => {
		let requested = false;
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		const chunk = await onErrorPageChunk(page, async (pass) => {
			requested = true;
			await held;
			await pass();
		});
		// Not gotoHydrated: the held request keeps the network busy. The idle load asks for the
		// page after hydration, so the request also says the app has started.
		await page.goto('/today');
		await expect.poll(() => requested, { message: 'the idle load asked for the page' }).toBe(true);
		await failProfileData(page);
		// The error page has replaced Today, its content still on its way.
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toHaveCount(0);
		await expect(page.getByTestId('error-view')).toHaveCount(0);

		release();
		await expect(page.getByTestId('error-view')).toBeVisible();
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await expect(page.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
		expect(chunk.served()).toBe(true);
	});

	test('when the page cannot be fetched, the error still says so, with a way to try again', async ({
		page
	}) => {
		await onErrorPageChunk(page, (_pass, abort) => abort());
		await gotoHydrated(page, '/today');
		await failProfileData(page);
		await expect(page.getByRole('heading', { level: 1, name: "You're offline" })).toBeVisible();
		const retry = page.getByRole('link', { name: 'Try again' });
		await expect(retry).toHaveAttribute('href', '/profile');
		expect((await retry.boundingBox())?.height).toBeGreaterThanOrEqual(44);
	});
});
