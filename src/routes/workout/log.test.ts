import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../tests/fixtures/workout-day';
import type { LoggedSet, Mutation, WorkoutView } from '#lib/domain/workout/index.ts';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import { applyLocal, applyMutation, replay, viewOf } from '#lib/domain/workout/project.ts';
import type { WorkoutState } from '#lib/domain/workout/project.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { logSet } from './log.ts';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const W = '00000000-0000-4000-8000-0000000000f1';
const AT = '2026-11-06T18:00:00.000Z';

const reps = (n: number, weight: number | null = null): LoggedSet => ({
	reps: n,
	seconds: null,
	metres: null,
	weight,
	assistance: null,
	unit: 'kg',
	rpe: 8,
	missedReps: 0,
	isWarmup: false,
	isExtra: false
});
const seconds = (n: number): LoggedSet => ({ ...reps(0), reps: null, seconds: n, rpe: null });

function started(): WorkoutState {
	const start = createMutation('workout.start', {
		workoutId: W,
		entityId: W,
		at: AT,
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
	return replay(strengthTable, { workoutId: W, kit: KIT, canonical: null, pending: [start] });
}

/** Logs through logSet and applies what it dispatches, as the store does. */
function log(state: WorkoutState, position: number, setIndex: number, values: LoggedSet) {
	const view = viewOf(strengthTable, state)!;
	const done = logSet(view, position, setIndex, values, AT);
	let next = applyMutation(strengthTable, state, done.mutation);
	for (const action of done.followUps) next = applyLocal(strengthTable, next, action);
	return { done, state: next, view: viewOf(strengthTable, next) as WorkoutView };
}

const goTo = (position: number) => ({ workoutId: W, position, type: 'goTo' });

describe('logSet', () => {
	it('sends a set.log under its own client id, where the set sits, with its values', () => {
		const { done } = log(started(), 1, 1, reps(5, 100));
		const m = done.mutation as Extract<Mutation, { type: 'set.log' }>;
		expect(m.type).toBe('set.log');
		expect(m.id).toBe(m.entityId);
		expect(m).toMatchObject({ workoutId: W, at: AT, v: 1 });
		expect(m.payload).toEqual({
			position: 1,
			plannedLineage: KIT.exercises[0]!.plannedLineage,
			setIndex: 1,
			exerciseId: KIT.exercises[0]!.exercise.id,
			...reps(5, 100)
		});
	});

	it('stays on a straight exercise, through its last set', () => {
		let state = started();
		for (const setIndex of [1, 2, 3, 4]) {
			const step = log(state, 1, setIndex, reps(5, 100));
			expect(step.done.followUps).toEqual([]);
			state = step.state;
		}
	});

	it('alternates a superset: A1 set 1 → A2, A2 set 1 → A1 set 2', () => {
		let state = applyLocal(strengthTable, started(), { type: 'goTo', workoutId: W, position: 4 });
		const a1 = log(state, 4, 1, reps(8));
		expect(a1.done.followUps).toEqual([goTo(5)]);
		expect(a1.view.device.position).toBe(5);
		state = a1.state;
		const a2 = log(state, 5, 1, seconds(45));
		expect(a2.done.followUps).toEqual([goTo(4)]);
		expect(a2.view.device.position).toBe(4);
		expect(a2.view.slots[3]!.sets.map((s) => s.setIndex)).toEqual([1]);
	});

	it('refuses a position with no exercise', () => {
		expect(() => logSet(viewOf(strengthTable, started())!, 9, 1, reps(5), AT)).toThrow(RangeError);
	});
});
