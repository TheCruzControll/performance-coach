/**
 * The exercise library on real Postgres: every migrate run (the global setup's included) seeds
 * the catalogue from CATALOGUE idempotently, retires removed keys and restores re-added ones with
 * stable ids, never touches custom rows, and survives withCommitted's cleanup because custom rows
 * have no foreign key to owners.
 */
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { CATALOGUE, type CatalogueExercise } from '../../../src/lib/domain/exercises/index';
import { exercises, getDb, type Executor } from '../../../src/lib/server/db';
import * as schema from '../../../src/lib/server/db/schema';
import { seedExerciseCatalogue } from '../../../src/lib/server/db/seed/exercises';
import { withCommitted } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const ROLLBACK = Symbol('rollback');
const NOTHING = { inserted: 0, updated: 0, retired: 0, restored: 0 };

/**
 * Run `fn` in a transaction that is always rolled back, on a client of its own, so the seed's
 * raw `query` and drizzle's reads share it and the shared catalogue rows never change.
 */
async function inSeedTransaction(fn: (client: pg.Client, db: Executor) => Promise<void>) {
	const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();
	try {
		await drizzle({ client, schema }).transaction(async (tx) => {
			await fn(client, tx);
			throw ROLLBACK;
		});
	} catch (err) {
		if (err !== ROLLBACK) throw err;
	} finally {
		await client.end();
	}
}

/** The fields CATALOGUE defines, which are the table's column names. */
const FIELDS = Object.keys(CATALOGUE[0]!) as (keyof CatalogueExercise)[];

const byKey = (a: { key: string | null }, b: { key: string | null }) => (a.key! < b.key! ? -1 : 1);

/** The catalogue rows as their definitions, sorted by key (in JS, whatever the collation). */
async function storedCatalogue(db: Executor) {
	const rows = await db.select().from(exercises).where(isNotNull(exercises.key));
	return rows
		.sort(byKey)
		.map((row) => Object.fromEntries(FIELDS.map((field) => [field, row[field]])));
}

async function catalogueRow(db: Executor, key: string) {
	const [row] = await db.select().from(exercises).where(eq(exercises.key, key));
	return row!;
}

/** Every catalogue row's id and timestamps, which a seed that changes nothing leaves alone. */
async function catalogueStamps(db: Executor) {
	return db
		.select({ id: exercises.id, key: exercises.key, updatedAt: exercises.updatedAt })
		.from(exercises)
		.where(isNotNull(exercises.key))
		.orderBy(asc(exercises.key));
}

const customExercise = (ownerId: string, overrides: Partial<typeof exercises.$inferInsert> = {}) =>
	({
		ownerId,
		name: 'Kettlebell suitcase march',
		pattern: 'carry',
		primaryMuscles: ['obliques', 'forearms'],
		equipment: ['kettlebells'],
		skillLevel: 'intermediate',
		measure: 'reps',
		loadType: 'external',
		repMin: 3,
		repMax: 5,
		...overrides
	}) satisfies typeof exercises.$inferInsert;

/** The constraint `insert` violates. It runs in a savepoint, so the transaction carries on. */
async function refusal(db: Executor, values: typeof exercises.$inferInsert) {
	const error = await db
		.transaction((sp) => sp.insert(exercises).values(values))
		.then(
			() => null,
			(err: unknown) => err
		);
	if (!error) throw new Error('expected the insert to be refused');
	// Drizzle wraps the driver's error, which is its cause.
	return (error as { cause?: { constraint?: string } }).cause?.constraint;
}

describe('the exercise catalogue seed', () => {
	it('stored every catalogue entry exactly as defined, by the global setup migrate run', async () => {
		const db = getDb();
		expect(CATALOGUE.some((e) => e.unilateral)).toBe(true);
		expect(CATALOGUE.some((e) => e.defaultSeconds !== null)).toBe(true);

		expect(await storedCatalogue(db)).toEqual([...CATALOGUE].sort(byKey));
		const live = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(exercises)
			.where(and(isNotNull(exercises.key), isNull(exercises.retiredAt)));
		expect(live[0]!.n).toBe(CATALOGUE.length);
	});

	it('changes nothing when run again, updated_at included', async () => {
		await inSeedTransaction(async (client, db) => {
			const before = await catalogueStamps(db);

			expect(await seedExerciseCatalogue(client)).toEqual(NOTHING);
			expect(await seedExerciseCatalogue(client)).toEqual(NOTHING);

			expect(await catalogueStamps(db)).toEqual(before);
		});
	});

	it('inserts a new key and updates a changed definition in place, keeping its id', async () => {
		await inSeedTransaction(async (client, db) => {
			const [first, second, ...rest] = CATALOGUE as [
				CatalogueExercise,
				CatalogueExercise,
				...CatalogueExercise[]
			];
			const before = await catalogueRow(db, first.key);
			const untouched = await catalogueRow(db, second.key);
			const changed = { ...first, name: `${first.name} (paused)`, unilateral: !first.unilateral };
			const added = { ...second, key: 'test_only_entry', name: 'Test-only entry' };

			expect(await seedExerciseCatalogue(client, [changed, second, ...rest, added])).toEqual({
				...NOTHING,
				inserted: 1,
				updated: 1
			});

			const after = await catalogueRow(db, first.key);
			expect(after.id).toBe(before.id);
			expect(after).toMatchObject({ name: changed.name, unilateral: changed.unilateral });
			expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
			expect(await catalogueRow(db, second.key)).toEqual(untouched);
			expect(await catalogueRow(db, added.key)).toMatchObject({ name: added.name, ownerId: null });
		});
	});

	it('retires a removed key, never deleting it, and restores it with the same id', async () => {
		await inSeedTransaction(async (client, db) => {
			const removed = CATALOGUE.at(-1)!;
			const { id } = await catalogueRow(db, removed.key);

			expect(
				await seedExerciseCatalogue(
					client,
					CATALOGUE.filter((e) => e.key !== removed.key)
				)
			).toEqual({ ...NOTHING, retired: 1 });
			const [retired] = await db.select().from(exercises).where(eq(exercises.id, id));
			expect(retired).toMatchObject({ key: removed.key, name: removed.name });
			expect(retired!.retiredAt).toBeInstanceOf(Date);
			expect(await seedExerciseCatalogue(client, [])).toEqual({
				...NOTHING,
				retired: CATALOGUE.length - 1
			});

			expect(await seedExerciseCatalogue(client)).toEqual({
				...NOTHING,
				restored: CATALOGUE.length
			});
			const [restored] = await db.select().from(exercises).where(eq(exercises.id, id));
			expect(restored!.retiredAt).toBeNull();
			expect(await storedCatalogue(db)).toEqual([...CATALOGUE].sort(byKey));
		});
	});

	it('never touches a custom row, which cannot take a catalogue key', async () => {
		await inSeedTransaction(async (client, db) => {
			const owner = await makeOwner(db);
			// The same name as a catalogue entry is fine: names are unique per owner only.
			const [custom] = await db
				.insert(exercises)
				.values(customExercise(owner, { name: CATALOGUE[0]!.name }))
				.returning();

			await seedExerciseCatalogue(client, []);
			await seedExerciseCatalogue(client);
			const [after] = await db.select().from(exercises).where(eq(exercises.id, custom!.id));
			expect(after).toEqual(custom);

			const catalogueKey = { key: CATALOGUE[0]!.key };
			expect(await refusal(db, customExercise(owner, catalogueKey))).toBe('exercises_kind_ck');
			expect(await refusal(db, customExercise(owner, { key: 'my_own_key' }))).toBe(
				'exercises_kind_ck'
			);
			expect(await refusal(db, { ...customExercise(owner), ownerId: null })).toBe(
				'exercises_kind_ck'
			);
			expect(
				await refusal(db, customExercise(owner, { name: CATALOGUE[0]!.name.toUpperCase() }))
			).toBe('exercises_owner_name_uq');
		});
	});
});

describe('exercise constraints', () => {
	it('CHECK the closed lists and the measure rules, leaving pattern open', async () => {
		await inSeedTransaction(async (_client, db) => {
			const owner = await makeOwner(db);
			const row = (overrides: Partial<typeof exercises.$inferInsert>) =>
				customExercise(owner, { name: `Row ${crypto.randomUUID()}`, ...overrides });

			expect(await refusal(db, row({ measure: 'stopwatch' as never }))).toBe(
				'exercises_measure_ck'
			);
			expect(await refusal(db, row({ repMin: 10, repMax: 6 }))).toBe('exercises_reps_ck');
			expect(await refusal(db, row({ repMin: 8, repMax: null }))).toBe('exercises_reps_ck');
			expect(
				await refusal(
					db,
					row({ measure: 'time', repMin: null, repMax: null, defaultSeconds: null })
				)
			).toBe('exercises_seconds_ck');
			expect(await refusal(db, row({ skillLevel: 'elite' as never }))).toBe(
				'exercises_skill_level_ck'
			);
			expect(await refusal(db, row({ loadType: 'banded' as never }))).toBe(
				'exercises_load_type_ck'
			);
			expect(await refusal(db, row({ primaryMuscles: [] }))).toBe('exercises_primary_muscles_ck');

			await db.insert(exercises).values(row({ pattern: 'sled_push' as never }));
			await db
				.insert(exercises)
				.values(row({ measure: 'time', repMin: null, repMax: null, defaultSeconds: 30 }));
		});
	});
});

describe('the exercise library and withCommitted', () => {
	it("keeps every catalogue row through the cleanup that clears the owner's rows", async () => {
		const db = getDb();
		const before = await catalogueStamps(db);
		let customId = '';

		await withCommitted(async (committed) => {
			const owner = await makeOwner(committed);
			const [custom] = await committed.insert(exercises).values(customExercise(owner)).returning();
			customId = custom!.id;
		});

		expect(await catalogueStamps(db)).toEqual(before);
		expect(await storedCatalogue(db)).toEqual([...CATALOGUE].sort(byKey));
		// No foreign key, so the custom row outlives its (test) owner: remove it by hand.
		const removed = await db.delete(exercises).where(eq(exercises.id, customId)).returning();
		expect(removed).toHaveLength(1);
	});
});
