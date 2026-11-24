import { describe, expect, it } from 'vitest';
import type { Component } from 'svelte';
import { PANELS, preloadPanel, servedPanel, settledPanel } from './index.ts';
import Program from './Program.svelte';
import Setup from './Setup.svelte';

const Panel = (() => {}) as unknown as Component;

describe('servedPanel', () => {
	it('renders the panel as static markup', async () => {
		const setup = { complete: false, done: 2, total: 10, next: 'experience' };
		const html = await servedPanel(Setup as Component, { setup });
		expect(html).toContain('data-testid="today-setup-count"');
		expect(html).toContain('2 of 10 steps done');
	});
});

describe('Program', () => {
	const TODAY = '2026-11-05';
	const served = (plan: unknown) => servedPanel(Program as Component, { plan });
	const LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
	const dots = LETTERS.map((letter, i) => ({
		date: `2026-11-0${i + 2}`,
		letter,
		name: `Day ${i + 2}`,
		mark: `2026-11-0${i + 2}` === TODAY ? 'today' : 'rest'
	}));
	const day = (over: Record<string, unknown> = {}) => ({
		state: 'session',
		date: TODAY,
		title: 'Full body',
		when: 'This morning · strength · about 60 min',
		coach: 'Baseline week. Finish every set with two reps still in you.',
		lead: null,
		review: null,
		lines: [],
		rows: [],
		log: null,
		...over
	});
	const ready = (over: Record<string, unknown> = {}) => ({
		failed: false,
		today: TODAY,
		dots,
		day: day(),
		others: [],
		coming: [],
		...over
	});
	const start = (lineage: string) => ({
		id: 'start-workout',
		label: 'Start workout',
		href: `/workout?start=${lineage}`,
		icon: 'play'
	});
	const later = {
		kind: 'later',
		label: 'Tomorrow',
		title: 'Intervals',
		end: '45 min',
		tick: false,
		quiet: false,
		href: '/train/session/b0',
		chevron: false
	};
	const count = (html: string, text: string) => html.split(text).length - 1;

	it('renders a session day in the markup: the dots, the day, one Start and the one line', async () => {
		const html = await served(
			ready({ day: day({ lead: { lineage: 'a0', link: start('a0') }, lines: [later] }) })
		);
		expect(html).toContain('data-testid="week-dots"');
		expect(count(html, 'class="dot-day')).toBe(7);
		expect(html).toMatch(/data-date="2026-11-05"[^>]*aria-current="date"/);
		expect(html).toMatch(/data-testid="today-title">Full body<\/h2>/);
		expect(html).toContain('data-testid="today-when">This morning · strength · about 60 min');
		expect(html).toContain('data-testid="today-coach">Baseline week.');
		// One Start, labelled Start: the session screen keeps 'Start workout'.
		expect(count(html, 'data-testid="start-workout"')).toBe(1);
		expect(html).toMatch(
			/href="\/workout\?start=a0"[^>]*data-testid="start-workout"[\s\S]*?<span class="label[^"]*">[\s\S]*?Start[\s\S]*?<\/span>/
		);
		expect(html).not.toContain('Start workout');
		expect(html).toMatch(
			/<a class="line[^"]*" href="\/train\/session\/b0"[^>]*aria-label="Tomorrow, Intervals, 45 min"[^>]*data-testid="today-line"/
		);
		expect(html).not.toContain('data-testid="log-something-else"');
		expect(html).not.toContain('aria-busy="true"');
	});

	it('a day of two with the first done: one Start, and the done one as a quiet line with a tick', async () => {
		const html = await served(
			ready({
				day: day({
					title: 'Muay Thai class',
					lead: { lineage: 'b0', link: start('b0') },
					lines: [
						{
							kind: 'done',
							label: 'Morning',
							title: 'Full body',
							end: null,
							tick: true,
							quiet: true,
							href: '/progress/workouts/w1',
							chevron: false
						}
					]
				})
			})
		);
		expect(count(html, 'data-testid="start-workout"')).toBe(1);
		expect(html).toMatch(/<li data-testid="today-done"[^>]*>(<!--[^>]*-->)*<a class="line/);
		expect(html).toMatch(
			/href="\/progress\/workouts\/w1"[^>]*data-quiet="true"[^>]*aria-label="Morning, Full body, done"[^>]*data-testid="done-workout"/
		);
		expect(html).toContain('tick');
	});

	it('a rest day offers no Start and logs something anyway', async () => {
		const html = await served(
			ready({
				day: day({
					state: 'rest',
					title: 'Rest day',
					when: 'Nothing planned. Recovery is part of the plan.',
					coach: null,
					lines: [later],
					log: 'anyway'
				})
			})
		);
		expect(html).toContain('data-state="rest"');
		expect(html).not.toContain('data-testid="start-workout"');
		expect(html).toMatch(
			/href="\/workout"[^>]*data-testid="log-something-else">\s*Log something anyway/
		);
	});

	it('a bridge week and nothing yet: no dots, the day, and the way to log or look back', async () => {
		const bridge = await served(
			ready({
				dots: null,
				day: day({ state: 'bridge', title: 'Free week', coach: null, log: 'plain' })
			})
		);
		expect(bridge).toMatch(/data-testid="today-title">Free week</);
		expect(bridge).toMatch(/data-testid="log-something-else">\s*Log something\s*</);
		expect(bridge).not.toContain('data-testid="week-dots"');

		const complete = await served(
			ready({
				dots: null,
				day: day({
					state: 'complete',
					title: 'Nothing yet',
					coach: null,
					rows: [
						{
							title: 'Look back at every week',
							href: '/train',
							secondary: false,
							testId: 'today-train-link'
						},
						{
							title: 'Log something',
							href: '/workout',
							secondary: false,
							testId: 'log-something-else'
						}
					]
				})
			})
		);
		expect(complete).toMatch(/data-testid="today-title">Nothing yet</);
		expect(complete).toMatch(/href="\/train" data-testid="today-train-link"/);
		expect(complete).toMatch(/href="\/workout" data-testid="log-something-else"/);
	});

	it('a block to review is the day, its button the review’s create form, with no prompt', async () => {
		const html = await served(
			ready({
				day: day({
					state: 'block-end',
					title: 'Done',
					when: 'Four weeks of Base',
					coach: 'Let’s look at what it built, then I’ll set up Accumulation with you.',
					review: {
						kind: 'cycle',
						state: 'due',
						title: 'Block complete — review it and plan the next',
						summary: 'Base · Mon 5 Oct – Sun 1 Nov: what it built.',
						href: null,
						create: {
							action: '/progress/reviews?/createCycle',
							fields: { programId: 'p1', blockLineage: 'b1' }
						},
						notReady: 'Not yet.'
					},
					lines: [{ ...later, label: 'Today' }]
				})
			})
		);
		expect(html).toContain('data-state="block-end"');
		expect(html).toMatch(/data-testid="today-title">Done<\/h2>/);
		expect(html).toContain('data-testid="today-when">Four weeks of Base');
		expect(html).toMatch(
			/<form class="go[^"]*" method="POST" action="\/progress\/reviews\?\/createCycle"/
		);
		expect(html).toMatch(/<input type="hidden" name="blockLineage" value="b1"/);
		expect(html).toMatch(/type="submit"[^>]*data-testid="review-block"[\s\S]*?Review the block/);
		expect(html).not.toContain('data-testid="start-workout"');
		expect(html).not.toContain('data-testid="review-prompt"');
		// Today's session waits under it, as its line.
		expect(html).toMatch(/aria-label="Today, Intervals, 45 min"[^>]*data-testid="today-line"/);
	});

	it('a week to review is the one line under the day, to Progress → Reviews', async () => {
		const html = await served(
			ready({
				day: day({
					lead: { lineage: 'a0', link: start('a0') },
					lines: [
						{
							kind: 'review',
							label: 'Last week',
							title: 'Review ready',
							end: null,
							tick: false,
							quiet: false,
							href: '/progress/reviews',
							chevron: true
						}
					]
				})
			})
		);
		expect(count(html, 'data-testid="start-workout"')).toBe(1);
		expect(html).toMatch(
			/<a class="line[^"]*" href="\/progress\/reviews" data-kind="review"[^>]*aria-label="Last week, Review ready"[^>]*data-testid="today-line"/
		);
		expect(html).toContain('chevron');
		expect(html).not.toContain('data-testid="review-prompt"');
		// The line stands under the day, not over it.
		expect(html.indexOf('data-kind="review"')).toBeGreaterThan(
			html.indexOf('data-testid="today-day"')
		);
	});

	it('a failed read is one statement with Try again', async () => {
		const failed = await served({ failed: true });
		expect(failed).toContain('Couldn’t load today');
		expect(failed).toContain('data-testid="today-retry"');
		expect(failed).toContain('data-testid="today-plan-error"');
		expect(failed).not.toContain('data-testid="today-day"');
	});
});

describe('PANELS', () => {
	it('keeps the preview out of the server, so its CSS stays off every Today page', async () => {
		await expect(PANELS.preview()).rejects.toThrow('client only');
	});
});

describe('preloadPanel', () => {
	it('records the imported component for PanelLoader to render as the server sent it', async () => {
		const load = async () => ({ default: Panel });
		expect(settledPanel(load)).toBeUndefined();
		await preloadPanel(load);
		expect(settledPanel(load)).toBe(Panel);
	});

	it('records a failed import instead of rejecting, and the next call imports again', async () => {
		const gone = new TypeError('Failed to fetch dynamically imported module');
		let attempts = 0;
		const load = async () => {
			attempts++;
			if (attempts === 1) throw gone;
			return { default: Panel };
		};
		await expect(preloadPanel(load)).resolves.toBeUndefined();
		expect(settledPanel(load)).toBe(gone);
		await preloadPanel(load);
		expect(attempts).toBe(2);
		expect(settledPanel(load)).toBe(Panel);
	});

	it('records a non-Error rejection as an Error, so PanelLoader still offers Retry', async () => {
		const load = () => Promise.reject('offline');
		await preloadPanel(load);
		expect(settledPanel(load)).toEqual(new Error('offline'));
	});
});
