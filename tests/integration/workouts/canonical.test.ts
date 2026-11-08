/**
 * The canonical workout reads (services/workouts/canonical.ts and the two GET endpoints) on real
 * Postgres: one workout's rows as the sync results carry them, the workouts in progress, the
 * queries they take, and convergence: the server and the domain reducers end on the same view
 * for the same seeded sequences, however the outbox batches and re-sends them.
 *
 * Mutations go through applySyncBatch as the endpoint calls it, with a test transaction as its
 * db, except where the endpoints themselves are called (they use the shared pool).
 */
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { seededRandom, type SeededRandom } from '../../../src/lib/domain/programming/random';
import {
	createMutation,
	dependsOn,
	type CanonicalWorkout,
	type Mutation,
	type MutationPayloads,
	type StrengthKit,
	type SyncResult,
	type WorkoutView
} from '../../../src/lib/domain/workout/index';
import { e1rmOf } from '../../../src/lib/domain/workout/logging';
import { project } from '../../../src/lib/domain/workout/project';
import { strengthTable } from '../../../src/lib/domain/workout/reducers/tables';
import { workouts, type Executor } from '../../../src/lib/server/db';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import {
	ACTIVE_WORKOUTS_LIMIT,
	getCanonicalWorkout,
	listActiveWorkouts
} from '../../../src/lib/server/services/workouts/canonical';
import { applySyncBatch } from '../../../src/lib/server/services/workouts/sync';
import { GET as getActive } from '../../../src/routes/api/workouts/active/+server';
import { GET as getWorkout } from '../../../src/routes/api/workouts/[id]/+server';
import { workoutDayKits } from '../../fixtures/workout-day';
import { acrossRows, strengthSequence } from '../../fixtures/workout-sequences';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** How many of workout-projection's seeds replay against Postgres (seeds 1 to this). */
const SERVER_SEEDS = 40;

/** An instant on Tuesday 10 November 2026, `minute` minutes after 07:00 UTC. */
const at = (minute = 0) => new Date(Date.UTC(2026, 10, 10, 7, minute)).toISOString();
const deviceId = () => crypto.randomUUID();

const DONE = {
	reps: 5,
	seconds: null,
	metres: null,
	weight: 100,
	assistance: null,
	unit: 'kg',
	rpe: 8,
	missedReps: 0,
	isWarmup: false,
	isExtra: false
} as const satisfies MutationPayloads['set.edit'];

const startOf = (workoutId: string, minute = 0, title = 'Lower body & pull') =>
	createMutation('workout.start', {
		workoutId,
		at: at(minute),
		payload: {
			kind: 'strength',
			title,
			sessionType: 'strength',
			discipline: 'strength',
			plannedSessionId: null,
			plannedLineage: null,
			programId: null
		}
	});

const logOf = (workoutId: string, exerciseId: string, setIndex = 1) =>
	createMutation('set.log', {
		workoutId,
		at: at(5 + setIndex),
		payload: { position: 1, plannedLineage: null, setIndex, exerciseId, ...DONE }
	});

const endOf = (type: 'workout.finish' | 'workout.abandon', workoutId: string) =>
	type === 'workout.finish'
		? createMutation(type, { workoutId, at: at(50), payload: { sessionRpe: 8 } })
		: createMutation(type, { workoutId, at: at(50), payload: {} });

/** Apply mutations as the endpoint does, after JSON (a test never shares objects with it). */
const sync = (db: Executor, owner: string, mutations: readonly unknown[]) =>
	applySyncBatch(owner, JSON.parse(JSON.stringify(mutations)) as Record<string, unknown>[], {
		db
	});

const statuses = (results: readonly SyncResult[]) => results.map((r) => r.status);

/** The owner and the catalogue exercises the workout-day kit names, by key. */
async function setup(db: Executor) {
	const owner = await makeOwner(db);
	const keys = await resolveKeys(
		['back_squat', 'leg_press', 'romanian_deadlift', 'pull_up', 'plank'],
		{ db }
	);
	const id = (key: string) => keys.get(key)!.id;
	return { owner, id, squat: id('back_squat') };
}

/**
 * Another owner. The app allows a single owner, so this lifts that rule inside the test's
 * transaction only (Postgres DDL rolls back with it).
 */
async function secondOwner(db: Executor) {
	await db.execute(sql`drop index owners_singleton_uq`);
	await db.execute(sql`alter table owners drop constraint owners_singleton_ck`);
	return makeOwner(db, 'Someone else');
}

/** The statements `run` sends, less transaction control (BEGIN, SAVEPOINT …). */
async function statementsOf(run: () => Promise<unknown>): Promise<string[]> {
	const spy = vi.spyOn(pg.Client.prototype, 'query');
	try {
		await run();
		return spy.mock.calls
			.map(([query]) => (typeof query === 'string' ? query : (query as { text: string }).text))
			.filter((text) => !/^\s*(begin|commit|rollback|savepoint|release)\b/i.test(text));
	} finally {
		spy.mockRestore();
	}
}

describe('one workout', () => {
	it('after a batch through the sync service, reads the canonical rows the batch returned', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = deviceId();
			const one = logOf(workout, squat, 1);
			const { results } = await sync(db, owner, [
				startOf(workout),
				one,
				logOf(workout, squat, 2),
				createMutation('set.edit', {
					workoutId: workout,
					entityId: one.id,
					at: at(20),
					payload: { ...DONE, reps: 4 }
				}),
				createMutation('workout.update', {
					workoutId: workout,
					at: at(30),
					payload: { notes: 'Felt quick' }
				})
			]);
			expect(statuses(results)).toEqual(Array(5).fill('applied'));
			const returned = results.at(-1)!.canonical!;

			const read = await getCanonicalWorkout(owner, workout, { db });
			expect(read).toStrictEqual(returned);
			expect(read).toMatchObject({
				v: 1,
				workout: { id: workout, status: 'in_progress', notes: 'Felt quick', deletedAt: null },
				exercises: { [squat]: { name: 'Back squat', measure: 'reps', loadType: 'external' } }
			});
			expect(read!.sets.map((s) => [s.id, s.setIndex, s.reps])).toEqual([
				[one.id, 1, 4],
				[expect.any(String), 2, 5]
			]);
		});
	});

	it('a soft-deleted set comes back as a tombstone, with its values', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = deviceId();
			const one = logOf(workout, squat, 1);
			const remove = createMutation('set.delete', {
				workoutId: workout,
				entityId: one.id,
				at: at(40),
				payload: {}
			});
			await sync(db, owner, [startOf(workout), one, logOf(workout, squat, 2), remove]);

			const { sets } = (await getCanonicalWorkout(owner, workout, { db }))!;
			expect(sets).toHaveLength(2);
			expect(sets[0]).toMatchObject({ id: one.id, reps: 5, weight: 100 });
			expect(sets[0]!.deletedAt).toEqual(expect.any(String));
			expect(sets[1]!.deletedAt).toBeNull();
		});
	});

	it('a malformed id, an unknown one or another owner’s reads as nothing', async () => {
		await withRollback(async (db) => {
			const { owner } = await setup(db);
			const theirs = deviceId();
			const other = await secondOwner(db);
			await sync(db, other, [startOf(theirs)]);

			expect(await getCanonicalWorkout(other, theirs, { db })).not.toBeNull();
			for (const id of ['not-a-uuid', '', deviceId(), theirs]) {
				expect(await getCanonicalWorkout(owner, id, { db }), id).toBeNull();
			}
		});
	});

	it('takes one keyed query per table, and one for the exercises', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = deviceId();
			const sets = Array.from({ length: 12 }, (_, i) => logOf(workout, squat, i + 1));
			await sync(db, owner, [startOf(workout), ...sets]);

			const sent = await statementsOf(() => getCanonicalWorkout(owner, workout, { db }));
			// The workout, its sets, substitutions, pain reports, run and other session; then the
			// exercises its rows name. However many sets: a run's segments are read only with a run.
			expect(sent).toHaveLength(7);
			expect(await statementsOf(() => getCanonicalWorkout(owner, 'nope', { db }))).toEqual([]);
			expect(await statementsOf(() => getCanonicalWorkout(owner, deviceId(), { db }))).toHaveLength(
				1
			);
		});
	});
});

describe('workouts in progress', () => {
	it('lists only the owner’s workouts in progress, newest first, keyed by client id', async () => {
		await withRollback(async (db) => {
			const { owner } = await setup(db);
			const [early, late, finished, abandoned, deleted] = [
				deviceId(),
				deviceId(),
				deviceId(),
				deviceId(),
				deviceId()
			];
			const other = await secondOwner(db);
			await sync(db, other, [startOf(deviceId(), 30)]);
			const { results } = await sync(db, owner, [
				startOf(early, 1, 'Early'),
				startOf(late, 20, 'Late'),
				startOf(finished, 25),
				endOf('workout.finish', finished),
				startOf(abandoned, 26),
				endOf('workout.abandon', abandoned),
				startOf(deleted, 27)
			]);
			expect(statuses(results)).toEqual(Array(7).fill('applied'));
			await db
				.update(workouts)
				.set({ deletedAt: new Date() })
				.where(eq(workouts.clientId, deleted));

			const sent: string[] = [];
			let active: Awaited<ReturnType<typeof listActiveWorkouts>>;
			sent.push(
				...(await statementsOf(async () => (active = await listActiveWorkouts(owner, { db }))))
			);
			expect(sent).toHaveLength(1);
			expect(active!).toStrictEqual({
				v: 1,
				workouts: [late, early].map((id, i) => ({
					id,
					kind: 'strength',
					title: i === 0 ? 'Late' : 'Early',
					sessionType: 'strength',
					discipline: 'strength',
					plannedSessionId: null,
					plannedLineage: null,
					programId: null,
					startedAt: at(i === 0 ? 20 : 1)
				}))
			});
		});
	});

	it(`lists at most ${ACTIVE_WORKOUTS_LIMIT}`, async () => {
		await withRollback(async (db) => {
			const { owner } = await setup(db);
			const ids = Array.from({ length: ACTIVE_WORKOUTS_LIMIT + 2 }, deviceId);
			await sync(
				db,
				owner,
				ids.map((id, i) => startOf(id, i))
			);
			const { workouts: listed } = await listActiveWorkouts(owner, { db });
			expect(listed.map((w) => w.id)).toEqual(ids.slice(2).reverse());
		});
	});
});

describe('the endpoints', () => {
	const event = (ownerId: string, params: Record<string, string> = {}) =>
		({ params, locals: { session: { ownerId } } }) as never;

	it('answer the owner’s rows and workouts in progress, never cached; anything else is a 404', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const workout = deviceId();
			const { results } = await sync(db, owner, [startOf(workout)]);
			expect(statuses(results)).toEqual(['applied']);

			const found = await getWorkout(event(owner, { id: workout }));
			expect(found.status).toBe(200);
			expect(found.headers.get('cache-control')).toBe('no-store');
			expect(((await found.json()) as CanonicalWorkout).workout.id).toBe(workout);

			for (const id of ['not-a-uuid', deviceId()]) {
				const missing = await getWorkout(event(owner, { id }));
				expect(missing.status, id).toBe(404);
				expect(missing.headers.get('cache-control')).toBe('no-store');
				expect(await missing.json()).toEqual({ error: 'not_found' });
			}

			const active = await getActive(event(owner));
			expect(active.status).toBe(200);
			expect(active.headers.get('cache-control')).toBe('no-store');
			expect(await active.json()).toMatchObject({ v: 1, workouts: [{ id: workout }] });
		});
	});
});

// ---- Convergence ------------------------------------------------------------------------------

/** The view with every pending flag cleared: what the rows say, whatever is still unsent. */
function settled(v: WorkoutView | null): WorkoutView | null {
	const done = <R extends { pending: boolean }>(row: R): R => ({ ...row, pending: false });
	return (
		v && {
			...v,
			workout: done(v.workout),
			slots: v.slots.map((slot) => ({
				...slot,
				substitution: slot.substitution && done(slot.substitution),
				sets: slot.sets.map(done)
			})),
			run: v.run && { ...done(v.run), segments: v.run.segments.map(done) },
			other: v.other && done(v.other)
		}
	);
}

/**
 * The sequence without the owner's own exercises and every mutation that depends on one, however
 * indirectly: the sequences reuse CUSTOM's names, which one owner's library holds once
 * (custom-exercises.test.ts covers exercise.create).
 */
function serverSupported(mutations: readonly Mutation[]): Mutation[] {
	const dropped: Mutation[] = [];
	return mutations.filter((m) => {
		if (m.type === 'exercise.create' || dropped.some((d) => dependsOn(m, d))) {
			dropped.push(m);
			return false;
		}
		return true;
	});
}

/**
 * The batches an outbox could send `ordered` in: 1 to 8 new mutations at a time, sometimes
 * re-sending a prefix it never heard back about, sometimes one mutation twice.
 */
function deliveries(ordered: readonly Mutation[], random: SeededRandom): Mutation[][] {
	const batches: Mutation[][] = [];
	for (let sent = 0; sent < ordered.length;) {
		const fresh = 1 + random.int(8);
		const resend = sent > 0 && random.next() < 0.3 ? 1 + random.int(Math.min(sent, 8)) : 0;
		const batch = ordered.slice(sent - resend, sent + fresh);
		if (random.next() < 0.3) {
			const twice = random.int(batch.length);
			batch.splice(twice + 1, 0, batch[twice]!);
		}
		batches.push(batch);
		sent += fresh;
	}
	return batches;
}

describe('convergence', () => {
	it(`the server's rows for ${SERVER_SEEDS} seeded sequences, batched, re-sent and reordered across rows, project to the domain fold`, async () => {
		await withRollback(async (db) => {
			const { owner, id } = await setup(db);
			const kit: StrengthKit = {
				...workoutDayKits({ date: '2026-11-06', exerciseId: id }).strength,
				// An ad-hoc start: the fixture's program is not in this database.
				plannedSessionId: null,
				plannedLineage: null,
				programId: null
			};
			let duplicates = 0;
			let estimated = 0;
			const types = new Set<string>();
			for (let seed = 1; seed <= SERVER_SEEDS; seed++) {
				const { workoutId, mutations } = strengthSequence(seed, kit);
				const M = serverSupported(mutations);
				for (const m of M) types.add(m.type);
				const random = seededRandom(`server:${seed}`);
				const applied = new Map<string, number>();
				for (const batch of deliveries(acrossRows(M, random), random)) {
					const { results } = await sync(db, owner, batch);
					for (const r of results) {
						expect(['applied', 'duplicate'], `seed ${seed}: ${JSON.stringify(r)}`).toContain(
							r.status
						);
						if (r.status === 'applied') applied.set(r.id, (applied.get(r.id) ?? 0) + 1);
						else duplicates++;
					}
				}
				expect([...applied.keys()].sort(), `seed ${seed}`).toEqual(M.map((m) => m.id).sort());
				expect(new Set(applied.values()), `seed ${seed}`).toEqual(new Set([1]));

				const canonical = (await getCanonicalWorkout(owner, workoutId, { db }))!;
				// e1rmKg is the server's alone (the reducers leave it null until the rows return):
				// logging-rules' e1rmOf on each stored set, then left out of the comparison.
				for (const set of canonical.sets) {
					const exercise = canonical.exercises[set.exerciseId]!;
					if (set.e1rmKg !== null) estimated++;
					expect(set.e1rmKg, `seed ${seed}, set ${set.id}`).toBe(
						e1rmOf(set, exercise)?.value ?? null
					);
				}
				const rows = { ...canonical, sets: canonical.sets.map((s) => ({ ...s, e1rmKg: null })) };
				const server = project(strengthTable, { workoutId, kit, canonical: rows, pending: [] });
				const fold = project(strengthTable, { workoutId, kit, canonical: null, pending: M });
				expect(server, `seed ${seed}`).toStrictEqual(settled(fold));
			}
			expect(duplicates).toBeGreaterThan(SERVER_SEEDS);
			expect(estimated).toBeGreaterThan(SERVER_SEEDS);
			expect([...types].sort()).toEqual([
				'set.delete',
				'set.edit',
				'set.log',
				'set.skip',
				'workout.abandon',
				'workout.finish',
				'workout.start',
				'workout.update'
			]);
		});
	}, 120_000);
});
