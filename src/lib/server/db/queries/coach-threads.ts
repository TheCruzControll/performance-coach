/**
 * Coach conversation read builders (M5, PRD §12): each one keyed query that
 * repositories/coach.ts runs, shaped for the indexes in schema/coach.ts.
 * - Every predicate leads with the thread (or the owner, for the lists) and repeats the owner, so
 *   a row is found only through its owner. A partial index's predicate is repeated so the plan
 *   can use it.
 * - COACH_THREAD_INDEXES names the index each builder is shaped for. The integration test checks
 *   that each exists; `pnpm db:explain` gates them (scripts/explain/history.explain.ts).
 * Nothing runs until a builder is awaited; await them in turn on one connection.
 */
import { and, asc, desc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { coachMessages, coachThreads } from '../schema';
import type { Executor } from '../types';

/** The index each builder is shaped for. */
export const COACH_THREAD_INDEXES = {
	thread: 'coach_threads_pkey',
	lockThread: 'coach_threads_pkey',
	messageByClientId: 'coach_messages_client_message_uq',
	lastSeq: 'coach_messages_thread_seq_uq',
	lastReplayed: 'coach_messages_thread_segment_seq_idx',
	transcript: 'coach_messages_thread_segment_seq_idx',
	displayPage: 'coach_messages_thread_seq_uq',
	threadPage: {
		open: 'coach_threads_owner_recent_idx',
		archived: 'coach_threads_owner_archived_idx'
	}
} as const;

/** A thread as the lists and the conversation header read it. */
export const threadColumns = {
	id: coachThreads.id,
	title: coachThreads.title,
	titleSource: coachThreads.titleSource,
	entry: coachThreads.entry,
	segment: coachThreads.segment,
	segmentPromptVersion: coachThreads.segmentPromptVersion,
	segmentProgramVersionId: coachThreads.segmentProgramVersionId,
	createdAt: coachThreads.createdAt,
	lastMessageAt: coachThreads.lastMessageAt,
	archivedAt: coachThreads.archivedAt
};

const ownThread = (ownerId: string, threadId: string) =>
	and(eq(coachThreads.id, threadId), eq(coachThreads.ownerId, ownerId));

const ownMessages = (ownerId: string, threadId: string) =>
	and(eq(coachMessages.threadId, threadId), eq(coachMessages.ownerId, ownerId));

/** A segment's rows the model is replayed. */
const replayed = (ownerId: string, threadId: string, segment: number) =>
	and(
		ownMessages(ownerId, threadId),
		eq(coachMessages.segment, segment),
		eq(coachMessages.apiVisible, true)
	);

/** One of the owner's threads. */
export function thread(db: Executor, ownerId: string, threadId: string) {
	return db.select(threadColumns).from(coachThreads).where(ownThread(ownerId, threadId));
}

/**
 * Lock one of the owner's threads for the rest of the transaction and move its last message time
 * to `at` (never back): every append to a thread queues here, so its seq is allocated gaplessly.
 */
export function lockThread(db: Executor, ownerId: string, threadId: string, at: Date) {
	return db
		.update(coachThreads)
		.set({ lastMessageAt: sql`greatest(${coachThreads.lastMessageAt}, ${at.toISOString()})` })
		.where(ownThread(ownerId, threadId))
		.returning(threadColumns);
}

/** The owner's message stored under a device's client message id, if any. */
export function messageByClientId(db: Executor, ownerId: string, clientMessageId: string) {
	return db
		.select({ id: coachMessages.id, threadId: coachMessages.threadId, seq: coachMessages.seq })
		.from(coachMessages)
		.where(
			and(eq(coachMessages.clientMessageId, clientMessageId), eq(coachMessages.ownerId, ownerId))
		);
}

/** The thread's highest seq, across segments (none for an empty thread). */
export function lastSeq(db: Executor, ownerId: string, threadId: string) {
	return db
		.select({ seq: coachMessages.seq })
		.from(coachMessages)
		.where(ownMessages(ownerId, threadId))
		.orderBy(desc(coachMessages.seq))
		.limit(1);
}

/** The kind of the segment's last row the model is replayed (none in an empty segment). */
export function lastReplayed(db: Executor, ownerId: string, threadId: string, segment: number) {
	return db
		.select({ kind: coachMessages.kind })
		.from(coachMessages)
		.where(replayed(ownerId, threadId, segment))
		.orderBy(desc(coachMessages.seq))
		.limit(1);
}

/** A segment's replayed rows, in order: what the model is sent, byte for byte. */
export function transcript(db: Executor, ownerId: string, threadId: string, segment: number) {
	return db
		.select({
			id: coachMessages.id,
			seq: coachMessages.seq,
			role: coachMessages.role,
			kind: coachMessages.kind,
			content: coachMessages.content,
			runId: coachMessages.runId
		})
		.from(coachMessages)
		.where(replayed(ownerId, threadId, segment))
		.orderBy(asc(coachMessages.seq));
}

/**
 * The thread's rows the screen shows, across segments, newest first, before seq `before` when
 * given, `limit` at a time.
 */
export function displayPage(
	db: Executor,
	ownerId: string,
	threadId: string,
	{ before, limit }: { before?: number; limit: number }
) {
	return db
		.select({
			id: coachMessages.id,
			seq: coachMessages.seq,
			role: coachMessages.role,
			kind: coachMessages.kind,
			status: coachMessages.status,
			display: coachMessages.display,
			runId: coachMessages.runId,
			createdAt: coachMessages.createdAt
		})
		.from(coachMessages)
		.where(
			and(
				ownMessages(ownerId, threadId),
				isNotNull(coachMessages.display),
				before === undefined ? undefined : lt(coachMessages.seq, before)
			)
		)
		.orderBy(desc(coachMessages.seq))
		.limit(limit);
}

const cursor = alias(coachThreads, 'cursor');

/**
 * The owner's threads, newest first, `limit` at a time: open ones by last message, archived ones
 * by when they were archived. Keyset pagination on (time, id): `before` is the last thread id of
 * the previous page, and its own row gives the time to continue from. A cursor that is not one of
 * the owner's threads in the same list gives an empty page.
 */
export function threadPage(
	db: Executor,
	ownerId: string,
	{ archived, before, limit }: { archived: boolean; before?: string; limit: number }
) {
	const at = archived ? coachThreads.archivedAt : coachThreads.lastMessageAt;
	const cursorAt = archived ? cursor.archivedAt : cursor.lastMessageAt;
	const after =
		before === undefined
			? undefined
			: sql`(${at}, ${coachThreads.id}) < ((${db
					.select({ at: cursorAt })
					.from(cursor)
					.where(
						and(
							eq(cursor.id, before),
							eq(cursor.ownerId, ownerId),
							archived ? isNotNull(cursor.archivedAt) : isNull(cursor.archivedAt)
						)
					)}), ${before}::uuid)`;
	return db
		.select(threadColumns)
		.from(coachThreads)
		.where(
			and(
				eq(coachThreads.ownerId, ownerId),
				archived ? isNotNull(coachThreads.archivedAt) : isNull(coachThreads.archivedAt),
				after
			)
		)
		.orderBy(desc(at), desc(coachThreads.id))
		.limit(limit);
}
