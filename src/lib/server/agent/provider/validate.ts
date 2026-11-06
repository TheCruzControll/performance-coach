/**
 * The request rules every coach call must meet, checked before it is sent: the shapes the
 * 2026-10-21 Messages API refuses with a 400 on claude-opus-5-5, plus the coach's own invariants
 * (marked "coach" below) that keep its prompt cache-stable and its tool calls schema-valid. The
 * MockProvider refuses any request that breaks one, so every test exercises exactly what the real
 * API would accept, and the Anthropic provider's recorded request is checked with it too.
 *
 * It reads fields that ModelRequest's type does not allow (temperature, thinking, tool_choice),
 * because a spread or a cast can still carry them into a body.
 */
import type {
	BetaContentBlockParam,
	BetaMessageParam,
	MessageCountTokensParams,
	MessageCreateParams
} from '@anthropic-ai/sdk/resources/beta/messages';
import { EFFORTS, type Effort, type ModelRequest } from './types.ts';

/** The most cache_control breakpoints a request may carry, top-level automatic caching included. */
export const MAX_BREAKPOINTS = 4;

export const REQUEST_RULE = {
	no_messages: 'A request needs at least one message',
	first_not_user: 'The first message must be a user message',
	prefill: 'The last message must not be the assistant’s: Opus 5.5 refuses a prefill',
	orphan_tool_use: 'Every tool_use needs its tool_result in the next user message',
	split_tool_results: 'All of a step’s tool_results go in one user message (coach)',
	orphan_tool_result: 'A tool_result must answer a tool_use in the message just before it',
	tool_result_not_first: 'Tool results come before any other block of their message',
	misplaced_system:
		'A mid-conversation system message follows a user message, and is last or followed by an assistant message',
	too_many_breakpoints: `A request carries at most ${MAX_BREAKPOINTS} cache breakpoints`,
	tools_unsorted: 'Tools are sorted by name, each once, so the prefix is byte-stable (coach)',
	tool_not_strict: 'Every tool is a custom tool with strict: true (coach)',
	tool_schema_open: 'Every object in a tool’s input schema sets additionalProperties: false',
	tool_choice:
		'tool_choice is absent or auto: Opus 5.5 refuses forced tool use, and the coach never turns tools off',
	thinking: 'thinking is absent or adaptive: Opus 5.5 refuses disabled thinking and budget_tokens',
	sampling: 'temperature, top_p and top_k are refused on 2026-10-21',
	assistant_document: 'A document block cannot sit directly in an assistant message',
	cited_user_text: 'A text block with citations cannot be sent in a user message',
	no_effort: 'output_config.effort is always set (coach: Opus 5.5’s default is not assumed)'
};
export type RequestRule = keyof typeof REQUEST_RULE;

export interface RequestIssue {
	rule: RequestRule;
	/** Where, as a path into the body: 'messages[3].content[2]', 'tools[1]'. */
	at: string;
}

export type RequestBody = ModelRequest | MessageCreateParams | MessageCountTokensParams;

type Block = BetaContentBlockParam;
const SAMPLING = ['temperature', 'top_p', 'top_k'] as const;
/** Schema keywords whose value is a map of subschemas, and those whose value is one or a list. */
const SCHEMA_MAPS = ['properties', '$defs', 'definitions'] as const;
const SCHEMA_CHILDREN = ['items', 'prefixItems', 'anyOf', 'oneOf', 'allOf', 'not'] as const;

/** Every rule the request breaks, in body order; empty when it may be sent. */
export function validateRequest(request: RequestBody): RequestIssue[] {
	const issues: RequestIssue[] = [];
	const flag = (rule: RequestRule, at: string) => void issues.push({ rule, at });
	const body = request as unknown as Record<string, unknown>;

	for (const field of SAMPLING) if (body[field] !== undefined) flag('sampling', field);
	const thinking = body.thinking as { type?: string; budget_tokens?: unknown } | undefined;
	if (thinking && (thinking.type !== 'adaptive' || 'budget_tokens' in thinking))
		flag('thinking', 'thinking');
	const choice = body.tool_choice as { type?: string } | undefined;
	if (choice && choice.type !== 'auto') flag('tool_choice', 'tool_choice');
	const effort = (body.output_config as { effort?: string } | undefined)?.effort;
	if (!EFFORTS.includes(effort as Effort)) flag('no_effort', 'output_config.effort');

	checkTools(request.tools ?? [], flag);
	checkMessages(request.messages, flag);
	if (breakpoints(request) > MAX_BREAKPOINTS) flag('too_many_breakpoints', 'cache_control');
	return issues;
}

type Flag = (rule: RequestRule, at: string) => void;

function checkTools(tools: readonly unknown[], flag: Flag) {
	let previous: string | undefined;
	tools.forEach((each, index) => {
		const tool = each as { name?: string; type?: string | null; strict?: boolean };
		const at = `tools[${index}]`;
		const name = tool.name ?? '';
		if (previous !== undefined && !(previous < name)) flag('tools_unsorted', at);
		previous = name;
		if ((tool.type ?? 'custom') !== 'custom' || tool.strict !== true) flag('tool_not_strict', at);
		if (!closed((each as { input_schema?: unknown }).input_schema))
			flag('tool_schema_open', `${at}.input_schema`);
	});
}

/** True when every object schema in it, at any depth, sets additionalProperties: false. */
function closed(schema: unknown): boolean {
	if (Array.isArray(schema)) return schema.every(closed);
	if (!schema || typeof schema !== 'object') return true;
	const node = schema as Record<string, unknown>;
	const types = Array.isArray(node.type) ? node.type : [node.type];
	if ((types.includes('object') || 'properties' in node) && node.additionalProperties !== false)
		return false;
	return (
		SCHEMA_MAPS.every((key) => closed(Object.values(node[key] ?? {}))) &&
		SCHEMA_CHILDREN.every((key) => closed(node[key]))
	);
}

const blocksOf = (message: BetaMessageParam | undefined): Block[] => {
	const content = message?.content;
	return Array.isArray(content) ? (content as Block[]) : [];
};

const toolUseIds = (message: BetaMessageParam | undefined) =>
	message?.role === 'assistant'
		? blocksOf(message).flatMap((block) => (block.type === 'tool_use' ? [block.id] : []))
		: [];

const resultIds = (message: BetaMessageParam | undefined) =>
	message?.role === 'user'
		? blocksOf(message).flatMap((block) =>
				block.type === 'tool_result' ? [block.tool_use_id] : []
			)
		: [];

function checkMessages(messages: readonly BetaMessageParam[], flag: Flag) {
	if (messages.length === 0) return flag('no_messages', 'messages');
	if (messages[0]!.role !== 'user') flag('first_not_user', 'messages[0]');
	if (messages.at(-1)!.role === 'assistant') flag('prefill', `messages[${messages.length - 1}]`);

	messages.forEach((message, index) => {
		const at = `messages[${index}]`;
		const blocks = blocksOf(message);
		if (message.role === 'system') {
			const next = messages[index + 1];
			if (messages[index - 1]?.role !== 'user' || (next && next.role !== 'assistant'))
				flag('misplaced_system', at);
		} else if (message.role === 'assistant') {
			const answered = new Set(resultIds(messages[index + 1]));
			const later = new Set(messages.slice(index + 2).flatMap(resultIds));
			blocks.forEach((block, position) => {
				const where = `${at}.content[${position}]`;
				if (block.type === 'document') flag('assistant_document', where);
				if (block.type === 'tool_use' && !answered.has(block.id))
					flag(later.has(block.id) ? 'split_tool_results' : 'orphan_tool_use', where);
			});
		} else {
			const asked = new Set(toolUseIds(messages[index - 1]));
			let other = false;
			let late = false;
			blocks.forEach((block, position) => {
				const where = `${at}.content[${position}]`;
				if (block.type !== 'tool_result') other = true;
				else {
					// Once per message: the first result that comes after another block.
					if (other && !late) flag('tool_result_not_first', where);
					late ||= other;
					if (!asked.has(block.tool_use_id)) flag('orphan_tool_result', where);
				}
				if (cited(block)) flag('cited_user_text', where);
			});
		}
	});
}

/** A text block with citations, directly or inside a search result or a tool result. */
function cited(block: unknown): boolean {
	const node = block as { type?: string; citations?: unknown; content?: unknown };
	if (node.type === 'text') return Array.isArray(node.citations) && node.citations.length > 0;
	if (node.type === 'search_result' || node.type === 'tool_result')
		return Array.isArray(node.content) && node.content.some(cited);
	return false;
}

const marked = (value: unknown) =>
	Boolean((value as { cache_control?: unknown } | null)?.cache_control);

/** Explicit breakpoints on tools, system blocks and message blocks, plus automatic caching. */
function breakpoints(request: RequestBody): number {
	const system = Array.isArray(request.system) ? request.system : [];
	const blocks = request.messages.flatMap((message) =>
		blocksOf(message).flatMap((block): unknown[] =>
			block.type === 'tool_result' && Array.isArray(block.content)
				? [block, ...block.content]
				: [block]
		)
	);
	const explicit = [...(request.tools ?? []), ...system, ...blocks].filter(marked).length;
	return explicit + (request.cache_control ? 1 : 0);
}
