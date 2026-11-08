/**
 * The coach's endpoints on real Postgres (POST /api/coach/turns and POST
 * /api/coach/runs/[run]/cancel), called as SvelteKit calls them, with the provider agent/coach.ts
 * resolves from the test environment (the mock, playing every mock script plus a slow one):
 * - a turn streams SSE frames with ids, no-store, that decode to a turn ending with done
 * - the 31st turn in 10 minutes is a 429 with Retry-After; the daily cap is a budget error
 * - a coach that is not launched or switched off answers one error event and writes nothing
 * - no_key still serves a direct answer
 * - leaving interrupts the turn; Stop flags it and it ends cancelled; 400 and 404 bodies
 * - the function may run COACH_MAX_DURATION_S, and a turn stops before that
 */
import { count, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COACH_MAX_DURATION_S, TURN_LIMITS } from '../../../src/lib/domain/coach/budgets';
import { createSseDecoder, type CoachEvent } from '../../../src/lib/domain/coach/events';
import { coachEventStream, coachStatus } from '../../../src/lib/server/agent/coach';
import type { MockScript } from '../../../src/lib/server/agent/provider/mock';
import type * as ScriptsModule from '../../../src/lib/server/agent/provider/mock-scripts/index';
import type * as SelectModule from '../../../src/lib/server/agent/provider/select';
import type { CoachProviderChoice } from '../../../src/lib/server/agent/provider/select';
import {
	agentModelCalls,
	agentRuns,
	coachMessages,
	coachThreads,
	type Executor
} from '../../../src/lib/server/db';
import { resetEnvCache } from '../../../src/lib/server/env';
import { finishRun, recordModelCall, startRun } from '../../../src/lib/server/services/coach/runs';
import { startOwnerTurn } from '../../../src/lib/server/services/coach/threads';
import { POST as cancelRun } from '../../../src/routes/api/coach/runs/[run]/cancel/+server';
import { config, POST as postTurn } from '../../../src/routes/api/coach/turns/+server';
import { withCommitted } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const forced = vi.hoisted(() => ({ choice: null as CoachProviderChoice | null }));

vi.mock('../../../src/lib/server/agent/provider/select', async (importOriginal) => {
	const actual = await importOriginal<typeof SelectModule>();
	return {
		...actual,
		resolveCoachProvider: (...args: Parameters<typeof actual.resolveCoachProvider>) =>
			forced.choice ?? actual.resolveCoachProvider(...args)
	};
});

const SLOW = 'Slowly, please: how is my week?';
/** A lookup direct.ts answers with no model call (domain/coach/intents.ts). */
const LOOKUP = "What's on this week?";
vi.mock('../../../src/lib/server/agent/provider/mock-scripts/index', async (importOriginal) => {
	const actual = await importOriginal<typeof ScriptsModule>();
	const slow: MockScript = {
		name: 'endpoint-slow',
		matches: (text) => text.startsWith('Slowly'),
		steps: [{ text: `[note] ${'Your week is on track so far. '.repeat(10)}`, delayMs: 30 }]
	};
	return { MOCK_SCRIPTS: [slow, ...actual.MOCK_SCRIPTS] };
});

/** Choose the provider (null: the test environment's own) for the next turns. */
function force(choice: CoachProviderChoice | null) {
	forced.choice = choice;
	resetEnvCache(); // a new environment: coach.ts resolves its provider again
}

afterEach(() => {
	force(null);
});

const URL_BASE = 'http://localhost:5173';

function event(owner: string, request: Request, params: Record<string, string> = {}) {
	return {
		request,
		params,
		url: new URL(request.url),
		locals: { session: { id: crypto.randomUUID(), ownerId: owner }, requestId: 'req-test' },
		getClientAddress: () => '127.0.0.1'
	} as never;
}

function turn(owner: string, body: unknown, signal?: AbortSignal) {
	const request = new Request(`${URL_BASE}/api/coach/turns`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
		signal
	});
	return postTurn(event(owner, request));
}

function cancel(owner: string, run: string) {
	const request = new Request(`${URL_BASE}/api/coach/runs/${run}/cancel`, { method: 'POST' });
	return cancelRun(event(owner, request, { run }));
}

const send = (text = 'Hello coach', extra: Record<string, unknown> = {}) => ({
	clientMessageId: crypto.randomUUID(),
	text,
	...extra
});

interface Read {
	events: CoachEvent[];
	raw: string;
	lastEventId: string | null;
}

/** Read a stream to its end; `onEvent` may stop reading (it returns true) after any event. */
async function read(
	body: ReadableStream<Uint8Array>,
	onEvent?: (event: CoachEvent) => Promise<boolean | void>
): Promise<Read> {
	const decoder = createSseDecoder();
	const reader = body.getReader();
	const text = new TextDecoder();
	const events: CoachEvent[] = [];
	let raw = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		raw += text.decode(value, { stream: true });
		for (const each of decoder.push(value)) {
			events.push(each);
			if (await onEvent?.(each)) {
				await reader.cancel();
				return { events, raw, lastEventId: decoder.lastEventId };
			}
		}
	}
	events.push(...decoder.end());
	return { events, raw, lastEventId: decoder.lastEventId };
}

async function streamed(response: Response) {
	expect(response.status).toBe(200);
	expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
	expect(response.headers.get('cache-control')).toBe('no-store');
	return read(response.body!);
}

const rowsOf = async (db: Executor) => ({
	threads: (await db.select({ n: count() }).from(coachThreads))[0]!.n,
	messages: (await db.select({ n: count() }).from(coachMessages))[0]!.n,
	runs: (await db.select({ n: count() }).from(agentRuns))[0]!.n
});

const runOf = async (db: Executor, id: string) =>
	(await db.select().from(agentRuns).where(eq(agentRuns.id, id)))[0]!;

/** Poll until the run has finished (the turn goes on storing after the client left). */
async function finished(db: Executor, id: string) {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const run = await runOf(db, id);
		if (run.status !== 'running') return run;
		if (Date.now() > deadline) throw new Error(`run ${id} is still running`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

const runStarted = (events: readonly CoachEvent[]) => {
	const started = events.find((each) => each.type === 'run_started');
	if (started?.type !== 'run_started') throw new Error('no run_started');
	return started;
};

describe('POST /api/coach/turns', () => {
	it('streams a scripted turn as SSE frames with ids that decode and end with done', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			expect(coachStatus()).toEqual({ status: 'ready', mockBadge: true });
			const { events, raw, lastEventId } = await streamed(await turn(owner, send()));

			const types = events.map((each) => each.type);
			expect(types[0]).toBe('run_started');
			expect(types).toContain('text_delta');
			expect(types.slice(-2)).toEqual(['answer_completed', 'done']);
			expect(events.at(-1)).toEqual({ type: 'done', status: 'completed' });
			expect(raw.startsWith('id: 1\nevent: run_started\n')).toBe(true);
			expect(lastEventId).toBe(String(events.length));
			const { runId } = runStarted(events);
			expect(await runOf(db, runId)).toMatchObject({ status: 'completed', provider: 'mock' });
		});
	});

	it('refuses the 31st turn in 10 minutes with 429 and Retry-After, and runs nothing', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			for (let n = 0; n < 30; n++) {
				const { events } = await streamed(await turn(owner, send()));
				expect(events.at(-1), `turn ${n + 1}`).toEqual({ type: 'done', status: 'completed' });
			}
			const refused = await turn(owner, send());
			expect(refused.status).toBe(429);
			expect(refused.headers.get('retry-after')).toBe('600');
			expect(refused.headers.get('cache-control')).toBe('no-store');
			expect(await refused.json()).toMatchObject({ error: 'rate_limited' });
			expect((await rowsOf(db)).runs).toBe(30);
		});
	});

	it('ends a turn at the daily cap with a budget error, before any model call', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const earlier = await startOwnerTurn(
				owner,
				{
					clientMessageId: crypto.randomUUID(),
					text: 'Plan my month',
					segment: { promptVersion: 'pv-earlier', programVersionId: null }
				},
				{ db }
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
				{ db }
			);
			// 250K output tokens at $20 per million: exactly the $5 cap.
			const usage = {
				inputTokens: 0,
				outputTokens: 250_000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0
			};
			await recordModelCall(
				owner,
				spent.id,
				{
					index: 0,
					requestId: null,
					model: 'claude-opus-5-5',
					stopReason: 'end_turn',
					usage,
					ttftMs: 1,
					latencyMs: 1,
					error: null
				},
				{ db }
			);
			await finishRun(owner, spent.id, { status: 'completed' }, { db });

			const { events } = await streamed(await turn(owner, send()));
			expect(events.filter((each) => each.type === 'error')).toEqual([
				{ type: 'error', kind: 'budget' }
			]);
			expect(events.at(-1)).toEqual({ type: 'done', status: 'budget_exhausted' });
			const { runId } = runStarted(events);
			const calls = await db.select().from(agentModelCalls).where(eq(agentModelCalls.runId, runId));
			expect(calls).toEqual([]);
		});
	});

	it.each(['not_launched', 'disabled'] as const)(
		'%s: one error event and done, with no thread, message or run, direct answers included',
		async (reason) => {
			await withCommitted(async (db) => {
				const owner = await makeOwner(db);
				force({ status: 'unavailable', reason });
				expect(coachStatus()).toEqual({ status: 'unavailable', reason, mockBadge: false });
				const { events } = await streamed(await turn(owner, send(LOOKUP)));
				expect(events).toEqual([
					{ type: 'error', kind: 'unavailable', reason },
					{ type: 'done', status: null }
				]);
				expect(await rowsOf(db)).toEqual({ threads: 0, messages: 0, runs: 0 });
			});
		}
	);

	it('no_key: a direct answer is still served; anything else is unavailable', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			force({ status: 'unavailable', reason: 'no_key' });
			const direct = await streamed(await turn(owner, send(LOOKUP)));
			expect(direct.events.map((each) => each.type)).toContain('answer_completed');
			expect(direct.events.at(-1)).toEqual({ type: 'done', status: 'completed' });
			expect(direct.raw).toContain('You have no active program yet');

			const other = await streamed(await turn(owner, send('Plan my month')));
			expect(other.events.filter((each) => each.type === 'error')).toEqual([
				{ type: 'error', kind: 'unavailable', reason: 'no_key' }
			]);
			expect(other.events.at(-1)).toEqual({ type: 'done', status: 'failed' });
		});
	});

	it('interrupts the turn when the client leaves, and stores what was shown as interrupted', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const leave = new AbortController();
			const response = await turn(owner, send(SLOW), leave.signal);
			const { events } = await read(response.body!, async (each) => {
				if (each.type === 'text_delta' && !leave.signal.aborted) leave.abort();
			});
			expect(events.filter((each) => each.type === 'error')).toEqual([
				{ type: 'error', kind: 'interrupted' }
			]);
			expect(events.at(-1)).toEqual({ type: 'done', status: 'interrupted' });
			const { runId, threadId } = runStarted(events);
			expect(await runOf(db, runId)).toMatchObject({ status: 'interrupted' });
			const shown = await db
				.select({ kind: coachMessages.kind, status: coachMessages.status })
				.from(coachMessages)
				.where(eq(coachMessages.threadId, threadId));
			expect(shown).toContainEqual({ kind: 'display_only', status: 'interrupted' });
		});
	});

	it('Stop: cancel flags the run (202), the stream is dropped, and the run ends cancelled', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const response = await turn(owner, send(SLOW));
			let runId = '';
			await read(response.body!, async (each) => {
				if (each.type === 'run_started') runId = each.runId;
				if (each.type !== 'text_delta') return;
				const stop = await cancel(owner, runId);
				expect(stop.status).toBe(202);
				expect(stop.headers.get('cache-control')).toBe('no-store');
				expect(await stop.json()).toEqual({ running: true });
				return true; // the client drops the stream
			});
			expect(await finished(db, runId)).toMatchObject({ status: 'cancelled' });
			expect((await runOf(db, runId)).cancelRequestedAt).not.toBeNull();

			const again = await cancel(owner, runId);
			expect(again.status).toBe(202);
			expect(await again.json()).toEqual({ running: false });
		});
	});

	it('cancel answers 404 for a run that is not the owner’s or not a run id', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const other = crypto.randomUUID(); // there is only ever one owner
			const { events } = await streamed(await turn(owner, send()));
			const { runId } = runStarted(events);
			for (const [who, id] of [
				[other, runId],
				[owner, crypto.randomUUID()],
				[owner, 'not-a-uuid']
			] as const) {
				const res = await cancel(who, id);
				expect(res.status, id).toBe(404);
				expect(res.headers.get('cache-control')).toBe('no-store');
				expect(await res.json()).toEqual({ error: 'not_found' });
			}
			expect((await runOf(db, runId)).cancelRequestedAt).toBeNull();
		});
	});

	it('answers 400 for a body that is not a turn, and stores nothing', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const bodies: unknown[] = [
				'not json',
				'',
				{ text: 'Hi' },
				{ clientMessageId: 'not-a-uuid', text: 'Hi' },
				{ ...send(), text: 42 },
				{ ...send(), threadId: 'thread-1' },
				{ ...send(), surprise: true },
				{ ...send(), entry: { from: 'Today!', ref: null } },
				{ ...send(), entry: { from: 'today', ref: { type: 'castle', id: '1' } } },
				{ ...send(), text: 'x'.repeat(70 * 1024) }
			];
			for (const body of bodies) {
				const res = await turn(owner, body);
				expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
				expect(res.headers.get('cache-control')).toBe('no-store');
				expect(await res.json()).toMatchObject({ error: 'invalid_request' });
			}
			expect(await rowsOf(db)).toEqual({ threads: 0, messages: 0, runs: 0 });
		});
	});

	it('a conversation that is not the owner’s is not_found in the stream, and nothing is written', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const { events } = await streamed(
				await turn(owner, send('Hello', { threadId: crypto.randomUUID() }))
			);
			expect(events).toEqual([
				{ type: 'error', kind: 'not_found' },
				{ type: 'done', status: null }
			]);
			expect(await rowsOf(db)).toEqual({ threads: 0, messages: 0, runs: 0 });
		});
	});

	it('may run COACH_MAX_DURATION_S on Vercel, and a turn stops before that', () => {
		expect(config.maxDuration).toBe(COACH_MAX_DURATION_S);
		expect(TURN_LIMITS.turnMs).toBeLessThan(COACH_MAX_DURATION_S * 1000);
	});
});

describe('coachEventStream', () => {
	it('sends a heartbeat comment while the turn is quiet, which the decoder skips', async () => {
		async function* quiet(): AsyncGenerator<CoachEvent> {
			yield { type: 'run_started', threadId: 't', runId: 'r', messageId: 'm' };
			await new Promise((resolve) => setTimeout(resolve, 60));
			yield { type: 'done', status: 'completed' };
		}
		const { events, raw } = await read(
			coachEventStream(quiet(), { onCancel: () => undefined, heartbeatMs: 10 })
		);
		expect(raw).toContain(': heartbeat\n\n');
		expect(events.map((each) => each.type)).toEqual(['run_started', 'done']);
		expect(raw.endsWith('id: 2\nevent: done\ndata: {"type":"done","status":"completed"}\n\n')).toBe(
			true
		);
	});
});
