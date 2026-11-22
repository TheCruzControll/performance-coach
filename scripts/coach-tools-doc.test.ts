/**
 * The tools catalogue in the docs is the registry's (scripts/coach-tools-doc.ts): the committed
 * docs/coach-tools.md and the index between the markers in docs/agent-architecture.md equal a
 * fresh render, and a change to a field, a bound or an output field changes the render.
 *
 * `pnpm docs:coach-tools` runs this file with COACH_TOOLS_DOC=write: it writes both files instead
 * of comparing them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { defineTool, type CoachTool } from '../src/lib/server/agent/tools/define.ts';
import { COACH_TOOLS } from '../src/lib/server/agent/tools/registry.ts';
import { toStrictJsonSchema } from '../src/lib/server/agent/tools/schema.ts';
import {
	absolute,
	ARCHITECTURE_DOC,
	BEGIN_MARKER,
	catalogueIndex,
	END_MARKER,
	renderArchitecture,
	renderToolsDoc,
	schemaOutline,
	spliceGenerated,
	TOOLS_DOC
} from './coach-tools-doc.ts';

const WRITE = process.env.COACH_TOOLS_DOC === 'write';
const read = (file: string) => readFileSync(absolute(file), 'utf8');

/** The registry with `tool` in place of the one of the same name. */
const replacing = (tool: CoachTool) => COACH_TOOLS.map((t) => (t.name === tool.name ? tool : t));

const original = COACH_TOOLS.find((tool) => tool.name === 'get_exercise_history')!;
const variant = (input: z.ZodMiniObject, output: z.ZodMiniType) =>
	defineTool({
		name: original.name,
		description: original.definition.description,
		input,
		output,
		run: async () => ({})
	});
const input = (max: number, extra = {}) =>
	z.object({
		exercise: z.string().check(z.minLength(1), z.maxLength(100)),
		limit: z.optional(z.int().check(z.minimum(1), z.maximum(max))),
		...extra
	});
const output = (field: string) => z.object({ [field]: z.array(z.string()) });

describe.skipIf(WRITE)('the committed tools catalogue', () => {
	it('docs/coach-tools.md equals a fresh render of the registry', async () => {
		expect(read(TOOLS_DOC), 'run `pnpm docs:coach-tools` and commit the result').toBe(
			await renderToolsDoc(COACH_TOOLS)
		);
	});

	it('the index in docs/agent-architecture.md equals a fresh render', async () => {
		const doc = read(ARCHITECTURE_DOC);
		expect(doc, 'run `pnpm docs:coach-tools` and commit the result').toBe(
			await renderArchitecture(doc, COACH_TOOLS)
		);
	});

	it('lists every tool once, with its group, effect and drafts flag', () => {
		const index = catalogueIndex(COACH_TOOLS);
		expect(index.split('\n')).toHaveLength(COACH_TOOLS.length + 2);
		expect(index).toContain(
			'| [`update_workout`](coach-tools.md#update_workout) | Workout | propose | yes |'
		);
		expect(index).toContain(
			'| [`save_workout_analysis`](coach-tools.md#save_workout_analysis) | Workout | write | no |'
		);
	});
});

describe.skipIf(WRITE)('a schema change changes the docs', () => {
	const base = variant(input(20), output('sets'));

	it('prints each field with its type, whether it is required and its bounds', () => {
		expect(schemaOutline(base.definition.input_schema as never)).toBe(
			[
				'- `exercise` (string, required): {minLength: 1, maxLength: 100}',
				'- `limit` (integer): {minimum: 1, maximum: 20}'
			].join('\n')
		);
	});

	it('a changed bound, a new input field or a renamed output field fails the comparison', async () => {
		const before = await renderToolsDoc(replacing(base));
		const bound = await renderToolsDoc(replacing(variant(input(21), output('sets'))));
		const field = await renderToolsDoc(
			replacing(variant(input(20, { since: z.optional(z.iso.date()) }), output('sets')))
		);
		const renamed = await renderToolsDoc(replacing(variant(input(20), output('entries'))));
		for (const changed of [bound, field, renamed]) expect(changed).not.toBe(before);
		expect(bound).toContain('{minimum: 1, maximum: 21}');
		expect(field).toContain('- `since` (string (date))');
		expect(renamed).toContain('- `entries` (array of string, required)');
	});

	it('prints a nullable object and a union with their fields', () => {
		const schema = toStrictJsonSchema(
			z.object({
				last: z.nullable(z.object({ kg: z.number() })),
				item: z.union([z.object({ a: z.boolean() }), z.literal('x')])
			}),
			'output'
		);
		expect(schemaOutline(schema)).toBe(
			[
				'- `last` (object | null, required)',
				'  - `kg` (number, required)',
				'- `item` (one of 2, required)',
				'  - or object',
				'    - `a` (boolean, required)',
				'  - or `"x"`'
			].join('\n')
		);
	});

	it('refuses a keyword it cannot print, so nothing is left out', () => {
		expect(() =>
			schemaOutline({
				type: 'object',
				properties: { n: { type: 'number', minimum: 1 } },
				required: [],
				additionalProperties: false
			})
		).toThrow("$.n: the catalogue cannot print 'minimum'");
	});
});

describe('the generated markers', () => {
	it('replaces only the text between them', () => {
		const doc = `# A\n\nhand\n\n${BEGIN_MARKER}\n\nold\n\n${END_MARKER}\n\nmore hand\n`;
		expect(spliceGenerated(doc, 'new')).toBe(
			`# A\n\nhand\n\n${BEGIN_MARKER}\n\nnew\n\n${END_MARKER}\n\nmore hand\n`
		);
	});

	it('refuses a doc without them, or with two pairs', () => {
		expect(() => spliceGenerated('# A\n', 'new')).toThrow('needs');
		const twice = `${BEGIN_MARKER}\n${END_MARKER}\n${BEGIN_MARKER}\n${END_MARKER}\n`;
		expect(() => spliceGenerated(twice, 'new')).toThrow('more than one pair');
	});
});

describe.runIf(WRITE)('pnpm docs:coach-tools', () => {
	it('writes docs/coach-tools.md and the index in docs/agent-architecture.md', async () => {
		const tools = await renderToolsDoc(COACH_TOOLS);
		const architecture = await renderArchitecture(read(ARCHITECTURE_DOC), COACH_TOOLS);
		writeFileSync(absolute(TOOLS_DOC), tools);
		writeFileSync(absolute(ARCHITECTURE_DOC), architecture);
		expect(read(TOOLS_DOC)).toBe(tools);
		expect(read(ARCHITECTURE_DOC)).toBe(architecture);
	});
});
