/**
 * Programs (M3, PRD §4–5; ADR 0010). A program is a head row pointing at its current version.
 * Versions are immutable, and so is everything they contain:
 *
 *   programs → program_versions → (program_version_blocks) → program_blocks
 *                               → (program_version_weeks)  → program_weeks → planned_sessions
 *
 * A version's tree is its membership rows. An edit is copy-on-write at week granularity: a new
 * version, copies of the affected week subtrees (new ids, same lineage_id) and every other
 * membership row reused. Screens address rows by lineage_id, which survives edits.
 *
 * Triggers from a custom migration (drizzle/<n>_program_history_guards.sql) refuse UPDATE and
 * DELETE on every table here; a program may change only its status, archived_at and a forward
 * current_version_id. Every table reaches owners through foreign keys (programs.owner_id or a
 * parent), so deleting the owner row is refused. M2's mutable rows (goals, commitments) are
 * referenced by uuid with no foreign key, so no SET NULL or CASCADE can ever trip a guard.
 *
 * CHECKs cover closed vocabularies and structure only. Phase, week kind, session type, decision
 * kind and rule key are open lists (domain/training/vocabulary.ts) that the services validate.
 */
import { sql } from 'drizzle-orm';
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
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import type { Discipline, TimeOfDay } from '../../../domain/profile/catalog';
import {
	DECIDERS,
	PLAN_STATUSES,
	SESSION_INTENSITIES,
	type DecisionKind,
	type Decider,
	type Phase,
	type PlanStatus,
	type SessionIntensity,
	type SessionType,
	type WeekKind
} from '../../../domain/training/vocabulary';
import { createdAt, inList, ownerRef } from './columns';

export const PROGRAM_STATUSES = ['active', 'archived'] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

/** Free-form structured data (progression rules, week targets, decision evidence). */
type Json = Record<string, unknown>;

/** The head of a program: the one row that changes, and only as the guard allows. */
export const programs = pgTable(
	'programs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		title: text('title').notNull(),
		status: text('status').$type<ProgramStatus>().notNull().default('active'),
		/**
		 * The current version. Null only while version 1 is being stored; from then on it moves
		 * forward (compare-and-set in the revising transaction), to one of this program's versions.
		 */
		currentVersionId: uuid('current_version_id').references((): AnyPgColumn => programVersions.id),
		createdAt: createdAt(),
		archivedAt: timestamp('archived_at', { withTimezone: true })
	},
	(t) => [
		uniqueIndex('programs_owner_active_uq')
			.on(t.ownerId)
			.where(sql`${t.status} = 'active'`),
		check('programs_status_ck', inList('status', PROGRAM_STATUSES)),
		check('programs_archived_ck', sql`(${t.status} = 'archived') = (${t.archivedAt} is not null)`),
		check('programs_title_ck', sql`char_length(${t.title}) > 0`)
	]
);

export const programVersions = pgTable(
	'program_versions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		programId: uuid('program_id')
			.notNull()
			.references(() => programs.id),
		/** 1, 2, 3… within the program; history pages by it. */
		number: integer('number').notNull(),
		parentVersionId: uuid('parent_version_id').references((): AnyPgColumn => programVersions.id),
		createdBy: text('created_by').$type<Decider>().notNull(),
		/** What this version changed, in a sentence. */
		summary: text('summary').notNull(),
		/** The generator id, input fingerprint, catalogue digest and input that built it, if any. */
		generator: text('generator'),
		inputFingerprint: text('input_fingerprint'),
		catalogueDigest: text('catalogue_digest'),
		inputSnapshot: jsonb('input_snapshot').$type<Json>(),
		/** The Monday of week 1, and the first day with planned sessions (today, for 'This week'). */
		startsOn: date('starts_on', { mode: 'string' }).notNull(),
		firstPlannedDay: date('first_planned_day', { mode: 'string' }).notNull(),
		createdAt: createdAt()
	},
	(t) => [
		uniqueIndex('program_versions_program_number_uq').on(t.programId, t.number),
		check('program_versions_number_ck', sql`${t.number} >= 1`),
		check('program_versions_parent_ck', sql`(${t.number} = 1) = (${t.parentVersionId} is null)`),
		check('program_versions_created_by_ck', inList('created_by', DECIDERS)),
		check('program_versions_summary_ck', sql`char_length(${t.summary}) > 0`),
		check(
			'program_versions_first_planned_day_ck',
			sql`${t.firstPlannedDay} between ${t.startsOn} and ${t.startsOn} + 6`
		)
	]
);

/** A block (cycle) of the program, shared by every version whose membership lists it. */
export const programBlocks = pgTable(
	'program_blocks',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		programId: uuid('program_id')
			.notNull()
			.references(() => programs.id),
		/** The same for every copy of this block across versions. */
		lineageId: uuid('lineage_id').notNull().defaultRandom(),
		/** 1-based order in the program. */
		position: integer('position').notNull(),
		phase: text('phase').$type<Phase>().notNull(),
		name: text('name').notNull(),
		startsOn: date('starts_on', { mode: 'string' }).notNull(),
		endsOn: date('ends_on', { mode: 'string' }).notNull(),
		/** Shape only (phase and dates): its weeks are planned when the block before it ends. */
		outline: boolean('outline').notNull().default(false),
		/** The M2 training goals the block serves (no foreign key: goals are mutable). */
		goalRefs: uuid('goal_refs')
			.array()
			.notNull()
			.default(sql`'{}'::uuid[]`),
		/** Progression rules as data (load, RPE and volume targets), for M4 and M6 to adapt. */
		progression: jsonb('progression').$type<Json>()
	},
	(t) => [
		check('program_blocks_position_ck', sql`${t.position} >= 1`),
		check('program_blocks_dates_ck', sql`${t.endsOn} >= ${t.startsOn}`),
		check('program_blocks_name_ck', sql`char_length(${t.name}) > 0`)
	]
);

export const programVersionBlocks = pgTable(
	'program_version_blocks',
	{
		versionId: uuid('version_id')
			.notNull()
			.references(() => programVersions.id),
		blockId: uuid('block_id')
			.notNull()
			.references(() => programBlocks.id)
	},
	(t) => [primaryKey({ name: 'program_version_blocks_pk', columns: [t.versionId, t.blockId] })]
);

/** A Monday-to-Sunday week of a block. */
export const programWeeks = pgTable(
	'program_weeks',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		blockId: uuid('block_id')
			.notNull()
			.references(() => programBlocks.id),
		lineageId: uuid('lineage_id').notNull().defaultRandom(),
		/** 1-based week of the block. */
		indexInBlock: integer('index_in_block').notNull(),
		startsOn: date('starts_on', { mode: 'string' }).notNull(),
		endsOn: date('ends_on', { mode: 'string' }).notNull(),
		kind: text('kind').$type<WeekKind>().notNull(),
		/** The week's targets as data (hard sets, run volume, intensity). */
		targets: jsonb('targets').$type<Json>()
	},
	(t) => [
		check('program_weeks_index_ck', sql`${t.indexInBlock} >= 1`),
		check('program_weeks_span_ck', sql`${t.endsOn} = ${t.startsOn} + 6`)
	]
);

export const programVersionWeeks = pgTable(
	'program_version_weeks',
	{
		versionId: uuid('version_id')
			.notNull()
			.references(() => programVersions.id),
		weekId: uuid('week_id')
			.notNull()
			.references(() => programWeeks.id)
	},
	(t) => [
		primaryKey({ name: 'program_version_weeks_pk', columns: [t.versionId, t.weekId] }),
		index('program_version_weeks_week_idx').on(t.weekId)
	]
);

/**
 * A planned session. Its status is planned, skipped or moved; skip and move are owner edits, so
 * each creates a version. 'Completed' is never stored: reads derive it from a logged workout.
 */
export const plannedSessions = pgTable(
	'planned_sessions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		weekId: uuid('week_id')
			.notNull()
			.references(() => programWeeks.id),
		lineageId: uuid('lineage_id').notNull().defaultRandom(),
		scheduledOn: date('scheduled_on', { mode: 'string' }).notNull(),
		timeOfDay: text('time_of_day').$type<TimeOfDay>(),
		/** 1-based order among the day's sessions. */
		orderInDay: integer('order_in_day').notNull().default(1),
		discipline: text('discipline').$type<Discipline>().notNull(),
		customDiscipline: text('custom_discipline'),
		sessionType: text('session_type').$type<SessionType>().notNull(),
		title: text('title').notNull(),
		estMinutes: integer('est_minutes').notNull(),
		/** Estimated session load: target RPE × minutes, in arbitrary units (M1's sessionLoad). */
		estLoad: numeric('est_load', { precision: 6, scale: 1, mode: 'number' }),
		intensity: text('intensity').$type<SessionIntensity>().notNull(),
		targetRpe: numeric('target_rpe', { precision: 3, scale: 1, mode: 'number' }),
		status: text('status').$type<PlanStatus>().notNull().default('planned'),
		/** The date the session was planned on before a move. */
		movedFrom: date('moved_from', { mode: 'string' }),
		/** Where it came from (a rule, a commitment, the owner). Open; validated by the services. */
		source: text('source').notNull(),
		/** The M2 schedule commitment it stands for (no foreign key: commitments are mutable). */
		commitmentRef: uuid('commitment_ref'),
		instructions: text('instructions'),
		notes: text('notes')
	},
	(t) => [
		index('planned_sessions_week_day_idx').on(t.weekId, t.scheduledOn, t.orderInDay),
		index('planned_sessions_lineage_idx').on(t.lineageId),
		check('planned_sessions_order_ck', sql`${t.orderInDay} >= 1`),
		check('planned_sessions_title_ck', sql`char_length(${t.title}) > 0`),
		check('planned_sessions_est_minutes_ck', sql`${t.estMinutes} > 0`),
		check('planned_sessions_est_load_ck', sql`${t.estLoad} >= 0`),
		check('planned_sessions_intensity_ck', inList('intensity', SESSION_INTENSITIES)),
		check('planned_sessions_target_rpe_ck', sql`${t.targetRpe} between 0 and 10`),
		check('planned_sessions_status_ck', inList('status', PLAN_STATUSES)),
		check('planned_sessions_moved_ck', sql`${t.status} <> 'moved' or ${t.movedFrom} is not null`)
	]
);

/** Why the program is what it is: one row per non-trivial choice, by the rules, coach or owner. */
export const programmingDecisions = pgTable(
	'programming_decisions',
	{
		/** Identity, so decisions written in one transaction keep their order. */
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		programId: uuid('program_id')
			.notNull()
			.references(() => programs.id),
		/** The version the decision produced. */
		versionId: uuid('version_id')
			.notNull()
			.references(() => programVersions.id),
		kind: text('kind').$type<DecisionKind>().notNull(),
		/** The rule that made it, for 'rules' decisions (e.g. a key in rules/<area>.ts). */
		ruleKey: text('rule_key'),
		/** What was decided. */
		summary: text('summary').notNull(),
		/** Why, in words the owner reads; never empty. */
		why: text('why').notNull(),
		decidedBy: text('decided_by').$type<Decider>().notNull(),
		/** The lineage ids of the blocks, weeks and sessions it touched. */
		affected: jsonb('affected')
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'::jsonb`),
		/** The inputs the decision read (a goal, a baseline, a day count). */
		evidence: jsonb('evidence').$type<Json>(),
		createdAt: createdAt()
	},
	(t) => [
		index('programming_decisions_program_idx').on(t.programId, t.createdAt.desc(), t.id.desc()),
		index('programming_decisions_version_idx').on(t.versionId),
		check('programming_decisions_decided_by_ck', inList('decided_by', DECIDERS)),
		check('programming_decisions_summary_ck', sql`char_length(${t.summary}) > 0`),
		check('programming_decisions_why_ck', sql`char_length(${t.why}) > 0`)
	]
);
