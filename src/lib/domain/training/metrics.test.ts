import { describe, expect, it } from 'vitest';
import { estimateOneRepMax } from '../e1rm.ts';
import { sessionLoad } from '../load.ts';
import { lbToKg, toMetres } from '../units.ts';
import {
	bestE1rm,
	exerciseRefKey,
	hardSets,
	personalRecords,
	plannedHardSets,
	sessionLoadOf,
	setE1rm,
	weekStartOf,
	weeklyDistance
} from './metrics.ts';
import type { ExerciseMuscles, LoggedSet } from './metrics.ts';
import type {
	OtherSessionPlan,
	RunSessionPlan,
	SetPrescription,
	StrengthSessionPlan,
	WeekPlan
} from './types.ts';

const EXERCISES = new Map<string, ExerciseMuscles>([
	['bench_press', { primaryMuscles: ['chest'], secondaryMuscles: ['triceps', 'front_delts'] }],
	['barbell_row', { primaryMuscles: ['lats', 'upper_back'], secondaryMuscles: ['biceps'] }],
	['overhead_press', { primaryMuscles: ['front_delts'], secondaryMuscles: ['side_delts'] }],
	[
		'custom:6f1c1a52-0c0e-4b6e-9d43-8d1f5b0f2a11',
		{ primaryMuscles: ['calves'], secondaryMuscles: [] }
	]
]);

/** Monday 2 November 2026, 18:00 UTC, plus `days`. */
const at = (days = 0) => new Date(Date.UTC(2026, 10, 2 + days, 18));

const logged = (overrides: Partial<LoggedSet> = {}): LoggedSet => ({
	exercise: 'bench_press',
	weight: 100,
	unit: 'kg',
	reps: 5,
	rpe: 8,
	isWarmup: false,
	isSkipped: false,
	performedAt: at(),
	...overrides
});

describe('setE1rm', () => {
	it("is M1's estimateOneRepMax, in kg", () => {
		expect(setE1rm(logged())).toEqual(estimateOneRepMax({ weight: 100, reps: 5, rpe: 8 }));
		expect(setE1rm(logged({ rpe: null }))).toEqual(
			estimateOneRepMax({ weight: 100, reps: 5, rpe: null })
		);
	});

	it('converts pounds with the exact factor before estimating', () => {
		const estimate = setE1rm(logged({ weight: 225, unit: 'lb' }));
		expect(estimate).toEqual(estimateOneRepMax({ weight: lbToKg(225), reps: 5, rpe: 8 }));
		expect(estimate?.value).toBe((225 * 0.45359237) / 0.811);
	});

	it('gives none for warm-ups, skipped sets, RPE under 6 and unloaded sets', () => {
		expect(setE1rm(logged({ isWarmup: true }))).toBeNull();
		expect(setE1rm(logged({ isSkipped: true }))).toBeNull();
		expect(setE1rm(logged({ rpe: 5.5 }))).toBeNull();
		expect(setE1rm(logged({ rpe: 6 }))).not.toBeNull();
		expect(setE1rm(logged({ weight: null }))).toBeNull();
		expect(setE1rm(logged({ reps: null }))).toBeNull();
	});
});

describe('bestE1rm', () => {
	it('is the highest estimate, always labelled estimated, never measured', () => {
		const sets = [
			logged(),
			logged({ weight: 110, performedAt: at(-7) }),
			logged({ isWarmup: true, weight: 140 })
		];
		const best = bestE1rm(sets);
		expect(best?.set).toBe(sets[1]);
		expect(best?.kind).toBe('estimated');
		expect(best?.value).toBe(setE1rm(sets[1]!)!.value);
		// A single at RPE 10 is as close to a measured max as a log gets, and still an estimate.
		expect(bestE1rm([logged({ reps: 1, rpe: 10, weight: 150 })])?.kind).toBe('estimated');
	});

	it('gives a tie to the most recent set, whatever the order', () => {
		const older = logged({ performedAt: at(-14) });
		const newer = logged({ performedAt: at() });
		expect(bestE1rm([older, newer])?.set).toBe(newer);
		expect(bestE1rm([newer, older])?.set).toBe(newer);
	});

	it('is null with no estimable set', () => {
		expect(bestE1rm([])).toBeNull();
		expect(bestE1rm([logged({ isWarmup: true }), logged({ rpe: 5 })])).toBeNull();
	});
});

describe('personalRecords', () => {
	it('keeps the heaviest working load per rep count from 1 to 10, ignoring warm-ups', () => {
		const sets = [
			logged({ reps: 5, weight: 100 }),
			logged({ reps: 5, weight: 105, performedAt: at(-7) }),
			logged({ reps: 5, weight: 140, isWarmup: true }),
			logged({ reps: 5, weight: 150, isSkipped: true }),
			logged({ reps: 3, weight: 250, unit: 'lb' }),
			logged({ reps: 1, weight: 120, rpe: null }),
			logged({ reps: 11, weight: 90 }),
			logged({ reps: 8, weight: null })
		];
		expect(personalRecords(sets)).toEqual([
			{ reps: 1, weightKg: 120, set: sets[5] },
			{ reps: 3, weightKg: lbToKg(250), set: sets[4] },
			{ reps: 5, weightKg: 105, set: sets[1] }
		]);
	});

	it('gives a tie to the most recent set, whatever the order', () => {
		const older = logged({ performedAt: at(-7) });
		const newer = logged({ performedAt: at() });
		expect(personalRecords([older, newer])[0]?.set).toBe(newer);
		expect(personalRecords([newer, older])[0]?.set).toBe(newer);
	});
});

describe('hardSets', () => {
	it('credits bench 1 for chest and 0.5 for triceps and front delts', () => {
		expect(hardSets([logged()], EXERCISES, 'UTC')).toEqual([
			{
				weekStart: '2026-11-02',
				muscles: { chest: 1, triceps: 0.5, front_delts: 0.5 },
				groups: { chest: 1, triceps: 0.5, shoulders: 0.5 }
			}
		]);
	});

	it('counts RPE 7 and up and unrated working sets, never RPE 6, warm-ups or skipped sets', () => {
		const sets = [
			logged({ rpe: 7 }),
			logged({ rpe: null }),
			logged({ rpe: 6.5 }),
			logged({ rpe: 6 }),
			logged({ isWarmup: true }),
			logged({ isSkipped: true })
		];
		expect(hardSets(sets, EXERCISES, 'UTC')[0]?.muscles.chest).toBe(2);
		expect(hardSets(sets.slice(2), EXERCISES, 'UTC')).toEqual([]);
	});

	it('credits a group once per set, even when several of its muscles work', () => {
		const [week] = hardSets([logged({ exercise: 'barbell_row' })], EXERCISES, 'UTC');
		expect(week?.muscles).toEqual({ lats: 1, upper_back: 1, biceps: 0.5 });
		expect(week?.groups).toEqual({ back: 1, biceps: 0.5 });
		const [press] = hardSets([logged({ exercise: 'overhead_press' })], EXERCISES, 'UTC');
		expect(press?.groups).toEqual({ shoulders: 1 });
	});

	it('splits weeks on Monday in the owner’s time zone, oldest first', () => {
		const sunday = logged({ performedAt: at(6) });
		const monday = logged({ performedAt: at(7) });
		expect(hardSets([monday, sunday], EXERCISES, 'UTC').map((w) => w.weekStart)).toEqual([
			'2026-11-02',
			'2026-11-09'
		]);
		// 20:00 on Sunday 8 November in Los Angeles is already Monday in UTC.
		const evening = logged({ performedAt: new Date('2026-11-09T04:00:00Z') });
		expect(hardSets([evening], EXERCISES, 'America/Los_Angeles')[0]?.weekStart).toBe('2026-11-02');
		expect(hardSets([evening], EXERCISES, 'UTC')[0]?.weekStart).toBe('2026-11-09');
	});

	it('refuses a set whose exercise it cannot find, even one that is not a hard set', () => {
		expect(() => hardSets([logged({ exercise: 'nope' })], EXERCISES, 'UTC')).toThrow(/'nope'/);
		const warmUp = logged({ exercise: 'nope', isWarmup: true });
		expect(() => hardSets([warmUp], EXERCISES, 'UTC')).toThrow(RangeError);
	});
});

const prescription = (overrides: Partial<SetPrescription>): SetPrescription => ({
	role: 'working',
	sets: 1,
	repsMin: 5,
	repsMax: 5,
	seconds: null,
	metres: null,
	targetRpe: null,
	loadKind: 'rpe_based',
	loadValue: null,
	loadUnit: null,
	loadBasis: null,
	reference1rm: null,
	reference1rmUnit: null,
	restSeconds: 120,
	tempo: null,
	notes: null,
	...overrides
});

/** What every planned session carries, here an hour of strength at RPE 7. */
const sessionBase = (date: string): Omit<StrengthSessionPlan, 'kind' | 'exercises'> => ({
	date,
	timeOfDay: null,
	orderInDay: 1,
	type: 'strength',
	title: 'Upper',
	discipline: 'strength',
	customDiscipline: null,
	intensity: 'moderate',
	estMinutes: 60,
	estLoad: 420,
	targetRpe: 7,
	source: 'generator',
	commitmentRef: null,
	instructions: null,
	notes: null
});

const strength = (
	date: string,
	exercises: StrengthSessionPlan['exercises']
): StrengthSessionPlan => ({ ...sessionBase(date), kind: 'strength', exercises });

const planned = (key: { key: string } | { customId: string }, sets: SetPrescription[]) => ({
	exercise: key,
	baselineLift: null,
	superset: null,
	substitutedFrom: null,
	substitutionReason: null,
	instructions: null,
	notes: null,
	sets
});

describe('plannedHardSets', () => {
	const week: WeekPlan = {
		kind: 'baseline',
		startsOn: '2026-11-02',
		endsOn: '2026-11-08',
		targets: { rpeCap: 8, volumeFactor: 1, loadStep: 0, runVolumeFactor: 1 },
		sessions: [
			strength('2026-11-02', [
				planned({ key: 'bench_press' }, [
					prescription({ role: 'warm_up', sets: 2 }),
					prescription({ role: 'ramp', sets: 3 }),
					prescription({ role: 'top', targetRpe: 8 }),
					prescription({ role: 'back_off', sets: 3, targetRpe: 7 }),
					prescription({ role: 'back_off', sets: 2, targetRpe: 6.5 })
				]),
				planned({ customId: '6f1c1a52-0c0e-4b6e-9d43-8d1f5b0f2a11' }, [
					prescription({ sets: 3, loadKind: 'absolute', loadValue: 40, loadUnit: 'kg' })
				])
			]),
			strength('2026-11-05', [
				planned({ key: 'barbell_row' }, [prescription({ sets: 4, targetRpe: 8 })])
			])
		]
	};

	it('agrees with hardSets on the equivalent logged sets', () => {
		const sets: LoggedSet[] = [
			...Array.from({ length: 5 }, () => logged({ isWarmup: true, rpe: null })),
			logged({ rpe: 8 }),
			...Array.from({ length: 3 }, () => logged({ rpe: 7 })),
			...Array.from({ length: 2 }, () => logged({ rpe: 6.5 })),
			...Array.from({ length: 3 }, () =>
				logged({ exercise: 'custom:6f1c1a52-0c0e-4b6e-9d43-8d1f5b0f2a11', rpe: null, weight: 40 })
			),
			...Array.from({ length: 4 }, () => logged({ exercise: 'barbell_row', performedAt: at(3) }))
		];
		const plan = plannedHardSets(week, EXERCISES);
		expect(plan).toEqual({
			weekStart: '2026-11-02',
			muscles: {
				chest: 4,
				triceps: 2,
				front_delts: 2,
				calves: 3,
				lats: 4,
				upper_back: 4,
				biceps: 2
			},
			groups: { chest: 4, triceps: 2, shoulders: 2, calves: 3, back: 4, biceps: 2 }
		});
		expect(hardSets(sets, EXERCISES, 'UTC')).toEqual([plan]);
	});

	it('credits nothing for runs and other sessions, a strength class included', () => {
		const common = { ...sessionBase('2026-11-03'), estMinutes: 45, estLoad: 270 };
		const run: RunSessionPlan = {
			...common,
			kind: 'run',
			type: 'easy_run',
			title: 'Easy run',
			discipline: 'running',
			segments: [
				{
					kind: 'easy',
					repeatGroup: null,
					repeats: null,
					distanceMetres: null,
					durationSeconds: 2700,
					paceMinSecondsPerKm: null,
					paceMaxSecondsPerKm: null,
					hrZone: 2,
					targetRpe: 4
				}
			]
		};
		const strengthClass: OtherSessionPlan = {
			...common,
			kind: 'other',
			type: 'strength_class',
			title: 'Barbell class',
			source: 'commitment',
			commitmentRef: '0b9f4c64-7d1e-4f1a-9a3e-2f6d1c8e5b70',
			details: { kind: 'class', durationMinutes: 45, targetRpe: 8, metrics: [], notes: null }
		};
		expect(plannedHardSets({ ...week, sessions: [run, strengthClass] }, EXERCISES)).toEqual({
			weekStart: '2026-11-02',
			muscles: {},
			groups: {}
		});
	});

	it('looks custom exercises up as custom:<uuid>', () => {
		expect(exerciseRefKey({ key: 'bench_press' })).toBe('bench_press');
		expect(exerciseRefKey({ customId: 'abc' })).toBe('custom:abc');
	});
});

describe('sessionLoadOf', () => {
	it("is M1's sessionLoad for a logged workout, from its seconds and session RPE", () => {
		expect(sessionLoadOf({ durationSeconds: 3600, sessionRpe: 7 })).toBe(sessionLoad(60, 7));
		expect(sessionLoadOf({ durationSeconds: 2700, sessionRpe: 6.5 })).toBe(sessionLoad(45, 6.5));
	});

	it("is M1's sessionLoad for a planned session, from its estimate and target RPE", () => {
		expect(sessionLoadOf(strength('2026-11-02', []))).toBe(sessionLoad(60, 7));
		expect(sessionLoadOf({ estMinutes: 90, targetRpe: 8 })).toBe(sessionLoad(90, 8));
	});

	it('is unknown while a logged workout lacks its duration or RPE', () => {
		expect(sessionLoadOf({ durationSeconds: null, sessionRpe: 7 })).toBeNull();
		expect(sessionLoadOf({ durationSeconds: 3600, sessionRpe: null })).toBeNull();
	});
});

describe('weeklyDistance', () => {
	it('adds km and mi exactly, in metres, and shows the total in the unit asked for', () => {
		const runs = [
			{ distance: 5, unit: 'km' as const, startedAt: at() },
			{ distance: 1, unit: 'mi' as const, startedAt: at(2) },
			{ distance: 400, unit: 'm' as const, startedAt: at(4) }
		];
		// 7009.344 m is 7.0093440000000005 km in floating point until the noise is removed.
		expect(weeklyDistance(runs, 'km', 'UTC')).toEqual([
			{ weekStart: '2026-11-02', metres: 7009.344, distance: 7.009344 }
		]);
		expect(weeklyDistance(runs, 'mi', 'UTC')).toEqual([
			{ weekStart: '2026-11-02', metres: 7009.344, distance: 4.355404 }
		]);
		// Floating-point noise never reaches the total: 0.1 mi ten times is exactly 1 mi.
		const tenths = Array.from({ length: 10 }, () => ({
			distance: 0.1,
			unit: 'mi' as const,
			startedAt: at()
		}));
		expect(weeklyDistance(tenths, 'mi', 'UTC')[0]).toMatchObject({
			metres: toMetres(1, 'mi'),
			distance: 1
		});
	});

	it('keeps a Sunday-evening run in its own week', () => {
		const runs = [
			// 20:00 on Sunday 8 November in Los Angeles: 04:00 on Monday in UTC.
			{ distance: 10, unit: 'km' as const, startedAt: new Date('2026-11-09T04:00:00Z') },
			{ distance: 3, unit: 'mi' as const, startedAt: new Date('2026-11-09T16:00:00Z') }
		];
		expect(weeklyDistance(runs, 'km', 'America/Los_Angeles')).toEqual([
			{ weekStart: '2026-11-02', metres: 10_000, distance: 10 },
			{ weekStart: '2026-11-09', metres: 4828.032, distance: 4.828032 }
		]);
		expect(weeklyDistance(runs, 'km', 'UTC').map((w) => w.weekStart)).toEqual(['2026-11-09']);
	});

	it('gives no weeks without runs', () => {
		expect(weeklyDistance([], 'km', 'UTC')).toEqual([]);
	});
});

describe('weekStartOf', () => {
	it('is the Monday of the owner’s calendar day', () => {
		expect(weekStartOf(new Date('2026-11-09T04:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-02');
		expect(weekStartOf(new Date('2026-11-09T04:00:00Z'), 'Asia/Tokyo')).toBe('2026-11-09');
	});
});
