/**
 * Coach conversations and runs on real Postgres (the M5 plan's coach-conversations-db):
 * - A thread, its transcript, a run and its model and tool calls round-trip, with their defaults.
 * - Message content is `json`, so it comes back as the exact text it was stored as, where jsonb
 *   would reorder its keys.
 * - Every CHECK refuses by name; seq is unique per thread and client_message_id once overall.
 * - Messages, model calls and tool calls are insert-only. A thread is renamed, archived,
 *   unarchived and moved forward one segment at a time, its segment's prompt and program versions
 *   changing only with the move. A run changes only while running, and its usage only grows.
 * - One running run per thread. DELETE is refused everywhere, so deleting the owner is refused;
 *   the test cleanup's TRUNCATE clears every table.
 * Refusals are pinned to their SQLSTATE, table and constraint.
 */
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	agentModelCalls,
	agentRuns,
	agentToolCalls,
	coachMessages,
	coachThreads,
	getDb,
	MESSAGE_KIND_ROLE,
	programs,
	programVersions,
	TOOL_CALL_JSON_MAX_BYTES,
	type Executor,
	type ThreadEntry
} from '../../../src/lib/server/db';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

type PgError = { code?: string; table?: string; constraint?: string; column?: string };
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
		const { code, table, constraint, column } = ((err as { cause?: PgError }).cause ??
			err) as PgError;
		return column ? { code, table, column } : { code, table, constraint };
	}
	throw new Error('unreachable');
}

const CHECK = '23514';
const UNIQUE = '23505';
const NOT_NULL = '23502';
const GUARD = '23001';
const refused = (code: string, table: string, constraint: string) => ({ code, table, constraint });
const ck = (table: string, name: string) => refused(CHECK, table, `${table}_${name}_ck`);
const deleteRefused = (table: string) => refused(GUARD, table, 'history_refuse_delete');

const CONVERSATION_TABLES = [
	'coach_threads',
	'coach_messages',
	'agent_runs',
	'agent_model_calls',
	'agent_tool_calls'
];

const MONDAY = '2026-11-09';
const STARTED = new Date('2026-11-10T07:42:13.250Z');

type NewThread = typeof coachThreads.$inferInsert;
type NewMessage = typeof coachMessages.$inferInsert;
type NewRun = typeof agentRuns.$inferInsert;
type NewModelCall = typeof agentModelCalls.$inferInsert;
type NewToolCall = typeof agentToolCalls.$inferInsert;

/**
 * An owner with a two-version program, a thread on version 1 and its first owner message; with
 * `program: false`, no program (whose own guards would refuse deleting the owner) and a thread on
 * none.
 */
async function setup(db: Executor, { program: withProgram = true } = {}) {
	const ownerId = await makeOwner(db);
	const [program] = withProgram
		? await db.insert(programs).values({ ownerId, title: 'Fight camp' }).returning()
		: [];
	const version = async (number: number, parentVersionId: string | null) => {
		if (!program) return null;
		const [row] = await db
			.insert(programVersions)
			.values({
				programId: program!.id,
				number,
				parentVersionId,
				createdBy: number === 1 ? 'rules' : 'coach',
				summary: number === 1 ? 'Your first program' : 'Friday is a rest day',
				startsOn: MONDAY,
				firstPlannedDay: MONDAY
			})
			.returning();
		return row!.id;
	};
	const v1 = await version(1, null);
	const v2 = await version(2, v1);
	if (withProgram && !(v1 && v2)) throw new Error('setup: no program versions');

	const thread = (values: Partial<NewThread> = {}): NewThread => ({
		ownerId,
		title: 'How has my bench progressed?',
		titleSource: 'first_message',
		segmentPromptVersion: 'prompt-1',
		segmentProgramVersionId: v1,
		...values
	});
	const [stored] = await db.insert(coachThreads).values(thread()).returning();
	const threadId = stored!.id;

	let nextSeq = 1;
	const message = (values: Partial<NewMessage> = {}): NewMessage => ({
		ownerId,
		threadId,
		seq: nextSeq++,
		segment: 1,
		role: 'user',
		kind: 'owner_message',
		apiVisible: true,
		content: 'How has my bench progressed?',
		display: { text: 'How has my bench progressed?' },
		clientMessageId: crypto.randomUUID(),
		...values
	});
	const [owner] = await db.insert(coachMessages).values(message()).returning();

	const run = (values: Partial<NewRun> = {}): NewRun => ({
		ownerId,
		threadId,
		triggerMessageId: owner!.id,
		kind: 'turn',
		provider: 'mock',
		model: 'claude-opus-5-5',
		effort: 'medium',
		promptVersion: 'prompt-1',
		...values
	});
	const modelCall = (runId: string, values: Partial<NewModelCall> = {}): NewModelCall => ({
		ownerId,
		runId,
		callIndex: 0,
		capCostMicros: 1_234,
		latencyMs: 900,
		...values
	});
	const toolCall = (runId: string, values: Partial<NewToolCall> = {}): NewToolCall => ({
		ownerId,
		runId,
		callIndex: 0,
		toolUseId: 'toolu_01',
		name: 'get_exercise_history',
		status: 'succeeded',
		input: { exercise: 'bench_press' },
		output: { items: [] },
		startedAt: STARTED,
		durationMs: 42,
		...values
	});
	return {
		ownerId,
		v1,
		v2,
		threadId,
		ownerMessageId: owner!.id,
		thread,
		message,
		run,
		modelCall,
		toolCall
	};
}

/** A running run on the setup's thread. */
async function startRun(
	db: Executor,
	s: Awaited<ReturnType<typeof setup>>,
	values: Partial<NewRun> = {}
) {
	const [row] = await db.insert(agentRuns).values(s.run(values)).returning();
	return row!;
}

const threadRow = async (db: Executor, id: string) =>
	(await db.select().from(coachThreads).where(eq(coachThreads.id, id)))[0]!;

describe('coach conversations', () => {
	it('round-trip a thread, its messages, a run and its model and tool calls, with defaults', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			expect(await threadRow(tx, s.threadId)).toMatchObject({
				ownerId: s.ownerId,
				title: 'How has my bench progressed?',
				titleSource: 'first_message',
				entry: null,
				segment: 1,
				segmentPromptVersion: 'prompt-1',
				segmentProgramVersionId: s.v1,
				archivedAt: null
			});
			const entry = {
				from: 'workout',
				ref: { type: 'exercise', id: 'bench_press', label: 'Bench' }
			} satisfies ThreadEntry;
			const [entered] = await tx
				.insert(coachThreads)
				.values(s.thread({ entry, segmentProgramVersionId: null }))
				.returning();
			expect(entered).toMatchObject({ entry, segmentProgramVersionId: null });

			const run = await startRun(tx, s);
			expect(run).toMatchObject({
				status: 'running',
				servedModel: null,
				modelCalls: 0,
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costMicros: 0,
				capCostMicros: 0,
				cancelRequestedAt: null,
				finishedAt: null
			});

			const [assistant] = await tx
				.insert(coachMessages)
				.values(
					s.message({
						role: 'assistant',
						kind: 'assistant',
						content: [{ type: 'text', text: 'Up 5 kg in a month.' }],
						display: { blocks: [{ kind: 'fact', text: 'Up 5 kg in a month.' }] },
						clientMessageId: null,
						runId: run.id
					})
				)
				.returning();
			expect(assistant).toMatchObject({
				seq: 2,
				status: 'complete',
				content: [{ type: 'text', text: 'Up 5 kg in a month.' }],
				runId: run.id
			});

			// Tokens beyond 2^31 fit: they are bigint.
			const [call] = await tx
				.insert(agentModelCalls)
				.values(
					s.modelCall(run.id, {
						requestId: 'req_01',
						model: 'claude-opus-5-5',
						stopReason: 'tool_use',
						inputTokens: 3_000_000_000,
						outputTokens: 512,
						cacheReadTokens: 2_048,
						cacheWriteTokens: 128,
						costMicros: 12_000_010_880,
						capCostMicros: 12_000_010_880,
						ttftMs: 640
					})
				)
				.returning();
			expect(call).toMatchObject({ inputTokens: 3_000_000_000, costMicros: 12_000_010_880 });
			// An unpriced model: no cost, but a cap cost.
			const [unpriced] = await tx
				.insert(agentModelCalls)
				.values(s.modelCall(run.id, { callIndex: 1, model: 'claude-next', costMicros: null }))
				.returning();
			expect(unpriced).toMatchObject({ costMicros: null, capCostMicros: 1_234 });

			const [tool] = await tx.insert(agentToolCalls).values(s.toolCall(run.id)).returning();
			expect(tool).toMatchObject({
				input: { exercise: 'bench_press' },
				output: { items: [] },
				errorCode: null,
				truncated: false,
				proposalId: null,
				startedAt: STARTED
			});
		});
	});

	it('keep message content as the exact text stored, where jsonb would reorder its keys', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			// Spacing, key order and an escape, as the API sent them.
			const exact =
				'[{"type":"thinking","thinking":"","signature":"EqQBCkYIARgC\\u002b=="},  {"type":"tool_use","name":"get_exercise_history","input":{"z":1,"a":{"y":2,"b":3}},"id":"toolu_01"}]';
			const { rows } = await tx.execute<{ id: string }>(
				sql`insert into coach_messages (owner_id, thread_id, seq, segment, role, kind, api_visible, content)
					values (${s.ownerId}, ${s.threadId}, 9, 1, 'assistant', 'assistant', true, ${exact}::json)
					returning id`
			);
			const id = rows[0]!.id;
			const { rows: read } = await tx.execute<{ text: string; reordered: string }>(
				sql`select content::text as text, content::jsonb::text as reordered
					from coach_messages where id = ${id}`
			);
			expect(read[0]!.text).toBe(exact);
			expect(read[0]!.reordered).not.toBe(exact);

			// Through Drizzle: what is written is JSON.stringify's text, and keys keep their order.
			const blocks = [{ type: 'tool_use', name: 'x', input: { z: 1, a: 2 }, id: 'toolu_02' }];
			const [written] = await tx
				.insert(coachMessages)
				.values(
					s.message({
						role: 'assistant',
						kind: 'assistant',
						clientMessageId: null,
						content: blocks
					})
				)
				.returning({ id: coachMessages.id });
			const { rows: text } = await tx.execute<{ text: string }>(
				sql`select content::text as text from coach_messages where id = ${written!.id}`
			);
			expect(text[0]!.text).toBe(JSON.stringify(blocks));
			const [back] = await tx
				.select({ content: coachMessages.content })
				.from(coachMessages)
				.where(eq(coachMessages.id, written!.id));
			expect(JSON.stringify(back!.content)).toBe(JSON.stringify(blocks));
		});
	});

	it('refuse every thread and message CHECK by name', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const thread = (values: Partial<NewThread>) => (db: Executor) =>
				db.insert(coachThreads).values(s.thread(values));
			expect(await attempt(tx, thread({ title: 'x'.repeat(120) }))).toBeNull();
			expect(await attempt(tx, thread({ title: 'x'.repeat(121) }))).toEqual(
				ck('coach_threads', 'title')
			);
			expect(await attempt(tx, thread({ title: '' }))).toEqual(ck('coach_threads', 'title'));
			expect(await attempt(tx, thread({ titleSource: 'owner' }))).toBeNull();
			expect(await attempt(tx, thread({ titleSource: 'model' as never }))).toEqual(
				ck('coach_threads', 'title_source')
			);
			expect(await attempt(tx, thread({ segment: 0 }))).toEqual(ck('coach_threads', 'segment'));
			expect(await attempt(tx, thread({ segmentPromptVersion: '' }))).toEqual(
				ck('coach_threads', 'prompt_version')
			);

			const message = (values: Partial<NewMessage>) => (db: Executor) =>
				db.insert(coachMessages).values(s.message(values));
			const msg = (name: string) => ck('coach_messages', name);
			// Each kind with its role is accepted; a kind with another role is not.
			for (const [kind, role] of Object.entries(MESSAGE_KIND_ROLE)) {
				const values = {
					kind: kind as NewMessage['kind'],
					role,
					apiVisible: kind !== 'display_only',
					clientMessageId: kind === 'owner_message' ? crypto.randomUUID() : null
				};
				expect(await attempt(tx, message(values)), kind).toBeNull();
				const other = role === 'user' ? 'assistant' : 'user';
				expect(await attempt(tx, message({ ...values, role: other })), kind).toEqual(
					msg('role_kind')
				);
			}
			expect(await attempt(tx, message({ seq: 0 }))).toEqual(msg('seq'));
			expect(await attempt(tx, message({ segment: 0 }))).toEqual(msg('seq'));
			expect(await attempt(tx, message({ role: 'tool' as never }))).toEqual(msg('role'));
			expect(
				await attempt(tx, message({ kind: 'summary' as never, clientMessageId: null }))
			).toEqual(msg('kind'));
			expect(await attempt(tx, message({ apiVisible: false }))).toEqual(msg('api_visible'));
			expect(
				await attempt(
					tx,
					message({
						kind: 'display_only',
						role: 'assistant',
						apiVisible: true,
						clientMessageId: null
					})
				)
			).toEqual(msg('api_visible'));
			expect(await attempt(tx, message({ status: 'pending' as never }))).toEqual(msg('status'));
			for (const status of ['complete', 'stopped', 'interrupted', 'failed'] as const) {
				expect(await attempt(tx, message({ status })), status).toBeNull();
			}
			expect(
				await attempt(
					tx,
					message({ kind: 'assistant', role: 'assistant', clientMessageId: crypto.randomUUID() })
				)
			).toEqual(msg('client_message'));
		});
	});

	it('refuse a duplicate seq in a thread and a duplicate client message id anywhere', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const [other] = await tx.insert(coachThreads).values(s.thread()).returning();
			const clientMessageId = crypto.randomUUID();
			await tx.insert(coachMessages).values(s.message({ seq: 5, clientMessageId }));
			expect(
				await attempt(tx, (db) => db.insert(coachMessages).values(s.message({ seq: 5 })))
			).toEqual(refused(UNIQUE, 'coach_messages', 'coach_messages_thread_seq_uq'));
			expect(
				await attempt(tx, (db) =>
					db.insert(coachMessages).values(s.message({ threadId: other!.id, seq: 5 }))
				)
			).toBeNull();
			expect(
				await attempt(tx, (db) =>
					db
						.insert(coachMessages)
						.values(s.message({ threadId: other!.id, seq: 1, clientMessageId }))
				)
			).toEqual(refused(UNIQUE, 'coach_messages', 'coach_messages_client_message_uq'));
		});
	});

	it('never update or delete a message', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const id = s.ownerMessageId;
			const update = (values: Partial<NewMessage>) => (db: Executor) =>
				db.update(coachMessages).set(values).where(eq(coachMessages.id, id));
			const insertOnly = refused(GUARD, 'coach_messages', 'coach_insert_only');
			expect(await attempt(tx, update({ content: 'Edited' }))).toEqual(insertOnly);
			expect(await attempt(tx, update({ status: 'failed' }))).toEqual(insertOnly);
			// Even a statement that changes nothing.
			expect(await attempt(tx, update({ seq: 1 }))).toEqual(insertOnly);
			expect(
				await attempt(tx, (db) => db.delete(coachMessages).where(eq(coachMessages.id, id)))
			).toEqual(deleteRefused('coach_messages'));
		});
	});
});

describe('the thread guard', () => {
	it('allows a rename, archive and unarchive, and a forward last message time', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const before = await threadRow(tx, s.threadId);
			const set = (values: Partial<NewThread>) =>
				tx.update(coachThreads).set(values).where(eq(coachThreads.id, s.threadId));
			await set({ title: 'Bench progress', titleSource: 'owner' });
			await set({ archivedAt: new Date('2026-11-11T08:00:00Z') });
			await set({ archivedAt: null });
			await set({ lastMessageAt: new Date(before.lastMessageAt.getTime() + 60_000) });
			const after = await threadRow(tx, s.threadId);
			expect(after).toMatchObject({
				title: 'Bench progress',
				titleSource: 'owner',
				archivedAt: null
			});
			// updated_at is stamped by the touch trigger.
			expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
			const { rows } = await tx.execute<{ moved: boolean }>(
				sql`select updated_at > created_at as moved from coach_threads where id = ${s.threadId}`
			);
			expect(rows[0]!.moved).toBe(true);
		});
	});

	it('moves the segment forward one at a time, and its versions only with the move', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const update = (values: Partial<NewThread>) => (db: Executor) =>
				db.update(coachThreads).set(values).where(eq(coachThreads.id, s.threadId));
			const guard = refused(GUARD, 'coach_threads', 'coach_thread_guard');

			// Within a segment, neither version changes.
			expect(await attempt(tx, update({ segmentProgramVersionId: s.v2 }))).toEqual(guard);
			expect(await attempt(tx, update({ segmentProgramVersionId: null }))).toEqual(guard);
			expect(await attempt(tx, update({ segmentPromptVersion: 'prompt-2' }))).toEqual(guard);
			// Not skipping ahead, and never back.
			expect(await attempt(tx, update({ segment: 3 }))).toEqual(guard);
			expect(await attempt(tx, update({ segment: 2 }))).toBeNull();

			await tx
				.update(coachThreads)
				.set({ segment: 2, segmentPromptVersion: 'prompt-2', segmentProgramVersionId: s.v2 })
				.where(eq(coachThreads.id, s.threadId));
			expect(await threadRow(tx, s.threadId)).toMatchObject({
				segment: 2,
				segmentPromptVersion: 'prompt-2',
				segmentProgramVersionId: s.v2
			});
			expect(await attempt(tx, update({ segment: 1 }))).toEqual(guard);
			expect(await attempt(tx, update({ segment: 2, segmentPromptVersion: 'prompt-1' }))).toEqual(
				guard
			);
		});
	});

	it('refuses any other change, a backward last message time and a DELETE', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const before = await threadRow(tx, s.threadId);
			const update = (values: Partial<NewThread>) => (db: Executor) =>
				db.update(coachThreads).set(values).where(eq(coachThreads.id, s.threadId));
			const guard = refused(GUARD, 'coach_threads', 'coach_thread_guard');
			expect(await attempt(tx, update({ entry: { from: 'today', ref: null } }))).toEqual(guard);
			expect(await attempt(tx, update({ ownerId: crypto.randomUUID() }))).toEqual(guard);
			expect(await attempt(tx, update({ createdAt: new Date('2026-01-01T00:00:00Z') }))).toEqual(
				guard
			);
			expect(
				await attempt(
					tx,
					update({ lastMessageAt: new Date(before.lastMessageAt.getTime() - 1_000) })
				)
			).toEqual(guard);
			expect(
				await attempt(tx, (db) => db.delete(coachThreads).where(eq(coachThreads.id, s.threadId)))
			).toEqual(deleteRefused('coach_threads'));
		});
	});
});

describe('agent runs', () => {
	it('refuse every CHECK by name, negative usage and a null cap cost', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const [thread] = await tx.insert(coachThreads).values(s.thread()).returning();
			// Each attempt runs on its own thread's slot: finished runs never hold it.
			const run = (values: Partial<NewRun>) => (db: Executor) =>
				db.insert(agentRuns).values(s.run({ threadId: thread!.id, ...values }));
			const runCk = (name: string) => ck('agent_runs', name);
			const done = { status: 'completed' as const, finishedAt: STARTED };

			expect(await attempt(tx, run({ status: 'paused' as never, finishedAt: STARTED }))).toEqual(
				runCk('status')
			);
			expect(await attempt(tx, run({ finishedAt: STARTED }))).toEqual(runCk('finished'));
			expect(await attempt(tx, run({ status: 'completed' }))).toEqual(runCk('finished'));
			for (const column of [
				'inputTokens',
				'outputTokens',
				'cacheReadTokens',
				'cacheWriteTokens',
				'costMicros',
				'capCostMicros',
				'ttftMs',
				'latencyMs',
				'modelCalls',
				'toolCalls'
			] as const) {
				expect(await attempt(tx, run({ ...done, [column]: -1 })), column).toEqual(runCk('usage'));
			}
			// An unpriced run: no cost, but never no cap cost.
			expect(await attempt(tx, run({ ...done, costMicros: null }))).toBeNull();
			expect(await attempt(tx, run({ ...done, capCostMicros: null as never }))).toEqual({
				code: NOT_NULL,
				table: 'agent_runs',
				column: 'cap_cost_micros'
			});
			for (const column of ['kind', 'provider', 'model', 'effort', 'promptVersion'] as const) {
				expect(await attempt(tx, run({ ...done, [column]: '' })), column).toEqual(runCk('text'));
			}

			const started = await startRun(tx, s);
			const call = (values: Partial<NewModelCall>) => (db: Executor) =>
				db.insert(agentModelCalls).values(s.modelCall(started.id, values));
			for (const column of [
				'inputTokens',
				'outputTokens',
				'cacheReadTokens',
				'cacheWriteTokens',
				'costMicros',
				'capCostMicros',
				'ttftMs',
				'latencyMs',
				'callIndex'
			] as const) {
				expect(await attempt(tx, call({ [column]: -1 })), column).toEqual(
					ck('agent_model_calls', 'usage')
				);
			}
			expect(await attempt(tx, call({ capCostMicros: null as never }))).toEqual({
				code: NOT_NULL,
				table: 'agent_model_calls',
				column: 'cap_cost_micros'
			});
			await tx.insert(agentModelCalls).values(s.modelCall(started.id));
			expect(await attempt(tx, call({}))).toEqual(
				refused(UNIQUE, 'agent_model_calls', 'agent_model_calls_run_call_uq')
			);

			const tool = (values: Partial<NewToolCall>) => (db: Executor) =>
				db.insert(agentToolCalls).values(s.toolCall(started.id, values));
			const toolCk = (name: string) => ck('agent_tool_calls', name);
			expect(await attempt(tx, tool({ status: 'ok' as never }))).toEqual(toolCk('status'));
			for (const status of [
				'failed',
				'invalid_input',
				'timed_out',
				'cancelled',
				'intervened'
			] as const) {
				expect(
					await attempt(tx, tool({ status, output: null, errorCode: 'X' })),
					status
				).toBeNull();
			}
			// jsonb renders `{"text": "…"}`: 12 bytes around the string.
			const fits = { text: 'x'.repeat(TOOL_CALL_JSON_MAX_BYTES - 12) };
			const over = { text: 'x'.repeat(TOOL_CALL_JSON_MAX_BYTES - 11) };
			expect(await attempt(tx, tool({ input: fits, output: fits }))).toBeNull();
			expect(await attempt(tx, tool({ input: over }))).toEqual(toolCk('size'));
			expect(await attempt(tx, tool({ output: over }))).toEqual(toolCk('size'));
			expect(await attempt(tx, tool({ name: '' }))).toEqual(toolCk('text'));
			expect(await attempt(tx, tool({ toolUseId: '' }))).toEqual(toolCk('text'));
			expect(await attempt(tx, tool({ callIndex: -1 }))).toEqual(toolCk('numbers'));
			expect(await attempt(tx, tool({ durationMs: -1 }))).toEqual(toolCk('numbers'));
		});
	});

	it('hold one running run per thread', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const first = await startRun(tx, s);
			expect(await attempt(tx, (db) => db.insert(agentRuns).values(s.run()))).toEqual(
				refused(UNIQUE, 'agent_runs', 'agent_runs_thread_running_uq')
			);
			const [other] = await tx.insert(coachThreads).values(s.thread()).returning();
			expect(
				await attempt(tx, (db) => db.insert(agentRuns).values(s.run({ threadId: other!.id })))
			).toBeNull();
			await tx
				.update(agentRuns)
				.set({ status: 'cancelled', finishedAt: new Date() })
				.where(eq(agentRuns.id, first.id));
			expect(await attempt(tx, (db) => db.insert(agentRuns).values(s.run()))).toBeNull();
		});
	});

	it('change a run only while it runs, never its identity, and its usage only grows', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const run = await startRun(tx, s);
			const update = (values: Partial<NewRun>) => (db: Executor) =>
				db.update(agentRuns).set(values).where(eq(agentRuns.id, run.id));
			const guard = refused(GUARD, 'agent_runs', 'agent_run_guard');
			const grown = {
				modelCalls: 2,
				toolCalls: 1,
				inputTokens: 4_000,
				outputTokens: 300,
				cacheReadTokens: 2_000,
				cacheWriteTokens: 100,
				costMicros: 22_000,
				capCostMicros: 22_000
			};
			await tx
				.update(agentRuns)
				.set({ ...grown, servedModel: 'claude-opus-5-5' })
				.where(eq(agentRuns.id, run.id));

			for (const [column, value] of Object.entries(grown)) {
				expect(await attempt(tx, update({ [column]: value - 1 })), column).toEqual(guard);
			}
			expect(await attempt(tx, update({ model: 'claude-opus-5' }))).toEqual(guard);
			expect(await attempt(tx, update({ promptVersion: 'prompt-2' }))).toEqual(guard);
			expect(await attempt(tx, update({ startedAt: new Date() }))).toEqual(guard);
			expect(await attempt(tx, update({ triggerMessageId: crypto.randomUUID() }))).toEqual(guard);

			// Once unpriced, always unpriced.
			await tx.update(agentRuns).set({ costMicros: null }).where(eq(agentRuns.id, run.id));
			expect(await attempt(tx, update({ costMicros: 30_000 }))).toEqual(guard);

			// A cancel request is set once.
			await tx
				.update(agentRuns)
				.set({ cancelRequestedAt: STARTED })
				.where(eq(agentRuns.id, run.id));
			expect(await attempt(tx, update({ cancelRequestedAt: null }))).toEqual(guard);
			expect(await attempt(tx, update({ cancelRequestedAt: new Date() }))).toEqual(guard);

			// Finished once: then frozen, so a second finish is refused.
			await tx
				.update(agentRuns)
				.set({
					status: 'cancelled',
					stopReason: 'end_turn',
					latencyMs: 4_200,
					finishedAt: new Date()
				})
				.where(eq(agentRuns.id, run.id));
			expect(await attempt(tx, update({ status: 'completed' }))).toEqual(guard);
			expect(await attempt(tx, update({ capCostMicros: 99_000 }))).toEqual(guard);
			expect(
				await attempt(tx, (db) => db.delete(agentRuns).where(eq(agentRuns.id, run.id)))
			).toEqual(deleteRefused('agent_runs'));
		});
	});

	it('never update or delete a model or tool call', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx);
			const run = await startRun(tx, s);
			const [call] = await tx.insert(agentModelCalls).values(s.modelCall(run.id)).returning();
			const [tool] = await tx.insert(agentToolCalls).values(s.toolCall(run.id)).returning();
			expect(
				await attempt(tx, (db) =>
					db
						.update(agentModelCalls)
						.set({ capCostMicros: 0 })
						.where(eq(agentModelCalls.id, call!.id))
				)
			).toEqual(refused(GUARD, 'agent_model_calls', 'coach_insert_only'));
			expect(
				await attempt(tx, (db) =>
					db
						.update(agentToolCalls)
						.set({ proposalId: crypto.randomUUID() })
						.where(eq(agentToolCalls.id, tool!.id))
				)
			).toEqual(refused(GUARD, 'agent_tool_calls', 'coach_insert_only'));
			expect(
				await attempt(tx, (db) =>
					db.delete(agentModelCalls).where(eq(agentModelCalls.id, call!.id))
				)
			).toEqual(deleteRefused('agent_model_calls'));
			expect(
				await attempt(tx, (db) => db.delete(agentToolCalls).where(eq(agentToolCalls.id, tool!.id)))
			).toEqual(deleteRefused('agent_tool_calls'));
		});
	});
});

describe('the owner', () => {
	it('cannot be deleted once they have a conversation', async () => {
		await withRollback(async (tx) => {
			const s = await setup(tx, { program: false });
			const run = await startRun(tx, s);
			await tx.insert(agentModelCalls).values(s.modelCall(run.id));
			await tx.insert(agentToolCalls).values(s.toolCall(run.id));
			// The owner's ON DELETE CASCADE reaches the conversation, whose guards refuse it.
			const refusal = await attempt(tx, (db) =>
				db.execute(sql`delete from owners where id = ${s.ownerId}`)
			);
			expect(refusal).toMatchObject({ code: GUARD, constraint: 'history_refuse_delete' });
			expect(CONVERSATION_TABLES).toContain(refusal!.table);
		});
	});

	it('is cleared, with every conversation and run, by the test cleanup', async () => {
		const tables = CONVERSATION_TABLES;
		const counts = async () => {
			const out: Record<string, number> = {};
			for (const table of tables) {
				const { rows } = await getDb().execute<{ n: number }>(
					sql`select count(*)::int as n from ${sql.identifier(table)}`
				);
				out[table] = rows[0]!.n;
			}
			return out;
		};
		let during: Record<string, number> = {};
		await withCommitted(async (db) => {
			const s = await setup(db);
			const run = await startRun(db, s);
			await db.insert(agentModelCalls).values(s.modelCall(run.id));
			await db.insert(agentToolCalls).values(s.toolCall(run.id));
			during = await counts();
		});
		expect(Object.values(during).every((n) => n >= 1)).toBe(true);
		expect(await counts()).toEqual(Object.fromEntries(tables.map((t) => [t, 0])));
	});
});
