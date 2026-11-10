/**
 * The reviews store on real Postgres (services/reviews/store.ts, the M6 plan's reviews-store):
 * storing is idempotent for a live week or block, a refresh supersedes and keeps both rows, the
 * write-up and the proposal are each set once, the history merges both kinds without gaps, every
 * read is owner-scoped, legacy snapshots read as legacy, the decision is read from the head of
 * the proposal's revision chain, and the write-up's display rows come from the run that wrote it.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	agentRuns,
	coachMessages,
	coachProposals,
	coachThreads,
	cycleReviews,
	programBlocks,
	programs,
	programVersions,
	weeklyReviews,
	type Executor
} from '../../../src/lib/server/db';
import type { CycleReviewSnapshot } from '../../../src/lib/domain/programming/review/cycle-snapshot';
import type { WeeklyReviewSnapshot } from '../../../src/lib/domain/programming/review/snapshot';
import { loadMemoryRecords } from '../../../src/lib/server/services/coach/memory-records';
import {
	decisionState,
	getCycleReview,
	getLiveWeeklyReview,
	getWeeklyReview,
	linkProposal,
	listReviews,
	narrativeBlocks,
	proposalHead,
	ReviewNotFoundError,
	ReviewSetOnceError,
	ReviewSupersededError,
	setNarrative,
	setNextVersion,
	stale,
	storeCycleReview,
	storeWeeklyReview,
	supersedeWeeklyReview,
	type ReviewListItem,
	type ReviewsKeyset
} from '../../../src/lib/server/services/reviews/store';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const DIGEST = '0123456789abcdef';
const LATER_DIGEST = 'fedcba9876543210';
const at = new Date('2026-11-16T09:00:00Z');
const now = () => at;

const brief = (kind: 'weekly' | 'cycle', from: string, to: string) => ({
	kind,
	from,
	to,
	summary: '4 of 4 sessions done',
	findings: []
});

const weeklySnapshot = (weekStartsOn: string, next: string): WeeklyReviewSnapshot => ({
	version: 1,
	weekStartsOn,
	computedOn: '2026-11-16',
	timeZone: 'America/Los_Angeles',
	analyticsVersion: 1,
	inputsDigest: DIGEST,
	adherence: { planned: 4, completed: 4, skipped: 0, missed: 0, pct: 100 },
	fatigue: { level: 'none', reasons: [] },
	next: { weekStartsOn: next, state: 'planned', kind: null },
	noProposal: null,
	brief: brief('weekly', weekStartsOn, addDays(weekStartsOn, 6))
});

const cycleSnapshot = (from: string, weeks: number): CycleReviewSnapshot => {
	const to = addDays(from, 7 * weeks - 1);
	return {
		version: 1,
		block: { lineage: 'block', name: 'Baseline', phase: 'baseline', from, to, weeks },
		computedOn: '2026-11-16',
		timeZone: 'America/Los_Angeles',
		analyticsVersion: 1,
		inputsDigest: DIGEST,
		adherence: {
			planned: 12,
			completed: 11,
			skipped: 1,
			missed: 0,
			pct: 92,
			verdictsWithheld: false,
			weeks: [],
			oftenMissed: []
		},
		goals: [],
		effectiveness: [],
		volume: [],
		fatigue: { level: 'none', reasons: [], deloadPlanned: false },
		deloadNeed: { verdict: 'not_needed', reasons: [] },
		previous: null,
		next: null,
		brief: brief('cycle', from, to)
	};
};

function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/** The owner (the app has exactly one) with a two-version program and a block. */
async function setup(db: Executor, owner?: string) {
	const ownerId = owner ?? (await makeOwner(db));
	// A second program of the owner's is an archived one: one program is active at a time.
	const archived = owner ? { status: 'archived' as const, archivedAt: at } : {};
	const [program] = await db
		.insert(programs)
		.values({ ownerId, title: 'Fight camp', ...archived })
		.returning();
	const programId = program!.id;
	const version = async (number: number, parentVersionId: string | null) => {
		const [row] = await db
			.insert(programVersions)
			.values({
				programId,
				number,
				parentVersionId,
				createdBy: number === 1 ? 'rules' : 'owner',
				summary: `Version ${number}`,
				startsOn: '2026-10-19',
				firstPlannedDay: '2026-10-19'
			})
			.returning();
		return row!.id;
	};
	const v1 = await version(1, null);
	const v2 = await version(2, v1);
	const block = async (position: number, startsOn: string, endsOn: string) => {
		const [row] = await db
			.insert(programBlocks)
			.values({ programId, position, phase: 'baseline', name: 'Baseline', startsOn, endsOn })
			.returning();
		return row!.lineageId;
	};
	const weekly = (weekStartsOn: string) => ({
		weekStartsOn,
		snapshot: weeklySnapshot(weekStartsOn, addDays(weekStartsOn, 7)) as never,
		summary: `Week of ${weekStartsOn}`,
		snapshotVersion: 1,
		analyticsVersion: 1,
		inputsDigest: DIGEST,
		programId,
		versionId: v1
	});
	const cycle = async (from: string, weeks: number) => {
		const to = addDays(from, 7 * weeks - 1);
		return {
			programId,
			blockLineageId: await block(weeks * 100 + Number(from.slice(8)), from, to),
			snapshot: cycleSnapshot(from, weeks) as never,
			summary: `Block to ${to}`,
			snapshotVersion: 1,
			analyticsVersion: 1,
			inputsDigest: DIGEST,
			versionId: v1,
			blockStartsOn: from,
			blockEndsOn: to
		};
	};
	return { ownerId, programId, v1, v2, weekly, cycle };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** A proposal of the owner's, optionally revising another. */
async function propose(db: Executor, s: Setup, revisionOf: string | null = null) {
	const [row] = await db
		.insert(coachProposals)
		.values({
			ownerId: s.ownerId,
			kind: 'program_adjustment',
			title: 'Lighter squats next week',
			summary: 'Squats drop 5 kg next week.',
			rationale: 'Two sessions ended above RPE 9.',
			payload: { revisionOf },
			programId: s.programId,
			baseVersionId: s.v1,
			revisionOf
		})
		.returning();
	return row!.id;
}

const decide = (db: Executor, id: string, set: Partial<typeof coachProposals.$inferInsert>) =>
	db
		.update(coachProposals)
		.set({ closedAt: at, updatedAt: at, ...set })
		.where(eq(coachProposals.id, id));

/** A narration thread with one owner message and a run started from it. */
async function narration(db: Executor, ownerId: string) {
	const [thread] = await db
		.insert(coachThreads)
		.values({
			ownerId,
			title: 'Week of 9 Nov',
			titleSource: 'first_message',
			entry: { from: 'weekly_review', ref: null },
			segmentPromptVersion: 'prompt-1'
		})
		.returning();
	const threadId = thread!.id;
	let seq = 0;
	const message = async (values: Partial<typeof coachMessages.$inferInsert>) => {
		seq += 1;
		const [row] = await db
			.insert(coachMessages)
			.values({
				ownerId,
				threadId,
				seq,
				segment: 1,
				role: 'user',
				kind: 'owner_message',
				apiVisible: true,
				content: 'Write up my week',
				...values
			})
			.returning();
		return row!;
	};
	const run = async () => {
		const trigger = await message({ clientMessageId: crypto.randomUUID() });
		const [row] = await db
			.insert(agentRuns)
			.values({
				ownerId,
				threadId,
				triggerMessageId: trigger.id,
				kind: 'turn',
				provider: 'mock',
				model: 'mock',
				effort: 'medium',
				promptVersion: 'prompt-1',
				status: 'completed',
				finishedAt: at
			})
			.returning();
		return row!.id;
	};
	const answer = (runId: string, text: string) =>
		message({
			role: 'assistant',
			kind: 'assistant',
			content: [{ type: 'text', text }],
			display: { text },
			runId
		});
	return { threadId, run, answer };
}

describe('storing', () => {
	it('is idempotent for a live week, and a refresh supersedes keeping both rows', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const first = await storeWeeklyReview(s.ownerId, s.weekly('2026-11-09'), { db });
			const again = await storeWeeklyReview(
				s.ownerId,
				{ ...s.weekly('2026-11-09'), summary: 'Another' },
				{ db }
			);
			expect(first.created).toBe(true);
			expect(again).toMatchObject({ created: false, review: { id: first.review.id } });
			expect(again.review.summary).toBe('Week of 2026-11-09');

			const refreshed = await supersedeWeeklyReview(
				s.ownerId,
				first.review.id,
				{ ...s.weekly('2026-11-09'), summary: 'Refreshed', inputsDigest: LATER_DIGEST },
				{ db, now }
			);
			expect(refreshed).toMatchObject({ revision: 2, summary: 'Refreshed', supersededAt: null });
			const old = await getWeeklyReview(s.ownerId, first.review.id, { db });
			expect(old).toMatchObject({ revision: 1, supersededBy: refreshed.id, supersededAt: at });
			const live = await getLiveWeeklyReview(s.ownerId, '2026-11-09', { db });
			expect(live?.id).toBe(refreshed.id);
			const rows = await db
				.select({ id: weeklyReviews.id })
				.from(weeklyReviews)
				.where(eq(weeklyReviews.ownerId, s.ownerId));
			expect(rows).toHaveLength(2);
			// The superseded row is frozen: refreshing it again is refused, nothing written.
			await expect(
				supersedeWeeklyReview(s.ownerId, first.review.id, s.weekly('2026-11-09'), { db })
			).rejects.toBeInstanceOf(ReviewSupersededError);
			// Storing the week again returns the live revision, never a third row.
			const third = await storeWeeklyReview(s.ownerId, s.weekly('2026-11-09'), { db });
			expect(third).toMatchObject({ created: false, review: { id: refreshed.id, revision: 2 } });
		});
	});

	it('is idempotent for a live block', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const values = await s.cycle('2026-10-19', 4);
			const first = await storeCycleReview(s.ownerId, values, { db });
			const again = await storeCycleReview(s.ownerId, values, { db });
			expect(first.created).toBe(true);
			expect(again).toMatchObject({ created: false, review: { id: first.review.id } });
			expect(first.review.read).toMatchObject({ legacy: false, snapshot: { block: { weeks: 4 } } });
		});
	});

	it('sets a write-up, a proposal and a next version once; a second attempt is a typed error', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const { review } = await storeWeeklyReview(s.ownerId, s.weekly('2026-11-09'), { db });
			const n = await narration(db, s.ownerId);
			const runId = await n.run();
			const write = { narrative: 'A solid week.', runId, threadId: n.threadId };
			await setNarrative(s.ownerId, 'weekly', review.id, write, { db, now });
			const second = setNarrative(
				s.ownerId,
				'weekly',
				review.id,
				{ ...write, narrative: 'Again' },
				{ db }
			);
			await expect(second).rejects.toMatchObject({
				name: 'ReviewSetOnceError',
				field: 'narrative'
			});
			expect(await getWeeklyReview(s.ownerId, review.id, { db })).toMatchObject({
				narrative: 'A solid week.',
				narrativeRunId: runId,
				narratedAt: at
			});

			const p1 = await propose(db, s);
			const p2 = await propose(db, s);
			await linkProposal(s.ownerId, 'weekly', review.id, p1, { db });
			await expect(linkProposal(s.ownerId, 'weekly', review.id, p2, { db })).rejects.toMatchObject({
				name: 'ReviewSetOnceError',
				field: 'proposal'
			});
			expect((await getWeeklyReview(s.ownerId, review.id, { db })).proposalId).toBe(p1);

			const cycle = await storeCycleReview(s.ownerId, await s.cycle('2026-10-19', 4), { db });
			const other = await setup(db, s.ownerId);
			// A version of another program is not one of the reviewed program's.
			await expect(
				setNextVersion(s.ownerId, cycle.review.id, other.v2, { db })
			).rejects.toMatchObject({ name: 'ReviewNotFoundError', what: 'program version' });
			await setNextVersion(s.ownerId, cycle.review.id, s.v2, { db });
			await expect(setNextVersion(s.ownerId, cycle.review.id, s.v2, { db })).rejects.toBeInstanceOf(
				ReviewSetOnceError
			);
			expect((await getCycleReview(s.ownerId, cycle.review.id, { db })).nextVersionId).toBe(s.v2);
		});
	});
});

describe('the history', () => {
	it('merges both kinds newest first, page after page, with no gaps or repeats', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const weeks = ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09'];
			for (const week of weeks) await storeWeeklyReview(s.ownerId, s.weekly(week), { db });
			// Blocks ending 1 Nov and 15 Nov: on the same Sundays as two of the weeks.
			const blockA = await storeCycleReview(s.ownerId, await s.cycle('2026-10-19', 2), { db });
			const blockB = await storeCycleReview(s.ownerId, await s.cycle('2026-11-02', 2), { db });
			// A cycle review written before M6, with no block dates: last.
			const [legacy] = await db
				.insert(cycleReviews)
				.values({
					ownerId: s.ownerId,
					programId: s.programId,
					blockLineageId: crypto.randomUUID(),
					snapshot: { anything: true },
					summary: 'An old block'
				})
				.returning();
			// A superseded weekly revision never shows; its live revision does.
			const old = await getLiveWeeklyReview(s.ownerId, '2026-10-26', { db });
			const live = await supersedeWeeklyReview(s.ownerId, old!.id, s.weekly('2026-10-26'), { db });
			// Anyone else reads none of them (the app has one owner: a stranger's id).
			const stranger = await listReviews(crypto.randomUUID(), {}, { db });
			expect(stranger).toEqual({ items: [], next: null });

			const seen: ReviewListItem[] = [];
			let before: ReviewsKeyset | undefined;
			for (let page = 0; page < 10; page += 1) {
				const result = await listReviews(s.ownerId, { before, limit: 2 }, { db });
				seen.push(...result.items);
				if (result.next === null) break;
				before = result.next;
			}
			expect(seen.map((i) => [i.kind, i.endsOn, i.id])).toEqual([
				['cycle', '2026-11-15', blockB.review.id],
				['weekly', '2026-11-15', expect.any(String)],
				['weekly', '2026-11-08', expect.any(String)],
				['cycle', '2026-11-01', blockA.review.id],
				['weekly', '2026-11-01', live.id],
				['weekly', '2026-10-25', expect.any(String)],
				['cycle', null, legacy!.id]
			]);
			expect(seen.find((i) => i.id === live.id)).toMatchObject({ revision: 2, legacy: false });
			expect(seen.at(-1)).toMatchObject({ legacy: true, summary: 'An old block' });
			// One page with everything gives the same order.
			const all = await listReviews(s.ownerId, { limit: 50 }, { db });
			expect(all.next).toBeNull();
			expect(all.items).toEqual(seen);
		});
	});
});

describe('owner scope and legacy rows', () => {
	it('reads another owner’s or a malformed id as not found, and a version 0 row as legacy', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			// The app has one owner: anyone else is a stranger's id.
			const other = { ownerId: crypto.randomUUID() };
			const { review } = await storeWeeklyReview(s.ownerId, s.weekly('2026-11-09'), { db });
			await expect(getWeeklyReview(other.ownerId, review.id, { db })).rejects.toBeInstanceOf(
				ReviewNotFoundError
			);
			await expect(getWeeklyReview(s.ownerId, 'not-a-uuid', { db })).rejects.toBeInstanceOf(
				ReviewNotFoundError
			);
			await expect(
				setNarrative(
					other.ownerId,
					'weekly',
					review.id,
					{
						narrative: 'x',
						runId: crypto.randomUUID(),
						threadId: crypto.randomUUID()
					},
					{ db }
				)
			).rejects.toBeInstanceOf(ReviewNotFoundError);
			const p = await propose(db, s);
			const notTheirs = { name: 'ReviewNotFoundError', what: 'proposal' };
			await expect(
				linkProposal(other.ownerId, 'weekly', review.id, p, { db })
			).rejects.toMatchObject(notTheirs);
			const missing = linkProposal(s.ownerId, 'weekly', review.id, crypto.randomUUID(), { db });
			await expect(missing).rejects.toMatchObject(notTheirs);
			await expect(
				supersedeWeeklyReview(other.ownerId, review.id, s.weekly('2026-11-09'), { db })
			).rejects.toBeInstanceOf(ReviewNotFoundError);
			expect(await getLiveWeeklyReview(other.ownerId, '2026-11-09', { db })).toBeNull();

			const [m3] = await db
				.insert(weeklyReviews)
				.values({
					ownerId: s.ownerId,
					weekStartsOn: '2026-10-26',
					snapshot: { planned: 5 },
					summary: 'A good week'
				})
				.returning();
			const read = await getWeeklyReview(s.ownerId, m3!.id, { db });
			expect(read.read).toEqual({ legacy: true, version: 0, summary: 'A good week' });
			expect(review.read).toMatchObject({ legacy: false, version: 1 });
			expect(stale(read, LATER_DIGEST)).toBe(false);
			expect(stale(review, DIGEST)).toBe(false);
			expect(stale(review, LATER_DIGEST)).toBe(true);
		});
	});
});

describe('the decision, from the revision chain’s head', () => {
	it('reads an owner revision of a superseded rules proposal that was then applied as applied', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const { review } = await storeWeeklyReview(s.ownerId, s.weekly('2026-11-09'), { db });
			expect(await decisionState(s.ownerId, review, { db })).toEqual({ state: 'none' });
			const rules = await propose(db, s);
			await linkProposal(s.ownerId, 'weekly', review.id, rules, { db });
			const linked = await getWeeklyReview(s.ownerId, review.id, { db });
			expect(await decisionState(s.ownerId, linked, { db })).toEqual({
				state: 'undecided',
				proposalId: rules
			});

			const revision = await propose(db, s, rules);
			await decide(db, rules, { status: 'superseded', supersededReason: 'revised' });
			expect(await decisionState(s.ownerId, linked, { db })).toEqual({
				state: 'undecided',
				proposalId: revision
			});
			await decide(db, revision, { status: 'applied', appliedVersionId: s.v2 });
			expect(await decisionState(s.ownerId, linked, { db })).toEqual({
				state: 'applied',
				proposalId: revision,
				versionId: s.v2,
				versionNumber: 2
			});
			expect(await proposalHead(s.ownerId, linked, { db })).toMatchObject({
				id: revision,
				depth: 1
			});
			// Another owner never reads the chain.
			expect(await proposalHead(crypto.randomUUID(), linked, { db })).toBeNull();
		});
	});

	it('reads a rejected revision as rejected, and a head superseded otherwise with its reason', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const { review } = await storeWeeklyReview(s.ownerId, s.weekly('2026-11-09'), { db });
			const rules = await propose(db, s);
			await linkProposal(s.ownerId, 'weekly', review.id, rules, { db });
			const linked = await getWeeklyReview(s.ownerId, review.id, { db });
			const first = await propose(db, s, rules);
			await decide(db, rules, { status: 'superseded', supersededReason: 'revised' });
			const second = await propose(db, s, first);
			await decide(db, first, { status: 'superseded', supersededReason: 'revised' });
			await decide(db, second, { status: 'rejected' });
			expect(await decisionState(s.ownerId, linked, { db })).toEqual({
				state: 'rejected',
				proposalId: second
			});

			const { review: next } = await storeWeeklyReview(s.ownerId, s.weekly('2026-11-16'), { db });
			const changed = await propose(db, s);
			await linkProposal(s.ownerId, 'weekly', next.id, changed, { db });
			await decide(db, changed, { status: 'superseded', supersededReason: 'program_changed' });
			expect(
				await decisionState(s.ownerId, await getWeeklyReview(s.ownerId, next.id, { db }), { db })
			).toEqual({ state: 'superseded', proposalId: changed, reason: 'program_changed' });
		});
	});
});

describe('the write-up’s display blocks', () => {
	it('are the stored display rows of the review’s run, never another run’s or owner’s', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const { review } = await storeWeeklyReview(s.ownerId, s.weekly('2026-11-09'), { db });
			expect(await narrativeBlocks(s.ownerId, review, { db })).toEqual([]);
			const n = await narration(db, s.ownerId);
			const runA = await n.run();
			await n.answer(runA, 'You did all four sessions.');
			await n.answer(runA, 'Squats moved well.');
			const runB = await n.run();
			await n.answer(runB, 'A later answer.');
			await setNarrative(
				s.ownerId,
				'weekly',
				review.id,
				{ narrative: 'You did all four sessions.', runId: runA, threadId: n.threadId },
				{ db, now }
			);
			const narrated = await getWeeklyReview(s.ownerId, review.id, { db });
			const blocks = await narrativeBlocks(s.ownerId, narrated, { db });
			expect(blocks.map((b) => b.display)).toEqual([
				{ text: 'You did all four sessions.' },
				{ text: 'Squats moved well.' }
			]);
			expect(blocks.every((b) => b.kind === 'assistant' && b.status === 'complete')).toBe(true);
			expect(await narrativeBlocks(crypto.randomUUID(), narrated, { db })).toEqual([]);
		});
	});
});

describe('M5’s coaching memory', () => {
	it('reads only the live revision of a refreshed review', async () => {
		await withRollback(async (db) => {
			const s = await setup(db);
			const { review } = await storeWeeklyReview(s.ownerId, s.weekly('2026-11-09'), { db });
			await supersedeWeeklyReview(
				s.ownerId,
				review.id,
				{ ...s.weekly('2026-11-09'), summary: 'Refreshed week' },
				{ db, now }
			);
			const records = await loadMemoryRecords(s.ownerId, '2026-11-16', db);
			expect(records.reviews.map((r) => r.summary)).toEqual(['Refreshed week']);
		});
	});
});
