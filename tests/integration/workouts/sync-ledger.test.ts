/**
 * The sync ledger on real Postgres (ADR 0012, 'Exactly once'): a mutation id is applied at most
 * once.
 * - A second claim of an id reads 'seen' and leaves the stored row as it was.
 * - A claim rolled back with its transaction leaves nothing, so the mutation can be corrected and
 *   re-sent under the same id.
 * - Two connections claiming one id at once: the second waits on the first's uncommitted key and
 *   reads 'seen' once it commits, or claims the id itself once it rolls back.
 * - appliedIn answers for the owner's ledger only.
 * - Ledger rows are never updated or deleted; TRUNCATE (the withCommitted cleanup) is the one
 *   bypass.
 */
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, syncMutations, type Executor } from '../../../src/lib/server/db';
import {
	claimMutation,
	createSyncRepository,
	type NewSyncMutation
} from '../../../src/lib/server/db/repositories/sync';
import { holdTransaction, lockWaiters, withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const id = () => crypto.randomUUID();
const CLIENT_AT = new Date('2026-11-10T07:42:13.250Z');

/** A set.log as the endpoint records it: its id is the new set's client id. */
function setLog(ownerId: string, overrides: Partial<NewSyncMutation> = {}): NewSyncMutation {
	const mutationId = id();
	return {
		mutationId,
		ownerId,
		type: 'set.log',
		entityId: mutationId,
		workoutClientId: id(),
		clientAt: CLIENT_AT,
		requestId: 'req-1',
		...overrides
	};
}

/** Claim in a savepoint of `db`'s transaction, as the endpoint claims in each mutation's own. */
const claim = (db: Executor, row: NewSyncMutation) =>
	db.transaction((tx) => claimMutation(tx, row));

const ledger = (db: Executor) =>
	db.select().from(syncMutations).orderBy(syncMutations.appliedAt, syncMutations.mutationId);

interface PgError {
	code?: string;
	table?: string;
	constraint?: string;
}

/** The Postgres error `write` failed with (drizzle wraps it as the cause), in a savepoint. */
async function refusal(db: Executor, write: (tx: Executor) => Promise<unknown>) {
	try {
		await db.transaction(write);
	} catch (err) {
		const { code, table, constraint } = ((err as { cause?: PgError }).cause ?? err) as PgError;
		return { code, table, constraint };
	}
	return null;
}

const UNDO = Symbol('undo');

describe('sync ledger', () => {
	it('claims an id once: a second claim reads seen and keeps the stored row', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const row = setLog(ownerId);

			expect(await claim(tx, row)).toBe('claimed');
			// The same id again, even sent as another type from another request.
			expect(await claim(tx, { ...row, type: 'set.edit', requestId: 'req-2' })).toBe('seen');

			const stored = await ledger(tx);
			expect(stored).toEqual([
				{
					mutationId: row.mutationId,
					ownerId,
					type: 'set.log',
					entityId: row.mutationId,
					workoutClientId: row.workoutClientId,
					clientAt: CLIENT_AT,
					appliedAt: expect.any(Date),
					requestId: 'req-1'
				}
			]);
			// applied_at is the server's: the transaction's time, never the device's.
			const { rows } = await tx.execute<{ server: boolean }>(
				sql`select applied_at = now() as server from sync_mutations`
			);
			expect(rows).toEqual([{ server: true }]);
		});
	});

	it('stores a mutation that names no workout, and a request without an id', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const row = setLog(ownerId, {
				type: 'exercise.create',
				workoutClientId: null,
				requestId: null
			});
			expect(await claim(tx, row)).toBe('claimed');
			expect(await ledger(tx)).toMatchObject([
				{ mutationId: row.mutationId, workoutClientId: null, requestId: null }
			]);
		});
	});

	it('leaves no row for a claim rolled back with its transaction, so the id can be re-sent', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const refused = setLog(ownerId, { type: 'set.log' });

			// The endpoint refuses the mutation after claiming it: its transaction rolls back.
			const outcome = await tx
				.transaction(async (mutation) => {
					expect(await claimMutation(mutation, refused)).toBe('claimed');
					throw UNDO;
				})
				.catch((err: unknown) => err);
			expect(outcome).toBe(UNDO);
			expect(await ledger(tx)).toEqual([]);
			expect(await createSyncRepository(tx).appliedIn(ownerId, [refused.mutationId])).toEqual(
				new Set()
			);

			// Corrected, and re-sent under the same id (even as another type): it is claimed now.
			const corrected = { ...refused, type: 'workout.substitute' };
			expect(await claim(tx, corrected)).toBe('claimed');
			expect(await ledger(tx)).toMatchObject([
				{ mutationId: refused.mutationId, type: 'workout.substitute' }
			]);
		});
	});

	it('gives one of two concurrent claims the id; the other reads seen once the first commits', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			const row = setLog(ownerId);

			// The first connection claims the id and holds its transaction open.
			let first: string | undefined;
			const held = await holdTransaction(async (tx) => {
				first = await claimMutation(tx, row);
			});
			expect(first).toBe('claimed');

			// The second waits on the first's uncommitted key instead of answering.
			let settled = false;
			const second = claim(db, { ...row, requestId: 'req-2' }).finally(() => (settled = true));
			await lockWaiters(1);
			expect(settled).toBe(false);
			expect(await ledger(db)).toEqual([]);

			await held.commit();
			expect(await second).toBe('seen');
			expect(await ledger(db)).toMatchObject([{ mutationId: row.mutationId, requestId: 'req-1' }]);
		});
	});

	it('gives the id to the waiting claim when the first rolls back', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			const row = setLog(ownerId);

			// The first connection claims the id, then its mutation is refused and rolls back.
			let refuse!: () => void;
			const refused = new Promise<void>((resolve) => (refuse = resolve));
			let claimed!: (claim: string) => void;
			const firstClaim = new Promise<string>((resolve) => (claimed = resolve));
			const firstDone = db
				.transaction(async (tx) => {
					claimed(await claimMutation(tx, row));
					await refused;
					throw UNDO;
				})
				.catch((err: unknown) => err);
			expect(await firstClaim).toBe('claimed');

			const second = claim(db, { ...row, requestId: 'req-2' });
			await lockWaiters(1);
			refuse();
			expect(await firstDone).toBe(UNDO);
			expect(await second).toBe('claimed');
			expect(await ledger(db)).toMatchObject([{ mutationId: row.mutationId, requestId: 'req-2' }]);
		});
	});

	it('answers which ids are applied, and only for the owner asking', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const applied = [setLog(ownerId), setLog(ownerId)];
			for (const row of applied) expect(await claim(tx, row)).toBe('claimed');
			const pending = id();
			const repo = createSyncRepository(tx);

			expect(
				await repo.appliedIn(ownerId, [pending, applied[1]!.mutationId, applied[0]!.mutationId])
			).toEqual(new Set([applied[0]!.mutationId, applied[1]!.mutationId]));
			expect(await repo.appliedIn(ownerId, [pending])).toEqual(new Set());
			expect(await repo.appliedIn(ownerId, [])).toEqual(new Set());
			// There is one owner (owners_singleton_uq): an id never answers for anyone else.
			expect(await repo.appliedIn(id(), [applied[0]!.mutationId])).toEqual(new Set());
		});
	});

	it('refuses every UPDATE and DELETE of a ledger row', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const row = setLog(ownerId);
			await claim(tx, row);
			const byId = eq(syncMutations.mutationId, row.mutationId);

			expect(
				await refusal(tx, (t) => t.update(syncMutations).set({ requestId: 'req-9' }).where(byId))
			).toEqual({ code: '23001', table: 'sync_mutations', constraint: 'history_refuse_update' });
			expect(await refusal(tx, (t) => t.delete(syncMutations).where(byId))).toEqual({
				code: '23001',
				table: 'sync_mutations',
				constraint: 'history_refuse_delete'
			});
			expect(await ledger(tx)).toMatchObject([{ mutationId: row.mutationId, requestId: 'req-1' }]);
		});
	});

	it('guards the ledger with row triggers only, none on TRUNCATE', async () => {
		// tgtype bit 5 (32) is TRIGGER_TYPE_TRUNCATE.
		const { rows } = await getDb().execute<{ name: string; truncate: boolean }>(
			sql`select t.tgname as name, (t.tgtype & 32) <> 0 as truncate
				from pg_trigger t join pg_class c on c.oid = t.tgrelid
				where not t.tgisinternal and c.relname = 'sync_mutations' order by 1`
		);
		expect(rows).toEqual([
			{ name: 'sync_mutations_refuse_delete', truncate: false },
			{ name: 'sync_mutations_refuse_update', truncate: false }
		]);
	});

	it('is emptied by the withCommitted cleanup', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			expect(await claim(db, setLog(ownerId))).toBe('claimed');
			expect(await ledger(db)).toHaveLength(1);
		});
		expect(await ledger(getDb())).toEqual([]);
	});
});
