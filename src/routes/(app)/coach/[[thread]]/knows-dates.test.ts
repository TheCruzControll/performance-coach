/**
 * What the coach knows dates its records as the rest of the app does ('Tue 10 Nov'), never in
 * the browser's locale ('Nov 10, 2026'), and only names a year that is not the snapshot's.
 */
import { describe, expect, it } from 'vitest';
import { knowsDate } from './knows-dates.ts';

describe('knowsDate', () => {
	it('writes a day of the snapshot’s year as Train and Progress do', () => {
		expect(knowsDate('2026-11-10', '2026-11-11')).toBe('Tue 10 Nov');
		expect(knowsDate('2026-11-11', '2026-11-11')).toBe('Wed 11 Nov');
		expect(knowsDate('2026-03-01', '2026-11-11')).toBe('Sun 1 Mar');
	});

	it('adds the year only for a day in another year', () => {
		expect(knowsDate('2025-12-31', '2026-01-02')).toBe('Wed 31 Dec 2025');
	});

	it('reads the calendar day itself, whatever the clock’s time zone', () => {
		// 29 Feb in a leap year, and a day that a UTC-midnight instant would shift elsewhere.
		expect(knowsDate('2028-02-29', '2028-06-01')).toBe('Tue 29 Feb');
		expect(knowsDate('2026-01-01', '2026-01-01')).toBe('Thu 1 Jan');
	});
});
