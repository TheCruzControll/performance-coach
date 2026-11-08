/**
 * The chart kit on /design → Charts, on a phone (Chromium and WebKit): no chart code loads until
 * Show charts is pressed; the frame reserves the plot box, so nothing moves while the body's
 * chunk loads; a body that fails to load is a Notice with Retry, which loads it; the marks keep their pixel sizes at 320 and 393 px; /design links no
 * chart CSS as render-blocking; axe in both themes. The desktop window is in
 * design-charts.desktop.e2e.ts; without JavaScript, the server render is checked by
 * src/routes/design/charts-no-js.test.ts (/design renders its panels in the browser only).
 */
import { expect, test, type Route } from '@playwright/test';
import {
	auditCharts,
	chartsSection,
	expectMarkSizes,
	FIXTURE_BODY_MARK,
	fixtureBody,
	fixtureFrame,
	fixturePlot,
	linkedStylesheets,
	openCharts,
	PANEL_MARK
} from './charts';
import { boxOf, expectNoShift, expectNoSideScroll } from './desktop';
import { captureScreen, gotoHydrated, trackConsoleErrors } from './support';

const IMMUTABLE_JS = '**/_app/immutable/**/*.js';

test.describe('/design → Charts, while the body loads', () => {
	// page.route does not see requests from a page the service worker controls on WebKit.
	test.use({ serviceWorkers: 'block' });

	test('no chart code loads until Show charts is pressed', async ({ page }) => {
		const loaded: string[] = [];
		await page.route(IMMUTABLE_JS, async (route: Route) => {
			const response = await route.fetch();
			const body = await response.text();
			if ([PANEL_MARK, FIXTURE_BODY_MARK].some((mark) => body.includes(mark)))
				loaded.push(route.request().url());
			return route.fulfill({ response, body });
		});
		await gotoHydrated(page, '/design');
		expect(loaded, 'a chart chunk before Show charts').toEqual([]);
		await expect(chartsSection(page)).toHaveCount(0);
		const toggle = page.getByRole('button', { name: 'Show charts' });
		await expect(toggle).toHaveAttribute('aria-expanded', 'false');
		const box = await boxOf(toggle);
		expect(box.height).toBeGreaterThanOrEqual(44);
		await openCharts(page);
		await expect(fixtureBody(page)).toBeVisible();
		expect(loaded.length, 'the panel and the fixture body').toBeGreaterThanOrEqual(2);
		await expect(page.getByRole('button', { name: 'Hide charts' })).toHaveAttribute(
			'aria-expanded',
			'true'
		);
	});

	test('the plot box is reserved: nothing moves when the body arrives', async ({
		page
	}, testInfo) => {
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(IMMUTABLE_JS, async (route: Route) => {
			const response = await route.fetch();
			const body = await response.text();
			if (body.includes(FIXTURE_BODY_MARK)) await held;
			return route.fulfill({ response, body });
		});
		await gotoHydrated(page, '/design');
		await openCharts(page);
		const plot = fixturePlot(page);
		await expect(plot).toHaveAttribute('aria-busy', 'true');
		await expect(fixtureBody(page)).toHaveCount(0);
		await expect(plot.getByText('Loading chart…')).toBeAttached();
		await page.waitForFunction(() => document.fonts.status === 'loaded');
		await fixtureFrame(page).scrollIntoViewIfNeeded();
		// Not captureScreen: it waits on document.fonts.ready, which WebKit resolves after load.
		await page.screenshot({
			path: `test-results/screens/${testInfo.project.name}/design-charts-loading.png`,
			animations: 'disabled'
		});
		const frame = fixtureFrame(page);
		await expectNoShift(page, {
			boxes: [
				frame,
				plot,
				frame.getByText('Show as table'),
				page.getByRole('heading', { level: 2, name: 'Icons' })
			],
			action: async () => {
				release();
				await expect(fixtureBody(page)).toBeVisible({ timeout: 15_000 });
			}
		});
		await expect(plot).toHaveAttribute('aria-busy', 'false');
	});

	test('a body that fails to load is a Notice with Retry, and Retry loads it', async ({
		page
	}, testInfo) => {
		let failing = true;
		await page.route(IMMUTABLE_JS, async (route: Route) => {
			const response = await route.fetch().catch(() => null);
			if (!response) return route.abort('internetdisconnected');
			const body = await response.text();
			if (failing && body.includes(FIXTURE_BODY_MARK)) return route.abort('internetdisconnected');
			return route.fulfill({ response, body });
		});
		await gotoHydrated(page, '/design');
		await openCharts(page);
		const failed = fixtureFrame(page).getByTestId('chart-failed');
		await expect(failed.getByRole('alert')).toContainText('Couldn’t load this chart');
		await expect(failed).toContainText('The numbers are in the table below.');
		await expect(fixturePlot(page)).toHaveAttribute('aria-busy', 'false');
		// The rest of the frame stands: its title and its table twin.
		await expect(
			fixtureFrame(page).getByRole('heading', { name: 'Hard sets a week' })
		).toBeVisible();
		await expect(fixtureFrame(page).getByText('Show as table')).toBeVisible();
		const retry = failed.getByRole('button', { name: 'Retry' });
		const box = await boxOf(retry);
		expect(box.height).toBeGreaterThanOrEqual(44);
		expect(box.width).toBeGreaterThanOrEqual(44);
		await failed.scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-charts-failed');
		expect(await auditCharts(page), 'failed, dark').toEqual([]);

		failing = false;
		await retry.click();
		// WebKit fetches the module again in place; Chromium keeps the failed fetch for the
		// document's lifetime, so the frame reloads the page, which loads it once Charts reopens.
		const reopen = page.getByRole('button', { name: 'Show charts' });
		await expect(fixtureBody(page).or(reopen)).toBeVisible({ timeout: 15_000 });
		if (await reopen.isVisible()) {
			await page.waitForLoadState('networkidle'); // hydrated, as gotoHydrated waits
			await openCharts(page);
		}
		await expect(fixtureBody(page)).toBeVisible({ timeout: 15_000 });
		await expect(fixtureFrame(page).getByTestId('chart-failed')).toHaveCount(0);
	});
});

for (const { width, height } of [
	{ width: 320, height: 640 },
	{ width: 393, height: 659 }
]) {
	test(`at ${width} px the marks keep their pixel sizes`, async ({ page }, testInfo) => {
		const errors = trackConsoleErrors(page);
		await page.setViewportSize({ width, height });
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectMarkSizes(page);
		await expect(fixturePlot(page)).toHaveAttribute('aria-busy', 'false');
		await fixtureFrame(page).scrollIntoViewIfNeeded();
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, `design-charts-${width}`);
		// The table twin opens below the plot, its wide rows scrolling inside the frame.
		await fixtureFrame(page).getByText('Show as table').click();
		await expect(fixtureFrame(page).getByRole('table')).toBeVisible();
		await expectNoSideScroll(page);
		await fixtureFrame(page).getByRole('table').scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, `design-charts-table-${width}`);
		expect(errors).toEqual([]);
	});
}

test('/design links no chart CSS as render-blocking', async ({ page }) => {
	const { html, css } = await linkedStylesheets(page);
	expect(css.length).toBeGreaterThan(0);
	// marks.css's reserved class and ChartFrame's own styles load only with the Charts section.
	for (const text of [html, ...css]) {
		expect(text).not.toContain('pc-chart');
		expect(text).not.toContain('--chart-axis-band');
	}
});

for (const theme of ['dark', 'light'] as const) {
	test(`the Charts section has no axe violations (${theme})`, async ({ page }, testInfo) => {
		await page.addInitScript(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await gotoHydrated(page, '/design');
		if (theme === 'light')
			await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
		await openCharts(page);
		await expect(fixtureBody(page)).toBeVisible();
		await expect(chartsSection(page).getByText('Shows once you log a run')).toBeVisible();
		await fixtureFrame(page).getByText('Show as table').click();
		await expect(fixtureFrame(page).getByRole('table')).toBeVisible();
		await page.waitForTimeout(300);
		expect(await auditCharts(page)).toEqual([]);
		await fixtureFrame(page).scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, `design-charts-${theme}`);
	});
}
