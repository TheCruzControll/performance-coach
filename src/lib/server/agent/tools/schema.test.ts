import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { validateRequest } from '../provider/validate.ts';
import { defineTool } from './define.ts';
import { COACH_TOOLS, toolDefinitionsForRequest } from './registry.ts';
import { ToolSchemaError, toStrictJsonSchema } from './schema.ts';

const output = z.object({ count: z.int() });
const run = async () => ({ count: 1 });

/** A tool input with every construct the tools use: bounds, defaults, formats, unions, nesting. */
const FIXTURE = z.object({
	exercise: z.string().check(z.minLength(1), z.maxLength(80), z.describe('As the owner named it')),
	weeks: z._default(z.int().check(z.minimum(1), z.maximum(12)), 4),
	ids: z.optional(z.array(z.uuid()).check(z.minLength(1), z.maxLength(10))),
	from: z.nullable(z.iso.date()),
	note: z.nullable(z.string().check(z.maxLength(200))),
	scope: z.enum(['session', 'from_now_on']),
	sets: z.array(
		z.object({ reps: z.int(), rpe: z.optional(z.number().check(z.minimum(6), z.maximum(10))) })
	),
	target: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('exercise'), id: z.string() }),
		z.object({ kind: z.literal('session') })
	])
});

const closedObject = (properties: object, required: string[]) => ({
	type: 'object',
	properties,
	required,
	additionalProperties: false
});

/** The keywords strict tool use accepts; every other keyword is refused by the API. */
const STRICT_KEYWORDS = new Set([
	'type',
	'description',
	'title',
	'enum',
	'const',
	'anyOf',
	'allOf',
	'properties',
	'required',
	'additionalProperties',
	'items',
	'minItems',
	'format'
]);
const STRICT_FORMATS = ['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri'];

/** Why a converted schema would not pass strict mode, as paths; empty when it would. */
function strictProblems(node: unknown, at = '$'): string[] {
	if (Array.isArray(node)) return node.flatMap((each, i) => strictProblems(each, `${at}[${i}]`));
	if (!node || typeof node !== 'object') return [];
	const schema = node as Record<string, unknown>;
	const problems = Object.keys(schema)
		.filter((key) => !STRICT_KEYWORDS.has(key))
		.map((key) => `${at}.${key}`);
	if (schema.type === 'object') {
		const properties = Object.keys((schema.properties ?? {}) as object);
		if (schema.additionalProperties !== false) problems.push(`${at} is open`);
		const required = schema.required;
		if (!Array.isArray(required) || required.some((key) => !properties.includes(key)))
			problems.push(`${at}.required`);
	}
	if ('minItems' in schema && schema.minItems !== 0 && schema.minItems !== 1)
		problems.push(`${at}.minItems`);
	if (
		'format' in schema &&
		![...STRICT_FORMATS, 'ipv4', 'ipv6', 'uuid'].includes(`${schema.format}`)
	)
		problems.push(`${at}.format`);
	for (const key of ['properties']) {
		const children = (schema[key] ?? {}) as Record<string, unknown>;
		for (const [name, child] of Object.entries(children))
			problems.push(...strictProblems(child, `${at}.${name}`));
	}
	for (const key of ['items', 'anyOf', 'allOf'])
		if (key in schema) problems.push(...strictProblems(schema[key], `${at}.${key}`));
	return problems;
}

/** Every property name anywhere in a JSON Schema. */
function propertyNames(node: unknown): string[] {
	if (Array.isArray(node)) return node.flatMap(propertyNames);
	if (!node || typeof node !== 'object') return [];
	const schema = node as Record<string, unknown>;
	const own = Object.keys((schema.properties ?? {}) as object);
	return [...own, ...Object.values(schema).flatMap(propertyNames)];
}

const requestWith = (tools: BetaTool[]) =>
	validateRequest({
		max_tokens: 1_000,
		output_config: { effort: 'medium' },
		messages: [{ role: 'user', content: 'Hi' }],
		tools
	});

describe('toStrictJsonSchema', () => {
	it('closes every object, lists its required keys and keeps what strict mode enforces', () => {
		expect(toStrictJsonSchema(FIXTURE)).toEqual(
			closedObject(
				{
					exercise: {
						type: 'string',
						description: 'As the owner named it\n\n{minLength: 1, maxLength: 80}'
					},
					weeks: { type: 'integer', description: '{default: 4, minimum: 1, maximum: 12}' },
					ids: {
						type: 'array',
						items: { type: 'string', format: 'uuid' },
						minItems: 1,
						description: '{maxItems: 10}'
					},
					from: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
					note: { anyOf: [{ type: 'string', description: '{maxLength: 200}' }, { type: 'null' }] },
					scope: { type: 'string', enum: ['session', 'from_now_on'] },
					sets: {
						type: 'array',
						items: closedObject(
							{
								reps: { type: 'integer' },
								rpe: { type: 'number', description: '{minimum: 6, maximum: 10}' }
							},
							['reps']
						)
					},
					target: {
						anyOf: [
							closedObject(
								{ kind: { type: 'string', const: 'exercise' }, id: { type: 'string' } },
								['kind', 'id']
							),
							closedObject({ kind: { type: 'string', const: 'session' } }, ['kind'])
						]
					}
				},
				['exercise', 'from', 'note', 'scope', 'sets', 'target']
			)
		);
	});

	it('produces only what strict tool use accepts', () => {
		const schemas = [
			FIXTURE,
			z.object({}),
			z.object({ when: z.iso.datetime(), mail: z.email(), any: z.array(z.string()) }),
			z.object({
				n: z.number().check(z.positive(), z.multipleOf(0.5)),
				s: z.string().check(z.regex(/^a+$/))
			}),
			z.object({ both: z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })) })
		];
		for (const schema of schemas) expect(strictProblems(toStrictJsonSchema(schema))).toEqual([]);
	});

	it('keeps the bounds strict mode drops in the description, which zod still enforces', () => {
		const schema = toStrictJsonSchema(
			z.object({
				n: z.number().check(z.positive(), z.multipleOf(0.5)),
				s: z.string().check(z.regex(/^a+$/))
			})
		);
		expect(schema.properties).toEqual({
			n: { type: 'number', description: '{exclusiveMinimum: 0, multipleOf: 0.5}' },
			s: { type: 'string', description: '{pattern: "^a+$"}' }
		});
	});

	it('reads defaults as optional for an input and as always present for an output', () => {
		const schema = z.object({ limit: z._default(z.int(), 10), kind: z.string() });
		expect(toStrictJsonSchema(schema, 'input').required).toEqual(['kind']);
		expect(toStrictJsonSchema(schema, 'output').required).toEqual(['limit', 'kind']);
	});

	it.each([
		['a record', z.object({ byDay: z.record(z.string(), z.number()) }), /propertyNames/],
		[
			'an open object',
			z.object({ meta: z.looseObject({ a: z.string() }) }),
			/additionalProperties/
		],
		['a tuple', z.object({ pair: z.tuple([z.string(), z.number()]) }), /prefixItems/],
		['an untyped value', z.object({ anything: z.unknown() }), /no type/],
		['a date object', z.object({ at: z.date() }), /cannot be a strict tool schema/]
	])('refuses %s', (_, schema, message) => {
		expect(() => toStrictJsonSchema(schema)).toThrow(ToolSchemaError);
		expect(() => toStrictJsonSchema(schema)).toThrow(message);
	});

	it('refuses recursion', () => {
		const Step = z.object({
			name: z.string(),
			get then(): z.ZodMiniOptional<typeof Step> {
				return z.optional(Step);
			}
		});
		const convert = () => toStrictJsonSchema(z.object({ plan: Step }));
		expect(convert).toThrow(ToolSchemaError);
		expect(convert).toThrow(/cannot be a strict tool schema: Cycle detected/);
	});

	it.each([
		['owner', z.object({ owner: z.string() })],
		['ownerId', z.object({ ownerId: z.uuid() })],
		['owner_id', z.object({ owner_id: z.uuid() })],
		['OwnerID, nested in a list', z.object({ sets: z.array(z.object({ OwnerID: z.string() })) })],
		[
			'owner_id, inside a union',
			z.object({ by: z.union([z.object({ owner_id: z.string() }), z.string()]) })
		]
	])('refuses a property that names an owner: %s', (_, schema) => {
		expect(() => toStrictJsonSchema(schema)).toThrow(/owner/);
	});
});

describe('defineTool', () => {
	const spec = {
		name: 'get_exercise_history',
		description: 'The owner’s sets of one exercise.',
		input: FIXTURE,
		output,
		run
	} as const;

	it('sends a strict, eagerly streamed definition the API accepts', () => {
		const tool = defineTool(spec);
		expect(tool.definition).toEqual({
			name: 'get_exercise_history',
			description: 'The owner’s sets of one exercise.',
			input_schema: toStrictJsonSchema(FIXTURE),
			strict: true,
			eager_input_streaming: true
		});
		expect(tool.entry).toEqual({ group: 'history', effect: 'read', drafts: false });
		expect(requestWith([tool.definition])).toEqual([]);
		expect(Object.isFrozen(tool.definition.input_schema.properties)).toBe(true);
	});

	it('is byte-identical every time it is defined', () => {
		const first = JSON.stringify(defineTool(spec).definition);
		expect(JSON.stringify(defineTool(spec).definition)).toBe(first);
		expect(JSON.stringify(defineTool({ ...spec, input: FIXTURE.clone() }).definition)).toBe(first);
	});

	it('refuses a name outside the catalogue, an empty description and an output strict mode cannot state', () => {
		expect(() => defineTool({ ...spec, name: 'get_weather' as never })).toThrow(/catalogue/);
		expect(() => defineTool({ ...spec, description: '  ' })).toThrow(/description/);
		const record = z.object({ byDay: z.record(z.string(), z.int()) });
		expect(() => defineTool({ ...spec, output: record, run: async () => ({ byDay: {} }) })).toThrow(
			ToolSchemaError
		);
	});

	it('refuses an input that names an owner', () => {
		expect(() => defineTool({ ...spec, input: z.object({ ownerId: z.uuid() }) })).toThrow(/owner/);
	});
});

describe('the registered tools', () => {
	it('never name an owner, anywhere in their input', () => {
		const names = [FIXTURE, ...COACH_TOOLS.map((tool) => tool.inputSchema)].flatMap((schema) =>
			propertyNames(toStrictJsonSchema(schema))
		);
		expect(names.length).toBeGreaterThan(0);
		expect(names.filter((name) => /^owner[_-]?(id)?$/i.test(name))).toEqual([]);
	});

	it('are the same bytes on every request', () => {
		const first = toolDefinitionsForRequest();
		expect(toolDefinitionsForRequest()).toBe(first);
		expect(JSON.stringify(toolDefinitionsForRequest())).toBe(JSON.stringify(first));
		expect(Object.isFrozen(first)).toBe(true);
	});
});
