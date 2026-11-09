/**
 * The chart kit on /design → Charts in a desktop window (1440 × 900): the section keeps the left
 * column of the gallery, about a phone column wide, so no chart stretches; the marks keep their
 * pixel sizes; 'Show as table' and the table take a visible focus ring from the keyboard and Enter
 * opens the table; the table toggle and each week's hit area take a hover tint for the mouse; a
 * range or diverging row takes a hover tint and its tooltip from the mouse, and a ring from Tab.
 * The trend tiles pair up in the column; a period link takes a hover tint, and a ring and a switch
 * from the keyboard. Screenshots in both themes.
 */
import { expect, test, type Page } from '@playwright/test';
import {
	auditCharts,
	barFixture,
	barFrameOf,
	barMarks,
	chartsSection,
	expectBarMarkSizes,
	expectBarReadout,
	expectLineMarkSizes,
	expectMarkSizes,
	expectReadout,
	expectRowReadout,
	expectRowSizes,
	expectTipInside,
	fixtureBody,
	fixtureFrame,
	lineBody,
	lineFixture,
	lineFrameOf,
	lineTip,
	openCharts,
	periodLink,
	ROW_FIXTURE_IDS,
	rowMarks,
	rowTip,
	slotPoint,
	tileOf,
	tilesSection
} from './charts';
import { barModel } from '../src/lib/ui/charts/bar-model';
import { boxOf, DESKTOP, expectNoSideScroll, tokenPx } from './desktop';
import { captureScreen, gotoHydrated, trackConsoleErrors } from './support';

test.use(DESKTOP);

const background = (page: Page, selector: string) =>
	page
		.locator(selector)
		.first()
		.evaluate((el) => getComputedStyle(el).backgroundColor);

test.describe('/design → Charts on a desktop', () => {
	for (const theme of ['dark', 'light'] as const) {
		test(`the charts keep a readable column and their pixel sizes (${theme})`, async ({
			page
		}, testInfo) => {
			const errors = trackConsoleErrors(page);
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await gotoHydrated(page, '/design');
			await openCharts(page);
			if (theme === 'light')
				await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
			await expectMarkSizes(page);
			await expectLineMarkSizes(page);
			await expectBarMarkSizes(page);
			await expectRowSizes(page);
			const section = await boxOf(chartsSection(page));
			const color = await boxOf(page.getByRole('heading', { level: 2, name: 'Color' }));
			expect(Math.abs(section.x - color.x), 'in the left column').toBeLessThanOrEqual(1);
			expect(section.width, 'never wider than the readable column').toBeLessThanOrEqual(
				await tokenPx(page, '--content-readable')
			);
			expect(section.width, 'about a phone column').toBeGreaterThanOrEqual(
				(await tokenPx(page, '--content-max')) - 40
			);
			expect(await auditCharts(page)).toEqual([]);
			await fixtureFrame(page).scrollIntoViewIfNeeded();
			await expectNoSideScroll(page);
			await captureScreen(page, testInfo, `design-charts-${theme}-desktop`);
			await lineFrameOf(page, 'line-converging').scrollIntoViewIfNeeded();
			await captureScreen(page, testInfo, `design-charts-line-${theme}-desktop`);
			await barFrameOf(page, 'bar-stacked').scrollIntoViewIfNeeded();
			await captureScreen(page, testInfo, `design-charts-bar-${theme}-desktop`);
			for (const id of ROW_FIXTURE_IDS) {
				await page.getByTestId(id).scrollIntoViewIfNeeded();
				await captureScreen(page, testInfo, `design-charts-${id}-${theme}-desktop`);
			}
			expect(errors).toEqual([]);
		});
	}

	test('Show as table and the table take a ring from the keyboard; Enter opens it', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expect(fixtureBody(page)).toBeVisible();
		const summary = fixtureFrame(page).locator('summary');
		await summary.focus();
		const ring = () =>
			page.evaluate(() => {
				const style = getComputedStyle(document.activeElement!);
				return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
			});
		await page.keyboard.press('Shift+Tab');
		await page.keyboard.press('Tab');
		await expect(summary).toBeFocused();
		expect((await ring()).style).not.toBe('none');
		expect((await ring()).width).toBeGreaterThanOrEqual(2);
		await page.keyboard.press('Enter');
		await expect(fixtureFrame(page).locator('details')).toHaveAttribute('open', '');
		await page.keyboard.press('Tab');
		const region = fixtureFrame(page).getByRole('region', { name: 'Hard sets a week, table' });
		await expect(region).toBeFocused();
		expect((await ring()).width).toBeGreaterThanOrEqual(2);
		await fixtureFrame(page).scrollIntoViewIfNeeded();
		await captureScreen(page, testInfo, 'design-charts-table-desktop');
	});

	test('the table toggle and a week’s hit area take a hover tint', async ({ page }) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expect(fixtureBody(page)).toBeVisible();
		const summary = fixtureFrame(page).locator('summary');
		await summary.scrollIntoViewIfNeeded();
		const before = await summary.evaluate((el) => getComputedStyle(el).backgroundColor);
		await summary.hover();
		await expect
			.poll(() => summary.evaluate((el) => getComputedStyle(el).backgroundColor))
			.not.toBe(before);
		expect(await summary.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');

		const hit = '[data-testid="chart-fixture-body"] .pc-hit';
		const rest = await background(page, hit);
		await page.locator(hit).first().hover();
		await expect.poll(() => background(page, hit)).not.toBe(rest);
	});
});

test.describe('/design → Charts: the line chart on a desktop', () => {
	test('a mouse scrubs it: the crosshair and tooltip follow the nearest week and leave with the mouse', async ({
		page
	}, testInfo) => {
		const id = 'line-converging';
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectLineMarkSizes(page);
		await lineFrameOf(page, id).scrollIntoViewIfNeeded();
		const last = lineFixture(id).data.slots.length - 1;
		for (const index of [last, 0, 4]) {
			await page.mouse.move(...(await slotPoint(page, id, index)), { steps: 4 });
			await expectReadout(page, id, index);
			await expectTipInside(page, id);
		}
		const crosshair = lineBody(page, id).locator('.crosshair');
		await expect(crosshair).toHaveAttribute('data-shown', '');
		expect(
			await lineBody(page, id)
				.locator('.pc-area')
				.evaluate((el) => getComputedStyle(el).cursor)
		).toBe('crosshair');
		await captureScreen(page, testInfo, 'design-charts-line-scrub-desktop');
		await page.mouse.move(5, 5);
		await expect(lineTip(page, id)).not.toHaveAttribute('data-shown', '');
		await expect(crosshair).not.toHaveAttribute('data-shown', '');
	});

	test('the series are labelled at their ends, colliding labels moved apart with leaders', async ({
		page
	}) => {
		const id = 'line-converging';
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectLineMarkSizes(page);
		const labels = lineBody(page, id).getByTestId('line-end-label');
		await expect(labels).toHaveText(['Strength', 'Hypertrophy', 'Conditioning', 'Combat'], {
			useInnerText: true
		});
		const boxes = (
			await labels.evaluateAll((els) =>
				els.map((el) => {
					const r = el.getBoundingClientRect();
					return { top: r.top, bottom: r.bottom };
				})
			)
		).sort((a, b) => a.top - b.top);
		boxes
			.slice(1)
			.forEach((box, i) =>
				expect(box.top, 'end labels never overlap').toBeGreaterThanOrEqual(boxes[i]!.bottom - 0.5)
			);
		// 8, 8, 7 and 7 sets end within a label's height of each other: leaders join them.
		await expect(lineBody(page, id).locator('path.leader')).not.toHaveCount(0);
		await expect(lineBody(page, id).locator('path.leader').first()).toBeVisible();
		await expect(lineBody(page, id).getByTestId('line-legend')).toContainText('Strength');
	});

	test('the chart takes one tab stop with a visible ring, and the arrow keys move it', async ({
		page
	}) => {
		const id = 'line-single';
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectLineMarkSizes(page);
		const body = lineBody(page, id);
		await lineFrameOf(page, id).locator('h3').click();
		await page.keyboard.press('Tab');
		await expect(body).toBeFocused();
		const ring = await body.evaluate((el) => {
			const style = getComputedStyle(el);
			return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
		});
		expect(ring.style).not.toBe('none');
		expect(ring.width).toBeGreaterThanOrEqual(2);
		const last = lineFixture(id).data.slots.length - 1;
		await expectReadout(page, id, last);
		await page.keyboard.press('ArrowLeft');
		await expectReadout(page, id, last - 1);
		await page.keyboard.press('Tab');
		await expect(body).not.toBeFocused();
		await expect(lineTip(page, id)).not.toHaveAttribute('data-shown', '');
	});
});

test.describe('/design → Charts: the bar chart on a desktop', () => {
	test('a mouse over a mark outlines it and shows its tooltip, which leaves with the mouse', async ({
		page
	}, testInfo) => {
		const id = 'bar-stacked';
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectBarMarkSizes(page);
		await barFrameOf(page, id).scrollIntoViewIfNeeded();
		const mark = barMarks(page, id).nth(3);
		const outline = () => mark.evaluate((el) => getComputedStyle(el).outlineStyle);
		expect(await outline()).toBe('none');
		await mark.hover();
		await expectBarReadout(page, id, 3);
		await expect.poll(outline).toBe('solid');
		await captureScreen(page, testInfo, 'design-charts-bar-hover-desktop');
		// 12 Oct's short conditioning and combat each keep their hover from the other's hit area.
		const model = barModel(barFixture(id).data);
		for (const key of ['conditioning', 'combat']) {
			const index = model.marks.findIndex(
				(m) => m.slot === 3 && model.series[m.series]?.key === key
			);
			const box = await boxOf(barMarks(page, id).nth(index));
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await expectBarReadout(page, id, index);
		}
		await page.mouse.move(5, 5);
		await expect(barFrameOf(page, id).getByTestId('bar-tooltip')).not.toHaveAttribute(
			'data-shown',
			''
		);
		await expect.poll(outline).toBe('none');
	});

	test('Tab reaches the newest mark with a visible ring, and the arrow keys move it', async ({
		page
	}) => {
		const id = 'bar-target';
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectBarMarkSizes(page);
		await barFrameOf(page, id).locator('h3').click();
		await page.keyboard.press('Tab');
		const marks = barMarks(page, id);
		const last = (await marks.count()) - 1;
		await expect(marks.nth(last)).toBeFocused();
		const ring = await marks.nth(last).evaluate((el) => {
			const style = getComputedStyle(el);
			return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
		});
		expect(ring.style).toBe('solid');
		expect(ring.width).toBeGreaterThanOrEqual(2);
		await expectBarReadout(page, id, last);
		await page.keyboard.press('ArrowLeft');
		await expect(marks.nth(last - 1)).toBeFocused();
		await expectBarReadout(page, id, last - 1);
		await page.keyboard.press('Tab');
		await expect(marks.nth(last - 1)).not.toBeFocused();
		await expect(barFrameOf(page, id).getByTestId('bar-tooltip')).not.toHaveAttribute(
			'data-shown',
			''
		);
	});
});

test.describe('/design → Charts: range and diverging bars on a desktop', () => {
	test('a mouse over a row tints it and shows its tooltip, which leaves with the mouse', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectRowSizes(page);
		for (const id of ROW_FIXTURE_IDS) {
			await page.getByTestId(id).scrollIntoViewIfNeeded();
			const row = rowMarks(page, id).nth(1);
			const tint = () => row.evaluate((el) => getComputedStyle(el).backgroundColor);
			const rest = await tint();
			await row.hover();
			await expectRowReadout(page, id, 1);
			await expect.poll(tint).not.toBe(rest);
			await captureScreen(page, testInfo, `design-charts-${id}-hover-desktop`);
			await page.mouse.move(5, 5);
			await expect(rowTip(page, id)).not.toHaveAttribute('data-shown', '');
			await expect.poll(tint).toBe(rest);
		}
	});

	test('Tab reaches the first row with a visible ring, and the arrow keys move it', async ({
		page
	}) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		await expectRowSizes(page);
		for (const id of ROW_FIXTURE_IDS) {
			await page.getByTestId(id).locator('h3').click();
			await page.keyboard.press('Tab');
			const rows = rowMarks(page, id);
			await expect(rows.first()).toBeFocused();
			const ring = await rows.first().evaluate((el) => {
				const style = getComputedStyle(el);
				return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
			});
			expect(ring.style).toBe('solid');
			expect(ring.width).toBeGreaterThanOrEqual(2);
			await expectRowReadout(page, id, 0);
			await page.keyboard.press('ArrowDown');
			await expect(rows.nth(1)).toBeFocused();
			await expectRowReadout(page, id, 1);
			await page.keyboard.press('Tab');
			await expect(rows.nth(1)).not.toBeFocused();
			await expect(rowTip(page, id)).not.toHaveAttribute('data-shown', '');
		}
	});
});

test.describe('/design → Charts: trend tiles on a desktop', () => {
	for (const theme of ['dark', 'light'] as const) {
		test(`the tiles pair up in the column, never stretched (${theme})`, async ({
			page
		}, testInfo) => {
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			await gotoHydrated(page, '/design');
			await openCharts(page);
			if (theme === 'light')
				await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
			const section = await boxOf(chartsSection(page));
			const squat = await boxOf(tileOf(page, 'tile-squat'));
			const pace = await boxOf(tileOf(page, 'tile-pace'));
			expect(Math.abs(squat.y - pace.y), 'two tiles a row').toBeLessThanOrEqual(1);
			expect(pace.x).toBeGreaterThan(squat.x + squat.width);
			expect(squat.width, 'about half the column').toBeLessThan(section.width / 2);
			expect(pace.x + pace.width).toBeLessThanOrEqual(section.x + section.width + 0.5);
			await tilesSection(page).scrollIntoViewIfNeeded();
			await expectNoSideScroll(page);
			expect(await auditCharts(page)).toEqual([]);
			await captureScreen(page, testInfo, `design-tiles-${theme}-desktop`);
		});
	}

	test('a period link takes a hover tint and a ring from the keyboard, and Enter switches', async ({
		page
	}) => {
		await gotoHydrated(page, '/design');
		await openCharts(page);
		const link = periodLink(page, 'Last 26 weeks');
		await link.scrollIntoViewIfNeeded();
		const tint = () => link.evaluate((el) => getComputedStyle(el).backgroundColor);
		const rest = await tint();
		await link.hover();
		await expect.poll(tint).not.toBe(rest);
		await page.mouse.move(5, 5);
		await expect.poll(tint).toBe(rest);

		await periodLink(page, 'Last 12 weeks').focus();
		await page.keyboard.press('Tab');
		await expect(link).toBeFocused();
		const ring = await link.evaluate((el) => {
			const style = getComputedStyle(el);
			return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
		});
		expect(ring.style).toBe('solid');
		expect(ring.width).toBeGreaterThanOrEqual(2);
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(/\?period=26w$/);
		await expect(link).toHaveAttribute('aria-current', 'page');
		await expect(link).toBeFocused();

		const summary = page.getByTestId('tiles-context').locator('summary');
		const before = await summary.evaluate((el) => getComputedStyle(el).backgroundColor);
		await summary.hover();
		await expect
			.poll(() => summary.evaluate((el) => getComputedStyle(el).backgroundColor))
			.not.toBe(before);
	});
});
