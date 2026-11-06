/**
 * What a planned session prescribes (M3, PRD §5; ADR 0010), by discipline:
 *
 *   planned_sessions → planned_exercises → set_prescriptions    strength
 *                    → planned_run_segments                      running
 *                    → planned_session_details                   Muay Thai, mobility, S&C, custom
 *
 * Like the program tree, these rows are history: a custom migration
 * (drizzle/<n>_prescription_history_guards.sql) attaches history_refuse_update() and
 * history_refuse_delete() to each table, so an edit copies its week's subtree into a new version
 * (new ids; a planned exercise keeps its lineage_id). Every row reaches its owner through
 * planned_sessions, so the test cleanup clears it. An exercise a plan prescribes or swapped out
 * cannot be deleted (the catalogue retires keys, never deletes them).
 *
 * Columns are named after the contract's fields (domain/training/types.ts): a row without its
 * keys and position is a SetPrescription, a RunSegment or an OtherDetails.
 *
 * The CHECKs agree with the zod schemas (domain/training/schemas.ts) on a row's structure:
 * - each per-row refinement as zod states it: one measure per set, ranges low to high, what each
 *   load kind needs (LOAD_NEEDS) and rpe_based's RPE, repeats with their group, a distance or a
 *   duration, a swap with its reason
 * - each PRESCRIPTION_LIMITS bound, from that table, so a changed limit changes the CHECK too
 * - the closed lists (load kind, load basis, weight units) and the RPE and heart-rate scales.
 * Zod alone holds the open lists (set role, segment and other-session kinds, substitution reason)
 * and M2's lifts; the caps written only in its schemas (a 100 km segment, a 300-minute class,
 * 20 metrics, text lengths), where these CHECKs ask only for positive amounts; and the rules that
 * span rows (a repeat group's segments together, each metric key once, a baseline lift for
 * relative loads).
 */
import { sql } from 'drizzle-orm';
import {
	check,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { WEIGHT_UNITS } from '../../../domain/profile/catalog';
import { LOAD_NEEDS, PRESCRIPTION_LIMITS as L } from '../../../domain/training/schemas';
import type { BaselineLift, CustomMetric, RunSegment } from '../../../domain/training/types';
import {
	LOAD_BASES,
	LOAD_KINDS,
	type LoadBasis,
	type LoadKind,
	type OtherSessionKind,
	type RunSegmentKind,
	type SetRole,
	type SubstitutionReason
} from '../../../domain/training/vocabulary';
import type { WeightUnit } from '../../../domain/units';
import { inList } from './columns';
import { exercises } from './exercises';
import { plannedSessions } from './programs';

/** The 1–10 scale a run segment's or another session's RPE is on, and the heart-rate zones. */
const RPE_SCALE = [1, 10] as const;
const HR_ZONES = [1, 5] as const;

/** RPE in half steps, exact at one decimal. */
const rpe = (name: string) => numeric(name, { precision: 3, scale: 1, mode: 'number' });
/** A computed load or 1RM (0.863 × 0.9 of a 1RM): stored exactly as validated, never rounded. */
const amount = (name: string) => numeric(name, { mode: 'number' });

const num = (n: number) => sql.raw(String(n));
/** Inclusive. Null passes, as a CHECK lets it: whether a value is given is another CHECK's job. */
const within = (column: AnyPgColumn, [min, max]: readonly [number, number]) =>
	sql`${column} between ${num(min)} and ${num(max)}`;
const halfSteps = (column: AnyPgColumn, scale: readonly [number, number]) =>
	sql`${within(column, scale)} and ${column} * 2 = trunc(${column} * 2)`;
/** A weight within L.weight for its unit; an unknown or missing unit is another CHECK's to refuse. */
const weight = (value: AnyPgColumn, unit: AnyPgColumn) =>
	sql`case ${unit} ${sql.join(
		WEIGHT_UNITS.map((u) => sql`when ${sql.raw(`'${u}'`)} then ${within(value, L.weight[u])}`),
		sql` `
	)} else true end`;

/** The load columns LOAD_NEEDS speaks of, so the CHECK below can be built from it. */
type LoadColumns = Record<(typeof LOAD_NEEDS)[LoadKind][number], AnyPgColumn>;

/** Each kind sets exactly the columns LOAD_NEEDS lists; an unknown kind is load_kind_ck's. */
function loadNeeds(kind: AnyPgColumn, columns: LoadColumns) {
	const when = LOAD_KINDS.map((k) => {
		const needs: readonly string[] = LOAD_NEEDS[k];
		const each = Object.entries(columns).map(
			([field, column]) => sql`${column} is ${sql.raw(needs.includes(field) ? 'not null' : 'null')}`
		);
		return sql`when ${sql.raw(`'${k}'`)} then ${sql.join(each, sql` and `)}`;
	});
	return sql`case ${kind} ${sql.join(when, sql` `)} else true end`;
}

/** A strength exercise in a planned session. */
export const plannedExercises = pgTable(
	'planned_exercises',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		sessionId: uuid('session_id')
			.notNull()
			.references(() => plannedSessions.id),
		/** The same for every copy of this exercise across versions: edits and logged sets name it. */
		lineageId: uuid('lineage_id').notNull().defaultRandom(),
		/** 1-based order in the session. */
		position: integer('position').notNull(),
		exerciseId: uuid('exercise_id')
			.notNull()
			.references(() => exercises.id, { onDelete: 'restrict' }),
		/** Exercises with the same superset number alternate (A1, A2); null for straight sets. */
		superset: integer('superset'),
		/** The lift a percent_1rm or from_e1rm set is a fraction of. */
		baselineLift: text('baseline_lift').$type<BaselineLift>(),
		/** What a swap replaced, and why. It stays on the session: it never becomes a preference. */
		substitutedFromExerciseId: uuid('substituted_from_exercise_id').references(() => exercises.id, {
			onDelete: 'restrict'
		}),
		substitutionReason: text('substitution_reason').$type<SubstitutionReason>(),
		instructions: text('instructions'),
		notes: text('notes')
	},
	(t) => [
		uniqueIndex('planned_exercises_session_position_uq').on(t.sessionId, t.position),
		check('planned_exercises_position_ck', sql`${t.position} >= 1`),
		check('planned_exercises_superset_ck', sql`${t.superset} >= 1`),
		check(
			'planned_exercises_substitution_ck',
			sql`(${t.substitutedFromExerciseId} is null) = (${t.substitutionReason} is null)`
		)
	]
);

/** One line of an exercise's prescription: `sets` sets with the same target and load. */
export const setPrescriptions = pgTable(
	'set_prescriptions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		plannedExerciseId: uuid('planned_exercise_id')
			.notNull()
			.references(() => plannedExercises.id),
		/** 1-based order in the exercise. */
		position: integer('position').notNull(),
		role: text('role').$type<SetRole>().notNull(),
		sets: integer('sets').notNull(),
		repsMin: integer('reps_min'),
		repsMax: integer('reps_max'),
		seconds: integer('seconds'),
		metres: integer('metres'),
		targetRpe: rpe('target_rpe'),
		loadKind: text('load_kind').$type<LoadKind>().notNull(),
		loadValue: amount('load_value'),
		loadUnit: text('load_unit').$type<WeightUnit>(),
		loadBasis: text('load_basis').$type<LoadBasis>(),
		reference1rm: amount('reference_1rm'),
		reference1rmUnit: text('reference_1rm_unit').$type<WeightUnit>(),
		restSeconds: integer('rest_seconds'),
		tempo: text('tempo'),
		notes: text('notes')
	},
	(t) => [
		uniqueIndex('set_prescriptions_exercise_position_uq').on(t.plannedExerciseId, t.position),
		check('set_prescriptions_position_ck', sql`${t.position} >= 1`),
		check('set_prescriptions_sets_ck', within(t.sets, L.sets)),
		// Both ends or neither, low to high.
		check(
			'set_prescriptions_reps_ck',
			sql`(${t.repsMin} is null) = (${t.repsMax} is null) and ${t.repsMin} between ${num(L.reps[0])} and ${t.repsMax} and ${t.repsMax} <= ${num(L.reps[1])}`
		),
		check('set_prescriptions_seconds_ck', within(t.seconds, L.seconds)),
		check('set_prescriptions_metres_ck', within(t.metres, L.metres)),
		// Reps, seconds or metres: exactly one.
		check(
			'set_prescriptions_measure_ck',
			sql`num_nonnulls(coalesce(${t.repsMin}, ${t.repsMax}), ${t.seconds}, ${t.metres}) = 1`
		),
		check('set_prescriptions_target_rpe_ck', halfSteps(t.targetRpe, L.rpe)),
		check('set_prescriptions_rest_ck', within(t.restSeconds, L.restSeconds)),
		check('set_prescriptions_tempo_ck', sql`${t.tempo} ~ '^[0-9X]{4}$'`),
		check('set_prescriptions_load_kind_ck', inList('load_kind', LOAD_KINDS)),
		check('set_prescriptions_load_unit_ck', inList('load_unit', WEIGHT_UNITS)),
		check('set_prescriptions_load_basis_ck', inList('load_basis', LOAD_BASES)),
		check('set_prescriptions_reference_1rm_unit_ck', inList('reference_1rm_unit', WEIGHT_UNITS)),
		check(
			'set_prescriptions_load_needs_ck',
			loadNeeds(t.loadKind, {
				loadValue: t.loadValue,
				loadUnit: t.loadUnit,
				loadBasis: t.loadBasis,
				reference1rm: t.reference1rm,
				reference1rmUnit: t.reference1rmUnit
			})
		),
		check(
			'set_prescriptions_rpe_based_ck',
			sql`${t.loadKind} <> 'rpe_based' or ${t.targetRpe} is not null`
		),
		check(
			'set_prescriptions_load_value_ck',
			sql`case ${t.loadKind} when 'absolute' then ${weight(t.loadValue, t.loadUnit)} when 'percent_1rm' then ${within(t.loadValue, L.loadFraction)} when 'from_e1rm' then ${within(t.loadValue, L.loadFraction)} else true end`
		),
		check('set_prescriptions_reference_1rm_ck', weight(t.reference1rm, t.reference1rmUnit))
	]
);

/** One segment of a structured run, in order. */
export const plannedRunSegments = pgTable(
	'planned_run_segments',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		sessionId: uuid('session_id')
			.notNull()
			.references(() => plannedSessions.id),
		/** 1-based order in the run. */
		position: integer('position').notNull(),
		kind: text('kind').$type<RunSegmentKind>().notNull(),
		/** Consecutive segments sharing a group run `repeats` times: 6 × (400 m + 90 s). */
		repeatGroup: integer('repeat_group'),
		repeats: integer('repeats'),
		distanceMetres: integer('distance_m'),
		durationSeconds: integer('duration_s'),
		/** The target pace range in seconds per km, fastest first. */
		paceMinSecondsPerKm: integer('pace_min_s_per_km'),
		paceMaxSecondsPerKm: integer('pace_max_s_per_km'),
		hrZone: integer('hr_zone').$type<NonNullable<RunSegment['hrZone']>>(),
		targetRpe: rpe('target_rpe')
	},
	(t) => [
		uniqueIndex('planned_run_segments_session_position_uq').on(t.sessionId, t.position),
		check('planned_run_segments_position_ck', sql`${t.position} >= 1`),
		// A group comes with its repeats, and repeats at least twice.
		check(
			'planned_run_segments_repeats_ck',
			sql`(${t.repeatGroup} is null) = (${t.repeats} is null) and ${t.repeatGroup} >= 1 and ${t.repeats} >= 2`
		),
		check(
			'planned_run_segments_measure_ck',
			sql`${t.distanceMetres} is not null or ${t.durationSeconds} is not null`
		),
		check('planned_run_segments_distance_ck', sql`${t.distanceMetres} >= 1`),
		check('planned_run_segments_duration_ck', sql`${t.durationSeconds} >= 1`),
		check(
			'planned_run_segments_pace_ck',
			sql`(${t.paceMinSecondsPerKm} is null) = (${t.paceMaxSecondsPerKm} is null) and ${t.paceMinSecondsPerKm} between 1 and ${t.paceMaxSecondsPerKm}`
		),
		check('planned_run_segments_hr_zone_ck', within(t.hrZone, HR_ZONES)),
		check('planned_run_segments_target_rpe_ck', halfSteps(t.targetRpe, RPE_SCALE))
	]
);

/** What a Muay Thai, mobility, S&C or custom session prescribes: one row per session. */
export const plannedSessionDetails = pgTable(
	'planned_session_details',
	{
		sessionId: uuid('session_id')
			.primaryKey()
			.references(() => plannedSessions.id),
		kind: text('kind').$type<OtherSessionKind>().notNull(),
		durationMinutes: integer('duration_minutes').notNull(),
		targetRpe: rpe('target_rpe'),
		/** What the owner tracks (rounds, sparring); its items are customMetricsSchema's to check. */
		metrics: jsonb('metrics')
			.$type<CustomMetric[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		notes: text('notes')
	},
	(t) => [
		check('planned_session_details_duration_ck', sql`${t.durationMinutes} >= 1`),
		check('planned_session_details_target_rpe_ck', halfSteps(t.targetRpe, RPE_SCALE)),
		check('planned_session_details_metrics_ck', sql`jsonb_typeof(${t.metrics}) = 'array'`)
	]
);
