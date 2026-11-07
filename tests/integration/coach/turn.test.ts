/**
 * One coach turn on real Postgres (src/lib/server/agent/turn.ts), driven by the MockProvider:
 * - a turn stores its rows exactly (the preamble, the owner's message, the turn context with the
 *   first stored step, the steps, the answer) and a finished run with its calls and costs
 * - the next turn replays the stored segment byte for byte, so its prefix is cached, even across
 *   a program version created between turns, which only the new context message reports
 * - tools run one at a time on a transaction, and each step is stored with all its results
 * - Stop, a refusal, a provider fault, a retried send, a busy thread, a new prompt version, a
 *   missing provider and the daily cap each end the turn as they should
 * - every stored segment stays a request the API accepts (validateRequest)
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { addDays } from '../../../src/lib/domain/calendar';
import type { CoachEvent } from '../../../src/lib/domain/coach/events';
import type { MockScript } from '../../../src/lib/server/agent/provider/mock';
import { MockProvider } from '../../../src/lib/server/agent/provider/mock';
import type { LlmProvider } from '../../../src/lib/server/agent/provider/types';
import { defineTool, type CoachTool } from '../../../src/lib/server/agent/tools/define';
import {
	agentModelCalls,
	agentRuns,
	agentToolCalls,
	coachMessages,
	coachThreads,
	type Executor
} from '../../../src/lib/server/db';
import {
	finishRun,
	recordModelCall,
	requestCancel,
	startRun
} from '../../../src/lib/server/services/coach/runs';
import type { ResolvedCoachDeps } from '../../../src/lib/server/services/coach/shared';
import { startOwnerTurn } from '../../../src/lib/server/services/coach/threads';
import {
	createProgramFromPlan,
	getTrainingWeek,
	skipSession
} from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { recording, runScripted, segmentIssues, storedRows, TURN_NOW } from './harness';

const MONDAY = '2026-11-09';
const TODAY = addDays(MONDAY, 2);
const ANSWER = '[note] Keep the plan as it is this week.';

const answering = (text = ANSWER, name = 'answer'): MockScript => ({
	name,
	matches: () => true,
	steps: [{ text }]
});

const ready = (provider: LlmProvider) => ({ status: 'ready' as const, provider });
const types = (events: readonly CoachEvent[]) => [...new Set(events.map((event) => event.type))];
const kinds = (rows: readonly { kind: string }[]) => rows.map((row) => row.kind);
const errorOf = (events: readonly CoachEvent[]) => events.find((event) => event.type === 'error');

const runOf = async (db: Executor, id: string) =>
	(await db.select().from(agentRuns).where(eq(agentRuns.id, id)))[0]!;
const callsOf = (db: Executor, runId: string) =>
	db.select().from(agentModelCalls).where(eq(agentModelCalls.runId, runId));
const toolCallsOf = (db: Executor, runId: string) =>
	db.select().from(agentToolCalls).where(eq(agentToolCalls.runId, runId));

async function storeProgram(db: Executor, owner: string) {
	const plan = programFixture('hybrid', { monday: MONDAY, today: TODAY });
	return createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
}

/** Two tools that note how many run at once, each with a real query. */
function countingTools(seen: { inFlight: number; most: number }) {
	const tool = (name: 'get_current_program' | 'get_current_training_week') =>
		defineTool({
			name,
			description: `The ${name} tool, for the turn test.`,
			input: z.object({}),
			output: z.object({ weekStartsOn: z.nullable(z.string()) }),
			run: async (_input, ctx: Parameters<CoachTool<ResolvedCoachDeps>['run']>[1]) => {
				seen.inFlight += 1;
				seen.most = Math.max(seen.most, seen.inFlight);
				const week = await getTrainingWeek(
					ctx.ownerId,
					{ date: ctx.today },
					{},
					{ db: ctx.deps.db }
				);
				await new Promise((resolve) => setTimeout(resolve, 20));
				seen.inFlight -= 1;
				return { weekStartsOn: week?.startsOn ?? null };
			}
		}) as CoachTool<ResolvedCoachDeps>;
	return [tool('get_current_program'), tool('get_current_training_week')];
}

const toolScript: MockScript = {
	name: 'tools',
	matches: () => true,
	steps: [
		{
			tools: [
				{ name: 'get_current_program', input: {} },
				{ name: 'get_current_training_week', input: {} }
			]
		},
		{
			text: (ctx) =>
				`[note] Your week starts on ${String((ctx.result('get_current_training_week') as { weekStartsOn: string }).weekStartsOn)}.`
		}
	]
};

describe('runTurn', () => {
	it('stores a text turn in order and finishes its run with its cost and cap cost', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const turn = await runScripted(answering(), { db, owner });

			expect(turn.events[0]).toMatchObject({ type: 'run_started', threadId: turn.threadId });
			expect(types(turn.events)).toEqual([
				'run_started',
				'block_started',
				'text_delta',
				'block_completed',
				'answer_completed',
				'done'
			]);
			expect(turn.done).toEqual({ type: 'done', status: 'completed' });
			const rows = await storedRows(db, turn.threadId!);
			expect(kinds(rows)).toEqual(['segment_preamble', 'owner_message', 'context', 'assistant']);
			const answer = rows[3]!;
			expect(turn.events).toContainEqual({ type: 'answer_completed', messageId: answer.id });
			expect(answer.content).toEqual([{ type: 'text', text: ANSWER, citations: null }]);
			expect(answer.display).toMatchObject({ blocks: [{ block: 0, kind: 'note' }] });

			const run = await runOf(db, turn.runId!);
			expect(run).toMatchObject({ status: 'completed', modelCalls: 1, toolCalls: 0, error: null });
			expect(run.costMicros).toBeGreaterThan(0);
			expect(run.capCostMicros).toBe(run.costMicros);
			expect(await callsOf(db, turn.runId!)).toHaveLength(1);
			expect(await segmentIssues(db, owner, turn.threadId!)).toEqual([]);
		});
	});

	it('replays turn 1 byte for byte as turn 2’s prefix, and the mock reads it from the cache', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const provider = recording(new MockProvider([answering()], { overrides: () => ({}) }));
			const first = await runScripted(answering(), { db, owner, provider: ready(provider) });
			const second = await runScripted(answering(), {
				db,
				owner,
				provider: ready(provider),
				threadId: first.threadId,
				text: 'And next week?'
			});

			const [one, two] = provider.requests;
			expect(two!.messages).toHaveLength(one!.messages.length + 3);
			expect(JSON.stringify(two!.messages.slice(0, one!.messages.length))).toBe(
				JSON.stringify(one!.messages)
			);
			expect(JSON.stringify([two!.system, two!.tools])).toBe(
				JSON.stringify([one!.system, one!.tools])
			);
			const [call] = await callsOf(db, second.runId!);
			expect(call!.cacheReadTokens).toBeGreaterThan(0);
			expect(await segmentIssues(db, owner, first.threadId!)).toEqual([]);
		});
	});

	it('reports a version created between turns in turn 2’s context only, leaving the prefix as stored', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await storeProgram(db, owner);
			const provider = recording(new MockProvider([answering()], { overrides: () => ({}) }));
			const first = await runScripted(answering(), { db, owner, provider: ready(provider) });
			const week = (await getTrainingWeek(owner, { date: TODAY }, {}, { db }))!;
			const later = week.planned
				? week.days.flatMap((day) => day.sessions).find((s) => s.date > TODAY)!
				: null;
			await skipSession(
				owner,
				{ sessionLineage: later!.lineage, reason: 'Travelling' },
				{ version: 1, today: TODAY },
				{ db }
			);
			await runScripted(answering(), {
				db,
				owner,
				provider: ready(provider),
				threadId: first.threadId,
				text: 'What changed?'
			});

			const contexts = (await storedRows(db, first.threadId!)).filter((r) => r.kind === 'context');
			const weekOf = (row: { content: unknown }) =>
				JSON.parse(String(row.content).split('\n')[1]!).week as Record<string, unknown>;
			expect(weekOf(contexts[0]!)).toMatchObject({
				number: 1,
				versionNumber: 1,
				changedSinceSegmentStart: false
			});
			expect(weekOf(contexts[1]!)).toMatchObject({
				number: 1,
				versionNumber: 2,
				changedSinceSegmentStart: true
			});
			const skipped = { date: later!.date, title: { untrusted_text: later!.title } };
			expect(weekOf(contexts[0]!).remaining).toContainEqual(skipped);
			expect(weekOf(contexts[1]!).remaining).not.toContainEqual(skipped);
			const [one, two] = provider.requests;
			expect(JSON.stringify(two!.messages.slice(0, one!.messages.length))).toBe(
				JSON.stringify(one!.messages)
			);
		});
	});

	it('stores a tool step whole (thinking, tool_use, results) and runs its tools one at a time on a transaction', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await storeProgram(db, owner);
			const seen = { inFlight: 0, most: 0 };
			const turn = await runScripted(toolScript, { db, owner, tools: countingTools(seen) });

			expect(turn.done.status).toBe('completed');
			expect(seen.most).toBe(1);
			const rows = await storedRows(db, turn.threadId!);
			expect(kinds(rows)).toEqual([
				'segment_preamble',
				'owner_message',
				'context',
				'assistant',
				'tool_results',
				'assistant'
			]);
			const step = rows[3]!.content as { type: string; signature?: string; id?: string }[];
			expect(step.map((block) => block.type)).toEqual(['thinking', 'tool_use', 'tool_use']);
			expect(step[0]!.signature).toMatch(/^mock-signature-/);
			const results = rows[4]!.content as { tool_use_id: string; is_error?: boolean }[];
			expect(results.map((r) => r.tool_use_id)).toEqual([step[1]!.id, step[2]!.id]);
			expect(results.some((r) => r.is_error)).toBe(false);
			expect(JSON.stringify(rows[5]!.content)).toContain(MONDAY);

			const calls = await toolCallsOf(db, turn.runId!);
			expect(calls.map((c) => [c.name, c.status, c.callIndex]).sort()).toEqual([
				['get_current_program', 'succeeded', 0],
				['get_current_training_week', 'succeeded', 0]
			]);
			expect(await runOf(db, turn.runId!)).toMatchObject({ modelCalls: 2, toolCalls: 2 });
			const chips = turn.events.filter((e) => e.type === 'activity').map((e) => e.state);
			expect(chips).toEqual(['running', 'running', 'done', 'done']);
			expect(await segmentIssues(db, owner, turn.threadId!)).toEqual([]);
		});
	});

	it('stops mid-stream on Stop: the partial answer is shown only, and no context is stored', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const controller = new AbortController();
			const slow: MockScript = {
				name: 'slow',
				matches: () => true,
				steps: [{ text: `${ANSWER} ${'More detail follows here. '.repeat(8)}`, delayMs: 40 }]
			};
			let runId = '';
			const turn = await runScripted(slow, {
				db,
				owner,
				controller,
				// Stop: the flag, then the client drops the stream. The mock is between chunks, so the
				// transaction is idle while the flag is set.
				onEvent: async (event) => {
					if (event.type === 'run_started') runId = event.runId;
					if (event.type !== 'text_delta' || controller.signal.aborted) return;
					expect(await requestCancel(owner, runId, { db })).toBe(true);
					controller.abort();
				}
			});

			expect(turn.done.status).toBe('cancelled');
			expect(errorOf(turn.events)).toEqual({ type: 'error', kind: 'cancelled' });
			const rows = await storedRows(db, turn.threadId!);
			expect(kinds(rows)).toEqual(['segment_preamble', 'owner_message', 'display_only']);
			expect(rows[2]).toMatchObject({ status: 'stopped', apiVisible: false });
			expect(JSON.stringify(rows[2]!.content)).toContain('[note] Keep the');
			expect(await runOf(db, turn.runId!)).toMatchObject({ status: 'cancelled' });
			expect(await segmentIssues(db, owner, turn.threadId!)).toEqual([]);
		});
	});

	it('stops during tools: the step is stored with cancelled results, and nothing more is asked', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const controller = new AbortController();
			const stopping = defineTool({
				name: 'get_current_program',
				description: 'A tool during which the owner presses Stop.',
				input: z.object({}),
				output: z.object({}),
				run: async (_input, ctx: Parameters<CoachTool<ResolvedCoachDeps>['run']>[1]) => {
					await requestCancel(ctx.ownerId, ctx.runId, { db: ctx.deps.db });
					controller.abort();
					await new Promise((resolve) => setTimeout(resolve, 50));
					return {};
				}
			}) as CoachTool<ResolvedCoachDeps>;
			const script: MockScript = {
				...toolScript,
				steps: [{ tools: [{ name: 'get_current_program', input: {} }] }, { text: ANSWER }]
			};
			const turn = await runScripted(script, {
				db,
				owner,
				controller,
				tools: [stopping]
			});

			expect(turn.done.status).toBe('cancelled');
			const rows = await storedRows(db, turn.threadId!);
			expect(kinds(rows)).toEqual([
				'segment_preamble',
				'owner_message',
				'context',
				'assistant',
				'tool_results'
			]);
			const [result] = rows[4]!.content as { is_error?: boolean; content: string }[];
			expect(result).toMatchObject({ is_error: true });
			expect(JSON.parse(result!.content)).toMatchObject({ error: 'CANCELLED' });
			expect((await toolCallsOf(db, turn.runId!)).map((c) => c.status)).toEqual(['cancelled']);
			expect(await runOf(db, turn.runId!)).toMatchObject({ status: 'cancelled', modelCalls: 1 });
			expect(await segmentIssues(db, owner, turn.threadId!)).toEqual([]);
		});
	});

	it('ends a refused turn as refused, with its category on the call and nothing replayable stored', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const refusing: MockScript = {
				name: 'refusing',
				matches: () => true,
				steps: [{ text: 'I can’t', refusal: { category: 'bio', explanation: 'Declined' } }]
			};
			const turn = await runScripted(refusing, { db, owner });

			expect(turn.done.status).toBe('refused');
			expect(errorOf(turn.events)).toEqual({ type: 'error', kind: 'refused' });
			const [call] = await callsOf(db, turn.runId!);
			expect(call).toMatchObject({ stopReason: 'refusal', refusalCategory: 'bio' });
			const rows = await storedRows(db, turn.threadId!);
			expect(kinds(rows)).toEqual(['segment_preamble', 'owner_message', 'display_only']);
			expect(rows[2]).toMatchObject({ status: 'failed', apiVisible: false });
			expect(await runOf(db, turn.runId!)).toMatchObject({ status: 'refused' });
			expect(await segmentIssues(db, owner, turn.threadId!)).toEqual([]);
		});
	});

	it('fails an overloaded call as a provider error, recording the failed call', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const overloaded: MockScript = {
				name: 'overloaded',
				matches: () => true,
				steps: [{ fault: { kind: 'overloaded' } }]
			};
			const turn = await runScripted(overloaded, { db, owner });

			expect(turn.done.status).toBe('failed');
			expect(errorOf(turn.events)).toEqual({ type: 'error', kind: 'provider' });
			expect(await callsOf(db, turn.runId!)).toMatchObject([{ error: 'overloaded', model: null }]);
			expect(await runOf(db, turn.runId!)).toMatchObject({ status: 'failed', error: 'overloaded' });
			expect(kinds(await storedRows(db, turn.threadId!))).toEqual([
				'segment_preamble',
				'owner_message'
			]);
		});
	});

	it('answers a retried send from the stored answer, with no new run or model call', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const provider = recording(new MockProvider([answering()], { overrides: () => ({}) }));
			const clientMessageId = crypto.randomUUID();
			const first = await runScripted(answering(), {
				db,
				owner,
				clientMessageId,
				provider: ready(provider)
			});
			const before = await storedRows(db, first.threadId!);
			const retry = await runScripted(answering(), {
				db,
				owner,
				clientMessageId,
				provider: ready(provider)
			});

			expect(retry.events).toEqual([
				{ type: 'answer_completed', messageId: before.at(-1)!.id },
				{ type: 'done', status: 'completed' }
			]);
			expect(provider.requests).toHaveLength(1);
			expect(await storedRows(db, first.threadId!)).toEqual(before);
			expect(await db.select().from(agentRuns)).toHaveLength(1);
		});
	});

	it('runs a retried send again when its first run stored no answer', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const clientMessageId = crypto.randomUUID();
			const overloaded: MockScript = {
				name: 'overloaded',
				matches: () => true,
				steps: [{ fault: { kind: 'overloaded' } }]
			};
			const failed = await runScripted(overloaded, { db, owner, clientMessageId });
			const retry = await runScripted(answering(), { db, owner, clientMessageId });

			expect(retry.threadId).toBe(failed.threadId);
			expect(retry.done.status).toBe('completed');
			expect(kinds(await storedRows(db, failed.threadId!))).toEqual([
				'segment_preamble',
				'owner_message',
				'context',
				'assistant'
			]);
			expect(await segmentIssues(db, owner, failed.threadId!)).toEqual([]);
		});
	});

	it('runs a retried send on its stored text, not on the text the retry sent', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const clientMessageId = crypto.randomUUID();
			const seen: string[] = [];
			const reading = defineTool({
				name: 'get_current_program',
				description: 'A tool that notes the owner text it is given.',
				input: z.object({}),
				output: z.object({}),
				run: async (_input, ctx: Parameters<CoachTool<ResolvedCoachDeps>['run']>[1]) => {
					seen.push(ctx.ownerText);
					return {};
				}
			}) as CoachTool<ResolvedCoachDeps>;
			const overloaded: MockScript = {
				name: 'overloaded',
				matches: () => true,
				steps: [{ fault: { kind: 'overloaded' } }]
			};
			const text = 'How is my training?';
			await runScripted(overloaded, { db, owner, clientMessageId, text });
			const script: MockScript = {
				...toolScript,
				steps: [{ tools: [{ name: 'get_current_program', input: {} }] }, { text: ANSWER }]
			};
			const retry = await runScripted(script, {
				db,
				owner,
				clientMessageId,
				text: 'I dislike squats',
				tools: [reading]
			});

			expect(retry.done.status).toBe('completed');
			expect(seen).toEqual([text]);
		});
	});

	it('answers a retried send from its stored answer when newer messages fill the screen’s page', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const clientMessageId = crypto.randomUUID();
			const first = await runScripted(answering(), { db, owner, clientMessageId });
			const answer = (await storedRows(db, first.threadId!)).at(-1)!;
			// Each turn shows two rows: past THREAD_VIEW_MESSAGES, the first is on an older page.
			for (let n = 0; n < 16; n += 1)
				await runScripted(answering(), { db, owner, threadId: first.threadId });
			const retry = await runScripted(answering(), { db, owner, clientMessageId });

			expect(retry.events).toEqual([
				{ type: 'answer_completed', messageId: answer.id },
				{ type: 'done', status: 'completed' }
			]);
		});
	});

	it('refuses a send during a live tool turn as busy, storing nothing, and the turn completes', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			let calls = 0;
			let busy: Awaited<ReturnType<typeof runScripted>> | null = null;
			let during: Awaited<ReturnType<typeof storedRows>> = [];
			let afterBusy: typeof during = [];
			// The owner sends again while the turn's second tool step runs.
			const sending = defineTool({
				name: 'get_current_program',
				description: 'A tool during which the owner sends another message.',
				input: z.object({}),
				output: z.object({}),
				run: async (_input, ctx: Parameters<CoachTool<ResolvedCoachDeps>['run']>[1]) => {
					calls += 1;
					if (calls !== 2) return {};
					during = await storedRows(db, ctx.threadId);
					busy = await runScripted(answering(), { db, owner, threadId: ctx.threadId });
					afterBusy = await storedRows(db, ctx.threadId);
					return {};
				}
			}) as CoachTool<ResolvedCoachDeps>;
			const step = { tools: [{ name: 'get_current_program', input: {} }] };
			const script: MockScript = { ...toolScript, steps: [step, step, { text: ANSWER }] };
			const turn = await runScripted(script, { db, owner, tools: [sending] });

			expect(busy!.events).toEqual([
				{ type: 'error', kind: 'busy' },
				{ type: 'done', status: null }
			]);
			expect(during.length).toBeGreaterThan(0);
			expect(afterBusy).toEqual(during);
			expect(turn.done.status).toBe('completed');
			expect(
				kinds(await storedRows(db, turn.threadId!)).filter((k) => k === 'owner_message')
			).toEqual(['owner_message']);
			expect(await segmentIssues(db, owner, turn.threadId!)).toEqual([]);
		});
	});

	it('refuses a turn on a thread whose run is still live as busy, with no model call', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const first = await runScripted(answering(), { db, owner });
			const [message] = (await storedRows(db, first.threadId!)).filter(
				(row) => row.kind === 'owner_message'
			);
			const live = await startRun(
				owner,
				{
					threadId: first.threadId!,
					triggerMessageId: message!.id,
					kind: 'turn',
					provider: 'mock',
					model: 'claude-opus-5-5',
					effort: 'medium',
					promptVersion: 'pv-live'
				},
				{ db, now: () => new Date(TURN_NOW) }
			);
			const provider = recording(new MockProvider([answering()], { overrides: () => ({}) }));
			const busy = await runScripted(answering(), {
				db,
				owner,
				threadId: first.threadId,
				provider: ready(provider)
			});

			expect(busy.events).toEqual([
				{ type: 'error', kind: 'busy' },
				{ type: 'done', status: null }
			]);
			expect(provider.requests).toHaveLength(0);
			expect(await runOf(db, live.id)).toMatchObject({ status: 'running' });
		});
	});

	it('starts a new segment when the prompt version changed, replaying none of the old one', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const provider = recording(new MockProvider([toolScript], { overrides: () => ({}) }));
			const first = await runScripted(answering(), { db, owner, tools: [] });
			const seen = { inFlight: 0, most: 0 };
			const second = await runScripted(toolScript, {
				db,
				owner,
				threadId: first.threadId,
				tools: countingTools(seen),
				provider: ready(provider),
				text: 'Which week is it?'
			});

			expect(second.done.status).toBe('completed');
			const [thread] = await db
				.select()
				.from(coachThreads)
				.where(eq(coachThreads.id, first.threadId!));
			expect(thread).toMatchObject({ segment: 2 });
			expect(thread!.segmentPromptVersion).not.toBe((await runOf(db, first.runId!)).promptVersion);
			const rows = await storedRows(db, first.threadId!);
			expect(rows.filter((r) => r.segment === 2).map((r) => r.kind)).toEqual([
				'segment_preamble',
				'owner_message',
				'context',
				'assistant',
				'tool_results',
				'assistant'
			]);
			const opening = provider.requests[0]!.messages;
			expect(opening).toHaveLength(3);
			expect(JSON.stringify(opening)).not.toContain('How is my training going?');
			expect(await segmentIssues(db, owner, first.threadId!)).toEqual([]);
		});
	});

	it('without a provider stores the message and ends unavailable; switched off, it writes nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const noKey = await runScripted(answering(), {
				db,
				owner,
				provider: { status: 'unavailable', reason: 'no_key' }
			});
			expect(types(noKey.events)).toEqual(['run_started', 'error', 'done']);
			expect(errorOf(noKey.events)).toEqual({
				type: 'error',
				kind: 'unavailable',
				reason: 'no_key'
			});
			expect(await runOf(db, noKey.runId!)).toMatchObject({
				status: 'failed',
				error: 'unavailable',
				modelCalls: 0
			});
			expect(kinds(await storedRows(db, noKey.threadId!))).toEqual([
				'segment_preamble',
				'owner_message'
			]);

			const off = await runScripted(answering(), {
				db,
				owner,
				provider: { status: 'unavailable', reason: 'disabled' }
			});
			expect(off.events).toEqual([
				{ type: 'error', kind: 'unavailable', reason: 'disabled' },
				{ type: 'done', status: null }
			]);
			expect(await db.select().from(coachThreads)).toHaveLength(1);
			expect(await db.select().from(coachMessages)).toHaveLength(2);
		});
	});

	it('ends a turn at the daily cap as a budget error, before any model call', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const deps = { db, now: () => new Date(TURN_NOW) };
			const earlier = await startOwnerTurn(
				owner,
				{
					clientMessageId: crypto.randomUUID(),
					text: 'Plan my month',
					segment: { promptVersion: 'pv-earlier', programVersionId: null }
				},
				deps
			);
			const spent = await startRun(
				owner,
				{
					threadId: earlier.thread.id,
					triggerMessageId: earlier.message.id,
					kind: 'turn',
					provider: 'mock',
					model: 'claude-opus-5-5',
					effort: 'medium',
					promptVersion: 'pv-earlier'
				},
				deps
			);
			// 250K output tokens at $20 per million: exactly the $5 cap.
			const usage = {
				inputTokens: 0,
				outputTokens: 250_000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0
			};
			const call = { index: 0, requestId: null, model: 'claude-opus-5-5', stopReason: 'end_turn' };
			await recordModelCall(
				owner,
				spent.id,
				{ ...call, usage, ttftMs: 1, latencyMs: 1, error: null },
				deps
			);
			await finishRun(owner, spent.id, { status: 'completed' }, deps);
			const provider = recording(new MockProvider([answering()], { overrides: () => ({}) }));
			const turn = await runScripted(answering(), { db, owner, provider: ready(provider) });

			expect(types(turn.events)).toEqual(['run_started', 'error', 'done']);
			expect(errorOf(turn.events)).toEqual({ type: 'error', kind: 'budget' });
			expect(turn.done.status).toBe('budget_exhausted');
			expect(provider.requests).toHaveLength(0);
			expect(await runOf(db, turn.runId!)).toMatchObject({
				status: 'budget_exhausted',
				error: 'daily_cap',
				modelCalls: 0
			});
		});
	});
});
