/**
 * The coach runs service on real Postgres (the M5 plan's agent-runs-service):
 * - Model and tool calls are stored priced, and roll up into their run in the same transaction.
 * - A run finishes once; a finished run records nothing more.
 * - One live run per conversation; a run abandoned past TURN_LIMITS.staleRunMs is expired.
 * - Stop's cancel flag is set once and read back.
 * - spentToday counts the owner's own day, not UTC's, and an unpriced model at the cap's rate.
 * - usageSummary and listRuns report exact numbers, owner-scoped.
 */
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { TURN_LIMITS } from '../../../src/lib/domain/coach/budgets';
import { capCostMicros, costMicros, type ModelUsage } from '../../../src/lib/domain/coach/pricing';
import {
	agentModelCalls,
	agentRuns,
	agentToolCalls,
	athleteProfiles,
	getDb,
	type Executor
} from '../../../src/lib/server/db';
import { AGENT_RUN_INDEXES } from '../../../src/lib/server/db/queries/agent-runs';
import { TOOL_CALL_JSON_MAX_BYTES } from '../../../src/lib/server/db/schema/agent-runs';
import {
	finishRun,
	isCancelRequested,
	listRuns,
	recordModelCall,
	recordToolCalls,
	requestCancel,
	RUN_PAGE,
	spentToday,
	startRun,
	usageSummary,
	type ModelCallInput,
	type ToolCallInput
} from '../../../src/lib/server/services/coach/runs';
import {
	CoachBusyError,
	CoachInputError,
	CoachNotFoundError,
	CoachRunFinishedError,
	type CoachDeps
} from '../../../src/lib/server/services/coach/shared';
import { startOwnerTurn } from '../../../src/lib/server/services/coach/threads';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const OPUS = 'claude-opus-5-5';

/** A clock the test sets. */
function setClock(start: string) {
	let t = new Date(start).getTime();
	return {
		now: () => new Date(t),
		set: (iso: string) => void (t = new Date(iso).getTime()),
		advance: (ms: number) => void (t += ms)
	};
}

type Clock = ReturnType<typeof setClock>;

/** The owner's message on a new conversation, and what a run on it starts with. */
async function message(db: Executor, ownerId: string, at: Clock) {
	const turn = await startOwnerTurn(
		ownerId,
		{
			clientMessageId: crypto.randomUUID(),
			text: 'How is my bench going?',
			segment: { promptVersion: 'pv-1', programVersionId: null }
		},
		{ db, now: at.now }
	);
	return {
		threadId: turn.thread.id,
		triggerMessageId: turn.message.id,
		kind: 'turn',
		provider: 'mock',
		model: OPUS,
		effort: 'high',
		promptVersion: 'pv-1'
	};
}

const usage = (
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens = 0,
	cacheWriteTokens = 0
): ModelUsage => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

const call = (index: number, values: Partial<ModelCallInput> = {}): ModelCallInput => ({
	index,
	requestId: `req_${index}`,
	model: OPUS,
	stopReason: 'end_turn',
	usage: usage(1000, 100),
	ttftMs: 300,
	latencyMs: 900,
	error: null,
	...values
});

const tool = (name: string, values: Partial<ToolCallInput> = {}): ToolCallInput => ({
	callIndex: 0,
	toolUseId: `toolu_${crypto.randomUUID()}`,
	name,
	status: 'succeeded',
	input: { exerciseId: 'bench' },
	output: { items: [] },
	errorCode: null,
	truncated: false,
	startedAt: new Date('2026-11-10T07:00:01Z'),
	durationMs: 40,
	...values
});

/** What a promise rejected with (fails the test if it resolved). */
async function rejection(promise: Promise<unknown>): Promise<Error> {
	const err = await promise.then(
		() => null,
		(e: unknown) => e
	);
	if (!(err instanceof Error)) throw new Error('expected a rejection');
	return err;
}

const runRow = async (db: Executor, id: string) =>
	(await db.select().from(agentRuns).where(eq(agentRuns.id, id)))[0]!;

const setTimeZone = async (db: Executor, ownerId: string, timeZone: string) => {
	await db
		.insert(athleteProfiles)
		.values({ ownerId, name: 'Niko', timeZone })
		.onConflictDoUpdate({ target: athleteProfiles.ownerId, set: { timeZone } });
};

describe('coach runs', () => {
	it('stores priced calls and rolls them up into the run, which finishes once', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const at = setClock('2026-11-10T07:00:00Z');
			const deps: CoachDeps = { db: tx, now: at.now };
			const run = await startRun(ownerId, await message(tx, ownerId, at), deps);
			expect(run).toMatchObject({ status: 'running', modelCalls: 0, capCostMicros: 0 });

			// Opus 5.5 at $4 / $20 / $0.20 / $5 per MTok is 4 / 20 / 0.2 / 5 micro-dollars a token.
			at.advance(1_000);
			const first = await recordModelCall(
				ownerId,
				run.id,
				call(0, { stopReason: 'tool_use', usage: usage(1000, 500, 2000, 400) }),
				deps
			);
			expect(first).toEqual({ costMicros: 16_400, capCostMicros: 16_400 });
			const big = 'x'.repeat(TOOL_CALL_JSON_MAX_BYTES);
			await recordToolCalls(
				ownerId,
				run.id,
				[tool('get_exercise_history'), tool('get_week_plan', { output: { text: big } })],
				deps
			);
			at.advance(2_000);
			await recordModelCall(ownerId, run.id, call(1, { usage: usage(200, 1000, 3000) }), deps);
			at.advance(1_500);
			const done = await finishRun(ownerId, run.id, { status: 'completed', ttftMs: 1_250 }, deps);

			expect(done).toMatchObject({
				status: 'completed',
				servedModel: OPUS,
				stopReason: 'end_turn',
				modelCalls: 2,
				toolCalls: 2,
				inputTokens: 1200,
				outputTokens: 1500,
				cacheReadTokens: 5000,
				cacheWriteTokens: 400,
				costMicros: 37_800,
				capCostMicros: 37_800,
				ttftMs: 1_250,
				latencyMs: 4_500,
				finishedAt: new Date('2026-11-10T07:00:04.500Z')
			});
			const calls = await tx
				.select()
				.from(agentModelCalls)
				.where(eq(agentModelCalls.runId, run.id))
				.orderBy(agentModelCalls.callIndex);
			expect(calls.map((c) => [c.callIndex, c.costMicros, c.capCostMicros, c.createdAt])).toEqual([
				[0, 16_400, 16_400, new Date('2026-11-10T07:00:01Z')],
				[1, 21_400, 21_400, new Date('2026-11-10T07:00:03Z')]
			]);
			expect(calls[0]).toMatchObject({ requestId: 'req_0', stopReason: 'tool_use', ttftMs: 300 });
			const tools = await tx
				.select()
				.from(agentToolCalls)
				.where(eq(agentToolCalls.runId, run.id))
				.orderBy(agentToolCalls.name);
			expect(tools.map((t) => [t.name, t.truncated, t.output])).toEqual([
				['get_exercise_history', false, { items: [] }],
				['get_week_plan', true, { truncated: true, bytes: expect.any(Number) }]
			]);

			// Finished: it records and changes nothing more.
			for (const late of [
				() => finishRun(ownerId, run.id, { status: 'failed' }, deps),
				() => recordModelCall(ownerId, run.id, call(2), deps),
				() => recordToolCalls(ownerId, run.id, [tool('get_week_plan')], deps)
			]) {
				expect(await rejection(late())).toBeInstanceOf(CoachRunFinishedError);
			}
			expect(await runRow(tx, run.id)).toMatchObject({ status: 'completed', modelCalls: 2 });
			expect(
				await rejection(finishRun(ownerId, run.id, { status: 'expired' as never }, deps))
			).toBeInstanceOf(CoachInputError);

			// Someone else's run is not found, like a missing or malformed one.
			const other = crypto.randomUUID();
			for (const id of [run.id, crypto.randomUUID(), 'not-a-uuid']) {
				expect(await rejection(finishRun(other, id, { status: 'failed' }, deps))).toBeInstanceOf(
					CoachNotFoundError
				);
				expect(await rejection(recordModelCall(other, id, call(3), deps))).toBeInstanceOf(
					CoachNotFoundError
				);
			}
		});
	});

	it('allows one live run per conversation and expires an abandoned one', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const at = setClock('2026-11-10T07:00:00Z');
			const deps: CoachDeps = { db: tx, now: at.now };
			const input = await message(tx, ownerId, at);
			const live = await startRun(ownerId, input, deps);

			expect(await rejection(startRun(ownerId, input, deps))).toBeInstanceOf(CoachBusyError);
			// Another conversation is not held up.
			const elsewhere = await startRun(ownerId, await message(tx, ownerId, at), deps);
			expect(elsewhere.status).toBe('running');

			// Not stale until staleRunMs has passed.
			at.advance(TURN_LIMITS.staleRunMs - 1);
			expect(await rejection(startRun(ownerId, input, deps))).toBeInstanceOf(CoachBusyError);
			at.advance(1);
			const retry = await startRun(ownerId, input, deps);
			expect(retry).toMatchObject({ status: 'running', triggerMessageId: input.triggerMessageId });
			expect(await runRow(tx, live.id)).toMatchObject({ status: 'expired', finishedAt: at.now() });

			// A finished run frees the conversation: a retry is a new run on the same message.
			await finishRun(ownerId, retry.id, { status: 'failed', error: 'overloaded' }, deps);
			expect(await runRow(tx, retry.id)).toMatchObject({ status: 'failed', error: 'overloaded' });
			expect((await startRun(ownerId, input, deps)).status).toBe('running');

			// A message that is not the owner's message in that conversation starts nothing.
			const other = crypto.randomUUID();
			for (const bad of [
				{ ...input, triggerMessageId: crypto.randomUUID() },
				{ ...input, threadId: elsewhere.threadId },
				{ ...input, threadId: 'nope' }
			]) {
				expect(await rejection(startRun(ownerId, bad, deps))).toBeInstanceOf(CoachNotFoundError);
			}
			expect(await rejection(startRun(other, input, deps))).toBeInstanceOf(CoachNotFoundError);
		});
	});

	it('starts one run when two starts race on the pool', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			const at = setClock('2026-11-10T07:00:00Z');
			const input = await message(db, ownerId, at);
			// Separate pool calls, each on its own connection.
			const results = await Promise.allSettled([
				startRun(ownerId, input, { db, now: at.now }),
				startRun(ownerId, input, { db, now: at.now })
			]);
			const won = results.filter((r) => r.status === 'fulfilled');
			const lost = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
			expect(won).toHaveLength(1);
			expect(lost).toHaveLength(1);
			expect(lost[0]).toBeInstanceOf(CoachBusyError);
		});
	});

	it('sets the cancel flag once and reads it back', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const at = setClock('2026-11-10T07:00:00Z');
			const deps: CoachDeps = { db: tx, now: at.now };
			const run = await startRun(ownerId, await message(tx, ownerId, at), deps);

			expect(await isCancelRequested(ownerId, run.id, deps)).toBe(false);
			at.advance(500);
			expect(await requestCancel(ownerId, run.id, deps)).toBe(true);
			at.advance(500);
			expect(await requestCancel(ownerId, run.id, deps)).toBe(true);
			expect(await isCancelRequested(ownerId, run.id, deps)).toBe(true);
			expect((await runRow(tx, run.id)).cancelRequestedAt).toEqual(
				new Date('2026-11-10T07:00:00.500Z')
			);

			// Stop after the run finished changes nothing.
			const ended = await startRun(ownerId, await message(tx, ownerId, at), deps);
			await finishRun(ownerId, ended.id, { status: 'completed' }, deps);
			expect(await requestCancel(ownerId, ended.id, deps)).toBe(false);
			expect(await isCancelRequested(ownerId, ended.id, deps)).toBe(false);

			const other = crypto.randomUUID();
			for (const id of [run.id, 'not-a-uuid']) {
				expect(await rejection(requestCancel(other, id, deps))).toBeInstanceOf(CoachNotFoundError);
				expect(await rejection(isCancelRequested(other, id, deps))).toBeInstanceOf(
					CoachNotFoundError
				);
			}
			expect(await isCancelRequested(ownerId, run.id, deps)).toBe(true);
		});
	});

	it('counts what the cap counts over the owner’s own day, across midnight UTC', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const at = setClock('2026-11-10T07:50:00Z');
			const deps: CoachDeps = { db: tx, now: at.now };
			const priced = (output: number) => call(0, { usage: usage(0, output) });
			const spend = async (calls: [string, number][]) => {
				at.set(calls[0]![0]);
				const run = await startRun(ownerId, await message(tx, ownerId, at), deps);
				for (const [index, [when, output]] of calls.entries()) {
					at.set(when);
					await recordModelCall(ownerId, run.id, { ...priced(output), index }, deps);
				}
				await finishRun(ownerId, run.id, { status: 'completed' }, deps);
			};
			// 23:59:30 and 00:01 in Los Angeles: one run's calls either side of the owner's midnight.
			await spend([
				['2026-11-10T07:59:30Z', 1],
				['2026-11-10T08:01:00Z', 10]
			]);
			await spend([['2026-11-10T23:30:00Z', 100]]); // 15:30 there, Nov 10 in UTC
			await spend([['2026-11-11T00:30:00Z', 1000]]); // 16:30 there, Nov 11 in UTC

			// Without a profile the owner is on UTC: only the call after midnight UTC.
			at.set('2026-11-11T01:00:00Z');
			expect(await spentToday(ownerId, deps)).toBe(20 * 1000);

			await setTimeZone(tx, ownerId, 'America/Los_Angeles'); // UTC−8 in November
			expect(await spentToday(ownerId, deps)).toBe(20 * 1110);
			await setTimeZone(tx, ownerId, 'UTC');
			expect(await spentToday(ownerId, deps)).toBe(20 * 1000);

			// The next Los Angeles day starts at 08:00 UTC.
			await setTimeZone(tx, ownerId, 'America/Los_Angeles');
			at.set('2026-11-11T08:00:00Z');
			expect(await spentToday(ownerId, deps)).toBe(0);

			// Someone else spent nothing.
			expect(await spentToday(crypto.randomUUID(), deps)).toBe(0);
		});
	});

	it('prices an unpriced model for the cap, counts it, and reports it', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const at = setClock('2026-11-10T07:00:00Z');
			const deps: CoachDeps = { db: tx, now: at.now };
			const run = await startRun(ownerId, await message(tx, ownerId, at), deps);
			const spent = usage(10_000, 2_000, 30_000, 4_000);

			const unknown = await recordModelCall(
				ownerId,
				run.id,
				call(0, { model: 'claude-mystery-9', usage: spent }),
				deps
			);
			expect(unknown.costMicros).toBeNull();
			expect(unknown.capCostMicros).toBe(capCostMicros(spent, 'claude-mystery-9'));
			expect(unknown.capCostMicros).toBeGreaterThanOrEqual(costMicros(spent, OPUS)!);
			// A priced call afterwards keeps the run unpriced.
			await recordModelCall(ownerId, run.id, call(1, { usage: usage(1000, 100) }), deps);
			await finishRun(ownerId, run.id, { status: 'completed' }, deps);

			const stored = await tx
				.select()
				.from(agentModelCalls)
				.where(eq(agentModelCalls.runId, run.id))
				.orderBy(agentModelCalls.callIndex);
			expect(stored.map((c) => [c.model, c.costMicros])).toEqual([
				['claude-mystery-9', null],
				[OPUS, 6_000]
			]);
			const cap = unknown.capCostMicros + 6_000;
			expect(await runRow(tx, run.id)).toMatchObject({ costMicros: null, capCostMicros: cap });
			expect(await spentToday(ownerId, deps)).toBe(cap);
			expect(await usageSummary(ownerId, deps)).toMatchObject({
				costMicros: 0,
				capCostMicros: cap,
				unpricedRuns: 1,
				unpricedCalls: 1
			});
		});
	});

	it('stores a refusal’s category, and reads stop_details on a refusal only', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const at = setClock('2026-11-10T07:00:00Z');
			const deps: CoachDeps = { db: tx, now: at.now };
			const run = await startRun(ownerId, await message(tx, ownerId, at), deps);
			const details = { type: 'refusal', category: 'cyber', explanation: 'x' };

			await recordModelCall(ownerId, run.id, call(0, { stopDetails: details }), deps);
			await recordModelCall(
				ownerId,
				run.id,
				call(1, { stopReason: 'refusal', stopDetails: details }),
				deps
			);
			await finishRun(ownerId, run.id, { status: 'refused' }, deps);

			const stored = await tx
				.select({ category: agentModelCalls.refusalCategory })
				.from(agentModelCalls)
				.where(eq(agentModelCalls.runId, run.id))
				.orderBy(agentModelCalls.callIndex);
			expect(stored.map((c) => c.category)).toEqual([null, 'cyber']);
			expect(await runRow(tx, run.id)).toMatchObject({
				status: 'refused',
				stopReason: 'refusal',
				refusalCategory: 'cyber'
			});
		});
	});

	it('summarises the owner’s usage exactly', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const at = setClock('2026-11-10T07:00:00Z');
			const deps: CoachDeps = { db: tx, now: at.now };

			expect(await usageSummary(ownerId, deps)).toEqual({
				runs: 0,
				modelCalls: 0,
				toolCalls: 0,
				tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
				costMicros: 0,
				capCostMicros: 0,
				unpricedRuns: 0,
				unpricedCalls: 0,
				cacheHitRatio: null,
				latencyMs: { p50: null, p95: null },
				statuses: {
					running: 0,
					completed: 0,
					refused: 0,
					budget_exhausted: 0,
					cancelled: 0,
					interrupted: 0,
					timed_out: 0,
					failed: 0,
					expired: 0
				},
				tools: []
			});

			const finished: [number, 'completed' | 'cancelled', string[]][] = [
				[1_000, 'completed', ['get_week_plan', 'get_exercise_history']],
				[10_000, 'completed', ['get_week_plan']],
				[2_000, 'cancelled', ['get_week_plan', '_policy']]
			];
			for (const [latency, status, names] of finished) {
				const run = await startRun(ownerId, await message(tx, ownerId, at), deps);
				await recordModelCall(ownerId, run.id, call(0, { usage: usage(1000, 100, 3000) }), deps);
				await recordToolCalls(
					ownerId,
					run.id,
					names.map((n) => tool(n)),
					deps
				);
				at.advance(latency);
				await finishRun(ownerId, run.id, { status }, deps);
			}
			await startRun(ownerId, await message(tx, ownerId, at), deps);
			// Someone else has no usage of the owner's.
			expect(await usageSummary(crypto.randomUUID(), deps)).toMatchObject({ runs: 0, tools: [] });

			// Each priced call: 1000 × 4 + 100 × 20 + 3000 × 0.2 = 6,600 micro-dollars.
			expect(await usageSummary(ownerId, deps)).toMatchObject({
				runs: 4,
				modelCalls: 3,
				toolCalls: 5,
				tokens: {
					inputTokens: 3000,
					outputTokens: 300,
					cacheReadTokens: 9000,
					cacheWriteTokens: 0
				},
				costMicros: 19_800,
				capCostMicros: 19_800,
				unpricedRuns: 0,
				unpricedCalls: 0,
				cacheHitRatio: 0.75,
				latencyMs: { p50: 2_000, p95: 10_000 },
				statuses: { running: 1, completed: 2, cancelled: 1, failed: 0 },
				tools: [
					{ name: 'get_week_plan', calls: 3 },
					{ name: '_policy', calls: 1 },
					{ name: 'get_exercise_history', calls: 1 }
				]
			});
		});
	});

	it('lists the owner’s runs newest first, a page at a time', async () => {
		await withRollback(async (tx) => {
			const ownerId = await makeOwner(tx);
			const at = setClock('2026-11-10T07:00:00Z');
			const deps: CoachDeps = { db: tx, now: at.now };
			const ids: string[] = [];
			for (let i = 0; i < 3; i++) {
				at.advance(60_000);
				ids.push((await startRun(ownerId, await message(tx, ownerId, at), deps)).id);
			}
			const other = crypto.randomUUID();

			const first = await listRuns(ownerId, { limit: 2 }, deps);
			expect(first.runs.map((r) => r.id)).toEqual([ids[2], ids[1]]);
			expect(first.nextBefore).toBe(ids[1]);
			const second = await listRuns(ownerId, { before: first.nextBefore!, limit: 2 }, deps);
			expect(second).toEqual({ runs: [expect.objectContaining({ id: ids[0] })], nextBefore: null });
			expect((await listRuns(ownerId, {}, deps)).runs).toHaveLength(3);
			expect((await listRuns(other, { before: ids[2] }, deps)).runs).toEqual([]);

			for (const bad of [{ limit: 0 }, { limit: RUN_PAGE.max + 1 }, { before: 'nope' }]) {
				expect(await rejection(listRuns(ownerId, bad, deps))).toBeInstanceOf(CoachInputError);
			}
		});
	});

	it('has the index each read builder is shaped for', async () => {
		const names = Object.values(AGENT_RUN_INDEXES).flatMap((v) =>
			typeof v === 'string' ? [v] : [...v]
		);
		const { rows: found } = await getDb().execute<{ indexname: string }>(
			sql`select indexname from pg_indexes where tablename in ('agent_runs', 'agent_model_calls', 'agent_tool_calls', 'coach_messages')`
		);
		const existing = new Set(found.map((r) => r.indexname));
		for (const name of names) expect(existing, name).toContain(name);
	});
});
