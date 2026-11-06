/**
 * The exercise library (M3, PRD §5): one table for two kinds of row.
 * - Catalogue rows have a `key` and no owner. They are seeded from CATALOGUE
 *   (src/lib/domain/exercises) by every migrate run (../seed/exercises.ts): changed entries are
 *   updated in place, removed keys are retired (retired_at), never deleted, so ids stay stable.
 * - Custom rows have an `owner_id` and no key: the owner's own exercises.
 *
 * owner_id deliberately has no foreign key to owners. The integration suite's withCommitted
 * cleanup clears owners with CASCADE, and a foreign key would empty the whole library in the
 * middle of the suite. Every query scopes custom rows to their owner, and the owner row is never
 * deleted (auth:reset-owner keeps it).
 *
 * CHECKs cover the closed vocabularies (skill level, measure, load type) and coherence only.
 * Pattern, muscles, equipment, tags and disciplines are open lists, validated by parseTable for
 * the catalogue and by the services for custom rows.
 */
import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import type { Discipline, Equipment, Lift } from '../../../domain/profile/catalog';
import {
	LOAD_TYPES,
	MEASURES,
	SKILL_LEVELS,
	type ExerciseTag,
	type LoadType,
	type Measure,
	type MovementPattern,
	type Muscle,
	type SkillLevel
} from '../../../domain/training/vocabulary';
import { createdAt, inList, updatedAt } from './columns';

const emptyList = sql`'{}'::text[]`;

export const exercises = pgTable(
	'exercises',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		/** The catalogue key (snake_case); null on custom rows. */
		key: text('key'),
		/** The owner of a custom row (no foreign key, see above); null on catalogue rows. */
		ownerId: uuid('owner_id'),
		name: text('name').notNull(),
		aliases: text('aliases').array().notNull().default(emptyList),
		pattern: text('pattern').$type<MovementPattern>().notNull(),
		primaryMuscles: text('primary_muscles').array().$type<Muscle[]>().notNull(),
		secondaryMuscles: text('secondary_muscles')
			.array()
			.$type<Muscle[]>()
			.notNull()
			.default(emptyList),
		/** Every item is required; empty means bodyweight only. */
		equipment: text('equipment').array().$type<Equipment[]>().notNull().default(emptyList),
		disciplines: text('disciplines').array().$type<Discipline[]>().notNull().default(emptyList),
		tags: text('tags').array().$type<ExerciseTag[]>().notNull().default(emptyList),
		/** One side at a time; reps and seconds are then per side. */
		unilateral: boolean('unilateral').notNull().default(false),
		skillLevel: text('skill_level').$type<SkillLevel>().notNull(),
		measure: text('measure').$type<Measure>().notNull(),
		loadType: text('load_type').$type<LoadType>().notNull(),
		repMin: integer('rep_min'),
		repMax: integer('rep_max'),
		/** One bout or hold of a time-measured exercise. */
		defaultSeconds: integer('default_seconds'),
		substitutionGroup: text('substitution_group'),
		/** The M2 lift whose baseline this exercise is. */
		baselineLift: text('baseline_lift').$type<Exclude<Lift, 'custom'>>(),
		/** Set when a catalogue key leaves the catalogue; the row stays readable by id. */
		retiredAt: timestamp('retired_at', { withTimezone: true }),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('exercises_key_uq').on(t.key),
		uniqueIndex('exercises_owner_name_uq')
			.on(t.ownerId, sql`lower(${t.name})`)
			.where(sql`${t.ownerId} is not null`),
		index('exercises_substitution_group_idx').on(t.substitutionGroup),
		index('exercises_pattern_idx').on(t.pattern),
		check('exercises_kind_ck', sql`(${t.key} is null) = (${t.ownerId} is not null)`),
		check('exercises_name_ck', sql`char_length(${t.name}) > 0`),
		check('exercises_primary_muscles_ck', sql`cardinality(${t.primaryMuscles}) > 0`),
		check('exercises_skill_level_ck', inList('skill_level', SKILL_LEVELS)),
		check('exercises_measure_ck', inList('measure', MEASURES)),
		check('exercises_load_type_ck', inList('load_type', LOAD_TYPES)),
		// Both bounds or neither, 1 ≤ min ≤ max.
		check(
			'exercises_reps_ck',
			sql`(${t.repMin} is null and ${t.repMax} is null) or (${t.repMin} is not null and ${t.repMax} is not null and ${t.repMin} between 1 and ${t.repMax})`
		),
		// Required for the time measure, and at least a second when set.
		check(
			'exercises_seconds_ck',
			sql`(${t.defaultSeconds} is null and ${t.measure} <> 'time') or (${t.defaultSeconds} is not null and ${t.defaultSeconds} >= 1)`
		)
	]
);
