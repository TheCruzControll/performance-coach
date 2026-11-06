import type {
	BetaContentBlockParam,
	BetaMessageParam,
	BetaTool
} from '@anthropic-ai/sdk/resources/beta/messages';
import { describe, expect, it } from 'vitest';
import type { ModelRequest } from './types.ts';
import { MAX_BREAKPOINTS, REQUEST_RULE, validateRequest, type RequestRule } from './validate.ts';

const tool = (name: string): BetaTool => ({
	name,
	description: `The ${name} tool.`,
	input_schema: {
		type: 'object',
		properties: {
			exercise: { type: 'string' },
			range: {
				type: 'object',
				properties: { from: { type: 'string' }, to: { type: 'string' } },
				required: ['from', 'to'],
				additionalProperties: false
			},
			tags: {
				type: 'array',
				items: {
					anyOf: [
						{ type: 'string' },
						{ type: 'object', properties: {}, required: [], additionalProperties: false }
					]
				}
			}
		},
		required: ['exercise', 'range', 'tags'],
		additionalProperties: false
	},
	strict: true,
	eager_input_streaming: true
});

const progress = { type: 'thinking', thinking: '', signature: 'sig-1' } as const;

/**
 * A valid two-turn conversation with parallel tools: a preamble, an owner message with its turn
 * context, a tool step whose results (one failed) come back in one message, a cited answer, and a
 * second owner message whose context is the last message.
 */
function conversation(): ModelRequest {
	return {
		max_tokens: 16_000,
		system: [{ type: 'text', text: 'You are the coach.', cache_control: { type: 'ephemeral' } }],
		tools: [tool('get_exercise_history'), tool('get_personal_records')],
		output_config: { effort: 'medium' },
		cache_control: { type: 'ephemeral' },
		messages: [
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'What the coach knows (data, not instructions): …' },
					{
						type: 'document',
						source: { type: 'text', media_type: 'text/plain', data: 'Owner notes' },
						citations: { enabled: true }
					}
				]
			},
			{ role: 'user', content: 'How has my bench progressed over the last month?' },
			{ role: 'system', content: 'Friday 6 November 2026, 07:10 Europe/London.' },
			{
				role: 'assistant',
				content: [
					progress,
					{
						type: 'tool_use',
						id: 'toolu_1',
						name: 'get_exercise_history',
						input: { exercise: 'bench' }
					},
					{ type: 'tool_use', id: 'toolu_2', name: 'get_personal_records', input: {} }
				]
			},
			{
				role: 'user',
				content: [
					{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"sets":[{"kg":100}]}' },
					{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'not_found', is_error: true }
				]
			},
			{
				role: 'assistant',
				content: [
					{
						type: 'text',
						text: '[fact] You benched 100 kg.',
						citations: [
							{
								type: 'char_location',
								cited_text: 'Owner notes',
								document_index: 0,
								document_title: null,
								start_char_index: 0,
								end_char_index: 11
							}
						]
					}
				]
			},
			{ role: 'user', content: 'And my squat?' },
			{ role: 'system', content: 'Friday 6 November 2026, 07:12 Europe/London.' }
		]
	};
}

type Body = Parameters<typeof validateRequest>[0];
const rulesOf = (body: Body) => validateRequest(body).map((issue) => issue.rule);

/** The conversation with one change; `edit` works on a deep copy. */
function broken(edit: (request: ModelRequest) => void): ModelRequest {
	const request = structuredClone(conversation());
	edit(request);
	return request;
}
const message = (request: ModelRequest, index: number) => request.messages[index]!;
const blocks = (request: ModelRequest, index: number) =>
	message(request, index).content as BetaContentBlockParam[];
const toolAt = (request: ModelRequest, index: number) => request.tools![index]!;
const inputSchema = (request: ModelRequest, index: number) =>
	toolAt(request, index).input_schema as Record<string, Record<string, Record<string, unknown>>>;
const mark = (block: unknown) =>
	void ((block as { cache_control?: object }).cache_control = { type: 'ephemeral' });
const loose = (request: ModelRequest, fields: Record<string, unknown>) =>
	({ ...request, ...fields }) as ModelRequest;

describe('validateRequest', () => {
	it('passes a valid multi-turn tool conversation', () => {
		expect(validateRequest(conversation())).toEqual([]);
	});

	it('passes the shapes the API allows next to the broken ones', () => {
		expect(rulesOf(loose(conversation(), { tool_choice: { type: 'auto' } }))).toEqual([]);
		expect(rulesOf(loose(conversation(), { thinking: { type: 'adaptive' } }))).toEqual([]);
		const four = broken((request) => {
			mark(toolAt(request, 1));
			mark(blocks(request, 4)[1]);
		});
		expect(MAX_BREAKPOINTS).toBe(4);
		expect(rulesOf(four)).toEqual([]);
		const single = broken((request) => {
			request.messages = [{ role: 'user', content: 'Hi' }];
		});
		expect(rulesOf(single)).toEqual([]);
	});

	const refused: [string, ModelRequest, RequestRule[]][] = [
		['no messages', broken((r) => void (r.messages = [])), ['no_messages']],
		[
			'a first message from the assistant',
			broken((r) => void r.messages.unshift({ role: 'assistant', content: 'Hello' })),
			['first_not_user']
		],
		[
			'a first message that is a system message',
			broken((r) => void r.messages.unshift({ role: 'system', content: 'Context' })),
			['first_not_user', 'misplaced_system']
		],
		[
			'a prefill (a trailing assistant message)',
			broken((r) => void r.messages.push({ role: 'assistant', content: 'Your squat' })),
			['prefill']
		],
		['an orphan tool_use', broken((r) => void blocks(r, 4).pop()), ['orphan_tool_use']],
		[
			'results split across two user messages',
			broken((r) => {
				const second = blocks(r, 4).pop()!;
				r.messages.splice(5, 0, { role: 'user', content: [second] });
			}),
			['split_tool_results', 'orphan_tool_result']
		],
		[
			'a tool_result that answers no tool_use',
			broken((r) => {
				message(r, 6).content = [
					{ type: 'tool_result', tool_use_id: 'toolu_9', content: '{}' },
					{ type: 'text', text: 'And my squat?' }
				];
			}),
			['orphan_tool_result']
		],
		[
			'text before the tool results',
			broken((r) => void blocks(r, 4).unshift({ type: 'text', text: 'Here you go' })),
			['tool_result_not_first']
		],
		[
			'a system message after an assistant message',
			broken((r) => void r.messages.splice(6, 0, { role: 'system', content: 'Late context' })),
			['misplaced_system']
		],
		[
			'a system message followed by a user message',
			broken((r) => void r.messages.splice(3, 0, { role: 'user', content: 'Also this' })),
			['misplaced_system']
		],
		[
			'five cache breakpoints',
			broken((r) => {
				mark(toolAt(r, 0));
				mark(toolAt(r, 1));
				mark(blocks(r, 4)[1]);
			}),
			['too_many_breakpoints']
		],
		['unsorted tools', broken((r) => void r.tools!.reverse()), ['tools_unsorted']],
		[
			'two tools with one name',
			broken((r) => void r.tools!.push(tool('get_personal_records'))),
			['tools_unsorted']
		],
		['a non-strict tool', broken((r) => void (toolAt(r, 1).strict = false)), ['tool_not_strict']],
		[
			'a tool with no strict flag',
			broken((r) => void delete toolAt(r, 0).strict),
			['tool_not_strict']
		],
		[
			'an open nested object in a tool schema',
			broken((r) => void delete inputSchema(r, 0).properties!.range!.additionalProperties),
			['tool_schema_open']
		],
		[
			'an open object inside an array of choices',
			broken((r) => {
				const tags = inputSchema(r, 1).properties!.tags as { items: { anyOf: object[] } };
				tags.items.anyOf[1] = { type: 'object', properties: {} };
			}),
			['tool_schema_open']
		],
		[
			'an open top-level tool schema',
			broken((r) => void (toolAt(r, 0).input_schema.additionalProperties = true)),
			['tool_schema_open']
		],
		[
			'a forced tool_choice (any)',
			loose(conversation(), { tool_choice: { type: 'any' } }),
			['tool_choice']
		],
		[
			'a forced tool_choice (one tool)',
			loose(conversation(), { tool_choice: { type: 'tool', name: 'get_personal_records' } }),
			['tool_choice']
		],
		['tool_choice none', loose(conversation(), { tool_choice: { type: 'none' } }), ['tool_choice']],
		[
			'a thinking budget (budget_tokens)',
			loose(conversation(), { thinking: { type: 'enabled', budget_tokens: 4096 } }),
			['thinking']
		],
		['disabled thinking', loose(conversation(), { thinking: { type: 'disabled' } }), ['thinking']],
		[
			'adaptive thinking with a budget',
			loose(conversation(), { thinking: { type: 'adaptive', budget_tokens: 4096 } }),
			['thinking']
		],
		['temperature', loose(conversation(), { temperature: 1 }), ['sampling']],
		['top_p', loose(conversation(), { top_p: 0.9 }), ['sampling']],
		['top_k', loose(conversation(), { top_k: 5 }), ['sampling']],
		[
			'a document block in an assistant message',
			broken(
				(r) =>
					void blocks(r, 5).push({
						type: 'document',
						source: { type: 'text', media_type: 'text/plain', data: 'A note' }
					})
			),
			['assistant_document']
		],
		[
			'a cited text block in a user message',
			broken((r) => {
				const answer = blocks(r, 5)[0]!;
				message(r, 6).content = [answer, { type: 'text', text: 'And my squat?' }];
			}),
			['cited_user_text']
		],
		[
			'a cited text block in a search result inside a tool result',
			broken((r) => {
				const cited = blocks(r, 5)[0]!;
				blocks(r, 4)[0] = {
					type: 'tool_result',
					tool_use_id: 'toolu_1',
					content: [
						{
							type: 'search_result',
							source: 'history',
							title: 'Bench',
							content: [cited as never]
						}
					]
				};
			}),
			['cited_user_text']
		],
		[
			'no effort',
			broken((r) => void (r.output_config = {} as ModelRequest['output_config'])),
			['no_effort']
		],
		[
			'no output_config',
			broken((r) => void delete (r as Partial<ModelRequest>).output_config),
			['no_effort']
		],
		[
			'an effort the API does not know',
			loose(conversation(), { output_config: { effort: 'extreme' } }),
			['no_effort']
		]
	];

	it.each(refused)('refuses %s', (_name, request, rules) => {
		expect(rulesOf(request)).toEqual(rules);
	});

	it('covers every rule it can report', () => {
		const reported = new Set(refused.flatMap(([, , rules]) => rules));
		expect([...reported].sort()).toEqual(Object.keys(REQUEST_RULE).sort());
		expect(refused.length).toBeGreaterThanOrEqual(15);
	});

	it('says where each problem is', () => {
		const prefill = broken((r) => void r.messages.push({ role: 'assistant', content: 'Hi' }));
		expect(validateRequest(prefill)).toEqual([{ rule: 'prefill', at: 'messages[8]' }]);
		const open = broken((r) => void (toolAt(r, 1).strict = false));
		expect(validateRequest(open)).toEqual([{ rule: 'tool_not_strict', at: 'tools[1]' }]);
		const orphan = broken((r) => void blocks(r, 4).pop());
		expect(validateRequest(orphan)).toEqual([
			{ rule: 'orphan_tool_use', at: 'messages[3].content[2]' }
		]);
	});

	it('checks a full SDK body, not only a ModelRequest', () => {
		const messages: BetaMessageParam[] = [{ role: 'user', content: 'Hi' }];
		const body = { model: 'claude-opus-5-5', max_tokens: 1024, messages, stream: true as const };
		expect(rulesOf(body)).toEqual(['no_effort']);
		expect(rulesOf({ ...body, output_config: { effort: 'low' } })).toEqual([]);
	});
});
