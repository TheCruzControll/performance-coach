/**
 * The usage view's read on real Postgres (GET /api/coach/runs, the M5 plan's coach-usage-view),
 * called as SvelteKit calls it:
 * - a fresh owner gets zero totals and no runs: the empty state
 * - each run is listed newest first with its tokens, cache reads and writes, latency, tools, stop
 *   reason and refusal category, and the cost domain/coach/pricing.ts gives it; a run served by
 *   a model with no price has a null cost (Not priced), while the cap's cost still counts it
 * - a lookup answered with no model call costs $0
 * - the first page carries the totals, later pages none; a bad cursor or limit is a 400
 * - nothing leaks: no owner, thread or message id; another session's owner sees none of it
 * - 429 past the 'coach.action' limit
 */
import { describe, expect, it } from 'vitest';
import { capCostMicros, costMicros, type ModelUsage } from '../../../src/lib/domain/coach/pricing';
import { RATE_LIMITS } from '../../../src/lib/server/auth/policy';
import { createAuthRepository, type Executor } from '../../../src/lib/server/db';
import {
	finishRun,
	recordModelCall,
	recordToolCalls,
	startRun,
	type ModelCallInput
} from '../../../src/lib/server/services/coach/runs';
import type { CoachDeps } from '../../../src/lib/server/services/coach/shared';
import { startOwnerTurn } from '../../../src/lib/server/services/coach/threads';
import { GET } from '../../../src/routes/api/coach/runs/+server';
import type { UsagePage } from '../../../src/routes/(app)/coach/[[thread]]/usage';
import { withCommitted } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const OPUS = 'claude-opus-5-5';
const UNPRICED = 'claude-future-x';
const URL_BASE = 'http://localhost:5173';

function read(ownerId: string, query = '') {
	const url = new URL(`${URL_BASE}/api/coach/runs${query}`);
	return GET({
		request: new Request(url),
		url,
		params: {},
		locals: { session: { id: crypto.randomUUID(), ownerId }, requestId: 'req-test' },
		getClientAddress: () => '127.0.0.1'
	} as never) as Promise<Response>;
}

async function page(ownerId: string, query = ''): Promise<UsagePage> {
	const response = await read(ownerId, query);
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('no-store');
	return (await response.json()) as UsagePage;
}

/** A clock the test moves. */
function clock(start: string) {
	let t = new Date(start).getTime();
	return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
}

const usage = (
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens = 0,
	cacheWriteTokens = 0
): ModelUsage => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens });

const call = (index: number, values: Partial<ModelCallInput>): ModelCallInput => ({
	index,
	requestId: `req_${index}`,
	model: OPUS,
	stopReason: 'end_turn',
	usage: usage(0, 0),
	ttftMs: 300,
	latencyMs: 900,
	error: null,
	...values
});

/** A run on a new conversation, as the turn starts one. */
async function run(
	db: Executor,
	ownerId: string,
	deps: CoachDeps,
	start: { provider?: string; model?: string } = {}
) {
	const turn = await startOwnerTurn(
		ownerId,
		{
			clientMessageId: crypto.randomUUID(),
			text: 'How is my week going?',
			segment: { promptVersion: 'pv-1', programVersionId: null }
		},
		deps
	);
	return startRun(
		ownerId,
		{
			threadId: turn.thread.id,
			triggerMessageId: turn.message.id,
			kind: 'turn',
			provider: start.provider ?? 'mock',
			model: start.model ?? OPUS,
			effort: 'high',
			promptVersion: 'pv-1'
		},
		deps
	);
}

/**
 * Three runs a minute apart: two tools then an answer (two priced calls), a lookup with no model
 * call, and a refusal served by a model with no price.
 */
async function seedRuns(db: Executor, ownerId: string) {
	const at = clock('2026-11-10T07:00:00Z');
	const deps: CoachDeps = { db, now: at.now };
	const first = usage(2_000, 150, 0, 1_500);
	const second = usage(400, 300, 3_500, 0);

	const tools = await run(db, ownerId, deps);
	await recordModelCall(ownerId, tools.id, call(0, { usage: first, stopReason: 'tool_use' }), deps);
	const tool = (name: string) => ({
		callIndex: 0,
		toolUseId: `toolu_${crypto.randomUUID()}`,
		name,
		status: 'succeeded' as const,
		input: {},
		output: { items: [] },
		errorCode: null,
		truncated: false,
		startedAt: at.now(),
		durationMs: 40
	});
	await recordToolCalls(
		ownerId,
		tools.id,
		[tool('get_training_load'), tool('get_performance_trends')],
		deps
	);
	await recordModelCall(ownerId, tools.id, call(1, { usage: second }), deps);
	at.advance(2_400);
	await finishRun(ownerId, tools.id, { status: 'completed', ttftMs: 300 }, deps);

	at.advance(60_000);
	const direct = await run(db, ownerId, deps, { provider: 'direct', model: 'none' });
	at.advance(35);
	await finishRun(ownerId, direct.id, { status: 'completed' }, deps);

	at.advance(60_000);
	const declined = await run(db, ownerId, deps);
	const refused = usage(1_000, 20);
	await recordModelCall(
		ownerId,
		declined.id,
		call(0, {
			model: UNPRICED,
			usage: refused,
			stopReason: 'refusal',
			stopDetails: { category: 'cyber' }
		}),
		deps
	);
	at.advance(1_200);
	await finishRun(ownerId, declined.id, { status: 'refused' }, deps);

	return {
		ids: { tools: tools.id, direct: direct.id, declined: declined.id },
		toolsCost: costMicros(first, OPUS)! + costMicros(second, OPUS)!,
		declinedCap: capCostMicros(refused, UNPRICED)
	};
}

describe('GET /api/coach/runs', () => {
	it('gives a fresh owner zero totals and no runs', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			const body = await page(ownerId);
			expect(body.runs).toEqual([]);
			expect(body.nextBefore).toBeNull();
			expect(body.summary).toMatchObject({
				runs: 0,
				costMicros: 0,
				unpricedRuns: 0,
				tools: [],
				latencyMs: { p50: null, p95: null }
			});
		});
	});

	it('lists each run newest first, priced by the domain, a lookup at $0 and an unpriced one null', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			const seeded = await seedRuns(db, ownerId);
			// 2000 × 4 + 150 × 20 + 1500 × 5 = 18,500; 400 × 4 + 300 × 20 + 3500 × 0.2 = 8,300.
			expect(seeded.toolsCost).toBe(26_800);

			const body = await page(ownerId);
			expect(body.nextBefore).toBeNull();
			expect(body.runs).toEqual([
				{
					id: seeded.ids.declined,
					startedAt: '2026-11-10T07:02:02.435Z',
					status: 'refused',
					provider: 'mock',
					model: UNPRICED,
					stopReason: 'refusal',
					refusalCategory: 'cyber',
					modelCalls: 1,
					toolCalls: 0,
					inputTokens: 1_000,
					outputTokens: 20,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					costMicros: null,
					latencyMs: 1_200
				},
				{
					id: seeded.ids.direct,
					startedAt: '2026-11-10T07:01:02.400Z',
					status: 'completed',
					provider: 'direct',
					model: 'none',
					stopReason: null,
					refusalCategory: null,
					modelCalls: 0,
					toolCalls: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					costMicros: 0,
					latencyMs: 35
				},
				{
					id: seeded.ids.tools,
					startedAt: '2026-11-10T07:00:00.000Z',
					status: 'completed',
					provider: 'mock',
					model: OPUS,
					stopReason: 'end_turn',
					refusalCategory: null,
					modelCalls: 2,
					toolCalls: 2,
					inputTokens: 2_400,
					outputTokens: 450,
					cacheReadTokens: 3_500,
					cacheWriteTokens: 1_500,
					costMicros: seeded.toolsCost,
					latencyMs: 2_400
				}
			]);
			expect(body.summary).toMatchObject({
				runs: 3,
				modelCalls: 3,
				toolCalls: 2,
				tokens: {
					inputTokens: 3_400,
					outputTokens: 470,
					cacheReadTokens: 3_500,
					cacheWriteTokens: 1_500
				},
				costMicros: seeded.toolsCost,
				capCostMicros: seeded.toolsCost + seeded.declinedCap,
				unpricedRuns: 1,
				statuses: { completed: 2, refused: 1, running: 0 },
				tools: [
					{ name: 'get_performance_trends', calls: 1 },
					{ name: 'get_training_load', calls: 1 }
				]
			});
		});
	});

	it('pages newest first, with the totals on the first page only', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			const { ids } = await seedRuns(db, ownerId);

			const first = await page(ownerId, '?limit=2');
			expect(first.runs.map((r) => r.id)).toEqual([ids.declined, ids.direct]);
			expect(first.nextBefore).toBe(ids.direct);
			expect(first.summary?.runs).toBe(3);

			const second = await page(ownerId, `?limit=2&before=${first.nextBefore}`);
			expect(second).toEqual({
				summary: null,
				runs: [expect.objectContaining({ id: ids.tools })],
				nextBefore: null
			});
		});
	});

	it('answers 400 for a limit or a cursor that is not one', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			for (const query of ['?limit=0', '?limit=51', '?limit=two', '?limit=', '?before=nope']) {
				const response = await read(ownerId, query);
				expect(response.status, query).toBe(400);
				expect(response.headers.get('cache-control')).toBe('no-store');
				expect(await response.json()).toMatchObject({ error: 'invalid_request' });
			}
		});
	});

	it('shows no owner, thread or message id, and another owner none of the runs', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			await seedRuns(db, ownerId);
			const text = await (await read(ownerId)).text();
			expect(text).not.toMatch(/ownerId|threadId|triggerMessageId|promptVersion|owner_id/);
			expect(text).not.toContain(ownerId);

			const other = await page(crypto.randomUUID());
			expect(other.runs).toEqual([]);
			expect(other.summary).toMatchObject({ runs: 0, costMicros: 0, tools: [] });
		});
	});

	it('answers 429 past the coach.action limit', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			const { limit, windowMs } = RATE_LIMITS['coach.action'];
			const repo = createAuthRepository(db);
			let hits = 0;
			while (hits < limit)
				hits = await repo.hitRateLimit('coach.action:global', windowMs, new Date());

			const response = await read(ownerId);
			expect(response.status).toBe(429);
			expect(await response.json()).toMatchObject({ error: 'rate_limited' });
		});
	});
});
