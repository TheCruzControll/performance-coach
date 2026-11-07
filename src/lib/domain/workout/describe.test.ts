import { describe, expect, it } from 'vitest';
import { describeMutation, problemText, setValues, type DescribeContext } from './describe';
import { createMutation, MUTATION_TYPES, type Mutation, type MutationPayloads } from './mutations';

const W = '00000000-0000-4000-8000-0000000000c1';
const SQUAT = '00000000-0000-4000-8000-0000000000e1';
const PULL = '00000000-0000-4000-8000-0000000000e2';
const SET = '00000000-0000-4000-8000-0000000000f1';
const at = '2026-11-07T08:00:00.000Z';

const done = {
	reps: 5,
	seconds: null,
	metres: null,
	weight: 100,
	assistance: null,
	unit: 'kg',
	rpe: 8,
	missedReps: 0,
	isWarmup: false,
	isExtra: false
} as const satisfies MutationPayloads['set.edit'];
const slot = { position: 1, plannedLineage: null };

/** A valid payload of every type: a type without one fails pnpm check. */
const PAYLOADS: { [T in keyof MutationPayloads]: MutationPayloads[T] } = {
	'workout.start': {
		kind: 'strength',
		title: 'Lower body & pull',
		sessionType: 'strength',
		discipline: 'strength',
		plannedSessionId: null,
		plannedLineage: null,
		programId: null
	},
	'workout.update': { notes: 'Felt good' },
	'workout.finish': {},
	'workout.abandon': {},
	'set.log': { ...slot, setIndex: 3, exerciseId: SQUAT, ...done },
	'set.skip': { ...slot, setIndex: 2, exerciseId: SQUAT, unit: 'kg' },
	'set.edit': { ...done, reps: 4 },
	'set.delete': {},
	'exercise.skip': { ...slot, exerciseId: SQUAT, unit: 'kg', sets: [] },
	'exercise.substitute': {
		...slot,
		fromExerciseId: SQUAT,
		toExerciseId: PULL,
		reason: 'equipment_unavailable'
	},
	'exercise.dislike': { ...slot, fromExerciseId: SQUAT, toExerciseId: PULL, note: null },
	'exercise.create': {
		name: 'Sandbag shouldering',
		measure: 'reps',
		loadType: 'external',
		pattern: 'carry',
		primaryMuscles: ['glutes'],
		equipment: [],
		defaultSeconds: null
	} as unknown as MutationPayloads['exercise.create'],
	'pain.report': {
		...slot,
		exerciseId: SQUAT,
		area: null,
		severity: null,
		action: 'stopped',
		substitutionId: null,
		note: null
	},
	'run.log': { distanceMetres: 5000 },
	'run.segment': {
		position: 2,
		kind: 'interval',
		distanceMetres: 400,
		durationSeconds: null,
		avgHr: null,
		rpe: null
	} as unknown as MutationPayloads['run.segment'],
	'other.log': { kind: 'muay_thai', durationMinutes: 60, rpe: 7, metrics: [], notes: null } as never
};

const mutationOf = (type: keyof MutationPayloads): Mutation =>
	createMutation(type, {
		workoutId: W,
		entityId: type === 'set.edit' || type === 'set.delete' ? SET : undefined,
		at,
		payload: PAYLOADS[type]
	} as never) as Mutation;

const known: DescribeContext = {
	exerciseName: (id) => ({ [SQUAT]: 'Back squat', [PULL]: 'Pull-up' })[id],
	set: (id) => (id === SET ? { setIndex: 3, exerciseId: SQUAT } : undefined)
};
const forgotten: DescribeContext = { exerciseName: () => undefined, set: () => undefined };

describe('describeMutation', () => {
	it.each(MUTATION_TYPES)('words %s, with names and without', (type) => {
		for (const context of [known, forgotten]) {
			const words = describeMutation(mutationOf(type), context);
			expect(words.length).toBeGreaterThan(5);
			expect(words).not.toMatch(/undefined|null|NaN|\[object/);
		}
	});

	it('names the set, its exercise and its values', () => {
		expect(describeMutation(mutationOf('set.log'), known)).toBe('Set 3 of Back squat · 100 kg × 5');
		expect(describeMutation(mutationOf('set.edit'), known)).toBe(
			'Set 3 of Back squat · changed to 100 kg × 4'
		);
		expect(describeMutation(mutationOf('set.edit'), forgotten)).toBe(
			'A set · changed to 100 kg × 4'
		);
		expect(describeMutation(mutationOf('set.skip'), forgotten)).toBe(
			'Set 2 of an exercise · Skipped'
		);
		expect(describeMutation(mutationOf('exercise.substitute'), known)).toBe(
			'Back squat swapped for Pull-up'
		);
	});

	it('words each measure and load', () => {
		const none = { reps: null, seconds: null, metres: null, weight: null, assistance: null };
		expect(setValues({ ...none, reps: 8, unit: 'kg' })).toBe('8 reps');
		expect(setValues({ ...none, seconds: 45, unit: 'kg' })).toBe('0:45');
		expect(setValues({ ...none, metres: 400, unit: 'kg' })).toBe('400 m');
		expect(setValues({ ...none, reps: 6, assistance: 20, unit: 'lb' })).toBe(
			'6 reps · 20 lb assist'
		);
		expect(setValues({ ...none, reps: 5, weight: 102.5, unit: 'kg' })).toBe('102.5 kg × 5');
	});
});

describe('problemText', () => {
	it('words a refusal by its fields, else by its reason', () => {
		const refused = { reason: 'refused', message: 'A value is not valid' } as const;
		expect(
			problemText(
				{ ...refused, errors: { 'payload.weight': 'Up to 1000 kg', 'payload.rpe': 'RPE 1 to 10' } },
				0
			)
		).toBe('Weight: Up to 1000 kg · RPE: RPE 1 to 10');
		expect(problemText({ ...refused, errors: {}, message: 'Deleted on another device' }, 0)).toBe(
			'Deleted on another device'
		);
	});

	it('says how long a stuck change kept failing, and its last error', () => {
		const stuck = { reason: 'stuck', errors: {}, message: 'The server answered 500' } as const;
		expect(problemText(stuck, null)).toBe("Couldn't sync for a day: the server answered 500");
		expect(problemText(stuck, 50)).toBe("Couldn't sync after 50 tries: the server answered 500");
	});
});
