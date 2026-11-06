/**
 * Exercise library persistence (schema/exercises.ts): catalogue rows (a key, no owner) and the
 * owner's custom rows (an owner, no key). Plain data access: validation and the library's rules
 * belong to src/lib/server/services/exercises.
 *
 * owner_id has no foreign key, so the owner scope in every query that can return a custom row
 * is the only thing keeping one owner's exercises from another's.
 */
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { MovementPattern } from '../../../domain/training/vocabulary';
import { exercises } from '../schema';
import type { Executor } from '../types';

export type ExerciseRow = typeof exercises.$inferSelect;

/** Every content column the owner sets on a custom exercise (all but key and lift). */
export type CustomExerciseValues = Required<
	Omit<
		typeof exercises.$inferInsert,
		'id' | 'key' | 'ownerId' | 'baselineLift' | 'retiredAt' | 'createdAt' | 'updatedAt'
	>
>;

/** Narrows a list to one movement pattern or substitution group (both indexed). */
export interface ExerciseFilter {
	pattern?: MovementPattern;
	substitutionGroup?: string;
}

/** Advisory-lock key for changes to one owner's custom exercises (727101–727107 are M2's). */
const CUSTOM_EXERCISES_LOCK = 727201;

/** The catalogue's rows and this owner's own, never another owner's. */
const visibleTo = (ownerId: string) =>
	or(isNull(exercises.ownerId), eq(exercises.ownerId, ownerId));

const byName = [asc(exercises.name), asc(exercises.id)];

export function createExercisesRepository(db: Executor) {
	return {
		/** The live library: catalogue rows and the owner's own, retired rows left out. */
		async listLive(ownerId: string, filter: ExerciseFilter = {}): Promise<ExerciseRow[]> {
			return db
				.select()
				.from(exercises)
				.where(
					and(
						visibleTo(ownerId),
						isNull(exercises.retiredAt),
						filter.pattern ? eq(exercises.pattern, filter.pattern) : undefined,
						filter.substitutionGroup
							? eq(exercises.substitutionGroup, filter.substitutionGroup)
							: undefined
					)
				)
				.orderBy(...byName);
		},

		/** The owner's live custom exercises. */
		async listCustom(ownerId: string): Promise<ExerciseRow[]> {
			return db
				.select()
				.from(exercises)
				.where(and(eq(exercises.ownerId, ownerId), isNull(exercises.retiredAt)))
				.orderBy(...byName);
		},

		/** Rows by id, retired ones included; `ids` must be well-formed uuids. */
		async byIds(ownerId: string, ids: readonly string[]): Promise<ExerciseRow[]> {
			if (ids.length === 0) return [];
			return db
				.select()
				.from(exercises)
				.where(and(inArray(exercises.id, [...ids]), visibleTo(ownerId)));
		},

		/** Catalogue rows by key. */
		async byKeys(
			keys: readonly string[],
			{ includeRetired = false }: { includeRetired?: boolean } = {}
		): Promise<ExerciseRow[]> {
			if (keys.length === 0) return [];
			return db
				.select()
				.from(exercises)
				.where(
					and(
						inArray(exercises.key, [...keys]),
						includeRetired ? undefined : isNull(exercises.retiredAt)
					)
				);
		},

		/**
		 * The owner's exercise called `name`, live or retired, compared as the unique index on
		 * (owner_id, lower(name)) compares names.
		 */
		async findCustomByName(ownerId: string, name: string): Promise<ExerciseRow | null> {
			const [row] = await db
				.select()
				.from(exercises)
				.where(and(eq(exercises.ownerId, ownerId), sql`lower(${exercises.name}) = lower(${name})`));
			return row ?? null;
		},

		/** Serialise changes to this owner's custom exercises within the current transaction. */
		async lockCustom(ownerId: string): Promise<void> {
			await db.execute(
				sql`select pg_advisory_xact_lock(${CUSTOM_EXERCISES_LOCK}, hashtext(${ownerId}))`
			);
		},

		async insertCustom(
			ownerId: string,
			values: CustomExerciseValues,
			now: Date
		): Promise<ExerciseRow> {
			const [row] = await db
				.insert(exercises)
				.values({ ...values, ownerId, createdAt: now, updatedAt: now })
				.returning();
			return row!;
		},

		/** Give a retired custom exercise a new definition and bring it back, keeping its id. */
		async restoreCustom(
			ownerId: string,
			id: string,
			values: CustomExerciseValues,
			now: Date
		): Promise<ExerciseRow> {
			const [row] = await db
				.update(exercises)
				.set({ ...values, retiredAt: null, updatedAt: now })
				.where(and(eq(exercises.id, id), eq(exercises.ownerId, ownerId)))
				.returning();
			return row!;
		},

		/** Retire one of the owner's live exercises; null when no live one has that id. */
		async retireCustom(ownerId: string, id: string, now: Date): Promise<ExerciseRow | null> {
			const [row] = await db
				.update(exercises)
				.set({ retiredAt: now, updatedAt: now })
				.where(
					and(eq(exercises.id, id), eq(exercises.ownerId, ownerId), isNull(exercises.retiredAt))
				)
				.returning();
			return row ?? null;
		}
	};
}
