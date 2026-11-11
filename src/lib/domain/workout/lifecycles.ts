/**
 * The workout lifecycle (owner decision D1): a workout starts in progress and ends completed or
 * abandoned; an abandoned workout may still be completed (completion wins across devices), and
 * a completed one never changes again. docs/lifecycles.md is generated from this table.
 *
 * The device reducer loads only ./ends.ts (the same from-lists, without these strings).
 */
import { defineLifecycle } from '../lifecycle.ts';
import { END_FROM } from './ends.ts';
import type { WorkoutEvent } from './ends.ts';
import type { WorkoutStatus } from './types.ts';

/** Every workout status, in lifecycle order: the training log's WORKOUT_STATUSES. */
export const WORKOUT_STATES = [
	'in_progress',
	'completed',
	'abandoned'
] as const satisfies readonly WorkoutStatus[];

export const WORKOUT = /* @__PURE__ */ defineLifecycle<WorkoutStatus, WorkoutEvent>({
	id: 'workout',
	storedIn: 'workouts.status (Postgres) and the device record (IndexedDB pc-offline)',
	writeSites: [
		'src/lib/server/services/training/log.ts finishWorkout',
		'src/lib/domain/workout/reducers/core.ts'
	],
	tests: [],
	states: WORKOUT_STATES,
	initial: ['in_progress'],
	terminal: ['completed'],
	on: {
		finish: {
			from: END_FROM.finish,
			to: 'completed',
			effects: [
				'workouts: status, finished_at and summary fields',
				'audit row',
				'planned session counts as done',
				'enters History and analytics'
			],
			why: 'Completion beats an earlier abandon from another device (D1).'
		},
		abandon: {
			from: END_FROM.abandon,
			to: 'abandoned',
			effects: [
				'workouts: status, finished_at',
				'audit row',
				'leaves the active list',
				'open session_substitution proposals are superseded on accept'
			]
		}
	}
});
