/**
 * The shared kit fixture (test-only, never imported by app code): the start kits of M3's
 * 'workout-day' program, which start-kit adds to M3's fixture route. The domain tests, the
 * IndexedDB-seeded e2e specs and start-kit's comparison use this one copy, and start-kit's
 * integration test proves the server builds the same kits. start-kit is its only later editor,
 * to match M3's wording.
 *
 * - Exercises are named by catalogue key: `exerciseId` turns a key into its row id (specs
 *   resolve ids in SQL; domain tests may keep the key).
 * - The program, its planned sessions and their lineages are the fixed ids in WORKOUT_DAY_IDS,
 *   which start-kit's comparison maps to the server's.
 * - Lines are M3's describePrescription headlines; loads are in kg, distances in km.
 */
import { addDays } from '../../src/lib/domain/calendar';
import type { IsoDate } from '../../src/lib/domain/calendar';
import { BASELINE_INSTRUCTION } from '../../src/lib/domain/training/describe';
import type { RunSegment } from '../../src/lib/domain/training/types';
import type {
	KitExercise,
	KitExerciseMeta,
	KitSet,
	KitUnits,
	LoggedSet,
	OtherKit,
	RunKit,
	StrengthKit
} from '../../src/lib/domain/workout';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const WORKOUT_DAY_IDS = {
	programId: id(1),
	strength: { session: id(11), lineage: id(21) },
	run: { session: id(12), lineage: id(22) },
	other: { session: id(13), lineage: id(23) },
	/** The planned exercises' lineages, by position. */
	exercises: [id(31), id(32), id(33), id(34), id(35)]
} as const;

const UNITS: KitUnits = { weight: 'kg', distance: 'km' };

const plan = (kind: 'strength' | 'run' | 'other', date: IsoDate) => ({
	v: 1 as const,
	date,
	plannedLineage: WORKOUT_DAY_IDS[kind].lineage,
	plannedSessionId: WORKOUT_DAY_IDS[kind].session,
	programId: WORKOUT_DAY_IDS.programId,
	versionNumber: 1,
	units: UNITS
});

type Meta = Omit<KitExerciseMeta, 'id' | 'increment' | 'unilateral'>;

const BACK_SQUAT: Meta = {
	key: 'back_squat',
	name: 'Back squat',
	measure: 'reps',
	loadType: 'external',
	pattern: 'squat',
	tags: ['compound', 'competition', 'spinal_loading', 'deep_knee_flexion'],
	restClass: 'main'
};
const LEG_PRESS: Meta = {
	key: 'leg_press',
	name: 'Leg press',
	measure: 'reps',
	loadType: 'external',
	pattern: 'squat',
	tags: ['compound', 'back_friendly'],
	restClass: 'compound'
};
const ROMANIAN_DEADLIFT: Meta = {
	key: 'romanian_deadlift',
	name: 'Romanian deadlift',
	measure: 'reps',
	loadType: 'external',
	pattern: 'hinge',
	tags: ['compound', 'spinal_loading', 'grip_demanding'],
	restClass: 'compound'
};
const PULL_UP: Meta = {
	key: 'pull_up',
	name: 'Pull-up',
	measure: 'reps',
	loadType: 'bodyweight',
	pattern: 'vertical_pull',
	tags: ['compound', 'grip_demanding'],
	restClass: 'compound'
};
const PLANK: Meta = {
	key: 'plank',
	name: 'Plank',
	measure: 'time',
	loadType: 'bodyweight',
	pattern: 'anti_extension',
	tags: ['back_friendly'],
	restClass: 'timed'
};

const NO_AMOUNT = { repsMin: null, repsMax: null, seconds: null, metres: null } as const;

/** `count` sets of one prescription line. */
const sets = (count: number, set: Omit<KitSet, 'instruction'> & Partial<KitSet>): KitSet[] =>
	Array.from({ length: count }, () => ({ instruction: null, ...set }));

const reps = (min: number, max = min) => ({ ...NO_AMOUNT, repsMin: min, repsMax: max });

const done = (weight: number | null, count: number, rpe: number | null): LoggedSet => ({
	reps: count,
	seconds: null,
	metres: null,
	weight,
	assistance: null,
	unit: 'kg',
	rpe,
	missedReps: 0,
	isWarmup: false,
	isExtra: false
});

export interface WorkoutDayKits {
	strength: StrengthKit;
	run: RunKit;
	other: OtherKit;
}

export interface WorkoutDayOptions {
	/** The day the program plans the sessions on: today, as the fixture route computes it. */
	date: IsoDate;
	/** A catalogue key's exercise id; the key itself by default. */
	exerciseId?: (key: string) => string;
}

export function workoutDayKits({
	date,
	exerciseId = (key) => key
}: WorkoutDayOptions): WorkoutDayKits {
	const exercise = (meta: Meta): KitExerciseMeta => ({
		...meta,
		id: exerciseId(meta.key!),
		unilateral: false,
		increment: 2.5
	});
	const slot = (
		position: number,
		meta: Meta,
		kitSets: KitSet[],
		more: Partial<KitExercise> = {}
	): KitExercise => ({
		position,
		plannedLineage: WORKOUT_DAY_IDS.exercises[position - 1]!,
		superset: null,
		exercise: exercise(meta),
		sets: kitSets,
		instructions: null,
		previous: null,
		bestE1rm: null,
		priorBests: [],
		mostReps: null,
		...more
	});
	const working = { role: 'working', prescribedWeight: null } as const;

	return {
		strength: {
			...plan('strength', date),
			kind: 'strength',
			title: 'Lower body & pull',
			sessionType: 'strength',
			discipline: 'strength',
			exercises: [
				slot(
					1,
					BACK_SQUAT,
					[
						...sets(1, {
							...reps(5),
							role: 'top',
							targetRpe: 7,
							prescribedWeight: null,
							restSeconds: 180,
							line: 'Work up to a set of 5 @ RPE 7',
							instruction: BASELINE_INSTRUCTION
						}),
						// 80 % of the estimated 1RM: 0.8 × 125 kg.
						...sets(3, {
							...reps(5),
							role: 'back_off',
							targetRpe: null,
							prescribedWeight: { value: 100, unit: 'kg', basis: 'estimated' },
							restSeconds: 180,
							line: '3 × 5'
						})
					],
					{
						previous: {
							date: addDays(date, -7),
							sets: [done(100, 5, 8), done(85, 5, 7), done(85, 5, 7), done(85, 5, 7.5)]
						},
						bestE1rm: { kg: 125, estimated: true },
						priorBests: [
							{ reps: 3, weightKg: 110, date: addDays(date, -21) },
							{ reps: 5, weightKg: 100, date: addDays(date, -7) }
						]
					}
				),
				slot(
					2,
					LEG_PRESS,
					sets(3, {
						...working,
						...reps(10),
						targetRpe: 7,
						restSeconds: 120,
						line: '3 × 10 @ RPE 7'
					})
				),
				slot(
					3,
					ROMANIAN_DEADLIFT,
					sets(3, { ...working, ...reps(8), targetRpe: 7, restSeconds: 120, line: '3 × 8 @ RPE 7' })
				),
				// A1/A2: no rest inside a round, 90 s after each.
				slot(
					4,
					PULL_UP,
					sets(3, {
						...working,
						...reps(6, 10),
						targetRpe: 8,
						restSeconds: 0,
						line: '3 × 6–10 @ RPE 8'
					}),
					{ superset: 1 }
				),
				slot(
					5,
					PLANK,
					sets(3, {
						...working,
						...NO_AMOUNT,
						seconds: 45,
						targetRpe: null,
						restSeconds: 90,
						line: '3 × 0:45'
					}),
					{ superset: 1 }
				)
			]
		},
		run: {
			...plan('run', date),
			kind: 'run',
			title: 'Intervals',
			sessionType: 'interval_run',
			discipline: 'running',
			// 'Warm-up 10:00', '6 × (Interval 400 m + Recovery 1:30)', 'Cool-down 10:00': 14 segments.
			run: {
				segments: [
					segment('warm_up', { durationSeconds: 600, hrZone: 2 }),
					segment('interval', {
						repeatGroup: 1,
						repeats: 6,
						distanceMetres: 400,
						paceMinSecondsPerKm: 225,
						paceMaxSecondsPerKm: 240
					}),
					segment('recovery', { repeatGroup: 1, repeats: 6, durationSeconds: 90 }),
					segment('cool_down', { durationSeconds: 600, hrZone: 2 })
				]
			}
		},
		other: {
			...plan('other', date),
			kind: 'other',
			title: 'Muay Thai class',
			sessionType: 'muay_thai',
			discipline: 'muay_thai',
			other: {
				kind: 'class',
				durationMinutes: 90,
				targetRpe: 7,
				metrics: [
					{ key: 'rounds', label: 'Rounds', unit: null, value: 6 },
					{ key: 'sparred', label: 'Sparred', unit: null, value: false }
				]
			}
		}
	};
}

function segment(kind: RunSegment['kind'], values: Partial<RunSegment>): RunSegment {
	return {
		kind,
		repeatGroup: null,
		repeats: null,
		distanceMetres: null,
		durationSeconds: null,
		paceMinSecondsPerKm: null,
		paceMaxSecondsPerKm: null,
		hrZone: null,
		targetRpe: null,
		...values
	};
}
