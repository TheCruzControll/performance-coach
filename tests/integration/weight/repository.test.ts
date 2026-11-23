/**
 * The weight repository on real Postgres: one weigh-in per owner per day (upsertForDay returns the
 * entry it replaced), the coach's run columns, the one active goal, and goal milestones. Every
 * read and write is scoped to the owner.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { WeightSource } from '../../../src/lib/domain/profile/catalog';
import {
	createWeightRepository,
	type Executor,
	type NewWeightGoal,
	type WeightEntryValues,
	weightGoals
} from '../../../src/lib/server/db';
import { withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';

const t0 = new Date('2026-11-01T08:00:00Z');
const t1 = new Date('2026-11-02T08:00:00Z');

function weighIn(overrides: Partial<WeightEntryValues> = {}): WeightEntryValues {
	return {
		value: 74.6,
		unit: 'kg',
		measuredOn: '2026-11-01',
		source: 'profile',
		runId: null,
		replaced: null,
		...overrides
	};
}

function goal(ownerId: string, overrides: Partial<NewWeightGoal> = {}): NewWeightGoal {
	return {
		ownerId,
		unit: 'kg',
		startOn: '2026-11-01',
		startWeight: 80,
		targetWeight: 75,
		targetOn: '2027-01-31',
		source: 'profile',
		createdAt: t0,
		updatedAt: t0,
		...overrides
	};
}

const UNDO = Symbol('undo');
interface PgError {
	code?: string;
	constraint?: string;
}

/** The constraint a write is refused by, or null when it is written (then rolled back). */
async function attempt(db: Executor, write: (tx: Executor) => Promise<unknown>) {
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
	throw new Error('unreachable');
}

const refused = (code: string, constraint: string) => ({ code, constraint });

describe('weigh-ins', () => {
	it('record a day once, and a later write for the day replaces it and returns what it replaced', async () => {
		await withRollback(async (db) => {
			const repo = createWeightRepository(db);
			const owner = await makeOwner(db);

			const first = await repo.upsertForDay(owner, weighIn(), t0);
			expect(first.previous).toBeNull();
			expect(first.entry).toMatchObject({
				ownerId: owner,
				value: 74.6,
				unit: 'kg',
				measuredOn: '2026-11-01',
				source: 'profile',
				runId: null,
				replaced: null,
				createdAt: t0,
				updatedAt: t0
			});

			const runId = crypto.randomUUID();
			const replaced = { value: 74.6, unit: 'kg' as const, source: 'profile' };
			const second = await repo.upsertForDay(
				owner,
				weighIn({ value: 74.2, source: 'coach', runId, replaced }),
				t1
			);
			expect(second.previous).toMatchObject({ id: first.entry.id, value: 74.6, source: 'profile' });
			// The day keeps its row (id and created_at); the write changes what it holds.
			expect(second.entry).toMatchObject({
				id: first.entry.id,
				value: 74.2,
				source: 'coach',
				runId,
				replaced,
				createdAt: t0,
				updatedAt: t1
			});
			expect(await repo.listRange(owner, null, '2026-12-31')).toHaveLength(1);
		});
	});

	it('keep each owner’s days apart', async () => {
		await withRollback(async (db) => {
			const repo = createWeightRepository(db);
			const a = await makeOwner(db);
			const b = await makeSecondOwner(db);

			const mine = await repo.upsertForDay(a, weighIn(), t0);
			const theirs = await repo.upsertForDay(b, weighIn({ value: 90 }), t0);
			expect(theirs.previous).toBeNull();
			expect(theirs.entry.id).not.toBe(mine.entry.id);
			expect((await repo.listRange(a, null, '2026-12-31')).map((r) => r.value)).toEqual([74.6]);
		});
	});

	it('read, move, and delete only the owner’s entries', async () => {
		await withRollback(async (db) => {
			const repo = createWeightRepository(db);
			const a = await makeOwner(db);
			const b = await makeSecondOwner(db);
			const { entry } = await repo.upsertForDay(a, weighIn(), t0);

			expect(await repo.getById(a, entry.id)).toMatchObject({ value: 74.6 });
			expect(await repo.getById(b, entry.id)).toBeNull();
			expect(await repo.update(b, entry.id, { value: 1 }, t1)).toBeNull();
			expect(await repo.delete(b, entry.id)).toBeNull();

			const moved = await repo.update(a, entry.id, { measuredOn: '2026-11-05', value: 73 }, t1);
			expect(moved).toMatchObject({
				measuredOn: '2026-11-05',
				value: 73,
				createdAt: t0,
				updatedAt: t1
			});

			expect(await repo.delete(a, entry.id)).toMatchObject({ id: entry.id });
			expect(await repo.getById(a, entry.id)).toBeNull();
		});
	});

	it('refuse a move onto a day the owner already has a weigh-in for', async () => {
		await withRollback(async (db) => {
			const repo = createWeightRepository(db);
			const a = await makeOwner(db);
			const { entry } = await repo.upsertForDay(a, weighIn(), t0);
			await repo.upsertForDay(a, weighIn({ measuredOn: '2026-11-02', value: 73 }), t0);

			expect(
				await attempt(db, (tx) =>
					createWeightRepository(tx).update(a, entry.id, { measuredOn: '2026-11-02' }, t1)
				)
			).toEqual(refused('23505', 'body_weight_entries_owner_day_uq'));
		});
	});

	it('list a window oldest first, from the start when none is given', async () => {
		await withRollback(async (db) => {
			const repo = createWeightRepository(db);
			const a = await makeOwner(db);
			for (const day of ['2026-11-09', '2026-11-01', '2026-11-05', '2026-11-03']) {
				await repo.upsertForDay(a, weighIn({ measuredOn: day }), t0);
			}
			const days = (from: string | null, to: string) =>
				repo.listRange(a, from, to).then((rows) => rows.map((r) => r.measuredOn));

			expect(await days(null, '2026-11-05')).toEqual(['2026-11-01', '2026-11-03', '2026-11-05']);
			expect(await days('2026-11-03', '2026-11-05')).toEqual(['2026-11-03', '2026-11-05']);
			expect(await days(null, '2026-12-31')).toEqual([
				'2026-11-01',
				'2026-11-03',
				'2026-11-05',
				'2026-11-09'
			]);
		});
	});

	it('list the entries of the given coach runs for the owner only', async () => {
		await withRollback(async (db) => {
			const repo = createWeightRepository(db);
			const a = await makeOwner(db);
			const b = await makeSecondOwner(db);
			const run = crypto.randomUUID();
			const other = crypto.randomUUID();
			const replaced = { value: 74.6, unit: 'kg' as const, source: 'profile' };
			await repo.upsertForDay(
				a,
				weighIn({ source: 'coach', runId: run, replaced, measuredOn: '2026-11-01' }),
				t0
			);
			await repo.upsertForDay(
				a,
				weighIn({ source: 'coach', runId: other, replaced: null, measuredOn: '2026-11-02' }),
				t0
			);
			await repo.upsertForDay(a, weighIn({ measuredOn: '2026-11-03' }), t0);
			await repo.upsertForDay(b, weighIn({ source: 'coach', runId: run, replaced: null }), t0);

			expect(await repo.listByRunIds(a, [run])).toMatchObject([
				{ measuredOn: '2026-11-01', runId: run, replaced }
			]);
			expect(await repo.listByRunIds(a, [])).toEqual([]);
			expect(await repo.listByRunIds(b, [other])).toEqual([]);
		});
	});

	it('refuse a source outside its list, and run columns on a write that is not the coach’s', async () => {
		await withRollback(async (db) => {
			const a = await makeOwner(db);
			const write = (overrides: Partial<WeightEntryValues>) =>
				attempt(db, (tx) => createWeightRepository(tx).upsertForDay(a, weighIn(overrides), t0));
			const replaced = { value: 74.6, unit: 'kg' as const, source: 'profile' };

			expect(await write({ source: 'import' as WeightSource })).toEqual(
				refused('23514', 'body_weight_entries_source_ck')
			);
			expect(await write({ source: 'profile', runId: crypto.randomUUID() })).toEqual(
				refused('23514', 'body_weight_entries_run_ck')
			);
			expect(await write({ source: 'coach', replaced })).toEqual(
				refused('23514', 'body_weight_entries_run_ck')
			);
			expect(await write({ source: 'coach', runId: crypto.randomUUID(), replaced })).toBeNull();
		});
	});

	it('delete only the chosen day’s entry', async () => {
		await withRollback(async (db) => {
			const repo = createWeightRepository(db);
			const a = await makeOwner(db);
			await repo.upsertForDay(a, weighIn({ measuredOn: '2026-11-01' }), t0);
			const { entry } = await repo.upsertForDay(a, weighIn({ measuredOn: '2026-11-02' }), t0);

			await repo.delete(a, entry.id);
			expect((await repo.listRange(a, null, '2026-12-31')).map((r) => r.measuredOn)).toEqual([
				'2026-11-01'
			]);
		});
	});
});

describe('weight goals and milestones', () => {
	it('keep one active goal per owner, end it into the history, and list newest first', async () => {
		await withRollback(async (db) => {
			const repo = createWeightRepository(db);
			const a = await makeOwner(db);
			const b = await makeSecondOwner(db);

			const first = await repo.insertGoal(goal(a));
			expect(first).toMatchObject({ status: 'active', endedAt: null, endedReason: null });
			expect(await repo.getActiveGoal(a)).toMatchObject({ id: first.id });
			expect(await repo.getActiveGoal(b)).toBeNull();
			expect(await attempt(db, (tx) => createWeightRepository(tx).insertGoal(goal(a)))).toEqual(
				refused('23505', 'weight_goals_owner_active_uq')
			);

			const ended = await repo.endActiveGoal(a, 'replaced', t1);
			expect(ended).toMatchObject({
				id: first.id,
				status: 'ended',
				endedReason: 'replaced',
				endedAt: t1,
				updatedAt: t1
			});
			expect(await repo.getActiveGoal(a)).toBeNull();
			expect(await repo.endActiveGoal(a, 'cleared', t1)).toBeNull();

			const next = await repo.insertGoal(
				goal(a, { startOn: '2026-11-02', createdAt: t1, updatedAt: t1 })
			);
			expect((await repo.listGoals(a)).map((g) => g.id)).toEqual([next.id, first.id]);
			expect(await repo.listGoals(b)).toEqual([]);
		});
	});

	it('refuse a goal whose target is not after its start, and an ended goal with no end', async () => {
		await withRollback(async (db) => {
			const a = await makeOwner(db);
			expect(
				await attempt(db, (tx) =>
					createWeightRepository(tx).insertGoal(goal(a, { targetOn: '2026-11-01' }))
				)
			).toEqual(refused('23514', 'weight_goals_target_on_ck'));
			expect(
				await attempt(db, (tx) => tx.insert(weightGoals).values(goal(a, { status: 'ended' })))
			).toEqual(refused('23514', 'weight_goals_ended_at_ck'));
		});
	});

	it('replace a goal’s milestones for its owner only, one per day', async () => {
		await withRollback(async (db) => {
			const repo = createWeightRepository(db);
			const a = await makeOwner(db);
			const b = await makeSecondOwner(db);
			const g = await repo.insertGoal(goal(a));

			const set = await repo.replaceMilestones(
				a,
				g.id,
				[
					{ onDate: '2026-12-15', weight: 77, source: 'edited' },
					{ onDate: '2026-12-01', weight: 78, source: 'generated' }
				],
				t0
			);
			expect(set).toHaveLength(2);
			expect(
				(await repo.listMilestones(a, g.id)).map((m) => [m.onDate, m.weight, m.source])
			).toEqual([
				['2026-12-01', 78, 'generated'],
				['2026-12-15', 77, 'edited']
			]);

			// Replacing drops the rows left out.
			await repo.replaceMilestones(
				a,
				g.id,
				[{ onDate: '2026-11-20', weight: 79, source: 'generated' }],
				t1
			);
			expect((await repo.listMilestones(a, g.id)).map((m) => m.onDate)).toEqual(['2026-11-20']);

			// Another owner cannot write to, or read, the goal.
			expect(
				await repo.replaceMilestones(
					b,
					g.id,
					[{ onDate: '2026-11-21', weight: 79, source: 'generated' }],
					t1
				)
			).toBeNull();
			expect(await repo.listMilestones(b, g.id)).toEqual([]);
			expect(await repo.listMilestones(a, g.id)).toHaveLength(1);

			expect(
				await attempt(db, (tx) =>
					createWeightRepository(tx).replaceMilestones(
						a,
						g.id,
						[
							{ onDate: '2026-11-25', weight: 79, source: 'generated' },
							{ onDate: '2026-11-25', weight: 78, source: 'edited' }
						],
						t1
					)
				)
			).toEqual(refused('23505', 'weight_goal_milestones_goal_day_uq'));
		});
	});

	it('delete a goal’s milestones with the goal', async () => {
		await withRollback(async (db) => {
			const repo = createWeightRepository(db);
			const a = await makeOwner(db);
			const g = await repo.insertGoal(goal(a));
			await repo.replaceMilestones(
				a,
				g.id,
				[{ onDate: '2026-12-01', weight: 78, source: 'generated' }],
				t0
			);

			await db.delete(weightGoals).where(eq(weightGoals.id, g.id));
			expect(await repo.listMilestones(a, g.id)).toEqual([]);
		});
	});
});
