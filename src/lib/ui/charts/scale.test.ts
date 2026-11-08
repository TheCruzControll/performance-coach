import { describe, expect, it } from 'vitest';
import {
	formatTick,
	linearScale,
	MAX_TICKS,
	monthBand,
	nearestIndex,
	niceTicks,
	timeTicks,
	weekBand
} from './scale.ts';

/** Is `step` 1, 2 or 5 times a power of ten? */
const isNice = (step: number) => {
	const mantissa = step / 10 ** Math.floor(Math.log10(step) + 1e-9);
	return [1, 2, 5].some((m) => Math.abs(mantissa - m) < 1e-9);
};

describe('niceTicks', () => {
	it('puts 0–131 kg on 0, 50, 100, 150', () => {
		expect(niceTicks(0, 131)).toEqual({ ticks: [0, 50, 100, 150], step: 50 });
	});

	it('puts 0.8–1.6 on steps of 0.2, with no float drift', () => {
		expect(niceTicks(0.8, 1.6)).toEqual({ ticks: [0.8, 1, 1.2, 1.4, 1.6], step: 0.2 });
		// 0.3 / 0.1 is 2.9999…: snapped down blindly, 0.3 would start a sixth tick at 0.2.
		expect(niceTicks(0.3, 0.7)).toEqual({ ticks: [0.3, 0.4, 0.5, 0.6, 0.7], step: 0.1 });
	});

	it('gives a span across zero a tick at zero', () => {
		expect(niceTicks(-3, 7)).toEqual({ ticks: [-5, 0, 5, 10], step: 5 });
		expect(niceTicks(-0.35, 0.12).ticks).toEqual([-0.4, -0.2, 0, 0.2]);
		expect(Object.is(niceTicks(-0.35, 0.12).ticks[2], 0)).toBe(true); // never −0
	});

	it('widens a flat range around its value, and reads a reversed one', () => {
		expect(niceTicks(100, 100).ticks).toEqual([90, 95, 100, 105, 110]);
		expect(niceTicks(0, 0).ticks).toEqual([-1, -0.5, 0, 0.5, 1]);
		expect(niceTicks(131, 0)).toEqual(niceTicks(0, 131));
	});

	it.each([
		[0, 1],
		[0, 9.5],
		[3, 17],
		[0, 22],
		[-120, -40],
		[1234, 98765],
		[0.013, 0.071],
		[61.2, 64.9]
	])('covers %d–%d with at most five ticks on a 1-2-5 step', (min, max) => {
		const { ticks, step } = niceTicks(min, max);
		expect(ticks.length).toBeLessThanOrEqual(MAX_TICKS);
		expect(ticks.length).toBeGreaterThanOrEqual(2);
		expect(ticks[0]).toBeLessThanOrEqual(min);
		expect(ticks.at(-1)).toBeGreaterThanOrEqual(max);
		expect(isNice(step)).toBe(true);
		ticks.slice(1).forEach((t, i) => expect(t - ticks[i]!).toBeCloseTo(step, 9));
	});

	it('refuses a value that is not a number', () => {
		expect(() => niceTicks(0, Number.NaN)).toThrow(RangeError);
	});
});

describe('linearScale', () => {
	it('starts bars at zero, whatever the data', () => {
		const bars = linearScale([12, 18, null, 22], 'bar');
		expect(bars.ticks).toEqual([0, 10, 20, 30]);
		expect(bars.at(0)).toBe(0);
		expect(bars.at(15)).toBe(50);
		expect(linearScale([-4, -9], 'bar').max).toBe(0);
		expect(linearScale([0, 0], 'bar').ticks).toEqual([0, 0.5, 1]);
	});

	it('gives a line a nice domain around its data, not down to zero', () => {
		const line = linearScale([131.5, 128, null, 140.25], 'line');
		expect(line.min).toBe(125);
		expect(line.max).toBe(145);
		expect(line.at(135)).toBe(50);
	});

	it('keeps every value inside 0–100 %', () => {
		const line = linearScale([10, 20], 'line');
		expect(line.at(-1_000)).toBe(0);
		expect(line.at(1_000)).toBe(100);
		expect(linearScale([], 'line').ticks).toEqual([0, 0.5, 1]);
	});
});

describe('bands', () => {
	it('labels weeks by their Monday, centred in equal slots', () => {
		const weeks = weekBand(['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
		expect(weeks.labels).toEqual(['5 Oct', '12 Oct', '19 Oct', '26 Oct']);
		expect(weeks.width).toBe(25);
		expect([0, 1, 2, 3].map(weeks.center)).toEqual([12.5, 37.5, 62.5, 87.5]);
	});

	it('labels months, with the year on the first and on each January', () => {
		expect(monthBand(['2026-11', '2026-12-01', '2027-01', '2027-02']).labels).toEqual([
			'Nov 2026',
			'Dec',
			'Jan 2027',
			'Feb'
		]);
		expect(() => monthBand(['2026-13'])).toThrow(RangeError);
	});

	it('picks at most five tick slots, counted back from the newest', () => {
		expect(timeTicks(6)).toEqual([1, 3, 5]);
		expect(timeTicks(12)).toEqual([2, 5, 8, 11]);
		expect(timeTicks(5)).toEqual([0, 1, 2, 3, 4]);
		expect(timeTicks(104).length).toBeLessThanOrEqual(MAX_TICKS);
		expect(timeTicks(104).at(-1)).toBe(103);
		expect(timeTicks(0)).toEqual([]);
	});
});

describe('formatTick', () => {
	it('writes the step’s precision, grouped, with a true minus', () => {
		expect(formatTick(1, 0.2)).toBe('1.0');
		expect(formatTick(1.2000000001, 0.2)).toBe('1.2');
		expect(formatTick(1500, 500)).toBe('1,500');
		expect(formatTick(-5, 5)).toBe('−5');
		expect(formatTick(-0.0000001, 0.05)).toBe('0.00');
	});
});

describe('nearestIndex', () => {
	it('finds the nearest slot, the later one on a tie', () => {
		const centres = [12.5, 37.5, 62.5, 87.5];
		expect(nearestIndex(centres, 0)).toBe(0);
		expect(nearestIndex(centres, 40)).toBe(1);
		expect(nearestIndex(centres, 25)).toBe(1); // halfway between 0 and 1: the newer week
		expect(nearestIndex(centres, 75)).toBe(3);
		expect(nearestIndex(centres, 100)).toBe(3);
		expect(nearestIndex([], 50)).toBe(-1);
	});
});
