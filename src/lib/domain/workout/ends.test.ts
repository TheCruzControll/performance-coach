/**
 * The device reducer ends a workout exactly as the server's finishWorkout does (owner decision
 * D1): from every state, a finish or an abandon moves the rows where canEnd allows, and leaves
 * them as they are where it refuses, so a late end replayed from the outbox or the server's rows
 * never un-finishes a completed workout.
 */
import { describe, expect, it } from 'vitest';
import { canEnd, END_FROM } from './ends.ts';
import type { WorkoutEvent } from './ends.ts';
import { WORKOUT, WORKOUT_STATES } from './lifecycles.ts';
import { createMutation } from './mutations.ts';
import type { Mutation } from './mutations.ts';
import { applyMutation, replay } from './project.ts';
import type { CanonicalWorkout } from './protocol.ts';
import { strengthTable } from './reducers/tables.ts';
import type { WorkoutStatus } from './types.ts';

const W = '00000000-0000-4000-8000-0000000000e1';
let ids = 0;
const fresh = () => `end-${++ids}`;
const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 7, minute)).toISOString();

const start = () =>
	createMutation(
		'workout.start',
		{
			workoutId: W,
			entityId: W,
			at: at(0),
			payload: {
				kind: 'strength',
				title: 'Lower body',
				sessionType: 'strength',
				discipline: 'strength',
				plannedSessionId: null,
				plannedLineage: null,
				programId: null
			}
		},
		fresh
	);

/** The event's mutation at `minute`: a finish carries summary values, an abandon none. */
const endOf = (event: WorkoutEvent, minute: number) =>
	event === 'finish'
		? createMutation(
				'workout.finish',
				{ workoutId: W, at: at(minute), payload: { durationSeconds: 3300, sessionRpe: 7 } },
				fresh
			)
		: createMutation('workout.abandon', { workoutId: W, at: at(minute), payload: {} }, fresh);

/** How the canonical rows come to be in `state`: a start, then the end that leads there. */
const reaching: Record<WorkoutStatus, () => Mutation[]> = {
	in_progress: () => [start()],
	completed: () => [start(), endOf('finish', 30)],
	abandoned: () => [start(), endOf('abandon', 30)]
};

/** The canonical rows of a workout in `state`, as the server's rows reach the device. */
const rowsIn = (state: WorkoutStatus) => {
	const rows = replay(strengthTable, {
		workoutId: W,
		kit: null,
		canonical: null,
		pending: reaching[state]()
	}).rows!;
	expect(rows.workout.status).toBe(state);
	return rows;
};

describe('the device reducer', () => {
	it('the device reducer ends a workout only as canEnd allows', () => {
		const events = Object.keys(END_FROM) as WorkoutEvent[];
		for (const state of WORKOUT_STATES) {
			for (const event of events) {
				const rows = rowsIn(state);
				const m = endOf(event, 55);
				const replayed = replay(strengthTable, {
					workoutId: W,
					kit: null,
					canonical: rows,
					pending: []
				});
				const ended = applyMutation(strengthTable, replayed, m).rows!;
				const label = `${event} from ${state}`;

				if (canEnd(state, event)) {
					expect(ended.workout.status, label).toBe(WORKOUT.on[event].to);
					expect(ended.workout.finishedAt, label).toBe(m.at);
				} else {
					expect(ended.workout.status, label).toBe(state);
					expect(ended, label).toBe(rows);
				}
			}
		}
	});

	it('a finish replayed over the rows it completed sets its values again', () => {
		const update = createMutation(
			'workout.update',
			{ workoutId: W, at: at(20), payload: { sessionRpe: 5 } },
			fresh
		);
		const finish = endOf('finish', 30);
		const sequence = [start(), update, finish];
		const fold = (canonical: CanonicalWorkout | null, pending: Mutation[]) =>
			replay(strengthTable, { workoutId: W, kit: null, canonical, pending }).rows!;
		const server = fold(null, sequence);

		// The server applied all three; their answer is not stored yet, so the outbox still holds them.
		const overlapping = fold(server, sequence);

		expect(server.workout).toMatchObject({ status: 'completed', sessionRpe: 7 });
		expect(overlapping).toStrictEqual(server);
	});
});
