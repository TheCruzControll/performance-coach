import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { createMutation } from './mutations';
import type { LocalAction, Mutation, MutationInput, MutationOf, MutationType } from './mutations';
import { applyLocal, project, replay, viewOf } from './project';
import { otherTable, strengthTable } from './reducers/tables';
import {
	currentExercise,
	nextExercise,
	pairBySetIndex,
	plannedVsLogged,
	previousFor,
	progress,
	setsFor
} from './selectors';
import type { KitExerciseMeta, LoggedSet, WorkoutView } from './types';

const KITS = workoutDayKits({ date: '2026-11-06' });
const KIT = KITS.strength;
const W = '00000000-0000-4000-8000-0000000000b1';
const idAt = (position: number) => KIT.exercises[position - 1]!.exercise.id;
const [SQUAT, LEG_PRESS, RDL, PULL_UP, PLANK] = [1, 2, 3, 4, 5].map(idAt) as [
	string,
	string,
	string,
	string,
	string
];

/** A device action of this test's workout. */
type Action = LocalAction extends infer A
	? A extends unknown
		? Omit<A, 'workoutId'>
		: never
	: never;

let ids = 0;
const fresh = () => `fresh-${++ids}`;
const at = (second: number) => new Date(Date.UTC(2026, 10, 6, 18, 0, second)).toISOString();

const make = <T extends MutationType>(type: T, input: Omit<MutationInput<T>, 'workoutId' | 'at'>) =>
	createMutation(type, { workoutId: W, at: at(ids), ...input }, fresh);

const START = make('workout.start', {
	entityId: W,
	payload: {
		kind: 'strength',
		title: KIT.title,
		sessionType: KIT.sessionType,
		discipline: KIT.discipline,
		plannedSessionId: KIT.plannedSessionId,
		plannedLineage: KIT.plannedLineage,
		programId: KIT.programId
	}
});

const values: LoggedSet = {
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
};

function log(id: string, position: number, setIndex: number, extra: Partial<LoggedSet> = {}) {
	const slot = KIT.exercises[position - 1]!;
	return make('set.log', {
		entityId: id,
		payload: {
			position,
			plannedLineage: slot.plannedLineage,
			setIndex,
			exerciseId: slot.exercise.id,
			...values,
			...extra
		}
	});
}

function skip(id: string, position: number, setIndex: number): MutationOf<'set.skip'> {
	const slot = KIT.exercises[position - 1]!;
	return make('set.skip', {
		entityId: id,
		payload: {
			position,
			plannedLineage: slot.plannedLineage,
			setIndex,
			exerciseId: slot.exercise.id,
			unit: 'kg'
		}
	});
}

const view = (pending: Mutation[], ...actions: Action[]): WorkoutView => {
	const state = actions.reduce(
		(s, a) => applyLocal(strengthTable, s, { workoutId: W, ...a } as LocalAction),
		replay(strengthTable, { workoutId: W, kit: KIT, canonical: null, pending })
	);
	return viewOf(strengthTable, state)!;
};

const KEG: KitExerciseMeta = {
	id: 'x1',
	key: null,
	name: 'Keg carry',
	measure: 'distance',
	loadType: 'external',
	unilateral: false,
	pattern: 'carry',
	tags: [],
	restClass: 'compound',
	increment: 2.5
};

describe('setsFor', () => {
	it("gives a slot's live sets in order, and none for a position with no slot", () => {
		const v = view([
			START,
			log('b', 1, 2),
			log('a', 1, 1),
			log('gone', 1, 3),
			make('set.delete', { entityId: 'gone', payload: {} }),
			log('lp', 2, 1)
		]);
		expect(setsFor(v, 1).map((s) => s.id)).toEqual(['a', 'b']);
		expect(setsFor(v, 2).map((s) => s.id)).toEqual(['lp']);
		expect(setsFor(v, 9)).toEqual([]);
	});
});

describe('currentExercise and nextExercise', () => {
	it('follow the position on screen, in position order', () => {
		const first = view([START]);
		expect(currentExercise(first)?.exerciseId).toBe(SQUAT);
		expect(nextExercise(first)?.exerciseId).toBe(LEG_PRESS);

		const fourth = view([START], { type: 'goTo', position: 4 });
		expect(currentExercise(fourth)?.exerciseId).toBe(PULL_UP);
		expect(nextExercise(fourth)?.exerciseId).toBe(PLANK);

		const last = view([START], { type: 'goTo', position: 5 });
		expect(nextExercise(last)).toBeNull();
		const added = view(
			[START],
			{ type: 'goTo', position: 5 },
			{ type: 'exercise.add', exercise: { position: 6, exercise: KEG, addedAt: at(1) } }
		);
		expect(nextExercise(added)?.exerciseId).toBe('x1');
	});

	it('fall back to the first slot when the position has none, and to null with no slots', () => {
		const lost = view([START], { type: 'goTo', position: 42 });
		expect(currentExercise(lost)?.exerciseId).toBe(SQUAT);
		expect(nextExercise(lost)?.exerciseId).toBe(LEG_PRESS);

		const other = KITS.other;
		const session = project(otherTable, {
			workoutId: W,
			kit: other,
			canonical: null,
			pending: [
				createMutation('workout.start', {
					workoutId: W,
					at: at(0),
					payload: {
						kind: 'other',
						title: other.title,
						sessionType: other.sessionType,
						discipline: other.discipline,
						plannedSessionId: other.plannedSessionId,
						plannedLineage: other.plannedLineage,
						programId: other.programId
					}
				})
			]
		})!;
		expect(session.slots).toEqual([]);
		expect(currentExercise(session)).toBeNull();
		expect(nextExercise(session)).toBeNull();
	});
});

describe('previousFor', () => {
	it("gives the kit's previous sets for a planned exercise, and the attached ones when present", () => {
		const v = view([START]);
		expect(previousFor(v, 1)).toBe(KIT.exercises[0]!.previous);
		expect(previousFor(v, 2)).toBeNull();
		expect(previousFor(v, 9)).toBeNull();

		const fresher = { date: '2026-11-05', sets: [{ ...values, reps: 3, weight: 110 }] };
		const attached = view([START], { type: 'kit.attach', exerciseId: SQUAT, previous: fresher });
		expect(previousFor(attached, 1)).toBe(fresher);
		const none = view([START], { type: 'kit.attach', exerciseId: SQUAT, previous: null });
		expect(previousFor(none, 1)).toBeNull();
	});

	it("never gives one exercise's previous sets to another performed in its slot", () => {
		const elsewhere = view([
			START,
			make('set.log', {
				entityId: 'q1',
				payload: { position: 7, plannedLineage: null, setIndex: 1, exerciseId: SQUAT, ...values }
			})
		]);
		expect(previousFor(elsewhere, 7)).toBeNull();
	});
});

describe('progress', () => {
	it('counts planned sets done, logged or skipped, and exercises with nothing left', () => {
		expect(progress(view([START]))).toStrictEqual({
			sets: { planned: 16, done: 0 },
			exercises: { total: 5, done: 0 }
		});
		const v = view(
			[
				START,
				log('s1', 1, 1),
				log('s2', 1, 2),
				skip('s3', 1, 3),
				log('s4', 1, 4),
				log('s5', 1, 5, { isExtra: true }),
				log('l1', 2, 1),
				log('k1', 3, 1),
				log('k2', 3, 2),
				log('k3', 3, 3),
				log('k4', 3, 4, { isExtra: true })
			],
			{ type: 'exercise.add', exercise: { position: 6, exercise: KEG, addedAt: at(1) } }
		);
		expect(progress(v)).toStrictEqual({
			sets: { planned: 16, done: 8 },
			exercises: { total: 6, done: 2 }
		});
		const kegLogged = view(
			[
				START,
				make('set.log', {
					entityId: 'c1',
					payload: { position: 6, plannedLineage: null, setIndex: 1, exerciseId: 'x1', ...values }
				})
			],
			{ type: 'exercise.add', exercise: { position: 6, exercise: KEG, addedAt: at(1) } }
		);
		expect(progress(kegLogged).exercises).toStrictEqual({ total: 6, done: 1 });
	});
});

describe('plannedVsLogged', () => {
	it('pairs each planned set with the set logged at its index, then lists the rest', () => {
		const v = view([
			START,
			log('s2', 1, 2, { reps: 4 }),
			log('s1', 1, 1),
			log('s5', 1, 5, { isExtra: true })
		]);
		const rows = plannedVsLogged(v, 1);
		expect(rows.map((r) => [r.setIndex, r.planned?.line ?? null, r.logged?.id ?? null])).toEqual([
			[1, 'Work up to a set of 5 @ RPE 7', 's1'],
			[2, '3 × 5', 's2'],
			[3, '3 × 5', null],
			[4, '3 × 5', null],
			[5, null, 's5']
		]);
		expect(rows[1]!.planned).toBe(KIT.exercises[0]!.sets[1]);
	});

	it('keeps a second set at one index, as two devices may log, after the first', () => {
		const v = view([START, log('b', 2, 1, { reps: 9 }), log('a', 2, 1, { reps: 10 })]);
		expect(
			plannedVsLogged(v, 2).map((r) => [r.setIndex, !!r.planned, r.logged?.id ?? null])
		).toEqual([
			[1, true, 'a'],
			[1, false, 'b'],
			[2, true, null],
			[3, true, null]
		]);
		expect(plannedVsLogged(v, 9)).toEqual([]);
		expect(plannedVsLogged(view([START]), 3).map((r) => r.planned)).toEqual(
			KIT.exercises.find((e) => e.exercise.id === RDL)!.sets
		);
	});
});

describe('pairBySetIndex', () => {
	it('numbers any planned list from 1 and gives each index to the first set logged at it', () => {
		const logged = [
			{ setIndex: 2, id: 'x' },
			{ setIndex: 1, id: 'y' },
			{ setIndex: 1, id: 'z' },
			{ setIndex: 4, id: 'w' }
		];
		const rows = pairBySetIndex(['a', 'b', 'c'], logged);
		expect(rows.map((r) => [r.setIndex, r.planned, r.logged?.id ?? null])).toEqual([
			[1, 'a', 'y'],
			[1, null, 'z'],
			[2, 'b', 'x'],
			[3, 'c', null],
			[4, null, 'w']
		]);
		expect(pairBySetIndex([], [])).toEqual([]);
	});
});
