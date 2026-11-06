/**
 * The training log (PRD §7, §9; M3 designs it, M4 writes it): what the owner actually did.
 *
 *   workouts → set_records                              strength
 *            → run_records → run_record_segments        running
 *            → other_session_records                    Muay Thai, mobility, S&C, custom
 *            → workout_substitutions                    in-workout swaps, on the session only
 *   recovery_notes                                      a day's sleep, soreness, energy, stress
 *   training_audit                                      every edit of the rows above
 *
 * Body weight stays in M2's body_weight_entries. A workout names the planned session it was
 * logged from and its lineage, so 'completed' carries across versions; logging creates none.
 *
 * - Every row carries owner_id (ownerRef): the test cleanup clears it with the owner, the audit
 *   trigger reads it from the row, and an export is owner-scoped.
 * - A row a device creates carries its device id (client_id, client_mutation_id) under a unique
 *   index, so a replayed create is a conflict the service turns into a no-op (m3/30); a 1:1
 *   record is unique by its workout.
 * - Rows are append-only except for audited edits (drizzle/<n>_training_log_guards.sql): an
 *   UPDATE that changes a row stamps updated_at and writes training_audit, with the actor from
 *   AUDIT_ACTOR_SETTING; one that changes nothing leaves no trace. DELETE is refused: workouts
 *   and sets are deleted softly (deleted_at). Only test and reset code bypasses this (ADR 0010).
 * - The generated columns use M1's exact factor: weight_kg beside the weight and unit as
 *   entered, and the pace of each run and segment.
 * - CHECKs cover the closed lists, the scales (RPE 1–10 in half steps, heart rate, recovery 1–5)
 *   and coherence; amounts need only be positive. Discipline, session type, segment and
 *   other-session kinds and substitution reasons are open lists that the services validate.
 * - Reps are the reps completed, as the metrics' LoggedSet has them; missed reps are attempts
 *   that failed, so a missed single is 0 reps and 1 missed. A set row is a LoggedSet (its
 *   exercise by id) and a workout row a LoggedSessionLoad.
 * - The history indexes are the ones the history queries (m3/26) use and db:explain (m3/33)
 *   measures. Descending columns are DESC NULLS FIRST, the order `order by … desc` asks for
 *   (drizzle's bare .desc() writes NULLS LAST, which such a query cannot use), and a query
 *   repeats its partial index's predicate. A workout's soft delete does not reach its sets, so
 *   whatever deletes a workout deletes its sets too: set history filters on its own deleted_at.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { WEIGHT_UNITS, type Discipline } from '../../../domain/profile/catalog';
import type { CustomMetric, SessionKind } from '../../../domain/training/types';
import {
	DECIDERS,
	type Decider,
	type OtherSessionKind,
	type RunSegmentKind,
	type SessionType,
	type SubstitutionReason
} from '../../../domain/training/vocabulary';
import { KG_PER_LB, type WeightUnit } from '../../../domain/units';
import { createdAt, inList, ownerRef, updatedAt } from './columns';
import { exercises } from './exercises';
import { plannedSessions, programs } from './programs';

/** Closed: what a logged session is made of, the plan's three session kinds. */
export const WORKOUT_KINDS = ['strength', 'run', 'other'] as const satisfies readonly SessionKind[];
export type WorkoutKind = (typeof WORKOUT_KINDS)[number];

/** Closed: a workout's lifecycle. Only an in-progress workout has no finish. */
export const WORKOUT_STATUSES = ['in_progress', 'completed', 'abandoned'] as const;
export type WorkoutStatus = (typeof WORKOUT_STATUSES)[number];

/** Closed: what an audited UPDATE did. A soft delete sets deleted_at; a restore clears it. */
export const AUDIT_ACTIONS = ['update', 'delete', 'restore'] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * The setting the audit trigger reads its actor from (one of DECIDERS; 'owner' when unset). A
 * service acting for someone else sets it for its transaction only:
 * `select set_config('app.actor', 'coach', true)`.
 */
export const AUDIT_ACTOR_SETTING = 'app.actor';

/** RPE on the 1–10 scale in half steps; heart rate in beats per minute; recovery scales 1–5. */
const RPE_SCALE = [1, 10] as const;
const HEART_RATE = [20, 250] as const;
const RECOVERY_SCALE = [1, 5] as const;
const SLEEP_HOURS = [0, 24] as const;

/** Kilograms per unit: M1's exact factors (domain/units.ts). */
const KG_PER_UNIT: Readonly<Record<WeightUnit, number>> = { kg: 1, lb: KG_PER_LB };

/** RPE, exact at one decimal. */
const rpe = (name: string) => numeric(name, { precision: 3, scale: 1, mode: 'number' });
/** An exact amount (metres converted from miles, a computed e1RM): stored as given. */
const amount = (name: string) => numeric(name, { mode: 'number' });
const deletedAt = () => timestamp('deleted_at', { withTimezone: true });

const num = (n: number) => sql.raw(String(n));
const keyOf = (value: string) => sql.raw(`'${value}'`);
/** Inclusive. Null passes, as a CHECK lets it: whether a value is given is another CHECK's job. */
const within = (column: AnyPgColumn, [min, max]: readonly [number, number]) =>
	sql`${column} between ${num(min)} and ${num(max)}`;
const halfSteps = (column: AnyPgColumn) =>
	sql`${within(column, RPE_SCALE)} and ${column} * 2 = trunc(${column} * 2)`;

/** A weight in kg through each unit's factor; null with no weight. */
const inKg = (weight: AnyPgColumn, unit: AnyPgColumn): SQL =>
	sql`case ${unit} ${sql.join(
		WEIGHT_UNITS.map((u) => {
			const factor = KG_PER_UNIT[u];
			return sql`when ${keyOf(u)} then ${factor === 1 ? weight : sql`${weight} * ${num(factor)}`}`;
		}),
		sql` `
	)} end`;

/** Seconds per km; null until both are known. A 0 m distance is its CHECK's to refuse. */
const pace = (durationSeconds: AnyPgColumn, distanceMetres: AnyPgColumn): SQL =>
	sql`case when ${distanceMetres} > 0 then ${durationSeconds} * 1000.0 / ${distanceMetres} end`;

/** One logged session, of any discipline. */
export const workouts = pgTable(
	'workouts',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		/** The device's id for the workout, so a replayed start never makes a second one. */
		clientId: uuid('client_id').notNull(),
		kind: text('kind').$type<WorkoutKind>().notNull(),
		discipline: text('discipline').$type<Discipline>().notNull(),
		sessionType: text('session_type').$type<SessionType>().notNull(),
		title: text('title').notNull(),
		/** The planned session it was logged from, in the version current then; null off plan. */
		plannedSessionId: uuid('planned_session_id').references(() => plannedSessions.id),
		/** That session's lineage: 'completed' is derived by it, across versions. */
		plannedLineageId: uuid('planned_lineage_id'),
		programId: uuid('program_id').references(() => programs.id),
		status: text('status').$type<WorkoutStatus>().notNull().default('in_progress'),
		startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
		finishedAt: timestamp('finished_at', { withTimezone: true }),
		/** Time spent training, pauses left out; null until known. */
		durationSeconds: integer('duration_s'),
		sessionRpe: rpe('session_rpe'),
		notes: text('notes'),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		deletedAt: deletedAt()
	},
	(t) => [
		uniqueIndex('workouts_client_id_uq').on(t.clientId),
		// Sessions by date, newest first; runs by week for the mileage; 'completed' by lineage.
		index('workouts_owner_started_idx')
			.on(t.ownerId, t.startedAt.desc().nullsFirst())
			.where(sql`${t.deletedAt} is null`),
		index('workouts_owner_kind_started_idx')
			.on(t.ownerId, t.kind, t.startedAt)
			.where(sql`${t.deletedAt} is null`),
		index('workouts_planned_lineage_idx').on(t.plannedLineageId),
		check('workouts_kind_ck', inList('kind', WORKOUT_KINDS)),
		check('workouts_status_ck', inList('status', WORKOUT_STATUSES)),
		check('workouts_title_ck', sql`char_length(${t.title}) > 0`),
		// A planned session comes with its lineage and its program.
		check(
			'workouts_plan_ck',
			sql`(${t.plannedSessionId} is null) = (${t.plannedLineageId} is null) and (${t.plannedSessionId} is null or ${t.programId} is not null)`
		),
		check('workouts_finished_ck', sql`(${t.status} = 'in_progress') = (${t.finishedAt} is null)`),
		check('workouts_times_ck', sql`${t.finishedAt} >= ${t.startedAt}`),
		check('workouts_duration_ck', sql`${t.durationSeconds} >= 1`),
		check('workouts_session_rpe_ck', halfSteps(t.sessionRpe))
	]
);

/** One set of a strength exercise, as performed. */
export const setRecords = pgTable(
	'set_records',
	{
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		ownerId: ownerRef(),
		clientMutationId: uuid('client_mutation_id').notNull(),
		workoutId: uuid('workout_id')
			.notNull()
			.references(() => workouts.id),
		exerciseId: uuid('exercise_id')
			.notNull()
			.references(() => exercises.id, { onDelete: 'restrict' }),
		/** The planned exercise it performs (its lineage); null off plan. */
		plannedExerciseLineageId: uuid('planned_exercise_lineage_id'),
		/** 1-based: the exercise's place in the workout, the set's in the exercise. */
		exercisePosition: integer('exercise_position').notNull(),
		setIndex: integer('set_index').notNull(),
		/** As entered, in the unit entered; null for a set with no load. */
		weight: numeric('weight', { precision: 6, scale: 2, mode: 'number' }),
		unit: text('unit').$type<WeightUnit>().notNull(),
		weightKg: amount('weight_kg').generatedAlwaysAs((): SQL =>
			inKg(setRecords.weight, setRecords.unit)
		),
		/** Completed; null for a set measured in time or distance. */
		reps: integer('reps'),
		/** Attempted and failed. */
		missedReps: integer('missed_reps').notNull().default(0),
		seconds: integer('seconds'),
		metres: integer('metres'),
		rpe: rpe('rpe'),
		isWarmup: boolean('is_warmup').notNull().default(false),
		isExtra: boolean('is_extra').notNull().default(false),
		isSkipped: boolean('is_skipped').notNull().default(false),
		/** The set's e1RM in kg when logged (the metrics' setE1rm), worked out again on each edit. */
		e1rmKg: amount('e1rm_kg'),
		performedAt: timestamp('performed_at', { withTimezone: true }).notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		deletedAt: deletedAt()
	},
	(t) => [
		uniqueIndex('set_records_client_mutation_id_uq').on(t.clientMutationId),
		// An exercise's history, newest first (keyset on performed_at, id), and its last sessions.
		index('set_records_exercise_history_idx')
			.on(t.ownerId, t.exerciseId, t.performedAt.desc().nullsFirst(), t.id.desc().nullsFirst())
			.where(sql`${t.deletedAt} is null`),
		// Best e1RM: e1rm_kg is set on working sets only.
		index('set_records_exercise_e1rm_idx')
			.on(t.ownerId, t.exerciseId, t.e1rmKg.desc().nullsFirst())
			.where(sql`${t.e1rmKg} is not null and ${t.deletedAt} is null`),
		// The heaviest working set at each rep count.
		index('set_records_exercise_rep_max_idx')
			.on(t.ownerId, t.exerciseId, t.reps, t.weightKg.desc().nullsFirst())
			.where(
				sql`${t.deletedAt} is null and not ${t.isWarmup} and not ${t.isSkipped} and ${t.weightKg} is not null`
			),
		// Sets in a date range (weekly volume per muscle group).
		index('set_records_owner_performed_idx').on(t.ownerId, t.performedAt),
		// A workout's sets in order.
		index('set_records_workout_order_idx').on(t.workoutId, t.exercisePosition, t.setIndex),
		check('set_records_exercise_position_ck', sql`${t.exercisePosition} >= 1`),
		check('set_records_set_index_ck', sql`${t.setIndex} >= 1`),
		check('set_records_unit_ck', inList('unit', WEIGHT_UNITS)),
		check('set_records_weight_ck', sql`${t.weight} > 0`),
		check('set_records_reps_ck', sql`${t.reps} >= 0`),
		// Missed reps only where reps are counted.
		check(
			'set_records_missed_reps_ck',
			sql`${t.missedReps} >= 0 and (${t.missedReps} = 0 or ${t.reps} is not null)`
		),
		check('set_records_seconds_ck', sql`${t.seconds} >= 1`),
		check('set_records_metres_ck', sql`${t.metres} >= 1`),
		check('set_records_rpe_ck', halfSteps(t.rpe)),
		// As setE1rm: a warm-up or a skipped set has no e1RM. (Spelled out for null: in SQL,
		// null and false is false.)
		check(
			'set_records_e1rm_ck',
			sql`${t.e1rmKg} is null or (${t.e1rmKg} > 0 and not ${t.isWarmup} and not ${t.isSkipped})`
		)
	]
);

/** A run's totals: one record per run workout. Each total may wait until the run ends. */
export const runRecords = pgTable(
	'run_records',
	{
		workoutId: uuid('workout_id')
			.primaryKey()
			.references(() => workouts.id),
		ownerId: ownerRef(),
		/** Exact metres: miles convert through M1's toMetres (5 mi is 8046.72 m). */
		distanceMetres: amount('distance_m'),
		durationSeconds: integer('duration_s'),
		paceSecondsPerKm: amount('pace_s_per_km').generatedAlwaysAs((): SQL =>
			pace(runRecords.durationSeconds, runRecords.distanceMetres)
		),
		/** Average heart rate, when the owner has it. */
		avgHr: integer('avg_hr'),
		rpe: rpe('rpe'),
		notes: text('notes'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		check('run_records_distance_ck', sql`${t.distanceMetres} > 0`),
		check('run_records_duration_ck', sql`${t.durationSeconds} >= 1`),
		check('run_records_avg_hr_ck', within(t.avgHr, HEART_RATE)),
		check('run_records_rpe_ck', halfSteps(t.rpe))
	]
);

/** One segment of a run as run (a warm-up, each interval and recovery, a cool-down), in order. */
export const runRecordSegments = pgTable(
	'run_record_segments',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		clientMutationId: uuid('client_mutation_id').notNull(),
		workoutId: uuid('workout_id')
			.notNull()
			.references(() => runRecords.workoutId),
		/** 1-based order in the run. */
		position: integer('position').notNull(),
		kind: text('kind').$type<RunSegmentKind>().notNull(),
		distanceMetres: amount('distance_m'),
		durationSeconds: integer('duration_s'),
		paceSecondsPerKm: amount('pace_s_per_km').generatedAlwaysAs((): SQL =>
			pace(runRecordSegments.durationSeconds, runRecordSegments.distanceMetres)
		),
		avgHr: integer('avg_hr'),
		rpe: rpe('rpe'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('run_record_segments_client_mutation_id_uq').on(t.clientMutationId),
		index('run_record_segments_run_order_idx').on(t.workoutId, t.position),
		check('run_record_segments_position_ck', sql`${t.position} >= 1`),
		check(
			'run_record_segments_measure_ck',
			sql`${t.distanceMetres} is not null or ${t.durationSeconds} is not null`
		),
		check('run_record_segments_distance_ck', sql`${t.distanceMetres} > 0`),
		check('run_record_segments_duration_ck', sql`${t.durationSeconds} >= 1`),
		check('run_record_segments_avg_hr_ck', within(t.avgHr, HEART_RATE)),
		check('run_record_segments_rpe_ck', halfSteps(t.rpe))
	]
);

/** What a Muay Thai, mobility, S&C or custom session was: one record per workout. */
export const otherSessionRecords = pgTable(
	'other_session_records',
	{
		workoutId: uuid('workout_id')
			.primaryKey()
			.references(() => workouts.id),
		ownerId: ownerRef(),
		kind: text('kind').$type<OtherSessionKind>().notNull(),
		durationMinutes: integer('duration_minutes').notNull(),
		rpe: rpe('rpe'),
		/** What the owner tracked (rounds, sparring); its items are customMetricsSchema's to check. */
		metrics: jsonb('metrics')
			.$type<CustomMetric[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		notes: text('notes'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		check('other_session_records_duration_ck', sql`${t.durationMinutes} >= 1`),
		check('other_session_records_rpe_ck', halfSteps(t.rpe)),
		check('other_session_records_metrics_ck', sql`jsonb_typeof(${t.metrics}) = 'array'`)
	]
);

/** How the owner felt on a day; any of it may be left out, not all of it. */
export const recoveryNotes = pgTable(
	'recovery_notes',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		clientMutationId: uuid('client_mutation_id').notNull(),
		/** The owner's calendar day (localDay in the profile's time zone). */
		notedOn: date('noted_on', { mode: 'string' }).notNull(),
		sleepHours: numeric('sleep_hours', { precision: 3, scale: 1, mode: 'number' }),
		/** 1 (none, low) to 5 (very sore, very high). */
		soreness: integer('soreness'),
		energy: integer('energy'),
		stress: integer('stress'),
		note: text('note'),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('recovery_notes_client_mutation_id_uq').on(t.clientMutationId),
		check('recovery_notes_sleep_ck', within(t.sleepHours, SLEEP_HOURS)),
		check('recovery_notes_soreness_ck', within(t.soreness, RECOVERY_SCALE)),
		check('recovery_notes_energy_ck', within(t.energy, RECOVERY_SCALE)),
		check('recovery_notes_stress_ck', within(t.stress, RECOVERY_SCALE)),
		check('recovery_notes_note_ck', sql`char_length(${t.note}) > 0`),
		check(
			'recovery_notes_content_ck',
			sql`num_nonnulls(${t.sleepHours}, ${t.soreness}, ${t.energy}, ${t.stress}, ${t.note}) > 0`
		)
	]
);

/**
 * An exercise swapped in a workout. It stays on the session: it never becomes an exercise
 * preference, whatever its reason (only an explicit 'never prescribe this again' does).
 */
export const workoutSubstitutions = pgTable(
	'workout_substitutions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		clientMutationId: uuid('client_mutation_id').notNull(),
		workoutId: uuid('workout_id')
			.notNull()
			.references(() => workouts.id),
		/** The planned exercise it replaced (its lineage); null off plan. */
		plannedExerciseLineageId: uuid('planned_exercise_lineage_id'),
		fromExerciseId: uuid('from_exercise_id')
			.notNull()
			.references(() => exercises.id, { onDelete: 'restrict' }),
		toExerciseId: uuid('to_exercise_id')
			.notNull()
			.references(() => exercises.id, { onDelete: 'restrict' }),
		reason: text('reason').$type<SubstitutionReason>().notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('workout_substitutions_client_mutation_id_uq').on(t.clientMutationId),
		check('workout_substitutions_exercises_ck', sql`${t.fromExerciseId} <> ${t.toExerciseId}`)
	]
);

/**
 * Every UPDATE that changed a logged row, written by the audit trigger: the row before and after
 * (as to_jsonb), by whom, and when (the updated_at the edit gave the row). Never changed or
 * deleted. A row is named by its table and its key as text (a set's bigint, a 1:1 record's
 * workout id, any other row's uuid).
 */
export const trainingAudit = pgTable(
	'training_audit',
	{
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		ownerId: ownerRef(),
		tableName: text('table_name').notNull(),
		rowId: text('row_id').notNull(),
		action: text('action').$type<AuditAction>().notNull(),
		before: jsonb('before').$type<Record<string, unknown>>().notNull(),
		after: jsonb('after').$type<Record<string, unknown>>().notNull(),
		actor: text('actor').$type<Decider>().notNull(),
		changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [
		index('training_audit_row_idx').on(t.ownerId, t.tableName, t.rowId),
		check('training_audit_action_ck', inList('action', AUDIT_ACTIONS)),
		check('training_audit_actor_ck', inList('actor', DECIDERS))
	]
);
