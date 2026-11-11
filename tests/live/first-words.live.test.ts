/**
 * How soon the coach's first words arrive against claude-opus-5-5 (owner decision 2026-11-11):
 * what the mock's timing cannot tell. Opt-in and never in CI, gated like the rest of the live
 * suite (gate.ts): LIVE_LLM=1 with a key of your own (never the production key) runs it for real;
 * LIVE_LLM_DRY=1 plays it on the MockProvider; otherwise it is skipped and touches nothing.
 *
 * Two questions, each opening its own conversation, as POST /api/coach/turns runs them:
 * 1. a short, general question, which runs at low effort (prompt/effort.ts)
 * 2. a question about the owner's training, which keeps the chat setting (medium)
 * For each it records ttft_ms (the run's start to its first text) and the send to the first
 * words, as annotations to compare across runs. Properties only: no wall-clock bound, which a
 * shared network cannot hold.
 */
import { eq, sum } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CoachEvent } from '../../src/lib/domain/coach/events';
import { CHAT_EFFORT } from '../../src/lib/server/agent/prompt/layout';
import { QUICK_EFFORT } from '../../src/lib/server/agent/prompt/effort';
import { AnthropicProvider } from '../../src/lib/server/agent/provider/anthropic';
import { MockProvider } from '../../src/lib/server/agent/provider/mock';
import type { LlmProvider } from '../../src/lib/server/agent/provider/types';
import { runTurn } from '../../src/lib/server/agent/turn';
import { agentRuns, getDb } from '../../src/lib/server/db';
import { makeOwner } from '../integration/profile/fixtures';
import { LIVE_COST_CAP_MICROS, liveMode } from './gate';
import { START } from './seed';

const MODE = liveMode(process.env);

const provider: LlmProvider =
	MODE === 'live'
		? new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY })
		: new MockProvider(
				[{ name: 'answer', matches: () => true, steps: [{ text: '[note] A short answer.' }] }],
				{ overrides: () => ({}) }
			);

let owner = '';

async function spent(): Promise<number> {
	const [row] = await getDb()
		.select({ total: sum(agentRuns.capCostMicros).mapWith(Number) })
		.from(agentRuns)
		.where(eq(agentRuns.ownerId, owner));
	return row?.total ?? 0;
}

/** One turn on a new conversation: its run, and the send to its first words in milliseconds. */
async function firstWords(text: string) {
	expect(await spent()).toBeLessThanOrEqual(LIVE_COST_CAP_MICROS);
	const events: CoachEvent[] = [];
	const sentAt = performance.now();
	let firstWordsMs: number | null = null;
	for await (const event of runTurn(
		{
			ownerId: owner,
			threadId: null,
			clientMessageId: crypto.randomUUID(),
			text,
			signal: new AbortController().signal
		},
		{ provider: { status: 'ready', provider }, deps: { db: getDb(), now: () => new Date(START) } }
	)) {
		if (event.type === 'text_delta') firstWordsMs ??= performance.now() - sentAt;
		events.push(event);
	}
	const started = events.find((event) => event.type === 'run_started');
	expect(started?.type).toBe('run_started');
	const { runId } = started as Extract<CoachEvent, { type: 'run_started' }>;
	const [run] = await getDb().select().from(agentRuns).where(eq(agentRuns.id, runId));
	expect(await spent()).toBeLessThanOrEqual(LIVE_COST_CAP_MICROS);
	return { run: run!, firstWordsMs };
}

describe.skipIf(MODE === 'off')(
	`first words, ${MODE === 'live' ? 'live' : 'dry run on the mock'}`,
	() => {
		beforeAll(async () => {
			owner = await makeOwner(getDb());
		});

		it('1. a short, general question runs at low effort and records its first words', async ({
			annotate
		}) => {
			const { run, firstWordsMs } = await firstWords('What does RPE mean?');
			expect(run).toMatchObject({ status: 'completed', effort: QUICK_EFFORT });
			expect(run.ttftMs).not.toBeNull();
			expect(firstWordsMs).not.toBeNull();
			await annotate(
				`quick (${QUICK_EFFORT}): ttft_ms ${run.ttftMs}, send to first words ${Math.round(firstWordsMs!)} ms`
			);
		});

		it('2. a question about the owner’s training keeps the chat setting', async ({ annotate }) => {
			const { run, firstWordsMs } = await firstWords('Is my bench on track?');
			expect(run).toMatchObject({ status: 'completed', effort: CHAT_EFFORT });
			expect(run.ttftMs).not.toBeNull();
			await annotate(
				`chat (${CHAT_EFFORT}): ttft_ms ${run.ttftMs}, send to first words ${firstWordsMs === null ? 'none' : Math.round(firstWordsMs)} ms`
			);
		});
	}
);
