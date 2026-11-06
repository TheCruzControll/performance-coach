/**
 * A coach tool: a zod/mini input schema, which is also its strict JSON Schema, an output schema,
 * and a function over the services the screens use. Only the catalogue's names are tools.
 *
 * The definition is what every request sends (the claude-api skill's tool-use rules): strict, so
 * the input matches the schema, and eager_input_streaming, so a long input streams as it is
 * written; the API then no longer checks it, so execute.ts validates every input with zod before
 * the tool runs. Definitions are frozen and built the same way every time, so the tools prefix of
 * the prompt is byte-stable for the cache.
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

export interface StrictToolDefinition extends BetaTool {
	name: ToolName;
	description: string;
	strict: true;
	eager_input_streaming: true;
}

export interface CoachTool<Deps = unknown> {
	readonly name: ToolName;
	readonly entry: Readonly<ToolCatalogueEntry>;
	readonly definition: Readonly<StrictToolDefinition>;
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
	run: (input: z.output<I>, ctx: ToolContext<Deps>) => Promise<z.input<O>>;
}): CoachTool<Deps> {
	if (!isToolName(spec.name))
		throw new ToolSchemaError(`${spec.name} is not in the tool catalogue`);
	const description = spec.description.trim();
	if (!description) throw new ToolSchemaError(`${spec.name} needs a description`);
	const input_schema = toStrictJsonSchema(spec.input, 'input') as BetaTool.InputSchema;
	// The generated tool docs print the output schema, so it must convert the same way.
	toStrictJsonSchema(spec.output, 'output');
	return Object.freeze({
		name: spec.name,
		entry: TOOL_CATALOGUE[spec.name],
		definition: deepFreeze({
			name: spec.name,
			description,
			input_schema,
			strict: true as const,
			eager_input_streaming: true as const
		}),
		inputSchema: spec.input,
		outputSchema: spec.output,
		run: spec.run as CoachTool<Deps>['run']
	});
}
