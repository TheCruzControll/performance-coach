/**
 * History read builders (PRD §9; the M3 plan's 'history queries are defined once'). Each is one
 * keyed query that repositories/history.ts runs and `pnpm db:explain` (m3/33) explains as it is,
 * shaped for the training log's history indexes (schema/training-log.ts).
 * - Predicates lead with the owner, then the exercise, then time, and never wrap an indexed
 *   column in a function. A partial index's predicate is repeated so the plan can use it.
 * - Times are instants, [start, end): the services turn the owner's dates into them, and the
 *   domain metrics place each row in its week. Nothing here counts hard sets, PRs or weeks.
 * - HISTORY_INDEXES names the index each builder is shaped for. db:explain asserts that a
 *   builder's plan uses it on a large relation, and the integration test that it exists.
 * Nothing runs until a builder is awaited; await them in turn on one connection.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, not, or, sql } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { IsoDate } from '../../../domain/calendar';
import { PR_MAX_REPS } from '../../../domain/training/metrics';
import { exercises, otherSessionRecords, runRecords, setRecords, workouts } from '../schema';
import type { Executor } from '../types';
import { plannedSessionsInRange } from './programs';

/**
 * The index each builder is shaped for. sessionsInRange composes two queries: programs.ts's
 * plannedSessionsInRange (a version's weeks, then each week's sessions by day) and
 * workoutsInRange.
 */
export const HISTORY_INDEXES = {
	exerciseHistory: 'set_records_exercise_history_idx',
	lastPerformances: 'set_records_exercise_history_idx',
	lastSessionSets: 'set_records_exercise_history_idx',
	mostReps: 'set_records_exercise_history_idx',
	bestE1rms: 'set_records_exercise_e1rm_idx',
	repMaxes: 'set_records_exercise_rep_max_idx',
	setsInRange: 'set_records_owner_performed_idx',
	runsInRange: 'workouts_owner_kind_started_idx',
	workoutsInRange: 'workouts_owner_started_idx',
	activeWorkouts: 'workouts_owner_started_idx',
	completedWorkoutsPage: {
		workouts: 'workouts_owner_started_idx',
		sets: 'set_records_workout_order_idx'
	},
	sessionsInRange: {
		planned: 'planned_sessions_week_day_idx',
		logged: 'workouts_owner_started_idx'
	}
} as const;

/** A span of time from `start`, included, to `end`, left out. */
export interface InstantRange {
	start: Date;
	end: Date;
}

/**
 * A set as history reads it: the weight as entered, with its exact kg, its assistance and its
 * stored e1RM.
 */
const setColumns = {
	id: setRecords.id,
	workoutId: setRecords.workoutId,
	exerciseId: setRecords.exerciseId,
	exercisePosition: setRecords.exercisePosition,
	setIndex: setRecords.setIndex,
	weight: setRecords.weight,
	unit: setRecords.unit,
	weightKg: setRecords.weightKg,
	assistance: setRecords.assistance,
	reps: setRecords.reps,
	missedReps: setRecords.missedReps,
	seconds: setRecords.seconds,
	metres: setRecords.metres,
	rpe: setRecords.rpe,
	isWarmup: setRecords.isWarmup,
	isExtra: setRecords.isExtra,
	isSkipped: setRecords.isSkipped,
	e1rmKg: setRecords.e1rmKg,
	performedAt: setRecords.performedAt
};

type SetColumns = typeof setColumns;

/** A subquery's set columns, as the query around it names them ("best"."id", …). */
const setsOf = <S extends Record<keyof SetColumns, unknown>>(subquery: S) =>
	Object.fromEntries(Object.keys(setColumns).map((k) => [k, subquery[k as keyof SetColumns]])) as {
		[K in keyof SetColumns]: S[K];
	};

const exerciseColumns = { id: exercises.id, key: exercises.key, name: exercises.name };

/** One of the owner's undeleted sets of one exercise (the history index's own predicate). */
const exerciseSets = (ownerId: string, exerciseId: string | typeof exercises.id) =>
	and(
		eq(setRecords.ownerId, ownerId),
		eq(setRecords.exerciseId, exerciseId),
		isNull(setRecords.deletedAt)
	);

/** Neither a warm-up nor skipped: a set the metrics count as performed work. */
const working = and(not(setRecords.isWarmup), not(setRecords.isSkipped));

/** One exercise by id, or a list of them (a start kit's, batched in one query). */
export type ExerciseIds = string | readonly string[];

/**
 * One exercise, a list of them, or all: the catalogue's rows, retired ones included, and the
 * owner's own.
 */
const exercisesOf = (ownerId: string, exerciseId: ExerciseIds | undefined) =>
	and(
		or(isNull(exercises.ownerId), eq(exercises.ownerId, ownerId)),
		exerciseId === undefined
			? undefined
			: typeof exerciseId === 'string'
				? eq(exercises.id, exerciseId)
				: inArray(exercises.id, [...exerciseId])
	);

/** Performed before `before`, when given (a start kit's bests, from before its workout). */
const performedBefore = (before: Date | undefined) => before && lt(setRecords.performedAt, before);

/** Started or performed from `start`, included, to `end`, left out. */
const during = (column: AnyPgColumn, { start, end }: InstantRange) =>
	and(gte(column, start), lt(column, end));

const cursor = alias(setRecords, 'cursor');

/**
 * An exercise's sets, newest first, `limit` at a time: warm-ups and skipped sets included and
 * flagged, deleted ones left out. Keyset pagination on (performed_at, id): `before` is the last
 * set id of the previous page, and its own row gives the exact timestamp to continue from, so
 * sets logged within a millisecond of each other are neither repeated nor skipped. A cursor that
 * is not one of the owner's sets gives an empty page.
 */
export function exerciseHistory(
	db: Executor,
	ownerId: string,
	exerciseId: string,
	{ before, limit }: { before?: number; limit: number }
) {
	const after =
		before === undefined
			? undefined
			: sql`(${setRecords.performedAt}, ${setRecords.id}) < ((${db
					.select({ at: cursor.performedAt })
					.from(cursor)
					.where(and(eq(cursor.id, before), eq(cursor.ownerId, ownerId)))}), ${before})`;
	return db
		.select(setColumns)
		.from(setRecords)
		.where(and(exerciseSets(ownerId, exerciseId), after))
		.orderBy(desc(setRecords.performedAt), desc(setRecords.id))
		.limit(limit);
}

/**
 * The last `count` workouts with a working set of the exercise, newest first, each with all its
 * working sets in workout order. A workout counts from its latest working set of the exercise.
 */
export function lastPerformances(db: Executor, ownerId: string, exerciseId: string, count: number) {
	const performed = and(exerciseSets(ownerId, exerciseId), working);
	const recent = db.$with('recent').as(
		db
			.select({
				workoutId: setRecords.workoutId,
				lastAt: sql`max(${setRecords.performedAt})`.as('last_at')
			})
			.from(setRecords)
			.where(performed)
			.groupBy(setRecords.workoutId)
			.orderBy(desc(sql`last_at`), desc(setRecords.workoutId))
			.limit(count)
	);
	return db
		.with(recent)
		.select({
			workout: {
				workoutId: workouts.id,
				title: workouts.title,
				status: workouts.status,
				startedAt: workouts.startedAt
			},
			set: setColumns
		})
		.from(recent)
		.innerJoin(workouts, eq(workouts.id, recent.workoutId))
		.innerJoin(setRecords, and(eq(setRecords.workoutId, recent.workoutId), performed))
		.orderBy(
			desc(recent.lastAt),
			desc(recent.workoutId),
			asc(setRecords.exercisePosition),
			asc(setRecords.setIndex)
		);
}

const lastSet = alias(setRecords, 'last_set');
const lastWorkout = alias(workouts, 'last_workout');

/**
 * Each of these exercises' previous session (a start kit's 'last time'): the sets of the owner's
 * last completed, undeleted workout with a set of it performed before `before`, in workout order.
 * Skipped and deleted sets are left out; warm-ups stay, flagged. A LATERAL
 * from the exercises table probes the history index once per id, newest first, and stops at the
 * first set of a completed workout, so an in-progress or abandoned one is never 'last time'.
 * Exercises never done drop out.
 */
export function lastSessionSetsFor(
	db: Executor,
	ownerId: string,
	exerciseIds: readonly string[],
	before: Date
) {
	const last = db
		.select({ workoutId: lastSet.workoutId, startedAt: lastWorkout.startedAt })
		.from(lastSet)
		.innerJoin(lastWorkout, eq(lastWorkout.id, lastSet.workoutId))
		.where(
			and(
				eq(lastSet.ownerId, ownerId),
				eq(lastSet.exerciseId, exercises.id),
				isNull(lastSet.deletedAt),
				not(lastSet.isSkipped),
				lt(lastSet.performedAt, before),
				eq(lastWorkout.status, 'completed'),
				isNull(lastWorkout.deletedAt)
			)
		)
		.orderBy(desc(lastSet.performedAt), desc(lastSet.id))
		.limit(1)
		.as('last');
	return db
		.select({
			exerciseId: exercises.id,
			startedAt: last.startedAt,
			set: setColumns
		})
		.from(exercises)
		.innerJoinLateral(last, sql`true`)
		.innerJoin(
			setRecords,
			and(
				eq(setRecords.workoutId, last.workoutId),
				eq(setRecords.exerciseId, exercises.id),
				isNull(setRecords.deletedAt),
				not(setRecords.isSkipped)
			)
		)
		.where(exercisesOf(ownerId, exerciseIds))
		.orderBy(asc(exercises.id), asc(setRecords.exercisePosition), asc(setRecords.setIndex));
}

/**
 * Each exercise's set with the highest stored e1RM (ties to the latest), for one exercise, a list
 * of them, or all. 'All' drives a LATERAL from the small exercises table (the catalogue, retired rows
 * included, and the owner's own) that probes the e1RM index once per exercise, so it never
 * scans set_records; exercises with no estimate drop out. Only working sets store an e1RM.
 * `before` leaves out sets performed from then on.
 */
export function bestE1rms(db: Executor, ownerId: string, exerciseId?: ExerciseIds, before?: Date) {
	const best = db
		.select(setColumns)
		.from(setRecords)
		.where(
			and(
				exerciseSets(ownerId, exercises.id),
				isNotNull(setRecords.e1rmKg),
				performedBefore(before)
			)
		)
		.orderBy(desc(setRecords.e1rmKg), desc(setRecords.performedAt), desc(setRecords.id))
		.limit(1)
		.as('best');
	return db
		.select({ exercise: exerciseColumns, set: setsOf(best) })
		.from(exercises)
		.innerJoinLateral(best, sql`true`)
		.where(exercisesOf(ownerId, exerciseId))
		.orderBy(asc(exercises.id));
}

const repCounts = sql`generate_series(1, ${sql.raw(String(PR_MAX_REPS))}) as rep_counts(reps)`;
const repCount = sql<number>`rep_counts.reps`;

/**
 * Each exercise's heaviest working set at each rep count from 1 to PR_MAX_REPS (ties to the
 * latest), for one exercise, a list of them, or all: a LATERAL from the exercises table and the
 * rep counts, probing the rep-max index once per pair. Rep counts never lifted with a load drop
 * out. `before` leaves out sets performed from then on.
 */
export function repMaxes(db: Executor, ownerId: string, exerciseId?: ExerciseIds, before?: Date) {
	const top = db
		.select(setColumns)
		.from(setRecords)
		.where(
			and(
				exerciseSets(ownerId, exercises.id),
				eq(setRecords.reps, repCount),
				working,
				isNotNull(setRecords.weightKg),
				performedBefore(before)
			)
		)
		.orderBy(desc(setRecords.weightKg), desc(setRecords.performedAt), desc(setRecords.id))
		.limit(1)
		.as('top');
	return db
		.select({ exercise: exerciseColumns, set: setsOf(top) })
		.from(exercises)
		.crossJoin(repCounts)
		.innerJoinLateral(top, sql`true`)
		.where(exercisesOf(ownerId, exerciseId))
		.orderBy(asc(exercises.id), asc(repCount));
}

/**
 * Each of these exercises' most reps in one working set with no weight added (the workout
 * summary's 'Most reps', which only bodyweight exercises compete for): a LATERAL from the
 * exercises table over the history index, performed before `before`. Exercises with no such set
 * drop out.
 */
export function mostReps(
	db: Executor,
	ownerId: string,
	exerciseIds: readonly string[],
	before: Date
) {
	const most = db
		.select({ reps: setRecords.reps })
		.from(setRecords)
		.where(
			and(
				exerciseSets(ownerId, exercises.id),
				working,
				sql`coalesce(${setRecords.weight}, 0) <= 0`,
				gte(setRecords.reps, 1),
				performedBefore(before)
			)
		)
		.orderBy(desc(setRecords.reps), desc(setRecords.performedAt), desc(setRecords.id))
		.limit(1)
		.as('most');
	return db
		.select({ exerciseId: exercises.id, reps: most.reps })
		.from(exercises)
		.innerJoinLateral(most, sql`true`)
		.where(exercisesOf(ownerId, exerciseIds))
		.orderBy(asc(exercises.id));
}

/**
 * The owner's undeleted sets performed in the range, as the metrics read a logged set, with their
 * exercise's muscles: of completed, undeleted workouts only, as M6's analytics count them (an
 * abandoned or unfinished workout is no training done). bestE1rms and repMaxes keep every
 * undeleted set: the start kit's 'prior bests' and the history sheet show what was lifted.
 */
export function setsInRange(db: Executor, ownerId: string, range: InstantRange) {
	return db
		.select({
			exercise: setRecords.exerciseId,
			weight: setRecords.weight,
			unit: setRecords.unit,
			reps: setRecords.reps,
			rpe: setRecords.rpe,
			isWarmup: setRecords.isWarmup,
			isSkipped: setRecords.isSkipped,
			performedAt: setRecords.performedAt,
			primaryMuscles: exercises.primaryMuscles,
			secondaryMuscles: exercises.secondaryMuscles
		})
		.from(setRecords)
		.innerJoin(exercises, eq(exercises.id, setRecords.exerciseId))
		.innerJoin(workouts, eq(workouts.id, setRecords.workoutId))
		.where(
			and(
				eq(setRecords.ownerId, ownerId),
				during(setRecords.performedAt, range),
				isNull(setRecords.deletedAt),
				eq(workouts.status, 'completed'),
				isNull(workouts.deletedAt)
			)
		)
		.orderBy(asc(setRecords.performedAt), asc(setRecords.id));
}

/** The owner's undeleted runs started in the range whose distance is recorded. */
export function runsInRange(db: Executor, ownerId: string, range: InstantRange) {
	return db
		.select({
			workoutId: workouts.id,
			startedAt: workouts.startedAt,
			distanceMetres: runRecords.distanceMetres
		})
		.from(workouts)
		.innerJoin(runRecords, eq(runRecords.workoutId, workouts.id))
		.where(
			and(
				eq(workouts.ownerId, ownerId),
				eq(workouts.kind, 'run'),
				during(workouts.startedAt, range),
				isNull(workouts.deletedAt),
				isNotNull(runRecords.distanceMetres)
			)
		)
		.orderBy(asc(workouts.startedAt), asc(workouts.id));
}

/** The owner's undeleted workouts of any kind started in the range, in order. */
export function workoutsInRange(db: Executor, ownerId: string, range: InstantRange) {
	return db
		.select({
			id: workouts.id,
			kind: workouts.kind,
			discipline: workouts.discipline,
			sessionType: workouts.sessionType,
			title: workouts.title,
			status: workouts.status,
			plannedLineageId: workouts.plannedLineageId,
			startedAt: workouts.startedAt,
			finishedAt: workouts.finishedAt,
			durationSeconds: workouts.durationSeconds,
			sessionRpe: workouts.sessionRpe
		})
		.from(workouts)
		.where(
			and(
				eq(workouts.ownerId, ownerId),
				during(workouts.startedAt, range),
				isNull(workouts.deletedAt)
			)
		)
		.orderBy(asc(workouts.startedAt), asc(workouts.id));
}

/**
 * The owner's undeleted workouts in progress, newest first, at most `limit`: the index's owner
 * prefix and its started_at DESC order, with the status filtered on the way (the owner has a few
 * workouts in progress at most, usually one). Keyed by client id, as the device knows them.
 */
export function activeWorkouts(db: Executor, ownerId: string, limit: number) {
	return db
		.select({
			id: workouts.clientId,
			kind: workouts.kind,
			title: workouts.title,
			sessionType: workouts.sessionType,
			discipline: workouts.discipline,
			plannedSessionId: workouts.plannedSessionId,
			plannedLineage: workouts.plannedLineageId,
			programId: workouts.programId,
			startedAt: workouts.startedAt
		})
		.from(workouts)
		.where(
			and(
				eq(workouts.ownerId, ownerId),
				isNull(workouts.deletedAt),
				eq(workouts.status, 'in_progress')
			)
		)
		.orderBy(desc(workouts.startedAt), desc(workouts.id))
		.limit(limit);
}

const pageCursor = alias(workouts, 'page_cursor');
const counted = alias(setRecords, 'counted');

/**
 * The owner's completed, undeleted workouts of every kind, newest first, `limit` at a time, keyed
 * by client id, each with its key numbers: a run's totals, an other session's kind and minutes,
 * and a strength workout's working sets and the slots they were done in (warm-ups, skipped and
 * deleted sets left out). Keyset pagination on (started_at, id), down the owner's started_at
 * index: `before` is the client id of the previous page's last workout, whose own row gives the
 * exact place to continue from, so workouts started in the same instant are neither repeated nor
 * skipped. A cursor that is not one of the owner's workouts gives an empty page. The counts probe
 * each workout's sets through their workout-order index.
 */
export function completedWorkoutsPage(
	db: Executor,
	ownerId: string,
	{ before, limit }: { before?: string; limit: number }
) {
	const cursorOf = (column: AnyPgColumn) =>
		db
			.select({ value: column })
			.from(pageCursor)
			.where(and(eq(pageCursor.clientId, before!), eq(pageCursor.ownerId, ownerId)));
	const after =
		before === undefined
			? undefined
			: sql`(${workouts.startedAt}, ${workouts.id}) < ((${cursorOf(pageCursor.startedAt)}), (${cursorOf(pageCursor.id)}))`;
	const workingSet = sql`not ${counted.isWarmup} and not ${counted.isSkipped}`;
	const sets = db
		.select({
			count: sql<number>`(count(*) filter (where ${workingSet}))::int`.as('set_count'),
			slots:
				sql<number>`(count(distinct ${counted.exercisePosition}) filter (where ${workingSet}))::int`.as(
					'slot_count'
				)
		})
		.from(counted)
		.where(and(eq(counted.workoutId, workouts.id), isNull(counted.deletedAt)))
		.as('sets');
	return db
		.select({
			id: workouts.clientId,
			kind: workouts.kind,
			discipline: workouts.discipline,
			sessionType: workouts.sessionType,
			title: workouts.title,
			plannedLineage: workouts.plannedLineageId,
			startedAt: workouts.startedAt,
			finishedAt: workouts.finishedAt,
			durationSeconds: workouts.durationSeconds,
			sessionRpe: workouts.sessionRpe,
			run: {
				distanceMetres: runRecords.distanceMetres,
				durationSeconds: runRecords.durationSeconds,
				paceSecondsPerKm: runRecords.paceSecondsPerKm
			},
			other: {
				kind: otherSessionRecords.kind,
				durationMinutes: otherSessionRecords.durationMinutes
			},
			sets: { count: sets.count, slots: sets.slots }
		})
		.from(workouts)
		.leftJoin(runRecords, eq(runRecords.workoutId, workouts.id))
		.leftJoin(otherSessionRecords, eq(otherSessionRecords.workoutId, workouts.id))
		.innerJoinLateral(sets, sql`true`)
		.where(
			and(
				eq(workouts.ownerId, ownerId),
				isNull(workouts.deletedAt),
				eq(workouts.status, 'completed'),
				after
			)
		)
		.orderBy(desc(workouts.startedAt), desc(workouts.id))
		.limit(limit);
}

/**
 * A date range's sessions, planned and logged: the version's sessions dated `from` to `to`
 * (plannedSessionsInRange, composed and never redefined) and the owner's workouts started within
 * `logged`, the instants those dates span.
 */
export function sessionsInRange(
	db: Executor,
	ownerId: string,
	versionId: string,
	from: IsoDate,
	to: IsoDate,
	logged: InstantRange
) {
	return {
		planned: plannedSessionsInRange(db, versionId, from, to),
		logged: workoutsInRange(db, ownerId, logged)
	};
}

/** What the history builders return. */
export type HistorySetRow = Awaited<ReturnType<typeof exerciseHistory>>[number];
export type PerformanceRow = Awaited<ReturnType<typeof lastPerformances>>[number];
export type RecordRow = Awaited<ReturnType<typeof bestE1rms>>[number];
export type LastSessionSetRow = Awaited<ReturnType<typeof lastSessionSetsFor>>[number];
export type WorkoutRow = Awaited<ReturnType<typeof workoutsInRange>>[number];
export type ActiveWorkoutRow = Awaited<ReturnType<typeof activeWorkouts>>[number];
export type CompletedWorkoutRow = Awaited<ReturnType<typeof completedWorkoutsPage>>[number];
