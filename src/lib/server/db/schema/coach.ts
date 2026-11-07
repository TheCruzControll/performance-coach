/**
 * Coach conversations (M5, PRD §4, §12): threads and their transcript, stored so every segment
 * replays to the model byte for byte.
 *
 *   coach_threads   one conversation; renamed, archived and moved to a new segment, nothing else
 *   coach_messages  its transcript, insert-only: what the model was sent and answered, verbatim
 *
 * - content is Postgres `json`, not jsonb: json keeps the exact text it was given (key order,
 *   spacing, escapes), and jsonb reorders keys. It holds the Messages API content as the SDK
 *   returned it, thinking blocks, signatures and fallback blocks included, so a replayed request
 *   is the request that was cached. The screen reads `display` (jsonb) instead.
 * - A conversation runs in segments. A segment starts with the memory preamble; a thread summary
 *   or a new prompt version starts the next one, and records the prompt version and the active
 *   program version it began on. Older segments are kept and never replayed.
 * - Every row carries owner_id (ownerRef), so the test cleanup clears it with the owner.
 * - Guards (drizzle/<n>_coach_conversations_guards.sql): messages are insert-only; a thread
 *   changes only its title, its archive state, its last message time and, one at a time and
 *   together with the segment's prompt and program versions, its segment; DELETE is refused, so
 *   deleting the owner is refused too. Only test and reset code bypasses them (ADR 0010).
 *   Owner decision (M5 plan, 'Deleting conversations'): conversations are archived, never
 *   deleted; allowing deletion is a migration that drops the delete guards.
 * - coach_messages.run_id names the run that wrote the row without a foreign key: a run names
 *   the message that triggered it (agent-runs.ts), and the two keys would form a cycle that a
 *   backup restore can only load by updating an insert-only row.
 */
import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	index,
	integer,
	json,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import type { SourceRef } from '../../../domain/coach/sources';
import {
	MESSAGE_KINDS,
	MESSAGE_ROLES,
	MESSAGE_STATUSES,
	THREAD_TITLE_SOURCES,
	type MessageKind,
	type MessageRole,
	type MessageStatus,
	type ThreadTitleSource
} from '../../../domain/coach/vocabulary';
import { createdAt, inList, ownerRef, updatedAt } from './columns';
import { programVersions } from './programs';

/** A thread title's longest, in characters. */
export const THREAD_TITLE_MAX = 120;

/** The Messages API role each kind of transcript row is replayed (or shown) with. */
export const MESSAGE_KIND_ROLE: Readonly<Record<MessageKind, MessageRole>> = Object.freeze({
	owner_message: 'user',
	segment_preamble: 'user',
	context: 'system',
	assistant: 'assistant',
	tool_results: 'user',
	display_only: 'assistant'
});

/** Where the owner opened the conversation from and about what (the turn's TurnEntry). */
export interface ThreadEntry {
	from: string;
	ref: SourceRef | null;
}

/** A message's content as the Messages API takes it: a string, or its content blocks verbatim. */
export type ApiContent = string | readonly Record<string, unknown>[];

const roleKindCheck = Object.entries(MESSAGE_KIND_ROLE)
	.map(([kind, role]) => `(kind = '${kind}' and role = '${role}')`)
	.join(' or ');

export const coachThreads = pgTable(
	'coach_threads',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		title: text('title').notNull(),
		titleSource: text('title_source').$type<ThreadTitleSource>().notNull(),
		/** Where it was started; null from the Coach tab. */
		entry: jsonb('entry').$type<ThreadEntry>(),
		/** The current segment, from 1. */
		segment: integer('segment').notNull().default(1),
		/** The prompt version (PROMPT_VERSION) the current segment was started with. */
		segmentPromptVersion: text('segment_prompt_version').notNull(),
		/** The active program version when the current segment started; null with no program. */
		segmentProgramVersionId: uuid('segment_program_version_id').references(
			() => programVersions.id
		),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
		archivedAt: timestamp('archived_at', { withTimezone: true })
	},
	(t) => [
		// Recent conversations, and Archived conversations, newest first.
		index('coach_threads_owner_recent_idx')
			.on(t.ownerId, t.lastMessageAt.desc().nullsFirst())
			.where(sql`${t.archivedAt} is null`),
		index('coach_threads_owner_archived_idx')
			.on(t.ownerId, t.archivedAt.desc().nullsFirst())
			.where(sql`${t.archivedAt} is not null`),
		check(
			'coach_threads_title_ck',
			sql`char_length(${t.title}) between 1 and ${sql.raw(String(THREAD_TITLE_MAX))}`
		),
		check('coach_threads_title_source_ck', inList('title_source', THREAD_TITLE_SOURCES)),
		check('coach_threads_segment_ck', sql`${t.segment} >= 1`),
		check('coach_threads_prompt_version_ck', sql`char_length(${t.segmentPromptVersion}) > 0`)
	]
);

export const coachMessages = pgTable(
	'coach_messages',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		threadId: uuid('thread_id')
			.notNull()
			.references(() => coachThreads.id),
		/** The message's place in its thread, from 1, across segments. */
		seq: integer('seq').notNull(),
		segment: integer('segment').notNull(),
		role: text('role').$type<MessageRole>().notNull(),
		kind: text('kind').$type<MessageKind>().notNull(),
		/** Replayed to the model; false only for a display_only row. */
		apiVisible: boolean('api_visible').notNull(),
		/** The message as the model was sent it or returned it, byte for byte. */
		content: json('content').$type<ApiContent>().notNull(),
		/** What the screen shows; null for rows it never shows. */
		display: jsonb('display').$type<Record<string, unknown>>(),
		status: text('status').$type<MessageStatus>().notNull().default('complete'),
		/** The device's id for an owner message, so a retried send stores it once. */
		clientMessageId: uuid('client_message_id'),
		/** The run that wrote it (agent_runs.id), with no foreign key (see above). */
		runId: uuid('run_id'),
		createdAt: createdAt()
	},
	(t) => [
		uniqueIndex('coach_messages_thread_seq_uq').on(t.threadId, t.seq),
		uniqueIndex('coach_messages_client_message_uq').on(t.clientMessageId),
		// A segment's transcript, in order.
		index('coach_messages_thread_segment_seq_idx').on(t.threadId, t.segment, t.seq),
		check('coach_messages_seq_ck', sql`${t.seq} >= 1 and ${t.segment} >= 1`),
		check('coach_messages_role_ck', inList('role', MESSAGE_ROLES)),
		check('coach_messages_kind_ck', inList('kind', MESSAGE_KINDS)),
		// Postgres tests CHECKs in name order, so an unknown role or kind is refused by its own.
		check('coach_messages_role_kind_ck', sql.raw(roleKindCheck)),
		check('coach_messages_api_visible_ck', sql`${t.apiVisible} = (${t.kind} <> 'display_only')`),
		check('coach_messages_status_ck', inList('status', MESSAGE_STATUSES)),
		check(
			'coach_messages_client_message_ck',
			sql`${t.clientMessageId} is null or ${t.kind} = 'owner_message'`
		)
	]
);
