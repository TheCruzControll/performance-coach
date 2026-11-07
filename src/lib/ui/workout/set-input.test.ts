import { describe, expect, it } from 'vitest';
import type { LoggedSet } from '#lib/domain/workout/index.ts';
import { setFields } from '#lib/domain/workout/logging.ts';
import { missingInput, parseTime } from './set-input.ts';

const set = (change: Partial<LoggedSet>): LoggedSet => ({
	reps: 5,
	seconds: null,
	metres: null,
	weight: 100,
	assistance: null,
	unit: 'kg',
	rpe: null,
	missedReps: 0,
	isWarmup: false,
	isExtra: false,
	...change
});

describe('parseTime', () => {
	it('reads m:ss and plain seconds, and nothing else', () => {
		expect(parseTime('1:30')).toBe(90);
		expect(parseTime(' 45 ')).toBe(45);
		expect(parseTime('1:3')).toBe(63);
		expect(parseTime('abc')).toBeNull();
		expect(parseTime('1:300')).toBeNull();
	});
});

describe('missingInput', () => {
	it('asks a weighted set for a weight, never logging 0', () => {
		const fields = setFields('reps', 'external');
		expect(missingInput(fields, set({ weight: null }))).toBe('load');
		expect(missingInput(fields, set({ weight: 0 }))).toBe('load');
		expect(missingInput(fields, set({}))).toBeNull();
	});

	it('takes 0 reps (a failed attempt) and no added weight on a bodyweight set', () => {
		expect(
			missingInput(setFields('reps', 'bodyweight'), set({ reps: 0, weight: null }))
		).toBeNull();
	});

	it('asks a time or a distance for at least 1', () => {
		const time = setFields('time', 'none');
		expect(missingInput(time, set({ reps: null, weight: null, seconds: 0 }))).toBe('amount');
		expect(missingInput(time, set({ reps: null, weight: null, seconds: 1 }))).toBeNull();
		const distance = setFields('distance', 'none');
		expect(missingInput(distance, set({ reps: null, weight: null, metres: null }))).toBe('amount');
	});
});
