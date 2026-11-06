import { describe, expect, it } from 'vitest';
import {
	blockingLimit,
	COACH_MAX_DURATION_S,
	DAILY_COST_CAP_USD,
	DAILY_LIMITS,
	SEGMENT,
	toolDeadlineMs,
	TURN_BUDGET_START,
	TURN_LIMITS,
	turnBudget,
	turnLimits,
	type TurnBudget,
	type TurnLimits
} from './budgets';
import type { ModelUsage, TokenUsage } from './pricing';
import { TOOL_CATALOGUE, TOOL_NAMES } from './tools';

const READS = { drafts: false };
const DRAFTS = { drafts: true };
const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0): TokenUsage => ({
	inputTokens: input,
	outputTokens: output,
	cacheReadTokens: cacheRead,
	cacheWriteTokens: cacheWrite
});
const small = tokens(100, 10);

function calls(kind: 'chat' | 'draft', n: number, from: TurnBudget = TURN_BUDGET_START) {
	let budget = from;
	for (let i = 0; i < n; i++) budget = turnBudget(budget, { kind, usage: small });
	return budget;
}

/** Every time limit is positive, and each is inside the next: tool, drafting tool, turn, run. */
function expectOrdered(limits: TurnLimits, maxDurationS: number) {
	for (const ms of [limits.toolMs, limits.draftMs, limits.turnMs, limits.staleRunMs]) {
		expect(Number.isInteger(ms)).toBe(true);
		expect(ms).toBeGreaterThan(0);
	}
	expect(limits.toolMs).toBeLessThan(toolDeadlineMs(DRAFTS, Infinity, limits));
	expect(toolDeadlineMs(DRAFTS, Infinity, limits)).toBeLessThanOrEqual(limits.turnMs);
	expect(limits.draftMs).toBeLessThan(limits.turnMs);
	expect(limits.turnMs).toBeLessThan(maxDurationS * 1000);
	expect(maxDurationS * 1000).toBeLessThan(limits.staleRunMs);
}

describe('turn limits', () => {
	it('derive from the 180 s endpoint duration', () => {
		expect(COACH_MAX_DURATION_S).toBe(180);
		expect(TURN_LIMITS).toEqual(turnLimits(180));
		expect(TURN_LIMITS).toMatchObject({
			turnMs: 150_000,
			draftMs: 75_000,
			toolMs: 10_000,
			staleRunMs: 210_000
		});
		expect(toolDeadlineMs(READS, TURN_LIMITS.turnMs)).toBe(10_000);
		expect(toolDeadlineMs(DRAFTS, TURN_LIMITS.turnMs)).toBe(85_000);
		expectOrdered(TURN_LIMITS, 180);
	});

	it('still hold at the 60 s fallback duration', () => {
		const limits = turnLimits(60);
		expect(limits).toMatchObject({
			turnMs: 30_000,
			draftMs: 15_000,
			toolMs: 10_000,
			staleRunMs: 90_000
		});
		expect(toolDeadlineMs(READS, limits.turnMs, limits)).toBe(10_000);
		expect(toolDeadlineMs(DRAFTS, limits.turnMs, limits)).toBe(25_000);
		expectOrdered(limits, 60);
	});

	it('refuse a duration too short to fit a drafting tool inside the turn', () => {
		expectOrdered(turnLimits(50), 50);
		for (const seconds of [49, 30, 0, -1, 90.5, Number.NaN])
			expect(() => turnLimits(seconds)).toThrow(RangeError);
	});

	it('cap calls, drafts, tokens, concurrency and tool output per turn', () => {
		expect(TURN_LIMITS).toMatchObject({
			chatCalls: 8,
			drafts: 2,
			maxTokens: { chat: 16_000, draft: 32_000, summary: 8_000 },
			outputTokens: 40_000,
			inputTokens: 300_000,
			concurrency: 3,
			toolOutputBytes: 8 * 1024
		});
		// One call can never spend the whole turn's output on its own, except a draft by design.
		expect(TURN_LIMITS.maxTokens.chat).toBeLessThan(TURN_LIMITS.outputTokens);
		expect(TURN_LIMITS.maxTokens.draft).toBeLessThanOrEqual(TURN_LIMITS.outputTokens);
		expect(Object.isFrozen(TURN_LIMITS)).toBe(true);
		expect(Object.isFrozen(TURN_LIMITS.maxTokens)).toBe(true);
	});

	it('set a $5 daily cap and summarise a segment at 60K input tokens or 40 messages', () => {
		expect(DAILY_COST_CAP_USD).toBe(5);
		expect(DAILY_LIMITS).toEqual({ costMicros: 5_000_000 });
		expect(SEGMENT).toEqual({ inputTokens: 60_000, messages: 40 });
	});
});

describe('toolDeadlineMs', () => {
	it('gives a drafting tool its draft’s time as well, never past the turn', () => {
		expect(toolDeadlineMs(DRAFTS, 20_000)).toBe(20_000);
		expect(toolDeadlineMs(READS, 20_000)).toBe(10_000);
		expect(toolDeadlineMs(READS, 8_000)).toBe(8_000);
		expect(toolDeadlineMs(DRAFTS, 100_000)).toBe(85_000);
		expect(toolDeadlineMs(DRAFTS, 0)).toBe(0);
		expect(toolDeadlineMs(READS, -500)).toBe(0);
	});

	it('reads the catalogue: exactly its three drafting tools get the longer deadline', () => {
		const long = TOOL_NAMES.filter(
			(name) => toolDeadlineMs(TOOL_CATALOGUE[name], TURN_LIMITS.turnMs) === 85_000
		);
		expect(long).toEqual([
			'create_next_training_cycle',
			'propose_program_adjustment',
			'update_workout'
		]);
		for (const name of TOOL_NAMES)
			if (!long.includes(name))
				expect(toolDeadlineMs(TOOL_CATALOGUE[name], TURN_LIMITS.turnMs)).toBe(10_000);
	});
});

describe('turnBudget', () => {
	it('starts empty', () => {
		expect(TURN_BUDGET_START).toEqual({
			chatCalls: 0,
			drafts: 0,
			inputTokens: 0,
			outputTokens: 0,
			exhausted: null
		});
		expect(blockingLimit(TURN_BUDGET_START, 'chat')).toBeNull();
		expect(blockingLimit(TURN_BUDGET_START, 'draft')).toBeNull();
	});

	it('stops at the eighth chat call', () => {
		const seven = calls('chat', 7);
		expect(seven).toMatchObject({ chatCalls: 7, drafts: 0, exhausted: null });
		const eight = calls('chat', 1, seven);
		expect(eight).toMatchObject({ chatCalls: 8, exhausted: 'chat_calls' });
		expect(blockingLimit(eight, 'chat')).toBe('chat_calls');
		expect(blockingLimit(eight, 'draft')).toBe('chat_calls');
	});

	it('refuses a third draft but lets the turn go on answering', () => {
		const one = calls('draft', 1);
		expect(blockingLimit(one, 'draft')).toBeNull();
		const two = calls('draft', 1, one);
		expect(two).toMatchObject({ chatCalls: 0, drafts: 2, exhausted: null });
		expect(blockingLimit(two, 'draft')).toBe('drafts');
		expect(blockingLimit(two, 'chat')).toBeNull();
	});

	it('stops at 300K input tokens, cache reads and writes included', () => {
		const almost = turnBudget(TURN_BUDGET_START, {
			kind: 'chat',
			usage: tokens(100_000, 0, 150_000, 49_999)
		});
		expect(almost).toMatchObject({ inputTokens: 299_999, exhausted: null });
		const full = turnBudget(almost, { kind: 'draft', usage: tokens(1, 0) });
		expect(full).toMatchObject({ inputTokens: 300_000, exhausted: 'input_tokens' });
		expect(blockingLimit(full, 'chat')).toBe('input_tokens');
	});

	it('stops at 40K output tokens', () => {
		const almost = turnBudget(TURN_BUDGET_START, { kind: 'chat', usage: tokens(0, 39_999) });
		expect(almost.exhausted).toBeNull();
		const full = turnBudget(almost, { kind: 'chat', usage: tokens(0, 1) });
		expect(full).toMatchObject({ outputTokens: 40_000, exhausted: 'output_tokens' });
	});

	it('keeps the first limit reached, and counts every attempt of a fallback', () => {
		const out = turnBudget(TURN_BUDGET_START, { kind: 'chat', usage: tokens(0, 40_000) });
		const later = calls('chat', 8, out);
		expect(later).toMatchObject({ chatCalls: 9, exhausted: 'output_tokens' });
		expect(out).toMatchObject({ chatCalls: 1, outputTokens: 40_000 });
		expect(Object.isFrozen(later)).toBe(true);

		const fallback: ModelUsage = {
			...tokens(1_000, 200, 5_000, 0),
			iterations: [
				{ kind: 'message', model: 'claude-opus-5-5', ...tokens(1_000, 50, 5_000, 0) },
				{ kind: 'fallback_message', model: 'claude-opus-5', ...tokens(1_000, 200, 5_000, 0) }
			]
		};
		expect(turnBudget(TURN_BUDGET_START, { kind: 'chat', usage: fallback })).toMatchObject({
			chatCalls: 1,
			inputTokens: 12_000,
			outputTokens: 250
		});
	});
});
