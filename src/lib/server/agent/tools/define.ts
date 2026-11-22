/**
 * A coach tool: a zod/mini input schema, which is also its strict JSON Schema, an output schema,
 * and a function over the services the screens use. Only the catalogue's names are tools.
 *
 * The definition is what every request sends (the claude-api skill's tool-use rules):
 * eager_input_streaming, so a long input streams as it is written; the API then no longer checks
 * it, so execute.ts validates every input with zod before the tool runs. A tool that proposes or
 * writes is also strict, so the model's input is generated to its schema. A read is not: the API
 * caps strict schemas per request (20 tools, 24 optional and 16 union-typed parameters in all,
 * validate.ts), all 24 tools strict broke every cap and every request came back a 400, and a read
 * with a bad input only fails zod and is asked again. A tool too complex to fit beside the others
 * opts out with `strict: false`. Definitions are frozen and built the same way every time, so the
 * tools prefix of the prompt is byte-stable for the cache.
 */
import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages';
import type * as z from 'zod/mini';
import {
	isToolName,
	TOOL_CATALOGUE,
	type ToolCatalogueEntry,
	type ToolName
} from '../../../domain/coach/tools.ts';
import type { ToolContext } from './context.ts';
import { toStrictJsonSchema, ToolSchemaError } from './schema.ts';

export interface ToolDefinition extends BetaTool {
	name: ToolName;
	description: string;
	strict: boolean;
	eager_input_streaming: true;
}

export interface CoachTool<Deps = unknown> {
	readonly name: ToolName;
	readonly entry: Readonly<ToolCatalogueEntry>;
	readonly definition: Readonly<ToolDefinition>;
	readonly inputSchema: z.ZodMiniType;
	/** What the tool returns; each tools slice validates real outputs against it. */
	readonly outputSchema: z.ZodMiniType;
	/** Runs on input that already passed inputSchema (execute.ts). */
	run(input: unknown, ctx: ToolContext<Deps>): Promise<unknown>;
}

const deepFreeze = <T>(value: T): T => {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
};

export function defineTool<
	I extends z.ZodMiniObject,
	O extends z.ZodMiniType,
	Deps = unknown
>(spec: {
	name: ToolName;
	description: string;
	input: I;
	output: O;
	/** By default a tool is strict unless it only reads; false opts a proposing tool out. */
	strict?: boolean;
	run: (input: z.output<I>, ctx: ToolContext<Deps>) => Promise<z.input<O>>;
}): CoachTool<Deps> {
	if (!isToolName(spec.name))
		throw new ToolSchemaError(`${spec.name} is not in the tool catalogue`);
	const description = spec.description.trim();
	if (!description) throw new ToolSchemaError(`${spec.name} needs a description`);
	const input_schema = toStrictJsonSchema(spec.input, 'input') as BetaTool.InputSchema;
	// The generated tool docs print the output schema, so it must convert the same way.
	toStrictJsonSchema(spec.output, 'output');
	const entry = TOOL_CATALOGUE[spec.name];
	return Object.freeze({
		name: spec.name,
		entry,
		definition: deepFreeze({
			name: spec.name,
			description,
			input_schema,
			strict: spec.strict ?? entry.effect !== 'read',
			eager_input_streaming: true as const
		}),
		inputSchema: spec.input,
		outputSchema: spec.output,
		run: spec.run as CoachTool<Deps>['run']
	});
}
