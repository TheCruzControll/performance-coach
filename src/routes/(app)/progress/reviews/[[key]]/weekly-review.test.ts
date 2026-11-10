/**
 * The weekly review as the server renders it (what a browser without JavaScript shows): an
 * out-of-date review's notice with a Refresh form that posts the live revision's id, none once it
 * is decided, the body (ReviewBody) as the markup the load sent, and each section a disclosure
 * whose summary holds its title and verdict line, its figures and chart (title, summary and,
 * without JavaScript, its numbers) after it. The e2e spec covers the browser.
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { staleNotice, type WeeklyReviewData } from './load.ts';
import type { SectionView } from './sections.ts';
import ReviewBody from './ReviewBody.svelte';
import WeeklyReview from './WeeklyReview.svelte';

const RPE: SectionView = {
	id: 'rpe',
	title: 'RPE against target',
	verdict: { level: 'watch', words: 'Bench press RPE against target: Felt easier' },
	items: [
		{
			id: 'rpe:average',
			label: 'Average RPE',
			words: 'About right',
			figures: [{ label: 'Mean', words: 'RPE 7.8', value: 7.8 }],
			reasons: []
		}
	],
	chart: {
		body: 'diverging',
		data: { title: 'RPE against target', rows: [] },
		title: 'RPE against target',
		context: ['This week'],
		summary: 'Bench press: Easier than prescribed.',
		table: {
			rowHeader: 'Exercise',
			columns: [{ label: 'Actual', unit: 'RPE' }, { label: 'Status' }],
			rows: [{ label: 'Bench press', values: ['7', 'Easier'] }]
		},
		height: '6rem'
	}
};

const review = (parts: Partial<WeeklyReviewData> = {}): WeeklyReviewData => ({
	kind: 'weekly',
	id: 'review-2',
	key: 'w-2026-10-26',
	weekStartsOn: '2026-10-26',
	title: 'Week of 26 Oct',
	dates: 'Mon 26 Oct – Sun 1 Nov',
	summary: 'A solid week.',
	legacy: false,
	adherence: null,
	trends: [],
	notes: [],
	sections: [RPE],
	stale: null,
	writeUp: null,
	...parts
});

const html = (data: WeeklyReviewData) => render(WeeklyReview, { props: { review: data } }).body;
const bodyHtml = (data: WeeklyReviewData) => render(ReviewBody, { props: { review: data } }).body;
const text = (fragment: string) =>
	fragment
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, '')
		.replace(/\s+/g, ' ')
		.trim();

describe('the weekly review on the server', () => {
	it('out of date and open: the notice, and Refresh posts the live revision', () => {
		const body = html(review({ stale: staleNotice(3, true) }));
		const form = /<form[^>]*data-testid="review-stale"[\s\S]*?<\/form>/.exec(body)?.[0] ?? '';
		expect(form).toMatch(/method="POST"/);
		expect(form).toMatch(/action="\?\/refresh"/);
		expect(form).toMatch(/<input type="hidden" name="reviewId" value="review-2"/);
		expect(text(form)).toContain('Computed before 3 later changes');
		expect(form).toMatch(
			/<button[^>]*type="submit"[^>]*data-testid="review-refresh"|data-testid="review-refresh"[^>]*type="submit"/
		);
	});

	it('out of date but decided: the notice says it stays, with no Refresh', () => {
		const body = html(review({ stale: staleNotice(1, false) }));
		expect(text(body)).toContain('You’ve decided on its changes, so it stays as it was.');
		expect(body).not.toContain('review-refresh');
	});

	it('up to date: no notice', () => {
		expect(html(review())).not.toContain('review-stale');
	});

	it('sends the body as the markup the load rendered, between the counts and the write-up', () => {
		const sent = render(WeeklyReview, {
			props: { review: review(), served: '<section>the body</section>' }
		}).body;
		expect(sent).toMatch(
			/<div data-served(="")? style="display: contents">(<!--[^>]*-->)?<section>the body<\/section>/
		);
		expect(sent.indexOf('the body')).toBeLessThan(sent.indexOf('data-testid="review-write-up"'));
		expect(html(review())).not.toContain('data-served');
	});

	it('each section is a disclosure, collapsed until opened, its verdict line in the summary', () => {
		const sent = bodyHtml(review());
		const start = sent.search(/<div[^>]*data-section="rpe"/);
		expect(start).toBeGreaterThan(-1);
		const section = sent.slice(start);
		expect(/<details[^>]*>/.exec(section)![0]).not.toMatch(/\bopen\b/);
		// The body follows the disclosure, so only a closed one below 1024 px hides it.
		expect(section).toMatch(/<\/details>\s*<div class="body/);
		const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(section)![1]!;
		expect(text(summary)).toBe('RPE against target Bench press RPE against target: Felt easier');
		expect(section).toMatch(
			/data-label="Mean"[^>]*data-value="7.8"|data-value="7.8"[^>]*data-label="Mean"/
		);
		// The chart's room is reserved; without JavaScript its title, summary and numbers fill it,
		// and the frame itself loads after hydration.
		const slot = /<figure class="slot[^>]*>/.exec(section)?.[0] ?? '';
		expect(slot).toContain('style="--plot: 6rem;"');
		expect(slot).toContain('aria-busy="true"');
		const noscript = /<noscript>([\s\S]*?)<\/noscript>/.exec(section)?.[1] ?? '';
		expect(text(noscript.replace(/></g, '> <'))).toBe(
			'RPE against target: Bench press: Easier than prescribed. Exercise Actual (RPE) Status Bench press 7 Easier'
		);
		expect(section).not.toContain('Show as table');
	});

	it('a legacy review has no sections', () => {
		expect(bodyHtml(review({ legacy: true, sections: [] }))).not.toContain('review-section');
	});
});
