/**
 * A structured run as the server renders it (svelte/server): a repeat group says its count once
 * on screen ('4×'), never '4× Repeat 4 times', while a screen reader still hears it in words.
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { RunStep } from '#lib/domain/training/describe.ts';
import RunSegments from './RunSegments.svelte';

const segment = (headline: string) => ({ headline, pace: null, target: null });
const STEPS: RunStep[] = [
	{ repeats: 1, headline: 'Warm-up 2 km', segments: [segment('Warm-up 2 km')] },
	{
		repeats: 4,
		headline: '4 × (Interval 800 m + Recovery 1:30)',
		segments: [segment('Interval 800 m'), segment('Recovery 1:30')]
	},
	{ repeats: 1, headline: 'Cool-down 1.5 km', segments: [segment('Cool-down 1.5 km')] }
];

/** The text a sighted reader sees: no tags, nothing aria-hidden or visually hidden dropped yet. */
const strip = (html: string) =>
	html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

describe('RunSegments', () => {
	const { body } = render(RunSegments, { props: { label: 'The run', steps: STEPS } });
	const times = /<p class="times[^"]*">([\s\S]*?)<\/p>/.exec(body)![1]!;

	it('shows a repeat group’s count once', () => {
		const shown = times.replace(/<span class="visually-hidden[^"]*">[\s\S]*?<\/span>/g, '');
		expect(strip(shown)).toBe('4×');
	});

	it('names it in words for a screen reader, the count itself hidden from it', () => {
		expect(times).toMatch(/<span class="visually-hidden[^"]*">Repeat 4 times<\/span>/);
		expect(times).toMatch(/<span class="count numeric[^"]*" aria-hidden="true">4×<\/span>/);
	});
});
