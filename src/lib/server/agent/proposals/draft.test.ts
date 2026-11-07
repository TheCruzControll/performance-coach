import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/mini';
import { TURN_LIMITS } from '../../../domain/coach/budgets.ts';
import { proposalDraftSchema } from '../../../domain/coach/proposals.ts';
import { BLOCK, EXERCISE, FIXTURES } from '../../../../../tests/fixtures/coach-proposals.ts';
import { DRAFTER_PROMPT } from '../prompt/drafter.ts';
import { MockProvider, type MockStep } from '../provider/mock.ts';
import { COACH_MODEL, type LlmProvider } from '../provider/types.ts';
import { validateRequest } from '../provider/validate.ts';
import { toolContext } from '../tools/context.ts';
import { defineTool } from '../tools/define.ts';
import { executeToolCalls } from '../tools/execute.ts';
import { toStrictJsonSchema } from '../tools/schema.ts';
import {
	DRAFT_KINDS,
	draftProposal,
	DraftError,
	type DraftCallRecord,
	type DraftContext,
	type DraftKind
} from './draft.ts';

const SECOND = 1000;
const INTENT = {
	request: 'Plan the next block around a squat 3RM test',
	data: { block: { lineage: BLOCK, phase: 'accumulation' }, exercises: [EXERCISE] }
};

const draftOf = (kind: DraftKind) => {
	const { title, rationale, payload } = FIXTURES[kind];
	return { title, rationale, payload };
};
const playing = (...steps: MockStep[]) =>
	new MockProvider([{ name: 'draft', matches: () => true, steps }], { overrides: () => ({}) });

function context(provider: LlmProvider, leftMs: number = TURN_LIMITS.draftMs) {
	const calls: DraftCallRecord[] = [];
	const ctx: DraftContext = {
		runId: 'run-1',
		signal: new AbortController().signal,
		deadlineAt: Date.now() + leftMs,
		provider,
		onCall: (call) => void calls.push(call)
	};
	return { ctx, calls };
}

async function failure(promise: Promise<unknown>): Promise<DraftError> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(DraftError);
	return error as DraftError;
}

beforeEach(() => {
	vi.useFakeTimers({ now: new Date('2026-11-06T09:00:00Z') });
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('draftProposal', () => {
	it.each(DRAFT_KINDS)('gives the %s draft the model wrote, parsed by its schema', async (kind) => {
		const { ctx } = context(playing({ json: draftOf(kind) }));
		await expect(draftProposal(kind, INTENT, ctx)).resolves.toEqual(draftOf(kind));
	});

	it('refuses a draft that breaks a constraint its JSON Schema dropped', async () => {
		const cycle = draftOf('next_cycle');
		const same = {
			...cycle,
			payload: {
				...(cycle.payload as object),
				rotation: [{ fromExerciseId: EXERCISE, toExerciseId: EXERCISE }]
			}
		};
		// The strict JSON Schema cannot say "a different exercise": zod's refinement is gone.
		expect(JSON.stringify(toStrictJsonSchema(proposalDraftSchema('next_cycle')))).not.toContain(
			'different'
		);
		const { ctx, calls } = context(playing({ json: same }));
		const error = await failure(draftProposal('next_cycle', INTENT, ctx));
		expect(error).toMatchObject({ code: 'DRAFT_FAILED', reason: 'invalid_output' });

		// The rejected draft was completed and billed, so its usage still counts.
		expect(calls).toEqual([
			expect.objectContaining({
				model: COACH_MODEL,
				requestId: expect.stringMatching(/^req_mock_/),
				error: 'invalid_output'
			})
		]);
		expect(calls[0]!.usage.outputTokens).toBeGreaterThan(0);
		expect(calls[0]!.capCostMicros).toBeGreaterThan(0);
	});

	it('checks the value again, whatever the provider let through', async () => {
		const provider = playing({ json: draftOf('workout_update') });
		const bad = { ...draftOf('workout_update'), title: 'x'.repeat(81) };
		vi.spyOn(provider, 'structured').mockImplementation(async (request, _schema, signal) => ({
			...(await provider.stream(request, signal).final()),
			value: bad
		}));
		const { ctx } = context(provider);
		const error = await failure(draftProposal('workout_update', INTENT, ctx));
		expect(error.reason).toBe('invalid_output');
		expect(error.details).toMatchObject({ issues: { title: 'Up to 80 characters' } });
	});

	it('turns a refusal, a cut-off draft and a failed call into DraftErrors', async () => {
		const refused = context(
			playing({ refusal: { category: 'cyber', explanation: 'Declined' }, json: {} })
		);
		expect(await failure(draftProposal('program_adjustment', INTENT, refused.ctx))).toMatchObject({
			reason: 'refused',
			details: { reason: 'refused', category: 'cyber' }
		});

		const cut = context(playing({ json: draftOf('program_adjustment'), stop: 'max_tokens' }));
		expect(await failure(draftProposal('program_adjustment', INTENT, cut.ctx))).toMatchObject({
			reason: 'max_tokens'
		});

		const down = context(playing({ fault: { kind: 'overloaded' } }));
		expect(await failure(draftProposal('program_adjustment', INTENT, down.ctx))).toMatchObject({
			reason: 'provider_error',
			details: { error: 'overloaded' }
		});
	});

	it('sends a request the API accepts: the kind’s schema, effort high, 32K tokens, no tools, the cached prompt', async () => {
		for (const kind of DRAFT_KINDS) {
			const provider = playing({ json: draftOf(kind) });
			const structured = vi.spyOn(provider, 'structured');
			const { ctx } = context(provider);
			await draftProposal(kind, INTENT, ctx);

			expect(structured).toHaveBeenCalledOnce();
			const [request, schema, signal] = structured.mock.calls[0]!;
			expect(validateRequest(request)).toEqual([]);
			expect(request).not.toHaveProperty('tools');
			expect(request.output_config).toEqual({ effort: 'high' });
			expect(request.max_tokens).toBe(32_000);
			expect(request.system).toEqual([
				{ type: 'text', text: DRAFTER_PROMPT, cache_control: { type: 'ephemeral' } }
			]);
			expect(JSON.stringify(request.messages)).toContain(INTENT.request);
			expect(JSON.stringify(request.messages)).toContain(BLOCK);
			// The format the provider sends is the kind's strict JSON Schema.
			expect(toStrictJsonSchema(schema as z.ZodMiniType)).toEqual(
				toStrictJsonSchema(proposalDraftSchema(kind))
			);
			expect(signal).toBe(ctx.signal);
		}
	});

	it('records every call with purpose draft, failed ones included', async () => {
		const done = context(playing({ json: draftOf('next_cycle') }));
		await draftProposal('next_cycle', INTENT, done.ctx);
		expect(done.calls).toEqual([
			expect.objectContaining({
				purpose: 'draft',
				kind: 'next_cycle',
				model: COACH_MODEL,
				stopReason: 'end_turn',
				error: null,
				requestId: expect.stringMatching(/^req_mock_/)
			})
		]);
		const [call] = done.calls;
		expect(call!.usage.inputTokens + call!.usage.cacheWriteTokens).toBeGreaterThan(0);
		expect(call!.usage.outputTokens).toBeGreaterThan(0);
		expect(call!.costMicros).toBeGreaterThan(0);
		expect(call!.capCostMicros).toBe(call!.costMicros);

		const refused = context(playing({ refusal: { category: 'bio' }, json: {} }));
		await failure(draftProposal('next_cycle', INTENT, refused.ctx));
		expect(refused.calls).toEqual([
			expect.objectContaining({ purpose: 'draft', stopReason: 'refusal', refusalCategory: 'bio' })
		]);

		const down = context(playing({ fault: { kind: 'rate_limited' } }));
		await failure(draftProposal('next_cycle', INTENT, down.ctx));
		expect(down.calls).toEqual([
			expect.objectContaining({ purpose: 'draft', model: null, error: 'rate_limited' })
		]);
	});

	it('completes a 40 s draft inside a drafting tool’s 85 s deadline', async () => {
		const provider = playing({
			json: draftOf('next_cycle'),
			delayMs: 40 * SECOND,
			chunkChars: 1e6
		});
		const tool = defineTool({
			name: 'create_next_training_cycle',
			description: 'Drafts the next cycle.',
			input: z.object({ request: z.string() }),
			output: z.object({ title: z.string() }),
			run: async ({ request }, ctx) =>
				draftProposal('next_cycle', { request, data: INTENT.data }, { ...ctx, provider })
		});
		const ctx = toolContext({
			session: { ownerId: '00000000-0000-4000-8000-000000000001' },
			message: { threadId: 'thread-1', runId: 'run-1', text: 'Plan my next block', entry: null },
			day: { today: '2026-11-06', timeZone: 'Europe/London' },
			runtime: { deps: {}, serialTools: false },
			signal: new AbortController().signal,
			deadlineAt: Date.now() + TURN_LIMITS.turnMs,
			matchExercise: () => null
		});
		expect(TURN_LIMITS.toolMs + TURN_LIMITS.draftMs).toBe(85 * SECOND);

		let settled = false;
		const executed = executeToolCalls(
			[{ id: 'toolu_1', name: 'create_next_training_cycle', input: { request: INTENT.request } }],
			ctx,
			{ tools: [tool] }
		).then((result) => ((settled = true), result));
		await vi.advanceTimersByTimeAsync(40 * SECOND - 1);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		const { outcomes } = await executed;
		expect(outcomes[0]).toMatchObject({ status: 'succeeded', output: draftOf('next_cycle') });
		expect(outcomes[0]!.durationMs).toBe(40 * SECOND);
	});

	it('makes no call when less than draftMs is left', async () => {
		const provider = playing({ json: draftOf('workout_update') });
		const structured = vi.spyOn(provider, 'structured');
		const short = context(provider, TURN_LIMITS.draftMs - 1);
		const error = await failure(draftProposal('workout_update', INTENT, short.ctx));
		expect(error).toMatchObject({ reason: 'draft_unavailable', code: 'DRAFT_FAILED' });
		expect(structured).not.toHaveBeenCalled();
		expect(short.calls).toEqual([]);

		const enough = context(provider, TURN_LIMITS.draftMs);
		await expect(draftProposal('workout_update', INTENT, enough.ctx)).resolves.toEqual(
			draftOf('workout_update')
		);
		expect(structured).toHaveBeenCalledOnce();
	});
});
