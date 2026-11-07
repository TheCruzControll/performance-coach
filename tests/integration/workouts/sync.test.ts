/**
 * The sync endpoint's dispatcher (services/workouts/sync.ts) on real Postgres: workout mutations
 * applied exactly once and in order, the set shapes the screens send, and every refusal.
 *
 * - Batches go through applySyncBatch as the endpoint calls it, with a test transaction as its
 *   db (each mutation's transaction is then a savepoint), except where real connections race.
 * - Ledger and audit assertions filter by the rows a case wrote.
 */
import { and, count, eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
	createMutation,
	type Mutation,
	type MutationOf,
	type MutationPayloads,
	type MutationType,
	type SyncResult
} from '../../../src/lib/domain/workout/index';
import {
	DB_CHECKED_BAD_VALUES,
	envelopeSchema,
	SCHEMA_ONLY_BAD_VALUES,
	type BadValue
} from '../../../src/lib/domain/workout/schemas';
import { validate } from '../../../src/lib/domain/validation';
import { guardRequest } from '../../../src/lib/server/auth/guard';
import { redeemRecoveryCode } from '../../../src/lib/server/auth/recovery';
import {
	getDb,
	painReports,
	syncMutations,
	trainingAudit,
	workouts,
	type Executor
} from '../../../src/lib/server/db';
import { createTrainingLogRepository } from '../../../src/lib/server/db/repositories/training-log';
import { createContext, runWithContext } from '../../../src/lib/server/observability/context';
import { serverTimingHeader } from '../../../src/lib/server/observability/timing';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import {
	applySyncBatch,
	parseSyncBody,
	SyncUnavailableError
} from '../../../src/lib/server/services/workouts/sync';
import { ORIGIN, request, setUpOwner } from '../auth/fixtures';
import { unreachableDb, withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

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

const startOf = (workoutId: string) =>
	createMutation('workout.start', {
		workoutId,
		at: at(),
		payload: {
			kind: 'strength',
			title: 'Lower body & pull',
			sessionType: 'strength',
			discipline: 'strength',
			plannedSessionId: null,
			plannedLineage: null,
			programId: null
		}
	});

const logOf = (
	workoutId: string,
	exerciseId: string,
	over: Partial<MutationPayloads['set.log']> = {},
	minute = 5
) =>
	createMutation('set.log', {
		workoutId,
		at: at(minute),
		payload: { position: 1, plannedLineage: null, setIndex: 1, exerciseId, ...DONE, ...over }
	});

const editOf = (workoutId: string, setId: string, over: Partial<MutationPayloads['set.edit']>) =>
	createMutation('set.edit', {
		workoutId,
		entityId: setId,
		at: at(20),
		payload: { ...DONE, ...over }
	});

const change = <T extends 'set.delete' | 'workout.finish' | 'workout.abandon' | 'workout.update'>(
	type: T,
	workoutId: string,
	payload: MutationPayloads[T],
	entityId?: string
) => createMutation(type, { workoutId, entityId, at: at(50), payload } as never) as MutationOf<T>;

/** Apply mutations as the endpoint does, after JSON (a test never shares objects with it). */
const sync = (db: Executor, owner: string, mutations: readonly unknown[]) =>
	applySyncBatch(owner, JSON.parse(JSON.stringify(mutations)) as Record<string, unknown>[], {
		db
	});

const statuses = (results: readonly SyncResult[]) => results.map((r) => r.status);

/** The owner and the catalogue exercises the cases log. */
async function setup(db: Executor) {
	const owner = await makeOwner(db);
	const keys = await resolveKeys(
		['back_squat', 'pull_up', 'assisted_pull_up', 'plank', 'romanian_deadlift'],
		{ db }
	);
	const id = (key: string) => keys.get(key)!.id;
	return {
		owner,
		squat: id('back_squat'),
		pullUp: id('pull_up'),
		assisted: id('assisted_pull_up'),
		plank: id('plank'),
		rdl: id('romanian_deadlift')
	};
}

/**
 * Another owner, for the refusals that guard against one. The app allows a single owner, so
 * this lifts that rule inside the test's transaction only (Postgres DDL rolls back with it).
 */
async function secondOwner(db: Executor) {
	await db.execute(sql`drop index owners_singleton_uq`);
	await db.execute(sql`alter table owners drop constraint owners_singleton_ck`);
	return makeOwner(db, 'Someone else');
}

/** The owner's started workout: its client id. */
async function started(db: Executor, owner: string) {
	const workout = deviceId();
	const { results } = await sync(db, owner, [startOf(workout)]);
	expect(statuses(results)).toEqual(['applied']);
	return workout;
}

const setRow = async (db: Executor, owner: string, clientMutationId: string) =>
	createTrainingLogRepository(db).set(owner, clientMutationId);

const setRowsOf = async (db: Executor, owner: string, workout: string) =>
	(await createTrainingLogRepository(db).workoutWithSets(owner, workout))!.sets;

const auditCount = async (db: Executor, table: string, rowId: string | number) => {
	const [row] = await db
		.select({ n: count() })
		.from(trainingAudit)
		.where(and(eq(trainingAudit.tableName, table), eq(trainingAudit.rowId, String(rowId))));
	return row!.n;
};

const ledgerHas = async (db: Executor, mutationId: string) => {
	const [row] = await db
		.select({ n: count() })
		.from(syncMutations)
		.where(eq(syncMutations.mutationId, mutationId));
	return row!.n === 1;
};

describe('duplicates and order', () => {
	it('the same mutation id twice gives one row; the second is a duplicate with the canonical row and no audit row', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = await started(db, owner);
			const log = logOf(workout, squat);

			const first = await sync(db, owner, [log]);
			const second = await sync(db, owner, [log]);

			expect(statuses(first.results)).toEqual(['applied']);
			expect(second.results[0]).toMatchObject({ id: log.id, status: 'duplicate' });
			expect(second.results[0]!.canonical!.sets).toEqual([
				expect.objectContaining({ id: log.id, reps: 5, weight: 100, deletedAt: null })
			]);
			const rows = await setRowsOf(db, owner, workout);
			expect(rows).toHaveLength(1);
			expect(await auditCount(db, 'set_records', rows[0]!.id)).toBe(0);
		});
	});

	it('the same batch twice changes nothing the second time', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = deviceId();
			const first = logOf(workout, squat);
			const second = logOf(workout, squat, { setIndex: 2, reps: 4 }, 8);
			const batch = [
				startOf(workout),
				first,
				second,
				editOf(workout, first.id, { reps: 6 }),
				change('workout.finish', workout, { sessionRpe: 8, durationSeconds: 3600 })
			];

			expect(statuses((await sync(db, owner, batch)).results)).toEqual(Array(5).fill('applied'));
			const before = await createTrainingLogRepository(db).workoutWithSets(owner, workout);
			const again = await sync(db, owner, batch);

			expect(statuses(again.results)).toEqual(Array(5).fill('duplicate'));
			expect(await createTrainingLogRepository(db).workoutWithSets(owner, workout)).toEqual(before);
			expect(await auditCount(db, 'workouts', before!.workout.id)).toBe(1);
			// The canonical rows ride on the workout's last result only.
			expect(again.results.map((r) => r.canonical !== undefined)).toEqual([
				false,
				false,
				false,
				false,
				true
			]);
		});
	});

	it('an edit after its create in one batch applies, and its values win', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = deviceId();
			const log = logOf(workout, squat);
			const { results } = await sync(db, owner, [
				startOf(workout),
				log,
				editOf(workout, log.id, { reps: 3, weight: 110 })
			]);

			expect(statuses(results)).toEqual(['applied', 'applied', 'applied']);
			expect(await setRow(db, owner, log.id)).toMatchObject({ reps: 3, weight: 110 });
			expect(results[2]!.canonical!.sets[0]).toMatchObject({ id: log.id, reps: 3, weight: 110 });
		});
	});

	it('an edit sent before its set.log is deferred; then the log and the edit both apply, and the edit wins', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = await started(db, owner);
			const log = logOf(workout, squat);
			const edit = editOf(workout, log.id, { reps: 2 });

			const early = await sync(db, owner, [edit, log]);
			expect(early.results).toEqual([
				{ id: edit.id, status: 'deferred', code: 'missing' },
				expect.objectContaining({ id: log.id, status: 'applied' })
			]);
			expect(await ledgerHas(db, edit.id)).toBe(false);
			expect(await setRow(db, owner, log.id)).toMatchObject({ reps: 5 });

			const later = await sync(db, owner, [edit]);
			expect(statuses(later.results)).toEqual(['applied']);
			expect(await setRow(db, owner, log.id)).toMatchObject({ reps: 2 });
		});
	});

	it('two creates delivered in reverse order both land, ordered by set index', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = await started(db, owner);
			const one = logOf(workout, squat, { setIndex: 1 }, 5);
			const two = logOf(workout, squat, { setIndex: 2, reps: 4 }, 8);

			const { results } = await sync(db, owner, [two, one]);

			expect(statuses(results)).toEqual(['applied', 'applied']);
			expect(results[1]!.canonical!.sets.map((s) => [s.id, s.setIndex])).toEqual([
				[one.id, 1],
				[two.id, 2]
			]);
		});
	});

	it('an old edit replayed after a newer one from another device is a duplicate and overwrites nothing', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = await started(db, owner);
			const log = logOf(workout, squat);
			await sync(db, owner, [log]);
			const phone = editOf(workout, log.id, { reps: 4 });
			const laptop = editOf(workout, log.id, { reps: 3 });

			await sync(db, owner, [phone]);
			await sync(db, owner, [laptop]);
			const replay = await sync(db, owner, [phone]);

			expect(statuses(replay.results)).toEqual(['duplicate']);
			expect(await setRow(db, owner, log.id)).toMatchObject({ reps: 3 });
			expect(replay.results[0]!.canonical!.sets[0]).toMatchObject({ reps: 3 });
		});
	});

	it('a delete, then the same delete replayed: one tombstone, the replay a duplicate', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = await started(db, owner);
			const log = logOf(workout, squat);
			await sync(db, owner, [log]);
			const remove = change('set.delete', workout, {}, log.id);

			const first = await sync(db, owner, [remove]);
			const stored = await setRow(db, owner, log.id);
			const second = await sync(db, owner, [remove]);

			expect(statuses(first.results)).toEqual(['applied']);
			expect(stored!.deletedAt).not.toBeNull();
			expect(statuses(second.results)).toEqual(['duplicate']);
			expect(await setRow(db, owner, log.id)).toEqual(stored);
			expect(second.results[0]!.canonical!.sets[0]!.deletedAt).toBe(
				stored!.deletedAt!.toISOString()
			);
			expect(await auditCount(db, 'set_records', stored!.id)).toBe(1);
		});
	});

	it('the same batch on two connections at once gives one row per set', async () => {
		await withCommitted(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = deviceId();
			const batch = [
				startOf(workout),
				...[1, 2, 3].map((setIndex) => logOf(workout, squat, { setIndex }, setIndex)),
				change('workout.finish', workout, {})
			];

			// Two pool connections: each mutation's claim waits on the other's uncommitted id.
			const [a, b] = await Promise.all([sync(db, owner, batch), sync(db, owner, batch)]);

			const rows = await setRowsOf(db, owner, workout);
			expect(rows.map((s) => s.setIndex)).toEqual([1, 2, 3]);
			for (const [i] of batch.entries()) {
				expect([a.results[i]!.status, b.results[i]!.status].sort()).toEqual([
					'applied',
					'duplicate'
				]);
			}
		});
	});

	it('a finish replayed completes the workout once, with no extra audit row', async () => {
		await withRollback(async (db) => {
			const { owner } = await setup(db);
			const workout = await started(db, owner);
			const finish = change('workout.finish', workout, { sessionRpe: 7.5, notes: 'Strong' });

			const first = await sync(db, owner, [finish]);
			const second = await sync(db, owner, [finish]);

			expect(statuses([...first.results, ...second.results])).toEqual(['applied', 'duplicate']);
			const [row] = await db.select().from(workouts).where(eq(workouts.clientId, workout));
			expect(row).toMatchObject({ status: 'completed', sessionRpe: 7.5, notes: 'Strong' });
			expect(row!.finishedAt!.toISOString()).toBe(finish.at);
			expect(await auditCount(db, 'workouts', row!.id)).toBe(1);
			expect(second.results[0]!.canonical!.workout).toMatchObject({
				id: workout,
				status: 'completed',
				finishedAt: finish.at
			});
		});
	});

	it('update sets notes, session RPE and duration while the workout runs; abandon ends it', async () => {
		await withRollback(async (db) => {
			const { owner } = await setup(db);
			const workout = await started(db, owner);
			const update = change('workout.update', workout, { notes: 'Knee fine', sessionRpe: 6 });
			const same = change('workout.update', workout, { notes: 'Knee fine' });
			const abandon = change('workout.abandon', workout, {});

			const { results } = await sync(db, owner, [update, same, abandon]);

			expect(statuses(results)).toEqual(['applied', 'applied', 'applied']);
			const [row] = await db.select().from(workouts).where(eq(workouts.clientId, workout));
			expect(row).toMatchObject({ notes: 'Knee fine', sessionRpe: 6, status: 'abandoned' });
			expect(row!.finishedAt!.toISOString()).toBe(abandon.at);
			// The update and the abandon; the no-op between them writes nothing.
			expect(await auditCount(db, 'workouts', row!.id)).toBe(2);
		});
	});
});

describe('the set shapes the screens send', () => {
	const rowOf = async (db: Executor, owner: string, m: Mutation) => {
		const { results } = await sync(db, owner, [m]);
		expect(results[0]).toMatchObject({ status: 'applied' });
		return (await setRow(db, owner, m.id))!;
	};

	it('a pull-up stores no weight and no e1RM with nothing added, and 10 kg with no e1RM when added', async () => {
		await withRollback(async (db) => {
			const { owner, pullUp } = await setup(db);
			const workout = await started(db, owner);
			const bodyweight = await rowOf(db, owner, logOf(workout, pullUp, { weight: null, reps: 8 }));
			const weighted = await rowOf(
				db,
				owner,
				logOf(workout, pullUp, { weight: 10, reps: 6, setIndex: 2 })
			);

			expect(bodyweight).toMatchObject({ weight: null, reps: 8, e1rmKg: null });
			expect(weighted).toMatchObject({ weight: 10, reps: 6, e1rmKg: null });
		});
	});

	it('a plank stores its seconds, an assisted pull-up its assistance with no weight', async () => {
		await withRollback(async (db) => {
			const { owner, plank, assisted } = await setup(db);
			const workout = await started(db, owner);
			const hold = await rowOf(
				db,
				owner,
				logOf(workout, plank, { weight: null, reps: null, seconds: 45, rpe: null })
			);
			const helped = await rowOf(
				db,
				owner,
				logOf(workout, assisted, { position: 2, weight: null, assistance: 20, reps: 8 })
			);

			expect(hold).toMatchObject({ seconds: 45, reps: null, weight: null, e1rmKg: null });
			expect(helped).toMatchObject({ assistance: 20, weight: null, reps: 8, e1rmKg: null });
		});
	});

	it('an edit of reps 5 → 4 stores the e1RM again and writes one audit row', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = await started(db, owner);
			const logged = await rowOf(db, owner, logOf(workout, squat));
			await sync(db, owner, [editOf(workout, logged.clientMutationId, { reps: 4 })]);

			const edited = (await setRow(db, owner, logged.clientMutationId))!;
			expect(logged.e1rmKg).toBeGreaterThan(0);
			expect(edited.reps).toBe(4);
			expect(edited.e1rmKg).toBeGreaterThan(0);
			expect(edited.e1rmKg).toBeLessThan(logged.e1rmKg!);
			expect(await auditCount(db, 'set_records', logged.id)).toBe(1);
		});
	});

	it('a skipped set, a set with missed reps and an extra set store their flags', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = await started(db, owner);
			const skip = createMutation('set.skip', {
				workoutId: workout,
				at: at(9),
				payload: { position: 1, plannedLineage: null, setIndex: 3, exerciseId: squat, unit: 'kg' }
			});
			const missed = await rowOf(db, owner, logOf(workout, squat, { reps: 3, missedReps: 2 }));
			const extra = await rowOf(db, owner, logOf(workout, squat, { setIndex: 4, isExtra: true }));
			const skipped = await rowOf(db, owner, skip);

			expect(missed).toMatchObject({ reps: 3, missedReps: 2, isSkipped: false, isExtra: false });
			expect(extra).toMatchObject({ isExtra: true, isSkipped: false });
			expect(skipped).toMatchObject({
				isSkipped: true,
				setIndex: 3,
				reps: null,
				weight: null,
				e1rmKg: null
			});
		});
	});
});

describe('refusals and failures', () => {
	it('a refused mutation answers dotted-path errors and leaves no ledger row; corrected under the same id it applies', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = await started(db, owner);
			const log = logOf(workout, squat, { reps: 500 });

			const refused = await sync(db, owner, [log]);
			expect(refused.results[0]).toMatchObject({ id: log.id, status: 'rejected', code: 'invalid' });
			expect(Object.keys(refused.results[0]!.errors!)).toEqual(['payload.reps']);
			expect(await ledgerHas(db, log.id)).toBe(false);

			const fixed = await sync(db, owner, [{ ...log, payload: { ...log.payload, reps: 5 } }]);
			expect(statuses(fixed.results)).toEqual(['applied']);
			expect(await ledgerHas(db, log.id)).toBe(true);
			expect(await setRow(db, owner, log.id)).toMatchObject({ reps: 5 });
		});
	});

	it('a set the exercise cannot record is rejected at payload.weight or payload.assistance', async () => {
		await withRollback(async (db) => {
			const { owner, squat, pullUp } = await setup(db);
			const workout = await started(db, owner);
			const noWeight = logOf(workout, squat, { weight: null });
			const helped = logOf(workout, pullUp, { weight: null, assistance: 15, setIndex: 2 });

			const { results } = await sync(db, owner, [noWeight, helped]);

			expect(results.map((r) => [r.status, r.code, Object.keys(r.errors ?? {})])).toEqual([
				['rejected', 'invalid', ['payload.weight']],
				['rejected', 'invalid', ['payload.assistance']]
			]);
			expect(await setRowsOf(db, owner, workout)).toEqual([]);
			expect(await ledgerHas(db, noWeight.id)).toBe(false);
		});
	});

	it('a refused row’s later mutation is deferred, while another row’s applies', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = await started(db, owner);
			const bad = logOf(workout, squat, { reps: 500 });
			const edit = editOf(workout, bad.id, { reps: 5 });
			const other = logOf(workout, squat, { setIndex: 2 });

			const { results } = await sync(db, owner, [bad, edit, other]);

			expect(results.map((r) => [r.status, r.code])).toEqual([
				['rejected', 'invalid'],
				['deferred', 'blocked'],
				['applied', undefined]
			]);
			expect((await setRowsOf(db, owner, workout)).map((s) => s.clientMutationId)).toEqual([
				other.id
			]);
		});
	});

	it('a mutation for an unknown workout is deferred; one for another owner’s workout is rejected', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const stranger = await secondOwner(db);
			const theirs = await started(db, stranger);
			const unknown = logOf(deviceId(), squat);
			const intrusion = logOf(theirs, squat);
			const theirFinish = change('workout.finish', theirs, {});

			const { results } = await sync(db, owner, [unknown, intrusion, theirFinish]);

			expect(results.map((r) => [r.status, r.code])).toEqual([
				['deferred', 'missing'],
				['rejected', 'forbidden'],
				['rejected', 'forbidden']
			]);
			expect(await setRowsOf(db, stranger, theirs)).toEqual([]);
			const [row] = await db.select().from(workouts).where(eq(workouts.clientId, theirs));
			expect(row!.status).toBe('in_progress');
		});
	});

	it('a mutation id another owner already used is never answered as this owner’s', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const stranger = await secondOwner(db);
			const theirs = await started(db, stranger);
			const log = logOf(theirs, squat);
			await sync(db, stranger, [log]);

			const { results } = await sync(db, owner, [log]);
			expect(results).toEqual([{ id: log.id, status: 'rejected', code: 'forbidden' }]);
		});
	});

	it('families whose handlers land later answer rejected “unsupported”, with no ledger row', async () => {
		await withRollback(async (db) => {
			const { owner, squat, rdl } = await setup(db);
			const workout = await started(db, owner);
			const swap = createMutation('exercise.substitute', {
				workoutId: workout,
				at: at(10),
				payload: {
					position: 1,
					plannedLineage: null,
					fromExerciseId: squat,
					toExerciseId: rdl,
					reason: 'equipment_unavailable'
				}
			});

			const { results } = await sync(db, owner, [swap]);

			expect(results.map((r) => [r.status, r.code])).toEqual([['rejected', 'unsupported']]);
			expect(await ledgerHas(db, swap.id)).toBe(false);
		});
	});

	describe('bad values', () => {
		const W = '00000000-0000-4000-8000-00000000000a';
		const EXERCISE = '00000000-0000-4000-8000-0000000000e1';
		const VALID: { [T in BadValue['type']]?: MutationPayloads[T] } = {
			'set.log': { position: 1, plannedLineage: null, setIndex: 1, exerciseId: EXERCISE, ...DONE },
			'run.log': { distanceMetres: 5000 },
			'pain.report': {
				position: 1,
				plannedLineage: null,
				exerciseId: EXERCISE,
				area: 'knee',
				severity: 'mild',
				action: 'stopped',
				substitutionId: null,
				note: null
			},
			'other.log': { kind: 'sparring', durationMinutes: 60, rpe: 8, metrics: [], notes: null },
			'exercise.substitute': {
				position: 1,
				plannedLineage: null,
				fromExerciseId: EXERCISE,
				toExerciseId: W,
				reason: 'equipment_unavailable'
			}
		};

		const mutationOf = (bad: BadValue) => {
			const m = createMutation(bad.type as MutationType, {
				workoutId: W,
				at: at(),
				payload: { ...VALID[bad.type], ...bad.payload } as never
			});
			return { ...m, ...bad.envelope };
		};

		it.each([...DB_CHECKED_BAD_VALUES, ...SCHEMA_ONLY_BAD_VALUES].filter((b) => !b.planned))(
			'the schemas refuse $name at $path',
			async (bad) => {
				expect(VALID[bad.type], `a valid ${bad.type}`).toBeDefined();
				const checked = validate(envelopeSchema, mutationOf(bad));
				expect(checked.ok).toBe(false);
				expect(Object.keys(checked.ok ? {} : checked.errors)).toContain(bad.path);
				// And the endpoint answers it so, before any handler runs.
				await withRollback(async (db) => {
					const owner = await makeOwner(db);
					const { results } = await sync(db, owner, [mutationOf(bad)]);
					expect(results[0]).toMatchObject({ status: 'rejected', code: 'invalid' });
					expect(Object.keys(results[0]!.errors!)).toContain(bad.path);
				});
			}
		);

		type PgError = { code?: string; constraint?: string };
		const UNDO = Symbol('undo');
		/** The Postgres error a write in an undone savepoint fails with. */
		async function pgRefusal(db: Executor, write: (tx: Executor) => Promise<unknown>) {
			try {
				await db.transaction(async (tx) => {
					await write(tx);
					throw UNDO;
				});
			} catch (err) {
				if (err === UNDO) return null;
				const { code, constraint } = ((err as { cause?: PgError }).cause ?? err) as PgError;
				return { code, constraint };
			}
			return null;
		}

		it.each(DB_CHECKED_BAD_VALUES)(
			'written past the schemas, Postgres refuses $name',
			async (bad) => {
				await withRollback(async (db) => {
					const { owner, squat } = await setup(db);
					const workout = await started(db, owner);
					const [row] = await db.select().from(workouts).where(eq(workouts.clientId, workout));
					const base = { ownerId: owner, workoutId: row!.id };
					// The payload's fields are the columns' own names in each table.
					const values = { ...bad.payload };
					const write = {
						'set.log': (tx: Executor) =>
							createTrainingLogRepository(tx).insertSet({
								...base,
								clientMutationId: deviceId(),
								exerciseId: squat,
								exercisePosition: 1,
								setIndex: 1,
								...DONE,
								performedAt: new Date(at()),
								...values
							}),
						'run.log': (tx: Executor) =>
							createTrainingLogRepository(tx).insertRun({ ...base, ...values }),
						'pain.report': (tx: Executor) =>
							tx.insert(painReports).values({
								...base,
								id: deviceId(),
								exerciseId: squat,
								exercisePosition: 1,
								action: 'stopped',
								reportedAt: new Date(at()),
								...(values as object)
							}),
						'other.log': (tx: Executor) =>
							tx.execute(
								sql`insert into other_session_records (workout_id, owner_id, kind, duration_minutes, metrics)
									values (${row!.id}, ${owner}, 'sparring', 60, ${JSON.stringify(values.metrics)}::jsonb)`
							)
					}[bad.type as 'set.log'];
					expect(write, `a write for ${bad.type}`).toBeDefined();
					const refusal = await pgRefusal(db, write);
					expect(refusal?.code, bad.name).toBe('23514');
				});
			}
		);
	});

	it('an unreachable database answers SyncUnavailableError (503), with nothing applied', async () => {
		const { db, close } = unreachableDb();
		try {
			const m = startOf(deviceId());
			await expect(sync(db, deviceId(), [m])).rejects.toBeInstanceOf(SyncUnavailableError);
			expect(await ledgerHas(getDb(), m.id)).toBe(false);
		} finally {
			await close();
		}
	});

	it('a failure mid-batch keeps what was applied and answers retry for the rest, half-applying nothing', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = await started(db, owner);
			const one = logOf(workout, squat);
			const two = logOf(workout, squat, { setIndex: 2 });
			const three = logOf(workout, squat, { setIndex: 3 });
			// The second mutation's transaction fails after its ledger claim and its set are written.
			let opened = 0;
			const flaky = new Proxy(db, {
				get(target, key, receiver) {
					if (key !== 'transaction') return Reflect.get(target, key, receiver);
					return (work: (tx: Executor) => Promise<unknown>) =>
						target.transaction(async (tx) => {
							const result = await work(tx);
							if (++opened === 2) throw new Error('connection terminated unexpectedly');
							return result;
						});
				}
			});

			const { results } = await sync(flaky, owner, [one, two, three]);

			expect(results.map((r) => [r.id, r.status])).toEqual([
				[one.id, 'applied'],
				[two.id, 'retry'],
				[three.id, 'retry']
			]);
			expect((await setRowsOf(db, owner, workout)).map((s) => s.clientMutationId)).toEqual([
				one.id
			]);
			expect(await ledgerHas(db, two.id)).toBe(false);
			expect(results[0]!.canonical!.sets).toHaveLength(1);
		});
	});

	it('a set mutation takes at most 5 statements; a 25-mutation batch’s Server-Timing', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = await started(db, owner);
			const sets = Array.from({ length: 12 }, (_, i) =>
				logOf(workout, squat, { setIndex: i + 1 }, i)
			);
			const edits = sets.map((s) => editOf(workout, s.id, { reps: 4 }));

			// Statements the server sends, less transaction control (BEGIN, COMMIT, SAVEPOINT …).
			const spy = vi.spyOn(pg.Client.prototype, 'query');
			const ctx = createContext('sync-25');
			const startedAt = performance.now();
			let calls: unknown[][];
			try {
				const { results } = await runWithContext(ctx, () =>
					sync(db, owner, [...sets, ...edits, change('workout.update', workout, { notes: 'x' })])
				);
				expect(statuses(results)).toEqual(Array(25).fill('applied'));
				calls = [...spy.mock.calls];
			} finally {
				spy.mockRestore();
			}
			const sent = calls
				.map(([query]) => (typeof query === 'string' ? query : (query as { text: string }).text))
				.filter((text) => !/^\s*(begin|commit|rollback|savepoint|release)\b/i.test(text));
			const header = serverTimingHeader(ctx, performance.now() - startedAt);
			console.info(`sync: 25 mutations, ${sent.length} statements; Server-Timing: ${header}`);

			// A log: claim, workout, exercise, insert. An edit: claim, set, exercise, actor, update.
			// The update: claim, lock, actor, update. Then the canonical read: the workout, its sets,
			// substitutions, pain reports, run, other session and exercises.
			expect(sent).toHaveLength(12 * 4 + 12 * 5 + 4 + 7);
			expect(header).toMatch(/^db;dur=[\d.]+;desc="\d+ ops", total;dur=/);
		});
	});

	it('a recovery session gets 403 passkey_required', async () => {
		await withCommitted(async (db) => {
			const owner = await setUpOwner(db);
			const recovered = await redeemRecoveryCode(owner.recoveryCodes[0], undefined, request(), {
				db
			});
			const url = new URL('/api/workouts/sync', ORIGIN);
			const response = await guardRequest({
				url,
				request: new Request(url, {
					method: 'POST',
					headers: { origin: ORIGIN, 'content-type': 'application/json' },
					body: '{"v":1,"mutations":[]}'
				}),
				cookies: {
					get: (name: string) => (name === 'session' ? recovered.token : undefined),
					set: () => {},
					serialize: () => ''
				} as never,
				locals: {} as App.Locals,
				route: { id: '/api/workouts/sync' }
			});
			expect(response?.status).toBe(403);
			expect(await response!.json()).toMatchObject({ error: 'passkey_required' });
		});
	});
});

describe('the request body', () => {
	const mutation = () => logOf(deviceId(), deviceId());

	it('refuses over 64 KB (413), malformed JSON and a malformed protocol (400)', () => {
		const big = JSON.stringify({ v: 1, mutations: [mutation()], pad: 'x'.repeat(64 * 1024) });
		expect(parseSyncBody(big)).toMatchObject({ ok: false, status: 413 });
		expect(parseSyncBody('{"v":1,')).toMatchObject({
			ok: false,
			status: 400,
			error: 'invalid_json'
		});
		for (const body of [
			{ v: 2, mutations: [mutation()] },
			{ v: 1, mutations: [] },
			{ v: 1, mutations: Array.from({ length: 26 }, mutation) },
			{ v: 1, mutations: [{ ...mutation(), id: 'not-a-uuid' }] },
			{ v: 1 }
		]) {
			expect(parseSyncBody(JSON.stringify(body)), JSON.stringify(body).slice(0, 60)).toMatchObject({
				ok: false,
				status: 400,
				error: 'invalid_request'
			});
		}
	});

	it('takes 25 mutations, leaving each one’s own shape to be checked on its own', () => {
		const batch = Array.from({ length: 25 }, mutation);
		const parsed = parseSyncBody(
			JSON.stringify({
				v: 1,
				mutations: [...batch.slice(1), { id: batch[0]!.id, type: 'set.teleport' }]
			})
		);
		expect(parsed).toMatchObject({ ok: true });
		expect(parsed.ok && parsed.mutations).toHaveLength(25);
	});
});

describe('discarded changes (finding F1 of the workout sync model)', () => {
	const syncWith = (db: Executor, owner: string, mutations: unknown[], discarded: string[]) =>
		applySyncBatch(owner, JSON.parse(JSON.stringify(mutations)) as Record<string, unknown>[], {
			db,
			discarded
		});

	it('a request the device stopped waiting for never lands a discarded edit after a newer one', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = await started(db, owner);
			const log = logOf(workout, squat);
			await sync(db, owner, [log]);
			// Timed out on the device while the server still runs it, then discarded.
			const stuck = editOf(workout, log.id, { reps: 6 });
			const newer = editOf(workout, log.id, { reps: 4 });

			const next = await syncWith(db, owner, [newer], [stuck.id]);
			const late = await sync(db, owner, [stuck]);

			expect(statuses(next.results)).toEqual(['applied']);
			expect(late.results[0]).toMatchObject({ id: stuck.id, status: 'duplicate' });
			expect(await setRow(db, owner, log.id)).toMatchObject({ reps: 4 });
			const [row] = await db
				.select({ type: syncMutations.type })
				.from(syncMutations)
				.where(eq(syncMutations.mutationId, stuck.id));
			expect(row).toEqual({ type: 'discarded' });
		});
	});

	it('an id applied before keeps its ledger row, and the discard alone is a request', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = await started(db, owner);
			const log = logOf(workout, squat);
			await sync(db, owner, [log]);

			expect(await syncWith(db, owner, [], [log.id])).toEqual({ v: 1, results: [] });
			const [row] = await db
				.select({ type: syncMutations.type })
				.from(syncMutations)
				.where(eq(syncMutations.mutationId, log.id));
			expect(row).toEqual({ type: 'set.log' });
		});
	});

	it('takes discarded ids alone, up to 25, and refuses an empty request', () => {
		const ids = (n: number) => Array.from({ length: n }, deviceId);
		const body = (discarded: string[]) => JSON.stringify({ v: 1, mutations: [], discarded });
		expect(parseSyncBody(body(ids(25)))).toMatchObject({ ok: true, mutations: [] });
		for (const discarded of [[], ids(26), ['not-a-uuid']]) {
			expect(parseSyncBody(body(discarded))).toMatchObject({ ok: false, status: 400 });
		}
		expect(parseSyncBody(JSON.stringify({ v: 1, mutations: [] }))).toMatchObject({
			ok: false,
			errors: { mutations: 'Nothing to sync' }
		});
	});
});

describe('a start whose planned session does not exist', () => {
	it('is refused at payload.plannedSessionId, and the same id applies once kept unplanned', async () => {
		await withRollback(async (db) => {
			const { owner, squat } = await setup(db);
			const workout = deviceId();
			const start = startOf(workout);
			const planned = { ...start, payload: { ...start.payload, plannedSessionId: deviceId() } };
			const log = logOf(workout, squat);

			const refused = await sync(db, owner, [planned, log]);
			expect(refused.results).toEqual([
				{
					id: start.id,
					status: 'rejected',
					code: 'invalid',
					errors: { 'payload.plannedSessionId': 'No such planned session' }
				},
				{ id: log.id, status: 'deferred', code: 'blocked' }
			]);
			expect(await ledgerHas(db, start.id)).toBe(false);

			const kept = await sync(db, owner, [start, log]);
			expect(statuses(kept.results)).toEqual(['applied', 'applied']);
			expect(kept.results[1]!.canonical!.workout).toMatchObject({ plannedSessionId: null });
		});
	});
});
