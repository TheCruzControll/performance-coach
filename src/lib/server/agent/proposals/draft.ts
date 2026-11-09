/**
 * The drafter: turns a propose tool's small intent (what the coach wants changed, and the data it
 * rests on) into a proposal payload that passes its kind's schema. Three kinds are drafted this
 * way (the plan's payload decisions): program_adjustment, workout_update and next_cycle. The
 * others come from strict tool inputs or M3's preview, with no second call.
 *
 * A draft is its own structured-output call, never part of the chat:
 * - output_config.format comes from the kind's schema (proposalDraftSchema): the provider turns
 *   the zod/mini schema it is handed into the strict JSON Schema it sends, at effort high, with up
 *   to TURN_LIMITS.maxTokens.draft output tokens and no tools
 * - the system prompt is DRAFTER_PROMPT, frozen, on its own cache breakpoint
 * - it runs inside the calling tool's time: ctx.signal stops it, and with less than draftMs left
 *   before ctx.deadlineAt it is not sent at all (draft_unavailable)
 * - a refusal, max_tokens, output that fails the schema or a provider error is a DraftError, a
 *   ToolError the tool runner answers as is_error, so nothing unvalidated reaches a proposal
 * - the result is parsed again here with the full zod schema, whatever the provider checked,
 *   because JSON Schema drops bounds and refinements that zod states
 * - every call, failed ones included, goes to ctx.onCall with purpose 'draft', for the run's
 *   model-call rows and the turn's draft budget (turnBudget with kind 'draft')
 *
 * Logs carry ids, counts and the kind, never the request or the data.
 */
import { TURN_LIMITS, type TurnLimits } from '../../../domain/coach/budgets.ts';
import { capCostMicros, costMicros } from '../../../domain/coach/pricing.ts';
import {
	canonicalJson,
	proposalDraftSchema,
	type ProposalDraft,
	type ProposalKind
} from '../../../domain/coach/proposals.ts';
import { validate } from '../../../domain/validation.ts';
import { logger } from '../../observability/logger.ts';
import type { ModelCallRecord } from '../hooks.ts';
import { modelUsage } from '../orchestrator.ts';
import { DRAFTER_PROMPT } from '../prompt/drafter.ts';
import {
	CoachProviderError,
	type Effort,
	type LlmProvider,
	type ModelRequest,
	type StructuredResult
} from '../provider/types.ts';
import type { ToolContext } from '../tools/context.ts';
import { ToolError } from '../tools/output.ts';

/** The kinds a structured-output draft produces. */
export const DRAFT_KINDS = [
	'program_adjustment',
	'workout_update',
	'next_cycle'
] as const satisfies readonly ProposalKind[];
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** Drafts run at high effort (the plan's effort decisions): a payload is checked, then shown. */
export const DRAFT_EFFORT: Effort = 'high';

/** What a propose tool asks for: the coach's request in its words, and the records it rests on. */
export interface DraftIntent {
	request: string;
	/** Plain JSON data (canonical JSON refuses anything else); stored text as untrusted_text. */
	data: unknown;
}

/**
 * Why a draft failed:
 * - draft_unavailable: less than draftMs was left, or no drafter is at hand, so no call was made
 * - drafts_spent: the turn has made its TURN_LIMITS.drafts drafts, so no call was made
 * - refused: the model declined (stop_reason refusal)
 * - max_tokens: the draft was cut off
 * - invalid_output: the output is not JSON, or fails the kind's schema
 * - provider_error: the call failed (overloaded, rate limited, aborted…)
 */
export type DraftFailure =
	| 'draft_unavailable'
	| 'drafts_spent'
	| 'refused'
	| 'max_tokens'
	| 'invalid_output'
	| 'provider_error';

const FAILURE_MESSAGE: Record<DraftFailure, string> = {
	draft_unavailable:
		'Not enough time is left in this turn to draft the change; tell the owner and offer to try again',
	drafts_spent:
		'This turn has drafted all the changes it may; tell the owner what you would change and offer to draft it next',
	refused: 'The change could not be drafted; describe a different change or answer without one',
	max_tokens: 'The draft was too long; propose fewer changes at once',
	invalid_output:
		'The draft failed the proposal’s checks; nothing was stored. Describe the change more precisely or try again',
	provider_error: 'The drafter is unavailable right now; nothing was stored. Try again later'
};

export class DraftError extends ToolError {
	readonly reason: DraftFailure;

	constructor(reason: DraftFailure, details: Record<string, unknown> = {}) {
		super('DRAFT_FAILED', FAILURE_MESSAGE[reason], { reason, ...details });
		this.name = 'DraftError';
		this.reason = reason;
	}
}

/** One draft call, as the run's model-call rows store it; the turn gives it its index. */
export interface DraftCallRecord extends Omit<ModelCallRecord, 'index'> {
	purpose: 'draft';
	kind: DraftKind;
}

/** What a draft needs from its tool's context, and the provider the turn runs on. */
export interface DraftContext extends Pick<ToolContext, 'runId' | 'signal' | 'deadlineAt'> {
	provider: LlmProvider;
	onCall?: (call: DraftCallRecord) => void | Promise<void>;
	limits?: TurnLimits;
}

/** The draft's request: the frozen, cached prompt, then the kind, the request and the data. */
export function draftRequest(
	kind: DraftKind,
	intent: DraftIntent,
	limits: TurnLimits = TURN_LIMITS
): Omit<ModelRequest, 'tools'> {
	const text = [
		`Kind: ${kind}`,
		`Request: ${intent.request}`,
		`Data: ${canonicalJson(intent.data)}`
	].join('\n\n');
	return {
		max_tokens: limits.maxTokens.draft,
		system: [{ type: 'text', text: DRAFTER_PROMPT, cache_control: { type: 'ephemeral' } }],
		messages: [{ role: 'user', content: [{ type: 'text', text }] }],
		output_config: { effort: DRAFT_EFFORT }
	};
}

/**
 * A drafting tool's draft: the turn's drafter (ctx.drafter) within the call's own signal and
 * deadline, once the turn admits another draft. With no drafter, nothing is drafted.
 */
export function draftInTool<K extends DraftKind>(
	kind: K,
	intent: DraftIntent,
	ctx: Pick<ToolContext, 'runId' | 'signal' | 'deadlineAt' | 'drafter'>
): Promise<ProposalDraft<K>> {
	const { drafter } = ctx;
	if (!drafter) return Promise.reject(new DraftError('draft_unavailable'));
	if (!drafter.admit()) return Promise.reject(new DraftError('drafts_spent'));
	const { runId, signal, deadlineAt } = ctx;
	return draftProposal(kind, intent, {
		runId,
		signal,
		deadlineAt,
		provider: drafter.provider,
		onCall: drafter.onCall
	});
}

export async function draftProposal<K extends DraftKind>(
	kind: K,
	intent: DraftIntent,
	ctx: DraftContext
): Promise<ProposalDraft<K>> {
	const limits = ctx.limits ?? TURN_LIMITS;
	const leftMs = ctx.deadlineAt - Date.now();
	if (leftMs < limits.draftMs) throw new DraftError('draft_unavailable', { leftMs });

	const schema = proposalDraftSchema(kind);
	const request = draftRequest(kind, intent, limits);
	const startedAt = Date.now();
	let result: StructuredResult<unknown> | null = null;
	let failed: CoachProviderError | null = null;
	try {
		result = await ctx.provider.structured(request, schema, ctx.signal);
	} catch (error) {
		if (!(error instanceof CoachProviderError)) throw error;
		failed = error;
	}

	// Output that fails the schema was still completed and billed: record its usage.
	const completed = result ?? failed?.result ?? null;
	const message = completed?.message ?? null;
	const usage = message ? modelUsage(message.usage, message.model) : null;
	const record: DraftCallRecord = {
		purpose: 'draft',
		kind,
		requestId: completed?.requestId ?? null,
		model: message?.model ?? null,
		stopReason: message?.stop_reason ?? null,
		refusalCategory: message?.stop_details?.category ?? null,
		usage: usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
		costMicros: usage && message ? costMicros(usage, message.model) : 0,
		capCostMicros: usage && message ? capCostMicros(usage, message.model) : 0,
		ttftMs: null,
		latencyMs: Date.now() - startedAt,
		error: failed?.kind ?? null
	};
	logger.info('coach model call', {
		runId: ctx.runId,
		purpose: 'draft',
		kind,
		requestId: record.requestId,
		model: record.model,
		stopReason: record.stopReason,
		refusalCategory: record.refusalCategory,
		...record.usage,
		latencyMs: record.latencyMs,
		error: record.error
	});
	await ctx.onCall?.(record);

	if (failed)
		throw failed.kind === 'invalid_output'
			? new DraftError('invalid_output')
			: new DraftError('provider_error', { error: failed.kind });
	if (message?.stop_reason === 'refusal')
		throw new DraftError('refused', { category: record.refusalCategory });
	if (message?.stop_reason === 'max_tokens') throw new DraftError('max_tokens');
	const checked = validate(schema, result?.value);
	if (!checked.ok) throw new DraftError('invalid_output', { issues: checked.errors });
	return checked.data as ProposalDraft<K>;
}
