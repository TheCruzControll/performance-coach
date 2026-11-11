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
	const card = (title: string, lineage: string) => ({
		title,
		status: 'planned',
		line: 'Strength · 60 min · Moderate · Morning',
		statusWords: null,
		tone: 'strength',
		lineage,
		baseline: false
	});
	const served = (plan: unknown) => servedPanel(Program as Component, { plan });

	it('renders a settled plan in the markup: the strip, the day and Up next with when each is', async () => {
		const html = await served({
			failed: false,
			week: {
				label: 'Week 1',
				today: '2026-11-05',
				selected: '2026-11-05',
				strip: [],
				days: [
					{
						date: '2026-11-05',
						heading: 'Thursday 5 November',
						cards: [],
						rest: 'Recovery is part of the plan. Next: Intervals, tomorrow.'
					}
				]
			},
			starts: null,
			complete: null,
			upNext: [{ ...card('Intervals', 'b0'), when: 'Tomorrow' }]
		});
		expect(html).toContain('data-testid="week-strip"');
		// Today is named by the page's eyebrow date: its day says so to assistive tech only, and a
		// rest day promises no sessions.
		expect(html).toContain('class="visually-hidden">Today</h2>');
		expect(html).not.toContain('Thursday 5 November');
		expect(html).toContain('Next: Intervals, tomorrow.');
		expect(html).toContain('Tomorrow');
		expect(html).toContain('href="/train/session/b0"');
		expect(html).not.toContain('aria-busy="true"');
	});

	it('gives only the next session the primary Start; later ones a trailing text Start', async () => {
		const start = (lineage: string) => ({
			id: 'start-workout',
			label: 'Start workout',
			href: `/workout?start=${lineage}`,
			icon: 'play'
		});
		const done = {
			id: 'done-workout',
			label: 'Done · View',
			href: '/progress/workouts',
			icon: 'check'
		};
		const day = (date: string, heading: string) => ({
			failed: false,
			week: {
				label: 'Week 1',
				today: '2026-11-05',
				selected: date,
				strip: [],
				days: [
					{
						date,
						heading,
						cards: [
							{ ...card('Full body', 'a0'), status: 'completed', start: done },
							{ ...card('Intervals', 'b0'), start: start('b0') },
							{ ...card('Muay Thai class', 'c0'), start: start('c0') }
						],
						rest: null
					}
				]
			},
			starts: null,
			complete: null,
			upNext: []
		});
		const html = await served(day('2026-11-05', 'Thursday 5 November'));
		const links = [
			...html.matchAll(/<a href="([^"]+)" class="btn[^"]*" data-variant="(\w+)"[^>]*>/g)
		];
		expect(
			links.map(([tag, href, variant]) => [href, variant, /aria-label="([^"]*)"/.exec(tag)?.[1]])
		).toEqual([
			['/progress/workouts', 'secondary', undefined],
			['/workout?start=b0', 'primary', undefined],
			['/workout?start=c0', 'ghost', 'Start Muay Thai class'],
			['/workout', 'ghost', undefined]
		]);
		expect(html).toContain('class="visually-hidden">Today’s sessions</h2>');
		expect(html.match(/Start workout/g)).toHaveLength(1);
		expect(html).toMatch(
			/data-testid="start-workout"><!--\[-1-->.*?<span class="label[^"]*"><!---->Start<!---->/
		);
		// Another day of the week keeps its date, and offers no Start.
		const other = await served(day('2026-11-06', 'Friday 6 November'));
		expect(other).toMatch(/<h2 id="[^"]+" class="title[^"]*">Friday 6 November<\/h2>/);
		expect(other).not.toContain('/workout?start=');
	});

	it('shows the starts and block-complete states, and a failed read with Retry', async () => {
		const starts = await served({
			failed: false,
			week: null,
			starts: { title: 'Starts Monday', description: 'Week 1 begins Monday 9 November.' },
			complete: null,
			upNext: []
		});
		expect(starts).toContain('data-testid="today-starts"');
		expect(starts).toContain('Starts Monday');
		const complete = await served({
			failed: false,
			week: null,
			starts: null,
			complete: { title: 'Nothing planned yet', description: 'Your next block is planned.' },
			upNext: []
		});
		expect(complete).toContain('data-testid="today-block-complete"');
		expect(complete).toContain('data-testid="today-up-next-empty"');
		expect(complete).toContain('href="/train"');
		const failed = await served({ failed: true });
		expect(failed).toContain('Couldn’t load today’s plan');
		expect(failed).toContain('Retry');
		expect(failed).not.toContain('today-up-next');
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
