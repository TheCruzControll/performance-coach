/**
 * Coach conversation persistence: runs queries/coach-threads.ts's builders one query at a time,
 * and the few writes the thread guard allows. Plain data access: idempotency, seq allocation,
 * the transcript's shape and the owner's limits belong to src/lib/server/services/coach/threads.ts.
 */
import { and, eq, sql } from 'drizzle-orm';
import * as q from '../queries/coach-threads';
import { coachMessages, coachThreads } from '../schema';
import type { Executor } from '../types';

export type ThreadRow = Awaited<ReturnType<typeof q.thread>>[number];
export type DisplayRow = Awaited<ReturnType<typeof q.displayPage>>[number];
export type TranscriptRow = Awaited<ReturnType<typeof q.transcript>>[number];
export type NewThreadRow = typeof coachThreads.$inferInsert;
export type NewMessageRow = typeof coachMessages.$inferInsert;
/** What a thread may change: its title, its archive state, and its segment, forward by one. */
export type ThreadChange = Partial<
	Pick<
		NewThreadRow,
		'title' | 'titleSource' | 'archivedAt' | 'segmentPromptVersion' | 'segmentProgramVersionId'
	>
> & { nextSegment?: true };

const first = async <T>(rows: Promise<T[]>): Promise<T | null> => (await rows)[0] ?? null;

export function createCoachRepository(db: Executor) {
	return {
		thread: (ownerId: string, threadId: string) => first(q.thread(db, ownerId, threadId)),

		/** Lock the thread for the transaction, touching its last message time; null if not found. */
		lockThread: (ownerId: string, threadId: string, at: Date) =>
			first(q.lockThread(db, ownerId, threadId, at)),

		messageByClientId: (ownerId: string, clientMessageId: string) =>
			first(q.messageByClientId(db, ownerId, clientMessageId)),

		/** The thread's highest seq, 0 when it has no message. */
		lastSeq: async (ownerId: string, threadId: string) =>
			(await first(q.lastSeq(db, ownerId, threadId)))?.seq ?? 0,

		lastReplayedKind: async (ownerId: string, threadId: string, segment: number) =>
			(await first(q.lastReplayed(db, ownerId, threadId, segment)))?.kind ?? null,

		transcript: async (ownerId: string, threadId: string, segment: number) =>
			q.transcript(db, ownerId, threadId, segment),

		displayPage: async (
			ownerId: string,
			threadId: string,
			page: { before?: number; limit: number }
		) => q.displayPage(db, ownerId, threadId, page),

		threadPage: async (
			ownerId: string,
			page: { archived: boolean; before?: string; limit: number }
		) => q.threadPage(db, ownerId, page),

		insertThread: async (values: NewThreadRow) =>
			(await first(db.insert(coachThreads).values(values).returning(q.threadColumns)))!,

		/**
		 * Insert rows in one statement. With `idempotent`, a row whose client message id is already
		 * stored is skipped: the returned list is then shorter than the given one.
		 */
		insertMessages: async (rows: NewMessageRow[], { idempotent = false } = {}) => {
			const insert = db.insert(coachMessages).values(rows);
			return (
				idempotent ? insert.onConflictDoNothing({ target: coachMessages.clientMessageId }) : insert
			).returning({ id: coachMessages.id, seq: coachMessages.seq });
		},

		/** Change what the thread guard lets a thread change; null if not found. */
		updateThread: (ownerId: string, threadId: string, { nextSegment, ...set }: ThreadChange) =>
			first(
				db
					.update(coachThreads)
					.set({ ...set, ...(nextSegment ? { segment: sql`${coachThreads.segment} + 1` } : {}) })
					.where(and(eq(coachThreads.id, threadId), eq(coachThreads.ownerId, ownerId)))
					.returning(q.threadColumns)
			)
	};
}
