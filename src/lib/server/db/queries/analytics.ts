/**
 * The rows M6's analytics read (PRD §10), each fact query defined once. repositories/analytics.ts
 * runs them; services/analytics/facts.ts loads each kind at most once per request.
 * - Which workouts count: set, session and segment facts join their workout and keep only
 *   COUNTED_STATUS ones that are not deleted, so an abandoned or unfinished workout never reaches a
 *   PR, a total or a review. (M3's bestE1rms and repMaxes keep every undeleted set on purpose.)
 * - Predicates lead with the owner, then time, and never wrap an indexed column in a function.
 *   Times are instants, [start, end): the loader turns the owner's dates into them and keeps each
 *   row by the day it fell on. Nothing here counts, sums or judges: the domain does.
 * - ANALYTICS_INDEXES names the index each fact query is shaped for, for analytics-plans to gate;
 *   ANALYTICS_SMALL lists the reads over small relations, whose plans are recorded, not gated.
 * Nothing runs until a builder is awaited; await them in turn on one connection.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, min, not, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { IsoDate } from '../../../domain/calendar';
import {
	exercises,
	otherSessionRecords,
	plannedExercises,
	plannedSessions,
	programBlocks,
	programs,
	programVersionBlocks,
	programVersions,
	recoveryNotes,
	runRecords,
	runRecordSegments,
	setRecords,
	workouts,
	type WorkoutStatus
} from '../schema';
import type { Executor } from '../types';
import type { InstantRange } from './history';
import { completedLineages, plannedSessionsInRange, sessionChildren } from './programs';

/**
 * Decision (m6-plan open question 'Workouts you abandoned or are still logging'): only completed
 * workouts count as training done.
 */
export const COUNTED_STATUS: WorkoutStatus = 'completed';

export const ANALYTICS_INDEXES = {
	setFacts: 'set_records_owner_performed_idx',
	sessionFacts: 'workouts_owner_started_idx',
	segmentFacts: 'run_record_segments_run_order_idx',
	prescriptionFacts: {
		exercises: 'planned_exercises_session_position_uq',
		sets: 'set_prescriptions_exercise_position_uq'
	},
	plannedFacts: {
		planned: 'planned_sessions_week_day_idx',
		completed: 'workouts_planned_lineage_idx',
		runSegments: 'planned_run_segments_session_position_uq'
	}
} as const;

/** One owner's few rows each: a program's versions and blocks, a note a day, one aggregate. */
export const ANALYTICS_SMALL = [
	'recoveryFacts',
	'programsInRange',
	'blockInputs',
	'firstActivity'
] as const;

/** A workout that counts: completed and not deleted. */
const counted = and(eq(workouts.status, COUNTED_STATUS), isNull(workouts.deletedAt));

const during = (column: AnyPgColumn, { start, end }: InstantRange) =>
	and(gte(column, start), lt(column, end));

type SetRecord = typeof setRecords.$inferSelect;
type ExerciseRow = typeof exercises.$inferSelect;

/** A counted set with its exercise's muscles, as setFacts gives it. */
export interface SetFactRow {
	/** The row's id, as text: the facts name sets and workouts alike by string ids. */
	id: string;
	workoutId: string;
	exercise: string;
	exerciseId: string;
	plannedLineage: string | null;
	exercisePosition: number;
	setIndex: number;
	weight: number | null;
	unit: SetRecord['unit'];
	assistance: number | null;
	reps: number | null;
	missedReps: number;
	seconds: number | null;
	metres: number | null;
	rpe: number | null;
	isWarmup: boolean;
	isExtra: boolean;
	isSkipped: boolean;
	performedAt: Date;
	deletedAt: Date | null;
	/** When it last changed: a review's inputs digest notices an edited set. */
	updatedAt: Date;
	primaryMuscles: ExerciseRow['primaryMuscles'];
	secondaryMuscles: ExerciseRow['secondaryMuscles'];
}

/** One set as setFacts' JSON array carries it: SET_FACT_COLUMNS' values, in order. */
type SetFactJson = [
	string,
	string,
	string,
	string | null,
	number,
	number,
	number | null,
	SetRecord['unit'],
	number | null,
	number | null,
	number,
	number | null,
	number | null,
	number | null,
	boolean,
	boolean,
	boolean,
	string,
	string | null,
	string,
	ExerciseRow['primaryMuscles'],
	ExerciseRow['secondaryMuscles']
];

/** The columns of each set, in the order setFactOf reads them (an object's keys keep their order). */
const SET_FACT_COLUMNS = {
	id: sql<string>`${setRecords.id}::text`.as('id'),
	workoutId: setRecords.workoutId,
	exerciseId: setRecords.exerciseId,
	plannedLineage: setRecords.plannedExerciseLineageId,
	exercisePosition: setRecords.exercisePosition,
	setIndex: setRecords.setIndex,
	weight: setRecords.weight,
	unit: setRecords.unit,
	assistance: setRecords.assistance,
	reps: setRecords.reps,
	missedReps: setRecords.missedReps,
	seconds: setRecords.seconds,
	metres: setRecords.metres,
	rpe: setRecords.rpe,
	isWarmup: setRecords.isWarmup,
	isExtra: setRecords.isExtra,
	isSkipped: setRecords.isSkipped,
	performedAt: setRecords.performedAt,
	deletedAt: setRecords.deletedAt,
	updatedAt: setRecords.updatedAt,
	primaryMuscles: exercises.primaryMuscles,
	secondaryMuscles: exercises.secondaryMuscles,
	// The order's tiebreak, as the row is numbered (the text id would sort '10' before '9').
	key: sql<number>`${setRecords.id}`.as('key')
};

function setFactOf([
	id,
	workoutId,
	exerciseId,
	plannedLineage,
	exercisePosition,
	setIndex,
	weight,
	unit,
	assistance,
	reps,
	missedReps,
	seconds,
	metres,
	rpe,
	isWarmup,
	isExtra,
	isSkipped,
	performedAt,
	deletedAt,
	updatedAt,
	primaryMuscles,
	secondaryMuscles
]: SetFactJson): SetFactRow {
	// One literal, no spreads: it runs once per set.
	return {
		id,
		workoutId,
		exercise: exerciseId,
		exerciseId,
		plannedLineage,
		exercisePosition,
		setIndex,
		weight,
		unit,
		assistance,
		reps,
		missedReps,
		seconds,
		metres,
		rpe,
		isWarmup,
		isExtra,
		isSkipped,
		performedAt: new Date(performedAt),
		deletedAt: deletedAt === null ? null : new Date(deletedAt),
		updatedAt: new Date(updatedAt),
		primaryMuscles,
		secondaryMuscles
	};
}

/**
 * The owner's undeleted sets of counted workouts performed in the range, with their muscles, in
 * the order they were performed.
 * Two years of sets are about 15k rows: Postgres sends them as one JSON array of arrays, which
 * Node parses natively, instead of 15k rows of 22 columns, each decoded and mapped field by field
 * (analytics-explain: that decoding cost more than the rest of the Strength view's 'all').
 */
export function setFacts(db: Executor, ownerId: string, range: InstantRange) {
	// The rows as the row query reads them, in order (set_records_owner_performed_idx), planned on
	// their own (offset 0 keeps Postgres from merging them into the aggregate, which would sort the
	// built rows whole instead), then built into arrays and aggregated in that order.
	const ordered = db
		.select(SET_FACT_COLUMNS)
		.from(setRecords)
		.innerJoin(workouts, eq(workouts.id, setRecords.workoutId))
		.innerJoin(exercises, eq(exercises.id, setRecords.exerciseId))
		.where(
			and(
				eq(setRecords.ownerId, ownerId),
				during(setRecords.performedAt, range),
				isNull(setRecords.deletedAt),
				counted
			)
		)
		.orderBy(asc(setRecords.performedAt), asc(setRecords.id))
		.offset(0)
		.as('ordered');
	const { key, ...columns } = ordered._.selectedFields;
	const row = sql.join(Object.values(columns), sql`, `);
	const sets = sql<
		SetFactJson[]
	>`coalesce(json_agg(json_build_array(${row}) order by ${ordered.performedAt}, ${key}), '[]')`;
	return db
		.select({ sets: sets.mapWith((value: SetFactJson[]) => value.map(setFactOf)) })
		.from(ordered);
}

/** The owner's counted workouts started in the range, with their run or other-session record. */
export function sessionFacts(db: Executor, ownerId: string, range: InstantRange) {
	return db
		.select({
			id: workouts.id,
			kind: workouts.kind,
			discipline: workouts.discipline,
			sessionType: workouts.sessionType,
			title: workouts.title,
			plannedSessionId: workouts.plannedSessionId,
			plannedLineage: workouts.plannedLineageId,
			programId: workouts.programId,
			startedAt: workouts.startedAt,
			finishedAt: workouts.finishedAt,
			durationSeconds: workouts.durationSeconds,
			sessionRpe: workouts.sessionRpe,
			// When it or its record last changed: a review's inputs digest notices an edit.
			updatedAt:
				sql<Date>`greatest(${workouts.updatedAt}, ${runRecords.updatedAt}, ${otherSessionRecords.updatedAt})`.mapWith(
					workouts.updatedAt
				),
			run: {
				workoutId: runRecords.workoutId,
				distanceMetres: runRecords.distanceMetres,
				durationSeconds: runRecords.durationSeconds,
				avgHr: runRecords.avgHr,
				rpe: runRecords.rpe
			},
			other: {
				kind: otherSessionRecords.kind,
				durationMinutes: otherSessionRecords.durationMinutes,
				rpe: otherSessionRecords.rpe,
				metrics: otherSessionRecords.metrics
			}
		})
		.from(workouts)
		.leftJoin(runRecords, eq(runRecords.workoutId, workouts.id))
		.leftJoin(otherSessionRecords, eq(otherSessionRecords.workoutId, workouts.id))
		.where(and(eq(workouts.ownerId, ownerId), during(workouts.startedAt, range), counted))
		.orderBy(asc(workouts.startedAt), asc(workouts.id));
}

/** These runs' segments, each run's in order, of counted workouts only. */
export function segmentFacts(db: Executor, ownerId: string, workoutIds: readonly string[]) {
	return db
		.select({
			workoutId: runRecordSegments.workoutId,
			position: runRecordSegments.position,
			kind: runRecordSegments.kind,
			distanceMetres: runRecordSegments.distanceMetres,
			durationSeconds: runRecordSegments.durationSeconds,
			avgHr: runRecordSegments.avgHr
		})
		.from(runRecordSegments)
		.innerJoin(workouts, eq(workouts.id, runRecordSegments.workoutId))
		.where(
			and(
				inArray(runRecordSegments.workoutId, [...workoutIds]),
				eq(runRecordSegments.ownerId, ownerId),
				counted
			)
		)
		.orderBy(asc(runRecordSegments.workoutId), asc(runRecordSegments.position));
}

/**
 * The planned exercises and set prescriptions of these planned sessions: the rows of the version
 * each workout was logged under (workouts.planned_session_id). The set prescriptions are
 * programs.ts's (sessionChildren, composed); of each exercise only what the matching reads (its
 * session, lineage and exercise), without the library names a program screen joins for, since
 * two years of strength sessions plan thousands of them.
 */
export function prescriptionFacts(db: Executor, plannedSessionIds: string[]) {
	const { sets } = sessionChildren(db, plannedSessionIds);
	const exercises = db
		.select({
			id: plannedExercises.id,
			sessionId: plannedExercises.sessionId,
			lineageId: plannedExercises.lineageId,
			exerciseId: plannedExercises.exerciseId
		})
		.from(plannedExercises)
		// Probed through the session index with the sessions' ids, as programs.ts's children are:
		// an IN list of hundreds of sessions would rather scan the table.
		.where(
			sql`${plannedExercises.sessionId} = any(array(${db
				.select({ id: plannedSessions.id })
				.from(plannedSessions)
				.where(inArray(plannedSessions.id, plannedSessionIds))}))`
		)
		.orderBy(asc(plannedExercises.sessionId), asc(plannedExercises.position));
	return { exercises, sets };
}

/**
 * The owner's programs whose current version plans a block that overlaps `from`–`to`, archived
 * ones included, oldest first.
 */
export function programsInRange(db: Executor, ownerId: string, from: IsoDate, to: IsoDate) {
	const overlaps = db
		.select({ one: sql`1` })
		.from(programVersionBlocks)
		.innerJoin(programBlocks, eq(programBlocks.id, programVersionBlocks.blockId))
		.where(
			and(
				eq(programVersionBlocks.versionId, programVersions.id),
				lte(programBlocks.startsOn, to),
				gte(programBlocks.endsOn, from)
			)
		);
	return db
		.select({
			id: programs.id,
			status: programs.status,
			versionId: programVersions.id,
			versionNumber: programVersions.number,
			startsOn: programVersions.startsOn
		})
		.from(programs)
		.innerJoin(programVersions, eq(programVersions.id, programs.currentVersionId))
		.where(and(eq(programs.ownerId, ownerId), sql`exists (${overlaps})`))
		.orderBy(asc(programVersions.startsOn), asc(programs.id));
}

/**
 * A planned-session read for the adherence: a version's sessions dated `from`–`to`
 * (plannedSessionsInRange, composed), which of `lineages` a counted workout completed, and the
 * segments of the planned runs among them (sessionChildren, composed) for the planned mileage.
 */
export function plannedFacts(db: Executor, ownerId: string) {
	return {
		planned: (versionId: string, from: IsoDate, to: IsoDate) =>
			plannedSessionsInRange(db, versionId, from, to),
		runSegments: (sessionIds: string[]) => sessionChildren(db, sessionIds).segments,
		completed: (lineages: string[]) => completedLineages(db, ownerId, lineages)
	};
}

/** The owner's recovery notes dated `from`–`to`, in date order. */
export function recoveryFacts(db: Executor, ownerId: string, from: IsoDate, to: IsoDate) {
	return db
		.select({
			id: recoveryNotes.id,
			notedOn: recoveryNotes.notedOn,
			sleepHours: recoveryNotes.sleepHours,
			soreness: recoveryNotes.soreness,
			energy: recoveryNotes.energy,
			stress: recoveryNotes.stress,
			note: recoveryNotes.note,
			// When it last changed: a review's inputs digest notices an edited check-in.
			updatedAt: recoveryNotes.updatedAt
		})
		.from(recoveryNotes)
		.where(
			and(
				eq(recoveryNotes.ownerId, ownerId),
				gte(recoveryNotes.notedOn, from),
				lte(recoveryNotes.notedOn, to)
			)
		)
		.orderBy(asc(recoveryNotes.notedOn), asc(recoveryNotes.id));
}

/**
 * The input each of a program's generated versions was built from, with the lineages of the
 * blocks it plans (outlines left out), lowest version first: a block is judged by the first
 * version that planned it.
 */
export function blockInputs(db: Executor, programId: string) {
	return db
		.select({
			number: programVersions.number,
			blockLineage: programBlocks.lineageId,
			input: programVersions.inputSnapshot
		})
		.from(programVersions)
		.innerJoin(programVersionBlocks, eq(programVersionBlocks.versionId, programVersions.id))
		.innerJoin(programBlocks, eq(programBlocks.id, programVersionBlocks.blockId))
		.where(
			and(
				eq(programVersions.programId, programId),
				isNotNull(programVersions.generator),
				isNotNull(programVersions.inputSnapshot),
				not(programBlocks.outline)
			)
		)
		.orderBy(asc(programVersions.number), asc(programBlocks.position));
}

/** When the owner's first counted workout started; null before any. */
export function firstActivity(db: Executor, ownerId: string) {
	return db
		.select({ at: min(workouts.startedAt) })
		.from(workouts)
		.where(and(eq(workouts.ownerId, ownerId), counted));
}

export type SessionFactRow = Awaited<ReturnType<typeof sessionFacts>>[number];
export type SegmentFactRow = Awaited<ReturnType<typeof segmentFacts>>[number];
export type ProgramInRangeRow = Awaited<ReturnType<typeof programsInRange>>[number];
export type RecoveryFactRow = Awaited<ReturnType<typeof recoveryFacts>>[number];
