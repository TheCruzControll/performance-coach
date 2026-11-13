import { describe, expect, it } from 'vitest';
import type { ExerciseHistory, HistorySet } from '#lib/client/workout/exercise-history.ts';
import {
	bestWords,
	dayOf,
	historySetWords,
	offlineWords,
	repMaxWords,
	sheetTitle
} from './history-words.ts';

const SET: HistorySet = {
	id: 1,
	workoutId: '00000000-0000-4000-8000-0000000000a1',
	setIndex: 2,
	performedAt: '2026-11-04T23:30:00.000Z',
	reps: 5,
	seconds: null,
	metres: null,
	weight: 100,
	assistance: null,
	unit: 'kg',
	rpe: 8,
	missedReps: 0,
	isWarmup: false,
	isExtra: false,
	isSkipped: false
};

describe('dayOf', () => {
	it('names the day an instant fell on, in the given time zone', () => {
		expect(dayOf(SET.performedAt, 'UTC')).toBe('Wed 4 Nov');
		expect(dayOf(SET.performedAt, 'Europe/Madrid')).toBe('Thu 5 Nov');
	});
});

describe('historySetWords', () => {
	it('says what each set was, with skipped, extra and missed in words', () => {
		expect(historySetWords(SET, 1)).toEqual({
			label: 'Set 2',
			value: '100 kg × 5 reps · RPE 8',
			mark: null
		});
		expect(historySetWords({ ...SET, isWarmup: true, weight: 60, rpe: null }, 1)).toEqual({
			label: 'Warm-up',
			value: '60 kg × 5 reps',
			mark: null
		});
		expect(historySetWords({ ...SET, isSkipped: true }, 1)).toMatchObject({
			value: 'Not done',
			mark: 'Skipped'
		});
		expect(historySetWords({ ...SET, isExtra: true, missedReps: 2 }, 1).mark).toBe(
			'Extra set · 2 missed'
		);
	});

	it('counts a device session’s sets by their place, which carry no set index', () => {
		const { id: _id, workoutId: _w, setIndex: _s, performedAt: _p, isSkipped: _k, ...logged } = SET;
		expect(historySetWords(logged, 3).label).toBe('Set 3');
	});
});

describe('bestWords', () => {
	it('labels the best e1RM as an estimate, in the unit its set was logged in, with that set', () => {
		expect(bestWords({ kind: 'estimated', value: 116.67, set: SET }, 'UTC')).toEqual({
			// An estimate to the nearest 0.5 kg, as Progress shows it.
			value: 'Estimated 1RM · 116.5 kg',
			from: 'From 100 kg × 5 reps · Wed 4 Nov'
		});
		const lb = { ...SET, weight: 225, unit: 'lb' as const };
		expect(bestWords({ kind: 'estimated', value: 120, set: lb }, 'UTC').value).toBe(
			'Estimated 1RM · 265 lb'
		);
	});
});

describe('repMaxWords', () => {
	it('gives each rep PR its weight as logged and its day', () => {
		expect(repMaxWords({ reps: 5, weightKg: 100, set: SET }, 'UTC')).toEqual({
			label: '5 reps',
			value: '100 kg',
			date: 'Wed 4 Nov'
		});
		const lb = { ...SET, reps: 1, weight: 315, unit: 'lb' as const };
		expect(repMaxWords({ reps: 1, weightKg: 142.88, set: lb }, 'UTC')).toMatchObject({
			label: '1 rep',
			value: '315 lb'
		});
	});
});

const BENCH = '00000000-0000-4000-8000-0000000000b1';
const LOADED: ExerciseHistory = {
	exercise: { id: BENCH, name: 'Bench press' },
	previous: null,
	sets: [SET],
	next: null,
	records: { bestE1rm: null, repMaxes: [] }
};

describe('sheetTitle', () => {
	it('is the name the sheet was opened with', () => {
		expect(sheetTitle({ exerciseId: BENCH, name: 'Barbell bench' }, LOADED)).toBe('Barbell bench');
		expect(sheetTitle({ exerciseId: BENCH, name: 'Barbell bench' }, null)).toBe('Barbell bench');
	});

	it('opened by exercise id alone, is the loaded history’s name, and a plain title until then', () => {
		expect(sheetTitle({ exerciseId: BENCH }, LOADED)).toBe('Bench press');
		expect(sheetTitle({ exerciseId: BENCH }, null)).toBe('Exercise history');
		expect(sheetTitle(null, null)).toBe('Exercise history');
	});
});

describe('offlineWords', () => {
	it('opened by exercise id alone, says the history needs a connection', () => {
		expect(offlineWords({ exerciseId: BENCH }).title).toBe('Exercise history needs a connection');
		expect(offlineWords({ exerciseId: BENCH }).description).toMatch(/isn’t kept on this device/);
	});

	it('opened with a name and no session, keeps History’s and the workout’s offline words', () => {
		for (const request of [
			{ exerciseId: BENCH, name: 'Bench press' },
			{ exerciseId: BENCH, name: 'Bench press', fallback: null }
		]) {
			expect(offlineWords(request)).toEqual({
				title: 'You’re offline',
				description:
					'This device holds no earlier sets of this exercise. Its history loads when you’re back online.'
			});
		}
	});
});
