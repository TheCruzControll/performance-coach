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
import type { SQLWrapper, Subquery } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { IsoDate } from '../../../domain/calendar';
import type { SetPrescription } from '../../../domain/training/types';
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
	setPrescriptions,
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

/**
 * One owner's few rows each: the exercises they logged, a program's versions and blocks, a note a
 * day, one aggregate.
 */
export const ANALYTICS_SMALL = [
	'exerciseMuscles',
	'recoveryFacts',
	'programsInRange',
	'blockInputs',
	'firstActivity'
] as const;

/** A workout that counts: completed and not deleted. */
const counted = and(eq(workouts.status, COUNTED_STATUS), isNull(workouts.deletedAt));

const during = (column: AnyPgColumn, { start, end }: InstantRange) =>
	and(gte(column, start), lt(column, end));

/**
 * The rows of `ordered` (a subquery, offset 0 so Postgres plans it on its own rather than merging
 * it into the aggregate) as one JSON array of arrays in `order`, each row's values in its columns'
 * order, built into facts by `of`. Node parses the one array natively: thousands of rows decoded
 * and mapped field by field cost more than the figures they feed (analytics-explain). JSON keeps
 * what these columns hold (numbers, text, booleans, arrays, jsonb); a timestamp comes as text.
 */
function jsonRows<S extends Subquery, J extends unknown[], T>(
	db: Executor,
	ordered: S,
	order: (columns: S['_']['selectedFields']) => SQLWrapper[],
	of: (row: J) => T
) {
	const columns = ordered._.selectedFields;
	const row = sql.join(Object.values(columns) as SQLWrapper[], sql`, `);
	const by = sql.join(order(columns), sql`, `);
	const rows = sql<J[]>`coalesce(json_agg(json_build_array(${row}) order by ${by}), '[]')`;
	return db.select({ rows: rows.mapWith((value: J[]) => value.map(of)) }).from(ordered as Subquery);
}

/** `ids` as one uuid[] parameter, however many there are, for `column = any(...)`. */
const anyOf = (column: AnyPgColumn, ids: readonly string[]) =>
	sql`${column} = any(${sql.param([...ids])}::uuid[])`;

type SetRecord = typeof setRecords.$inferSelect;

/** A counted set, as setFacts gives it; its exercise's muscles come from exerciseMuscles. */
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
	/** Null: setFacts keeps undeleted sets only. */
	deletedAt: null;
	/** When it last changed: a review's inputs digest notices an edited set. */
	updatedAt: Date;
}

/** One set as setFacts' JSON array carries it: SET_FACT_COLUMNS' values, in order. */
type SetFactJson = [
	number,
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
	string
];

/**
 * The columns of each set, in the order setFactOf reads them (an object's keys keep their order).
 * The id goes as a number (it is a bigint far below 2^53) and sorts as one; deleted_at, null for
 * every set kept, and the exercise's muscles, the same on thousands of sets, are not sent.
 */
const SET_FACT_COLUMNS = {
	id: setRecords.id,
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
	updatedAt: setRecords.updatedAt
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
	updatedAt
]: SetFactJson): SetFactRow {
	// One literal, no spreads: it runs once per set.
	return {
		id: String(id),
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
		deletedAt: null,
		updatedAt: new Date(updatedAt)
	};
}

/**
 * The owner's undeleted sets of counted workouts performed in the range, in the order they were
 * performed.
 * Two years of sets are about 15k rows: Postgres sends them as one JSON array of arrays, which
 * Node parses natively, instead of 15k rows of 19 columns, each decoded and mapped field by field
 * (analytics-explain: that decoding cost more than the rest of the Strength view's 'all'). Each
 * column of each set costs Postgres time to write, so only what the facts read is sent.
 */
export function setFacts(db: Executor, ownerId: string, range: InstantRange) {
	// The rows as the row query reads them, in order (set_records_owner_performed_idx), planned on
	// their own (offset 0 keeps Postgres from merging them into the aggregate, which would sort the
	// built rows whole instead), then built into arrays and aggregated in that order.
	const ordered = db
		.select(SET_FACT_COLUMNS)
		.from(setRecords)
		.innerJoin(workouts, eq(workouts.id, setRecords.workoutId))
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
	return jsonRows(db, ordered, (set) => [set.performedAt, set.id], setFactOf);
}

/** The muscles of these exercises (the ones setFacts' sets name), by primary key. */
export function exerciseMuscles(db: Executor, exerciseIds: readonly string[]) {
	return db
		.select({
			id: exercises.id,
			primaryMuscles: exercises.primaryMuscles,
			secondaryMuscles: exercises.secondaryMuscles
		})
		.from(exercises)
		.where(inArray(exercises.id, [...exerciseIds]));
}

type WorkoutRow = typeof workouts.$inferSelect;
type RunRecordRow = typeof runRecords.$inferSelect;
type OtherRecordRow = typeof otherSessionRecords.$inferSelect;
type SegmentRow = typeof runRecordSegments.$inferSelect;

/** A counted workout with its run or other-session record (null for the other kinds). */
export interface SessionFactRow extends Pick<
	WorkoutRow,
	| 'id'
	| 'kind'
	| 'discipline'
	| 'sessionType'
	| 'title'
	| 'plannedSessionId'
	| 'programId'
	| 'startedAt'
	| 'finishedAt'
	| 'durationSeconds'
	| 'sessionRpe'
> {
	plannedLineage: WorkoutRow['plannedLineageId'];
	/** When it or its record last changed: a review's inputs digest notices an edit. */
	updatedAt: Date;
	run: Pick<RunRecordRow, 'distanceMetres' | 'durationSeconds' | 'avgHr' | 'rpe'> | null;
	other: Pick<OtherRecordRow, 'kind' | 'durationMinutes' | 'rpe' | 'metrics'> | null;
}

/** One workout as sessionFacts' JSON array carries it: its columns' values, in order. */
type SessionFactJson = [
	string,
	WorkoutRow['kind'],
	WorkoutRow['discipline'],
	WorkoutRow['sessionType'],
	string,
	string | null,
	string | null,
	string | null,
	string,
	string | null,
	number | null,
	number | null,
	string,
	string | null,
	number | null,
	number | null,
	number | null,
	number | null,
	OtherRecordRow['kind'] | null,
	number | null,
	number | null,
	OtherRecordRow['metrics'] | null
];

function sessionFactOf([
	id,
	kind,
	discipline,
	sessionType,
	title,
	plannedSessionId,
	plannedLineage,
	programId,
	startedAt,
	finishedAt,
	durationSeconds,
	sessionRpe,
	updatedAt,
	runWorkoutId,
	distanceMetres,
	runSeconds,
	avgHr,
	runRpe,
	otherKind,
	durationMinutes,
	otherRpe,
	metrics
]: SessionFactJson): SessionFactRow {
	return {
		id,
		kind,
		discipline,
		sessionType,
		title,
		plannedSessionId,
		plannedLineage,
		programId,
		startedAt: new Date(startedAt),
		finishedAt: finishedAt === null ? null : new Date(finishedAt),
		durationSeconds,
		sessionRpe,
		updatedAt: new Date(updatedAt),
		// A left join's record: null when the workout has none (its key is null).
		run:
			runWorkoutId === null
				? null
				: { distanceMetres, durationSeconds: runSeconds, avgHr, rpe: runRpe },
		other:
			otherKind === null
				? null
				: { kind: otherKind, durationMinutes: durationMinutes!, rpe: otherRpe, metrics: metrics! }
	};
}

/** The owner's counted workouts started in the range, with their run or other-session record. */
export function sessionFacts(db: Executor, ownerId: string, range: InstantRange) {
	const ordered = db
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
			updatedAt:
				sql<string>`greatest(${workouts.updatedAt}, ${runRecords.updatedAt}, ${otherSessionRecords.updatedAt})`.as(
					'updated_at'
				),
			// The records' columns that share a name with another's are aliased: a subquery names
			// each column once.
			runWorkoutId: sql<string | null>`${runRecords.workoutId}`.as('run_workout_id'),
			runDistanceMetres: runRecords.distanceMetres,
			runDurationSeconds: sql<number | null>`${runRecords.durationSeconds}`.as('run_duration_s'),
			runAvgHr: runRecords.avgHr,
			runRpe: sql<number | null>`${runRecords.rpe}`.as('run_rpe'),
			otherKind: sql<string | null>`${otherSessionRecords.kind}`.as('other_kind'),
			otherDurationMinutes: otherSessionRecords.durationMinutes,
			otherRpe: sql<number | null>`${otherSessionRecords.rpe}`.as('other_rpe'),
			otherMetrics: otherSessionRecords.metrics
		})
		.from(workouts)
		.leftJoin(runRecords, eq(runRecords.workoutId, workouts.id))
		.leftJoin(otherSessionRecords, eq(otherSessionRecords.workoutId, workouts.id))
		.where(and(eq(workouts.ownerId, ownerId), during(workouts.startedAt, range), counted))
		.orderBy(asc(workouts.startedAt), asc(workouts.id))
		.offset(0)
		.as('sessions');
	return jsonRows(db, ordered, (w) => [w.startedAt, w.id], sessionFactOf);
}

/** A run's segment, by its workout. */
export type SegmentFactRow = Pick<
	SegmentRow,
	'workoutId' | 'position' | 'kind' | 'distanceMetres' | 'durationSeconds' | 'avgHr'
>;

type SegmentFactJson = [
	string,
	number,
	SegmentRow['kind'],
	number | null,
	number | null,
	number | null
];

const segmentFactOf = ([
	workoutId,
	position,
	kind,
	distanceMetres,
	durationSeconds,
	avgHr
]: SegmentFactJson): SegmentFactRow => ({
	workoutId,
	position,
	kind,
	distanceMetres,
	durationSeconds,
	avgHr
});

/** These runs' segments, each run's in order, of counted workouts only. */
export function segmentFacts(db: Executor, ownerId: string, workoutIds: readonly string[]) {
	const ordered = db
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
				anyOf(runRecordSegments.workoutId, workoutIds),
				eq(runRecordSegments.ownerId, ownerId),
				counted
			)
		)
		.orderBy(asc(runRecordSegments.workoutId), asc(runRecordSegments.position))
		.offset(0)
		.as('segments');
	return jsonRows(db, ordered, (r) => [r.workoutId, r.position], segmentFactOf);
}

/** One set prescription as prescriptionFacts' JSON array carries it: SET_LINE_COLUMNS, in order. */
type SetLineJson = [
	string,
	SetPrescription['role'],
	number,
	number | null,
	number | null,
	number | null,
	number | null,
	number | null,
	SetPrescription['loadKind'],
	number | null,
	SetPrescription['loadUnit'],
	SetPrescription['loadBasis'],
	number | null,
	SetPrescription['reference1rmUnit'],
	number | null,
	string | null,
	string | null
];

/** A set prescription's planned exercise, then its line, in the order setLineOf reads them. */
const SET_LINE_COLUMNS = {
	plannedExerciseId: setPrescriptions.plannedExerciseId,
	role: setPrescriptions.role,
	sets: setPrescriptions.sets,
	repsMin: setPrescriptions.repsMin,
	repsMax: setPrescriptions.repsMax,
	seconds: setPrescriptions.seconds,
	metres: setPrescriptions.metres,
	targetRpe: setPrescriptions.targetRpe,
	loadKind: setPrescriptions.loadKind,
	loadValue: setPrescriptions.loadValue,
	loadUnit: setPrescriptions.loadUnit,
	loadBasis: setPrescriptions.loadBasis,
	reference1rm: setPrescriptions.reference1rm,
	reference1rmUnit: setPrescriptions.reference1rmUnit,
	restSeconds: setPrescriptions.restSeconds,
	tempo: setPrescriptions.tempo,
	notes: setPrescriptions.notes,
	position: setPrescriptions.position
};

/** A planned exercise's line, keyed by its planned exercise, with the fields SetPrescription has. */
export interface SetLineRow {
	plannedExerciseId: string;
	line: SetPrescription;
}

function setLineOf([
	plannedExerciseId,
	role,
	sets,
	repsMin,
	repsMax,
	seconds,
	metres,
	targetRpe,
	loadKind,
	loadValue,
	loadUnit,
	loadBasis,
	reference1rm,
	reference1rmUnit,
	restSeconds,
	tempo,
	notes
]: SetLineJson): SetLineRow {
	// SetPrescription's fields in the schema's order, as the row's spread used to give them.
	const line: SetPrescription = {
		role,
		sets,
		repsMin,
		repsMax,
		seconds,
		metres,
		targetRpe,
		loadKind,
		loadValue,
		loadUnit,
		loadBasis,
		reference1rm,
		reference1rmUnit,
		restSeconds,
		tempo,
		notes
	};
	return { plannedExerciseId, line };
}

/** One planned exercise as prescriptionFacts' JSON array carries it, its position last. */
type PlannedExerciseJson = [string, string, string, string, number];

/** A planned exercise: what the matching reads of it. */
export interface PlannedExerciseRow {
	id: string;
	sessionId: string;
	lineageId: string;
	exerciseId: string;
}

const plannedExerciseOf = ([id, sessionId, lineageId, exerciseId]: PlannedExerciseJson) =>
	({ id, sessionId, lineageId, exerciseId }) satisfies PlannedExerciseRow;

/**
 * The planned exercises and set prescriptions of these planned sessions: the rows of the version
 * each workout was logged under (workouts.planned_session_id). Of each exercise only what the
 * matching reads (its session, lineage and exercise), without the library names a program screen
 * joins for, since two years of strength sessions plan thousands of them.
 * Each is read as programs.ts's children are (sessionChildren): probed through its parent's index
 * with its parents' ids (an IN list of hundreds of sessions would rather scan the table), the
 * sessions' ids passed as one parameter, and sent as one JSON array (jsonRows).
 */
export function prescriptionFacts(db: Executor, plannedSessionIds: string[]) {
	const sessionIds = db
		.select({ id: plannedSessions.id })
		.from(plannedSessions)
		.where(anyOf(plannedSessions.id, plannedSessionIds));
	const ofSessions = sql`${plannedExercises.sessionId} = any(array(${sessionIds}))`;
	const exerciseRows = db
		.select({
			id: plannedExercises.id,
			sessionId: plannedExercises.sessionId,
			lineageId: plannedExercises.lineageId,
			exerciseId: plannedExercises.exerciseId,
			position: plannedExercises.position
		})
		.from(plannedExercises)
		.where(ofSessions)
		.orderBy(asc(plannedExercises.sessionId), asc(plannedExercises.position))
		.offset(0)
		.as('planned');
	const exerciseIds = db
		.select({ id: plannedExercises.id })
		.from(plannedExercises)
		.where(ofSessions);
	const lineRows = db
		.select(SET_LINE_COLUMNS)
		.from(setPrescriptions)
		.where(sql`${setPrescriptions.plannedExerciseId} = any(array(${exerciseIds}))`)
		.orderBy(asc(setPrescriptions.plannedExerciseId), asc(setPrescriptions.position))
		.offset(0)
		.as('lines');
	return {
		exercises: jsonRows(db, exerciseRows, (e) => [e.sessionId, e.position], plannedExerciseOf),
		sets: jsonRows(db, lineRows, (l) => [l.plannedExerciseId, l.position], setLineOf)
	};
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
 * The input each of a program's generated versions was built from, with the generator that built
 * it, its week 1 Monday and the lineages of the blocks it plans (outlines left out), lowest version
 * first: a block is judged by the first version that planned it.
 */
export function blockInputs(db: Executor, programId: string) {
	return db
		.select({
			number: programVersions.number,
			blockLineage: programBlocks.lineageId,
			input: programVersions.inputSnapshot,
			generator: programVersions.generator,
			startsOn: programVersions.startsOn
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

export type ProgramInRangeRow = Awaited<ReturnType<typeof programsInRange>>[number];
export type RecoveryFactRow = Awaited<ReturnType<typeof recoveryFacts>>[number];
