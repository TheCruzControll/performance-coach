/**
 * Coach conversations (M5, PRD §4, §12): the one way the turn, the endpoints and the screens read
 * and write threads and their transcript.
 *
 * - Idempotent: an owner message is stored once per client message id, so a retried send returns
 *   the stored message (`duplicate: true`) and writes nothing.
 * - Append-only and gapless: every append locks its thread first, so concurrent appends queue
 *   and take seq n + 1 in turn. Rows are never edited (Postgres refuses it).
 * - Every replayed segment stays a valid request: a turn's context row is stored only with its
 *   first step, an assistant tool_use only together with all of its tool_results, and a partial
 *   answer only as a display_only row the model is never sent.
 * - Segmented: the model is replayed the current segment only; the screen shows every segment.
 * - Archived conversations stay reachable (listThreads({archived: true}), getThreadView) and take
 *   no new owner message until unarchived. Nothing is ever deleted.
 * Every function is owner-scoped: someone else's thread is not found, like a missing one.
 */
import type { MessageStatus } from '../../../domain/coach/vocabulary';
import {
	createCoachRepository,
	type DisplayRow,
	type NewMessageRow,
	type ThreadRow,
	type TranscriptRow
} from '../../db/repositories/coach';
import type { Executor } from '../../db/types';
import { THREAD_TITLE_MAX, type ApiContent, type ThreadEntry } from '../../db/schema/coach';
import { isUuid } from '../ids';
import {
	CoachArchivedError,
	CoachInputError,
	CoachNotFoundError,
	CoachTranscriptError,
	resolveDeps,
	type CoachDeps
} from './shared';

/**
 * The longest automatic title, in characters, ellipsis included.
 * Owner decision (M5 plan, 'Thread titles'): a title is the first message, cut at a word; the
 * model writes none. Model-written titles would replace titleFromMessage's caller only.
 */
export const THREAD_AUTO_TITLE_CHARS = 60;
/** The longest owner message, in characters. */
export const OWNER_MESSAGE_MAX_CHARS = 4_000;
/** How many shown messages a conversation opens with, and each older page adds. */
export const THREAD_VIEW_MESSAGES = 30;
/** Conversations per page of a list: the default and the most a caller may ask for. */
export const THREAD_PAGE = Object.freeze({ default: 20, max: 50 });

export type CoachThread = ThreadRow & { archived: boolean };
export type { DisplayRow, TranscriptRow };

/** A content block as the Messages API carries it. */
type Block = Readonly<Record<string, unknown>>;

const toThread = (row: ThreadRow): CoachThread => ({ ...row, archived: row.archivedAt !== null });

const chars = (text: string) => Array.from(text).length;

/** A thread's automatic title: the message on one line, cut at a word with an ellipsis. */
export function titleFromMessage(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	const points = Array.from(flat);
	if (points.length <= THREAD_AUTO_TITLE_CHARS) return flat;
	// A word that ends exactly at the limit is kept whole; one longer than half the title is cut.
	const space = points.slice(0, THREAD_AUTO_TITLE_CHARS).lastIndexOf(' ');
	const head = points.slice(
		0,
		space >= THREAD_AUTO_TITLE_CHARS / 2 ? space : THREAD_AUTO_TITLE_CHARS - 1
	);
	return `${head.join('').trimEnd()}…`;
}

function threadId(id: string): string {
	if (!isUuid(id)) throw new CoachNotFoundError('conversation');
	return id;
}

async function ownThread(db: Executor, ownerId: string, id: string) {
	const row = await createCoachRepository(db).thread(ownerId, threadId(id));
	if (!row) throw new CoachNotFoundError('conversation');
	return row;
}

type Repository = ReturnType<typeof createCoachRepository>;
type Append = Omit<NewMessageRow, 'ownerId' | 'threadId' | 'seq' | 'segment'>;

/** Lock one of the owner's threads for the transaction (see lockThread). */
async function lockOwn(r: Repository, ownerId: string, id: string, at: Date) {
	const thread = await r.lockThread(ownerId, id, at);
	if (!thread) throw new CoachNotFoundError('conversation');
	return thread;
}

/** Append rows to a locked thread's current segment in one statement, seq n + 1 onward. */
async function insertAfter(
	r: Repository,
	ownerId: string,
	thread: ThreadRow,
	rows: Append[],
	options?: { idempotent: boolean }
) {
	let seq = await r.lastSeq(ownerId, thread.id);
	const values = rows.map((row) => {
		seq += 1;
		return { ownerId, threadId: thread.id, seq, segment: thread.segment, ...row };
	});
	return r.insertMessages(values, options);
}

const DUPLICATE = Symbol('duplicate');

export interface OwnerTurnInput {
	/** The conversation to continue; null or absent starts a new one. */
	threadId?: string | null;
	/** The device's id for this message: a retried send with it stores nothing new. */
	clientMessageId: string;
	text: string;
	/** Where a new conversation was started from (the turn's entry). */
	entry?: ThreadEntry | null;
	/** A new conversation's title in place of one from the message (a review's write-up). */
	title?: string;
	/** What a new conversation's first segment starts on (PROMPT_VERSION, the active version). */
	segment: { promptVersion: string; programVersionId: string | null };
	/**
	 * The segment's memory preamble (segmentPreamble), stored ahead of the message when the message
	 * opens its segment, and ignored otherwise: a segment has one, frozen once stored.
	 */
	preamble?: ApiContent;
}

export interface OwnerTurn {
	thread: CoachThread;
	message: { id: string; seq: number };
	/** True when the message was already stored: nothing was written. */
	duplicate: boolean;
}

/**
 * Store the owner's message, starting the conversation when there is none: titled from the
 * message, on segment 1. A message already stored under its client message id is returned as it
 * was, from whichever conversation holds it.
 */
export async function startOwnerTurn(
	ownerId: string,
	input: OwnerTurnInput,
	deps: CoachDeps = {}
): Promise<OwnerTurn> {
	const { db, now } = resolveDeps(deps);
	if (!isUuid(input.clientMessageId)) {
		throw new CoachInputError('clientMessageId', 'A message needs a client message id');
	}
	const text = input.text.trim();
	if (text === '') throw new CoachInputError('text', 'Write a message');
	if (chars(text) > OWNER_MESSAGE_MAX_CHARS) {
		throw new CoachInputError('text', `Keep it under ${OWNER_MESSAGE_MAX_CHARS} characters`);
	}
	const continuing = input.threadId == null ? null : threadId(input.threadId);

	const repo = createCoachRepository(db);
	const replay = async (stored: { id: string; threadId: string; seq: number } | null) => {
		if (!stored) throw new CoachInputError('clientMessageId', 'That message id is taken');
		const thread = (await repo.thread(ownerId, stored.threadId))!;
		return {
			thread: toThread(thread),
			message: { id: stored.id, seq: stored.seq },
			duplicate: true
		};
	};
	const stored = await repo.messageByClientId(ownerId, input.clientMessageId);
	if (stored) return replay(stored);

	try {
		return await db.transaction(async (tx) => {
			const r = createCoachRepository(tx);
			const at = now();
			let thread: ThreadRow;
			if (continuing === null) {
				thread = await r.insertThread({
					ownerId,
					title: input.title === undefined ? titleFromMessage(text) : threadTitle(input.title),
					titleSource: 'first_message',
					entry: input.entry ?? null,
					segmentPromptVersion: segmentPrompt(input.segment.promptVersion),
					segmentProgramVersionId: programVersion(input.segment.programVersionId),
					lastMessageAt: at
				});
			} else {
				thread = await lockOwn(r, ownerId, continuing, at);
				if (thread.archivedAt) throw new CoachArchivedError();
			}
			if (
				input.preamble !== undefined &&
				(await r.lastReplayedKind(ownerId, thread.id, thread.segment)) === null
			) {
				const preamble = { role: 'user', kind: 'segment_preamble', apiVisible: true } as const;
				await insertAfter(r, ownerId, thread, [{ ...preamble, content: input.preamble }]);
			}
			const [message] = await insertAfter(
				r,
				ownerId,
				thread,
				[
					{
						role: 'user',
						kind: 'owner_message',
						apiVisible: true,
						content: text,
						display: { text },
						clientMessageId: input.clientMessageId
					}
				],
				{ idempotent: true }
			);
			// Stored meanwhile by a concurrent send: undo this one (a new thread included).
			if (!message) throw DUPLICATE;
			return { thread: toThread(thread), message, duplicate: false };
		});
	} catch (err) {
		if (err !== DUPLICATE) throw err;
		return replay(await repo.messageByClientId(ownerId, input.clientMessageId));
	}
}

/** The owner's message stored under a client message id, or null: is a send a retry? */
export async function findOwnerMessage(
	ownerId: string,
	clientMessageId: string,
	deps: CoachDeps = {}
): Promise<{ id: string; threadId: string; seq: number } | null> {
	if (!isUuid(clientMessageId)) return null;
	const { db } = resolveDeps(deps);
	return createCoachRepository(db).messageByClientId(ownerId, clientMessageId);
}

function threadTitle(title: string): string {
	const trimmed = title.trim();
	if (trimmed === '' || chars(trimmed) > THREAD_TITLE_MAX) {
		throw new CoachInputError('title', `Use 1 to ${THREAD_TITLE_MAX} characters`);
	}
	return trimmed;
}

function programVersion(id: string | null): string | null {
	if (id !== null && !isUuid(id)) {
		throw new CoachInputError('programVersionId', 'A program version id is a uuid');
	}
	return id;
}

function segmentPrompt(promptVersion: string): string {
	if (promptVersion.trim() === '') {
		throw new CoachInputError('promptVersion', 'A segment needs its prompt version');
	}
	return promptVersion;
}

export interface TurnStep {
	runId: string;
	/** The turn's context message: with the turn's first step, and only then. */
	context?: ApiContent;
	/** The model's message, its content blocks verbatim, and what the screen shows of it. */
	assistant: { content: readonly Block[]; display?: Record<string, unknown> | null };
	/** One user message with a tool_result for each of the assistant's tool_uses, and no other. */
	toolResults?: readonly Block[];
}

/** The ids of the blocks of one type, by the key that holds them. */
const idsOf = (blocks: readonly Block[], type: string, key: string) =>
	blocks.filter((b) => b.type === type).map((b) => String(b[key]));

function checkToolPairs(step: TurnStep) {
	const uses = idsOf(step.assistant.content, 'tool_use', 'id');
	if (step.toolResults === undefined) {
		if (uses.length > 0) {
			throw new CoachTranscriptError('a tool_use is stored only together with its tool_results');
		}
		return;
	}
	const results = idsOf(step.toolResults, 'tool_result', 'tool_use_id');
	const same =
		uses.length > 0 &&
		results.length === step.toolResults.length &&
		new Set(results).size === results.length &&
		results.length === uses.length &&
		uses.every((id) => results.includes(id));
	if (!same) {
		throw new CoachTranscriptError(
			'tool results answer exactly the step’s tool_uses, one tool_result each'
		);
	}
}

/**
 * Store one completed step of a turn atomically: the turn's context with its first step, the
 * model's message, and its tool results when it called tools. The first step follows the owner's
 * message; every later one follows a step's tool results.
 */
export async function appendTurnStep(
	ownerId: string,
	id: string,
	step: TurnStep,
	deps: CoachDeps = {}
): Promise<{ seqs: number[]; ids: string[] }> {
	const { db, now } = resolveDeps(deps);
	threadId(id);
	if (step.assistant.content.length === 0) {
		throw new CoachTranscriptError('an assistant message has content');
	}
	checkToolPairs(step);
	return db.transaction(async (tx) => {
		const r = createCoachRepository(tx);
		const thread = await lockOwn(r, ownerId, id, now());
		const previous = await r.lastReplayedKind(ownerId, id, thread.segment);
		const expected = step.context === undefined ? 'tool_results' : 'owner_message';
		if (previous !== expected) {
			throw new CoachTranscriptError(
				step.context === undefined
					? 'a turn’s first step carries its context'
					: 'the turn context is stored once, with the turn’s first step'
			);
		}
		const { runId } = step;
		const rows: Append[] = [
			{
				role: 'assistant',
				kind: 'assistant',
				apiVisible: true,
				content: step.assistant.content,
				display: step.assistant.display ?? null,
				runId
			}
		];
		if (step.context !== undefined) {
			rows.unshift({
				role: 'system',
				kind: 'context',
				apiVisible: true,
				content: step.context,
				runId
			});
		}
		if (step.toolResults !== undefined) {
			rows.push({
				role: 'user',
				kind: 'tool_results',
				apiVisible: true,
				content: step.toolResults,
				runId
			});
		}
		const stored = await insertAfter(r, ownerId, thread, rows);
		return { seqs: stored.map((m) => m.seq), ids: stored.map((m) => m.id) };
	});
}

/**
 * Store what the screen showed of an answer that did not complete (stopped, interrupted or
 * failed): shown, never replayed to the model.
 */
export async function appendDisplayOnly(
	ownerId: string,
	id: string,
	partial: {
		runId: string;
		content: ApiContent;
		display: Record<string, unknown>;
		status: MessageStatus;
	},
	deps: CoachDeps = {}
): Promise<{ id: string; seq: number }> {
	const { db, now } = resolveDeps(deps);
	threadId(id);
	return db.transaction(async (tx) => {
		const r = createCoachRepository(tx);
		const thread = await lockOwn(r, ownerId, id, now());
		const row: Append = { ...partial, role: 'assistant', kind: 'display_only', apiVisible: false };
		return (await insertAfter(r, ownerId, thread, [row]))[0]!;
	});
}

/** The current segment as the model is replayed it: its rows in order, content verbatim. */
export async function getTranscript(
	ownerId: string,
	id: string,
	deps: CoachDeps = {}
): Promise<{ thread: CoachThread; rows: TranscriptRow[] }> {
	const { db } = resolveDeps(deps);
	const thread = await ownThread(db, ownerId, id);
	const rows = await createCoachRepository(db).transcript(ownerId, thread.id, thread.segment);
	return { thread: toThread(thread), rows };
}

/**
 * A conversation as the screen opens it: the thread with its archived state, and its newest
 * shown messages across segments, oldest first. `before` (a seq) pages back;
 * `olderBefore` is the cursor for the next older page, null at the start.
 */
export async function getThreadView(
	ownerId: string,
	id: string,
	{ before }: { before?: number } = {},
	deps: CoachDeps = {}
): Promise<{ thread: CoachThread; messages: DisplayRow[]; olderBefore: number | null }> {
	const { db } = resolveDeps(deps);
	if (before !== undefined && !(Number.isInteger(before) && before >= 1)) {
		throw new CoachInputError('before', 'An older page starts from a message number');
	}
	const thread = await ownThread(db, ownerId, id);
	const page = await createCoachRepository(db).displayPage(ownerId, thread.id, {
		before,
		limit: THREAD_VIEW_MESSAGES + 1
	});
	const messages = page.slice(0, THREAD_VIEW_MESSAGES).reverse();
	const olderBefore = page.length > THREAD_VIEW_MESSAGES ? messages[0]!.seq : null;
	return { thread: toThread(thread), messages, olderBefore };
}

/**
 * A page of the owner's conversations, newest first: open ones by their last message, or archived
 * ones by when they were archived. `nextBefore` continues the list, null at its end.
 */
export async function listThreads(
	ownerId: string,
	{
		archived = false,
		before,
		limit = THREAD_PAGE.default
	}: { archived?: boolean; before?: string; limit?: number } = {},
	deps: CoachDeps = {}
): Promise<{ threads: CoachThread[]; nextBefore: string | null }> {
	const { db } = resolveDeps(deps);
	if (!(Number.isInteger(limit) && limit >= 1 && limit <= THREAD_PAGE.max)) {
		throw new CoachInputError('limit', `A page holds 1 to ${THREAD_PAGE.max} conversations`);
	}
	if (before !== undefined && !isUuid(before)) {
		throw new CoachInputError('before', 'A page continues from a conversation id');
	}
	const rows = await createCoachRepository(db).threadPage(ownerId, {
		archived,
		before,
		limit: limit + 1
	});
	const threads = rows.slice(0, limit).map(toThread);
	return { threads, nextBefore: rows.length > limit ? threads.at(-1)!.id : null };
}

/** Name a conversation; the owner's name replaces the automatic one for good. */
export async function renameThread(
	ownerId: string,
	id: string,
	title: string,
	deps: CoachDeps = {}
): Promise<CoachThread> {
	const { db } = resolveDeps(deps);
	const trimmed = title.trim();
	if (trimmed === '' || chars(trimmed) > THREAD_TITLE_MAX) {
		throw new CoachInputError('title', `Use 1 to ${THREAD_TITLE_MAX} characters`);
	}
	const row = await createCoachRepository(db).updateThread(ownerId, threadId(id), {
		title: trimmed,
		titleSource: 'owner'
	});
	if (!row) throw new CoachNotFoundError('conversation');
	return toThread(row);
}

async function setArchived(ownerId: string, id: string, archived: boolean, deps: CoachDeps) {
	const { db, now } = resolveDeps(deps);
	const thread = await ownThread(db, ownerId, id);
	if ((thread.archivedAt !== null) === archived) return toThread(thread);
	const row = await createCoachRepository(db).updateThread(ownerId, thread.id, {
		archivedAt: archived ? now() : null
	});
	if (!row) throw new CoachNotFoundError('conversation');
	return toThread(row);
}

/** Archive a conversation: it leaves Recent for Archived, read-only; already archived, a no-op. */
export async function archiveThread(ownerId: string, id: string, deps: CoachDeps = {}) {
	return setArchived(ownerId, id, true, deps);
}

/** Return an archived conversation to Recent, open for messages again; a no-op if it is open. */
export async function unarchiveThread(ownerId: string, id: string, deps: CoachDeps = {}) {
	return setArchived(ownerId, id, false, deps);
}

/**
 * Move a conversation to its next segment, started on `promptVersion` and the active program
 * version: the model is replayed only the new segment from then on. Start it before storing the
 * turn's owner message, so that message opens the segment.
 */
export async function startSegment(
	ownerId: string,
	id: string,
	{ promptVersion, programVersionId }: { promptVersion: string; programVersionId: string | null },
	deps: CoachDeps = {}
): Promise<CoachThread> {
	const { db } = resolveDeps(deps);
	const row = await createCoachRepository(db).updateThread(ownerId, threadId(id), {
		nextSegment: true,
		segmentPromptVersion: segmentPrompt(promptVersion),
		segmentProgramVersionId: programVersion(programVersionId)
	});
	if (!row) throw new CoachNotFoundError('conversation');
	return toThread(row);
}
