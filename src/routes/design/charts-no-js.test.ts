/**
 * /design → Charts as the server renders it, which is what a browser without JavaScript shows:
 * each frame's title, context and summary, the plot box reserved with 'Chart needs JavaScript',
 * and the table twin holding exactly the fixture's numbers. /design only renders the panel in the
 * browser, so this renders it with svelte/server; the e2e spec covers the browser. The trend
 * tiles too: their period links are real links that switch without JavaScript, and every tile's
 * sentence, number and sparkline is in the server's HTML.
 */
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import { CHART_FIXTURE, FIXTURE_FRAME } from './chart-fixture.ts';
import ChartsPanel from './ChartsPanel.svelte';
import { TILE_IDS } from './tile-fixture.ts';

/** The page the panel renders on: /design, with whatever ?period a test sets. */
const at = vi.hoisted(() => ({ url: new URL('http://app/design') }));
vi.mock('$app/state', () => ({
	page: {
		get url() {
			return at.url;
		}
	},
	navigating: { to: null }
}));

const renderAt = (search: string) => {
	at.url = new URL(`http://app/design${search}`);
	return render(ChartsPanel).body;
};
const html = renderAt('');

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

const section = (fragment: string, testId: string) => {
	const start = fragment.indexOf(`data-testid="${testId}"`);
	expect(start, testId).toBeGreaterThan(-1);
	return fragment.slice(start);
};
const tile = (fragment: string, id: string) => {
	const from = section(fragment, id);
	const end = from.indexOf('</li>');
	return from.slice(0, end);
};

describe('the trend tiles without JavaScript', () => {
	it('switch period with real links, one history entry each, the current one marked', () => {
		const picker = all(section(renderAt('?period=26w'), 'tiles-period'), 'nav')[0]!;
		expect(picker.whole).toMatch(/^<nav[^>]*aria-label="Period"/);
		expect(picker.whole).toMatch(/^<nav[^>]*data-sveltekit-reset="false"/);
		expect(picker.whole).not.toContain('replacestate');
		const links = [...picker.inner.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(
			([, attributes, inner]) => ({
				href: /href="([^"]+)"/.exec(attributes!)![1],
				current: /aria-current="page"/.test(attributes!),
				name: text(inner!.replace(/<span aria-hidden="true">[^<]*<\/span>/, ''))
			})
		);
		expect(links).toEqual([
			{ href: '?period=4w', current: false, name: 'Last 4 weeks' },
			{ href: '?period=12w', current: false, name: 'Last 12 weeks' },
			{ href: '?period=26w', current: true, name: 'Last 26 weeks' },
			{ href: '?period=52w', current: false, name: 'Last 52 weeks' },
			{ href: '?period=all', current: false, name: 'All time' }
		]);
	});

	it('render every tile’s sentence, canonical number and sparkline on the server', () => {
		const page = renderAt('?period=12w');
		for (const id of TILE_IDS) expect(tile(page, id)).toContain('data-testid="tile-sentence"');
		const squat = tile(page, 'tile-squat');
		expect(page).toMatch(/data-value="142.5"[^>]*data-testid="tile-squat"/);
		expect(squat).toMatch(/<polyline points="0,90 [^"]+"/);
		expect(text(all(squat, 'p')[0]!.inner)).toBe(
			'Squat · Estimated 1RM: 142.5 kg, estimated. +5 kg better than the 12 weeks before. ' +
				'This week so far: 140 kg · 137.5 kg by Wednesday last week. Real improvement.'
		);
		const empty = tile(page, 'tile-empty');
		expect(page).not.toMatch(/data-value="[^"]*"[^>]*data-testid="tile-empty"/);
		expect(text(all(empty, 'p')[0]!.inner)).toBe(
			'Long run: no data yet. This week so far: 5 km · nothing by Wednesday last week. ' +
				'Not enough data yet · 0 of 6 weeks.'
		);
		expect(empty).toMatch(
			/data-testid="so-far">This week so far: 5 km · nothing by Wednesday last week</
		);
		expect(empty).not.toContain('<polyline');
		// Only the loading example is busy: the tiles themselves are never served dimmed.
		const busy = [...page.matchAll(/aria-busy="(\w+)" data-testid="period-content"/g)].map(
			([, value]) => value
		);
		expect(busy).toEqual(['false', 'true']);
	});

	it('at 4 weeks, say each verdict reads the last 12 weeks, never that there is too little data', () => {
		const page = renderAt('?period=4w');
		const squat = text(all(tile(page, 'tile-squat'), 'p')[0]!.inner);
		expect(squat).toContain('+5 kg better than the 4 weeks before.');
		expect(squat).toMatch(/Real improvement over the last 12 weeks\.$/);
		expect(squat).not.toContain('Not enough data');
		expect(text(all(section(page, 'tiles-context'), 'p')[0]!.inner)).toBe(
			'Last 4 weeks · Compared with the 4 weeks before · Trend over the last 12 weeks · ' +
				'Good is a real rise over the trend window'
		);
	});

	it('at all time, say how the weeks moved in place of a comparison, and keep a verdict', () => {
		const page = renderAt('?period=all');
		const squat = text(all(tile(page, 'tile-squat'), 'p')[0]!.inner);
		// No earlier period: the trend within the window, never 'no earlier period' over a verdict.
		expect(squat).toContain('Improving over 87 weeks.');
		expect(squat).not.toContain('No earlier period');
		expect(squat).toMatch(/Real improvement\.$/);
		expect(text(all(section(page, 'tiles-context'), 'p')[0]!.inner)).toBe(
			'All time · Good is a real rise over the trend window'
		);
	});

	it('fall back to 12 weeks for an unknown period', () => {
		const picker = all(section(renderAt('?period=3w'), 'tiles-period'), 'nav')[0]!;
		expect(picker.inner).toMatch(/href="\?period=12w"[^>]*aria-current="page"/);
	});
});
