/**
 * /design → Charts as the server renders it, which is what a browser without JavaScript shows:
 * each frame's title, context and summary, the plot box reserved with 'Chart needs JavaScript',
 * and the table twin holding exactly the fixture's numbers. /design only renders the panel in the
 * browser, so this renders it with svelte/server; the e2e spec covers the browser.
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { CHART_FIXTURE, FIXTURE_FRAME } from './chart-fixture.ts';
import ChartsPanel from './ChartsPanel.svelte';

const html = render(ChartsPanel).body;

/** The text of an HTML fragment: no tags, no Svelte comments, whitespace collapsed. */
const text = (fragment: string) =>
	fragment
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, '')
		.replace(/\s+/g, ' ')
		.trim();
const all = (fragment: string, tag: string) =>
	[...fragment.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map(
		([whole, inner]) => ({ whole, inner: inner! })
	);

const [fixture, unavailable] = all(html, 'figure');

describe('the charts panel without JavaScript', () => {
	it('server-renders the fixture frame: title, context, summary and a reserved plot', () => {
		expect(fixture).toBeDefined();
		const caption = text(all(fixture!.inner, 'figcaption')[0]!.inner);
		expect(caption).toBe(
			`${FIXTURE_FRAME.title} ${FIXTURE_FRAME.context.join(' · ')} ${FIXTURE_FRAME.summary}`
		);
		expect(fixture!.inner).toMatch(
			/data-testid="chart-plot"[^>]*style="block-size: 13rem;"|style="block-size: 13rem;"[^>]*data-testid="chart-plot"/
		);
		expect(fixture!.inner).toContain('aria-busy="true"');
		expect(all(fixture!.inner, 'noscript').map((n) => text(n.inner))).toEqual([
			'Chart needs JavaScript'
		]);
		// The body never renders on the server: it loads after hydration.
		expect(html).not.toContain('chart-fixture-body');
		expect(html).not.toContain('pc-chart-body');
	});

	it('holds exactly the fixture’s numbers in the table twin, the week in progress marked', () => {
		const table = all(fixture!.inner, 'table')[0]!.inner;
		const head = all(all(table, 'thead')[0]!.inner, 'th').map((th) => text(th.inner));
		expect(head).toEqual([
			'Week',
			'Strength (sets)',
			'Hypertrophy (sets)',
			'Conditioning (sets)',
			'Total (sets)',
			'Planned (sets)'
		]);
		expect(all(table, 'th').every(({ whole }) => /scope="(col|row)"/.test(whole))).toBe(true);
		const rows = all(all(table, 'tbody')[0]!.inner, 'tr').map((tr) => [
			...all(tr.inner, 'th').map((th) => text(th.inner)),
			...all(tr.inner, 'td').map((td) => text(td.inner))
		]);
		expect(rows).toEqual(
			CHART_FIXTURE.weeks.map((week) => {
				const { strength = 0, hypertrophy = 0, conditioning = 0 } = week.sets;
				const [, month, day] = week.monday.split('-').map(Number);
				return [
					`Week of ${day} ${month === 10 ? 'Oct' : 'Nov'}${week.inProgress ? ' so far' : ''}`,
					...[strength, hypertrophy, conditioning, strength + hypertrophy + conditioning].map(
						String
					),
					String(week.planned)
				];
			})
		);
		expect(text(all(fixture!.inner, 'summary')[0]!.inner)).toBe('Show as table');
	});

	it('has the six weeks and 15 stack segments e2e/charts.ts measures', () => {
		const parts = CHART_FIXTURE.weeks.flatMap((week) => Object.values(week.sets));
		expect(CHART_FIXTURE.weeks).toHaveLength(6);
		expect(parts.filter((sets) => (sets ?? 0) > 0)).toHaveLength(15);
	});

	it('shows an unavailable chart’s availability in place of the plot, and a missing value in words', () => {
		expect(unavailable).toBeDefined();
		expect(unavailable!.inner).toContain('Shows once you log a run');
		expect(unavailable!.inner).not.toContain('<noscript');
		expect(unavailable!.inner).not.toContain('aria-busy="true"');
		const cells = all(unavailable!.inner, 'td').map((td) => text(td.inner));
		expect(cells).toEqual(['—No data']); // the dash is hidden from screen readers
	});
});
