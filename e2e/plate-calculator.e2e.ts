/**
 * Train's plate calculator is code-split together with the sheet it opens in: neither is part of
 * the screen's initial JavaScript. These specs prove the code arrives on intent, that a tap made
 * before it arrives still opens the sheet, and that a failed fetch has a designed Retry state
 * that recovers: in place, or through a reload of Train when the failure persists online. The
 * shell spec covers the calculator itself (stepper, units, Escape, focus return, ?tool=plates).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIResponse, type Page, type Route } from '@playwright/test';
import { captureScreen } from './support';

// Every script then comes from the page itself, as on a first visit: no service worker
// precaches the build behind it.
test.use({ serviceWorkers: 'block' });

/** The sheet's description: only Train's plate-sheet chunk carries it. */
const SHEET_MARKUP = 'Per side, heaviest plate first.';
const THEMES = ['dark', 'light'] as const;

/**
 * Serve the app's scripts, and hand each request for the sheet's chunk made after Train has
 * loaded to `sheet`. Returns `openTrain`, which loads Train hydrated and proves the sheet's
 * chunk was not part of that load (one fetched during it is served untouched, then reported).
 */
async function routeSheetChunk(
	page: Page,
	sheet: (route: Route, response: APIResponse) => Promise<void>
) {
	let loaded = false;
	const duringLoad: string[] = [];
	await page.route('**/_app/immutable/**/*.js', async (route) => {
		const response = await route.fetch().catch(() => null);
		if (!response) return route.abort('internetdisconnected'); // the context is offline
		const body = await response.text();
		if (!body.includes(SHEET_MARKUP)) return route.fulfill({ response, body });
		if (loaded) return sheet(route, response);
		duringLoad.push(route.request().url());
		await route.fulfill({ response, body });
	});
	return async function openTrain() {
		await page.goto('/train');
		// Hydrated first: a tap on the server-rendered row before then does nothing.
		await page.waitForLoadState('networkidle');
		expect(duringLoad, 'the sheet is not part of the initial load').toEqual([]);
		loaded = true;
	};
}

// routeSheetChunk handles every script, and one can still be on its way when a spec ends: the
// app loads web-vitals once the browser is idle, or 1.5 s after mount without
// requestIdleCallback, which can be a spec's last moments. Closing the context then disposes the
// response its handler is reading, and "Response has been disposed" fails a spec whose
// assertions all passed. So routing stops with the spec, and a handler still running is dropped.
test.afterEach(async ({ page }) => {
	await page.unrouteAll({ behavior: 'ignoreErrors' });
});

async function audit(page: Page): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

test('on a cold page the first tap opens the sheet, whose code is fetched on intent', async ({
	page
}, testInfo) => {
	const requested: string[] = [];
	let release = () => {};
	const held = new Promise<void>((resolve) => (release = resolve));
	const openTrain = await routeSheetChunk(page, async (route, response) => {
		requested.push(route.request().url());
		await held; // the tap lands while the sheet's code is still on its way
		await route.fulfill({ response });
	});

	await openTrain();
	const modulepreloads = () =>
		page.evaluate(() =>
			[...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')].map(
				(l) => l.href
			)
		);
	const preloaded = await modulepreloads();
	await page.getByTestId('open-plates').tap();
	await expect.poll(() => requested.length, { message: 'fetched on the tap' }).toBe(1);
	await expect(page.getByTestId('plates-sheet')).toHaveCount(0);
	await expect(page.getByTestId('open-plates').locator('..')).toHaveAttribute('aria-busy', 'true');
	await page.waitForTimeout(400); // past the beat before the row shows its spinner
	await captureScreen(page, testInfo, 'plate-calculator-pending');

	release();
	const sheet = page.getByRole('dialog', { name: 'Plate calculator' });
	await expect(sheet).toBeVisible();
	await expect(sheet.getByTestId('plates-result')).toContainText('25 · 15');
	await expect(page.getByTestId('open-plates').locator('..')).toHaveAttribute('aria-busy', 'false');
	expect(requested).toHaveLength(1);
	// Its code came through the import alone, never a <link rel=modulepreload>: WebKit answers
	// every later import of a URL whose modulepreload failed with that failure, even after a
	// reload, so Retry could never recover (vite.config.ts).
	expect(
		(await modulepreloads()).filter((href) => !preloaded.includes(href)),
		'no modulepreload for the sheet'
	).toEqual([]);
});

const failedNotice = (page: Page) =>
	page.getByRole('alert').filter({ hasText: 'Couldn’t open the plate calculator' });

for (const theme of THEMES) {
	test(`a sheet that fails to load offers Retry, which opens it (${theme} theme)`, async ({
		page
	}, testInfo) => {
		await page.addInitScript(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		const pageErrors: string[] = [];
		page.on('pageerror', (err) => pageErrors.push(err.message));
		let attempts = 0;
		let offline = true;
		const openTrain = await routeSheetChunk(page, async (route, response) => {
			attempts++;
			if (offline) await route.abort('internetdisconnected');
			else await route.fulfill({ response });
		});

		await openTrain();
		const row = page.getByTestId('open-plates');
		const notice = failedNotice(page);

		// A prefetch on hover that fails says nothing: the owner has not asked for the sheet.
		await row.hover();
		await expect.poll(() => attempts).toBe(1);
		await page.waitForTimeout(300);
		await expect(notice).toHaveCount(0);

		// The tap reports the failure inline, under the row, with a full-size Retry target.
		await row.tap();
		await expect(notice).toBeVisible();
		await expect(page.getByTestId('plates-sheet')).toHaveCount(0);
		await expect(row.locator('..')).toHaveAttribute('aria-busy', 'false');
		const target = await notice.getByRole('button', { name: 'Try again' }).boundingBox();
		expect(target?.width, 'Try again is at least 44 px wide').toBeGreaterThanOrEqual(44);
		expect(target?.height, 'Try again is at least 44 px tall').toBeGreaterThanOrEqual(44);
		if (theme === 'light')
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await page.evaluate(() => document.fonts.ready);
		expect(await audit(page)).toEqual([]);
		await captureScreen(page, testInfo, `plate-calculator-retry-${theme}`);

		// Back online, Retry opens the sheet: in place where the browser fetches a failed module
		// again, or by reloading Train with ?tool=plates where it does not (Chromium).
		offline = false;
		await notice.getByRole('button', { name: 'Try again' }).click();
		const sheet = page.getByRole('dialog', { name: 'Plate calculator' });
		await expect(sheet).toBeVisible();
		await expect(sheet.getByTestId('plates-result')).toContainText('25 · 15');
		await expect(notice).toHaveCount(0);
		await page.waitForTimeout(500); // let the sheet's entrance settle before measuring contrast
		expect(await audit(page)).toEqual([]);

		await sheet.getByRole('button', { name: 'Close' }).click();
		await expect(sheet).toBeHidden();
		await expect(page).toHaveURL(/\/train$/);
		expect(pageErrors).toEqual([]);
	});
}

test('a tap that fails again reloads Train asking for the sheet, unless offline', async ({
	page,
	context
}) => {
	const pageErrors: string[] = [];
	page.on('pageerror', (err) => pageErrors.push(err.message));
	// Every failed lazy import, counted from Vite's documented `vite:preloadError` event: Chromium
	// fails a repeated import from its module map, without a request page.route could count.
	await page.addInitScript(() => {
		let failures = 0;
		addEventListener('vite:preloadError', () => failures++);
		Object.defineProperty(window, '__failedImports', { get: () => failures });
	});
	const failedImports = () => page.evaluate(() => Reflect.get(window, '__failedImports') as number);
	const openTrain = await routeSheetChunk(page, (route) => route.abort('internetdisconnected'));
	await openTrain();
	const row = page.getByTestId('open-plates');
	const notice = failedNotice(page);
	const markDocument = () => page.evaluate(() => Object.assign(window, { __beforeRetry: true }));
	const sameDocument = () => page.evaluate(() => '__beforeRetry' in window);
	await row.tap();
	await expect(notice).toBeVisible();

	// A prefetch that fails while the notice is up (the pointer passing over the row) leaves it.
	const before = await failedImports();
	await row.hover();
	await expect.poll(failedImports, { message: 'the prefetch ran and failed' }).toBe(before + 1);
	await expect(notice).toBeVisible();

	// Online, a failure that persists (a browser that keeps it, or a chunk gone after a deploy)
	// reloads Train asking for the sheet. Tapping the row again is a retry too, as Retry is; the
	// fresh page tries once more and, still failing, says so again.
	await markDocument();
	await row.tap();
	await page.waitForURL(/\/train\?tool=plates$/);
	expect(await sameDocument(), 'a fresh document').toBe(false);
	await expect(notice).toBeVisible();
	await expect(page.getByTestId('plates-sheet')).toHaveCount(0);
	// The fresh page's resume bar loads after its first paint (on idle, or once it has painted where
	// there is no idle callback, as on WebKit): loaded while online, so the failures counted below
	// are the Retry's alone.
	await expect(page.locator('[data-testid="resume-slot"][data-looked="/train"]')).toBeAttached();
	// So does real-user monitoring (on idle, or 1.5 s after mount without an idle callback), which
	// marks the page once web-vitals has arrived.
	await expect(page.locator('html')).toHaveAttribute('data-rum', 'ready');

	// Offline, a reload could only reach the offline screen: the notice comes back instead.
	await markDocument();
	await context.setOffline(true);
	const offline = await failedImports();
	// Pressed, which leaves the pointer where it was: a click, and on WebKit a tap too, leave it
	// where Retry was, and as the notice goes the rest timer's row slides under it, whose hover
	// prefetch fails offline too and is counted.
	await notice.getByRole('button', { name: 'Try again' }).press('Enter');
	await expect.poll(failedImports, { message: 'the retry ran and failed' }).toBe(offline + 1);
	await expect(notice).toBeVisible();
	await page.waitForTimeout(500);
	await expect(notice).toBeVisible();
	await expect(page).toHaveURL(/\/train\?tool=plates$/);
	expect(await sameDocument(), 'the same document').toBe(true);
	expect(pageErrors).toEqual([]);
});

test('leaving Train while a Retry is on its way never brings the owner back', async ({
	page,
	browserName
}) => {
	test.skip(
		browserName === 'chromium',
		'Chromium fails a repeated import at once, from its module map: no Retry is ever in flight'
	);
	let held = false;
	let fail = () => {};
	const openTrain = await routeSheetChunk(page, async (route) => {
		if (held) await new Promise<void>((resolve) => (fail = resolve));
		held = true; // the first request fails at once; the Retry's is held until released
		await route.abort('internetdisconnected');
	});
	await openTrain();
	const notice = failedNotice(page);
	await page.getByTestId('open-plates').tap();
	await expect(notice).toBeVisible();
	await notice.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByTestId('open-plates').locator('..')).toHaveAttribute('aria-busy', 'true');

	await page
		.getByRole('navigation', { name: 'Primary' })
		.getByRole('link', { name: 'Today' })
		.click();
	await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
	fail();
	await page.waitForTimeout(1_000);
	await expect(page).toHaveURL(/\/today$/);
	await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
});
