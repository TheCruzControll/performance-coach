import { describe, expect, it } from 'vitest';
import { RUN_STATUSES, type RunStatus } from '#lib/domain/coach/index.ts';
import {
	costWords,
	latencyWords,
	pricingCaption,
	ratioWords,
	statusCounts,
	stopWords,
	tokenWords,
	UNPRICED_CAPTION
} from './usage';

const statuses = (counts: Partial<Record<RunStatus, number>>) =>
	({
		...Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])),
		...counts
	}) as Record<RunStatus, number>;

describe('the usage view’s words', () => {
	it('states the rates every estimate uses, from the domain’s pricing', () => {
		expect(pricingCaption()).toBe(
			'Estimates at $4 / $20 per million tokens in and out, $0.20 for cache reads and $5 for cache writes.'
		);
	});

	it('shows a cost, $0.00 for a run that made no model call, and Not priced without a price', () => {
		expect(costWords(4_000)).toBe('<$0.01');
		expect(costWords(1_234_567)).toBe('$1.23');
		expect(costWords(0)).toBe('$0.00');
		expect(costWords(null)).toBe('Not priced');
		expect(UNPRICED_CAPTION).toMatch(/daily cap counts it at the highest known rate/);
	});

	it('says why a run stopped, with a refusal’s category, and a lookup made no model call', () => {
		const run = { provider: 'anthropic', stopReason: 'end_turn', refusalCategory: null };
		expect(stopWords(run)).toBe('Finished');
		expect(stopWords({ ...run, stopReason: 'tool_use' })).toBe('Called tools');
		expect(stopWords({ ...run, stopReason: 'refusal', refusalCategory: 'cyber' })).toBe(
			'Declined · cyber'
		);
		expect(stopWords({ ...run, stopReason: 'something_new' })).toBe('something_new');
		expect(stopWords({ provider: 'direct', stopReason: null, refusalCategory: null })).toBe(
			'No model call'
		);
		expect(stopWords({ ...run, stopReason: null })).toBe('—');
	});

	it('writes tokens, latency and the cache share as a person reads them', () => {
		expect(tokenWords(0)).toBe('0');
		expect(tokenWords(12_400)).toBe('12,400');
		expect(tokenWords(1_000_000)).toBe('1M');
		expect(tokenWords(1_250_000)).toBe('1.3M');
		expect(latencyWords(null)).toBe('—');
		expect(latencyWords(840)).toBe('840 ms');
		expect(latencyWords(2_400)).toBe('2.4 s');
		expect(ratioWords(null)).toBe('—');
		expect(ratioWords(0.75)).toBe('75%');
	});

	it('lists how runs ended, most first, without the statuses no run ended in', () => {
		expect(statusCounts(statuses({}))).toEqual([]);
		expect(statusCounts(statuses({ cancelled: 1, completed: 3, refused: 2 }))).toEqual([
			{ status: 'completed', label: 'Completed', runs: 3 },
			{ status: 'refused', label: 'Declined', runs: 2 },
			{ status: 'cancelled', label: 'Stopped', runs: 1 }
		]);
	});
});
