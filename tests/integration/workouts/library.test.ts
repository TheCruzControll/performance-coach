/**
 * The exercise library as JSON (services/workouts/library.ts and GET /api/exercises) on real
 * Postgres: the live catalogue and the owner's own exercises, in the owner's units, with a digest
 * the route serves as its ETag.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import type { ExerciseLibrary } from '../../../src/lib/domain/workout/index';
import { restClassOf } from '../../../src/lib/domain/workout/timers';
import { exercises, getDb } from '../../../src/lib/server/db';
import {
	createCustomExercise,
	retireCustomExercise
} from '../../../src/lib/server/services/exercises/index';
import { getAthleteProfile, saveBasics } from '../../../src/lib/server/services/profile/index';
import { getExerciseLibrary } from '../../../src/lib/server/services/workouts/library';
import { GET } from '../../../src/routes/api/exercises/+server';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** One of the owner's own, which no catalogue part has. */
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

const byKey = (library: ExerciseLibrary, key: string) =>
	library.exercises.find((exercise) => exercise.key === key);

describe('the exercise library as JSON', () => {
	it("lists the catalogue and this owner's own exercises, never another owner's, with what the picker needs", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			// Single-owner app: another owner's row is one with a random owner id, as M3's tests write it.
			const stranger = crypto.randomUUID();
			const own = await createCustomExercise(owner, sandbag(), { db });
			const theirs = await createCustomExercise(
				stranger,
				sandbag({ name: 'Keg carry', aliases: [] }),
				{ db }
			);

			const library = await getExerciseLibrary(owner, { db });
			expect(library.v).toBe(1);
			expect(library.units).toEqual({ weight: 'kg', distance: 'km' });
			expect(library.exercises).toHaveLength(CATALOGUE.length + 1);
			const ids = library.exercises.map((exercise) => exercise.id);
			expect(ids).toContain(own.id);
			expect(ids).not.toContain(theirs.id);
			expect(new Set(library.exercises.map((exercise) => exercise.key))).toEqual(
				new Set([...CATALOGUE.map((exercise) => exercise.key), null])
			);

			expect(library.exercises.find((exercise) => exercise.id === own.id)).toEqual({
				id: own.id,
				key: null,
				name: 'Sandbag shouldering',
				aliases: ['Sandbag to shoulder'],
				measure: 'reps',
				loadType: 'external',
				unilateral: false,
				pattern: 'hinge',
				equipment: own.equipment,
				tags: own.tags,
				defaultSeconds: null,
				restClass: 'compound',
				increment: 2.5
			});
			expect(byKey(library, 'romanian_deadlift')).toMatchObject({
				name: 'Romanian deadlift',
				aliases: ['RDL', 'Barbell RDL'],
				equipment: ['barbell'],
				restClass: 'compound'
			});
			expect(byKey(library, 'deadlift')).toMatchObject({ restClass: 'main' });
			const timed = CATALOGUE.find((exercise) => exercise.measure === 'time')!;
			expect(byKey(library, timed.key)).toMatchObject({
				measure: 'time',
				defaultSeconds: timed.defaultSeconds,
				restClass: restClassOf(timed)
			});
		});
	});

	it('hides retired rows', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const own = await createCustomExercise(owner, sandbag(), { db });
			await retireCustomExercise(owner, own.id, { db });

			const library = await getExerciseLibrary(owner, { db });
			expect(library.exercises).toHaveLength(CATALOGUE.length);
			expect(library.exercises.map((exercise) => exercise.id)).not.toContain(own.id);
		});
	});

	it('keeps a stable digest, which changes with a new custom exercise, a retirement or new units', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const first = await getExerciseLibrary(owner, { db });
			expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
			expect((await getExerciseLibrary(owner, { db })).digest).toBe(first.digest);
			// The digest is the content's, not the owner's: another owner with the same library shares it.
			expect((await getExerciseLibrary(crypto.randomUUID(), { db })).digest).toBe(first.digest);

			const own = await createCustomExercise(owner, sandbag(), { db });
			const added = await getExerciseLibrary(owner, { db });
			expect(added.digest).not.toBe(first.digest);
			expect((await getExerciseLibrary(owner, { db })).digest).toBe(added.digest);

			await retireCustomExercise(owner, own.id, { db });
			expect((await getExerciseLibrary(owner, { db })).digest).toBe(first.digest);

			const { name, distanceUnit, timeZone } = await getAthleteProfile(owner, { db });
			await saveBasics(owner, { name, weightUnit: 'lb', distanceUnit, timeZone }, { db });
			const pounds = await getExerciseLibrary(owner, { db });
			expect(pounds.units).toEqual({ weight: 'lb', distance: distanceUnit });
			expect(pounds.exercises.every((exercise) => exercise.increment === 5)).toBe(true);
			expect(pounds.digest).not.toBe(first.digest);
		});
	});

	describe('GET /api/exercises', () => {
		const event = (ownerId: string, ifNoneMatch?: string) =>
			({
				request: new Request('http://localhost/api/exercises', {
					headers: ifNoneMatch === undefined ? {} : { 'if-none-match': ifNoneMatch }
				}),
				locals: { session: { ownerId } }
			}) as never;

		it('serves the library with its digest as a private ETag, and a matching If-None-Match gets an empty 304', async () => {
			let owner: string | undefined;
			try {
				await withCommitted(async (db) => {
					owner = await makeOwner(db);

					const full = await GET(event(owner));
					expect(full.status).toBe(200);
					expect(full.headers.get('cache-control')).toBe('private, no-cache');
					const body = (await full.json()) as ExerciseLibrary;
					const etag = `"${body.digest}"`;
					expect(full.headers.get('etag')).toBe(etag);
					expect(body.exercises).toHaveLength(CATALOGUE.length);

					for (const header of [etag, `W/${etag}`, `"stale", ${etag}`, '*']) {
						const unchanged = await GET(event(owner, header));
						expect(unchanged.status, header).toBe(304);
						expect(unchanged.headers.get('etag')).toBe(etag);
						expect(unchanged.headers.get('cache-control')).toBe('private, no-cache');
						expect(await unchanged.text()).toBe('');
					}

					const stale = await GET(event(owner, '"stale"'));
					expect(stale.status).toBe(200);
					expect(((await stale.json()) as ExerciseLibrary).digest).toBe(body.digest);

					// A new custom exercise changes the digest, so the device's old ETag gets the new list.
					const own = await createCustomExercise(owner, sandbag(), { db });
					const changed = await GET(event(owner, etag));
					expect(changed.status).toBe(200);
					const next = (await changed.json()) as ExerciseLibrary;
					expect(changed.headers.get('etag')).toBe(`"${next.digest}"`);
					expect(next.digest).not.toBe(body.digest);
					expect(next.exercises.map((exercise) => exercise.id)).toContain(own.id);
				});
			} finally {
				// No foreign key to owners, so withCommitted leaves custom rows: remove them by hand.
				if (owner) await getDb().delete(exercises).where(eq(exercises.ownerId, owner));
			}
		});
	});
});
