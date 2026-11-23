import { describe, expect, it } from 'vitest';
import { dayWords, weighInKey, weighInLabel } from './recorded.ts';

const TODAY = '2026-11-11';

describe('the Undo card’s label', () => {
	it('names a weigh-in of today and of yesterday', () => {
		expect(weighInLabel({ value: 82.4, unit: 'kg', measuredOn: TODAY }, TODAY)).toBe(
			'Logged 82.4 kg for today'
		);
		expect(weighInLabel({ value: 180, unit: 'lb', measuredOn: '2026-11-10' }, TODAY)).toBe(
			'Logged 180 lb for yesterday'
		);
	});

	it('names an older day by its weekday and date, once it is no longer yesterday', () => {
		// 9 November 2026 was a Monday.
		expect(weighInLabel({ value: 82, unit: 'kg', measuredOn: '2026-11-09' }, TODAY)).toBe(
			'Logged 82 kg for Mon 9 Nov'
		);
	});

	it('adds the year to a day in another year', () => {
		// 31 December 2026 was a Thursday, read on 3 January 2027.
		expect(dayWords('2026-12-31', '2027-01-03')).toBe('Thu 31 Dec 2026');
		expect(dayWords('2027-01-02', '2027-01-03')).toBe('yesterday');
	});

	it('is keyed by the weigh-in’s id and the run that logged it', () => {
		const run = '00000000-0000-4000-8000-0000000000b1';
		const other = '00000000-0000-4000-8000-0000000000b2';
		expect(weighInKey(41, run)).toBe(`weigh-in:41:${run}`);
		expect(weighInKey(41, run)).not.toBe(weighInKey(14, run));
		expect(weighInKey(41, run)).not.toBe(weighInKey(41, other));
	});
});
