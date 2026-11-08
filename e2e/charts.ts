/**
 * The chart kit on /design → Charts (src/routes/design/ChartsPanel.svelte), shared by the phone
 * and desktop specs: where the fixture chart is, the pixel sizes its marks must keep at every
 * width, and axe on the section.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import {
	barModel,
	barReadout,
	barTable,
	divergingReadout,
	divergingTable,
	markName,
	rangeReadout,
	rangeTable,
	rowName
} from '../src/lib/ui/charts/bar-model';
import { lineModel, lineTable, readout } from '../src/lib/ui/charts/line-model';
import { BAR_FIXTURES, DIVERGING_FIXTURE, RANGE_FIXTURE } from '../src/routes/design/bar-fixture';
import { LINE_FIXTURES } from '../src/routes/design/line-fixture';

export const chartsSection = (page: Page) => page.getByTestId('design-charts');
export const fixtureFrame = (page: Page) => page.getByTestId('chart-fixture');
export const fixturePlot = (page: Page) => fixtureFrame(page).getByTestId('chart-plot');
export const fixtureBody = (page: Page) => page.getByTestId('chart-fixture-body');

/** A string only the fixture body's chunk holds: how a spec finds that chunk to hold or fail. */
export const FIXTURE_BODY_MARK = 'chart-fixture-body';
/** A string only the Charts panel's chunk holds (its template text; file names can be in others). */
export const PANEL_MARK = 'Shows once you log a run';

/** Open the Charts section: its code loads only then, as a component group's does on its tab. */
export async function openCharts(page: Page): Promise<void> {
	await page.getByRole('button', { name: 'Show charts' }).click();
}

/** The fixture's weeks (src/routes/design/chart-fixture.ts), one column and one marker each. */
const WEEKS = 6;
/** The stack segments it draws: its non-zero parts (three weeks have no conditioning). */
const SEGMENTS = 15;

/**
 * The fixture's marks at their pixel sizes, measured with getBoundingClientRect: each column at
 * most 24 px wide, a 2 px gap between stacked segments, every marker 8 × 8 px, and the planned
 * line a 2 px non-scaling stroke.
 */
export async function expectMarkSizes(page: Page): Promise<void> {
	await expect(fixtureBody(page)).toBeVisible();
	const { segments, markers, line } = await fixtureBody(page).evaluate((root) => {
		const box = (el: Element) => el.getBoundingClientRect();
		const path = root.querySelector('[data-testid="chart-line"]')!;
		return {
			segments: [...root.querySelectorAll('[data-testid="chart-seg"]')].map((el) => {
				const r = box(el);
				return { centre: r.x + r.width / 2, width: r.width, top: r.top, bottom: r.bottom };
			}),
			markers: [...root.querySelectorAll('[data-testid="chart-marker"]')].map((el) => {
				const r = box(el);
				return { width: r.width, height: r.height };
			}),
			line: {
				effect: getComputedStyle(path).getPropertyValue('vector-effect'),
				width: getComputedStyle(path).strokeWidth
			}
		};
	});
	expect(segments).toHaveLength(SEGMENTS);
	for (const segment of segments) {
		expect(segment.width, 'a column is at most 24 px wide').toBeLessThanOrEqual(24.01);
		expect(segment.width).toBeGreaterThan(4);
	}
	const columns = new Map<number, typeof segments>();
	for (const segment of segments) {
		const key = Math.round(segment.centre);
		columns.set(key, [...(columns.get(key) ?? []), segment]);
	}
	expect(columns.size, 'one column a week').toBe(WEEKS);
	const gaps = [...columns.values()].flatMap((column) => {
		const up = [...column].sort((a, b) => b.bottom - a.bottom); // from the baseline up
		return up.slice(1).map((segment, i) => up[i]!.top - segment.bottom);
	});
	expect(gaps.length).toBe(SEGMENTS - WEEKS);
	for (const gap of gaps)
		expect(Math.abs(gap - 2), `a ${gap} px stack gap`).toBeLessThanOrEqual(0.1);
	expect(markers).toHaveLength(WEEKS);
	for (const marker of markers) expect(marker).toEqual({ width: 8, height: 8 });
	expect(line).toEqual({ effect: 'non-scaling-stroke', width: '2px' });
}

/** axe (WCAG 2.1 A/AA) on the Charts section alone. */
export async function auditCharts(page: Page): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page })
		.include('[data-testid="design-charts"]')
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

/** The stylesheets /design links in its server-rendered HTML: render-blocking, every one. */
export async function linkedStylesheets(page: Page): Promise<{ html: string; css: string[] }> {
	const response = await page.request.get('/design');
	expect(response.ok()).toBe(true);
	const html = await response.text();
	const hrefs = [...html.matchAll(/<link\b[^>]*>/g)]
		.map(([tag]) => tag)
		.filter((tag) => /\brel="stylesheet"/.test(tag))
		.map((tag) => /\bhref="([^"]+)"/.exec(tag)![1]!);
	const css: string[] = [];
	for (const href of hrefs) {
		const sheet = await page.request.get(new URL(href, 'http://app/design').pathname);
		expect(sheet.ok(), href).toBe(true);
		css.push(await sheet.text());
	}
	return { html, css };
}

/** The line chart's fixtures on /design → Charts (src/routes/design/line-fixture.ts). */
export const lineFixture = (id: string) => LINE_FIXTURES.find((fixture) => fixture.id === id)!;
export const lineFrameOf = (page: Page, id: string) => page.getByTestId(id);
export const lineBody = (page: Page, id: string) => lineFrameOf(page, id).getByTestId('line-chart');
export const lineArea = (page: Page, id: string) => lineBody(page, id).locator('.pc-area');
export const lineTip = (page: Page, id: string) => lineBody(page, id).getByTestId('line-tooltip');

/** Every line fixture's body has loaded. */
export async function expectLineCharts(page: Page): Promise<void> {
	await expect(chartsSection(page).getByTestId('line-chart')).toHaveCount(LINE_FIXTURES.length);
}

/** Where slot `index` of a fixture sits in the window: its x, at mid-height of the plot. */
export async function slotPoint(page: Page, id: string, index: number): Promise<[number, number]> {
	const box = (await lineArea(page, id).boundingBox())!;
	const x = lineModel(lineFixture(id).data).xs[index]!;
	return [box.x + (box.width * x) / 100, box.y + box.height / 2];
}

/** The tooltip is shown on slot `index`, listing every series' value and kind in words. */
export async function expectReadout(page: Page, id: string, index: number): Promise<void> {
	const tip = lineTip(page, id);
	const { heading, rows } = readout(lineFixture(id).data, index);
	await expect(tip).toHaveAttribute('data-shown', '');
	await expect(tip.locator('.tip-heading')).toHaveText(heading);
	await expect(tip.locator('.tip-label')).toHaveText(rows.map((row) => row.label));
	await expect(tip.locator('.tip-value')).toHaveText(rows.map((row) => row.value ?? 'No data'));
	await expect(tip.locator('.tip-kind')).toHaveText(
		rows.flatMap((row) => (row.kind ? [row.kind === 'estimated' ? 'Estimated' : 'Measured'] : []))
	);
}

/** The tooltip lies inside the plot's data area, whichever slot it is on. */
export async function expectTipInside(page: Page, id: string): Promise<void> {
	const area = (await lineArea(page, id).boundingBox())!;
	const tip = (await lineTip(page, id).boundingBox())!;
	expect(tip.x).toBeGreaterThanOrEqual(area.x - 0.5);
	expect(tip.x + tip.width).toBeLessThanOrEqual(area.x + area.width + 0.5);
}

/**
 * Every line chart's marks keep their pixel sizes: an 8 × 8 px box for every marker, a measured
 * diamond as square on screen as its box (8√2 px across, turned 45°), and the lines 2 px
 * non-scaling strokes.
 */
export async function expectLineMarkSizes(page: Page): Promise<void> {
	await expectLineCharts(page);
	const marks = await chartsSection(page)
		.getByTestId('line-mark')
		.evaluateAll((els) =>
			els.map((el) => {
				const r = el.getBoundingClientRect();
				const box = el as HTMLElement;
				return {
					kind: el.getAttribute('data-kind'),
					box: [box.offsetWidth, box.offsetHeight],
					screen: [r.width, r.height]
				};
			})
		);
	const expected = LINE_FIXTURES.reduce((sum, f) => sum + lineModel(f.data).marks.length, 0);
	expect(marks).toHaveLength(expected);
	expect(marks.some((mark) => mark.kind === 'measured')).toBe(true);
	for (const mark of marks) {
		expect(mark.box, `a ${mark.kind} marker`).toEqual([8, 8]);
		const [w, h] = mark.screen as [number, number];
		expect(Math.abs(w - h), `a ${mark.kind} marker stays square`).toBeLessThanOrEqual(0.1);
		expect(w).toBeCloseTo(mark.kind === 'measured' ? 8 * Math.SQRT2 : 8, 1);
	}
	const strokes = await chartsSection(page)
		.getByTestId('line-path')
		.evaluateAll((els) =>
			els.map((el) => [getComputedStyle(el).strokeWidth, getComputedStyle(el).vectorEffect])
		);
	for (const stroke of strokes) expect(stroke).toEqual(['2px', 'non-scaling-stroke']);
}

/** The table twin of fixture `id` holds exactly its series: one row a week, a cell a series. */
export async function expectLineTable(page: Page, id: string): Promise<void> {
	const frame = lineFrameOf(page, id);
	await frame.getByText('Show as table').click();
	const table = lineTable(lineFixture(id).data);
	const rows = frame.getByRole('table').locator('tbody tr');
	await expect(rows).toHaveCount(table.rows.length);
	for (const [i, row] of table.rows.entries()) {
		await expect(rows.nth(i).locator('th')).toHaveText(
			`${row.label}${row.inProgress ? ' so far' : ''}`
		);
		await expect(rows.nth(i).locator('td')).toHaveText(
			row.values.map((value) => value ?? '—No data')
		);
	}
}

/** The bar chart's fixtures on /design → Charts (src/routes/design/bar-fixture.ts). */
export const barFixture = (id: string) => BAR_FIXTURES.find((fixture) => fixture.id === id)!;
export const barFrameOf = (page: Page, id: string) => page.getByTestId(id);
export const barBody = (page: Page, id: string) => barFrameOf(page, id).getByTestId('bar-chart');
export const barMarks = (page: Page, id: string) => barBody(page, id).getByTestId('bar-mark');
export const barTip = (page: Page, id: string) => barBody(page, id).getByTestId('bar-tooltip');

/** Every bar fixture's body has loaded. */
export async function expectBarCharts(page: Page): Promise<void> {
	await expect(chartsSection(page).getByTestId('bar-chart')).toHaveCount(BAR_FIXTURES.length);
}

/**
 * Every bar chart's marks keep their pixel sizes: each column at most 24 px wide, a 2 px gap
 * between stacked parts, and a 4 px rounded data end only: the baseline end and every part under
 * the top of its stack are square.
 */
export async function expectBarMarkSizes(page: Page): Promise<void> {
	await expectBarCharts(page);
	for (const { id, data } of BAR_FIXTURES) {
		const model = barModel(data);
		const marks = await barMarks(page, id).evaluateAll((els) =>
			els.map((el) => {
				const r = el.getBoundingClientRect();
				const style = getComputedStyle(el);
				return {
					slot: Number(el.getAttribute('data-slot')),
					plan: el.hasAttribute('data-plan'),
					width: r.width,
					top: r.top,
					bottom: r.bottom,
					radius: [
						style.borderTopLeftRadius,
						style.borderTopRightRadius,
						style.borderBottomRightRadius,
						style.borderBottomLeftRadius
					]
				};
			})
		);
		expect(marks, id).toHaveLength(model.marks.length);
		for (const [i, mark] of marks.entries()) {
			expect(mark.width, `${id}: a column is at most 24 px wide`).toBeLessThanOrEqual(24.01);
			expect(mark.width).toBeGreaterThan(4);
			const end = model.marks[i]!.last ? '4px' : '0px';
			expect(mark.radius, `${id}: a rounded data end only`).toEqual([end, end, '0px', '0px']);
		}
		const gaps = model.marks.flatMap((mark, i) =>
			i > 0 && mark.slot === model.marks[i - 1]!.slot && !mark.first
				? [marks[i - 1]!.top - marks[i]!.bottom]
				: []
		);
		if (model.stacked) expect(gaps.length, `${id}: stacked parts`).toBeGreaterThan(0);
		for (const gap of gaps)
			expect(Math.abs(gap - 2), `${id}: a ${gap} px stack gap`).toBeLessThanOrEqual(0.1);
	}
}

/** Mark `index`'s tooltip is shown, saying its week, its part, the total and the plan. */
export async function expectBarReadout(page: Page, id: string, index: number): Promise<void> {
	const { data } = barFixture(id);
	const { heading, rows } = barReadout(data, barModel(data), index);
	const tip = barTip(page, id);
	await expect(tip).toHaveAttribute('data-shown', '');
	await expect(tip.locator('.tip-heading')).toHaveText(heading);
	await expect(tip.locator('.tip-label')).toHaveText(rows.map((row) => row.label));
	await expect(tip.locator('.tip-value')).toHaveText(rows.map((row) => row.value));
	await expect(barMarks(page, id).nth(index)).toHaveAccessibleName(
		markName(data, barModel(data), index)
	);
}

/** The table twin of bar fixture `id` holds exactly what it draws: parts, total and plan. */
export async function expectBarTable(page: Page, id: string): Promise<void> {
	const frame = barFrameOf(page, id);
	await frame.getByText('Show as table').click();
	const table = barTable(barFixture(id).data);
	await expect(frame.getByRole('table').locator('thead th')).toHaveText([
		table.rowHeader,
		...table.columns.map((column) => new RegExp(`^\\s*${column.label}\\b`))
	]);
	const rows = frame.getByRole('table').locator('tbody tr');
	await expect(rows).toHaveCount(table.rows.length);
	for (const [i, row] of table.rows.entries()) {
		await expect(rows.nth(i).locator('th')).toHaveText(
			`${row.label}${row.inProgress ? ' so far' : ''}`
		);
		await expect(rows.nth(i).locator('td')).toHaveText(
			row.values.map((value) => value ?? '—No data')
		);
	}
}

/** The horizontal bar fixtures on /design → Charts: range bars and diverging bars. */
export const ROW_FIXTURES = {
	'range-bars': {
		fixture: RANGE_FIXTURE,
		body: 'range-chart',
		readout: (i: number) => rangeReadout(RANGE_FIXTURE.data, i),
		table: () => rangeTable(RANGE_FIXTURE.data)
	},
	'diverging-bars': {
		fixture: DIVERGING_FIXTURE,
		body: 'diverging-chart',
		readout: (i: number) => divergingReadout(DIVERGING_FIXTURE.data, i),
		table: () => divergingTable(DIVERGING_FIXTURE.data)
	}
} as const;
export type RowFixtureId = keyof typeof ROW_FIXTURES;
export const ROW_FIXTURE_IDS = Object.keys(ROW_FIXTURES) as RowFixtureId[];

export const rowBody = (page: Page, id: RowFixtureId) =>
	page.getByTestId(id).getByTestId(ROW_FIXTURES[id].body);
export const rowMarks = (page: Page, id: RowFixtureId) => rowBody(page, id).getByTestId('row-mark');
export const rowTip = (page: Page, id: RowFixtureId) =>
	rowBody(page, id).getByTestId('row-tooltip');

/** Both horizontal bar bodies have loaded, a row each for every group or exercise. */
export async function expectRowCharts(page: Page): Promise<void> {
	for (const id of ROW_FIXTURE_IDS)
		await expect(rowMarks(page, id)).toHaveCount(ROW_FIXTURES[id].fixture.data.rows.length);
}

/** Row `index`'s tooltip is shown with the table's words, inside the plot, and names the row. */
export async function expectRowReadout(page: Page, id: RowFixtureId, index: number): Promise<void> {
	const { heading, rows } = ROW_FIXTURES[id].readout(index);
	const tip = rowTip(page, id);
	await expect(tip).toHaveAttribute('data-shown', '');
	await expect(tip.locator('.tip-heading')).toHaveText(heading);
	await expect(tip.locator('.tip-label')).toHaveText(rows.map((row) => row.label));
	await expect(tip.locator('.tip-value')).toHaveText(rows.map((row) => row.value));
	await expect(rowMarks(page, id).nth(index)).toHaveAccessibleName(
		rowName(ROW_FIXTURES[id].readout(index))
	);
	const plot = (await page.getByTestId(id).getByTestId('chart-plot').boundingBox())!;
	const box = (await tip.boundingBox())!;
	expect(box.x).toBeGreaterThanOrEqual(plot.x - 0.5);
	expect(box.x + box.width).toBeLessThanOrEqual(plot.x + plot.width + 0.5);
	expect(box.y).toBeGreaterThanOrEqual(plot.y - 0.5);
	expect(box.y + box.height).toBeLessThanOrEqual(plot.y + plot.height + 0.5);
}

/** The table twin of row fixture `id` holds exactly its rows, in the chart's order. */
export async function expectRowTable(page: Page, id: RowFixtureId): Promise<void> {
	const frame = page.getByTestId(id);
	await frame.getByText('Show as table').click();
	const table = ROW_FIXTURES[id].table();
	await expect(frame.getByRole('table').locator('thead th')).toHaveText([
		table.rowHeader,
		...table.columns.map((column) => new RegExp(`^\\s*${column.label}\\b`))
	]);
	const rows = frame.getByRole('table').locator('tbody tr');
	await expect(rows).toHaveCount(table.rows.length);
	for (const [i, row] of table.rows.entries()) {
		await expect(rows.nth(i).locator('th')).toHaveText(row.label);
		await expect(rows.nth(i).locator('td')).toHaveText(
			row.values.map((value) => value ?? '—No data')
		);
	}
	// The chart reads in the table's order.
	const names = await rowMarks(page, id).evaluateAll((els) =>
		els.map((el) => el.getAttribute('aria-label')!.split('. ')[0])
	);
	expect(names).toEqual(table.rows.map((row) => row.label));
}

/** Every row is a target at least 44 px tall, none overflowing the plot box the frame reserved. */
export async function expectRowSizes(page: Page): Promise<void> {
	await expectRowCharts(page);
	for (const id of ROW_FIXTURE_IDS) {
		const plot = (await page.getByTestId(id).getByTestId('chart-plot').boundingBox())!;
		const rows = await rowMarks(page, id).evaluateAll((els) =>
			els.map((el) => {
				const r = el.getBoundingClientRect();
				return { bottom: r.bottom, height: r.height };
			})
		);
		for (const row of rows) {
			expect(row.height, `${id}: a 44 px row`).toBeGreaterThanOrEqual(44);
			expect(row.bottom).toBeLessThanOrEqual(plot.y + plot.height + 0.5);
		}
	}
}

/** The trend tiles on /design → Charts (src/routes/design/tile-fixture.ts), under their period links. */
export const tilesSection = (page: Page) => page.getByTestId('design-tiles');
export const tileOf = (page: Page, id: string) => page.getByTestId(id);
/** A period link by its name ('Last 4 weeks'), in the tiles' own picker (not the loading example). */
export const periodLink = (page: Page, name: string) =>
	page.getByRole('navigation', { name: 'Period', exact: true }).getByRole('link', { name });
