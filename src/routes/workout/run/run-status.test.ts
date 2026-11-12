import { describe, expect, it } from 'vitest';
import type { SegmentItem } from './run-log.ts';
import { runStatus } from './run-status.ts';

const segment = (position: number, kind: SegmentItem['kind'], logged = false): SegmentItem => ({
	position,
	kind,
	repeat: null,
	repeats: null,
	target: null,
	// Only whether one was logged counts here.
	logged: logged ? ({ position } as unknown as SegmentItem['logged']) : null
});

const ITEMS = [segment(1, 'warm_up', true), segment(2, 'tempo', true), segment(3, 'cool_down')];

describe('the run’s Status Display', () => {
	it('puts the run’s pace in the big numeral, in the owner’s unit, with what it is over', () => {
		const status = runStatus({
			items: ITEMS,
			item: ITEMS[2]!,
			planned: true,
			totals: { distanceMetres: 5200, durationSeconds: 1690, paceSecondsPerKm: 325 },
			unit: 'km'
		});
		expect(status).toEqual({
			label: 'Run status',
			line: 'Segment 3 of 3 · Cool-down',
			big: '5:25',
			unit: '/km',
			dim: 'Run pace over 5.2 km in 28:10',
			bar: { label: 'Segments logged', start: 'Segments', end: '2 of 3 done', progress: 2 / 3 }
		});
		const miles = runStatus({
			items: ITEMS,
			item: ITEMS[2]!,
			planned: true,
			totals: { distanceMetres: 5200, durationSeconds: 1690, paceSecondsPerKm: 325 },
			unit: 'mi'
		});
		expect(miles.big).toBe('8:43');
		expect(miles.unit).toBe('/mi');
	});

	it('shows a quiet dash, never an invented pace, before a segment gives one', () => {
		const status = runStatus({
			items: [segment(1, 'easy')],
			item: segment(1, 'easy'),
			planned: true,
			totals: null,
			unit: 'km'
		});
		expect(status.big).toBe('—');
		expect(status.unit).toBeUndefined();
		expect(status.dim).toBe('Your pace shows once a segment is logged');
		expect(status.bar?.end).toBe('0 of 1 done');
		expect(status.bar?.progress).toBe(0);
	});

	it('names a segment of the owner’s own, and has no bar with nothing planned or logged', () => {
		const free = segment(1, 'easy');
		const status = runStatus({ items: [], item: free, planned: false, totals: null, unit: 'km' });
		expect(status.line).toBe('A segment of your own · Easy');
		expect(status.bar).toBeNull();
	});
});
