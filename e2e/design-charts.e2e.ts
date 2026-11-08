/**
 * The chart kit on /design → Charts, on a phone (Chromium and WebKit): no chart code loads until
 * Show charts is pressed; the frame reserves the plot box, so nothing moves while the body's
 * chunk loads; a body that fails to load is a Notice with Retry, which loads it; the marks keep their pixel sizes at 320 and 393 px; /design links no
 * chart CSS as render-blocking; axe in both themes. The bar chart: per-mark tooltips by tap and
 * by keyboard, the stack order, totals that fit, its table twins and forced colours. The range and
 * diverging bars: statuses in words, the diverging tokens, tooltips by tap and keyboard, their
 * table twins and 44 px rows. The desktop
 * window is in
 * design-charts.desktop.e2e.ts; without JavaScript, the server render is checked by
 * src/routes/design/charts-no-js.test.ts (/design renders its panels in the browser only).
 */
import { expect, test, type Route } from '@playwright/test';
import {
	auditCharts,
	barBody,
	barFixture,
	barFrameOf,
	barMarks,
	barTip,
	chartsSection,
	expectBarCharts,
	expectBarMarkSizes,
	expectBarReadout,
	expectBarTable,
	expectLineCharts,
	expectLineMarkSizes,
	expectLineTable,
	expectMarkSizes,
	expectReadout,
	expectRowCharts,
	expectRowReadout,
	expectRowSizes,
	expectRowTable,
	expectTipInside,
	FIXTURE_BODY_MARK,
	fixtureBody,
	fixtureFrame,
	fixturePlot,
	lineBody,
	lineFixture,
	lineFrameOf,
	lineTip,
	linkedStylesheets,
	openCharts,
	PANEL_MARK,
	ROW_FIXTURE_IDS,
	rowBody,
	rowMarks,
	rowTip,
	slotPoint
} from './charts';
import {
	barModel,
	DIVERGE_WORDS,
	divergingModel,
	RANGE_STATUS,
	rangeModel,
	stepMark,
	stepRow
} from '../src/lib/ui/charts/bar-model';
import { DIVERGING } from '../src/lib/ui/charts/palette';
import { DIVERGING_FIXTURE, RANGE_FIXTURE } from '../src/routes/design/bar-fixture';
import { announce } from '../src/lib/ui/charts/line-model';
import { STACK_ORDER } from '../src/lib/ui/charts/palette';
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
		await expectLineMarkSizes(page);
		await expectBarMarkSizes(page);
		await expectRowSizes(page);
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
		for (const id of [
			'line-kinds',
			'line-converging',
			'line-so-far',
			'bar-adherence',
			'bar-stacked',
			'bar-target',
			'range-bars',
			'diverging-bars'
		]) {
			await lineFrameOf(page, id).scrollIntoViewIfNeeded();
			await captureScreen(page, testInfo, `design-charts-${id}-${width}`);
		}
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
		await expectLineCharts(page);
		await expectBarCharts(page);
		await expectRowCharts(page);
		// A row's tooltip shown, so axe reads it in this theme too.
		await rowMarks(page, 'range-bars').first().focus();
		await expect(rowTip(page, 'range-bars')).toHaveAttribute('data-shown', '');
		await fixtureFrame(page).getByText('Show as table').click();
		await expect(fixtureFrame(page).getByRole('table')).toBeVisible();
		await page.waitForTimeout(300);
		expect(await auditCharts(page)).toEqual([]);
		await fixtureFrame(page).scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, `design-charts-${theme}`);
	});
}

test.describe('/design → Charts: the line chart on a phone', () => {
	test('a finger scrubs it: a tap shows the nearest week, the tooltip stays inside the plot', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 320, height: 640 });
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectLineCharts(page);
		const id = 'line-converging';
		await lineFrameOf(page, id).scrollIntoViewIfNeeded();
		const last = lineFixture(id).data.slots.length - 1;
		for (const index of [0, 3, last]) {
			await page.touchscreen.tap(...(await slotPoint(page, id, index)));
			await expectReadout(page, id, index);
			await expectTipInside(page, id);
		}
		await captureScreen(page, testInfo, 'design-charts-line-scrub-320');
		// The week in progress reads 'so far' in the tooltip.
		const soFar = 'line-so-far';
		await lineFrameOf(page, soFar).scrollIntoViewIfNeeded();
		const now = lineFixture(soFar).data.slots.length - 1;
		await page.touchscreen.tap(...(await slotPoint(page, soFar, now)));
		await expectReadout(page, soFar, now);
		await expect(lineTip(page, soFar).locator('.tip-heading')).toContainText('so far');
	});

	test('at 320 px the lines are told apart without colour: numbered end labels the legend repeats', async ({
		page
	}) => {
		await page.setViewportSize({ width: 320, height: 640 });
		const id = 'line-converging';
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectLineCharts(page);
		const body = lineBody(page, id);
		await body.scrollIntoViewIfNeeded();
		const names = lineFixture(id).data.series.map((s) => s.label);
		const numbers = names.map((_, i) => String(i + 1));
		const items = body.getByTestId('line-legend').locator('li');
		for (const [i, name] of names.entries()) {
			await expect(items.nth(i).locator('.ordinal')).toBeVisible();
			await expect(items.nth(i)).toHaveText(`${i + 1}${name}`);
		}
		const labels = body.getByTestId('line-end-label');
		await expect(labels).toHaveCount(names.length);
		for (const label of await labels.all()) await expect(label).toBeVisible();
		expect((await labels.locator('.ordinal').allInnerTexts()).sort()).toEqual(numbers);
		// The 8, 8, 7 and 7 ends collide: leaders join the moved numbers to their lines.
		await expect(body.locator('path.leader').first()).toBeVisible();
		const inside = await body.evaluate((root) => {
			const edge = root.getBoundingClientRect().right;
			return [...root.querySelectorAll('[data-testid="line-end-label"]')].every(
				(el) => el.getBoundingClientRect().right <= edge + 0.5
			);
		});
		expect(inside, 'the numbers stay inside the chart').toBe(true);
	});

	test('a sideways drag scrubs it and a vertical swipe still scrolls the page', async ({
		page,
		browserName
	}) => {
		const id = 'line-kinds';
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectLineCharts(page);
		await lineFrameOf(page, id).scrollIntoViewIfNeeded();
		// What lets the page scroll under a finger: the plot claims only sideways movement.
		expect(
			await lineBody(page, id)
				.locator('.pc-area')
				.evaluate((el) => getComputedStyle(el).touchAction)
		).toBe('pan-y');
		// Touch moves are dispatched through Chromium's DevTools protocol.
		test.skip(browserName !== 'chromium', 'touch drags are dispatched on Chromium only');
		const cdp = await page.context().newCDPSession(page);
		const drag = async (from: [number, number], to: [number, number]) => {
			await cdp.send('Input.dispatchTouchEvent', {
				type: 'touchStart',
				touchPoints: [{ x: from[0], y: from[1] }]
			});
			for (let step = 1; step <= 10; step++) {
				const x = from[0] + ((to[0] - from[0]) * step) / 10;
				const y = from[1] + ((to[1] - from[1]) * step) / 10;
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
			}
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		};
		const [x1, y] = await slotPoint(page, id, 1);
		const [x6] = await slotPoint(page, id, 6);
		await drag([x1, y], [x6, y]);
		await expectReadout(page, id, 6);

		const before = await page.evaluate(() => scrollY);
		await drag([x6, y], [x6, y - 150]);
		await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(before);
		await cdp.detach();
	});

	test('the keyboard reads it: one tab stop; ←, →, Home and End move, and the live region says the week', async ({
		page
	}) => {
		const id = 'line-gaps';
		const { data } = lineFixture(id);
		const last = data.slots.length - 1;
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectLineCharts(page);
		const body = lineBody(page, id);
		await expect(body).toHaveAttribute('role', 'group');
		await expect(body).toHaveAttribute('tabindex', '0');
		await expect(body).toHaveAccessibleName(/^Bodyweight: use the arrow keys/);
		expect(
			await body.evaluate(
				(root) => root.querySelectorAll('a, button, input, select, textarea, [tabindex]').length
			),
			'nothing inside takes a tab stop of its own'
		).toBe(0);
		const live = body.getByTestId('line-live');
		await expect(live).toHaveAttribute('role', 'status');
		await body.focus();
		for (const [key, index] of [
			['Home', 0],
			['ArrowRight', 1],
			['ArrowRight', 2],
			['End', last],
			['ArrowRight', last],
			['ArrowLeft', last - 1]
		] as const) {
			await page.keyboard.press(key);
			await expectReadout(page, id, index);
			await expect(live).toHaveText(announce(data, index));
		}
		// The gap at week 3 is said in words, never skipped.
		await page.keyboard.press('Home');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await expect(live).toContainText('Bodyweight no data');
		await page.keyboard.press('Escape');
		await expect(lineTip(page, id)).not.toHaveAttribute('data-shown', '');
	});

	test('estimated, measured and so-far points differ by shape and by legend text', async ({
		page
	}) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectLineCharts(page);
		const shape = (id: string, kind: string) =>
			lineBody(page, id)
				.locator(`[data-testid="line-mark"][data-kind="${kind}"]`)
				.evaluateAll((els) =>
					els.map((el) => {
						const style = getComputedStyle(el);
						return {
							radius: style.borderRadius,
							rotate: style.rotate,
							outline: style.outlineStyle
						};
					})
				);
		const estimated = await shape('line-kinds', 'estimated');
		const measured = await shape('line-kinds', 'measured');
		const soFar = await shape('line-so-far', 'so-far');
		expect(estimated).toHaveLength(6);
		expect(measured).toHaveLength(2);
		expect(soFar).toHaveLength(1);
		for (const ring of estimated)
			expect(ring).toMatchObject({ radius: '50%', rotate: 'none', outline: 'none' });
		for (const diamond of measured)
			expect(diamond).toMatchObject({ rotate: '45deg', outline: 'none' });
		for (const ring of soFar) expect(ring).toMatchObject({ radius: '50%', outline: 'dashed' });
		// A ring is hollow (the surface inside), a diamond is filled with the series colour.
		const fill = (id: string, kind: string) =>
			lineBody(page, id)
				.locator(`[data-testid="line-mark"][data-kind="${kind}"]`)
				.first()
				.evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(await fill('line-kinds', 'estimated')).not.toBe(await fill('line-kinds', 'measured'));

		await expect(lineBody(page, 'line-kinds').getByTestId('line-legend')).toHaveText(
			/Estimated\s*Measured/
		);
		await expect(lineBody(page, 'line-so-far').getByTestId('line-legend')).toHaveText('So far');
		await expect(lineBody(page, 'line-so-far').locator('.so-far')).toHaveText('so far');
		// A plain series has no shape to name: no legend.
		await expect(lineBody(page, 'line-single').getByTestId('line-legend')).toHaveCount(0);
	});

	test('each table twin holds exactly its series', async ({ page }) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		for (const id of ['line-kinds', 'line-converging', 'line-gaps', 'line-so-far'])
			await expectLineTable(page, id);
	});

	test('nothing animates under reduced motion', async ({ page }) => {
		await page.emulateMedia({ reducedMotion: 'reduce' });
		const id = 'line-single';
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectLineCharts(page);
		await lineFrameOf(page, id).scrollIntoViewIfNeeded();
		await page.touchscreen.tap(...(await slotPoint(page, id, 2)));
		await expectReadout(page, id, 2);
		const tip = lineTip(page, id);
		expect(await tip.evaluate((el) => getComputedStyle(el).transitionProperty)).toBe('none');
		expect(
			await lineBody(page, id).evaluate(
				(el) => el.closest('figure')!.getAnimations({ subtree: true }).length
			)
		).toBe(0);
	});
});

test.describe('/design → Charts: the bar chart on a phone', () => {
	test('a tap shows a mark’s tooltip: its week, its part, the total and the plan', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 320, height: 640 });
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectBarCharts(page);
		const id = 'bar-stacked';
		const model = barModel(barFixture(id).data);
		await barFrameOf(page, id).scrollIntoViewIfNeeded();
		const area = await boxOf(barBody(page, id).locator('.pc-area'));
		// The first week's strength, the top of a middle week's stack, the week in progress, and
		// 12 Oct's short conditioning and combat: each keeps its taps from its neighbour's hit area.
		const part = (slot: number, key: string) =>
			model.marks.findIndex((m) => m.slot === slot && model.series[m.series]?.key === key);
		const picks = [
			0,
			model.marks.findIndex((m) => m.slot === 4 && m.last),
			model.marks.length - 1,
			part(3, 'conditioning'),
			part(3, 'combat')
		];
		expect(picks).not.toContain(-1);
		for (const index of picks) {
			const mark = barMarks(page, id).nth(index);
			const box = await boxOf(mark);
			await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
			await expectBarReadout(page, id, index);
			await expect(mark).toBeFocused();
			const tip = await boxOf(barTip(page, id));
			expect(tip.x).toBeGreaterThanOrEqual(area.x - 0.5);
			expect(tip.x + tip.width).toBeLessThanOrEqual(area.x + area.width + 0.5);
		}
		await captureScreen(page, testInfo, 'design-charts-bar-tap-320');
		// Every mark answers a finger over at least 24 × 24 px, however thin it is drawn.
		const hits = await barMarks(page, id).evaluateAll((els) =>
			els.map((el) => {
				const after = getComputedStyle(el, '::after');
				return [parseFloat(after.width), parseFloat(after.height)];
			})
		);
		for (const [w, h] of hits) {
			expect(w).toBeGreaterThanOrEqual(24);
			expect(h).toBeGreaterThanOrEqual(24);
		}
		// A missed week has nothing drawn, yet its plan is a mark a tap reaches.
		const missed = 'bar-adherence';
		const plan = barMarks(page, missed).and(page.locator('[data-plan]'));
		await expect(plan).toHaveCount(1);
		await plan.scrollIntoViewIfNeeded();
		const planBox = await boxOf(plan);
		await page.touchscreen.tap(planBox.x + planBox.width / 2, planBox.y + planBox.height / 2);
		const planIndex = barModel(barFixture(missed).data).marks.findIndex((m) => m.series < 0);
		await expectBarReadout(page, missed, planIndex);
		await expect(barTip(page, missed).locator('.tip-value').first()).toHaveText('0 runs');
	});

	test('the keyboard moves one tab stop between the marks; Escape hides the tooltip', async ({
		page
	}) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectBarCharts(page);
		const id = 'bar-stacked';
		const model = barModel(barFixture(id).data);
		const body = barBody(page, id);
		await expect(body).toHaveAttribute('role', 'group');
		await expect(body).toHaveAccessibleName(/^Training time by discipline: use the arrow keys/);
		const last = model.marks.length - 1;
		// Roving: only the newest mark is in the tab order until the keyboard moves.
		await expect(body.locator('[tabindex="0"]')).toHaveCount(1);
		await expect(barMarks(page, id).nth(last)).toHaveAttribute('tabindex', '0');
		await barMarks(page, id).nth(last).focus();
		await expectBarReadout(page, id, last);
		let at = last;
		for (const key of ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'Home', 'End']) {
			await page.keyboard.press(key);
			at = stepMark(model, at, key)!;
			await expect(barMarks(page, id).nth(at)).toBeFocused();
			await expect(barMarks(page, id).nth(at)).toHaveAttribute('tabindex', '0');
			await expectBarReadout(page, id, at);
		}
		await expect(body.locator('[tabindex="0"]')).toHaveCount(1);
		await page.keyboard.press('Escape');
		await expect(barTip(page, id)).not.toHaveAttribute('data-shown', '');
	});

	test('the parts stack in the one order, and strength is never next to combat', async ({
		page
	}) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectBarCharts(page);
		const id = 'bar-stacked';
		await expect(barBody(page, id).getByTestId('bar-legend').locator('li')).toHaveText([
			'Strength',
			'Hypertrophy',
			'Conditioning',
			'Combat',
			'Running',
			'Planned',
			'So far'
		]);
		const stacks = await barMarks(page, id).evaluateAll((els) => {
			const bySlot = new Map<string, { key: string; bottom: number }[]>();
			for (const el of els) {
				const slot = el.getAttribute('data-slot')!;
				const key = el.getAttribute('data-series')!;
				bySlot.set(slot, [
					...(bySlot.get(slot) ?? []),
					{ key, bottom: el.getBoundingClientRect().bottom }
				]);
			}
			// From the baseline up: the lowest part has the largest bottom on screen.
			return [...bySlot.values()].map((parts) =>
				parts.sort((a, b) => b.bottom - a.bottom).map((part) => part.key)
			);
		});
		expect(stacks).toHaveLength(barFixture(id).data.slots.length);
		for (const stack of stacks) {
			expect(stack).toEqual(STACK_ORDER.filter((key) => stack.includes(key)));
			stack.slice(1).forEach((key, i) => {
				expect([stack[i], key].sort(), 'strength next to combat').not.toEqual([
					'combat',
					'strength'
				]);
			});
		}
	});

	test('each bar chart’s table twin holds exactly what it draws', async ({ page }) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectBarCharts(page);
		for (const id of ['bar-adherence', 'bar-stacked', 'bar-target']) await expectBarTable(page, id);
	});

	test('a total sits on each complete stack only where it fits its week', async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 640 });
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectBarCharts(page);
		const caps = await barBody(page, 'bar-stacked')
			.locator('.cap')
			.evaluateAll((els) =>
				els.map((el) => {
					const text = el.querySelector('.cap-text') as HTMLElement;
					return {
						shown: getComputedStyle(text).display !== 'none',
						text: text.textContent,
						fits: text.scrollWidth <= el.clientWidth + 0.5
					};
				})
			);
		const model = barModel(barFixture('bar-stacked').data);
		expect(caps.map((cap) => cap.text)).toEqual(model.caps.map((cap) => cap.text));
		expect(caps.some((cap) => cap.shown)).toBe(true);
		for (const cap of caps) if (cap.shown) expect(cap.fits, `${cap.text} fits`).toBe(true);
		await expect(barBody(page, 'bar-stacked').getByTestId('bar-so-far')).toHaveText('so far');
	});

	test('under forced colours the parts are outlined and hatched, never told apart by hue', async ({
		page,
		browserName
	}, testInfo) => {
		test.skip(browserName !== 'chromium', 'forced colours are emulated on Chromium only');
		await page.emulateMedia({ forcedColors: 'active' });
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectBarCharts(page);
		const id = 'bar-stacked';
		const styles = await barMarks(page, id).evaluateAll((els) =>
			els.map((el) => {
				const style = getComputedStyle(el);
				return {
					slot: el.getAttribute('data-slot'),
					soFar: el.hasAttribute('data-so-far'),
					image: style.backgroundImage,
					border: style.borderTopStyle
				};
			})
		);
		for (const style of styles) {
			expect(style.image).toContain('repeating-linear-gradient');
			expect(style.border).toBe(style.soFar ? 'dashed' : 'solid');
		}
		// Neighbours in a stack alternate their hatch: 45° then 135°.
		const first = styles.filter((style) => style.slot === '0');
		expect(first.length).toBeGreaterThan(1);
		first.slice(1).forEach((style, i) => {
			const angles = [first[i]!.image, style.image].map((image) => /\d+deg/.exec(image)?.[0]);
			expect(new Set(angles)).toEqual(new Set(['45deg', '135deg']));
		});
		await barFrameOf(page, id).scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-charts-bar-forced-colors');
	});
});

test.describe('/design → Charts: range and diverging bars on a phone', () => {
	test('every status reads as words: the range beside an icon, the RPE side beside its value', async ({
		page
	}) => {
		await page.setViewportSize({ width: 320, height: 640 });
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectRowCharts(page);
		const range = rangeModel(RANGE_FIXTURE.data);
		const statuses = rowBody(page, 'range-bars').getByTestId('range-status');
		await expect(statuses).toHaveText(range.marks.map((m) => RANGE_STATUS[m.status!]));
		// Every status the chart can show is in the fixture, and each carries an icon.
		expect(new Set(range.marks.map((m) => m.status))).toEqual(
			new Set(['below', 'within', 'above'])
		);
		await expect(statuses.locator('svg')).toHaveCount(range.marks.length);
		await expect(rowBody(page, 'range-bars').getByTestId('row-legend')).toHaveText(
			/Done.*Target range.*Planned/
		);
		const diverging = divergingModel(DIVERGING_FIXTURE.data).marks.filter((m) => m.tone);
		await expect(rowBody(page, 'diverging-bars').getByTestId('diverging-value')).toHaveText(
			diverging.map((m) => m.text!)
		);
		await expect(rowBody(page, 'diverging-bars').getByTestId('diverging-side')).toHaveText(
			diverging.map((m) => DIVERGE_WORDS[m.tone!])
		);
		// A row with no RPE says so in words, and draws nothing.
		await expect(rowMarks(page, 'diverging-bars').last()).toContainText('No data');
		await expect(rowMarks(page, 'diverging-bars').last().getByTestId('diverging-fill')).toHaveCount(
			0
		);
	});

	test('the diverging bars wear the three diverging tokens: cool below, warm above, mid within ±0.5', async ({
		page
	}) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectRowCharts(page);
		const fills = rowBody(page, 'diverging-bars').getByTestId('diverging-fill');
		const drawn = await fills.evaluateAll((els, tokens) => {
			// Each token resolved the way the browser paints it, on a probe in the same chart.
			const resolve = (token: string) => {
				const probe = document.createElement('span');
				probe.style.backgroundColor = `var(${token})`;
				els[0]!.parentElement!.append(probe);
				const color = getComputedStyle(probe).backgroundColor;
				probe.remove();
				return color;
			};
			const colors = Object.fromEntries(
				Object.entries(tokens).map(([tone, token]) => [tone, resolve(token)])
			);
			return {
				colors,
				fills: els.map((el) => ({
					tone: el.getAttribute('data-tone')!,
					color: getComputedStyle(el).backgroundColor
				}))
			};
		}, DIVERGING);
		expect(new Set(Object.values(drawn.colors)).size, 'three distinct tokens').toBe(3);
		const tones = divergingModel(DIVERGING_FIXTURE.data).marks.flatMap((m) =>
			m.tone ? [m.tone] : []
		);
		expect(drawn.fills.map((fill) => fill.tone)).toEqual(tones);
		expect(new Set(tones)).toEqual(new Set(['below', 'zero', 'above']));
		for (const fill of drawn.fills) expect(fill.color, fill.tone).toBe(drawn.colors[fill.tone]);
	});

	test('a tap shows a row’s tooltip inside the plot, in the table’s words', async ({
		page
	}, testInfo) => {
		await page.setViewportSize({ width: 320, height: 640 });
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectRowSizes(page);
		for (const id of ROW_FIXTURE_IDS) {
			await page.getByTestId(id).scrollIntoViewIfNeeded();
			const count = await rowMarks(page, id).count();
			// The first row's tooltip opens under it, the last one's over it.
			for (const index of [0, count - 1, 1]) {
				const row = rowMarks(page, id).nth(index);
				const box = await boxOf(row);
				await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
				await expect(row).toBeFocused();
				await expectRowReadout(page, id, index);
			}
			await captureScreen(page, testInfo, `design-charts-${id}-tap-320`);
		}
	});

	test('the keyboard moves one tab stop between the rows; Escape hides the tooltip', async ({
		page
	}) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectRowCharts(page);
		for (const id of ROW_FIXTURE_IDS) {
			const body = rowBody(page, id);
			const rows = rowMarks(page, id);
			const count = await rows.count();
			await expect(body.getByRole('group')).toHaveAccessibleName(
				/: use the arrow keys to move between rows$/
			);
			await expect(body.locator('[tabindex="0"]')).toHaveCount(1);
			await expect(rows.first()).toHaveAttribute('tabindex', '0');
			await rows.first().focus();
			await expectRowReadout(page, id, 0);
			let at = 0;
			for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp', 'End', 'ArrowRight', 'Home']) {
				await page.keyboard.press(key);
				at = stepRow(count, at, key)!;
				await expect(rows.nth(at)).toBeFocused();
				await expect(rows.nth(at)).toHaveAttribute('tabindex', '0');
				await expectRowReadout(page, id, at);
			}
			await expect(body.locator('[tabindex="0"]')).toHaveCount(1);
			await page.keyboard.press('Escape');
			await expect(rowTip(page, id)).not.toHaveAttribute('data-shown', '');
		}
	});

	test('each table twin holds exactly its rows, in the chart’s order', async ({ page }) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectRowCharts(page);
		for (const id of ROW_FIXTURE_IDS) await expectRowTable(page, id);
	});
});
