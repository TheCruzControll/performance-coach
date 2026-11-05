import { describe, expect, it } from 'vitest';
import { brzycki, epley, estimateOneRepMax, loadForTarget, MAX_REPS_TO_FAILURE } from './e1rm';
import { percentOfOneRepMax, repsInReserve } from './rpe';

/** RPE 10, 9.5, ..., 6: the half steps of the chart, hardest first. */
const RPE_HALF_STEPS = Array.from({ length: 9 }, (_, i) => 10 - i / 2);

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

	it('falls back to formulas without RPE, never claiming high confidence', () => {
		const e = estimateOneRepMax({ weight: 100, reps: 5 });
		expect(e!.method).toBe('formula-mean');
		expect(e!.value).toBeCloseTo((epley(100, 5) + brzycki(100, 5)) / 2, 6);
		// Effort unknown: the set is assumed to be at failure, so the estimate is only a floor.
		expect(e!.confidence).toBe('medium');
		expect(estimateOneRepMax({ weight: 180, reps: 1 })).toMatchObject({
			value: 180,
			method: 'single',
			confidence: 'medium'
		});
		expect(estimateOneRepMax({ weight: 60, reps: 15 })!.confidence).toBe('low');
		expect(estimateOneRepMax({ weight: 100, reps: 5, rpe: null })!.method).toBe('formula-mean');
	});

	it('rises as RPE falls for the same weight and reps (never runs backwards)', () => {
		for (let reps = 1; reps <= MAX_REPS_TO_FAILURE; reps++) {
			let previous = -Infinity;
			for (const rpe of RPE_HALF_STEPS) {
				const e = estimateOneRepMax({ weight: 100, reps, rpe });
				if (e === null) {
					// Only once reps + reps in reserve leave the range every formula supports.
					expect(reps + (10 - rpe)).toBeGreaterThan(MAX_REPS_TO_FAILURE);
					continue;
				}
				expect(e.value, `${reps} reps @ RPE ${rpe}`).toBeGreaterThan(previous);
				previous = e.value;
			}
		}
	});

	it('never drops a recorded RPE: an easier set is never estimated lower than a harder one', () => {
		// The review's counterexample: RPE 5 and 7.25 used to fall back to "assume failure"
		// (107.9) and land below the RPE 8 estimate (115.9) with 'high' confidence.
		const rpe8 = estimateOneRepMax({ weight: 100, reps: 3, rpe: 8 })!;
		expect(rpe8).toMatchObject({ method: 'rpe-table', confidence: 'high' });
		expect(rpe8.value).toBeCloseTo(100 / 0.863, 6);
		expect(estimateOneRepMax({ weight: 100, reps: 3, rpe: 5 })).toBeNull();
		expect(estimateOneRepMax({ weight: 100, reps: 3, rpe: 7.25 })).toBeNull();
	});

	it('rejects RPE values that are not on the 6–10 half-step scale', () => {
		for (const rpe of [0, 1, 5.5, 6.25, 7.25, 8.1, 10.5, 11, -2, Number.NaN, Infinity]) {
			expect(estimateOneRepMax({ weight: 100, reps: 5, rpe }), `RPE ${rpe}`).toBeNull();
		}
	});

	it('extrapolates past 12 reps from reps to failure, with low confidence', () => {
		// 15 reps @ RPE 6 = 4 in reserve → treated as a 19-rep max, not a 15-rep max.
		const e = estimateOneRepMax({ weight: 100, reps: 15, rpe: 6 })!;
		expect(e).toMatchObject({ method: 'reps-to-failure', confidence: 'low' });
		expect(e.value).toBeCloseTo((epley(100, 19) + brzycki(100, 19)) / 2, 6);
		expect(e.value).toBeGreaterThan(estimateOneRepMax({ weight: 100, reps: 15 })!.value);
		// RPE 10 means no reps in reserve: the same as the assume-failure estimate, lower confidence.
		const failure = estimateOneRepMax({ weight: 100, reps: 15, rpe: 10 })!;
		expect(failure.value).toBeCloseTo(estimateOneRepMax({ weight: 100, reps: 15 })!.value, 6);
		expect(failure.confidence).toBe('low');
		// 18 reps with 3 in reserve is past every formula's useful range.
		expect(estimateOneRepMax({ weight: 100, reps: 18, rpe: 7 })).toBeNull();
	});

	it('scores confidence from reps to failure, including reps in reserve', () => {
		expect(estimateOneRepMax({ weight: 100, reps: 3, rpe: 9 })!.confidence).toBe('high');
		expect(estimateOneRepMax({ weight: 100, reps: 3, rpe: 6 })!.confidence).toBe('medium');
		expect(estimateOneRepMax({ weight: 100, reps: 8, rpe: 7 })!.confidence).toBe('low');
	});

	it('rejects unusable sets', () => {
		expect(estimateOneRepMax({ weight: 0, reps: 5 })).toBeNull();
		expect(estimateOneRepMax({ weight: -20, reps: 5, rpe: 8 })).toBeNull();
		expect(estimateOneRepMax({ weight: 100, reps: 25 })).toBeNull();
		expect(estimateOneRepMax({ weight: 100, reps: 0, rpe: 8 })).toBeNull();
		expect(estimateOneRepMax({ weight: 100, reps: 2.5 })).toBeNull();
	});

	it('prescribes loads for a target set', () => {
		expect(loadForTarget(200, 5, 8)).toBeCloseTo(162.2, 6);
		expect(loadForTarget(200, 15, 8)).toBeNull();
	});
});
