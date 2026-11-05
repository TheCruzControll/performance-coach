import { describe, expect, it } from 'vitest';
import { brzycki, epley, estimateOneRepMax, loadForTarget } from './e1rm';
import { percentOfOneRepMax, repsInReserve } from './rpe';

describe('RPE table', () => {
	it('matches anchor values of the RTS chart', () => {
		expect(percentOfOneRepMax(1, 10)).toBe(1);
		expect(percentOfOneRepMax(5, 8)).toBe(0.811);
		expect(percentOfOneRepMax(3, 9)).toBe(0.892);
		expect(percentOfOneRepMax(12, 6)).toBe(0.572);
	});

	it('is consistent: +1 rep at the same RPE equals −1 RPE at the same reps', () => {
		for (let reps = 1; reps < 12; reps++) {
			for (const rpe of [7, 7.5, 8, 8.5, 9, 9.5, 10]) {
				expect(percentOfOneRepMax(reps + 1, rpe)).toBe(percentOfOneRepMax(reps, rpe - 1));
			}
		}
	});

	it('refuses to extrapolate outside the table', () => {
		expect(percentOfOneRepMax(13, 8)).toBeNull();
		expect(percentOfOneRepMax(5, 5.5)).toBeNull();
		expect(percentOfOneRepMax(5, 8.25)).toBeNull();
		expect(percentOfOneRepMax(0, 8)).toBeNull();
	});

	it('maps RPE to reps in reserve', () => {
		expect(repsInReserve(8)).toBe(2);
		expect(repsInReserve(9.5)).toBe(0.5);
		expect(() => repsInReserve(11)).toThrow(RangeError);
	});
});

describe('e1RM', () => {
	it('implements Epley and Brzycki', () => {
		expect(epley(100, 10)).toBeCloseTo(133.33, 2);
		expect(brzycki(100, 10)).toBeCloseTo(133.33, 2);
		expect(epley(100, 1)).toBe(100);
		expect(() => brzycki(100, 37)).toThrow(RangeError);
	});

	it('uses the RPE table when RPE is known and marks the result as estimated', () => {
		const e = estimateOneRepMax({ weight: 150, reps: 5, rpe: 8 });
		expect(e).not.toBeNull();
		expect(e!.kind).toBe('estimated');
		expect(e!.method).toBe('rpe-table');
		expect(e!.value).toBeCloseTo(150 / 0.811, 6);
		expect(e!.confidence).toBe('medium');
	});

	it('falls back to formulas without RPE', () => {
		const e = estimateOneRepMax({ weight: 100, reps: 5 });
		expect(e!.method).toBe('formula-mean');
		expect(e!.value).toBeCloseTo((epley(100, 5) + brzycki(100, 5)) / 2, 6);
		expect(estimateOneRepMax({ weight: 180, reps: 1 })).toMatchObject({
			value: 180,
			method: 'single',
			confidence: 'high'
		});
	});

	it('rejects unusable sets', () => {
		expect(estimateOneRepMax({ weight: 0, reps: 5 })).toBeNull();
		expect(estimateOneRepMax({ weight: 100, reps: 25 })).toBeNull();
		expect(estimateOneRepMax({ weight: 100, reps: 2.5 })).toBeNull();
	});

	it('prescribes loads for a target set', () => {
		expect(loadForTarget(200, 5, 8)).toBeCloseTo(162.2, 6);
		expect(loadForTarget(200, 15, 8)).toBeNull();
	});
});
