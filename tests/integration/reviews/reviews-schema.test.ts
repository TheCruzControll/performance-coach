/**
 * Weekly and cycle reviews on real Postgres (the M6 plan's reviews-db: 'Reviews are completed,
 * not replaced, and earlier rows stay valid'):
 * - A row written before M6 (snapshot_version 0, as M3's and M5's inserts are) stays valid. From
 *   snapshot_version 1, named CHECKs ask for the analytics version, the inputs digest, a
 *   narrative stamped with when it was written, and the program version (and a cycle's block
 *   dates) it reviewed.
 * - Identity and content never change. The narrative, its run, thread and time, proposal_id and
 *   next_version_id are set once, from null. Supersession is set once and freezes the row, and a
 *   cycle review whose next block is planned is never superseded. updated_at is stamped on a
 *   change. DELETE is refused; TRUNCATE (the test and e2e reset) is not.
 * - A refresh marks the live row superseded, naming the next revision's id, and then inserts it,
 *   in one transaction (superseded_by is deferred). One live review per week or block; the
 *   superseded ones stay beside it, and M5's coach memory reads only the live one.
 * Refusals are pinned to their SQLSTATE, table and constraint (or guard).
 */
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	agentRuns,
	coachMessages,
	coachProposals,
	coachThreads,
	cycleReviews,
	getDb,
	programBlocks,
	programs,
	programVersions,
	weeklyReviews,
	type Executor
} from '../../../src/lib/server/db';
import {
	latestCycleReview,
	latestWeeklyReviews
} from '../../../src/lib/server/db/queries/coach-memory';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

type PgError = { code?: string; table?: string; constraint?: string };
const UNDO = Symbol('undo');

/** Run `write` in a savepoint that is always undone: the Postgres error, or null if accepted. */
async function attempt(db: Executor, write: (tx: Executor) => Promise<unknown>) {
	try {
		await db.transaction(async (tx) => {
			await write(tx);
			throw UNDO;
		});
	} catch (err) {
		if (err === UNDO) return null;
		const { code, table, constraint } = ((err as { cause?: PgError }).cause ?? err) as PgError;
		return { code, table, constraint };
	}
	throw new Error('unreachable');
}

const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const GUARD = '23001';
const refused = (code: string, table: string, constraint: string) => ({ code, table, constraint });
const weeklyCk = (name: string) => refused(CHECK, 'weekly_reviews', `weekly_reviews_${name}_ck`);
const cycleCk = (name: string) => refused(CHECK, 'cycle_reviews', `cycle_reviews_${name}_ck`);
const weeklyGuard = (name: string) =>
	refused(GUARD, 'weekly_reviews', `weekly_reviews_${name}_guard`);
const cycleGuard = (name: string) => refused(GUARD, 'cycle_reviews', `cycle_reviews_${name}_guard`);

const MONDAY = '2026-11-09';
const SUNDAY = '2026-11-15';
const NEXT_MONDAY = '2026-11-16';
const BLOCK_START = '2026-10-19';
const DIGEST = '0123456789abcdef';

type NewWeekly = typeof weeklyReviews.$inferInsert;
type NewCycle = typeof cycleReviews.$inferInsert;

/** An owner with a two-version program and its block, a proposal, and a narration run. */
async function setup(db: Executor) {
	const ownerId = await makeOwner(db);
	const [program] = await db.insert(programs).values({ ownerId, title: 'Fight camp' }).returning();
	const programId = program!.id;
	const version = async (number: number, parentVersionId: string | null) => {
		const [row] = await db
			.insert(programVersions)
			.values({
				programId,
				number,
				parentVersionId,
				createdBy: number === 1 ? 'rules' : 'coach',
				summary: number === 1 ? 'Your first program' : 'Next block planned',
				startsOn: BLOCK_START,
				firstPlannedDay: BLOCK_START
			})
			.returning();
		return row!.id;
	};
	const v1 = await version(1, null);
	const v2 = await version(2, v1);
	const [block] = await db
		.insert(programBlocks)
		.values({
			programId,
			position: 1,
			phase: 'baseline',
			name: 'Baseline',
			startsOn: BLOCK_START,
			endsOn: SUNDAY
		})
		.returning();
	const proposal = async () => {
		const [row] = await db
			.insert(coachProposals)
			.values({
				ownerId,
				kind: 'program_adjustment',
				title: 'Lighter squats next week',
				summary: 'Squats drop 5 kg next week.',
				rationale: 'Two sessions ended above RPE 9.',
				payload: {},
				programId,
				baseVersionId: v1
			})
			.returning();
		return row!.id;
	};
	const narration = async () => {
		const [thread] = await db
			.insert(coachThreads)
			.values({
				ownerId,
				title: 'Week of 9 Nov',
				titleSource: 'first_message',
				entry: { from: 'weekly_review', ref: null },
				segmentPromptVersion: 'prompt-1',
				segmentProgramVersionId: v1
			})
			.returning();
		const [message] = await db
			.insert(coachMessages)
			.values({
				ownerId,
				threadId: thread!.id,
				seq: 1,
				segment: 1,
				role: 'user',
				kind: 'owner_message',
				apiVisible: true,
				content: 'Write up my week',
				clientMessageId: crypto.randomUUID()
			})
			.returning();
		const [run] = await db
			.insert(agentRuns)
			.values({
				ownerId,
				threadId: thread!.id,
				triggerMessageId: message!.id,
				kind: 'turn',
				provider: 'mock',
				model: 'claude-opus-5-5',
				effort: 'medium',
				promptVersion: 'prompt-1'
			})
			.returning();
		return { threadId: thread!.id, runId: run!.id };
	};
	const first = await narration();
	const second = await narration();

	/** A weekly review as M6 writes it: version 1, with its analytics, digest and program. */
	const weekly = (values: Partial<NewWeekly> = {}): NewWeekly => ({
		ownerId,
		weekStartsOn: MONDAY,
		snapshot: { version: 1, adherence: 0.8 },
		summary: 'Four of five sessions done; squats moved well.',
		snapshotVersion: 1,
		analyticsVersion: 1,
		inputsDigest: DIGEST,
		programId,
		versionId: v1,
		...values
	});
	/** A cycle review as M6 writes it: version 1, naming the version and dates of its block. */
	const cycle = (values: Partial<NewCycle> = {}): NewCycle => ({
		ownerId,
		programId,
		blockLineageId: block!.lineageId,
		snapshot: { version: 1, adherence: 0.9 },
		summary: 'Squat e1RM up 5 kg; ready for the next block.',
		snapshotVersion: 1,
		analyticsVersion: 1,
		inputsDigest: DIGEST,
		versionId: v1,
		blockStartsOn: BLOCK_START,
		blockEndsOn: SUNDAY,
		...values
	});
	return { ownerId, programId, v1, v2, proposal, first, second, weekly, cycle };
}

const insertWeekly = (values: NewWeekly) => (tx: Executor) =>
	tx.insert(weeklyReviews).values(values);
const insertCycle = (values: NewCycle) => (tx: Executor) => tx.insert(cycleReviews).values(values);
const updateWeekly = (id: string, set: Partial<NewWeekly>) => (tx: Executor) =>
	tx.update(weeklyReviews).set(set).where(eq(weeklyReviews.id, id));
const updateCycle = (id: string, set: Partial<NewCycle>) => (tx: Executor) =>
	tx.update(cycleReviews).set(set).where(eq(cycleReviews.id, id));

async function storeWeekly(db: Executor, values: NewWeekly) {
	const [row] = await db.insert(weeklyReviews).values(values).returning();
	return row!;
}
async function storeCycle(db: Executor, values: NewCycle) {
	const [row] = await db.insert(cycleReviews).values(values).returning();
	return row!;
}

/** Check the deferred keys now, as COMMIT would. */
const checkKeysNow = (tx: Executor) => tx.execute(sql`set constraints all immediate`);

describe('rows written before M6', () => {
	it('stay valid at version 0, including M3’s insert with a narrative and a proposal', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			// M5's memory-records insert, verbatim in shape: no M6 column at all.
			const bare = await storeWeekly(db, {
				ownerId: s.ownerId,
				weekStartsOn: '2026-10-26',
				snapshot: {},
				summary: 'A good week'
			});
			expect(bare).toMatchObject({
				snapshotVersion: 0,
				analyticsVersion: 0,
				inputsDigest: null,
				revision: 1,
				programId: null,
				versionId: null,
				supersededAt: null,
				supersededBy: null,
				narrativeRunId: null,
				narrativeThreadId: null,
				narratedAt: null
			});
			// M3's coaching-schema insert: a narrative with no narrated_at, and a proposal.
			const proposalId = await s.proposal();
			const m3 = await storeWeekly(db, {
				ownerId: s.ownerId,
				weekStartsOn: MONDAY,
				snapshot: { planned: 5, completed: 4 },
				summary: 'Four of five sessions done; squats moved well.',
				narrative: 'A solid week.',
				proposalId
			});
			expect(m3).toMatchObject({ snapshotVersion: 0, narrative: 'A solid week.', proposalId });
			const cycle = await storeCycle(db, {
				ownerId: s.ownerId,
				programId: s.programId,
				blockLineageId: crypto.randomUUID(),
				snapshot: { adherence: 0.9 },
				summary: 'Squat e1RM up 5 kg; ready for the next block.',
				nextVersionId: s.v2,
				narrative: 'The baseline block is done.'
			});
			expect(cycle).toMatchObject({
				snapshotVersion: 0,
				versionId: null,
				blockStartsOn: null,
				blockEndsOn: null,
				revision: 1
			});
		});
	});
});

describe('an M6 review', () => {
	it('is stored with its analytics version, digest and program version', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			expect(await attempt(db, insertWeekly(s.weekly()))).toBeNull();
			expect(await attempt(db, insertCycle(s.cycle()))).toBeNull();
			// A week with no program reviews no version.
			const noProgram = s.weekly({ programId: null, versionId: null });
			expect(await attempt(db, insertWeekly(noProgram))).toBeNull();
		});
	});

	it('is refused without a digest, an analytics version or narrated_at, naming each CHECK', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const weekly = async (values: Partial<NewWeekly>) =>
				attempt(db, insertWeekly(s.weekly(values)));
			expect(await weekly({ inputsDigest: null })).toEqual(weeklyCk('digest'));
			expect(await weekly({ inputsDigest: '' })).toEqual(weeklyCk('digest'));
			expect(await weekly({ analyticsVersion: 0 })).toEqual(weeklyCk('analytics'));
			expect(await weekly({ narrative: 'A solid week.' })).toEqual(weeklyCk('narrated'));
			expect(await weekly({ narratedAt: new Date() })).toEqual(weeklyCk('narrated'));
			expect(await weekly({ programId: null })).toEqual(weeklyCk('program'));
			expect(await weekly({ snapshotVersion: -1 })).toEqual(weeklyCk('versions'));
			expect(await weekly({ revision: 0 })).toEqual(weeklyCk('revision'));
			expect(await weekly({ supersededAt: new Date() })).toEqual(weeklyCk('superseded'));
			// A write-up with its time is accepted.
			expect(await weekly({ narrative: 'A solid week.', narratedAt: new Date() })).toBeNull();

			const cycle = async (values: Partial<NewCycle>) => attempt(db, insertCycle(s.cycle(values)));
			expect(await cycle({ inputsDigest: null })).toEqual(cycleCk('digest'));
			expect(await cycle({ analyticsVersion: 0 })).toEqual(cycleCk('analytics'));
			expect(await cycle({ narrative: 'The block is done.' })).toEqual(cycleCk('narrated'));
			expect(await cycle({ versionId: null })).toEqual(cycleCk('block'));
			expect(await cycle({ blockStartsOn: null })).toEqual(cycleCk('block'));
			expect(await cycle({ blockEndsOn: null })).toEqual(cycleCk('block'));
			expect(await cycle({ blockEndsOn: '2026-10-18' })).toEqual(cycleCk('block'));
			expect(await cycle({ blockEndsOn: BLOCK_START })).toBeNull();
			expect(await cycle({ snapshotVersion: 0, analyticsVersion: -1 })).toEqual(
				cycleCk('versions')
			);
			expect(await cycle({ revision: 0 })).toEqual(cycleCk('revision'));
		});
	});
});

describe('a stored review', () => {
	it('refuses every change to its identity and content, naming its guard', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const weekly = await storeWeekly(db, s.weekly());
			const weeklyChanges: Partial<NewWeekly>[] = [
				{ id: crypto.randomUUID() },
				{ ownerId: crypto.randomUUID() },
				{ weekStartsOn: NEXT_MONDAY },
				{ snapshot: { version: 1, adherence: 1 } },
				{ summary: 'Every session done.' },
				{ snapshotVersion: 2 },
				{ analyticsVersion: 2 },
				{ inputsDigest: 'fedcba9876543210' },
				{ revision: 2 },
				{ programId: null, versionId: null },
				{ versionId: s.v2 },
				{ createdAt: new Date(0) }
			];
			for (const change of weeklyChanges) {
				expect(await attempt(db, updateWeekly(weekly.id, change)), JSON.stringify(change)).toEqual(
					weeklyGuard('content')
				);
			}
			const cycle = await storeCycle(db, s.cycle());
			const cycleChanges: Partial<NewCycle>[] = [
				{ programId: s.programId, blockLineageId: crypto.randomUUID() },
				{ snapshot: {} },
				{ summary: 'Changed.' },
				{ versionId: s.v2 },
				{ blockStartsOn: '2026-10-26' },
				{ blockEndsOn: '2026-11-22' },
				{ inputsDigest: 'fedcba9876543210' },
				{ revision: 3 }
			];
			for (const change of cycleChanges) {
				expect(await attempt(db, updateCycle(cycle.id, change)), JSON.stringify(change)).toEqual(
					cycleGuard('content')
				);
			}
		});
	});

	it('sets each write-up, proposal and next-version column once, from null', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const weekly = await storeWeekly(db, s.weekly());
			const proposalId = await s.proposal();
			const narratedAt = new Date('2026-11-16T08:00:00Z');
			const written = {
				narrative: 'A solid week.',
				narrativeRunId: s.first.runId,
				narrativeThreadId: s.first.threadId,
				narratedAt
			};
			await updateWeekly(weekly.id, { proposalId })(db);
			await updateWeekly(weekly.id, written)(db);
			const [stored] = await db.select().from(weeklyReviews).where(eq(weeklyReviews.id, weekly.id));
			expect(stored).toMatchObject({ ...written, proposalId });
			// updated_at is stamped on a change (the statement's time, after the insert's).
			expect(stored!.updatedAt.getTime()).toBeGreaterThan(weekly.updatedAt.getTime());

			const again: Partial<NewWeekly>[] = [
				{ proposalId: await s.proposal() },
				{ proposalId: null },
				{ narrative: 'Rewritten.' },
				{ narrativeRunId: s.second.runId },
				{ narrativeThreadId: s.second.threadId },
				{ narratedAt: new Date() },
				{ narrative: null, narratedAt: null }
			];
			for (const change of again) {
				expect(await attempt(db, updateWeekly(weekly.id, change)), JSON.stringify(change)).toEqual(
					weeklyGuard('once')
				);
			}
			// Writing the same values again changes nothing, and keeps updated_at.
			await updateWeekly(weekly.id, { ...written, proposalId })(db);
			const [unchanged] = await db
				.select({ updatedAt: weeklyReviews.updatedAt })
				.from(weeklyReviews)
				.where(eq(weeklyReviews.id, weekly.id));
			expect(unchanged!.updatedAt).toEqual(stored!.updatedAt);

			const cycle = await storeCycle(db, s.cycle());
			await updateCycle(cycle.id, { nextVersionId: s.v2, proposalId })(db);
			expect(await attempt(db, updateCycle(cycle.id, { nextVersionId: s.v1 }))).toEqual(
				cycleGuard('once')
			);
			expect(await attempt(db, updateCycle(cycle.id, { nextVersionId: null }))).toEqual(
				cycleGuard('once')
			);
			expect(await attempt(db, updateCycle(cycle.id, { proposalId: null }))).toEqual(
				cycleGuard('once')
			);
		});
	});
});

describe('superseding', () => {
	it('marks the live row, then inserts the next revision, in one transaction', async () => {
		let owner = '';
		await withCommitted(async (db) => {
			const s = await setup(db);
			owner = s.ownerId;
			const first = await storeWeekly(db, s.weekly());
			const nextId = crypto.randomUUID();
			// The new revision first would be a second live review of the week.
			expect(await attempt(db, insertWeekly(s.weekly({ id: nextId, revision: 2 })))).toEqual(
				refused(UNIQUE, 'weekly_reviews', 'weekly_reviews_owner_week_uq')
			);
			await db.transaction(async (tx) => {
				await updateWeekly(first.id, { supersededAt: new Date(), supersededBy: nextId })(tx);
				await insertWeekly(s.weekly({ id: nextId, revision: 2, inputsDigest: 'fedcba9876543210' }))(
					tx
				);
			});
			const rows = await db
				.select({
					id: weeklyReviews.id,
					revision: weeklyReviews.revision,
					supersededBy: weeklyReviews.supersededBy
				})
				.from(weeklyReviews)
				.where(eq(weeklyReviews.ownerId, s.ownerId))
				.orderBy(weeklyReviews.revision);
			expect(rows).toEqual([
				{ id: first.id, revision: 1, supersededBy: nextId },
				{ id: nextId, revision: 2, supersededBy: null }
			]);

			const block = await storeCycle(db, s.cycle());
			const nextBlockId = crypto.randomUUID();
			await db.transaction(async (tx) => {
				await updateCycle(block.id, { supersededAt: new Date(), supersededBy: nextBlockId })(tx);
				await insertCycle(s.cycle({ id: nextBlockId, revision: 2 }))(tx);
			});
			const [live] = await latestCycleReview(db, s.ownerId);
			expect(live?.id).toBe(nextBlockId);
		});
		expect(owner).not.toBe('');
		const left = await getDb()
			.select({ id: weeklyReviews.id })
			.from(weeklyReviews)
			.where(eq(weeklyReviews.ownerId, owner));
		expect(left).toEqual([]);
	});

	it('keeps one live review per week and block, beside its superseded revisions', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const live = await storeWeekly(db, s.weekly());
			expect(await attempt(db, insertWeekly(s.weekly()))).toEqual(
				refused(UNIQUE, 'weekly_reviews', 'weekly_reviews_owner_week_uq')
			);
			// A superseded revision coexists with the live one, under its own revision number.
			const superseded = { supersededAt: new Date(), supersededBy: live.id };
			expect(await attempt(db, insertWeekly(s.weekly({ revision: 2, ...superseded })))).toBeNull();
			expect(await attempt(db, insertWeekly(s.weekly(superseded)))).toEqual(
				refused(UNIQUE, 'weekly_reviews', 'weekly_reviews_owner_week_revision_uq')
			);
			// Another week is another review.
			expect(await attempt(db, insertWeekly(s.weekly({ weekStartsOn: NEXT_MONDAY })))).toBeNull();

			const block = await storeCycle(db, s.cycle());
			expect(await attempt(db, insertCycle(s.cycle()))).toEqual(
				refused(UNIQUE, 'cycle_reviews', 'cycle_reviews_block_uq')
			);
			const replaced = { supersededAt: new Date(), supersededBy: block.id };
			expect(await attempt(db, insertCycle(s.cycle({ revision: 2, ...replaced })))).toBeNull();
			expect(await attempt(db, insertCycle(s.cycle(replaced)))).toEqual(
				refused(UNIQUE, 'cycle_reviews', 'cycle_reviews_block_revision_uq')
			);
		});
	});

	it('freezes a superseded review, and refuses DELETE on every review', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const old = await storeWeekly(db, s.weekly());
			const next = { id: crypto.randomUUID() };
			await updateWeekly(old.id, { supersededAt: new Date(), supersededBy: next.id })(db);
			await insertWeekly(s.weekly({ id: next.id, revision: 2 }))(db);
			const frozen: Partial<NewWeekly>[] = [
				{ proposalId: await s.proposal() },
				{ narrative: 'Late write-up.', narratedAt: new Date() },
				{ supersededAt: new Date() },
				{ supersededAt: null, supersededBy: null },
				{ updatedAt: new Date() }
			];
			for (const change of frozen) {
				expect(await attempt(db, updateWeekly(old.id, change)), JSON.stringify(change)).toEqual(
					weeklyGuard('frozen')
				);
			}
			const cycle = await storeCycle(db, s.cycle());
			const nextCycle = { id: crypto.randomUUID() };
			await updateCycle(cycle.id, { supersededAt: new Date(), supersededBy: nextCycle.id })(db);
			await insertCycle(s.cycle({ id: nextCycle.id, revision: 2 }))(db);
			expect(await attempt(db, updateCycle(cycle.id, { nextVersionId: s.v2 }))).toEqual(
				cycleGuard('frozen')
			);

			const deleteRefused = (table: string) => refused(GUARD, table, 'history_refuse_delete');
			for (const id of [old.id, next.id]) {
				expect(
					await attempt(db, (tx) => tx.delete(weeklyReviews).where(eq(weeklyReviews.id, id)))
				).toEqual(deleteRefused('weekly_reviews'));
			}
			for (const id of [cycle.id, nextCycle.id]) {
				expect(
					await attempt(db, (tx) => tx.delete(cycleReviews).where(eq(cycleReviews.id, id)))
				).toEqual(deleteRefused('cycle_reviews'));
			}
		});
	});

	it('never supersedes a cycle review whose next block is planned', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const planned = await storeCycle(db, s.cycle());
			const next = await storeCycle(db, s.cycle({ blockLineageId: crypto.randomUUID() }));
			const supersede = { supersededAt: new Date(), supersededBy: next.id };
			// Planning the next block and superseding in one update is refused too.
			expect(
				await attempt(db, updateCycle(planned.id, { nextVersionId: s.v2, ...supersede }))
			).toEqual(cycleGuard('supersede'));
			await updateCycle(planned.id, { nextVersionId: s.v2 })(db);
			expect(await attempt(db, updateCycle(planned.id, supersede))).toEqual(
				cycleGuard('supersede')
			);
			// Without a next version, the same update supersedes it.
			expect(
				await attempt(db, updateCycle(next.id, { ...supersede, supersededBy: planned.id }))
			).toBeNull();
		});
	});
});

describe('foreign keys', () => {
	it('defer superseded_by to the end of the transaction, and hold it then', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const weekly = await storeWeekly(db, s.weekly());
			const cycle = await storeCycle(db, s.cycle());
			// Accepted while the revision it names does not exist yet; refused at the check.
			const accepted: string[] = [];
			expect(
				await attempt(db, async (tx) => {
					await updateWeekly(weekly.id, {
						supersededAt: new Date(),
						supersededBy: crypto.randomUUID()
					})(tx);
					accepted.push('weekly');
					await checkKeysNow(tx);
				})
			).toEqual(
				refused(FOREIGN_KEY, 'weekly_reviews', 'weekly_reviews_superseded_by_weekly_reviews_id_fk')
			);
			expect(
				await attempt(db, async (tx) => {
					await updateCycle(cycle.id, {
						supersededAt: new Date(),
						supersededBy: crypto.randomUUID()
					})(tx);
					accepted.push('cycle');
					await checkKeysNow(tx);
				})
			).toEqual(
				refused(FOREIGN_KEY, 'cycle_reviews', 'cycle_reviews_superseded_by_cycle_reviews_id_fk')
			);
			expect(accepted).toEqual(['weekly', 'cycle']);
		});
	});

	it('hold the program, version, run and thread a review names', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const missing = crypto.randomUUID();
			const fk = (table: string, column: string, target: string) =>
				refused(FOREIGN_KEY, table, `${table}_${column}_${target}_id_fk`);
			const narrated = { narrative: 'Written.', narratedAt: new Date() };
			expect(await attempt(db, insertWeekly(s.weekly({ programId: missing })))).toEqual(
				fk('weekly_reviews', 'program_id', 'programs')
			);
			expect(await attempt(db, insertWeekly(s.weekly({ versionId: missing })))).toEqual(
				fk('weekly_reviews', 'version_id', 'program_versions')
			);
			expect(
				await attempt(db, insertWeekly(s.weekly({ ...narrated, narrativeRunId: missing })))
			).toEqual(fk('weekly_reviews', 'narrative_run_id', 'agent_runs'));
			expect(
				await attempt(db, insertWeekly(s.weekly({ ...narrated, narrativeThreadId: missing })))
			).toEqual(fk('weekly_reviews', 'narrative_thread_id', 'coach_threads'));
			expect(await attempt(db, insertCycle(s.cycle({ versionId: missing })))).toEqual(
				fk('cycle_reviews', 'version_id', 'program_versions')
			);
			expect(
				await attempt(db, insertCycle(s.cycle({ ...narrated, narrativeRunId: missing })))
			).toEqual(fk('cycle_reviews', 'narrative_run_id', 'agent_runs'));
			expect(
				await attempt(db, insertCycle(s.cycle({ ...narrated, narrativeThreadId: missing })))
			).toEqual(fk('cycle_reviews', 'narrative_thread_id', 'coach_threads'));
		});
	});
});

describe('the schema', () => {
	it('keeps the live unique indexes by name, partial on live rows, and row triggers only', async () => {
		const { rows: indexes } = await getDb().execute<{ name: string; def: string }>(
			sql`select indexname as name, indexdef as def from pg_indexes
				where tablename in ('weekly_reviews', 'cycle_reviews') order by 1`
		);
		const def = Object.fromEntries(indexes.map((r) => [r.name, r.def]));
		expect(Object.keys(def)).toEqual([
			'cycle_reviews_block_revision_uq',
			'cycle_reviews_block_uq',
			'cycle_reviews_owner_ends_idx',
			'cycle_reviews_pkey',
			'weekly_reviews_owner_week_revision_uq',
			'weekly_reviews_owner_week_uq',
			'weekly_reviews_pkey'
		]);
		const live = 'WHERE (superseded_at IS NULL)';
		expect(def.weekly_reviews_owner_week_uq).toMatch(/^CREATE UNIQUE INDEX/);
		expect(def.weekly_reviews_owner_week_uq).toContain(`(owner_id, week_starts_on) ${live}`);
		expect(def.cycle_reviews_block_uq).toContain(`(program_id, block_lineage_id) ${live}`);
		expect(def.cycle_reviews_owner_ends_idx).toContain(`(owner_id, block_ends_on DESC) ${live}`);
		expect(def.weekly_reviews_owner_week_revision_uq).toContain(
			'(owner_id, week_starts_on, revision)'
		);
		expect(def.cycle_reviews_block_revision_uq).toContain(
			'(program_id, block_lineage_id, revision)'
		);

		const { rows: keys } = await getDb().execute<{
			name: string;
			deferrable: boolean;
			deferred: boolean;
		}>(
			sql`select conname as name, condeferrable as deferrable, condeferred as deferred
				from pg_constraint where conname like '%_superseded_by_%' order by 1`
		);
		expect(keys).toEqual([
			{ name: 'cycle_reviews_superseded_by_cycle_reviews_id_fk', deferrable: true, deferred: true },
			{
				name: 'weekly_reviews_superseded_by_weekly_reviews_id_fk',
				deferrable: true,
				deferred: true
			}
		]);

		// TRUNCATE (tgtype bit 32) fires none of them: it stays the test and reset bypass.
		const { rows: triggers } = await getDb().execute<{ tgname: string; truncate: boolean }>(
			sql`select tgname, (tgtype & 32) <> 0 as truncate from pg_trigger where not tgisinternal
				and tgrelid in ('weekly_reviews'::regclass, 'cycle_reviews'::regclass) order by 1`
		);
		expect(triggers).toEqual(
			[
				'cycle_reviews_content_guard',
				'cycle_reviews_frozen_guard',
				'cycle_reviews_once_guard',
				'cycle_reviews_refuse_delete',
				'cycle_reviews_supersede_guard',
				'cycle_reviews_touch',
				'weekly_reviews_content_guard',
				'weekly_reviews_frozen_guard',
				'weekly_reviews_once_guard',
				'weekly_reviews_refuse_delete',
				'weekly_reviews_touch'
			].map((tgname) => ({ tgname, truncate: false }))
		);
	});

	it("gives M5's coach memory the live revision only", async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const old = await storeWeekly(db, s.weekly({ summary: 'Before the late session' }));
			const nextId = crypto.randomUUID();
			await updateWeekly(old.id, { supersededAt: new Date(), supersededBy: nextId })(db);
			await insertWeekly(s.weekly({ id: nextId, revision: 2, summary: 'Every session done' }))(db);
			expect(await latestWeeklyReviews(db, s.ownerId, 5)).toEqual([
				expect.objectContaining({ id: nextId, date: MONDAY, summary: 'Every session done' })
			]);

			// The superseded cycle review is the newer row, so only the filter keeps it out.
			const nextCycle = await storeCycle(db, s.cycle({ summary: 'Live' }));
			const oldCycle = await storeCycle(
				db,
				s.cycle({
					revision: 2,
					summary: 'Superseded',
					supersededAt: new Date(),
					supersededBy: nextCycle.id,
					createdAt: new Date(Date.now() + 60_000)
				})
			);
			expect(oldCycle.supersededBy).toBe(nextCycle.id);
			const [latest] = await latestCycleReview(db, s.ownerId);
			expect(latest?.id).toBe(nextCycle.id);
		});
	});

	it('is emptied by resetPrograms, whose TRUNCATE lists both tables', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const old = await storeWeekly(db, s.weekly());
			const nextId = crypto.randomUUID();
			await updateWeekly(old.id, { supersededAt: new Date(), supersededBy: nextId })(db);
			await insertWeekly(s.weekly({ id: nextId, revision: 2 }))(db);
			await storeCycle(db, s.cycle());
			const count = async () => {
				const { rows } = await db.execute<{ n: number }>(
					sql`select (select count(*) from weekly_reviews) + (select count(*) from cycle_reviews) as n`
				);
				return Number(rows[0]!.n);
			};
			expect(await count()).toBeGreaterThanOrEqual(3);
			// A fresh transaction has no pending deferred check; this one runs them first.
			await checkKeysNow(db);
			// e2e/program-support.ts RESET_ROOTS lists weekly_reviews and cycle_reviews.
			await db.execute(sql`truncate weekly_reviews, cycle_reviews cascade`);
			expect(await count()).toBe(0);
			expect(
				await db
					.select({ id: weeklyReviews.id })
					.from(weeklyReviews)
					.where(eq(weeklyReviews.ownerId, s.ownerId))
			).toEqual([]);
		});
	});
});
