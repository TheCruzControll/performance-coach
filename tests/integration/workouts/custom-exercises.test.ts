/**
 * exercise.create through the sync dispatcher (services/workouts/apply/exercises.ts) on real
 * Postgres: an exercise the owner adds mid-workout, online or offline, becomes their own library
 * row under the device's client id, exactly once, and the sets that name it apply once it has
 * arrived, deferred until then. No name can strand them: a name the owner retired is refused
 * instead of restoring the retired row under its old id.
 *
 * Batches go through applySyncBatch as the endpoint calls it, with a test transaction as its db.
 * Custom rows have no foreign key to owners, so another owner needs no owners row.
 */
import { count, eq, isNotNull, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	createMutation,
	type ExerciseLibrary,
	type MutationPayloads,
	type SyncResult
} from '../../../src/lib/domain/workout/index';
import { exercises, getDb, syncMutations, type Executor } from '../../../src/lib/server/db';
import { createTrainingLogRepository } from '../../../src/lib/server/db/repositories/training-log';
import {
	createCustomExercise,
	listExercises,
	resolveKeys,
	retireCustomExercise
} from '../../../src/lib/server/services/exercises/index';
import { getCanonicalWorkout } from '../../../src/lib/server/services/workouts/canonical';
import { applySyncBatch } from '../../../src/lib/server/services/workouts/sync';
import { GET } from '../../../src/routes/api/exercises/+server';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** An instant on Tuesday 10 November 2026, `minute` minutes after 07:00 UTC. */
const at = (minute = 0) => new Date(Date.UTC(2026, 10, 10, 7, minute)).toISOString();

const sync = (db: Executor, owner: string, mutations: readonly unknown[]) =>
	applySyncBatch(owner, JSON.parse(JSON.stringify(mutations)) as Record<string, unknown>[], {
		db
	});

const statuses = (results: readonly SyncResult[]) => results.map((r) => r.status);

/** A strongman carry, as the in-workout form sends it: measured in metres, loaded. */
const carry = (over: Partial<MutationPayloads['exercise.create']> = {}) =>
	({
		name: 'Sandbag carry',
		aliases: [],
		pattern: 'carry',
		primaryMuscles: ['forearms', 'traps'],
		secondaryMuscles: [],
		equipment: [],
		substitutionGroup: null,
		skillLevel: 'beginner',
		repMin: null,
		repMax: null,
		defaultSeconds: null,
		unilateral: false,
		measure: 'distance',
		loadType: 'external',
		tags: [],
		disciplines: [],
		...over
	}) satisfies MutationPayloads['exercise.create'];

/** The owner and an ad-hoc strength workout the device started and synced. */
async function seed(db: Executor) {
	const owner = await makeOwner(db);
	const workoutId = crypto.randomUUID();
	const start = createMutation('workout.start', {
		workoutId,
		at: at(),
		payload: {
			kind: 'strength',
			title: 'Strongman',
			sessionType: 'strength',
			discipline: 'strength',
			plannedSessionId: null,
			plannedLineage: null,
			programId: null
		}
	});
	expect(statuses((await sync(db, owner, [start])).results)).toEqual(['applied']);
	return { owner, workoutId };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

const createOf = (s: Seeded, over: Partial<MutationPayloads['exercise.create']> = {}) =>
	createMutation('exercise.create', { workoutId: s.workoutId, at: at(10), payload: carry(over) });

/** 40 m with 60 kg of the exercise, the first set of position 1. */
const carried = (s: Seeded, exerciseId: string, setIndex = 1) =>
	createMutation('set.log', {
		workoutId: s.workoutId,
		at: at(12 + setIndex),
		payload: {
			position: 1,
			plannedLineage: null,
			setIndex,
			exerciseId,
			reps: null,
			seconds: null,
			metres: 40,
			weight: 60,
			assistance: null,
			unit: 'kg',
			rpe: 8,
			missedReps: 0,
			isWarmup: false,
			isExtra: false
		}
	});

/** Every custom row of `owner`, retired ones included. */
const customRows = (db: Executor, owner: string) =>
	db
		.select({ id: exercises.id, name: exercises.name, retiredAt: exercises.retiredAt })
		.from(exercises)
		.where(eq(exercises.ownerId, owner))
		.orderBy(exercises.name);

const setsOf = async (db: Executor, s: Seeded) =>
	(await createTrainingLogRepository(db).workoutWithSets(s.owner, s.workoutId))!.sets.map(
		(set) => ({ id: set.clientMutationId, exerciseId: set.exerciseId, metres: set.metres })
	);

const ledgerHas = async (db: Executor, mutationId: string) => {
	const [row] = await db
		.select({ n: count() })
		.from(syncMutations)
		.where(eq(syncMutations.mutationId, mutationId));
	return row!.n === 1;
};

describe('exercise.create', () => {
	it("creates the owner's exercise under the device's id, and a set in the same batch names it", async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const create = createOf(s);
			const set = carried(s, create.id);

			const { results } = await sync(db, s.owner, [create, set]);

			expect(statuses(results)).toEqual(['applied', 'applied']);
			const [row] = await db.select().from(exercises).where(eq(exercises.id, create.id));
			expect(row).toMatchObject({
				id: create.id,
				ownerId: s.owner,
				key: null,
				name: 'Sandbag carry',
				measure: 'distance',
				loadType: 'external',
				retiredAt: null
			});
			expect(await setsOf(db, s)).toEqual([{ id: set.id, exerciseId: create.id, metres: 40 }]);
			// The batch's canonical rows carry it, as the device's reconcile needs.
			expect(results[1]!.canonical!.exercises[create.id]).toMatchObject({
				name: 'Sandbag carry',
				measure: 'distance',
				loadType: 'external'
			});
		});
	});

	it('a set sent before its exercise.create, in another batch, is deferred, then applies', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const create = createOf(s);
			const set = carried(s, create.id);

			expect((await sync(db, s.owner, [set])).results).toEqual([
				{ id: set.id, status: 'deferred', code: 'missing' }
			]);
			expect(await ledgerHas(db, set.id)).toBe(false);

			expect(statuses((await sync(db, s.owner, [create])).results)).toEqual(['applied']);
			expect(statuses((await sync(db, s.owner, [set])).results)).toEqual(['applied']);
			expect(await setsOf(db, s)).toEqual([{ id: set.id, exerciseId: create.id, metres: 40 }]);
		});
	});

	it('a replay is duplicate, and createCustomExercise twice with one id returns one row', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const create = createOf(s);

			expect(statuses((await sync(db, s.owner, [create, create])).results)).toEqual([
				'applied',
				'duplicate'
			]);
			expect(statuses((await sync(db, s.owner, [create])).results)).toEqual(['duplicate']);
			expect(await customRows(db, s.owner)).toEqual([
				{ id: create.id, name: 'Sandbag carry', retiredAt: null }
			]);

			const id = crypto.randomUUID();
			const input = carry({ name: 'Keg toss', measure: 'reps', repMin: 3, repMax: 5 });
			const first = await createCustomExercise(s.owner, input, { db }, { id });
			// Its own name is no clash, and a changed definition is not applied: the row is the row.
			const again = await createCustomExercise(s.owner, { ...input, repMax: 8 }, { db }, { id });
			expect(first).toMatchObject({ id, name: 'Keg toss', repMax: 5 });
			expect(again).toEqual(first);
			expect((await customRows(db, s.owner)).map((row) => row.id)).toEqual([id, create.id]);
		});
	});

	it("a name the catalogue or the owner's own exercises use is rejected at payload.name, naming it, with no ledger row", async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const own = await createCustomExercise(s.owner, carry({ name: 'Keg carry' }), { db });
			const squat = createOf(s, { name: 'back squat' });
			const mine = createOf(s, { name: 'Keg Carry' });

			const { results } = await sync(db, s.owner, [squat, mine]);

			expect(results).toEqual([
				{
					id: squat.id,
					status: 'rejected',
					code: 'invalid',
					errors: { 'payload.name': 'Already in the library as Back squat' }
				},
				{
					id: mine.id,
					status: 'rejected',
					code: 'invalid',
					errors: { 'payload.name': 'You already have Keg carry' }
				}
			]);
			expect(await ledgerHas(db, squat.id)).toBe(false);
			expect(await ledgerHas(db, mine.id)).toBe(false);
			expect((await customRows(db, s.owner)).map((row) => row.id)).toEqual([own.id]);
		});
	});

	it('a name the owner retired is refused, never restored under its old id; Fix renames it and its deferred sets follow', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const removed = await createCustomExercise(s.owner, carry(), { db });
			await retireCustomExercise(s.owner, removed.id, { db });
			const create = createOf(s, { name: 'sandbag carry' });
			const set = carried(s, create.id);

			const { results } = await sync(db, s.owner, [create, set]);

			expect(results).toEqual([
				{
					id: create.id,
					status: 'rejected',
					code: 'invalid',
					errors: {
						'payload.name':
							'You removed Sandbag carry from your exercises earlier: pick another name'
					}
				},
				{ id: set.id, status: 'deferred', code: 'blocked' }
			]);
			expect(await ledgerHas(db, create.id)).toBe(false);
			const [retired] = await customRows(db, s.owner);
			expect(retired).toEqual({
				id: removed.id,
				name: 'Sandbag carry',
				retiredAt: expect.any(Date)
			});
			// The set alone, in a later batch, waits for its exercise.
			expect((await sync(db, s.owner, [set])).results).toEqual([
				{ id: set.id, status: 'deferred', code: 'missing' }
			]);

			// Fix: the same mutation id, renamed.
			const renamed = { ...create, payload: carry({ name: 'Sandbag farmer carry' }) };
			const second = carried(s, create.id, 2);
			expect(statuses((await sync(db, s.owner, [renamed, set, second])).results)).toEqual([
				'applied',
				'applied',
				'applied'
			]);
			expect(await customRows(db, s.owner)).toEqual([
				{ id: removed.id, name: 'Sandbag carry', retiredAt: expect.any(Date) },
				{ id: create.id, name: 'Sandbag farmer carry', retiredAt: null }
			]);
			expect((await setsOf(db, s)).map((row) => row.exerciseId)).toEqual([create.id, create.id]);
		});
	});

	it("Profile's path, with no id, still restores a retired name under its old id", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const removed = await createCustomExercise(owner, carry(), { db });
			await retireCustomExercise(owner, removed.id, { db });

			const back = await createCustomExercise(owner, carry({ name: 'SANDBAG CARRY' }), { db });

			expect(back).toMatchObject({ id: removed.id, name: 'SANDBAG CARRY', retiredAt: null });
		});
	});

	it('a time-measured exercise without its default seconds is rejected at payload.defaultSeconds', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const hold = createOf(s, { name: 'Sandbag bear hug hold', measure: 'time' });

			const { results } = await sync(db, s.owner, [hold]);

			expect(results).toEqual([
				{
					id: hold.id,
					status: 'rejected',
					code: 'invalid',
					errors: { 'payload.defaultSeconds': 'How long is one bout or hold?' }
				}
			]);
			expect(await customRows(db, s.owner)).toEqual([]);
			expect(await ledgerHas(db, hold.id)).toBe(false);

			const timed = { ...hold, payload: carry({ ...hold.payload, defaultSeconds: 30 }) };
			expect(statuses((await sync(db, s.owner, [timed])).results)).toEqual(['applied']);
		});
	});

	it("another owner's custom exercise is never visible: not listed, not loggable, its id never taken", async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const theirs = await createCustomExercise(crypto.randomUUID(), carry(), { db });
			const [squat] = (await resolveKeys(['back_squat'], { db })).values();
			const set = carried(s, theirs.id);
			const takeTheirs = createMutation('exercise.create', {
				workoutId: s.workoutId,
				entityId: theirs.id,
				at: at(10),
				payload: carry({ name: 'Keg carry' })
			});
			const takeSquat = createMutation('exercise.create', {
				workoutId: s.workoutId,
				entityId: squat!.id,
				at: at(10),
				payload: carry({ name: 'Log carry' })
			});

			const { results } = await sync(db, s.owner, [set, takeTheirs, takeSquat]);

			// It exists, so the set is refused rather than deferred for ever.
			expect(results).toEqual([
				{
					id: set.id,
					status: 'rejected',
					code: 'invalid',
					errors: { 'payload.exerciseId': 'Not in your library' }
				},
				{ id: takeTheirs.id, status: 'rejected', code: 'forbidden' },
				{ id: takeSquat.id, status: 'rejected', code: 'forbidden' }
			]);
			const [row] = await db.select().from(exercises).where(eq(exercises.id, theirs.id));
			expect(row).toMatchObject({ name: 'Sandbag carry', retiredAt: null });
			expect(row!.ownerId).not.toBe(s.owner);

			// Names are each owner's own: theirs is no clash.
			const mine = createOf(s);
			expect(statuses((await sync(db, s.owner, [mine])).results)).toEqual(['applied']);
			const listed = (await listExercises(s.owner, {}, { db })).map((e) => e.id);
			expect(listed).toContain(mine.id);
			expect(listed).not.toContain(theirs.id);
		});
	});

	it('the canonical read and GET /api/exercises list it', async () => {
		let owner: string | undefined;
		try {
			await withCommitted(async (db) => {
				const s = await seed(db);
				owner = s.owner;
				const create = createOf(s);
				const set = carried(s, create.id);
				expect(statuses((await sync(db, s.owner, [create, set])).results)).toEqual([
					'applied',
					'applied'
				]);

				const canonical = await getCanonicalWorkout(s.owner, s.workoutId, { db });
				expect(canonical!.exercises[create.id]).toMatchObject({ name: 'Sandbag carry' });

				const response = await GET({
					request: new Request('http://localhost/api/exercises'),
					locals: { session: { ownerId: s.owner } }
				} as never);
				expect(response.status).toBe(200);
				const library = (await response.json()) as ExerciseLibrary;
				expect(library.exercises.find((e) => e.id === create.id)).toMatchObject({
					key: null,
					name: 'Sandbag carry',
					measure: 'distance',
					loadType: 'external'
				});
			});
		} finally {
			// No foreign key to owners, so withCommitted leaves custom rows: remove them by hand.
			if (owner) await getDb().delete(exercises).where(eq(exercises.ownerId, owner));
		}
	});

	it("resetPrograms' delete removes it and keeps the catalogue", async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const create = createOf(s);
			expect(statuses((await sync(db, s.owner, [create])).results)).toEqual(['applied']);
			const catalogue = async () => {
				const [row] = await db
					.select({ n: count() })
					.from(exercises)
					.where(isNotNull(exercises.key));
				return row!.n;
			};
			const before = await catalogue();

			// e2e/program-support.ts resetPrograms' second statement, verbatim.
			await db.execute(sql`delete from exercises where owner_id is not null`);

			expect(await customRows(db, s.owner)).toEqual([]);
			expect(await catalogue()).toBe(before);
		});
	});
});
