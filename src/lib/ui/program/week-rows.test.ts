import { describe, expect, it } from 'vitest';
import type { TimelineWeek } from './timeline';
import { OUTLINE_RUN, weekRows } from './week-rows';

describe('weekRows', () => {
	const weeks = (count: number, eventAt?: number): TimelineWeek[] =>
		Array.from({ length: count }, (_, i) => ({
			number: 9 + i,
			dates: `${['Mon 4 Jan', 'Mon 11 Jan'][i % 2]} – Sun ${10 + i} Jan`,
			planned: false,
			current: false,
			events: i === eventAt ? [{ title: 'Marathon', date: 'Sun 25 Apr' }] : []
		}));

	it('counts a long run of outline weeks in one row, keeping an event’s week on its own', () => {
		const rows = weekRows(weeks(OUTLINE_RUN + 3, OUTLINE_RUN + 2), {
			outline: true,
			collapse: true
		});
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({
			week: {
				number: 9,
				dates: `Mon 4 Jan – Sun ${10 + OUTLINE_RUN + 1} Jan`,
				planned: false,
				current: false,
				events: [],
				last: 8 + OUTLINE_RUN + 2,
				count: `${OUTLINE_RUN + 2} weeks`
			},
			tick: ''
		});
		expect(rows[1]!.week).toMatchObject({ number: 9 + OUTLINE_RUN + 2 });
		expect(rows[1]!.week.last).toBeUndefined();
	});

	it('keeps this week on its own row, never folded into a counted run', () => {
		const list = weeks(8).map((w, i) => (i === 2 ? { ...w, current: true } : w));
		const rows = weekRows(list, { outline: true, collapse: true });
		expect(rows.map((r) => [r.week.number, r.week.last])).toEqual([
			[9, undefined],
			[10, undefined],
			[11, undefined],
			[12, 16]
		]);
		expect(rows[2]!.week.current).toBe(true);
	});

	it('lists a short outline, a planned block, or any block without a road week by week', () => {
		const short = weekRows(weeks(OUTLINE_RUN - 1), { outline: true, collapse: true });
		expect(short.map((r) => r.week.number)).toEqual([9, 10, 11]);
		expect(weekRows(weeks(8), { outline: false, collapse: true })).toHaveLength(8);
		expect(weekRows(weeks(8), { outline: true, collapse: false })).toHaveLength(8);
	});

	it('gives each row its weeks’ tick words, a counted run all of them', () => {
		const rows = weekRows(weeks(OUTLINE_RUN + 1), {
			outline: true,
			collapse: true,
			ticks: { 0: 'Recovery', 2: 'Taper', [OUTLINE_RUN + 3]: 'Deload' }
		});
		expect(rows.map((r) => r.tick)).toEqual(['Recovery · Taper']);
		const planned = weekRows(weeks(3), { outline: false, collapse: true, ticks: { 1: 'Deload' } });
		expect(planned.map((r) => r.tick)).toEqual(['', 'Deload', '']);
	});
});
