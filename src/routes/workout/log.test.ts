import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../tests/fixtures/workout-day';
import type { LoggedSet, Mutation, WorkoutView } from '#lib/domain/workout/index.ts';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import { applyLocal, applyMutation, replay, viewOf } from '#lib/domain/workout/project.ts';
import type { WorkoutState } from '#lib/domain/workout/project.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import { DEFAULT_REST_SECONDS } from '#lib/domain/workout/timers.ts';
import { logSet, skipSet, type RestOptions } from './log.ts';

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
function log(
	state: WorkoutState,
	position: number,
	setIndex: number,
	values: LoggedSet,
	rest: RestOptions | null = null
) {
	const view = viewOf(strengthTable, state)!;
	const done = logSet(view, position, setIndex, values, AT, rest);
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

	describe('the rest a completed set starts', () => {
		const AUTO: RestOptions = { autoStart: true, defaults: DEFAULT_REST_SECONDS };
		const restStart = (ms: number) => ({
			workoutId: W,
			type: 'rest.start',
			at: Date.parse(AT),
			durationMs: ms
		});

		it('starts the prescribed rest after a straight set, at the set’s instant', () => {
			// The leg press prescribes 2:00 a set.
			const { done, view } = log(started(), 2, 1, reps(10, 120), AUTO);
			expect(done.followUps).toEqual([restStart(120_000)]);
			expect(view.device.rest).toEqual({
				startedAt: Date.parse(AT),
				durationMs: 120_000,
				pausedAt: null,
				addedMs: 0
			});
		});

		it('in a superset, none inside a round; the round’s 1:30 after its last member', () => {
			const state = applyLocal(strengthTable, started(), {
				type: 'goTo',
				workoutId: W,
				position: 4
			});
			const a1 = log(state, 4, 1, reps(8), AUTO);
			expect(a1.done.followUps).toEqual([goTo(5)]);
			expect(a1.view.device.rest).toBeNull();
			const a2 = log(a1.state, 5, 1, seconds(45), AUTO);
			expect(a2.done.followUps).toEqual([goTo(4), restStart(90_000)]);
			expect(a2.view.device.position).toBe(4);
			expect(a2.view.device.rest?.durationMs).toBe(90_000);
		});

		it('starts none when the device’s settings leave the rest to the owner, or without them', () => {
			const off = log(started(), 2, 1, reps(10, 120), { ...AUTO, autoStart: false });
			expect(off.done.followUps).toEqual([]);
			expect(off.view.device.rest).toBeNull();
			expect(log(started(), 2, 1, reps(10, 120)).done.followUps).toEqual([]);
		});

		it('falls back to the device’s rest for the class when the prescription names none', () => {
			const kit = structuredClone(KIT);
			for (const set of kit.exercises[1]!.sets) set.restSeconds = null;
			const state = { ...started(), kit };
			const { done } = log(state, 2, 1, reps(10, 120), {
				autoStart: true,
				defaults: { ...DEFAULT_REST_SECONDS, [kit.exercises[1]!.exercise.restClass]: 75 }
			});
			expect(done.followUps).toEqual([restStart(75_000)]);
		});
	});

	it('refuses a position with no exercise', () => {
		expect(() => logSet(viewOf(strengthTable, started())!, 9, 1, reps(5), AT)).toThrow(RangeError);
	});
});

describe('skipSet', () => {
	/** Skips through skipSet and applies what it dispatches, as the store does. */
	function skip(state: WorkoutState, position: number, setIndex: number) {
		const done = skipSet(viewOf(strengthTable, state)!, position, setIndex, 'kg', AT);
		let next = applyMutation(strengthTable, state, done.mutation);
		for (const action of done.followUps) next = applyLocal(strengthTable, next, action);
		return { done, state: next, view: viewOf(strengthTable, next) as WorkoutView };
	}

	it('sends a set.skip under its own client id, where the set sits, in the unit', () => {
		const { done, view } = skip(started(), 2, 1);
		const m = done.mutation as Extract<Mutation, { type: 'set.skip' }>;
		expect(m.type).toBe('set.skip');
		expect(m.id).toBe(m.entityId);
		expect(m.payload).toEqual({
			position: 2,
			plannedLineage: KIT.exercises[1]!.plannedLineage,
			setIndex: 1,
			exerciseId: KIT.exercises[1]!.exercise.id,
			unit: 'kg'
		});
		expect(done.followUps).toEqual([]);
		expect(view.slots[1]!.sets).toMatchObject([{ setIndex: 1, isSkipped: true, reps: null }]);
	});

	it('advances a superset like a logged set: A1 set 1 skipped → A2', () => {
		const state = applyLocal(strengthTable, started(), { type: 'goTo', workoutId: W, position: 4 });
		const a1 = skip(state, 4, 1);
		expect(a1.done.followUps).toEqual([goTo(5)]);
		expect(a1.view.device.position).toBe(5);
	});
});
