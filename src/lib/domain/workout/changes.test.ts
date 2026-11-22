import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { changedRows, mergeRows, namedRows } from './changes';
import { createMutation } from './mutations';
import type { Mutation, MutationInput, MutationOf, MutationType } from './mutations';
import { replay } from './project';
import type { CanonicalWorkout } from './protocol';
import { strengthTable } from './reducers/tables';
import type { ExerciseSummary, LoggedSet } from './types';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const W = '00000000-0000-4000-8000-0000000000c1';
const slot = (position: number) => KIT.exercises[position - 1]!;
const SQUAT = slot(1).exercise.id;
const LEG_PRESS = slot(2).exercise.id;
const PLANK = slot(5).exercise.id;
const SWAP = '00000000-0000-4000-8000-00000000e0e0';

let ids = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

function make<T extends MutationType>(
	type: T,
	input: Omit<MutationInput<T>, 'workoutId' | 'at'>
): MutationOf<T> {
	return createMutation(type, { workoutId: W, at: '2026-11-06T18:00:00.000Z', ...input }, fresh);
}

const DONE: LoggedSet = {
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

const start = make('workout.start', {
	entityId: W,
	payload: {
		kind: 'strength',
		title: KIT.title,
		sessionType: KIT.sessionType,
		discipline: KIT.discipline,
		plannedSessionId: null,
		plannedLineage: null,
		programId: null
	}
});
const logAt = (position: number, setIndex: number, exerciseId = slot(position).exercise.id) =>
	make('set.log', {
		payload: {
			position,
			plannedLineage: slot(position).plannedLineage,
			setIndex,
			exerciseId,
			...DONE
		}
	});
const edit = (setId: string, reps: number) =>
	make('set.edit', { entityId: setId, payload: { ...DONE, reps } });
const substitute = make('exercise.substitute', {
	payload: {
		position: 2,
		plannedLineage: slot(2).plannedLineage,
		fromExerciseId: LEG_PRESS,
		toExerciseId: SWAP,
		reason: 'equipment_unavailable'
	}
});
const pain = make('pain.report', {
	payload: {
		position: 1,
		plannedLineage: slot(1).plannedLineage,
		exerciseId: SQUAT,
		area: null,
		severity: null,
		action: 'stopped',
		substitutionId: null,
		note: null
	}
});
const skip = (position: number, ...setIndexes: number[]) =>
	make('exercise.skip', {
		payload: {
			position,
			plannedLineage: slot(position).plannedLineage,
			exerciseId: slot(position).exercise.id,
			unit: 'kg',
			sets: setIndexes.map((setIndex) => ({ id: fresh(), setIndex }))
		}
	});

const summary = (name: string): ExerciseSummary => ({
	name,
	measure: 'reps',
	loadType: 'external',
	unilateral: false
});

/** The server's rows after `mutations`, naming every exercise they hold, as the real server does. */
function rowsAfter(mutations: readonly Mutation[]): CanonicalWorkout {
	const rows = replay(strengthTable, {
		workoutId: W,
		kit: null,
		canonical: null,
		pending: mutations
	}).rows!;
	const exercises = { [SQUAT]: summary('Squat'), [LEG_PRESS]: summary('Leg press') };
	return {
		...rows,
		exercises: { ...exercises, [PLANK]: summary('Plank'), [SWAP]: summary('Hack squat') }
	};
}

describe('namedRows', () => {
	it('names the row a change creates, the row an edit names, and every set a skip writes', () => {
		const log = logAt(1, 1);
		const change = edit(log.id, 4);
		const skipped = skip(5, 1, 2);
		expect(namedRows(log)).toEqual([log.id, log.id]);
		expect(namedRows(change)).toEqual([change.id, log.id]);
		expect(namedRows(skipped)).toEqual([
			skipped.id,
			skipped.entityId,
			...skipped.payload.sets.map((s) => s.id)
		]);
		expect(namedRows(substitute)).toContain(substitute.id);
		expect(namedRows(pain)).toContain(pain.id);
	});
});

describe('changedRows', () => {
	it('keeps only the named sets, substitutions and pain reports, the workout row whole, and only their exercises', () => {
		const one = logAt(1, 1);
		const two = logAt(1, 2);
		const plank = logAt(5, 1);
		const rows = rowsAfter([start, one, two, plank, substitute, pain]);

		const changes = changedRows(rows, new Set([...namedRows(edit(two.id, 4)), substitute.id]));

		expect(changes.workout).toBe(rows.workout);
		expect(changes.run).toBe(rows.run);
		expect(changes.other).toBe(rows.other);
		expect(changes.sets.map((s) => s.id)).toEqual([two.id]);
		expect(changes.substitutions.map((s) => s.id)).toEqual([substitute.id]);
		expect(changes.pain).toEqual([]);
		expect(Object.keys(changes.exercises).sort()).toEqual([SQUAT, LEG_PRESS, SWAP].sort());
	});

	it('keeps nothing but the workout row for a change that names no row', () => {
		const rows = rowsAfter([start, logAt(1, 1), pain]);
		const changes = changedRows(
			rows,
			new Set(namedRows(make('workout.update', { payload: { notes: 'x' } })))
		);
		expect(changes).toEqual({ ...rows, sets: [], substitutions: [], pain: [], exercises: {} });
	});
});

describe('mergeRows', () => {
	it('folds the changed rows into the held ones, in place or last, and ends on the server’s rows', () => {
		const one = logAt(1, 1);
		const two = logAt(1, 2);
		const before = [start, one, two, substitute];
		const held = rowsAfter(before);
		const batch = [edit(one.id, 3), logAt(1, 3), skip(5, 1, 2), pain];
		const server = rowsAfter([...before, ...batch]);

		const merged = mergeRows(held, changedRows(server, new Set(batch.flatMap(namedRows))));

		expect(merged).toStrictEqual(server);
		expect(merged.sets[0]).toMatchObject({ id: one.id, reps: 3 });
	});

	it('keeps the held exercises and takes the workout row the answer carries', () => {
		const held = { ...rowsAfter([start, logAt(1, 1)]), exercises: { [SQUAT]: summary('Squat') } };
		const finish = make('workout.finish', { payload: {} });
		const server = rowsAfter([start, logAt(1, 1), finish]);
		const changes = { ...changedRows(server, new Set(namedRows(finish))), exercises: {} };

		const merged = mergeRows(held, changes);

		expect(merged.workout).toBe(server.workout);
		expect(merged.exercises).toEqual({ [SQUAT]: summary('Squat') });
		expect(merged.sets).toEqual(held.sets);
	});

	it('holds none when the device holds none: changed rows are not the whole workout', () => {
		const server = rowsAfter([start, logAt(1, 1)]);
		const changes = changedRows(server, new Set([start.id]));
		expect(mergeRows(null, changes)).toBeNull();
	});
});
