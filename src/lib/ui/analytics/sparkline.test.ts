import { describe, expect, it } from 'vitest';
import type { SeriesPoint } from '#lib/domain/analytics/types.ts';
import { SPARK_INSET, sparkline } from './sparkline.ts';

const week = (index: number) => `2026-0${1 + Math.floor(index / 4)}-${10 + (index % 4) * 7}`;
const series = (values: readonly (number | null)[], inProgress = false): SeriesPoint[] =>
	values.map((value, index) => ({
		at: week(index),
		value,
		inProgress: inProgress && index === values.length - 1
	}));
/** The polyline's points as numbers. */
const xy = (points: string) =>
	points.split(' ').map((pair) => pair.split(',').map(Number) as [number, number]);

describe('sparkline', () => {
	it('spans the box: the oldest point at x 0, the newest at x 100, high values near the top', () => {
		const line = sparkline(series([10, 20, 15]))!;
		expect(xy(line.points)).toEqual([
			[0, 100 - SPARK_INSET],
			[50, SPARK_INSET],
			[100, 50]
		]);
		expect(line.end).toEqual({ x: 100, y: 50 });
	});

	it('draws a flat series level through the middle, never dividing by a zero range', () => {
		const line = sparkline(series([80, 80, 80, 80]))!;
		expect(xy(line.points).map(([, y]) => y)).toEqual([50, 50, 50, 50]);
		expect(line.points).not.toMatch(/NaN|Infinity/);
	});

	it('draws a single point as its end dot in the middle, with no segment to stroke', () => {
		const line = sparkline(series([142.5]))!;
		expect(line.points).toBe('100,50');
		expect(line.end).toEqual({ x: 100, y: 50 });
	});

	it('keeps a gap’s place: the points around it stay at their own weeks, the gap is not zero', () => {
		const line = sparkline(series([10, null, null, 30, 20]))!;
		const points = xy(line.points);
		expect(points.map(([x]) => x)).toEqual([0, 75, 100]);
		// The missing weeks are not drawn as zeros: the lowest drawn value is the series' minimum.
		expect(points.map(([, y]) => y)).toEqual([100 - SPARK_INSET, SPARK_INSET, 50]);
	});

	it('is null with nothing to draw: no points, or only gaps', () => {
		expect(sparkline([])).toBeNull();
		expect(sparkline(series([null, null]))).toBeNull();
	});

	it('leaves the week in progress out: it is shown apart, as the so-far line', () => {
		const line = sparkline(series([10, 20, 999], true))!;
		expect(xy(line.points)).toEqual([
			[0, 100 - SPARK_INSET],
			[100, SPARK_INSET]
		]);
	});

	it('rounds to two decimals so the server sends a short attribute', () => {
		const line = sparkline(series([1, 2, 3, 4, 5, 6, 7]))!;
		expect(line.points).toBe('0,90 16.67,76.67 33.33,63.33 50,50 66.67,36.67 83.33,23.33 100,10');
		for (const [x, y] of xy(line.points)) {
			expect(String(x)).toMatch(/^\d+(\.\d{1,2})?$/);
			expect(String(y)).toMatch(/^\d+(\.\d{1,2})?$/);
		}
	});
});
