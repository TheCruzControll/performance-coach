/**
 * The Coach screen's load (src/routes/(app)/coach/[[thread]]/coach.server.ts) on real Postgres:
 * - /coach: the open conversations newest first, a page at a time, each with when it was last
 *   active in the owner's zone; ?before pages on, a malformed cursor is the first page; archived
 *   ones are not listed; the prefill an entry point sent; a review's 'Discuss with your coach'
 *   entry (from weekly_review, ref review:<key>) kept only for the owner's own review, and stored
 *   on the conversation its first turn starts.
 * - /coach/<id>: the conversation's shown messages in order, through the threads service, and
 *   whether it is archived (read-only until unarchived).
 * - A malformed or unknown id, or someone else's conversation, is the 404 page.
 * - A read that fails is the screen's load-failed state, recorded.
 */
import { eq, sql } from 'drizzle-orm';
import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { coachThreads, type Executor } from '../../../src/lib/server/db';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import { saveBasics } from '../../../src/lib/server/services/profile/index';
import { createWeeklyReview } from '../../../src/lib/server/services/reviews';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import {
	appendTurnStep,
	archiveThread,
	listThreads,
	startOwnerTurn,
	THREAD_PAGE,
	unarchiveThread
} from '../../../src/lib/server/services/coach/threads';
import {
	loadCoachScreen,
	type CoachScreenData
} from '../../../src/routes/(app)/coach/[[thread]]/coach.server';
import { unreachableDb, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const ROUTE = '/(app)/coach/[[thread]]';
const SEGMENT = { promptVersion: 'pv-0000000000000001', programVersionId: null };
const RUN = '0b6f6a52-1c55-4d2e-9a52-6d1f1e0c2a11';
const CONTEXT = [{ type: 'text', text: '{"date":"2026-11-10"}' }];
/** 09:30 on Wednesday 11 November 2026 in Sydney. */
const NOW = new Date('2026-11-10T22:30:00Z');

const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/coach',
	routeId: ROUTE,
	appVersion: '0.1.0+test'
});

const load = (db: Executor, owner: string, thread?: string, query = '') =>
	loadCoachScreen(
		owner,
		{ thread, search: new URLSearchParams(query), origin: origin() },
		{ db, now: () => NOW }
	);

async function ready(promise: Promise<CoachScreenData>) {
	const data = await promise;
	if (data.failed) throw new Error('expected the Coach screen, got its load failure');
	return data;
}

async function status(promise: Promise<unknown>): Promise<number> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!isHttpError(error)) throw new Error(`expected an HTTP error, got ${String(error)}`);
	return error.status;
}

/** An owner in Sydney. */
async function owner(db: Executor) {
	const id = await makeOwner(db);
	await saveBasics(
		id,
		{ name: 'Niko', weightUnit: 'kg', distanceUnit: 'km', timeZone: 'Australia/Sydney' },
		{ db }
	);
	return id;
}

/** A conversation whose one message was sent at `at`. */
async function ask(db: Executor, ownerId: string, text: string, at: string) {
	const { thread } = await startOwnerTurn(
		ownerId,
		{ clientMessageId: crypto.randomUUID(), text, segment: SEGMENT },
		{ db, now: () => new Date(at) }
	);
	return thread.id;
}

const block = (text: string) => ({
	block: 0,
	kind: 'note',
	method: null,
	ast: [{ type: 'text', text }],
	sources: [],
	grounded: true
});

describe('the Coach screen', () => {
	it('lists open conversations newest first, each with when it was last active', async () => {
		await withRollback(async (db) => {
			const me = await owner(db);
			const older = await ask(db, me, 'What should I focus on next week?', '2026-11-08T23:00:00Z');
			const yesterday = await ask(db, me, 'Should I deload?', '2026-11-10T07:40:00Z');
			const today = await ask(db, me, 'How is my bench?', '2026-11-10T20:05:00Z');
			await archiveThread(me, await ask(db, me, 'Archived', '2026-11-10T21:00:00Z'), { db });

			const data = await ready(load(db, me));
			expect(data.threads).toEqual([
				{ id: today, title: 'How is my bench?', when: 'Today · 07:05' },
				{ id: yesterday, title: 'Should I deload?', when: 'Yesterday · 18:40' },
				{ id: older, title: 'What should I focus on next week?', when: 'Mon 9 Nov' }
			]);
			expect(data).toMatchObject({ failed: false, next: null, thread: null, prefill: null });
		});
	});

	it('pages on from ?before, and starts again from a malformed cursor', async () => {
		await withRollback(async (db) => {
			const me = await owner(db);
			const ids: string[] = [];
			for (let n = 0; n <= THREAD_PAGE.default; n++) {
				const at = new Date(NOW.getTime() - (n + 1) * 60_000).toISOString();
				ids.push(await ask(db, me, `Question ${n}`, at));
			}

			const first = await ready(load(db, me));
			expect(first.threads.map((t) => t.id)).toEqual(ids.slice(0, THREAD_PAGE.default));
			expect(first.next).toBe(ids[THREAD_PAGE.default - 1]);

			const second = await ready(load(db, me, undefined, `before=${first.next}`));
			expect(second.threads.map((t) => t.id)).toEqual([ids[THREAD_PAGE.default]]);
			expect(second.next).toBeNull();

			const malformed = await ready(load(db, me, undefined, 'before=nope'));
			expect(malformed.threads.map((t) => t.id)).toEqual(first.threads.map((t) => t.id));
		});
	});

	it('keeps a review’s Discuss entry for the owner’s own review, stored by its first turn', async () => {
		await withRollback(async (db) => {
			const reviewed = '2026-11-09';
			const at = atLocal('2026-11-17', '12:00', 'America/Los_Angeles');
			const me = await makeOwner(db);
			await seedAnalyticsFixture(
				me,
				'week-complete',
				{ timeZone: 'America/Los_Angeles', now: at },
				{ db }
			);
			await createWeeklyReview(
				me,
				{ weekStartsOn: reviewed, today: '2026-11-17' },
				{ db, now: () => at }
			);
			const text = 'Can we go through my weekly review?';
			const query = (ref: string) =>
				new URLSearchParams({ ask: text, from: 'weekly_review', ref }).toString();
			const bare = { text, from: null, label: null, ref: null };

			const prefill = (await ready(load(db, me, undefined, query(`review:w-${reviewed}`)))).prefill;
			expect(prefill).toEqual({
				text,
				from: 'weekly_review',
				label: 'From your weekly review',
				ref: { type: 'review', id: `w-${reviewed}` }
			});
			const { thread } = await startOwnerTurn(
				me,
				{
					clientMessageId: crypto.randomUUID(),
					text: prefill!.text,
					entry: { from: prefill!.from!, ref: prefill!.ref },
					segment: SEGMENT
				},
				{ db, now: () => NOW }
			);
			const [stored] = await db.select().from(coachThreads).where(eq(coachThreads.id, thread.id));
			expect(stored!.entry).toEqual({
				from: 'weekly_review',
				ref: { type: 'review', id: `w-${reviewed}` }
			});
			// A normal conversation, listed in Recent.
			expect((await listThreads(me, {}, { db })).threads.map((t) => t.id)).toEqual([thread.id]);

			// Someone else's review (one database holds one owner: anyone else's id owns none), a
			// week with no review, an unknown cycle review: the question alone.
			const someone = await load(db, crypto.randomUUID(), undefined, query(`review:w-${reviewed}`));
			expect(someone.prefill).toEqual(bare);
			expect((await ready(load(db, me, undefined, query('review:w-2026-11-02')))).prefill).toEqual(
				bare
			);
			const cycle = query(`review:c-${crypto.randomUUID()}`);
			expect((await ready(load(db, me, undefined, cycle))).prefill).toEqual(bare);
			// A review's entry with no ref, or with a ref that is not a review: the question alone.
			const noRef = new URLSearchParams({ ask: text, from: 'cycle_review' }).toString();
			expect((await ready(load(db, me, undefined, noRef))).prefill).toEqual(bare);
			const workout = query(`workout:${crypto.randomUUID()}`);
			expect((await ready(load(db, me, undefined, workout))).prefill).toEqual(bare);
		});
	});

	it('carries the prefill an entry point sent, on /coach only', async () => {
		await withRollback(async (db) => {
			const me = await owner(db);
			const query = 'ask=How%20did%20it%20go%3F&from=workout';
			expect((await ready(load(db, me, undefined, query))).prefill).toEqual({
				text: 'How did it go?',
				from: 'workout',
				label: 'From your workout',
				ref: null
			});
			const thread = await ask(db, me, 'Hi', '2026-11-10T20:05:00Z');
			expect((await ready(load(db, me, thread, query))).prefill).toBeNull();
		});
	});

	it('opens a conversation with its shown messages, in order', async () => {
		await withRollback(async (db) => {
			const me = await owner(db);
			const thread = await ask(db, me, 'How is my bench?', '2026-11-10T20:05:00Z');
			await appendTurnStep(
				me,
				thread,
				{
					runId: RUN,
					context: CONTEXT,
					assistant: {
						content: [{ type: 'text', text: 'Up 5 kg.' }],
						display: { blocks: [block('Up 5 kg.')] }
					}
				},
				{ db }
			);

			const data = await ready(load(db, me, thread));
			// The owner's message carries the id it was sent with, for Retry.
			const [sent] = (
				await db.execute(
					sql`select client_message_id::text as "sentWith" from coach_messages
					where thread_id = ${thread} and kind = 'owner_message'`
				)
			).rows as { sentWith: string }[];
			expect(data.threads).toEqual([]);
			expect(data.thread).toEqual({
				id: thread,
				title: 'How is my bench?',
				archived: false,
				messages: [
					{
						id: expect.any(String),
						from: 'owner',
						text: 'How is my bench?',
						clientId: sent!.sentWith
					},
					{
						id: expect.any(String),
						from: 'coach',
						blocks: [block('Up 5 kg.')],
						ended: null,
						retryable: false
					}
				]
			});
		});
	});

	it('opens an archived conversation marked archived, with its messages, until it is unarchived', async () => {
		await withRollback(async (db) => {
			const me = await owner(db);
			const thread = await ask(db, me, 'Old question', '2026-11-10T20:05:00Z');
			await archiveThread(me, thread, { db });
			const archived = (await ready(load(db, me, thread))).thread!;
			expect([archived.archived, archived.messages.map((m) => m.from)]).toEqual([true, ['owner']]);
			await unarchiveThread(me, thread, { db });
			expect((await ready(load(db, me, thread))).thread!.archived).toBe(false);
		});
	});

	it('answers 404 for a malformed or unknown id, and for someone else’s conversation', async () => {
		await withRollback(async (db) => {
			const me = await owner(db);
			const mine = await ask(db, me, 'Mine', '2026-11-10T20:05:00Z');
			expect(await status(load(db, me, 'not-a-uuid'))).toBe(404);
			expect(await status(load(db, me, crypto.randomUUID()))).toBe(404);
			// One database holds one owner: anyone else's id finds none of the owner's threads.
			expect(await status(load(db, crypto.randomUUID(), mine))).toBe(404);
			expect((await ready(load(db, me, mine))).thread?.id).toBe(mine);
		});
	});

	it('fails soft when the database cannot be reached, and records the failure', async () => {
		const broken = unreachableDb();
		try {
			await withRollback(async (tx) => {
				for (const thread of [undefined, crypto.randomUUID()]) {
					const request = origin();
					const data = await loadCoachScreen(
						crypto.randomUUID(),
						{ thread, search: new URLSearchParams('ask=Hi'), origin: request },
						{ db: broken.db, errorsDb: tx }
					);
					expect(data).toEqual({
						failed: true,
						prefill:
							thread === undefined ? { text: 'Hi', from: null, label: null, ref: null } : null
					});
					const recorded = await findErrorsByRequestId(request.requestId, { db: tx });
					expect(recorded).toHaveLength(1);
					expect(recorded[0]).toMatchObject({
						kind: 'load',
						status: 500,
						routeId: ROUTE,
						context: expect.objectContaining({ load: 'coach' })
					});
				}
			});
		} finally {
			await broken.close();
		}
	});
});
