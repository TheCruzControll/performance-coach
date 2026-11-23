/**
 * Weight-tracking persistence (schema/profile.ts `body_weight_entries`, schema/weight.ts). Plain
 * data access: every method is scoped to one owner. Validation, history and transaction
 * boundaries belong to the services (src/lib/server/services/weight).
 */
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { WeightSource } from '../../../domain/profile/catalog';
import { bodyWeightEntries, weightGoalMilestones, weightGoals } from '../schema';
import type { MilestoneSource, WeightGoalEndReason } from '../schema';
import type { Executor } from '../types';

export type WeightEntryRow = typeof bodyWeightEntries.$inferSelect;
/** The weigh-in a coach write replaced, as the day held it. */
export type WeightReplaced = NonNullable<WeightEntryRow['replaced']>;

/** What a weigh-in write sets. `runId` and `replaced` are set only for a coach write. */
export interface WeightEntryValues {
	value: number;
	unit: 'kg' | 'lb';
	measuredOn: string;
	source: WeightSource;
	runId: string | null;
	replaced: WeightReplaced | null;
}

export type WeightEntryPatch = Partial<WeightEntryValues>;

export type WeightGoalRow = typeof weightGoals.$inferSelect;
export type NewWeightGoal = typeof weightGoals.$inferInsert;
export type WeightMilestoneRow = typeof weightGoalMilestones.$inferSelect;
/** A milestone as the services compute it: its day, weight and how it was made. */
export interface NewWeightMilestone {
	onDate: string;
	weight: number;
	source: MilestoneSource;
}

export function createWeightRepository(db: Executor) {
	return {
		// ---- weigh-ins -----------------------------------------------------------------------
		/**
		 * Record the owner's weigh-in for `values.measuredOn`, replacing the day's entry when it
		 * has one (the unique index allows one per day). The previous entry is read first, locked
		 * until the transaction ends, and returned with the new row. The entry keeps its id and
		 * created_at.
		 */
		async upsertForDay(
			ownerId: string,
			values: WeightEntryValues,
			now: Date
		): Promise<{ entry: WeightEntryRow; previous: WeightEntryRow | null }> {
			const [previous] = await db
				.select()
				.from(bodyWeightEntries)
				.where(
					and(
						eq(bodyWeightEntries.ownerId, ownerId),
						eq(bodyWeightEntries.measuredOn, values.measuredOn)
					)
				)
				.for('update');
			const [entry] = await db
				.insert(bodyWeightEntries)
				.values({ ...values, ownerId, createdAt: now, updatedAt: now })
				.onConflictDoUpdate({
					target: [bodyWeightEntries.ownerId, bodyWeightEntries.measuredOn],
					set: {
						value: values.value,
						unit: values.unit,
						source: values.source,
						runId: values.runId,
						replaced: values.replaced,
						updatedAt: now
					}
				})
				.returning();
			return { entry: entry!, previous: previous ?? null };
		},

		async getById(ownerId: string, id: number): Promise<WeightEntryRow | null> {
			const [row] = await db
				.select()
				.from(bodyWeightEntries)
				.where(and(eq(bodyWeightEntries.ownerId, ownerId), eq(bodyWeightEntries.id, id)));
			return row ?? null;
		},

		/** The owner's weigh-ins from `from` (or the first ever when null) to `to`, oldest first. */
		async listRange(ownerId: string, from: string | null, to: string): Promise<WeightEntryRow[]> {
			return db
				.select()
				.from(bodyWeightEntries)
				.where(
					and(
						eq(bodyWeightEntries.ownerId, ownerId),
						from === null ? undefined : gte(bodyWeightEntries.measuredOn, from),
						lte(bodyWeightEntries.measuredOn, to)
					)
				)
				.orderBy(asc(bodyWeightEntries.measuredOn), asc(bodyWeightEntries.id));
		},

		async update(
			ownerId: string,
			id: number,
			patch: WeightEntryPatch,
			now: Date
		): Promise<WeightEntryRow | null> {
			const [row] = await db
				.update(bodyWeightEntries)
				.set({ ...patch, updatedAt: now })
				.where(and(eq(bodyWeightEntries.ownerId, ownerId), eq(bodyWeightEntries.id, id)))
				.returning();
			return row ?? null;
		},

		async delete(ownerId: string, id: number): Promise<WeightEntryRow | null> {
			const [row] = await db
				.delete(bodyWeightEntries)
				.where(and(eq(bodyWeightEntries.ownerId, ownerId), eq(bodyWeightEntries.id, id)))
				.returning();
			return row ?? null;
		},

		/** The owner's coach-written weigh-ins of the given runs (their Undo cards on reload). */
		async listByRunIds(ownerId: string, runIds: string[]): Promise<WeightEntryRow[]> {
			if (runIds.length === 0) return [];
			return db
				.select()
				.from(bodyWeightEntries)
				.where(
					and(eq(bodyWeightEntries.ownerId, ownerId), inArray(bodyWeightEntries.runId, runIds))
				)
				.orderBy(asc(bodyWeightEntries.measuredOn), asc(bodyWeightEntries.id));
		},

		// ---- goals ---------------------------------------------------------------------------
		async insertGoal(values: NewWeightGoal): Promise<WeightGoalRow> {
			const [row] = await db.insert(weightGoals).values(values).returning();
			return row!;
		},

		/** The owner's one active goal, or null when there is none. */
		async getActiveGoal(ownerId: string): Promise<WeightGoalRow | null> {
			const [row] = await db
				.select()
				.from(weightGoals)
				.where(and(eq(weightGoals.ownerId, ownerId), eq(weightGoals.status, 'active')));
			return row ?? null;
		},

		/** Every goal the owner has had, newest first: the active one and the ended history. */
		async listGoals(ownerId: string): Promise<WeightGoalRow[]> {
			return db
				.select()
				.from(weightGoals)
				.where(eq(weightGoals.ownerId, ownerId))
				.orderBy(desc(weightGoals.createdAt), desc(weightGoals.id));
		},

		/** End the owner's active goal (if any) and return it. The row stays as history. */
		async endActiveGoal(
			ownerId: string,
			reason: WeightGoalEndReason,
			now: Date
		): Promise<WeightGoalRow | null> {
			const [row] = await db
				.update(weightGoals)
				.set({ status: 'ended', endedReason: reason, endedAt: now, updatedAt: now })
				.where(and(eq(weightGoals.ownerId, ownerId), eq(weightGoals.status, 'active')))
				.returning();
			return row ?? null;
		},

		/**
		 * Replace a goal's milestones with `rows`. Returns null, and writes nothing, when the goal
		 * is not the owner's. The caller holds the transaction.
		 */
		async replaceMilestones(
			ownerId: string,
			goalId: string,
			rows: NewWeightMilestone[],
			now: Date
		): Promise<WeightMilestoneRow[] | null> {
			const [goal] = await db
				.select({ id: weightGoals.id })
				.from(weightGoals)
				.where(and(eq(weightGoals.ownerId, ownerId), eq(weightGoals.id, goalId)));
			if (!goal) return null;
			await db
				.delete(weightGoalMilestones)
				.where(
					and(eq(weightGoalMilestones.ownerId, ownerId), eq(weightGoalMilestones.goalId, goalId))
				);
			if (rows.length === 0) return [];
			return db
				.insert(weightGoalMilestones)
				.values(
					rows.map((row) => ({
						...row,
						goalId,
						ownerId,
						createdAt: now,
						updatedAt: now
					}))
				)
				.returning();
		},

		/** A goal's milestones, in date order, when the goal is the owner's. */
		async listMilestones(ownerId: string, goalId: string): Promise<WeightMilestoneRow[]> {
			return db
				.select()
				.from(weightGoalMilestones)
				.where(
					and(eq(weightGoalMilestones.ownerId, ownerId), eq(weightGoalMilestones.goalId, goalId))
				)
				.orderBy(asc(weightGoalMilestones.onDate), asc(weightGoalMilestones.id));
		}
	};
}

export type WeightRepository = ReturnType<typeof createWeightRepository>;
