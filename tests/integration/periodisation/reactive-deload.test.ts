/**
 * The reactive deload on real Postgres (m7-plan reactive-deload): a weekly review that finds high
 * fatigue deloads the week after it in place, through M5's lifecycle, and M6's review machinery
 * handles it (services/reviews/weekly.ts, services/reviews/next-week.ts,
 * services/periodisation/deload.ts, agent/reviews/narrate.ts):
 * - the review proposes a deload (origin weekly_review, no ops) whose reasons name the signals
 *   (S7); accepted through decideNextWeek, the week is a deload with no sparring and RPE ≤ 6, the
 *   block after it the same rows; Train's weekChanges names the review; the decision is applied
 * - the Monday review deloads all of the week, a Thursday review Thursday to Sunday only, and a
 *   review after next week ended deloads the week holding today
 * - Keep rejects with the note and makes no version; items for a deload are refused; refresh
 *   re-assesses (a new deload head, the old one review_refreshed; no longer needed → M6's
 *   changes); accepting after the week ended reads late; the narration's context names the replan
 * - idempotent creation, a pool of one connection, the context's reader stalled (M6's path, no
 *   overlap), a foreign owner, and a planned deload next week keeping M6's path
 * The review fixtures (M6) give the week; a check-in on its Sunday (5 hours of sleep, soreness 4
 * of 5) makes its fatigue high. Times are in Los Angeles; this week starts Monday 16 Nov 2026.
 */
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, type IsoDate } from '../../../src/lib/domain/calendar';
import type { WeeklyReviewSnapshot } from '../../../src/lib/domain/programming/review/snapshot';
import type { ReplanPayload } from '../../../src/lib/domain/training/replan';
import { MockProvider } from '../../../src/lib/server/agent/provider/mock';
import type { ModelRequest } from '../../../src/lib/server/agent/provider/types';
import { narrateReview } from '../../../src/lib/server/agent/reviews/narrate';
import { createDatabase, createPool, getDb, type Executor } from '../../../src/lib/server/db';
import { resetEnvCache } from '../../../src/lib/server/env';
import { getProposalView } from '../../../src/lib/server/services/coach/proposals';
import type { ContextReader } from '../../../src/lib/server/services/periodisation/context';
import {
	getProgramVersion,
	type ProgramVersion,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import { weekChanges } from '../../../src/lib/server/services/programs/week-changes';
import {
	createWeeklyReview,
	decideNextWeek,
	getWeeklyReview,
	getWeeklyReviewView,
	refreshWeeklyReview,
	ReviewInputError,
	ReviewNotFoundError,
	WHOLE_ONLY,
	type StoredWeeklyReview,
	type WeeklyReviewDeps
} from '../../../src/lib/server/services/reviews';
import { recordRecoveryNote } from '../../../src/lib/server/services/training/log';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import type { ReviewFixtureResult } from '../../../src/lib/server/test-support/analytics-fixtures/reviews';
import { takeOverlaps } from '../one-query-per-client';
import { withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const MONDAY = '2026-11-16';
const TUESDAY = '2026-11-17';
const THURSDAY = '2026-11-19';
const NEXT_TUESDAY = '2026-11-24';
/** Real reads on a loaded CI runner: far above the context's 300 ms default. */
const SLOW_OK = 10_000;

const clock = (day: IsoDate) => () => atLocal(day, '12:00', TZ);

const before = process.env.ENABLE_TEST_ROUTES;
beforeAll(() => {
	process.env.ENABLE_TEST_ROUTES = 'true';
	resetEnvCache();
});
afterEach(() => {
	vi.restoreAllMocks();
});
afterAll(() => {
	if (before === undefined) delete process.env.ENABLE_TEST_ROUTES;
	else process.env.ENABLE_TEST_ROUTES = before;
	resetEnvCache();
});

type Fixture = 'week-complete' | 'week-late' | 'next-week-deload';

/** A review fixture seeded on `today`, its reviewed week's Sunday a tired one unless `rested`. */
async function seeded(db: Executor, name: Fixture, today: IsoDate, rested = false) {
	const owner = await makeOwner(db);
	const now = clock(today);
	const fixture = (await seedAnalyticsFixture(
		owner,
		name,
		{ timeZone: TZ, now: now() },
		{ db }
	)) as unknown as ReviewFixtureResult;
	if (fixture.review.kind !== 'weekly') throw new Error('a weekly fixture');
	const reviewed = fixture.review.weekStartsOn;
	if (!rested) await checkIn(db, owner, addDays(reviewed, 6), { sleepHours: 5, soreness: 4 });
	const deps: WeeklyReviewDeps & { db: Executor; now: () => Date } = {
		db,
		now,
		context: { statementTimeoutMs: SLOW_OK }
	};
	return { owner, programId: fixture.programId!, reviewed, deps };
}

async function checkIn(
	db: Executor,
	owner: string,
	notedOn: IsoDate,
	values: { sleepHours: number; soreness: number }
) {
	const note = { notedOn, ...values, energy: 2, stress: null, note: null };
	await recordRecoveryNote(owner, { clientMutationId: crypto.randomUUID(), ...note }, { db });
}

const review = async (
	owner: string,
	weekStartsOn: IsoDate,
	today: IsoDate,
	deps: WeeklyReviewDeps
) => (await createWeeklyReview(owner, { weekStartsOn, today }, deps)).review;

const snapshotOf = (r: StoredWeeklyReview): WeeklyReviewSnapshot => {
	if (r.read.legacy) throw new Error('a v1 snapshot');
	return r.read.snapshot;
};

async function proposalRow(db: Executor, id: string) {
	const { rows } = await db.execute<{
		kind: string;
		status: string;
		superseded_reason: string | null;
		decision_note: string | null;
		payload: Record<string, unknown>;
		evidence: Record<string, unknown> | null;
	}>(
		sql`select kind, status, superseded_reason, decision_note, payload, evidence
			from coach_proposals where id = ${id}`
	);
	return rows[0]!;
}

async function versionCount(db: Executor, programId: string) {
	const { rows } = await db.execute<{ n: number }>(
		sql`select count(*)::int as n from program_versions where program_id = ${programId}`
	);
	return rows[0]!.n;
}

const weekOf = (v: ProgramVersion, monday: IsoDate) =>
	v.blocks.flatMap((b) => b.weeks).find((w) => w.startsOn === monday)!;
/** A session's values, its row ids left out. */
const values = (s: StoredSession) =>
	JSON.parse(
		JSON.stringify(s, (key, value) => (key === 'id' ? undefined : (value as unknown)))
	) as unknown;
const sparring = (s: StoredSession) => s.kind === 'other' && s.details.kind === 'sparring';

describe('a weekly review that finds high fatigue', () => {
	it('proposes a deload of next week, from the review, with no ops and the signals as its reasons (S7)', async () => {
		await withRollback(async (db) => {
			const { owner, reviewed, deps } = await seeded(db, 'week-complete', MONDAY);
			const made = await review(owner, reviewed, MONDAY, deps);

			const snapshot = snapshotOf(made);
			expect(snapshot.fatigue.level).toBe('high');
			expect(snapshot.noProposal).toBeNull();
			expect(snapshot.deload?.week).toBe(MONDAY);
			expect(snapshot.deload?.reasons).toEqual(
				expect.arrayContaining([
					expect.stringMatching(/sore \(4 of 5\)/),
					expect.stringMatching(/slept 5 hours/)
				])
			);
			// No M6 change is proposed beside it: any it found waits for the deload, with why.
			expect(snapshot.brief.findings.some((f) => f.id === 'next:no_proposal')).toBe(false);
			const waiting = snapshot.brief.findings.filter((f) =>
				f.verdict.words.includes('deload instead')
			);
			expect(waiting.every((f) => f.id.startsWith('next:not_proposed:'))).toBe(true);

			const row = await proposalRow(db, made.proposalId!);
			expect(row).toMatchObject({ kind: 'replan', status: 'proposed' });
			const payload = row.payload as unknown as ReplanPayload;
			expect(payload).not.toHaveProperty('ops');
			expect(payload.directive).toEqual({
				kind: 'deload',
				week: MONDAY,
				trigger: 'reactive',
				reasons: snapshot.deload!.reasons
			});
			expect(row.evidence?.source).toMatchObject({
				kind: 'weekly_review',
				reviewId: made.id,
				revision: 1,
				weekStartsOn: reviewed
			});
			const view = await getProposalView(owner, made.proposalId!, { db });
			expect(view.origin).toMatchObject({ kind: 'weekly_review', reviewId: made.id });
			expect((await getWeeklyReviewView(owner, reviewed, deps)).decision).toEqual({
				state: 'undecided',
				proposalId: made.proposalId
			});
		});
	});

	it('accepted through decideNextWeek, deloads the whole week on Monday; the next block is the same rows; Train names the review', async () => {
		await withRollback(async (db) => {
			const { owner, programId, reviewed, deps } = await seeded(db, 'week-complete', MONDAY);
			const made = await review(owner, reviewed, MONDAY, deps);
			const v1 = await getProgramVersion(owner, programId, 1, { db });

			const decided = await decideNextWeek(owner, made.id, { items: [], accept: true }, deps);
			expect(decided).toEqual({
				outcome: 'applied',
				proposalId: made.proposalId,
				versionId: expect.any(String),
				versionNumber: 2,
				passed: 0
			});
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			const week = weekOf(v2, MONDAY);
			expect(week.kind).toBe('deload');
			expect(week.sessions.length).toBe(weekOf(v1, MONDAY).sessions.length);
			expect(week.sessions.some(sparring)).toBe(false);
			expect(week.sessions.every((s) => s.targetRpe <= 6)).toBe(true);
			// Every session of the week was still ahead on Monday, so every one changed.
			const was = new Map(weekOf(v1, MONDAY).sessions.map((s) => [s.lineage, values(s)]));
			expect(week.sessions.filter((s) => was.get(s.lineage) === undefined)).toEqual([]);
			expect(
				week.sessions.every((s) => JSON.stringify(values(s)) !== JSON.stringify(was.get(s.lineage)))
			).toBe(true);
			// The block after it resumes as planned: the same rows, weeks and all.
			expect(v2.blocks.at(-1)).toEqual(v1.blocks.at(-1));
			expect(v2.blocks.at(-1)!.weeks[0]).toMatchObject({
				startsOn: addDays(MONDAY, 7),
				kind: 'accumulation'
			});

			const changes = await weekChanges(
				owner,
				{ programId, version: 2, weekLineage: week.lineage },
				{ db }
			);
			expect(changes).toMatchObject({
				version: { number: 2, createdBy: 'rules' },
				applied: expect.stringContaining('weekly review of'),
				review: { weekStartsOn: reviewed }
			});
			expect((await getWeeklyReviewView(owner, reviewed, deps)).decision).toMatchObject({
				state: 'applied',
				proposalId: made.proposalId,
				versionNumber: 2
			});
			// A retry returns the decision as it is.
			expect(await decideNextWeek(owner, made.id, { items: [], accept: true }, deps)).toEqual(
				decided
			);
			expect(await versionCount(db, programId)).toBe(2);
		});
	});

	it('made on Thursday, deloads Thursday to Sunday only', async () => {
		await withRollback(async (db) => {
			const { owner, programId, reviewed, deps } = await seeded(db, 'week-complete', THURSDAY);
			const made = await review(owner, reviewed, THURSDAY, deps);
			expect(snapshotOf(made).deload?.week).toBe(MONDAY);
			const v1 = await getProgramVersion(owner, programId, 1, { db });

			const decided = await decideNextWeek(owner, made.id, { items: [], accept: true }, deps);
			expect(decided).toMatchObject({ outcome: 'applied', versionNumber: 2 });
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			const early = (s: StoredSession) => s.date < THURSDAY;
			const [was, now] = [weekOf(v1, MONDAY).sessions, weekOf(v2, MONDAY).sessions];
			expect(now.filter(early).map(values)).toEqual(was.filter(early).map(values));
			const late = now.filter((s) => !early(s));
			expect(late.length).toBeGreaterThan(0);
			expect(late.every((s) => s.targetRpe <= 6 && !sparring(s))).toBe(true);
			expect(late.map(values)).not.toEqual(was.filter((s) => !early(s)).map(values));
		});
	});

	it('made after next week ended, deloads the week holding today', async () => {
		await withRollback(async (db) => {
			const { owner, programId, reviewed, deps } = await seeded(db, 'week-late', TUESDAY);
			expect(addDays(reviewed, 13) < TUESDAY).toBe(true);
			const made = await review(owner, reviewed, TUESDAY, deps);
			const snapshot = snapshotOf(made);
			expect(snapshot.noProposal).toBeNull();
			expect(snapshot.deload?.week).toBe(MONDAY);
			const row = await proposalRow(db, made.proposalId!);
			expect((row.payload as unknown as ReplanPayload).directive).toMatchObject({
				kind: 'deload',
				week: MONDAY
			});

			await decideNextWeek(owner, made.id, { items: [], accept: true }, deps);
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			expect(weekOf(v2, MONDAY).kind).toBe('deload');
		});
	});
});

describe("M6's machinery on a deload review", () => {
	it("'Keep training as planned' rejects it with the note and makes no version; items are refused", async () => {
		await withRollback(async (db) => {
			const { owner, programId, reviewed, deps } = await seeded(db, 'week-complete', MONDAY);
			const made = await review(owner, reviewed, MONDAY, deps);

			const items = [{ id: 'op:0', choice: 'proposed' as const }];
			const refused = decideNextWeek(owner, made.id, { items, accept: true }, deps);
			await expect(refused).rejects.toBeInstanceOf(ReviewInputError);
			await expect(refused).rejects.toThrow(WHOLE_ONLY);

			const kept = await decideNextWeek(owner, made.id, { items: [], note: 'Feeling fine' }, deps);
			expect(kept).toEqual({ outcome: 'rejected', proposalId: made.proposalId });
			expect(await proposalRow(db, made.proposalId!)).toMatchObject({
				status: 'rejected',
				decision_note: 'Feeling fine'
			});
			expect(await versionCount(db, programId)).toBe(1);
			expect((await getWeeklyReviewView(owner, reviewed, deps)).decision.state).toBe('rejected');
		});
	});

	it('accepted after its week ended reads late, with no version', async () => {
		await withRollback(async (db) => {
			const { owner, programId, reviewed, deps } = await seeded(db, 'week-complete', MONDAY);
			const made = await review(owner, reviewed, MONDAY, deps);
			const later = { ...deps, now: clock(NEXT_TUESDAY) };
			const decided = await decideNextWeek(owner, made.id, { items: [], accept: true }, later);
			expect(decided).toEqual({
				outcome: 'superseded',
				proposalId: made.proposalId,
				reason: 'sessions_passed'
			});
			expect(await versionCount(db, programId)).toBe(1);
			expect((await getWeeklyReviewView(owner, reviewed, later)).decision).toEqual({
				state: 'late',
				proposalId: made.proposalId
			});
			// Decided: a retry says so again.
			expect(await decideNextWeek(owner, made.id, { items: [], accept: true }, later)).toEqual(
				decided
			);
		});
	});

	it('refreshing re-assesses: still needed, a new deload head and the old one review_refreshed', async () => {
		await withRollback(async (db) => {
			const { owner, reviewed, deps } = await seeded(db, 'week-complete', MONDAY);
			const first = await review(owner, reviewed, MONDAY, deps);
			// A second tired check-in that week: stale, and still high.
			await checkIn(db, owner, addDays(reviewed, 5), { sleepHours: 5, soreness: 5 });

			const second = await refreshWeeklyReview(owner, first.id, { today: MONDAY }, deps);
			expect(second.revision).toBe(2);
			expect(second.proposalId).not.toBe(first.proposalId);
			expect(await proposalRow(db, first.proposalId!)).toMatchObject({
				status: 'superseded',
				superseded_reason: 'review_refreshed'
			});
			expect(await proposalRow(db, second.proposalId!)).toMatchObject({
				kind: 'replan',
				status: 'proposed',
				evidence: { source: { reviewId: second.id, revision: 2 } }
			});
			expect(snapshotOf(second).deload?.week).toBe(MONDAY);
		});
	});

	it("refreshing once no deload is needed falls back to M6's next-week changes", async () => {
		await withRollback(async (db) => {
			const { owner, reviewed, deps } = await seeded(db, 'week-complete', MONDAY);
			const first = await review(owner, reviewed, MONDAY, deps);
			// A rested check-in that week brings the averages back: 7 hours of sleep, soreness 2.5.
			await checkIn(db, owner, addDays(reviewed, 5), { sleepHours: 9, soreness: 1 });

			const second = await refreshWeeklyReview(owner, first.id, { today: MONDAY }, deps);
			const snapshot = snapshotOf(second);
			expect(snapshot.fatigue.level).not.toBe('high');
			expect(snapshot).not.toHaveProperty('deload');
			expect(await proposalRow(db, first.proposalId!)).toMatchObject({
				status: 'superseded',
				superseded_reason: 'review_refreshed'
			});
			if (second.proposalId === null) expect(snapshot.noProposal).toBe('no_changes');
			else expect((await proposalRow(db, second.proposalId)).kind).toBe('program_adjustment');
			// The same review without the deload, as M6 computes it.
			const m6 = await getWeeklyReview(owner, second.id, deps);
			expect(snapshotOf(m6).noProposal).toBe(snapshot.noProposal);
		});
	});

	it("is narrated by the mock 'weekly-review' script, the context naming the replan and its decision", async () => {
		await withRollback(async (db) => {
			const { owner, reviewed, deps } = await seeded(db, 'week-complete', MONDAY);
			const made = await review(owner, reviewed, MONDAY, deps);
			const sent: ModelRequest[] = [];
			const stream = MockProvider.prototype.stream;
			vi.spyOn(MockProvider.prototype, 'stream').mockImplementation(function (
				this: MockProvider,
				request,
				signal
			) {
				sent.push(structuredClone(request));
				return stream.call(this, request, signal);
			});

			const result = await narrateReview(owner, { kind: 'weekly', id: made.id }, deps);
			expect(result.outcome).toBe('written');
			const system = sent[0]!.messages.find((m) => (m.role as string) === 'system');
			const text = typeof system?.content === 'string' ? system.content : '';
			const context = JSON.parse(text.slice(text.indexOf('\n') + 1)) as Record<string, unknown>;
			expect(context).toMatchObject({
				review: { proposal: { id: made.proposalId, kind: 'replan', decision: 'undecided' } }
			});
		});
	});
});

describe("M6's paths and robustness", () => {
	it("keeps M6's path when next week is a planned deload", async () => {
		await withRollback(async (db) => {
			const { owner, reviewed, deps } = await seeded(db, 'next-week-deload', MONDAY);
			const made = await review(owner, reviewed, MONDAY, deps);
			expect(snapshotOf(made).fatigue.level).toBe('high');
			expect(snapshotOf(made)).not.toHaveProperty('deload');
			expect((await proposalRow(db, made.proposalId!)).kind).toBe('program_adjustment');
		});
	});

	it("keeps M6's path while the previous week's review's deload is undecided, leaving it as it is", async () => {
		await withRollback(async (db) => {
			const { owner, reviewed, deps } = await seeded(db, 'week-complete', MONDAY);
			// The week before, reviewed late (tired that Sunday too): a deload of this week.
			const earlier = addDays(reviewed, -7);
			await checkIn(db, owner, addDays(earlier, 6), { sleepHours: 5, soreness: 4 });
			const first = await review(owner, earlier, MONDAY, deps);
			expect(snapshotOf(first).deload?.week).toBe(MONDAY);

			const made = await review(owner, reviewed, MONDAY, deps);
			expect(snapshotOf(made).fatigue.level).toBe('high');
			expect(snapshotOf(made)).not.toHaveProperty('deload');
			if (made.proposalId !== null)
				expect((await proposalRow(db, made.proposalId)).kind).toBe('program_adjustment');
			// The earlier deload is neither revised nor shared: still open, still that review's head.
			expect(await proposalRow(db, first.proposalId!)).toMatchObject({ status: 'proposed' });
			expect((await getWeeklyReviewView(owner, earlier, deps)).decision).toEqual({
				state: 'undecided',
				proposalId: first.proposalId
			});
		});
	});

	it('is idempotent: a second create returns the same review and proposes nothing more', async () => {
		await withRollback(async (db) => {
			const { owner, reviewed, deps } = await seeded(db, 'week-complete', MONDAY);
			const first = await createWeeklyReview(
				owner,
				{ weekStartsOn: reviewed, today: MONDAY },
				deps
			);
			const again = await createWeeklyReview(
				owner,
				{ weekStartsOn: reviewed, today: MONDAY },
				deps
			);
			expect(first.created).toBe(true);
			expect(again).toMatchObject({ created: false, review: { id: first.review.id } });
			const { rows } = await db.execute<{ n: number }>(
				sql`select count(*)::int as n from coach_proposals where owner_id = ${owner}`
			);
			expect(rows[0]!.n).toBe(1);
		});
	});

	it('completes inside its transaction on a pool of one connection', async () => {
		const pool = createPool(process.env.DATABASE_URL!, { max: 1, connectionTimeoutMs: 2_000 });
		const solo = createDatabase(pool);
		const ROLLBACK = new Error('rollback');
		const app = (getDb() as unknown as { $client: pg.Pool }).$client;
		const connect = vi.spyOn(app, 'connect');
		const query = vi.spyOn(app, 'query');
		try {
			await solo
				.transaction(async (tx) => {
					const { owner, reviewed, deps } = await seeded(tx, 'week-complete', MONDAY);
					connect.mockClear();
					query.mockClear();
					const made = await review(owner, reviewed, MONDAY, deps);
					expect((await proposalRow(tx, made.proposalId!)).kind).toBe('replan');
					expect(connect).not.toHaveBeenCalled();
					expect(query).not.toHaveBeenCalled();
					throw ROLLBACK;
				})
				.catch((error: unknown) => {
					if (error !== ROLLBACK) throw error;
				});
			expect(takeOverlaps()).toEqual([]);
		} finally {
			await pool.end();
		}
	});

	it("with the context's reader stalled inside the transaction, is created on M6's path with no overlap", async () => {
		const stall: ContextReader = async (db) => {
			await db.execute(sql`select pg_sleep(1)`);
			return null;
		};
		await withRollback(async (db) => {
			const { owner, reviewed, deps } = await seeded(db, 'week-complete', MONDAY);
			takeOverlaps();
			const made = await review(owner, reviewed, MONDAY, { ...deps, context: { reader: stall } });
			expect(snapshotOf(made).fatigue.level).toBe('high');
			expect(snapshotOf(made)).not.toHaveProperty('deload');
			expect((await proposalRow(db, made.proposalId!)).kind).toBe('program_adjustment');
			expect(takeOverlaps()).toEqual([]);
		});
	});

	it('gives a foreign owner nothing: no review to decide, and nothing changes', async () => {
		await withRollback(async (db) => {
			const { owner, reviewed, deps } = await seeded(db, 'week-complete', MONDAY);
			const made = await review(owner, reviewed, MONDAY, deps);
			const other = await makeSecondOwner(db);
			await expect(
				decideNextWeek(other, made.id, { items: [], accept: true }, deps)
			).rejects.toBeInstanceOf(ReviewNotFoundError);
			await expect(getWeeklyReviewView(other, reviewed, deps)).rejects.toBeInstanceOf(
				ReviewNotFoundError
			);
			expect(await proposalRow(db, made.proposalId!)).toMatchObject({ status: 'proposed' });
		});
	});
});
