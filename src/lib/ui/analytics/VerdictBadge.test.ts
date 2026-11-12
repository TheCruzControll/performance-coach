/**
 * VerdictBadge as the server renders it: the verdict's phrase in its own box, so 'Real
 * improvement' stays on one line in a narrow tile while the window after it may wrap.
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import VerdictBadge from './VerdictBadge.svelte';

const phraseOf = (html: string) =>
	html.match(/<span class="phrase[^"]*">([^<]*)<\/span>([^<]*)<\/span>/)?.slice(1);

describe('VerdictBadge', () => {
	it('boxes the phrase apart from the window that follows it', () => {
		const { body } = render(VerdictBadge, {
			props: {
				verdict: { verdict: 'real_trend', direction: 'up', good: true },
				window: { sameAsPeriod: false, weeks: 12 }
			}
		});
		expect(phraseOf(body)).toEqual(['Real improvement', ' over the last 12 weeks']);
	});

	it('boxes the phrase alone when there is nothing after it, and its count apart', () => {
		const normal = render(VerdictBadge, { props: { verdict: { verdict: 'normal_variation' } } });
		expect(phraseOf(normal.body)).toEqual(['Normal variation', '']);
		const thin = render(VerdictBadge, {
			props: { verdict: { verdict: 'insufficient_data', have: 2, need: 6, unit: 'weeks' } }
		});
		expect(phraseOf(thin.body)).toEqual(['Not enough data yet', ' · 2 of 6 weeks']);
	});
});
