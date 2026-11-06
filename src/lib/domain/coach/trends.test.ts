import { describe, expect, it } from 'vitest';
import { METHOD_MAX } from './answer';
import {
	FLAT_WITHIN_PCT,
	SERIES_CHANGE_METHOD,
	seriesChange,
	CHANGE_MIN_POINTS,
	type SeriesChange
} from './trends';
import type { SeriesPoint } from '../analytics/types';

/** Complete weekly points from `values`, Mondays from 5 October 2026. */
const weekly = (values: (number | null)[]): SeriesPoint[] =>
	values.map((value, n) => ({
		at: new Date(Date.UTC(2026, 9, 5 + 7 * n)).toISOString().slice(0, 10),
		value,
		inProgress: false
	}));

/** The change, failing the test unless there was enough data for one. */
function changeOf(points: readonly SeriesPoint[]): Extract<SeriesChange, { enoughData: true }> {
	const change = seriesChange(points);
	if (!change.enoughData) throw new Error(`not enough data: ${JSON.stringify(change)}`);
	return change;
}

describe('seriesChange', () => {
	it('compares the mean of the later half of the points with the earlier half', () => {
		// Earlier half 100, 110, 120 (mean 110); later half 130, 140, 150 (mean 140).
		expect(seriesChange(weekly([100, 110, 120, 130, 140, 150]))).toEqual({
			enoughData: true,
			points: 6,
			from: '2026-10-05',
			to: '2026-11-09',
			earlier: 110,
			later: 140,
			delta: 30,
			pct: 27.272727,
			direction: 'up'
		});
		expect(changeOf(weekly([20, 18, 12, 10]))).toMatchObject({
			earlier: 19,
			later: 11,
			delta: -8,
			pct: -42.105263,
			direction: 'down'
		});
	});

	it('leaves the middle point of an odd count out of both halves', () => {
		// 10, 10 | 1000 | 12, 12: the spike in the middle moves neither half.
		expect(changeOf(weekly([10, 10, 1000, 12, 12]))).toMatchObject({
			points: 5,
			earlier: 10,
			later: 12,
			delta: 2,
			pct: 20,
			direction: 'up'
		});
	});

	it(`calls a change within ${FLAT_WITHIN_PCT} % of the earlier half flat, and one at it a change`, () => {
		expect(changeOf(weekly([100, 100, 102.9, 102.9]))).toMatchObject({
			pct: 2.9,
			direction: 'flat'
		});
		expect(changeOf(weekly([100, 100, 97.1, 97.1]))).toMatchObject({
			pct: -2.9,
			direction: 'flat'
		});
		expect(changeOf(weekly([100, 100, 103, 103]))).toMatchObject({ pct: 3, direction: 'up' });
		expect(changeOf(weekly([100, 100, 97, 97]))).toMatchObject({ pct: -3, direction: 'down' });
		expect(changeOf(weekly([5, 5, 5, 5]))).toMatchObject({ delta: 0, pct: 0, direction: 'flat' });
	});

	it('gives no percentage for a change from nothing, only its direction', () => {
		expect(changeOf(weekly([0, 0, 8, 12]))).toMatchObject({
			earlier: 0,
			later: 10,
			delta: 10,
			pct: null,
			direction: 'up'
		});
		expect(changeOf(weekly([0, 0, 0, 0]))).toMatchObject({
			delta: 0,
			pct: null,
			direction: 'flat'
		});
	});

	it('counts zeros but leaves gaps and the week in progress out', () => {
		const points = [
			...weekly([4, null, 4, 0, 8, 8]),
			{ at: '2026-11-16', value: 900, inProgress: true }
		];
		// Counted: 4, 4, 0, 8, 8 → 4, 4 | 0 | 8, 8.
		expect(changeOf(points)).toMatchObject({
			points: 5,
			from: '2026-10-05',
			to: '2026-11-09',
			earlier: 4,
			later: 8,
			direction: 'up'
		});
	});

	it('orders the points by date before splitting them', () => {
		const points = weekly([100, 110, 120, 130]);
		expect(seriesChange([...points].reverse())).toEqual(seriesChange(points));
	});

	it(`needs ${CHANGE_MIN_POINTS} counted points, and says how many it has`, () => {
		expect(seriesChange([])).toEqual({ enoughData: false, points: 0, need: CHANGE_MIN_POINTS });
		expect(seriesChange(weekly([100, null, 110, 120]))).toEqual({
			enoughData: false,
			points: 3,
			need: CHANGE_MIN_POINTS
		});
		const inProgress = { at: '2026-11-02', value: 130, inProgress: true };
		expect(seriesChange([...weekly([100, 110, 120]), inProgress])).toMatchObject({
			enoughData: false,
			points: 3
		});
		expect(seriesChange(weekly([100, 110, 120, 130])).enoughData).toBe(true);
	});

	it('takes a smaller minimum, never below one point in each half', () => {
		expect(seriesChange(weekly([100, 120]), { minPoints: 2 })).toMatchObject({
			enoughData: true,
			earlier: 100,
			later: 120
		});
		expect(seriesChange(weekly([100]), { minPoints: 1 })).toEqual({
			enoughData: false,
			points: 1,
			need: 2
		});
	});

	it('refuses a value that is not a finite number', () => {
		expect(() => seriesChange(weekly([1, 2, Number.NaN, 4]))).toThrow(RangeError);
		expect(() => seriesChange(weekly([1, 2, Infinity, 4]))).toThrow(RangeError);
		// The middle point of an odd count, and a series too short for a change, are checked too.
		expect(() => seriesChange(weekly([1, 2, Number.NaN, 4, 5]))).toThrow(RangeError);
		expect(() => seriesChange(weekly([Number.NaN]))).toThrow(RangeError);
	});

	it('describes its method in words a metric block can carry', () => {
		expect(SERIES_CHANGE_METHOD.length).toBeLessThanOrEqual(METHOD_MAX);
		expect(SERIES_CHANGE_METHOD).not.toMatch(/[[\]]/);
		expect(SERIES_CHANGE_METHOD).toContain(`${FLAT_WITHIN_PCT}%`);
	});
});
