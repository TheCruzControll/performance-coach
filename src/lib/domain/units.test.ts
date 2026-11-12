import { describe, expect, it } from 'vitest';
import {
	cleanFloat,
	convertDistance,
	convertPace,
	convertWeight,
	ESTIMATE_INCREMENT,
	formatDuration,
	formatWeight,
	kgToLb,
	lbToKg,
	paceSecondsPer,
	parseDuration,
	roundEstimate,
	roundToIncrement
} from './units';

describe('weight conversion', () => {
	it('uses the exact international pound', () => {
		expect(lbToKg(1)).toBe(0.45359237);
		expect(kgToLb(0.45359237)).toBe(1);
	});

	it('converts common gym loads', () => {
		expect(cleanFloat(kgToLb(100), 2)).toBe(220.46);
		expect(cleanFloat(lbToKg(225), 2)).toBe(102.06);
		expect(convertWeight(140, 'kg', 'kg')).toBe(140);
	});

	it('round-trips without drift', () => {
		for (const kg of [0.5, 2.5, 20, 102.5, 317.5]) {
			expect(cleanFloat(convertWeight(convertWeight(kg, 'kg', 'lb'), 'lb', 'kg'))).toBe(kg);
		}
	});
});

describe('roundToIncrement', () => {
	it('rounds to plate-loadable increments', () => {
		expect(roundToIncrement(101.3, 2.5)).toBe(102.5);
		expect(roundToIncrement(101.2, 2.5)).toBe(100);
		expect(roundToIncrement(227, 5)).toBe(225);
	});

	it('supports directional rounding without float noise', () => {
		expect(roundToIncrement(102.49999999999999, 2.5, 'down')).toBe(102.5);
		expect(roundToIncrement(100.01, 2.5, 'up')).toBe(102.5);
		expect(roundToIncrement(100.01, 2.5, 'down')).toBe(100);
		expect(roundToIncrement(0.1 + 0.2, 0.1)).toBe(0.3);
	});

	it('rejects non-positive increments', () => {
		expect(() => roundToIncrement(10, 0)).toThrow(RangeError);
	});
});

describe('distance and pace', () => {
	it('converts distances exactly', () => {
		expect(convertDistance(1, 'mi', 'm')).toBe(1609.344);
		expect(cleanFloat(convertDistance(42.195, 'km', 'mi'), 3)).toBe(26.219);
		expect(convertDistance(5, 'km', 'km')).toBe(5);
	});

	it('computes pace per km and per mile', () => {
		// 5 km in 25:00 → 5:00 / km
		expect(paceSecondsPer(1500, 5000, 'km')).toBe(300);
		expect(paceSecondsPer(600, 0, 'km')).toBeNull();
		expect(cleanFloat(convertPace(300, 'km', 'mi'), 1)).toBe(482.8);
		expect(cleanFloat(convertPace(convertPace(300, 'km', 'mi'), 'mi', 'km'))).toBe(300);
	});
});

describe('durations', () => {
	it('formats m:ss and h:mm:ss', () => {
		expect(formatDuration(0)).toBe('0:00');
		expect(formatDuration(95)).toBe('1:35');
		expect(formatDuration(3600 + 5 * 60 + 9)).toBe('1:05:09');
		expect(formatDuration(-90)).toBe('-1:30');
		expect(formatDuration(59.6)).toBe('1:00');
	});

	it('parses durations and rejects malformed input', () => {
		expect(parseDuration('1:35')).toBe(95);
		expect(parseDuration('1:05:09')).toBe(3909);
		expect(parseDuration(' 12:00 ')).toBe(720);
		expect(parseDuration('1:75')).toBeNull();
		expect(parseDuration('1:61:00')).toBeNull();
		expect(parseDuration('abc')).toBeNull();
	});
});

describe('roundEstimate', () => {
	it('shows an estimated max to the nearest 0.5 kg or 1 lb, never to the hundredth', () => {
		expect(roundEstimate(157.21, 'kg')).toBe(157);
		expect(roundEstimate(157.3, 'kg')).toBe(157.5);
		expect(roundEstimate(101.6, 'kg')).toBe(101.5);
		expect(roundEstimate(98.75, 'kg')).toBe(99);
		expect(roundEstimate(123.33, 'lb')).toBe(123);
		expect(roundEstimate(264.55, 'lb')).toBe(265);
		expect(ESTIMATE_INCREMENT).toEqual({ kg: 0.5, lb: 1 });
	});
});

describe('formatWeight', () => {
	it('trims trailing zeros', () => {
		expect(formatWeight(100, 'kg')).toBe('100 kg');
		expect(formatWeight(102.5, 'kg')).toBe('102.5 kg');
		expect(formatWeight(220.462262, 'lb')).toBe('220.46 lb');
		expect(formatWeight(1250, 'kg')).toBe('1,250 kg');
	});

	it('groups thousands, keeps a minus and never shows -0', () => {
		expect(formatWeight(1234567.891, 'lb')).toBe('1,234,567.89 lb');
		expect(formatWeight(999.999, 'kg')).toBe('1,000 kg');
		expect(formatWeight(-1250.5, 'kg')).toBe('-1,250.5 kg');
		expect(formatWeight(-0.001, 'kg')).toBe('0 kg');
		expect(formatWeight(0, 'kg')).toBe('0 kg');
	});

	it('writes what toLocaleString would, without building a number formatter', () => {
		const values = [0, 0.004, 0.005, 1, 2.5, 7.25, 12.345, 99.95, 102.49999999999999, 999.5];
		const scaled = values.flatMap((v) => [v, v * 10, v * 1000, v * 123457, -v]);
		for (const decimals of [0, 1, 2, 3, 6]) {
			for (const value of scaled) {
				const rounded = cleanFloat(value, decimals) + 0;
				const expected = rounded.toLocaleString('en-US', { maximumFractionDigits: decimals });
				expect(formatWeight(value, 'kg', decimals)).toBe(`${expected} kg`);
			}
		}
	});
});
