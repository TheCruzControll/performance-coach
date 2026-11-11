/**
 * A review's write-up thread is hidden by its entry (domain/coach/review-entries.ts, the M6
 * plan's review-narration), on real Postgres:
 * - listThreads, open and archived, never lists a weekly or cycle review's thread
 * - summariseSegment never summarises one, even when its segment is due to roll over
 * - memory's other-threads section (thread summaries) leaves out a note about one
 * - a normal conversation, and a review's 'Discuss with your coach' conversation (entry
 *   weekly_review, review-narrative-ui), are unaffected by each
 */
import { describe, expect, it } from 'vitest';
import { summariseSegment } from '../../../src/lib/server/agent/rollover';
import { coachNotes, type Executor } from '../../../src/lib/server/db';
import { loadMemoryRecords } from '../../../src/lib/server/services/coach/memory-records';
import {
	archiveThread,
	listThreads,
	startOwnerTurn
} from '../../../src/lib/server/services/coach/threads';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const NOW = new Date('2026-11-17T20:00:00Z');
const TODAY = '2026-11-17';
const PROMPT = 'pv-review-threads';

async function thread(
	db: Executor,
	owner: string,
	text: string,
	entry: { from: string; id?: string } | null = null
) {
	const turn = await startOwnerTurn(
		owner,
		{
			clientMessageId: crypto.randomUUID(),
			text,
			entry: entry && {
				from: entry.from,
				ref: entry.id === undefined ? null : { type: 'review', id: entry.id }
			},
			segment: { promptVersion: PROMPT, programVersionId: null }
		},
		{ db, now: () => NOW }
	);
	return turn.thread.id;
}

async function threads(db: Executor) {
	const owner = await makeOwner(db);
	return {
		owner,
		weekly: await thread(db, owner, 'Review my week of 9 Nov', {
			from: 'weekly_review_writeup',
			id: 'w-2026-11-09'
		}),
		cycle: await thread(db, owner, 'Review my block', {
			from: 'cycle_review_writeup',
			id: `c-${crypto.randomUUID()}`
		}),
		normal: await thread(db, owner, 'How is my week going?'),
		discuss: await thread(db, owner, 'Why did my volume drop?', {
			from: 'weekly_review',
			id: 'w-2026-11-09'
		})
	};
}

const ids = (list: { threads: { id: string }[] }) => list.threads.map((t) => t.id).sort();

describe('review write-up threads', () => {
	it('are never listed in Recent or Archived conversations; other threads are', async () => {
		await withRollback(async (db) => {
			const t = await threads(db);
			const deps = { db, now: () => NOW };
			expect(ids(await listThreads(t.owner, {}, deps))).toEqual([t.normal, t.discuss].sort());

			await archiveThread(t.owner, t.weekly, deps);
			await archiveThread(t.owner, t.cycle, deps);
			await archiveThread(t.owner, t.discuss, deps);
			expect(ids(await listThreads(t.owner, { archived: true }, deps))).toEqual([t.discuss]);
			expect(ids(await listThreads(t.owner, {}, deps))).toEqual([t.normal]);
		});
	});

	it('are never summarised, even with a segment due to roll over', async () => {
		await withRollback(async (db) => {
			const t = await threads(db);
			const summarise = (threadId: string) =>
				summariseSegment({
					ownerId: t.owner,
					threadId,
					clientMessageId: crypto.randomUUID(),
					// A new prompt version makes every segment due.
					promptVersion: `${PROMPT}-next`,
					provider: null,
					chatCallsBelow: 1000,
					signal: new AbortController().signal,
					deps: { db, now: () => NOW }
				});
			expect(await summarise(t.weekly)).toBeNull();
			expect(await summarise(t.cycle)).toBeNull();
			expect(await summarise(t.normal)).toMatchObject({ reason: 'prompt_version' });
			expect(await summarise(t.discuss)).toMatchObject({ reason: 'prompt_version' });
		});
	});

	it("are left out of memory's other-threads section", async () => {
		await withRollback(async (db) => {
			const t = await threads(db);
			const note = (threadId: string, summary: string) => ({
				ownerId: t.owner,
				kind: 'thread_summary',
				subjects: [],
				body: { threadId, segment: 1 },
				summary,
				createdAt: NOW
			});
			await db
				.insert(coachNotes)
				.values([
					note(t.weekly, 'The weekly review write-up.'),
					note(t.cycle, 'The cycle review write-up.'),
					note(t.normal, 'We talked about the week.'),
					note(t.discuss, 'We discussed the weekly review.')
				]);
			const records = await loadMemoryRecords(t.owner, TODAY, db);
			expect(records.threadSummaries.map((n) => n.text).sort()).toEqual(
				['We talked about the week.', 'We discussed the weekly review.'].sort()
			);
		});
	});
});
