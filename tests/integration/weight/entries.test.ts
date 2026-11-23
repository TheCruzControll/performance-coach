/**
 * The owner's weigh-ins through the services on real Postgres: logging (one per day, replacing
 * the day's entry and returning it), editing and deleting, owner scoping, the owner's calendar day,
 * and Undo of a coach write.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createWeightRepository } from '../../../src/lib/server/db';
import {
	ProfileInputError,
	ProfileNotFoundError,
	saveBasics
} from '../../../src/lib/server/services/profile';
import {
	deleteWeight,
	editWeight,
	logWeight,
	undoCoachWeight,
	WeightUndoError
} from '../../../src/lib/server/services/weight';
import { holdTransaction, lockWaiters, withCommitted, withRollback } from '../helpers';
import { clock, fieldErrors, makeOwner, makeSecondOwner } from '../profile/fixtures';

const kg = (value: number, measuredOn: string) => ({ value, unit: 'kg', measuredOn });

describe('logging a weigh-in', () => {
	it('records today on the owner’s local day, from the log source', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveBasics(
				owner,
				{ name: 'Niko', weightUnit: 'kg', distanceUnit: 'km', timeZone: 'America/Los_Angeles' },
				{ db }
			);
			// 22:30 on 5 November in Los Angeles is 6 November in UTC: the owner's day is the 5th.
			const at = { db, now: () => new Date('2026-11-06T06:30:00Z') };
			const { entry, replaced } = await logWeight(owner, { value: 82.4, unit: 'kg' }, at);
			expect(replaced).toBeNull();
			expect(entry).toMatchObject({
				value: 82.4,
				unit: 'kg',
				measuredOn: '2026-11-05',
				source: 'log',
				runId: null,
				replaced: null
			});
		});
	});

	it('replaces a day’s weigh-in, keeps its id, and returns the entry it replaced', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const time = clock('2026-11-10T08:00:00Z');
			const first = await logWeight(owner, kg(82.4, '2026-11-10'), { db, now: time.now });
			const second = await logWeight(owner, kg(81.9, '2026-11-10'), { db, now: time.now });
			expect(second.entry.id).toBe(first.entry.id);
			expect(second.entry.value).toBe(81.9);
			expect(second.replaced).toMatchObject({ id: first.entry.id, value: 82.4 });
			const rows = await db.execute<{ n: number }>(
				sql`select count(*)::int as n from body_weight_entries where owner_id = ${owner}`
			);
			expect(rows.rows[0]).toEqual({ n: 1 });
		});
	});

	it('takes a past day, and refuses a day after today at that field', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const time = clock('2026-11-10T08:00:00Z');
			const past = await logWeight(owner, kg(83, '2026-11-01'), { db, now: time.now });
			expect(past.entry.measuredOn).toBe('2026-11-01');
			expect(
				await fieldErrors(logWeight(owner, kg(83, '2026-11-11'), { db, now: time.now }))
			).toEqual({ measuredOn: 'That day hasn’t come yet' });
		});
	});

	it('refuses an implausible value and a unit it does not know', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(
				await fieldErrors(
					logWeight(owner, { value: 20, unit: 'stone', measuredOn: '2026-11-01' }, { db })
				)
			).toEqual({ unit: 'Pick kg or lb' });
			expect(await fieldErrors(logWeight(owner, kg(20, '2026-11-01'), { db }))).toEqual({
				value: 'Between 25 and 350 kg'
			});
		});
	});

	it('a coach write keeps its run and the entry it replaced; any other source clears both', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const run = crypto.randomUUID();
			const earlier = await logWeight(owner, kg(82.4, '2026-11-10'), { db });
			const coach = await logWeight(owner, kg(82, '2026-11-10'), {
				db,
				source: 'coach',
				runId: run
			});
			expect(coach.entry).toMatchObject({
				source: 'coach',
				runId: run,
				value: 82,
				replaced: { value: 82.4, unit: 'kg', source: 'log' }
			});
			expect(coach.replaced).toMatchObject({ id: earlier.entry.id, value: 82.4 });

			// A second coach write in the same run keeps the entry the run first replaced, so Undo goes
			// back past both writes to what the owner had before the run.
			const again = await logWeight(owner, kg(81.5, '2026-11-10'), {
				db,
				source: 'coach',
				runId: run
			});
			expect(again.entry.replaced).toMatchObject({ value: 82.4, unit: 'kg', source: 'log' });
			expect(await undoCoachWeight(owner, again.entry.id, run, { db })).toMatchObject({
				entry: { id: earlier.entry.id, value: 82.4, source: 'log', runId: null, replaced: null }
			});

			// On a day the run filled, a second write has nothing to restore: Undo deletes the entry.
			const filled = await logWeight(owner, kg(80, '2026-11-14'), {
				db,
				source: 'coach',
				runId: run
			});
			const refilled = await logWeight(owner, kg(79.5, '2026-11-14'), {
				db,
				source: 'coach',
				runId: run
			});
			expect(refilled.entry).toMatchObject({ id: filled.entry.id, replaced: null });
			expect(await undoCoachWeight(owner, refilled.entry.id, run, { db })).toEqual({ entry: null });

			// Any other source clears the run and the entry it replaced.
			await logWeight(owner, kg(80, '2026-11-13'), { db, source: 'coach', runId: run });
			const plain = await logWeight(owner, kg(79.5, '2026-11-13'), { db });
			expect(plain.entry).toMatchObject({ source: 'log', runId: null, replaced: null });
		});
	});

	it('refuses a coach write without the run that made it', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await expect(logWeight(owner, kg(82, '2026-11-10'), { db, source: 'coach' })).rejects.toThrow(
				'needs the run'
			);
		});
	});
});

describe('editing and deleting a weigh-in', () => {
	it('edits the value and unit in place, and clears a coach run', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await logWeight(owner, kg(82, '2026-11-10'), {
				db,
				source: 'coach',
				runId: crypto.randomUUID()
			});
			const edited = await editWeight(
				owner,
				entry.id,
				{ value: 180.2, unit: 'lb', measuredOn: '2026-11-10' },
				{ db }
			);
			expect(edited).toMatchObject({
				id: entry.id,
				value: 180.2,
				unit: 'lb',
				measuredOn: '2026-11-10',
				source: 'log',
				runId: null,
				replaced: null
			});
		});
	});

	it('moves a weigh-in to an empty day, and refuses a day that already has one', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const moving = await logWeight(owner, kg(82.4, '2026-11-10'), { db });
			await logWeight(owner, kg(81, '2026-11-12'), { db });
			expect(
				await fieldErrors(editWeight(owner, moving.entry.id, kg(82.4, '2026-11-12'), { db }))
			).toEqual({ measuredOn: 'That day already has a weigh-in' });
			const moved = await editWeight(owner, moving.entry.id, kg(82.4, '2026-11-09'), { db });
			expect(moved.measuredOn).toBe('2026-11-09');
		});
	});

	it('a move that loses its day to a write that commits first is refused at that field', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const moving = await logWeight(owner, kg(82.4, '2026-11-10'), { db });
			// Another connection takes 2026-11-12 and holds it uncommitted: the day check does not
			// see it, so the move reaches the one-per-day index and waits on it.
			const taker = await holdTransaction((tx) =>
				logWeight(owner, kg(81, '2026-11-12'), { db: tx })
			);
			const move = editWeight(owner, moving.entry.id, kg(82.4, '2026-11-12'), { db }).then(
				() => null,
				(err: unknown) => err
			);
			await lockWaiters(1);
			await taker.commit();
			const refusal = await move;
			expect(refusal).toBeInstanceOf(ProfileInputError);
			expect((refusal as ProfileInputError).errors).toEqual({
				measuredOn: 'That day already has a weigh-in'
			});
			expect(await createWeightRepository(db).getById(owner, moving.entry.id)).toMatchObject({
				measuredOn: '2026-11-10',
				value: 82.4
			});
		});
	});

	it('a missing weigh-in is not found', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await expect(editWeight(owner, 999_999, kg(82, '2026-11-10'), { db })).rejects.toThrow(
				ProfileNotFoundError
			);
			await expect(deleteWeight(owner, 999_999, { db })).rejects.toThrow(ProfileNotFoundError);
		});
	});

	it('deletes a weigh-in, and a second delete is not found', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await logWeight(owner, kg(82, '2026-11-10'), { db });
			await deleteWeight(owner, entry.id, { db });
			await expect(deleteWeight(owner, entry.id, { db })).rejects.toThrow(ProfileNotFoundError);
		});
	});
});

describe('owner scoping', () => {
	it('another owner cannot edit, delete or undo a weigh-in, and it stays as it was', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const run = crypto.randomUUID();
			const { entry } = await logWeight(owner, kg(82, '2026-11-10'), {
				db,
				source: 'coach',
				runId: run
			});
			const someoneElse = await makeSecondOwner(db);
			await expect(editWeight(someoneElse, entry.id, kg(70, '2026-11-10'), { db })).rejects.toThrow(
				ProfileNotFoundError
			);
			await expect(deleteWeight(someoneElse, entry.id, { db })).rejects.toThrow(
				ProfileNotFoundError
			);
			await expect(undoCoachWeight(someoneElse, entry.id, run, { db })).rejects.toMatchObject({
				name: 'WeightUndoError',
				reason: 'gone'
			});
			expect(await createWeightRepository(db).getById(owner, entry.id)).toMatchObject({
				value: 82,
				runId: run,
				source: 'coach'
			});
		});
	});
});

describe('undoing a coach write', () => {
	it('restores the entry a coach write replaced, and removes a coach entry on a new day', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const run = crypto.randomUUID();
			const earlier = await logWeight(owner, kg(82.4, '2026-11-10'), { db });
			const coach = await logWeight(owner, kg(82, '2026-11-10'), {
				db,
				source: 'coach',
				runId: run
			});
			const restored = await undoCoachWeight(owner, coach.entry.id, run, { db });
			expect(restored.entry).toMatchObject({
				id: earlier.entry.id,
				value: 82.4,
				unit: 'kg',
				measuredOn: '2026-11-10',
				source: 'log',
				runId: null,
				replaced: null
			});

			const fresh = await logWeight(owner, kg(79, '2026-11-11'), {
				db,
				source: 'coach',
				runId: run
			});
			expect(await undoCoachWeight(owner, fresh.entry.id, run, { db })).toEqual({ entry: null });
		});
	});

	it('refuses an undo after an edit as changed, and a second undo of a removed entry as gone', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const run = crypto.randomUUID();
			const edited = await logWeight(owner, kg(79, '2026-11-11'), {
				db,
				source: 'coach',
				runId: run
			});
			await editWeight(owner, edited.entry.id, kg(79.4, '2026-11-11'), { db });
			await expect(undoCoachWeight(owner, edited.entry.id, run, { db })).rejects.toMatchObject({
				reason: 'changed'
			});

			const removed = await logWeight(owner, kg(78, '2026-11-12'), {
				db,
				source: 'coach',
				runId: run
			});
			await undoCoachWeight(owner, removed.entry.id, run, { db });
			const second = undoCoachWeight(owner, removed.entry.id, run, { db });
			await expect(second).rejects.toThrow(WeightUndoError);
			await expect(second).rejects.toMatchObject({ reason: 'gone' });
		});
	});

	it('a second undo after a replace is changed: Undo put back the owner’s own entry', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const run = crypto.randomUUID();
			await logWeight(owner, kg(82.4, '2026-11-10'), { db });
			const coach = await logWeight(owner, kg(82, '2026-11-10'), {
				db,
				source: 'coach',
				runId: run
			});
			await undoCoachWeight(owner, coach.entry.id, run, { db });
			const second = undoCoachWeight(owner, coach.entry.id, run, { db });
			await expect(second).rejects.toThrow(WeightUndoError);
			await expect(second).rejects.toMatchObject({ reason: 'changed' });
		});
	});

	it('refuses an undo from another run as changed', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { entry } = await logWeight(owner, kg(78, '2026-11-12'), {
				db,
				source: 'coach',
				runId: crypto.randomUUID()
			});
			await expect(
				undoCoachWeight(owner, entry.id, crypto.randomUUID(), { db })
			).rejects.toMatchObject({ reason: 'changed' });
		});
	});
});
