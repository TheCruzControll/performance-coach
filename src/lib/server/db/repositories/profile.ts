/**
 * Training-profile persistence (schema/profile.ts). Plain data access: validation, history and
 * transaction boundaries belong to the services (src/lib/server/services/profile).
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import {
	athleteProfiles,
	bodyWeightEntries,
	disciplineExperience,
	equipmentProfiles,
	exercisePreferences,
	injuries,
	muayThaiProfiles,
	owners,
	raceResults,
	runningProfiles,
	scheduleCommitments,
	schedules,
	strengthBaselines,
	trainingGoalEvents,
	trainingGoals
} from '../schema';
import type { Executor } from '../types';

export type AthleteProfileRow = typeof athleteProfiles.$inferSelect;
export type BodyWeightRow = typeof bodyWeightEntries.$inferSelect;
export type GoalRow = typeof trainingGoals.$inferSelect;
export type NewGoal = typeof trainingGoals.$inferInsert;
export type GoalEventRow = typeof trainingGoalEvents.$inferSelect;
export type NewGoalEvent = typeof trainingGoalEvents.$inferInsert;
export type ExperienceRow = typeof disciplineExperience.$inferSelect;
export type NewExperience = typeof disciplineExperience.$inferInsert;
export type BaselineRow = typeof strengthBaselines.$inferSelect;
export type NewBaseline = typeof strengthBaselines.$inferInsert;
export type RunningRow = typeof runningProfiles.$inferSelect;
export type RaceRow = typeof raceResults.$inferSelect;
export type NewRace = typeof raceResults.$inferInsert;
export type MuayThaiRow = typeof muayThaiProfiles.$inferSelect;
export type EquipmentRow = typeof equipmentProfiles.$inferSelect;
export type InjuryRow = typeof injuries.$inferSelect;
export type NewInjury = typeof injuries.$inferInsert;
export type ExercisePreferenceRow = typeof exercisePreferences.$inferSelect;
export type NewExercisePreference = typeof exercisePreferences.$inferInsert;
export type ScheduleRow = typeof schedules.$inferSelect;
export type CommitmentRow = typeof scheduleCommitments.$inferSelect;
export type NewCommitment = typeof scheduleCommitments.$inferInsert;

type ProfilePatch = Partial<Omit<typeof athleteProfiles.$inferInsert, 'ownerId' | 'createdAt'>>;

/** Columns of a one-row-per-owner table that a save may set. */
type Upsert<T extends { $inferInsert: unknown }> = Omit<
	T['$inferInsert'],
	'ownerId' | 'createdAt' | 'updatedAt'
>;

export function createProfileRepository(db: Executor) {
	return {
		// ---- athlete profile -----------------------------------------------------------------
		async getProfile(ownerId: string): Promise<AthleteProfileRow | null> {
			const [row] = await db
				.select()
				.from(athleteProfiles)
				.where(eq(athleteProfiles.ownerId, ownerId));
			return row ?? null;
		},

		/** Create the profile (named after the owner) unless it exists; returns it either way. */
		async ensureProfile(ownerId: string): Promise<AthleteProfileRow> {
			const existing = await this.getProfile(ownerId);
			if (existing) return existing;
			await db.execute(sql`
				insert into ${athleteProfiles} (owner_id, name)
				select ${owners.id}, ${owners.displayName} from ${owners} where ${owners.id} = ${ownerId}
				on conflict (owner_id) do nothing`);
			const row = await this.getProfile(ownerId);
			if (!row) throw new Error('ensureProfile: unknown owner');
			return row;
		},

		async updateProfile(ownerId: string, patch: ProfilePatch, now: Date) {
			const [row] = await db
				.update(athleteProfiles)
				.set({ ...patch, updatedAt: now })
				.where(eq(athleteProfiles.ownerId, ownerId))
				.returning();
			return row ?? null;
		},

		// ---- body weight ---------------------------------------------------------------------
		async insertBodyWeight(values: typeof bodyWeightEntries.$inferInsert) {
			const [row] = await db.insert(bodyWeightEntries).values(values).returning();
			return row!;
		},

		/** Replace the entry for a day (one weigh-in per day from forms). */
		async upsertBodyWeightForDay(values: typeof bodyWeightEntries.$inferInsert) {
			await db
				.delete(bodyWeightEntries)
				.where(
					and(
						eq(bodyWeightEntries.ownerId, values.ownerId),
						eq(bodyWeightEntries.measuredOn, values.measuredOn),
						eq(bodyWeightEntries.source, values.source)
					)
				);
			return this.insertBodyWeight(values);
		},

		async listBodyWeight(ownerId: string, limit = 30): Promise<BodyWeightRow[]> {
			return db
				.select()
				.from(bodyWeightEntries)
				.where(eq(bodyWeightEntries.ownerId, ownerId))
				.orderBy(desc(bodyWeightEntries.measuredOn), desc(bodyWeightEntries.id))
				.limit(limit);
		},

		// ---- goals ---------------------------------------------------------------------------
		/** Open goals by rank, then closed goals (most recently closed first). */
		async listGoals(ownerId: string): Promise<GoalRow[]> {
			return db
				.select()
				.from(trainingGoals)
				.where(eq(trainingGoals.ownerId, ownerId))
				.orderBy(
					sql`${trainingGoals.priority} asc nulls last`,
					desc(trainingGoals.closedAt),
					asc(trainingGoals.createdAt)
				);
		},

		async getGoal(ownerId: string, id: string): Promise<GoalRow | null> {
			const [row] = await db
				.select()
				.from(trainingGoals)
				.where(and(eq(trainingGoals.ownerId, ownerId), eq(trainingGoals.id, id)));
			return row ?? null;
		},

		/** Serialise goal ranking changes for this owner within the current transaction. */
		async lockGoals(ownerId: string): Promise<void> {
			await db.execute(sql`select pg_advisory_xact_lock(727101, hashtext(${ownerId}))`);
		},

		async insertGoal(values: NewGoal): Promise<GoalRow> {
			const [row] = await db.insert(trainingGoals).values(values).returning();
			return row!;
		},

		async updateGoal(
			ownerId: string,
			id: string,
			patch: Partial<Omit<NewGoal, 'id' | 'ownerId' | 'createdAt'>>
		): Promise<GoalRow | null> {
			const [row] = await db
				.update(trainingGoals)
				.set(patch)
				.where(and(eq(trainingGoals.ownerId, ownerId), eq(trainingGoals.id, id)))
				.returning();
			return row ?? null;
		},

		async deleteGoal(ownerId: string, id: string): Promise<GoalRow | null> {
			const [row] = await db
				.delete(trainingGoals)
				.where(and(eq(trainingGoals.ownerId, ownerId), eq(trainingGoals.id, id)))
				.returning();
			return row ?? null;
		},

		/**
		 * Rewrite open-goal ranks to 1..n in the given order. Two passes keep the partial unique
		 * index on (owner_id, priority) satisfied at every statement.
		 */
		async setPriorities(ownerId: string, orderedIds: string[], now: Date): Promise<void> {
			if (orderedIds.length === 0) return;
			await db
				.update(trainingGoals)
				.set({ priority: sql`${trainingGoals.priority} + 100000` })
				.where(and(eq(trainingGoals.ownerId, ownerId), isNotNull(trainingGoals.priority)));
			const cases = sql.join(
				orderedIds.map((id, i) => sql`when ${id}::uuid then ${i + 1}::int`),
				sql` `
			);
			await db
				.update(trainingGoals)
				.set({ priority: sql`case ${trainingGoals.id} ${cases} end`, updatedAt: now })
				.where(and(eq(trainingGoals.ownerId, ownerId), inArray(trainingGoals.id, orderedIds)));
		},

		async insertGoalEvents(events: NewGoalEvent[]): Promise<void> {
			if (events.length) await db.insert(trainingGoalEvents).values(events);
		},

		async listGoalEvents(ownerId: string, limit = 100): Promise<GoalEventRow[]> {
			return db
				.select()
				.from(trainingGoalEvents)
				.where(eq(trainingGoalEvents.ownerId, ownerId))
				.orderBy(desc(trainingGoalEvents.occurredAt), desc(trainingGoalEvents.id))
				.limit(limit);
		},

		// ---- experience ----------------------------------------------------------------------
		async listExperience(ownerId: string): Promise<ExperienceRow[]> {
			return db
				.select()
				.from(disciplineExperience)
				.where(eq(disciplineExperience.ownerId, ownerId))
				.orderBy(asc(disciplineExperience.createdAt), asc(disciplineExperience.discipline));
		},

		/** Upsert by (discipline, label) — ids and created_at survive — and drop the rest. */
		async replaceExperience(ownerId: string, rows: Omit<NewExperience, 'ownerId'>[], now: Date) {
			const kept: string[] = [];
			for (const row of rows) {
				const [saved] = await db
					.insert(disciplineExperience)
					.values({ ...row, ownerId, updatedAt: now })
					.onConflictDoUpdate({
						target: [
							disciplineExperience.ownerId,
							disciplineExperience.discipline,
							disciplineExperience.customLabel
						],
						set: {
							level: row.level,
							years: row.years ?? null,
							sessionsPerWeek: row.sessionsPerWeek ?? null,
							notes: row.notes ?? null,
							updatedAt: now
						}
					})
					.returning({ id: disciplineExperience.id });
				kept.push(saved!.id);
			}
			await db
				.delete(disciplineExperience)
				.where(
					and(
						eq(disciplineExperience.ownerId, ownerId),
						kept.length ? notInArray(disciplineExperience.id, kept) : undefined
					)
				);
		},

		// ---- strength baselines --------------------------------------------------------------
		async listCurrentBaselines(ownerId: string): Promise<BaselineRow[]> {
			return db
				.select()
				.from(strengthBaselines)
				.where(and(eq(strengthBaselines.ownerId, ownerId), isNull(strengthBaselines.supersededAt)))
				.orderBy(asc(strengthBaselines.recordedAt), asc(strengthBaselines.lift));
		},

		async listBaselineHistory(ownerId: string): Promise<BaselineRow[]> {
			return db
				.select()
				.from(strengthBaselines)
				.where(eq(strengthBaselines.ownerId, ownerId))
				.orderBy(desc(strengthBaselines.recordedAt));
		},

		async supersedeBaselines(ownerId: string, ids: string[], now: Date): Promise<void> {
			if (!ids.length) return;
			await db
				.update(strengthBaselines)
				.set({ supersededAt: now })
				.where(and(eq(strengthBaselines.ownerId, ownerId), inArray(strengthBaselines.id, ids)));
		},

		async insertBaselines(rows: NewBaseline[]): Promise<void> {
			if (rows.length) await db.insert(strengthBaselines).values(rows);
		},

		// ---- running & Muay Thai -------------------------------------------------------------
		async getRunning(ownerId: string): Promise<RunningRow | null> {
			const [row] = await db
				.select()
				.from(runningProfiles)
				.where(eq(runningProfiles.ownerId, ownerId));
			return row ?? null;
		},

		async upsertRunning(ownerId: string, values: Upsert<typeof runningProfiles>, now: Date) {
			await db
				.insert(runningProfiles)
				.values({ ...values, ownerId, updatedAt: now })
				.onConflictDoUpdate({
					target: runningProfiles.ownerId,
					set: { ...values, updatedAt: now }
				});
		},

		async deleteRunning(ownerId: string): Promise<void> {
			await db.delete(runningProfiles).where(eq(runningProfiles.ownerId, ownerId));
			await db.delete(raceResults).where(eq(raceResults.ownerId, ownerId));
		},

		async listRaces(ownerId: string): Promise<RaceRow[]> {
			return db
				.select()
				.from(raceResults)
				.where(eq(raceResults.ownerId, ownerId))
				.orderBy(asc(raceResults.distanceMetres), desc(raceResults.racedOn));
		},

		async replaceRaces(ownerId: string, rows: Omit<NewRace, 'ownerId'>[]): Promise<void> {
			await db.delete(raceResults).where(eq(raceResults.ownerId, ownerId));
			if (rows.length) await db.insert(raceResults).values(rows.map((r) => ({ ...r, ownerId })));
		},

		async getMuayThai(ownerId: string): Promise<MuayThaiRow | null> {
			const [row] = await db
				.select()
				.from(muayThaiProfiles)
				.where(eq(muayThaiProfiles.ownerId, ownerId));
			return row ?? null;
		},

		async upsertMuayThai(ownerId: string, values: Upsert<typeof muayThaiProfiles>, now: Date) {
			await db
				.insert(muayThaiProfiles)
				.values({ ...values, ownerId, updatedAt: now })
				.onConflictDoUpdate({
					target: muayThaiProfiles.ownerId,
					set: { ...values, updatedAt: now }
				});
		},

		async deleteMuayThai(ownerId: string): Promise<void> {
			await db.delete(muayThaiProfiles).where(eq(muayThaiProfiles.ownerId, ownerId));
		},

		// ---- equipment -----------------------------------------------------------------------
		async getEquipment(ownerId: string): Promise<EquipmentRow | null> {
			const [row] = await db
				.select()
				.from(equipmentProfiles)
				.where(eq(equipmentProfiles.ownerId, ownerId));
			return row ?? null;
		},

		async upsertEquipment(ownerId: string, values: Upsert<typeof equipmentProfiles>, now: Date) {
			await db
				.insert(equipmentProfiles)
				.values({ ...values, ownerId, updatedAt: now })
				.onConflictDoUpdate({
					target: equipmentProfiles.ownerId,
					set: { ...values, updatedAt: now }
				});
		},

		// ---- injuries ------------------------------------------------------------------------
		async listInjuries(ownerId: string): Promise<InjuryRow[]> {
			return db
				.select()
				.from(injuries)
				.where(eq(injuries.ownerId, ownerId))
				.orderBy(desc(injuries.active), asc(injuries.createdAt));
		},

		async insertInjury(values: NewInjury): Promise<InjuryRow> {
			const [row] = await db.insert(injuries).values(values).returning();
			return row!;
		},

		async updateInjury(
			ownerId: string,
			id: string,
			patch: Partial<Omit<NewInjury, 'id' | 'ownerId' | 'createdAt'>>
		): Promise<InjuryRow | null> {
			const [row] = await db
				.update(injuries)
				.set(patch)
				.where(and(eq(injuries.ownerId, ownerId), eq(injuries.id, id)))
				.returning();
			return row ?? null;
		},

		async deleteInjuriesExcept(ownerId: string, keep: string[]): Promise<void> {
			await db
				.delete(injuries)
				.where(
					and(
						eq(injuries.ownerId, ownerId),
						keep.length ? notInArray(injuries.id, keep) : undefined
					)
				);
		},

		// ---- exercise likes & dislikes -------------------------------------------------------
		async listExercisePreferences(ownerId: string): Promise<ExercisePreferenceRow[]> {
			return db
				.select()
				.from(exercisePreferences)
				.where(eq(exercisePreferences.ownerId, ownerId))
				.orderBy(asc(exercisePreferences.sentiment), asc(exercisePreferences.createdAt));
		},

		/** Match by exercise name (case-insensitive) so ids and created_at survive; drop the rest. */
		async replaceExercisePreferences(
			ownerId: string,
			rows: Omit<NewExercisePreference, 'ownerId'>[],
			now: Date
		): Promise<void> {
			const existing = new Map(
				(await this.listExercisePreferences(ownerId)).map((r) => [r.exercise.toLowerCase(), r])
			);
			const kept: string[] = [];
			for (const row of rows) {
				const match = existing.get(row.exercise.toLowerCase());
				if (match) {
					kept.push(match.id);
					await db
						.update(exercisePreferences)
						.set({
							exercise: row.exercise,
							sentiment: row.sentiment,
							reason: row.reason ?? null,
							updatedAt: now
						})
						.where(eq(exercisePreferences.id, match.id));
				} else {
					const [saved] = await db
						.insert(exercisePreferences)
						.values({ ...row, ownerId, createdAt: now, updatedAt: now })
						.returning({ id: exercisePreferences.id });
					kept.push(saved!.id);
				}
			}
			await db
				.delete(exercisePreferences)
				.where(
					and(
						eq(exercisePreferences.ownerId, ownerId),
						kept.length ? notInArray(exercisePreferences.id, kept) : undefined
					)
				);
		},

		// ---- schedule ------------------------------------------------------------------------
		async getSchedule(ownerId: string): Promise<ScheduleRow | null> {
			const [row] = await db.select().from(schedules).where(eq(schedules.ownerId, ownerId));
			return row ?? null;
		},

		async upsertSchedule(ownerId: string, values: Upsert<typeof schedules>, now: Date) {
			await db
				.insert(schedules)
				.values({ ...values, ownerId, updatedAt: now })
				.onConflictDoUpdate({ target: schedules.ownerId, set: { ...values, updatedAt: now } });
		},

		async listCommitments(ownerId: string): Promise<CommitmentRow[]> {
			return db
				.select()
				.from(scheduleCommitments)
				.where(eq(scheduleCommitments.ownerId, ownerId))
				.orderBy(asc(scheduleCommitments.createdAt));
		},

		async insertCommitment(values: NewCommitment): Promise<CommitmentRow> {
			const [row] = await db.insert(scheduleCommitments).values(values).returning();
			return row!;
		},

		async updateCommitment(
			ownerId: string,
			id: string,
			patch: Partial<Omit<NewCommitment, 'id' | 'ownerId' | 'createdAt'>>
		): Promise<CommitmentRow | null> {
			const [row] = await db
				.update(scheduleCommitments)
				.set(patch)
				.where(and(eq(scheduleCommitments.ownerId, ownerId), eq(scheduleCommitments.id, id)))
				.returning();
			return row ?? null;
		},

		async deleteCommitmentsExcept(ownerId: string, keep: string[]): Promise<void> {
			await db
				.delete(scheduleCommitments)
				.where(
					and(
						eq(scheduleCommitments.ownerId, ownerId),
						keep.length ? notInArray(scheduleCommitments.id, keep) : undefined
					)
				);
		}
	};
}

export type ProfileRepository = ReturnType<typeof createProfileRepository>;
