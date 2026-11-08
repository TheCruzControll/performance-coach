/**
 * The chart kit on /design → Charts (src/routes/design/ChartsPanel.svelte), shared by the phone
 * and desktop specs: where the fixture chart is, the pixel sizes its marks must keep at every
 * width, and axe on the section.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

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
