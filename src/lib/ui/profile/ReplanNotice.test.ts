/**
 * Profile's re-plan notice as the server renders it: one polite live region, empty until an
 * answer comes, then the state's line, its link where it has one, and Retry only for a failure.
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { ReplanResult } from './replan-notice.ts';
import ReplanNotice from './ReplanNotice.svelte';

const notice = (props: { replan: ReplanResult | null; checking?: boolean }) =>
	render(ReplanNotice, { props }).body;

describe('the re-plan notice', () => {
	it('is an empty polite live region before any answer', () => {
		const html = notice({ replan: null });
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain('data-testid="replan-notice"');
		// No text, not even whitespace: `:empty` hides the region, so it takes no room.
		const inner = html.match(/data-testid="replan-notice">([\s\S]*)<\/div>/)?.[1] ?? '';
		expect(inner.replace(/<!--[\s\S]*?-->/g, '')).toBe('');
	});

	it('links a re-plan to review to its proposal', () => {
		const html = notice({ replan: { state: 'proposed', proposalId: 'p-1' } });
		expect(html).toContain('Your plan can follow these priorities · ');
		expect(html).toContain('href="/coach/proposals/p-1"');
		expect(html).toContain('Review the re-plan');
	});

	it('states an unchanged or deferred plan with no link and no button', () => {
		for (const state of ['unchanged', 'deferred'] as const) {
			const html = notice({ replan: { state } });
			expect(html).toContain('data-state="' + state + '"');
			expect(html).not.toContain('data-testid="replan-link"');
			expect(html).not.toContain('data-testid="replan-retry"');
		}
	});

	it('links the no-program line to Today', () => {
		const html = notice({ replan: { state: 'no_program' } });
		expect(html).toContain('href="/today"');
		expect(html).toContain('Build your program from ');
	});

	it('offers Try again for a failure, busy while it runs', () => {
		const idle = notice({ replan: { state: 'failed' } });
		expect(idle).toContain('Couldn’t prepare a re-plan for these priorities');
		expect(idle).toContain('data-testid="replan-retry"');
		expect(idle).toContain('Try again');
		expect(idle).not.toContain('Retry');
		expect(idle).not.toContain('aria-busy');

		const busy = notice({ replan: { state: 'failed' }, checking: true });
		expect(busy).toContain('aria-busy="true"');
	});
});
