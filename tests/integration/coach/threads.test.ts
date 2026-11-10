/**
 * The coach threads service on real Postgres (the M5 plan's coach-threads-service):
 * - The first owner message starts a conversation titled from it; a client message id is stored
 *   once, even when the retry races the first send.
 * - seq stays gapless while sends to one conversation run concurrently on the pool.
 * - A step is stored atomically and only in a shape the model accepts: no orphan tool_use, the
 *   turn context once, with the first step. A partial answer is shown but never replayed.
 * - The transcript is the current segment; the screen's view spans segments and pages back.
 * - Conversation lists page by keyset; archived ones are listed only as archived, stay readable
 *   and take no message until unarchived.
 * - toolRuntime tells tools to run serially exactly when they share a transaction.
 * - Someone else's or a missing conversation is not found, and every bound is enforced.
 */
import { count, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	coachMessages,
	coachThreads,
	getDb,
	programs,
	programVersions,
	type Executor
} from '../../../src/lib/server/db';
import { COACH_THREAD_INDEXES } from '../../../src/lib/server/db/queries/coach-threads';
import {
	CoachArchivedError,
	CoachInputError,
	CoachNotFoundError,
	CoachTranscriptError,
	toolRuntime,
	type CoachDeps
} from '../../../src/lib/server/services/coach/shared';
import {
	appendDisplayOnly,
	appendTurnStep,
	archiveThread,
	getThreadView,
	getTranscript,
	listThreads,
	renameThread,
	startOwnerTurn,
	startSegment,
	THREAD_AUTO_TITLE_CHARS,
	THREAD_PAGE,
	THREAD_VIEW_MESSAGES,
	titleFromMessage,
	unarchiveThread,
	type OwnerTurnInput
} from '../../../src/lib/server/services/coach/threads';
import { holdTransaction, lockWaiters, withCommitted, withRollback } from '../helpers';
import { clock, makeOwner } from '../profile/fixtures';

const SEGMENT = { promptVersion: 'pv-0000000000000001', programVersionId: null };
const RUN = '0b6f6a52-1c55-4d2e-9a52-6d1f1e0c2a11';

const send = (text: string, values: Partial<OwnerTurnInput> = {}): OwnerTurnInput => ({
	clientMessageId: crypto.randomUUID(),
	text,
	segment: SEGMENT,
	...values
});

/** The rows the owner has, per table. */
async function rows(db: Executor, ownerId: string) {
	const [threads] = await db
		.select({ n: count() })
		.from(coachThreads)
		.where(eq(coachThreads.ownerId, ownerId));
	const [messages] = await db
		.select({ n: count() })
		.from(coachMessages)
		.where(eq(coachMessages.ownerId, ownerId));
	return { threads: threads!.n, messages: messages!.n };
}

const messagesOf = (db: Executor, threadId: string) =>
	db
		.select()
		.from(coachMessages)
		.where(eq(coachMessages.threadId, threadId))
		.orderBy(coachMessages.seq);

/** What a promise rejected with (fails the test if it resolved). */
async function rejection(promise: Promise<unknown>): Promise<Error> {
	const err = await promise.then(
		() => null,
		(e: unknown) => e
	);
	if (!(err instanceof Error)) throw new Error('expected a rejection');
	return err;
}

const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'get_exercise_history', input: {} });
const toolResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: '{}' });
const thinking = { type: 'thinking', thinking: '', signature: 'sig-1' };
const answer = (text: string) => ({ type: 'text', text });
const CONTEXT = [{ type: 'text', text: '{"date":"2026-11-10"}' }];

describe('coach threads', () => {
	it('starts a conversation with its first message, titled from it', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const at = clock('2026-11-10T07:42:00Z');
			const deps: CoachDeps = { db: tx, now: at.now };
			const text =
				'  How has my bench\n progressed over the last month, and should I deload before the fight?  ';

			const turn = await startOwnerTurn(
				ownerId,
				send(text, { entry: { from: 'today', ref: null } }),
				deps
			);

			expect(turn.duplicate).toBe(false);
			expect(turn.message.seq).toBe(1);
			expect(turn.thread).toMatchObject({
				title: 'How has my bench progressed over the last month, and should…',
				titleSource: 'first_message',
				entry: { from: 'today', ref: null },
				segment: 1,
				segmentPromptVersion: SEGMENT.promptVersion,
				segmentProgramVersionId: null,
				lastMessageAt: at.now(),
				archived: false,
				archivedAt: null
			});
			expect(Array.from(turn.thread.title).length).toBeLessThanOrEqual(THREAD_AUTO_TITLE_CHARS);
			const stored = text.trim();
			expect(await messagesOf(tx, turn.thread.id)).toMatchObject([
				{
					id: turn.message.id,
					seq: 1,
					segment: 1,
					role: 'user',
					kind: 'owner_message',
					apiVisible: true,
					content: stored,
					display: { text: stored },
					status: 'complete'
				}
			]);

			// A second message continues it: the next seq, a later last message time, the same title.
			at.advanceDays(1);
			const next = await startOwnerTurn(
				ownerId,
				send('And my squat?', { threadId: turn.thread.id }),
				deps
			);
			expect(next.message.seq).toBe(2);
			expect(next.thread).toMatchObject({ id: turn.thread.id, lastMessageAt: at.now() });
			expect(next.thread.title).toBe(turn.thread.title);
		});
	});

	it('titles a short message as written, and cuts a long word mid-way', () => {
		expect(titleFromMessage(' Deload\tweek? ')).toBe('Deload week?');
		const long = 'x'.repeat(80);
		expect(titleFromMessage(long)).toBe(`${'x'.repeat(THREAD_AUTO_TITLE_CHARS - 1)}…`);
		// Characters, not UTF-16 units: an emoji is never split.
		const emoji = '💪'.repeat(70);
		expect(Array.from(titleFromMessage(emoji))).toHaveLength(THREAD_AUTO_TITLE_CHARS);
	});

	it('stores a message once per client message id, and a retry writes nothing', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const clientMessageId = crypto.randomUUID();
			const first = await startOwnerTurn(ownerId, send('How is my bench?', { clientMessageId }), {
				db: tx
			});
			const second = await startOwnerTurn(
				ownerId,
				send('And my squat?', { threadId: first.thread.id }),
				{ db: tx }
			);
			const before = await rows(tx, ownerId);

			// A retry without the thread id (the first answer never arrived) starts no other thread,
			// and one sent after a later message neither moves nor repeats it.
			const again = await startOwnerTurn(ownerId, send('How is my bench?', { clientMessageId }), {
				db: tx
			});

			expect(again).toEqual({ ...second, message: first.message, duplicate: true });
			expect(await rows(tx, ownerId)).toEqual(before);
			expect(await rows(tx, ownerId)).toEqual({ threads: 1, messages: 2 });

			// Still a duplicate once the conversation is archived: the retry is answered, not refused.
			await archiveThread(ownerId, first.thread.id, { db: tx });
			const late = await startOwnerTurn(
				ownerId,
				send('How is my bench?', { clientMessageId, threadId: first.thread.id }),
				{ db: tx }
			);
			expect(late).toMatchObject({ message: first.message, duplicate: true });
			expect(await rows(tx, ownerId)).toEqual(before);
		});
	});

	it('stores a message once when the retry races the first send', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			const clientMessageId = crypto.randomUUID();
			// The first send has written its rows but not committed them yet.
			let first!: Awaited<ReturnType<typeof startOwnerTurn>>;
			const held = await holdTransaction(async (tx) => {
				first = await startOwnerTurn(ownerId, send('Bench?', { clientMessageId }), { db: tx });
			});
			// The retry finds nothing committed, and queues on the client message id.
			const retry = startOwnerTurn(ownerId, send('Bench?', { clientMessageId }), { db });
			await lockWaiters(1);
			await held.commit();

			expect(await retry).toEqual({ ...first, duplicate: true });
			expect(await rows(db, ownerId)).toEqual({ threads: 1, messages: 1 });
		});
	});

	it('keeps seq gapless while sends to one conversation run concurrently', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			const { thread } = await startOwnerTurn(ownerId, send('Week one'), { db });
			// Separate pool calls: each its own connection and transaction.
			const sends = Array.from({ length: 6 }, (_, i) =>
				startOwnerTurn(ownerId, send(`Question ${i}`, { threadId: thread.id }), { db })
			);
			const turns = await Promise.all(sends);

			expect(turns.map((t) => t.message.seq).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7]);
			expect((await messagesOf(db, thread.id)).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
		});
	});

	it('stores a turn step by step, each tool_use with its results and the context once', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const deps = { db: tx };
			const { thread } = await startOwnerTurn(ownerId, send('How is my bench?'), deps);

			const first = await appendTurnStep(
				ownerId,
				thread.id,
				{
					runId: RUN,
					context: CONTEXT,
					assistant: { content: [thinking, toolUse('toolu_1'), toolUse('toolu_2')] },
					toolResults: [toolResult('toolu_2'), toolResult('toolu_1')]
				},
				deps
			);
			const last = await appendTurnStep(
				ownerId,
				thread.id,
				{
					runId: RUN,
					assistant: { content: [answer('Up 5 kg.')], display: { blocks: ['Up 5 kg.'] } }
				},
				deps
			);

			expect(first.seqs).toEqual([2, 3, 4]);
			expect(last.seqs).toEqual([5]);
			const { rows: transcript } = await getTranscript(ownerId, thread.id, deps);
			const stored = await messagesOf(tx, thread.id);
			expect(transcript.map((row) => row.id)).toEqual(stored.map((m) => m.id));
			expect(transcript.map(({ id: _id, ...row }) => row)).toEqual([
				{ seq: 1, role: 'user', kind: 'owner_message', content: 'How is my bench?', runId: null },
				{ seq: 2, role: 'system', kind: 'context', content: CONTEXT, runId: RUN },
				{
					seq: 3,
					role: 'assistant',
					kind: 'assistant',
					content: [thinking, toolUse('toolu_1'), toolUse('toolu_2')],
					runId: RUN
				},
				{
					seq: 4,
					role: 'user',
					kind: 'tool_results',
					content: [toolResult('toolu_2'), toolResult('toolu_1')],
					runId: RUN
				},
				{
					seq: 5,
					role: 'assistant',
					kind: 'assistant',
					content: [answer('Up 5 kg.')],
					runId: RUN
				}
			]);
			expect(stored.slice(1).every((m) => m.runId === RUN)).toBe(true);
			expect(stored.map((m) => m.display)).toEqual([
				{ text: 'How is my bench?' },
				null,
				null,
				null,
				{ blocks: ['Up 5 kg.'] }
			]);
		});
	});

	it('refuses an orphan tool_use, unmatched results and a misplaced context, writing nothing', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const deps = { db: tx };
			const { thread } = await startOwnerTurn(ownerId, send('How is my bench?'), deps);
			const before = await rows(tx, ownerId);
			const step = (values: Partial<Parameters<typeof appendTurnStep>[2]>) =>
				rejection(
					appendTurnStep(
						ownerId,
						thread.id,
						{ runId: RUN, context: CONTEXT, assistant: { content: [answer('Hi')] }, ...values },
						deps
					)
				);

			const refusals = [
				// An orphan tool_use: no results at all.
				await step({ assistant: { content: [toolUse('toolu_1')] } }),
				// Results missing one of the tool_uses, answering another, or repeated.
				await step({
					assistant: { content: [toolUse('toolu_1'), toolUse('toolu_2')] },
					toolResults: [toolResult('toolu_1')]
				}),
				await step({
					assistant: { content: [toolUse('toolu_1')] },
					toolResults: [toolResult('toolu_9')]
				}),
				await step({
					assistant: { content: [toolUse('toolu_1')] },
					toolResults: [toolResult('toolu_1'), toolResult('toolu_1')]
				}),
				// Results with no tool_use, a non-result block among them, an empty message.
				await step({ toolResults: [toolResult('toolu_1')] }),
				await step({
					assistant: { content: [toolUse('toolu_1')] },
					toolResults: [toolResult('toolu_1'), answer('extra')]
				}),
				await step({ assistant: { content: [] } }),
				// The first step without its context.
				await step({ context: undefined })
			];
			for (const err of refusals) expect(err).toBeInstanceOf(CoachTranscriptError);
			expect(await rows(tx, ownerId)).toEqual(before);

			// After a final answer, the turn is over: a second context is refused, and so is a step.
			await appendTurnStep(
				ownerId,
				thread.id,
				{ runId: RUN, context: CONTEXT, assistant: { content: [answer('Hi')] } },
				deps
			);
			const after = await rows(tx, ownerId);
			expect(await step({})).toBeInstanceOf(CoachTranscriptError);
			expect(await step({ context: undefined })).toBeInstanceOf(CoachTranscriptError);
			expect(await rows(tx, ownerId)).toEqual(after);
		});
	});

	it('shows a partial answer without replaying it to the model', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const deps = { db: tx };
			const { thread } = await startOwnerTurn(ownerId, send('Plan my week'), deps);
			const partial = await appendDisplayOnly(
				ownerId,
				thread.id,
				{
					runId: RUN,
					content: [answer('Monday is')],
					display: { blocks: ['Monday is'] },
					status: 'interrupted'
				},
				deps
			);

			expect(partial.seq).toBe(2);
			expect((await getTranscript(ownerId, thread.id, deps)).rows.map((r) => r.seq)).toEqual([1]);
			const view = await getThreadView(ownerId, thread.id, {}, deps);
			expect(view.messages.map((m) => [m.seq, m.kind, m.status, m.display])).toEqual([
				[1, 'owner_message', 'complete', { text: 'Plan my week' }],
				[2, 'display_only', 'interrupted', { blocks: ['Monday is'] }]
			]);
			// The next turn's first step follows the owner's new message, not the partial.
			await startOwnerTurn(ownerId, send('Try again', { threadId: thread.id }), deps);
			const step = await appendTurnStep(
				ownerId,
				thread.id,
				{ runId: RUN, context: CONTEXT, assistant: { content: [answer('Monday is legs.')] } },
				deps
			);
			expect(step.seqs).toEqual([4, 5]);
		});
	});

	it('replays the current segment only, while the view spans every segment', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const deps = { db: tx };
			const [program] = await tx
				.insert(programs)
				.values({ ownerId, title: 'Fight camp' })
				.returning();
			const [version] = await tx
				.insert(programVersions)
				.values({
					programId: program!.id,
					number: 1,
					createdBy: 'rules',
					summary: 'Your first program',
					startsOn: '2026-11-09',
					firstPlannedDay: '2026-11-09'
				})
				.returning();
			const { thread } = await startOwnerTurn(ownerId, send('Week one?'), deps);
			await appendTurnStep(
				ownerId,
				thread.id,
				{
					runId: RUN,
					context: CONTEXT,
					assistant: { content: [answer('Good.')], display: { blocks: ['Good.'] } }
				},
				deps
			);

			const moved = await startSegment(
				ownerId,
				thread.id,
				{ promptVersion: 'pv-0000000000000002', programVersionId: version!.id },
				deps
			);
			expect(moved).toMatchObject({
				segment: 2,
				segmentPromptVersion: 'pv-0000000000000002',
				segmentProgramVersionId: version!.id
			});
			expect((await getTranscript(ownerId, thread.id, deps)).rows).toEqual([]);

			const next = await startOwnerTurn(ownerId, send('Week two?', { threadId: thread.id }), deps);
			expect(next.message.seq).toBe(4);
			const { thread: current, rows: transcript } = await getTranscript(ownerId, thread.id, deps);
			expect(current.segment).toBe(2);
			expect(transcript.map(({ id: _id, ...row }) => row)).toEqual([
				{ seq: 4, role: 'user', kind: 'owner_message', content: 'Week two?', runId: null }
			]);
			expect((await messagesOf(tx, thread.id)).map((m) => [m.seq, m.segment])).toEqual([
				[1, 1],
				[2, 1],
				[3, 1],
				[4, 2]
			]);
			const view = await getThreadView(ownerId, thread.id, {}, deps);
			expect(view.messages.map((m) => m.seq)).toEqual([1, 3, 4]);
		});
	});

	it('opens a conversation on its newest messages and pages back to the first', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const deps = { db: tx };
			const { thread } = await startOwnerTurn(ownerId, send('Message 1'), deps);
			const total = THREAD_VIEW_MESSAGES + 5;
			for (let i = 2; i <= total; i++) {
				await startOwnerTurn(ownerId, send(`Message ${i}`, { threadId: thread.id }), deps);
			}

			const newest = await getThreadView(ownerId, thread.id, {}, deps);
			expect(newest.messages.map((m) => m.seq)).toEqual(
				Array.from({ length: THREAD_VIEW_MESSAGES }, (_, i) => i + 6)
			);
			expect(newest.olderBefore).toBe(6);
			const older = await getThreadView(ownerId, thread.id, { before: newest.olderBefore! }, deps);
			expect(older.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
			expect(older.olderBefore).toBeNull();
		});
	});

	it('lists conversations newest first by keyset, archived ones only as archived', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const at = clock('2026-11-10T07:00:00Z');
			const deps = { db: tx, now: at.now };
			const ids: string[] = [];
			for (let i = 0; i < 5; i++) {
				at.advanceDays(1);
				ids.push((await startOwnerTurn(ownerId, send(`Thread ${i}`), deps)).thread.id);
			}
			// Two share a last message time: the id breaks the tie, and no page repeats or skips one.
			await tx
				.update(coachThreads)
				.set({
					lastMessageAt: sql`(select last_message_at from coach_threads where id = ${ids[3]})`
				})
				.where(eq(coachThreads.id, ids[2]!));

			const pages: string[][] = [];
			let before: string | undefined;
			do {
				const page = await listThreads(ownerId, { before, limit: 2 }, deps);
				pages.push(page.threads.map((t) => t.id));
				before = page.nextBefore ?? undefined;
			} while (before);
			const tie = [ids[2]!, ids[3]!].sort().reverse();
			expect(pages.flat()).toEqual([ids[4], ...tie, ids[1], ids[0]]);
			expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);

			// Archive two: they leave the open list and appear only in the archived one.
			at.advanceDays(1);
			const archived = await archiveThread(ownerId, ids[1]!, deps);
			expect(archived).toMatchObject({ archived: true, archivedAt: at.now() });
			at.advanceDays(1);
			await archiveThread(ownerId, ids[4]!, deps);
			expect((await listThreads(ownerId, {}, deps)).threads.map((t) => t.id)).toEqual([
				...tie,
				ids[0]
			]);
			const archivedList = await listThreads(ownerId, { archived: true, limit: 1 }, deps);
			expect(archivedList.threads.map((t) => t.id)).toEqual([ids[4]]);
			expect(
				(
					await listThreads(ownerId, { archived: true, before: archivedList.nextBefore! }, deps)
				).threads.map((t) => t.id)
			).toEqual([ids[1]]);
			// An open thread is no cursor for the archived list.
			expect(
				(await listThreads(ownerId, { archived: true, before: ids[0] }, deps)).threads
			).toEqual([]);

			// An archived conversation stays readable, takes no message, and archiving again is a no-op.
			const view = await getThreadView(ownerId, ids[1]!, {}, deps);
			expect(view.thread.archived).toBe(true);
			expect(view.messages).toHaveLength(1);
			const before2 = await rows(tx, ownerId);
			expect(
				await rejection(startOwnerTurn(ownerId, send('Hello?', { threadId: ids[1] }), deps))
			).toBeInstanceOf(CoachArchivedError);
			expect(await archiveThread(ownerId, ids[1]!, deps)).toMatchObject({
				archivedAt: archived.archivedAt
			});
			expect(await rows(tx, ownerId)).toEqual(before2);

			// Unarchive restores it to the open list, in its place, open for messages again.
			expect(await unarchiveThread(ownerId, ids[1]!, deps)).toMatchObject({
				archived: false,
				archivedAt: null
			});
			expect((await listThreads(ownerId, {}, deps)).threads.map((t) => t.id)).toEqual([
				...tie,
				ids[1],
				ids[0]
			]);
			expect(
				(await listThreads(ownerId, { archived: true }, deps)).threads.map((t) => t.id)
			).toEqual([ids[4]]);
			const resumed = await startOwnerTurn(ownerId, send('Hello?', { threadId: ids[1] }), deps);
			expect(resumed.message.seq).toBe(2);
		});
	});

	it('renames a conversation for good', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const deps = { db: tx };
			const { thread } = await startOwnerTurn(ownerId, send('How is my bench?'), deps);
			expect(await renameThread(ownerId, thread.id, '  Bench progress  ', deps)).toMatchObject({
				title: 'Bench progress',
				titleSource: 'owner'
			});
			const next = await startOwnerTurn(ownerId, send('More?', { threadId: thread.id }), deps);
			expect(next.thread.title).toBe('Bench progress');
		});
	});

	it('runs tools serially on a transaction and together on the pool', async () => {
		expect(toolRuntime().serialTools).toBe(false);
		expect(toolRuntime({ db: getDb() }).serialTools).toBe(false);
		await withRollback(async (tx) => {
			const runtime = toolRuntime({ db: tx });
			expect(runtime.serialTools).toBe(true);
			expect(runtime.deps.db).toBe(tx);
		});
	});

	it('finds no conversation of someone else, or none at all, and writes nothing', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const deps = { db: tx };
			const { thread } = await startOwnerTurn(ownerId, send('Mine'), deps);
			const before = await rows(tx, ownerId);
			const stranger = crypto.randomUUID();
			const step = { runId: RUN, context: CONTEXT, assistant: { content: [answer('Hi')] } };
			const partial = {
				runId: RUN,
				content: 'x',
				display: { text: 'x' },
				status: 'stopped' as const
			};
			const segment = { promptVersion: 'pv-2', programVersionId: null };

			for (const [who, id] of [
				[stranger, thread.id],
				[ownerId, crypto.randomUUID()],
				[ownerId, 'not-a-uuid']
			] as const) {
				const attempts: (() => Promise<unknown>)[] = [
					() => startOwnerTurn(who, send('Hi', { threadId: id }), deps),
					() => appendTurnStep(who, id, step, deps),
					() => appendDisplayOnly(who, id, partial, deps),
					() => getTranscript(who, id, deps),
					() => getThreadView(who, id, {}, deps),
					() => renameThread(who, id, 'Renamed', deps),
					() => archiveThread(who, id, deps),
					() => unarchiveThread(who, id, deps),
					() => startSegment(who, id, segment, deps)
				];
				for (const attempt of attempts) {
					expect(await rejection(attempt())).toBeInstanceOf(CoachNotFoundError);
				}
			}
			expect((await listThreads(stranger, {}, deps)).threads).toEqual([]);
			expect(await rows(tx, ownerId)).toEqual(before);
			expect((await getThreadView(ownerId, thread.id, {}, deps)).thread.title).toBe('Mine');
		});
	});

	it('enforces every bound before writing', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const deps = { db: tx };
			const { thread } = await startOwnerTurn(ownerId, send('Mine'), deps);
			const before = await rows(tx, ownerId);
			const field = async (promise: Promise<unknown>) => {
				const err = await rejection(promise);
				expect(err).toBeInstanceOf(CoachInputError);
				return (err as CoachInputError).field;
			};

			expect(await field(startOwnerTurn(ownerId, send('   '), deps))).toBe('text');
			expect(await field(startOwnerTurn(ownerId, send('x'.repeat(4_001)), deps))).toBe('text');
			expect(await startOwnerTurn(ownerId, send('💪'.repeat(4_000)), deps)).toMatchObject({
				duplicate: false
			});
			expect(
				await field(startOwnerTurn(ownerId, send('Hi', { clientMessageId: 'abc' }), deps))
			).toBe('clientMessageId');
			expect(
				await field(
					startOwnerTurn(ownerId, send('Hi', { segment: { ...SEGMENT, promptVersion: ' ' } }), deps)
				)
			).toBe('promptVersion');
			expect(
				await field(
					startOwnerTurn(
						ownerId,
						send('Hi', { segment: { ...SEGMENT, programVersionId: 'v1' } }),
						deps
					)
				)
			).toBe('programVersionId');
			for (const limit of [0, THREAD_PAGE.max + 1, 1.5]) {
				expect(await field(listThreads(ownerId, { limit }, deps))).toBe('limit');
			}
			expect((await listThreads(ownerId, { limit: THREAD_PAGE.max }, deps)).threads).toHaveLength(
				2
			);
			expect(await field(listThreads(ownerId, { before: 'nope' }, deps))).toBe('before');
			expect(await field(getThreadView(ownerId, thread.id, { before: 0 }, deps))).toBe('before');
			expect(await field(renameThread(ownerId, thread.id, '  ', deps))).toBe('title');
			expect(await field(renameThread(ownerId, thread.id, 'x'.repeat(121), deps))).toBe('title');
			expect(await renameThread(ownerId, thread.id, '💪'.repeat(120), deps)).toMatchObject({
				titleSource: 'owner'
			});
			expect(
				await field(
					startSegment(ownerId, thread.id, { promptVersion: '', programVersionId: null }, deps)
				)
			).toBe('promptVersion');
			expect(await rows(tx, ownerId)).toEqual({
				...before,
				threads: before.threads + 1,
				messages: before.messages + 1
			});
		});
	});

	it('has the index each read builder is shaped for', async () => {
		const names = Object.values(COACH_THREAD_INDEXES).flatMap((v) =>
			typeof v === 'string' ? [v] : Object.values(v)
		);
		const { rows: found } = await getDb().execute<{ indexname: string }>(
			sql`select indexname from pg_indexes where tablename in ('coach_threads', 'coach_messages')`
		);
		const existing = new Set(found.map((r) => r.indexname));
		for (const name of names) expect(existing, name).toContain(name);
	});
});
