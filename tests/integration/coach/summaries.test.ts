/**
 * Long conversations on real Postgres (src/lib/server/agent/rollover.ts, through runTurn): a
 * segment that reaches SEGMENT's message or token limit, or a new prompt version, becomes a
 * thread_summary note in its own run, and the turn's message opens a new segment.
 * - the next request replays none of the old segment (no old answer, no thinking block) and is a
 *   request the API accepts; the old segment's rows are left exactly as they were
 * - the new segment's preamble carries the summary, and the memory snapshot lists it
 * - within the new segment nothing rolls over again, and each request extends the previous one
 * - a change of prompt version rolls over however short the segment
 * - a summary that fails still rolls the segment over, with no summary and a failed chip
 * - the summary call's tokens and cost are recorded in a 'summary' run the daily cap counts
 */
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { SEGMENT } from '../../../src/lib/domain/coach/budgets';
import type { CoachEvent } from '../../../src/lib/domain/coach/events';
import { MEMORY_HEADER } from '../../../src/lib/server/agent/prompt/context';
import { MockProvider, type MockScript } from '../../../src/lib/server/agent/provider/mock';
import { summaryScripts } from '../../../src/lib/server/agent/provider/mock-scripts/summaries';
import type { LlmProvider } from '../../../src/lib/server/agent/provider/types';
import { validateRequest } from '../../../src/lib/server/agent/provider/validate';
import { DRAFT_CALL_INDEX_BASE } from '../../../src/lib/server/agent/turn';
import {
	agentModelCalls,
	agentRuns,
	coachNotes,
	coachThreads,
	type Executor
} from '../../../src/lib/server/db';
import { spentToday } from '../../../src/lib/server/services/coach/runs';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { recording, runScripted, segmentIssues, storedRows, TURN_NOW } from './harness';

const OLD_ANSWER = '[note] Keep going as planned.';
const NEW_ANSWER = '[note] Here is where things stand.';

/** Every turn's answer, with a thinking block first, as Opus 5.5 sends one. */
const answering = (text: string): MockScript => ({
	name: 'answer',
	matches: () => true,
	steps: [{ text, thinking: true }]
});

const ready = (provider: LlmProvider) => ({ status: 'ready' as const, provider });

/** A mock coach that summarises (summaries.ts first) and answers everything else with `text`. */
function coach(text: string, summary: readonly MockScript[] = summaryScripts) {
	const provider = recording(
		new MockProvider([...summary, answering(text)], { overrides: () => ({}) })
	);
	const summarise = provider.structured;
	let structured = 0;
	return Object.assign(provider, {
		structuredCalls: () => structured,
		structured: ((request, schema, signal) => {
			structured += 1;
			return summarise(request, schema, signal);
		}) as LlmProvider['structured']
	});
}

/** Owner messages and assistant rows: what SEGMENT.messages counts. */
const messageCount = (rows: readonly { kind: string }[]) =>
	rows.filter((row) => row.kind === 'owner_message' || row.kind === 'assistant').length;

/** Turns on one conversation (no tools, so one prompt version) until it holds `messages` messages. */
async function longThread(db: Executor, owner: string, messages: number = SEGMENT.messages) {
	const provider = coach(OLD_ANSWER);
	const first = await runScripted(answering(OLD_ANSWER), {
		db,
		owner,
		tools: [],
		provider: ready(provider),
		text: 'Old question 1'
	});
	const threadId = first.threadId!;
	for (let n = 2; messageCount(await storedRows(db, threadId)) < messages; n += 1)
		await runScripted(answering(OLD_ANSWER), {
			db,
			owner,
			threadId,
			tools: [],
			provider: ready(provider),
			text: `Old question ${n}`
		});
	expect(provider.structuredCalls()).toBe(0);
	return { threadId, firstRun: first.runId! };
}

const threadOf = async (db: Executor, id: string) =>
	(await db.select().from(coachThreads).where(eq(coachThreads.id, id)))[0]!;
const summaryRuns = (db: Executor, threadId: string) =>
	db
		.select()
		.from(agentRuns)
		.where(and(eq(agentRuns.threadId, threadId), eq(agentRuns.kind, 'summary')));
const chips = (events: readonly CoachEvent[]) =>
	events.filter((event) => event.type === 'activity');

/** The preamble's data: the memory snapshot and the previous segment's summary. */
function preambleData(content: unknown) {
	const text = (content as { text: string }[])[0]!.text;
	expect(text.startsWith(`${MEMORY_HEADER}\n`)).toBe(true);
	return JSON.parse(text.slice(MEMORY_HEADER.length + 1)) as {
		memory: unknown;
		previousSummary: { untrusted_text: string } | null;
	};
}

describe('thread summaries', () => {
	it('summarises a segment at its message limit and opens the next with the summary alone', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { threadId } = await longThread(db, owner);
			const before = await storedRows(db, threadId);
			expect(messageCount(before)).toBeGreaterThanOrEqual(SEGMENT.messages);

			const provider = coach(NEW_ANSWER);
			const turn = await runScripted(answering(NEW_ANSWER), {
				db,
				owner,
				threadId,
				tools: [],
				provider: ready(provider),
				text: 'Where do things stand?'
			});

			expect(turn.done.status).toBe('completed');
			expect(turn.events[0]?.type).toBe('run_started');
			expect(turn.events[1]).toEqual({
				type: 'activity',
				id: 'summary_1',
				tool: 'summary',
				state: 'done',
				label: 'Summarised our earlier messages'
			});
			expect(provider.structuredCalls()).toBe(1);
			expect(await threadOf(db, threadId)).toMatchObject({ segment: 2 });

			// Rows are never edited: the old segment is exactly as it was.
			const after = await storedRows(db, threadId);
			expect(after.filter((row) => row.segment === 1)).toEqual(before);
			expect(after.filter((row) => row.segment === 2).map((row) => row.kind)).toEqual([
				'segment_preamble',
				'owner_message',
				'context',
				'assistant'
			]);

			// The next request: the new preamble, the message and its context; nothing old.
			const request = provider.requests[0]!;
			expect(request.messages).toHaveLength(3);
			const sent = JSON.stringify(request.messages);
			expect(sent).not.toContain(OLD_ANSWER);
			expect(sent).not.toContain('"thinking"');
			expect(validateRequest(request)).toEqual([]);
			expect(await segmentIssues(db, owner, threadId)).toEqual([]);

			// The summary note, in the preamble and in the memory it carries.
			const [note] = await db.select().from(coachNotes).where(eq(coachNotes.ownerId, owner));
			expect(note).toMatchObject({ kind: 'thread_summary' });
			expect(note!.body).toMatchObject({ threadId, segment: 1 });
			expect(note!.summary).toContain('Old question 1');
			const data = preambleData(request.messages[0]!.content);
			expect(data.previousSummary?.untrusted_text).toContain(note!.summary);
			expect(JSON.stringify(data.memory)).toContain(note!.summary);
		});
	});

	it('records the summary call’s tokens and cost in a summary run the daily cap counts', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { threadId } = await longThread(db, owner);
			const spent = await spentToday(owner, { db, now: () => new Date(TURN_NOW) });
			await runScripted(answering(NEW_ANSWER), {
				db,
				owner,
				threadId,
				tools: [],
				provider: ready(coach(NEW_ANSWER))
			});

			const [run] = await summaryRuns(db, threadId);
			expect(run).toMatchObject({ status: 'completed', effort: 'low', modelCalls: 1 });
			const [call] = await db
				.select()
				.from(agentModelCalls)
				.where(eq(agentModelCalls.runId, run!.id));
			expect(call!.inputTokens + call!.cacheWriteTokens).toBeGreaterThan(0);
			expect(call!.outputTokens).toBeGreaterThan(0);
			expect(call!.costMicros).toBeGreaterThan(0);
			expect(run!.costMicros).toBe(call!.costMicros);
			const [note] = await db.select().from(coachNotes).where(eq(coachNotes.ownerId, owner));
			expect(note!.runId).toBe(run!.id);
			// The day's spend grew by the summary as well as by the turn.
			const now = await spentToday(owner, { db, now: () => new Date(TURN_NOW) });
			expect(now - spent).toBeGreaterThan(call!.capCostMicros);
		});
	});

	it('rolls over once: the new segment grows turn by turn, each request extending the last', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { threadId } = await longThread(db, owner);
			const provider = coach(NEW_ANSWER);
			for (const text of ['First new question', 'Second new question'])
				await runScripted(answering(NEW_ANSWER), {
					db,
					owner,
					threadId,
					tools: [],
					provider: ready(provider),
					text
				});

			expect(await threadOf(db, threadId)).toMatchObject({ segment: 2 });
			expect(await summaryRuns(db, threadId)).toHaveLength(1);
			expect(provider.structuredCalls()).toBe(1);
			const [first, second] = provider.requests;
			// The second request starts with the first's bytes, so its prefix is cached.
			expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages);
		});
	});

	it('rolls over when the last chat call’s prompt reached the token limit, drafts aside', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const provider = coach(OLD_ANSWER);
			const first = await runScripted(answering(OLD_ANSWER), {
				db,
				owner,
				tools: [],
				provider: ready(provider)
			});
			const threadId = first.threadId!;
			const call = {
				ownerId: owner,
				runId: first.runId!,
				model: 'claude-opus-5-5',
				inputTokens: 1_000,
				outputTokens: 10,
				cacheReadTokens: SEGMENT.inputTokens - 2_000,
				cacheWriteTokens: 500,
				costMicros: 1,
				capCostMicros: 1,
				latencyMs: 1,
				createdAt: new Date(TURN_NOW)
			};
			// A draft's prompt (numbered from DRAFT_CALL_INDEX_BASE) is not the conversation's.
			await db
				.insert(agentModelCalls)
				.values({ ...call, callIndex: DRAFT_CALL_INDEX_BASE, cacheWriteTokens: 1_000 });
			const second = await runScripted(answering(OLD_ANSWER), {
				db,
				owner,
				threadId,
				tools: [],
				provider: ready(provider)
			});
			expect(await threadOf(db, threadId)).toMatchObject({ segment: 1 });

			// The last turn's chat call sent the limit, cache reads and writes included.
			await db
				.insert(agentModelCalls)
				.values({ ...call, runId: second.runId!, callIndex: 1, cacheWriteTokens: 1_000 });
			const turn = await runScripted(answering(NEW_ANSWER), {
				db,
				owner,
				threadId,
				tools: [],
				provider: ready(provider)
			});

			expect(turn.done.status).toBe('completed');
			expect(chips(turn.events)).toMatchObject([{ state: 'done' }]);
			expect(await threadOf(db, threadId)).toMatchObject({ segment: 2 });
		});
	});

	it('rolls over on a new prompt version, however short the segment', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const provider = coach(NEW_ANSWER);
			const first = await runScripted(answering(OLD_ANSWER), {
				db,
				owner,
				tools: [],
				provider: ready(provider),
				text: 'Old question 1'
			});
			// The registry's tools: another prompt version.
			const turn = await runScripted(answering(NEW_ANSWER), {
				db,
				owner,
				threadId: first.threadId,
				provider: ready(provider)
			});

			expect(turn.done.status).toBe('completed');
			expect(chips(turn.events)).toMatchObject([{ id: 'summary_1', state: 'done' }]);
			const thread = await threadOf(db, first.threadId!);
			expect(thread.segment).toBe(2);
			expect(thread.segmentPromptVersion).toBe(
				(await db.select().from(agentRuns).where(eq(agentRuns.id, turn.runId!)))[0]!.promptVersion
			);
			const [run] = await summaryRuns(db, first.threadId!);
			// The summary run is recorded on the version of the segment it closed.
			expect(run!.promptVersion).toBe(
				(await db.select().from(agentRuns).where(eq(agentRuns.id, first.runId!)))[0]!.promptVersion
			);
			const data = preambleData(provider.requests.at(-1)!.messages[0]!.content);
			expect(data.previousSummary?.untrusted_text).toContain('Old question 1');
		});
	});

	it('still opens a new segment when the summary fails, with no summary and a failed chip', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { threadId } = await longThread(db, owner);
			const failing: MockScript = {
				name: 'thread-summary',
				matches: summaryScripts[0]!.matches,
				steps: [{ fault: { kind: 'overloaded' } }]
			};
			const provider = coach(NEW_ANSWER, [failing]);
			const turn = await runScripted(answering(NEW_ANSWER), {
				db,
				owner,
				threadId,
				tools: [],
				provider: ready(provider)
			});

			expect(turn.done.status).toBe('completed');
			expect(chips(turn.events)).toEqual([
				{
					type: 'activity',
					id: 'summary_1',
					tool: 'summary',
					state: 'failed',
					label: 'Couldn’t summarise our earlier messages'
				}
			]);
			expect(await threadOf(db, threadId)).toMatchObject({ segment: 2 });
			expect(await db.select().from(coachNotes).where(eq(coachNotes.ownerId, owner))).toEqual([]);
			const [run] = await summaryRuns(db, threadId);
			expect(run).toMatchObject({ status: 'failed', error: 'overloaded', modelCalls: 1 });
			const request = provider.requests[0]!;
			expect(request.messages).toHaveLength(3);
			expect(preambleData(request.messages[0]!.content).previousSummary).toBeNull();
			expect(await segmentIssues(db, owner, threadId)).toEqual([]);
		});
	});

	it('makes no summary call once the day’s budget is spent, and keeps the segment', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { threadId, firstRun } = await longThread(db, owner);
			// 250K output tokens at $20 per million: exactly the $5 cap, on a call of the first run.
			await db.insert(agentModelCalls).values({
				ownerId: owner,
				runId: firstRun,
				callIndex: DRAFT_CALL_INDEX_BASE,
				model: 'claude-opus-5-5',
				outputTokens: 250_000,
				costMicros: 5_000_000,
				capCostMicros: 5_000_000,
				latencyMs: 1,
				createdAt: new Date(TURN_NOW)
			});
			const provider = coach(NEW_ANSWER);
			const turn = await runScripted(answering(NEW_ANSWER), {
				db,
				owner,
				threadId,
				tools: [],
				provider: ready(provider)
			});

			expect(provider.structuredCalls()).toBe(0);
			expect(await summaryRuns(db, threadId)).toEqual([]);
			expect(chips(turn.events)).toEqual([]);
			expect(await threadOf(db, threadId)).toMatchObject({ segment: 1 });
			expect(turn.done.status).toBe('budget_exhausted');
		});
	});

	it('keeps the segment when the client leaves mid-summary', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { threadId } = await longThread(db, owner);
			const controller = new AbortController();
			const provider = coach(NEW_ANSWER);
			const summarise = provider.structured;
			provider.structured = (request, schema, signal) => {
				controller.abort();
				return summarise(request, schema, signal);
			};
			const turn = await runScripted(answering(NEW_ANSWER), {
				db,
				owner,
				threadId,
				tools: [],
				provider: ready(provider),
				controller
			});

			expect(provider.structuredCalls()).toBe(1);
			expect(chips(turn.events)).toEqual([]);
			expect(await threadOf(db, threadId)).toMatchObject({ segment: 1 });
			expect(await db.select().from(coachNotes).where(eq(coachNotes.ownerId, owner))).toEqual([]);
			expect(turn.done.status).toBe('interrupted');
		});
	});
});
