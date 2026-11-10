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

/** The owner's undeleted sets of counted workouts performed in the range, with their muscles. */
export function setFacts(db: Executor, ownerId: string, range: InstantRange) {
	return db
		.select({
			// The row's id, as text: the facts name sets and workouts alike by string ids.
			id: sql<string>`${setRecords.id}::text`,
			workoutId: setRecords.workoutId,
			exercise: setRecords.exerciseId,
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
			// When it last changed: a review's inputs digest notices an edited set.
			updatedAt: setRecords.updatedAt,
			primaryMuscles: exercises.primaryMuscles,
			secondaryMuscles: exercises.secondaryMuscles
		})
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
		.orderBy(asc(setRecords.performedAt), asc(setRecords.id));
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
 * each workout was logged under (workouts.planned_session_id), composed from programs.ts.
 */
export function prescriptionFacts(db: Executor, plannedSessionIds: string[]) {
	const { exercises, sets } = sessionChildren(db, plannedSessionIds);
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

export type SetFactRow = Awaited<ReturnType<typeof setFacts>>[number];
export type SessionFactRow = Awaited<ReturnType<typeof sessionFacts>>[number];
export type SegmentFactRow = Awaited<ReturnType<typeof segmentFacts>>[number];
export type ProgramInRangeRow = Awaited<ReturnType<typeof programsInRange>>[number];
export type RecoveryFactRow = Awaited<ReturnType<typeof recoveryFacts>>[number];
