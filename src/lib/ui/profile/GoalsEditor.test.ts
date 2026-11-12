/**
 * Goals with no goal yet, as the server renders it: the empty state asks "What are you training
 * for?" under its own heading on Profile, and leaves that heading out on onboarding's goals
 * step, whose title already asks it, so the step never shows the question twice.
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { SectionContext } from './editors';
import GoalsEditor from './GoalsEditor.svelte';

const QUESTION = 'What are you training for?';
const context: SectionContext = {
	disciplines: [],
	units: { weight: 'kg', distance: 'km' }
};

const headings = (html: string) =>
	[...html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/g)].map(([, inner]) =>
		inner!.replace(/<!--[\s\S]*?-->/g, '').trim()
	);

const empty = (heading?: string) =>
	render(GoalsEditor, { props: { value: [], context, heading } }).body;

describe('the goals editor with no goal yet', () => {
	it('asks what you are training for under its own heading on Profile', () => {
		const html = empty();
		expect(html).toContain('data-testid="goals-empty"');
		expect(headings(html)).toEqual([QUESTION]);
		expect(html).toContain('Add a goal and the coach plans your training around it.');
	});

	it('leaves that heading out under a step title that already asks it', () => {
		const html = empty(QUESTION);
		expect(html).toContain('data-testid="goals-empty"');
		expect(headings(html)).toEqual([]);
		expect(html).not.toContain(QUESTION);
		// The guidance and the three ways in stay.
		expect(html).toContain('Add a goal and the coach plans your training around it.');
		for (const path of ['event', 'general', 'several']) {
			expect(html).toContain(`data-testid="goal-path-${path}"`);
		}
	});

	it('keeps its heading under a different title', () => {
		expect(headings(empty('Your goals'))).toEqual([QUESTION]);
	});
});
