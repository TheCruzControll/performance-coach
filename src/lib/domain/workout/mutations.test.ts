import { describe, expect, expectTypeOf, it } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import {
	createMutation,
	entityKey,
	MUTATION_RULES,
	MUTATION_TYPES,
	unhandledMutation
} from './mutations';
import { dependsOn } from './order';
import type {
	LocalAction,
	Mutation,
	MutationOf,
	MutationPayloads,
	MutationType,
	MutationTypeFor
} from './mutations';
import type { OtherKit, RunKit, StartKit, StrengthKit } from './types';

const AT = '2026-11-06T18:00:00.000Z';
const W = '00000000-0000-4000-8000-00000000000a';
const OTHER_W = '00000000-0000-4000-8000-00000000000b';
const SQUAT = '00000000-0000-4000-8000-0000000000e1';
const LEG_PRESS = '00000000-0000-4000-8000-0000000000e2';

/** Numbered ids, so a test can tell a fresh id from one it passed in. */
function counter() {
	let n = 0;
	return () => `fresh-${++n}`;
}
const fresh = counter();

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
} as const;
const place = { position: 1, setIndex: 1, exerciseId: SQUAT, plannedLineage: null };
const slot = { position: 2, plannedLineage: null };

/** A valid payload of every type: a missing type fails pnpm check. */
const PAYLOADS: { [T in MutationType]: MutationPayloads[T] } = {
	'workout.start': {
		kind: 'strength',
		title: 'Lower body & pull',
		sessionType: 'strength',
		discipline: 'strength',
		plannedSessionId: null,
		plannedLineage: null,
		programId: null
	},
	'workout.update': { notes: 'Felt quick' },
	'workout.finish': { durationSeconds: 3900, sessionRpe: 8 },
	'workout.abandon': {},
	'set.log': { ...place, ...done },
	'set.skip': { ...place, unit: 'kg' },
	'set.edit': { ...done, reps: 4 },
	'set.delete': {},
	'exercise.skip': { ...slot, exerciseId: LEG_PRESS, unit: 'kg', sets: [] },
	'exercise.substitute': {
		...slot,
		fromExerciseId: LEG_PRESS,
		toExerciseId: SQUAT,
		reason: 'equipment_unavailable'
	},
	'exercise.dislike': { ...slot, fromExerciseId: LEG_PRESS, toExerciseId: SQUAT, note: null },
	'exercise.create': {
		name: 'Sandbag shouldering',
		aliases: [],
		pattern: 'carry',
		primaryMuscles: ['glutes'],
		secondaryMuscles: [],
		equipment: [],
		substitutionGroup: null,
		skillLevel: 'beginner',
		repMin: 3,
		repMax: 8,
		defaultSeconds: null,
		unilateral: false,
		measure: 'reps',
		loadType: 'external',
		tags: [],
		disciplines: []
	},
	'pain.report': {
		...slot,
		exerciseId: LEG_PRESS,
		area: 'knee',
		severity: 'mild',
		action: 'stopped',
		substitutionId: null,
		note: null
	},
	'run.log': { distanceMetres: 5000 },
	'run.segment': {
		position: 1,
		kind: 'warm_up',
		distanceMetres: null,
		durationSeconds: 600,
		avgHr: null,
		rpe: null
	},
	'other.log': { kind: 'class', durationMinutes: 90, rpe: 7, metrics: [], notes: null }
};

/** A mutation of `type` for workout W: an edit addresses `entityId`, a create makes its own. */
function make<T extends MutationType>(
	type: T,
	options: { entityId?: string; workoutId?: string; payload?: MutationPayloads[T] } = {}
): MutationOf<T> {
	const { identity } = MUTATION_RULES[type];
	const needsTarget = identity === 'edit' && MUTATION_RULES[type].entity !== 'workout';
	return createMutation(
		type,
		{
			workoutId: options.workoutId ?? W,
			entityId: options.entityId ?? (needsTarget ? 'some-row' : undefined),
			at: AT,
			payload: options.payload ?? PAYLOADS[type]
		},
		fresh
	);
}

const start = (workoutId = W) => make('workout.start', { workoutId });

describe('wire format v1', () => {
	it('has 16 mutation types, each with its kinds, an entity key and a dependency rule', () => {
		expect(MUTATION_TYPES).toEqual([
			'workout.start',
			'workout.update',
			'workout.finish',
			'workout.abandon',
			'set.log',
			'set.skip',
			'set.edit',
			'set.delete',
			'exercise.skip',
			'exercise.substitute',
			'exercise.dislike',
			'exercise.create',
			'pain.report',
			'run.log',
			'run.segment',
			'other.log'
		]);
		for (const type of MUTATION_TYPES) {
			const { kinds, entity } = MUTATION_RULES[type];
			expect(kinds.length, type).toBeGreaterThan(0);
			for (const kind of kinds) expect(['strength', 'run', 'other']).toContain(kind);
			const m = make(type);
			expect(m).toMatchObject({ v: 1, type, workoutId: W, at: AT });
			expect(entityKey(m), type).toMatch(new RegExp(`^${entity}:.+`));
			expect(dependsOn(m, start()), type).toBe(type !== 'workout.start');
		}
	});

	it('tags each type with the kinds of workout it belongs to', () => {
		const kindsOf = (kind: 'strength' | 'run' | 'other') =>
			MUTATION_TYPES.filter((type) =>
				(MUTATION_RULES[type].kinds as readonly string[]).includes(kind)
			);
		const workout = ['workout.start', 'workout.update', 'workout.finish', 'workout.abandon'];
		expect(kindsOf('run')).toEqual([...workout, 'run.log', 'run.segment']);
		expect(kindsOf('other')).toEqual([...workout, 'other.log']);
		expect(kindsOf('strength')).toEqual(
			MUTATION_TYPES.filter((t) => !t.startsWith('run.') && t !== 'other.log')
		);
	});

	it('names each entity by its client id, and 1:1 records and slots by their workout', () => {
		expect(entityKey(start())).toBe(`workout:${W}`);
		expect(entityKey(make('workout.finish'))).toBe(`workout:${W}`);
		expect(entityKey(make('set.log', { entityId: 's1' }))).toBe('set:s1');
		expect(entityKey(make('set.delete', { entityId: 's1' }))).toBe('set:s1');
		expect(entityKey(make('run.segment', { entityId: 'g1' }))).toBe('segment:g1');
		expect(entityKey(make('run.log'))).toBe(`run:${W}`);
		expect(entityKey(make('other.log'))).toBe(`other:${W}`);
		expect(entityKey(make('exercise.skip'))).toBe(`slot:${W}:2`);
		expect(entityKey(make('exercise.substitute'))).toBe(`slot:${W}:2`);
		expect(entityKey(make('pain.report'))).toBe(`slot:${W}:2`);
		expect(entityKey(make('exercise.create', { entityId: 'x1' }))).toBe('exercise:x1');
	});
});

describe('the identity rule', () => {
	it("gives a create its new row's client id as its own, and an edit a fresh id", () => {
		const creates = MUTATION_TYPES.filter((t) => MUTATION_RULES[t].identity === 'create');
		expect(creates).toEqual([
			'workout.start',
			'set.log',
			'set.skip',
			'exercise.substitute',
			'exercise.dislike',
			'exercise.create',
			'pain.report'
		]);
		for (const type of creates) {
			const made = make(type);
			expect(made.id, type).toBe(made.entityId);
			if (type === 'workout.start') continue;
			const named = make(type, { entityId: 'row-1' });
			expect(named, type).toMatchObject({ id: 'row-1', entityId: 'row-1' });
		}
		for (const type of MUTATION_TYPES.filter((t) => !creates.includes(t) && t !== 'run.segment')) {
			const m = make(type);
			expect(m.id, type).toMatch(/^fresh-/);
			expect(m.id, type).not.toBe(m.entityId);
		}
	});

	it("starts a workout under the workout's own id, which nothing else takes", () => {
		expect(start()).toMatchObject({ id: W, entityId: W, workoutId: W });
		const payload = PAYLOADS['workout.start'];
		expect(() =>
			createMutation('workout.start', { workoutId: W, entityId: 'row-1', at: AT, payload })
		).toThrow(RangeError);
		expect(() => make('run.log', { entityId: 'row-1' })).toThrow(RangeError);
	});

	it('addresses the row an edit, a delete, a finish or an abandon changes', () => {
		expect(make('set.edit', { entityId: 's1' })).toMatchObject({ entityId: 's1' });
		expect(make('set.delete', { entityId: 's1' })).toMatchObject({ entityId: 's1' });
		expect(make('workout.finish')).toMatchObject({ entityId: W });
		expect(make('workout.abandon')).toMatchObject({ entityId: W });
		expect(() =>
			createMutation('set.edit', { workoutId: W, at: AT, payload: PAYLOADS['set.edit'] })
		).toThrow(RangeError);
	});

	it('creates a segment with its first run.segment and edits it with every later one', () => {
		const first = make('run.segment');
		expect(first.id).toBe(first.entityId);
		const later = make('run.segment', { entityId: first.entityId });
		expect(later.entityId).toBe(first.entityId);
		expect(later.id).not.toBe(first.id);
		expect(later.id).not.toBe(later.entityId);
		expect(entityKey(later)).toBe(entityKey(first));
		expect(dependsOn(later, first)).toBe(true);
		expect(dependsOn(first, later)).toBe(false);
	});

	it("never gives run.log or other.log their workout's id, which is workout.start's", () => {
		for (const type of ['run.log', 'other.log'] as const) {
			const first = make(type);
			const second = make(type);
			expect(first.entityId).toBe(W);
			expect(first.id).not.toBe(W);
			expect(second.id).not.toBe(first.id);
			expect(entityKey(first)).toBe(`${type.split('.')[0]}:${W}`);
			expect(entityKey(second)).toBe(entityKey(first));
			expect(dependsOn(second, first)).toBe(true);
		}
		expect(dependsOn(make('run.log'), make('other.log'))).toBe(false);
	});
});

describe('dependencies', () => {
	const log = (id: string) => make('set.log', { entityId: id });
	const skip = (id: string) => make('set.skip', { entityId: id });

	it("makes set.edit and set.delete depend on their own set's log or skip, never on another set", () => {
		for (const type of ['set.edit', 'set.delete'] as const) {
			const change = make(type, { entityId: 's1' });
			expect(dependsOn(change, log('s1')), type).toBe(true);
			expect(dependsOn(change, skip('s1')), type).toBe(true);
			expect(dependsOn(change, log('s2')), type).toBe(false);
			expect(dependsOn(change, make('set.edit', { entityId: 's2' })), type).toBe(false);
		}
		expect(
			dependsOn(make('set.delete', { entityId: 's1' }), make('set.edit', { entityId: 's1' }))
		).toBe(true);
		expect(dependsOn(log('s1'), make('set.edit', { entityId: 's1' }))).toBe(false);
		expect(dependsOn(log('s2'), log('s1'))).toBe(false);
	});

	it("makes every mutation depend on its workout's start, and on no other workout's", () => {
		for (const type of MUTATION_TYPES.filter((t) => t !== 'workout.start')) {
			expect(dependsOn(make(type), start(W)), type).toBe(true);
			expect(dependsOn(make(type), start(OTHER_W)), type).toBe(false);
		}
		expect(dependsOn(start(W), start(W))).toBe(false);
		expect(dependsOn(start(W), make('workout.update'))).toBe(false);
		expect(dependsOn(make('workout.finish'), make('workout.update'))).toBe(true);
	});

	it('makes a mutation naming a custom exercise still in the outbox depend on its exercise.create', () => {
		const custom = make('exercise.create', { entityId: 'x1', workoutId: OTHER_W });
		const naming: Mutation[] = [
			make('set.log', { payload: { ...PAYLOADS['set.log'], exerciseId: 'x1' } }),
			make('set.skip', { payload: { ...PAYLOADS['set.skip'], exerciseId: 'x1' } }),
			make('exercise.skip', { payload: { ...PAYLOADS['exercise.skip'], exerciseId: 'x1' } }),
			make('exercise.substitute', {
				payload: { ...PAYLOADS['exercise.substitute'], toExerciseId: 'x1' }
			}),
			make('exercise.dislike', {
				payload: { ...PAYLOADS['exercise.dislike'], fromExerciseId: 'x1' }
			}),
			make('pain.report', { payload: { ...PAYLOADS['pain.report'], exerciseId: 'x1' } })
		];
		for (const m of naming) expect(dependsOn(m, custom), m.type).toBe(true);
		expect(dependsOn(make('set.log'), custom)).toBe(false);
		expect(dependsOn(make('exercise.create', { entityId: 'x2' }), custom)).toBe(false);
	});

	it('makes the sets an exercise.skip writes, and its slot, depend on it', () => {
		const skipped = make('exercise.skip', {
			payload: {
				...PAYLOADS['exercise.skip'],
				sets: [
					{ id: 'k1', setIndex: 2 },
					{ id: 'k2', setIndex: 3 }
				]
			}
		});
		expect(dependsOn(make('set.delete', { entityId: 'k2' }), skipped)).toBe(true);
		expect(dependsOn(make('set.delete', { entityId: 's9' }), skipped)).toBe(false);
		expect(dependsOn(make('exercise.substitute'), skipped)).toBe(true);
		const elsewhere = { ...PAYLOADS['exercise.substitute'], position: 3 };
		expect(dependsOn(make('exercise.substitute', { payload: elsewhere }), skipped)).toBe(false);
	});

	it('makes a pain report depend on the substitution it chose', () => {
		const gentler = make('exercise.substitute', {
			payload: { ...PAYLOADS['exercise.substitute'], position: 5, reason: 'pain' }
		});
		const report = make('pain.report', {
			payload: { ...PAYLOADS['pain.report'], action: 'substituted', substitutionId: gentler.id }
		});
		expect(dependsOn(report, gentler)).toBe(true);
		expect(dependsOn(make('pain.report'), gentler)).toBe(false);
	});
});

describe('types', () => {
	it('keeps local actions out of the mutation types, and every switch exhaustive', () => {
		expectTypeOf<LocalAction['type'] & MutationType>().toBeNever();
		// @ts-expect-error: a device action is never a mutation type
		const _goTo: MutationType = 'goTo';
		// @ts-expect-error: nor is the rest timer
		const _rest: Mutation['type'] = 'rest.start';
		expectTypeOf<MutationTypeFor<'run'>>().toEqualTypeOf<
			| 'workout.start'
			| 'workout.update'
			| 'workout.finish'
			| 'workout.abandon'
			| 'run.log'
			| 'run.segment'
		>();

		function family(m: Mutation): string {
			switch (m.type) {
				case 'workout.start':
				case 'workout.update':
				case 'workout.finish':
				case 'workout.abandon':
					return 'workout';
				case 'set.log':
				case 'set.skip':
				case 'set.edit':
				case 'set.delete':
					return 'sets';
				case 'exercise.skip':
				case 'exercise.substitute':
				case 'exercise.dislike':
				case 'pain.report':
					return 'structure';
				case 'exercise.create':
					return 'exercises';
				case 'run.log':
				case 'run.segment':
					return 'run';
				default:
					// @ts-expect-error: other.log is not handled, so `m` is not never
					return unhandledMutation(m);
			}
		}
		expect(family(make('set.edit', { entityId: 's1' }))).toBe('sets');
		expect(() => family(make('other.log'))).toThrow(/other\.log/);
	});

	it('types the shared workout-day fixture as start kits, one per kind', () => {
		const kits = workoutDayKits({ date: '2026-11-06' });
		expectTypeOf(kits.strength).toEqualTypeOf<StrengthKit>();
		expectTypeOf(kits.run).toEqualTypeOf<RunKit>();
		expectTypeOf(kits.other).toEqualTypeOf<OtherKit>();
		const all: StartKit[] = [kits.strength, kits.run, kits.other];
		expect(all.map((kit) => kit.kind)).toEqual(['strength', 'run', 'other']);
	});
});

describe('the workout-day fixture', () => {
	const kits = workoutDayKits({ date: '2026-11-06', exerciseId: (key) => `id:${key}` });

	it('holds the strength session, with the A1/A2 superset last and last time on back squat', () => {
		const exercises = kits.strength.exercises;
		expect(exercises.map((e) => [e.position, e.exercise.key, e.superset, e.sets.length])).toEqual([
			[1, 'back_squat', null, 4],
			[2, 'leg_press', null, 3],
			[3, 'romanian_deadlift', null, 3],
			[4, 'pull_up', 1, 3],
			[5, 'plank', 1, 3]
		]);
		expect(exercises.map((e) => e.exercise.id)).toEqual(
			exercises.map((e) => `id:${e.exercise.key}`)
		);
		expect(exercises[0]!.previous?.date).toBe('2026-10-30');
		expect(exercises[0]!.bestE1rm).toEqual({ kg: 125, estimated: true });
		expect(exercises.slice(1).every((e) => e.previous === null)).toBe(true);
		expect(exercises[3]!.sets.map((s) => s.restSeconds)).toEqual([0, 0, 0]);
		expect(exercises[4]!.sets.map((s) => s.restSeconds)).toEqual([90, 90, 90]);
	});

	it('expands the interval run to 14 segments and gives the class its metrics', () => {
		const steps = kits.run.run.segments.reduce((sum, s) => sum + (s.repeats ?? 1), 0);
		expect(steps).toBe(14);
		expect(kits.other.other).toMatchObject({ kind: 'class', durationMinutes: 90 });
		expect(kits.other.other.metrics.map((m) => m.key)).toEqual(['rounds', 'sparred']);
	});
});
