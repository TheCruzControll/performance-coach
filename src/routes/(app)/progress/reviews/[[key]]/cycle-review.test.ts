/**
 * The cycle review as the server renders it (what a browser without JavaScript shows): the hero
 * with each count's value in data-value, every section a disclosure with its verdict line, each
 * progression chart's room holding its table twin, the effectiveness table with Keep or Rotate,
 * the out-of-date notice, the History link, the earlier cycles the page passes in and the empty
 * write-up slot. The e2e spec covers the browser.
 */
import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { CycleReviewData } from './cycle-data.ts';
import type { NextCycleView } from './next-cycle-data.ts';
import CycleReview from './CycleReview.svelte';
import type { ReviewRow } from './load.ts';

const table = (label: string, value: string) => ({
	rowHeader: 'Session',
	columns: [{ label: 'Back squat', unit: 'kg' }],
	rows: [{ label, values: [value] }]
});

const review = (parts: Partial<CycleReviewData> = {}): CycleReviewData => ({
	kind: 'cycle',
	id: 'review-1',
	key: 'c-review-1',
	title: 'Base',
	dates: 'Mon 26 Oct – Sun 22 Nov',
	summary: 'Base: 22 of 24 sessions done.',
	legacy: false,
	adherence: {
		...{ pct: 91.7, text: '92%', level: 'good', words: '22 of 24 sessions done · On plan' },
		counts: [
			{ label: 'Planned', value: 24, words: '24 sessions' },
			{ label: 'Missed', value: 1, words: '1 session' }
		]
	},
	sections: [
		{
			id: 'strength',
			title: 'Strength progression',
			verdict: { level: 'good', words: 'Strength progression: 1 of 1 main lift progressed' },
			items: [],
			chart: null,
			charts: [
				{
					body: 'line',
					data: { title: 'Back squat estimated 1RM', slots: [], series: [] },
					title: 'Back squat estimated 1RM',
					context: ['The block', 'Estimated'],
					summary: 'Up 7.5 kg from the first session to the last: 120 to 127.5 kg.',
					table: table('Session on Mon 26 Oct', '120'),
					height: '9rem'
				}
			]
		},
		{
			id: 'effectiveness',
			title: 'Exercise effectiveness',
			verdict: { level: 'watch', words: '1 exercise to keep, 1 to rotate' },
			items: [],
			chart: null,
			table: {
				rowHeader: 'Exercise',
				columns: [{ label: 'How it did' }, { label: 'Next block' }],
				rows: [{ label: 'Curl', values: ['Held. Stalled', 'Rotate · a fresh stimulus'] }]
			}
		}
	],
	stale: null,
	earlier: [],
	history: null,
	writeUp: null,
	next: null,
	...parts
});

const html = (data: CycleReviewData, props = {}) =>
	render(CycleReview, { props: { review: data, ...props } }).body;
const text = (fragment: string) =>
	fragment
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
/** One section's markup: from its element to the next section's (its body follows its details). */
const sectionOf = (body: string, id: string) => {
	const rest = body.slice(body.search(new RegExp(`<div[^>]*data-section="${id}"`)));
	const next = rest.slice(1).search(/<div[^>]*data-testid="review-section"/);
	return next < 0 ? rest : rest.slice(0, next + 1);
};

describe('the cycle review on the server', () => {
	it('the hero: the block, its summary, adherence and each count’s value', () => {
		const body = html(review());
		expect(body).toMatch(/<h2 id="review-title"[^>]*>Base<\/h2>/);
		expect(text(body)).toContain('Cycle review · Mon 26 Oct – Sun 22 Nov');
		expect(body).toMatch(/data-value="91.7"[^>]*data-testid="review-adherence"/);
		expect(body).toMatch(
			/data-value="24"[^>]*data-testid="review-count-planned"[^>]*>24 sessions planned</
		);
		expect(body).toMatch(
			/data-value="1"[^>]*data-testid="review-count-missed"[^>]*>1 session missed</
		);
	});

	it('each section with its verdict line; a chart’s room holds its table twin', () => {
		const body = html(review());
		const strength = sectionOf(body, 'strength');
		expect(text(strength)).toContain('Strength progression: 1 of 1 main lift progressed');
		const twin = /<noscript>([\s\S]*?)<\/noscript>/.exec(strength)![1]!;
		expect(text(twin)).toContain('Back squat estimated 1RM: Up 7.5 kg');
		expect(text(twin)).toContain('Session on Mon 26 Oct 120');
	});

	it('effectiveness: a table in words, leading to Keep or Rotate', () => {
		const body = html(review());
		const section = sectionOf(body, 'effectiveness');
		const found = /<table[^>]*data-testid="section-table"[\s\S]*?<\/table>/.exec(section)![0];
		expect(text(found)).toBe(
			'Exercise How it did Next block Curl Held. Stalled Rotate · a fresh stimulus'
		);
		expect(found).toMatch(/<th scope="row"[^>]*>Curl<\/th>/);
	});

	it('out of date: the notice; nothing earlier: no earlier cycles; the write-up slot is empty', () => {
		const body = html(
			review({ stale: { words: 'Computed before 2 later changes', detail: 'Since.' } })
		);
		expect(text(/data-testid="review-stale"[\s\S]*?<\/div>\s*<\/div>/.exec(body)![0])).toContain(
			'Computed before 2 later changes'
		);
		expect(body).not.toContain('data-testid="earlier-cycles"');
		expect(text(/data-testid="review-write-up"[^>]*>([\s\S]*?)<\/div>/.exec(body)![1]!)).toBe('');
	});

	it('earlier cycles: the version it planned in History, and the page’s list of them', () => {
		const rows: ReviewRow[] = [
			{ state: 'reviewed', key: 'c-older', weekStartsOn: '2026-09-28', title: 'Older', text: '' }
		];
		const earlierCycles = createRawSnippet((list: () => ReviewRow[]) => ({
			render: () =>
				`<ol data-testid="earlier-list">${list()
					.map((r) => r.key)
					.join(',')}</ol>`
		}));
		const body = html(
			review({ earlier: rows, history: { version: 3, label: 'See version 3 in History' } }),
			{ earlierCycles }
		);
		expect(body).toMatch(/href="\/train\/history\/3"[^>]*>|data-testid="review-history"/);
		expect(body).toContain('href="/train/history/3"');
		expect(body).toContain('<ol data-testid="earlier-list">c-older</ol>');
	});

	it('the next block: its title and words hold the card’s place until it loads', () => {
		const next = {
			...{ state: 'applied', title: 'Next block planned · version 2', words: 'In your plan.' },
			...{ folded: false, previews: [], rotated: [], deload: null, link: null }
		} as NextCycleView;
		const body = html(review({ next }));
		const slot = /<section[^>]*data-testid="next-cycle-slot"[\s\S]*?<\/section>/.exec(body)![0];
		expect(slot).toContain('aria-busy="true"');
		expect(text(slot)).toBe('Next block planned · version 2 In your plan.');
		expect(html(review())).not.toContain('next-cycle-slot');
	});
});
