/**
 * The core family: the workout's own row, in every kind's table (workout.start, update, finish and
 * abandon), and exercise.create, strength only, which adds the owner's new exercise to the rows'
 * exercises so a set logged on it can be named at once.
 * - workout.start creates the rows; once they exist (from the server, or an earlier replay of the
 *   same start), it is a no-op. Every other mutation waits for them.
 * - update and finish set the fields they carry, and only those; finish and abandon end the
 *   workout at the mutation's time. All are absolute, so a replay changes nothing.
 */
import type { MutationOf, WorkoutFields } from '../mutations.ts';
import { onRows } from '../project.ts';
import type { MutationReducers } from '../project.ts';
import type { CanonicalWorkout, CanonicalWorkoutRow } from '../protocol.ts';

const FIELDS = [
	'notes',
	'sessionRpe',
	'durationSeconds'
] as const satisfies (keyof WorkoutFields)[];

/** The workout fields a payload carries, and nothing else it may hold. */
const carried = (payload: Partial<WorkoutFields>) =>
	Object.fromEntries(
		FIELDS.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]])
	) as Partial<WorkoutFields>;

const withWorkout = (rows: CanonicalWorkout, change: Partial<CanonicalWorkoutRow>) => ({
	...rows,
	workout: { ...rows.workout, ...change }
});

function started(m: MutationOf<'workout.start'>): CanonicalWorkout {
	const { kind, title, sessionType, discipline, plannedSessionId, plannedLineage, programId } =
		m.payload;
	return {
		v: 1,
		workout: {
			id: m.entityId,
			kind,
			title,
			sessionType,
			discipline,
			plannedSessionId,
			plannedLineage,
			programId,
			status: 'in_progress',
			startedAt: m.at,
			finishedAt: null,
			notes: null,
			sessionRpe: null,
			durationSeconds: null,
			deletedAt: null
		},
		sets: [],
		substitutions: [],
		pain: [],
		run: null,
		other: null,
		exercises: {}
	};
}

export const core: MutationReducers<
	'workout.start' | 'workout.update' | 'workout.finish' | 'workout.abandon'
> = {
	'workout.start': (rows, m) => rows ?? started(m),
	'workout.update': onRows((rows, m) => withWorkout(rows, carried(m.payload))),
	'workout.finish': onRows((rows, m) =>
		withWorkout(rows, { ...carried(m.payload), status: 'completed', finishedAt: m.at })
	),
	'workout.abandon': onRows((rows, m) =>
		withWorkout(rows, { status: 'abandoned', finishedAt: m.at })
	)
};

export const customExercises: MutationReducers<'exercise.create'> = {
	'exercise.create': onRows((rows, { entityId, payload }) => {
		if (rows.exercises[entityId]) return rows;
		const { name, measure, loadType, unilateral } = payload;
		return {
			...rows,
			exercises: { ...rows.exercises, [entityId]: { name, measure, loadType, unilateral } }
		};
	})
};
