/**
 * The exercise library service on real Postgres (src/lib/server/services/exercises): lists of the
 * catalogue and the owner's own exercises, lookups that keep retired rows readable, custom
 * exercises created and retired with field errors the owner can fix, and free text resolved to
 * one exercise. Custom rows have no foreign key to owners, so another owner needs no owners row.
 */
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import { exercises, getDb } from '../../../src/lib/server/db';
import {
	createCustomExercise,
	getExercisesByIds,
	listCustomExercises,
	listExercises,
	resolveExerciseName,
	resolveExerciseNames,
	resolveKeys,
	retireCustomExercise
} from '../../../src/lib/server/services/exercises/index';
import {
	TrainingInputError,
	TrainingNotFoundError
} from '../../../src/lib/server/services/training/shared';
import { holdTransaction, lockWaiters, withCommitted, withRollback } from '../helpers';
import { clock, makeOwner } from '../profile/fixtures';

/** One of the owner's own: a strongman lift that neither catalogue part has. */
const sandbag = (overrides: Record<string, unknown> = {}) => ({
	name: 'Sandbag shouldering',
	aliases: ['Sandbag to shoulder'],
	pattern: 'hinge',
	primaryMuscles: ['glutes', 'hamstrings'],
	secondaryMuscles: ['lower_back'],
	substitutionGroup: 'hip_hinge_ballistic',
	measure: 'reps',
	loadType: 'external',
	repMin: 3,
	repMax: 5,
	...overrides
});

const atlasStone = { ...sandbag(), name: 'Atlas stone load', aliases: [] };

const byKey = (a: { key: string | null }, b: { key: string | null }) => (a.key! < b.key! ? -1 : 1);

/** The field errors of a refused create (fails the test if it was not refused that way). */
async function inputErrors(promise: Promise<unknown>): Promise<Record<string, string>> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!(error instanceof TrainingInputError)) {
		throw new Error(`expected a TrainingInputError, got ${String(error)}`);
	}
	return error.errors;
}

describe('the exercise library', () => {
	it("lists the catalogue and the owner's own exercises, never another owner's", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const stranger = crypto.randomUUID();
			const own = await createCustomExercise(owner, sandbag(), { db });
			// Names are the owner's own: another owner may use the same one.
			const theirs = await createCustomExercise(stranger, sandbag(), { db });

			expect(own).toEqual({
				id: expect.any(String),
				key: null,
				name: 'Sandbag shouldering',
				aliases: ['Sandbag to shoulder'],
				pattern: 'hinge',
				primaryMuscles: ['glutes', 'hamstrings'],
				secondaryMuscles: ['lower_back'],
				equipment: [],
				substitutionGroup: 'hip_hinge_ballistic',
				skillLevel: 'beginner',
				repMin: 3,
				repMax: 5,
				defaultSeconds: null,
				unilateral: false,
				measure: 'reps',
				loadType: 'external',
				tags: [],
				disciplines: [],
				baselineLift: null,
				retiredAt: null
			});

			const listed = await listExercises(owner, {}, { db });
			const catalogue = listed
				.filter((exercise) => exercise.key !== null)
				.map(({ id: _id, retiredAt: _retiredAt, ...entry }) => entry)
				.sort(byKey);
			expect(catalogue).toEqual([...CATALOGUE].sort(byKey));
			expect(listed.filter((exercise) => exercise.key === null)).toEqual([own]);
			expect(await listCustomExercises(owner, { db })).toEqual([own]);
			expect(await listCustomExercises(stranger, { db })).toEqual([theirs]);
			expect([...(await getExercisesByIds(owner, [own.id, theirs.id], { db })).keys()]).toEqual([
				own.id
			]);

			// The filters the schema indexes: a custom exercise joins its group's swaps.
			const hinges = await listExercises(owner, { pattern: 'hinge' }, { db });
			expect(new Set(hinges.map((exercise) => exercise.key ?? exercise.id))).toEqual(
				new Set([...CATALOGUE.filter((e) => e.pattern === 'hinge').map((e) => e.key), own.id])
			);
			const swings = await listExercises(
				owner,
				{ substitutionGroup: 'hip_hinge_ballistic' },
				{ db }
			);
			expect(new Set(swings.map((exercise) => exercise.key ?? exercise.id))).toEqual(
				new Set([
					...CATALOGUE.filter((e) => e.substitutionGroup === 'hip_hinge_ballistic').map(
						(e) => e.key
					),
					own.id
				])
			);
		});
	});

	it('lists by name, whichever plan the database picks', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await createCustomExercise(owner, sandbag(), { db });
			await createCustomExercise(owner, atlasStone, { db });
			// The (owner, lower(name)) index happens to return name order, so rule it out: only
			// ORDER BY may give the order, not the plan.
			await db.execute(sql`set local enable_indexscan = off`);
			await db.execute(sql`set local enable_bitmapscan = off`);

			expect((await listCustomExercises(owner, { db })).map((e) => e.name)).toEqual([
				'Atlas stone load',
				'Sandbag shouldering'
			]);
			const swings = await listExercises(
				owner,
				{ substitutionGroup: 'hip_hinge_ballistic' },
				{ db }
			);
			expect(swings.map((e) => e.name)).toEqual(
				[
					...CATALOGUE.filter((e) => e.substitutionGroup === 'hip_hinge_ballistic').map(
						(e) => e.name
					),
					'Atlas stone load',
					'Sandbag shouldering'
				].sort((a, b) => a.localeCompare(b, 'en'))
			);
		});
	});

	it('hides retired rows from lists but keeps them readable by id, and resolves a retired key', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const time = clock();
			const own = await createCustomExercise(owner, sandbag(), { db });
			// A key another preview's catalogue no longer has, retired as its seed would.
			const [boxSquat] = await db
				.update(exercises)
				.set({ retiredAt: new Date('2026-11-01T00:00:00Z') })
				.where(eq(exercises.key, 'box_squat'))
				.returning();
			const retired = await retireCustomExercise(owner, own.id, { db, now: time.now });
			expect(retired).toEqual({ ...own, retiredAt: time.now() });

			const listed = await listExercises(owner, {}, { db });
			expect(listed).toHaveLength(CATALOGUE.length - 1);
			expect(listed.map((exercise) => exercise.id)).not.toContain(boxSquat!.id);
			expect(await listCustomExercises(owner, { db })).toEqual([]);

			const byId = await getExercisesByIds(owner, [boxSquat!.id, own.id], { db });
			expect(byId.get(boxSquat!.id)).toMatchObject({
				key: 'box_squat',
				name: 'Box squat',
				retiredAt: new Date('2026-11-01T00:00:00Z')
			});
			expect(byId.get(own.id)).toEqual(retired);

			const resolved = await resolveKeys(['back_squat', 'box_squat', 'no_such_key'], { db });
			expect([...resolved.keys()].sort()).toEqual(['back_squat', 'box_squat']);
			expect(resolved.get('box_squat')).toEqual(byId.get(boxSquat!.id));

			// Retiring again (a repeated request) keeps the first retirement.
			time.advanceDays(1);
			expect(await retireCustomExercise(owner, own.id, { db, now: time.now })).toEqual(retired);
		});
	});

	it('brings back a retired exercise created again by name, with the new definition and its id', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const first = await createCustomExercise(owner, sandbag(), { db });
			await retireCustomExercise(owner, first.id, { db });

			const again = await createCustomExercise(
				owner,
				sandbag({ name: 'SANDBAG shouldering', aliases: [], repMin: 1, repMax: 3 }),
				{ db }
			);

			expect(again).toEqual({
				...first,
				name: 'SANDBAG shouldering',
				aliases: [],
				repMin: 1,
				repMax: 3,
				retiredAt: null
			});
			expect(await listCustomExercises(owner, { db })).toEqual([again]);
		});
	});
});

describe('custom exercises', () => {
	it('refuse bad input with a message for each field, writing nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const create = (input: unknown) => inputErrors(createCustomExercise(owner, input, { db }));

			expect(
				await create({ name: ' ', pattern: 'sideways', primaryMuscles: [], measure: 'reps' })
			).toEqual({
				name: 'Required',
				pattern: 'Pick a movement pattern',
				primaryMuscles: 'Pick a muscle',
				loadType: 'Pick how it is loaded'
			});
			// The database requires seconds for a timed exercise: a field error, never a 500.
			expect(
				await create(
					sandbag({ substitutionGroup: null, measure: 'time', repMin: null, repMax: null })
				)
			).toEqual({ defaultSeconds: 'How long is one bout or hold?' });

			expect(await listCustomExercises(owner, { db })).toEqual([]);
		});
	});

	it('take only what the owner sets: never a key, another owner, a lift or a retirement', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const stranger = crypto.randomUUID();
			// The coach's tool calls (M5) pass their input through as given.
			const own = await createCustomExercise(
				owner,
				{
					...sandbag(),
					id: stranger,
					key: 'sandbag_shouldering',
					ownerId: stranger,
					baselineLift: 'deadlift',
					retiredAt: '2026-11-01T00:00:00Z'
				},
				{ db }
			);

			expect(own).toMatchObject({ key: null, baselineLift: null, retiredAt: null });
			expect(own.id).not.toBe(stranger);
			expect(await listCustomExercises(owner, { db })).toEqual([own]);
			expect(await listCustomExercises(stranger, { db })).toEqual([]);
		});
	});

	it('refuse a name or alias the catalogue or the owner already uses, in any case or plural', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const own = await createCustomExercise(owner, sandbag(), { db });
			const create = (input: unknown) => inputErrors(createCustomExercise(owner, input, { db }));

			expect(await create(sandbag({ name: 'SANDBAG SHOULDERING', aliases: [] }))).toEqual({
				name: 'You already have Sandbag shouldering'
			});
			expect(
				await create(
					sandbag({ name: 'Back squats', aliases: ['Atlas', 'RDL', 'sandbag to shoulders'] })
				)
			).toEqual({
				name: 'Already in the library as Back squat',
				'aliases.1': 'Already in the library as Romanian deadlift',
				'aliases.2': 'You already have Sandbag shouldering'
			});

			expect(await listCustomExercises(owner, { db })).toEqual([own]);
		});
	});

	it('refuse a substitution group that does not exist or does not fit the exercise', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const create = (input: unknown) => inputErrors(createCustomExercise(owner, input, { db }));

			for (const substitutionGroup of ['leg_day', 'constructor']) {
				expect(await create(sandbag({ substitutionGroup }))).toEqual({
					substitutionGroup: 'Not a substitution group'
				});
			}
			// A swap within a group keeps its pattern and measure (the catalogue's integrity tests).
			expect(await create(sandbag({ substitutionGroup: 'knee_dominant_bilateral' }))).toEqual({
				substitutionGroup: 'This group is for the Squat pattern'
			});
			expect(
				await create(sandbag({ measure: 'time', repMin: null, repMax: null, defaultSeconds: 40 }))
			).toEqual({ substitutionGroup: "This group's exercises are measured in reps" });

			expect(await listCustomExercises(owner, { db })).toEqual([]);
		});
	});

	it('answer a malformed, catalogue or stranger’s id as not found, never with a database error', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const own = await createCustomExercise(owner, sandbag(), { db });
			const squat = (await resolveKeys(['back_squat'], { db })).get('back_squat')!;
			// Route params and the coach's tool calls (M5) pass ids through as given.
			const malformed = ['', 'abc', `${own.id}x`];

			expect((await getExercisesByIds(owner, malformed, { db })).size).toBe(0);
			for (const id of [...malformed, squat.id]) {
				await expect(retireCustomExercise(owner, id, { db })).rejects.toBeInstanceOf(
					TrainingNotFoundError
				);
			}
			await expect(retireCustomExercise(crypto.randomUUID(), own.id, { db })).rejects.toThrow(
				'exercise not found'
			);

			expect(await listCustomExercises(owner, { db })).toEqual([own]);
			expect((await resolveKeys(['back_squat'], { db })).get('back_squat')).toEqual(squat);
		});
	});

	it('serialise a double-tapped create: the second gets field errors, never a unique violation', async () => {
		const owner = crypto.randomUUID();
		try {
			await withCommitted(async (db) => {
				const first = await holdTransaction((tx) =>
					createCustomExercise(owner, sandbag(), { db: tx })
				);
				const second = inputErrors(createCustomExercise(owner, sandbag(), { db }));
				await lockWaiters(1);
				await first.commit();

				expect(await second).toEqual({
					name: 'You already have Sandbag shouldering',
					'aliases.0': 'You already have Sandbag shouldering'
				});
				expect(await listCustomExercises(owner, { db })).toHaveLength(1);
			});
		} finally {
			// No foreign key to owners, so withCommitted leaves custom rows: remove them by hand.
			await getDb().delete(exercises).where(eq(exercises.ownerId, owner));
		}
	});
});

describe('resolving free text', () => {
	it('finds one exercise by name or alias, the owner’s own included, and null for unknown text', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const own = await createCustomExercise(owner, sandbag(), { db });
			await createCustomExercise(crypto.randomUUID(), atlasStone, { db });
			const keys = await resolveKeys(['romanian_deadlift', 'back_squat'], { db });
			const rdl = keys.get('romanian_deadlift')!;
			const resolve = (text: string) => resolveExerciseName(owner, text, { db });

			expect(await resolve('RDL')).toEqual(rdl);
			expect(await resolve('romanian deadlifts')).toEqual(rdl);
			expect(await resolve('Squat')).toEqual(keys.get('back_squat'));
			expect(await resolve('sandbag to shoulders')).toEqual(own);
			// Another owner's exercise, unknown text and part of a name resolve to nothing.
			expect(await resolve('Atlas stone load')).toBeNull();
			expect(await resolve('Underwater basket weaving')).toBeNull();
			expect(await resolve('Romanian')).toBeNull();
			expect(await resolve('')).toBeNull();
			// A list resolves in one call, in order.
			expect(
				await resolveExerciseNames(owner, ['RDL', 'Nothing like it', 'Sandbag shouldering'], { db })
			).toEqual([rdl, null, own]);

			// A retired exercise has left the library.
			await retireCustomExercise(owner, own.id, { db });
			expect(await resolve('Sandbag shouldering')).toBeNull();
		});
	});
});
