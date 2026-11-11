/**
 * The core family: the workout's own row, in every kind's table (workout.start, update, finish and
 * abandon), and exercise.create, strength only, which adds the owner's new exercise to the rows'
 * exercises so a set logged on it can be named at once.
 * - workout.start creates the rows; once they exist (from the server, or an earlier replay of the
 *   same start), it is a no-op. Every other mutation waits for them.
 * - update and finish set the fields they carry, and only those; finish and abandon end the
 *   workout at the mutation's time. All are absolute, so a replay changes nothing.
 * - finish and abandon end the workout only as canEnd says, as the server's finishWorkout does
 *   (owner decision D1): a completed workout stays completed, an abandoned one may still be
 *   completed, and a refused end leaves the rows as they are. Only ./ends.ts is loaded, not the
 *   WORKOUT table, which stays out of /workout's bundle.
 * - The one finish a completed workout takes is its own, replayed: the outbox replays over rows
 *   the server already applied it to (its answer not yet stored), after the updates before it,
 *   so it sets its values again. The server's ledger answers that replay 'duplicate'; here the
 *   finish time it ended the rows at stands in for its id.
 */
import { canEnd } from '../ends.ts';
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

/** Whether `m` is the finish that already ended the rows: replayed, not a second finish. */
const finishedBy = (rows: CanonicalWorkout, m: MutationOf<'workout.finish'>) =>
	rows.workout.status === 'completed' &&
	rows.workout.finishedAt !== null &&
	Date.parse(rows.workout.finishedAt) === Date.parse(m.at);

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
		canEnd(rows.workout.status, 'finish') || finishedBy(rows, m)
			? withWorkout(rows, { ...carried(m.payload), status: 'completed', finishedAt: m.at })
			: rows
	),
	'workout.abandon': onRows((rows, m) =>
		canEnd(rows.workout.status, 'abandon')
			? withWorkout(rows, { status: 'abandoned', finishedAt: m.at })
			: rows
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
