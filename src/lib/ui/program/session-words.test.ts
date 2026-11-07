import { describe, expect, it } from 'vitest';
import { BASELINE_INSTRUCTION } from '#lib/domain/training/describe.ts';
import type { OtherDetails, RunSegment, SetPrescription } from '#lib/domain/training/types.ts';
import {
	adjustValues,
	BASELINE_CALLOUT,
	detailsView,
	disciplineWords,
	exerciseViews,
	metricValue,
	moveOption,
	whenWords,
	type ExerciseSource
} from './session-words';

const set = (over: Partial<SetPrescription> = {}): SetPrescription => ({
	role: 'working',
	sets: 3,
	repsMin: 5,
	repsMax: 5,
	seconds: null,
	metres: null,
	targetRpe: 7,
	loadKind: 'rpe_based',
	loadValue: null,
	loadUnit: null,
	loadBasis: null,
	reference1rm: null,
	reference1rmUnit: null,
	restSeconds: 120,
	tempo: null,
	notes: null,
	...over
});

const exercise = (name: string, over: Partial<ExerciseSource> = {}): ExerciseSource => ({
	name,
	superset: null,
	instructions: null,
	notes: null,
	sets: [set()],
	...over
});

const details = (over: Partial<OtherDetails> = {}): OtherDetails => ({
	kind: 'class',
	durationMinutes: 90,
	targetRpe: 7,
	metrics: [],
	notes: null,
	...over
});

describe('whenWords', () => {
	it('names the day from the calendar string and adds the time of day when it is known', () => {
		expect(whenWords('2026-11-10', 'evening')).toBe('Tuesday 10 November · Evening');
		expect(whenWords('2026-11-09', 'early_morning')).toBe('Monday 9 November · Early morning');
	});

	it('leaves out a time that is unknown or varies', () => {
		expect(whenWords('2026-11-09', null)).toBe('Monday 9 November');
		expect(whenWords('2026-11-09', 'varies')).toBe('Monday 9 November');
	});
});

describe('disciplineWords', () => {
	it('names the session type, and an other session’s format after it', () => {
		expect(disciplineWords({ kind: 'strength', type: 'strength', customDiscipline: null })).toBe(
			'Strength'
		);
		expect(disciplineWords({ kind: 'run', type: 'interval_run', customDiscipline: null })).toBe(
			'Intervals'
		);
		expect(
			disciplineWords({
				kind: 'other',
				type: 'muay_thai',
				customDiscipline: null,
				details: details({ kind: 'pad_work' })
			})
		).toBe('Muay Thai · Pad work');
	});

	it('never repeats a format the type already names, and a custom session says its own discipline', () => {
		expect(
			disciplineWords({
				kind: 'other',
				type: 'mobility',
				customDiscipline: null,
				details: details({ kind: 'mobility' })
			})
		).toBe('Mobility');
		expect(
			disciplineWords({
				kind: 'other',
				type: 'custom',
				customDiscipline: 'Climbing',
				details: details({ kind: 'custom' })
			})
		).toBe('Climbing');
	});
});

describe('detailsView', () => {
	it('gives a strength or run session its planned minutes, target RPE and intensity', () => {
		expect(
			detailsView({ kind: 'strength', estMinutes: 60, targetRpe: 7.5, intensity: 'moderate' })
		).toEqual({
			facts: [
				{ label: 'Duration', value: '60', unit: 'min', caption: null },
				{ label: 'Target RPE', value: '7.5', unit: null, caption: 'Moderate' }
			],
			metrics: []
		});
	});

	it('reads an other session’s own duration, target RPE and metrics from its details', () => {
		const view = detailsView({
			kind: 'other',
			estMinutes: 60,
			targetRpe: 6,
			intensity: 'hard',
			details: details({
				durationMinutes: 90,
				targetRpe: 7,
				metrics: [
					{ key: 'rounds', label: 'Rounds', unit: null, value: 6 },
					{ key: 'round_length', label: 'Round length', unit: 'min', value: 3 }
				]
			})
		});
		expect(view.facts).toEqual([
			{ label: 'Duration', value: '90', unit: 'min', caption: null },
			{ label: 'Target RPE', value: '7', unit: null, caption: 'Hard' }
		]);
		expect(view.metrics).toEqual([
			{ label: 'Rounds', value: '6' },
			{ label: 'Round length', value: '3 min' }
		]);
	});

	it('falls back to the session’s target RPE when the details set none', () => {
		const view = detailsView({
			kind: 'other',
			estMinutes: 45,
			targetRpe: 6,
			intensity: 'easy',
			details: details({ durationMinutes: 45, targetRpe: null })
		});
		expect(view.facts[1]).toEqual({ label: 'Target RPE', value: '6', unit: null, caption: 'Easy' });
	});
});

describe('metricValue', () => {
	it('says a number with its unit, a yes/no in words and a text as written', () => {
		expect(metricValue({ key: 'r', label: 'Rounds', unit: null, value: 6 })).toBe('6');
		expect(metricValue({ key: 'l', label: 'Length', unit: 'min', value: 2.5 })).toBe('2.5 min');
		expect(metricValue({ key: 's', label: 'Sparring', unit: null, value: false })).toBe('No');
		expect(metricValue({ key: 's', label: 'Sparring', unit: null, value: true })).toBe('Yes');
		expect(metricValue({ key: 'f', label: 'Focus', unit: null, value: 'Teeps and checks' })).toBe(
			'Teeps and checks'
		);
	});
});

describe('exerciseViews', () => {
	const kg = { unit: 'kg' as const, oneRepMaxKg: null };

	it('describes each set prescription in the owner’s unit, with what a baseline set records', () => {
		const [squat, bench] = exerciseViews(
			[
				exercise('Back squat', {
					instructions: 'Record weight, reps and RPE for every set.',
					sets: [
						set({ role: 'top', sets: 1, restSeconds: 180 }),
						set({ role: 'back_off', sets: 2, loadKind: 'from_e1rm', loadValue: 0.72 })
					]
				}),
				exercise('Bench press', {
					sets: [
						set({
							loadKind: 'percent_1rm',
							loadValue: 0.7,
							loadBasis: 'measured',
							reference1rm: 100,
							reference1rmUnit: 'kg'
						})
					]
				})
			],
			{ unit: 'lb', oneRepMaxKg: null }
		);
		expect(squat).toMatchObject({
			label: null,
			name: 'Back squat',
			instructions: 'Record weight, reps and RPE for every set.'
		});
		expect(squat!.sets).toEqual([
			{
				headline: 'Work up to a set of 5 @ RPE 7',
				load: null,
				basis: null,
				rest: 'Rest 3:00',
				tempo: null,
				instruction: BASELINE_INSTRUCTION
			},
			{
				headline: '2 × 5 @ RPE 7',
				load: null,
				basis: '72 % of your week-1 estimate',
				rest: 'Rest 2:00',
				tempo: null,
				instruction: null
			}
		]);
		// 70 % of 100 kg in pounds, to the owner's plates.
		expect(bench!.sets[0]).toMatchObject({ load: '155 lb', basis: '70 % of your measured 1RM' });
	});

	it('labels a superset’s exercises A1, A2, B1 in order, and leaves straight sets unlabelled', () => {
		const views = exerciseViews(
			[
				exercise('Squat'),
				exercise('Pull-up', { superset: 4 }),
				exercise('Dip', { superset: 4 }),
				exercise('Curl', { superset: 9 }),
				exercise('Plank'),
				exercise('Triceps', { superset: 9 })
			],
			kg
		);
		expect(views.map((v) => v.label)).toEqual([null, 'A1', 'A2', 'B1', null, 'B2']);
	});
});

describe('BASELINE_CALLOUT', () => {
	it('asks the owner to record what they reach, in the words a baseline set uses', () => {
		expect(BASELINE_CALLOUT.points).toContain(BASELINE_INSTRUCTION);
	});
});

describe('moveOption', () => {
	it('names a day as its card and its toast say it, with what is planned there', () => {
		expect(moveOption({ date: '2026-11-11', planned: 'Intervals' })).toEqual({
			date: '2026-11-11',
			label: 'Wed 11 Nov',
			day: 'Wednesday',
			planned: 'Intervals'
		});
		// Across a month end, and on a Sunday.
		expect(moveOption({ date: '2026-11-29', planned: 'Rest day' })).toMatchObject({
			label: 'Sun 29 Nov',
			day: 'Sunday'
		});
		expect(moveOption({ date: '2026-12-01', planned: 'Rest day' })).toMatchObject({
			label: 'Tue 1 Dec',
			day: 'Tuesday'
		});
	});
});

describe('adjustValues', () => {
	const segment = (over: Partial<RunSegment>): RunSegment => ({
		kind: 'easy',
		repeatGroup: null,
		repeats: null,
		distanceMetres: null,
		durationSeconds: null,
		paceMinSecondsPerKm: null,
		paceMaxSecondsPerKm: null,
		hrZone: null,
		targetRpe: null,
		...over
	});

	it('gives each set prescription its position, its words and only the values it has', () => {
		const sets = [
			set({ role: 'top', sets: 1, restSeconds: 180 }),
			set({
				role: 'back_off',
				sets: 2,
				loadKind: 'percent_1rm',
				loadValue: 0.72,
				loadBasis: 'measured',
				reference1rm: 100,
				reference1rmUnit: 'kg'
			}),
			set({
				repsMin: 8,
				repsMax: 10,
				targetRpe: null,
				loadKind: 'absolute',
				loadValue: 60,
				loadUnit: 'lb',
				restSeconds: null
			}),
			set({ repsMin: null, repsMax: null, seconds: 45 })
		];
		const values = adjustValues(
			{ kind: 'strength', exercises: [{ lineage: 'squat', sets }] },
			{ distanceUnit: 'km' }
		);
		expect(values).toEqual({
			kind: 'strength',
			exercises: {
				squat: [
					{
						position: 1,
						label: 'Top set · Work up to a set of 5 @ RPE 7',
						sets: 1,
						repsMin: 5,
						repsMax: 5,
						targetRpe: 7,
						load: null,
						restSeconds: 180
					},
					{
						position: 2,
						label: 'Back-off · 2 × 5 @ RPE 7',
						sets: 2,
						repsMin: 5,
						repsMax: 5,
						targetRpe: 7,
						load: { value: 0.72, unit: '%' },
						restSeconds: 120
					},
					{
						position: 3,
						label: 'Working · 3 × 8–10',
						sets: 3,
						repsMin: 8,
						repsMax: 10,
						targetRpe: null,
						load: { value: 60, unit: 'lb' },
						restSeconds: null
					},
					{
						position: 4,
						label: 'Working · 3 × 0:45 @ RPE 7',
						sets: 3,
						repsMin: null,
						repsMax: null,
						targetRpe: 7,
						load: null,
						restSeconds: 120
					}
				]
			}
		});
	});

	it('names each run segment with its repeats, and keeps paces per km for the owner’s unit', () => {
		const values = adjustValues(
			{
				kind: 'run',
				segments: [
					segment({ kind: 'warm_up', durationSeconds: 600, targetRpe: 3 }),
					segment({
						kind: 'interval',
						repeatGroup: 1,
						repeats: 6,
						distanceMetres: 400,
						paceMinSecondsPerKm: 225,
						paceMaxSecondsPerKm: 240
					})
				]
			},
			{ distanceUnit: 'mi' }
		);
		expect(values).toEqual({
			kind: 'run',
			paceUnit: 'mi',
			segments: [
				{
					position: 1,
					label: 'Warm-up 10:00',
					distanceMetres: null,
					durationSeconds: 600,
					paceMinSecondsPerKm: null,
					paceMaxSecondsPerKm: null,
					targetRpe: 3,
					repeats: null
				},
				{
					position: 2,
					label: '6 × Interval 400 m',
					distanceMetres: 400,
					durationSeconds: null,
					paceMinSecondsPerKm: 225,
					paceMaxSecondsPerKm: 240,
					targetRpe: null,
					repeats: 6
				}
			]
		});
	});

	it('gives another session its own length and RPE', () => {
		expect(
			adjustValues({ kind: 'other', details: details({ targetRpe: null }) }, { distanceUnit: 'km' })
		).toEqual({ kind: 'other', durationMinutes: 90, targetRpe: null });
	});
});
