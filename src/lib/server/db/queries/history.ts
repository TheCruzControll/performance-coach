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
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, not, or, sql } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { IsoDate } from '../../../domain/calendar';
import { PR_MAX_REPS } from '../../../domain/training/metrics';
import { exercises, runRecords, setRecords, workouts } from '../schema';
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
	bestE1rms: 'set_records_exercise_e1rm_idx',
	repMaxes: 'set_records_exercise_rep_max_idx',
	setsInRange: 'set_records_owner_performed_idx',
	runsInRange: 'workouts_owner_kind_started_idx',
	workoutsInRange: 'workouts_owner_started_idx',
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

/** A set as history reads it: the weight as entered, with its exact kg and its stored e1RM. */
const setColumns = {
	id: setRecords.id,
	workoutId: setRecords.workoutId,
	exerciseId: setRecords.exerciseId,
	exercisePosition: setRecords.exercisePosition,
	setIndex: setRecords.setIndex,
	weight: setRecords.weight,
	unit: setRecords.unit,
	weightKg: setRecords.weightKg,
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

/** One exercise, or all: the catalogue's rows, retired ones included, and the owner's own. */
const exercisesOf = (ownerId: string, exerciseId: string | undefined) =>
	and(
		or(isNull(exercises.ownerId), eq(exercises.ownerId, ownerId)),
		exerciseId === undefined ? undefined : eq(exercises.id, exerciseId)
	);

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

/**
 * Each exercise's set with the highest stored e1RM (ties to the latest), for one exercise or for
 * all. 'All' drives a LATERAL from the small exercises table (the catalogue, retired rows
 * included, and the owner's own) that probes the e1RM index once per exercise, so it never
 * scans set_records; exercises with no estimate drop out. Only working sets store an e1RM.
 */
export function bestE1rms(db: Executor, ownerId: string, exerciseId?: string) {
	const best = db
		.select(setColumns)
		.from(setRecords)
		.where(and(exerciseSets(ownerId, exercises.id), isNotNull(setRecords.e1rmKg)))
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
 * latest), for one exercise or for all: a LATERAL from the exercises table and the rep counts,
 * probing the rep-max index once per pair. Rep counts never lifted with a load drop out.
 */
export function repMaxes(db: Executor, ownerId: string, exerciseId?: string) {
	const top = db
		.select(setColumns)
		.from(setRecords)
		.where(
			and(
				exerciseSets(ownerId, exercises.id),
				eq(setRecords.reps, repCount),
				working,
				isNotNull(setRecords.weightKg)
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
 * The owner's undeleted sets performed in the range, as the metrics read a logged set, with their
 * exercise's muscles.
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
		.where(
			and(
				eq(setRecords.ownerId, ownerId),
				during(setRecords.performedAt, range),
				isNull(setRecords.deletedAt)
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
export type WorkoutRow = Awaited<ReturnType<typeof workoutsInRange>>[number];
