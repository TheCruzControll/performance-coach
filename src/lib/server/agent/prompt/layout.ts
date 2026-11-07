/**
 * Every coach chat request, laid out for the prompt cache (the claude-api skill's prompt-caching
 * rules). Render order is tools, then system, then messages:
 *
 *   tools        the registry's definitions, sorted by name, frozen
 *   system       SYSTEM_PROMPT, one block with an explicit breakpoint: tools and system are
 *                cached together and read back by every request of every segment
 *   messages     the segment preamble (the memory, as data), the stored transcript verbatim, and
 *                this turn's context message while it is not yet stored
 *   cache_control  top-level automatic caching: a second breakpoint on the last block, so each
 *                request reads everything the previous one wrote
 *
 * Nothing volatile sits before a breakpoint it would move: the date, the week and the decided
 * proposals live in the context message, which follows the owner's message. The transcript only
 * grows: the context message is stored with the turn's first completed step and replayed
 * unchanged, so request n+1 starts with request n's exact bytes, even when the program changes
 * between them.
 *
 * buildModelRequest refuses (LayoutError) any request the API would refuse (validateRequest: at
 * most 4 breakpoints, never ending on the assistant, a system message only after a user message),
 * and an owner message left without its context message.
 */
import type {
	BetaMessageParam,
	BetaSystemMessageParam,
	BetaTool,
	BetaUserMessageParam
} from '@anthropic-ai/sdk/resources/beta/messages';
import { TURN_LIMITS } from '../../../domain/coach/budgets.ts';
import type { Effort, ModelRequest } from '../provider/types.ts';
import { validateRequest, type RequestIssue } from '../provider/validate.ts';
import { toolDefinitionsForRequest } from '../tools/registry.ts';
import { SYSTEM_PROMPT } from './system.ts';

/** Chat turns run at medium effort (the plan's effort decisions); drafts and summaries set theirs. */
export const CHAT_EFFORT: Effort = 'medium';

export interface LayoutInput {
	/** The message the segment opened with (segmentPreamble), exactly as first sent. */
	preamble: BetaUserMessageParam;
	/** The segment's stored messages, oldest first, verbatim. */
	transcript: readonly BetaMessageParam[];
	/** This turn's context message (turnContext) until it is stored; then null. */
	context: BetaSystemMessageParam | null;
	effort?: Effort;
	maxTokens?: number;
	/** The registry's definitions by default. */
	tools?: readonly Readonly<BetaTool>[];
}

export class LayoutError extends Error {
	readonly issues: readonly RequestIssue[];

	constructor(message: string, issues: readonly RequestIssue[] = []) {
		super(message);
		this.name = 'LayoutError';
		this.issues = issues;
	}
}

/** An owner's message: a user message that is not only tool results. */
function isOwnerMessage(message: BetaMessageParam | undefined): boolean {
	if (message?.role !== 'user') return false;
	const { content } = message;
	return typeof content === 'string' || content.some((block) => block.type !== 'tool_result');
}

export function buildModelRequest(input: LayoutInput): ModelRequest {
	const tools = [...(input.tools ?? toolDefinitionsForRequest())] as BetaTool[];
	const messages: BetaMessageParam[] = [
		input.preamble,
		...input.transcript,
		...(input.context ? [input.context] : [])
	];
	if (input.transcript.length > 0 && isOwnerMessage(messages.at(-1)))
		throw new LayoutError("The owner's message needs this turn's context message after it");

	const request: ModelRequest = {
		max_tokens: input.maxTokens ?? TURN_LIMITS.maxTokens.chat,
		...(tools.length > 0 && { tools }),
		system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
		messages,
		output_config: { effort: input.effort ?? CHAT_EFFORT },
		cache_control: { type: 'ephemeral' }
	};
	const issues = validateRequest(request);
	if (issues.length > 0)
		throw new LayoutError(
			`The request would be refused: ${issues.map((issue) => `${issue.rule} at ${issue.at}`).join('; ')}`,
			issues
		);
	return request;
}
