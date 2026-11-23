/**
 * Weight goals (PRD weight tracking): the owner's target weight and its dates, and the milestones
 * along the way. The weigh-ins themselves are `body_weight_entries` (schema/profile.ts), one per
 * owner per day. A goal is never edited in place: a new one ends the active goal, which stays in
 * the history. Only the services write these tables (src/lib/server/services/weight).
 */
import { sql } from 'drizzle-orm';
import {
	bigint,
	check,
	date,
	index,
	numeric,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import { WEIGHT_SOURCES, type WeightSource } from '../../../domain/profile/catalog';
import { createdAt, inList, ownerRef, updatedAt } from './columns';
import { WEIGHT_UNIT_VALUES } from './profile';

/** Weights: up to 9999.99 in the unit the goal was entered in (never converted, so never rounded). */
const weight = (name: string) => numeric(name, { precision: 6, scale: 2, mode: 'number' });

export const WEIGHT_GOAL_STATUSES = ['active', 'ended'] as const;
export type WeightGoalStatus = (typeof WEIGHT_GOAL_STATUSES)[number];
/** `replaced`: a newer goal took its place. `cleared`: the owner removed the goal. */
export const WEIGHT_GOAL_END_REASONS = ['replaced', 'cleared'] as const;
export type WeightGoalEndReason = (typeof WEIGHT_GOAL_END_REASONS)[number];
/** `generated`: the default for its date and weight. `edited`: the owner moved it. */
export const MILESTONE_SOURCES = ['generated', 'edited'] as const;
export type MilestoneSource = (typeof MILESTONE_SOURCES)[number];

export const weightGoals = pgTable(
	'weight_goals',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		/** The unit the goal was entered in. Its milestones use the same unit. */
		unit: text('unit').$type<'kg' | 'lb'>().notNull(),
		startOn: date('start_on', { mode: 'string' }).notNull(),
		startWeight: weight('start_weight').notNull(),
		targetWeight: weight('target_weight').notNull(),
		targetOn: date('target_on', { mode: 'string' }).notNull(),
		status: text('status').$type<WeightGoalStatus>().notNull().default('active'),
		endedReason: text('ended_reason').$type<WeightGoalEndReason>(),
		endedAt: timestamp('ended_at', { withTimezone: true }),
		source: text('source').$type<WeightSource>().notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		// At most one active goal per owner; ended goals stay as history.
		uniqueIndex('weight_goals_owner_active_uq')
			.on(t.ownerId)
			.where(sql`${t.status} = 'active'`),
		index('weight_goals_owner_idx').on(t.ownerId, t.createdAt.desc()),
		check('weight_goals_unit_ck', inList('unit', WEIGHT_UNIT_VALUES)),
		check('weight_goals_status_ck', inList('status', WEIGHT_GOAL_STATUSES)),
		check('weight_goals_ended_reason_ck', inList('ended_reason', WEIGHT_GOAL_END_REASONS)),
		check('weight_goals_source_ck', inList('source', WEIGHT_SOURCES)),
		check('weight_goals_start_weight_ck', sql`${t.startWeight} > 0`),
		check('weight_goals_target_weight_ck', sql`${t.targetWeight} > 0`),
		check('weight_goals_target_on_ck', sql`${t.targetOn} > ${t.startOn}`),
		check('weight_goals_ended_at_ck', sql`(${t.status} = 'active') = (${t.endedAt} is null)`),
		check(
			'weight_goals_ended_reason_pair_ck',
			sql`(${t.endedAt} is null) = (${t.endedReason} is null)`
		)
	]
);

/**
 * A milestone on a goal's line: the weight the owner expects to reach on a day strictly between
 * the goal's start and target (the services check the dates). Deleting a goal deletes its
 * milestones.
 */
export const weightGoalMilestones = pgTable(
	'weight_goal_milestones',
	{
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		goalId: uuid('goal_id')
			.notNull()
			.references(() => weightGoals.id, { onDelete: 'cascade' }),
		ownerId: ownerRef(),
		onDate: date('on_date', { mode: 'string' }).notNull(),
		weight: weight('weight').notNull(),
		source: text('source').$type<MilestoneSource>().notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('weight_goal_milestones_goal_day_uq').on(t.goalId, t.onDate),
		check('weight_goal_milestones_weight_ck', sql`${t.weight} > 0`),
		check('weight_goal_milestones_source_ck', inList('source', MILESTONE_SOURCES))
	]
);
