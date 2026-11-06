import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { TOOL_CATALOGUE, TOOL_NAMES, type ToolName } from '../../../domain/coach/tools.ts';
import { validateRequest } from '../provider/validate.ts';
import { defineTool, type CoachTool } from './define.ts';
import {
	buildRegistry,
	COACH_TOOLS,
	TOOL_GROUP_FILES,
	toolDefinitionsForRequest,
	type ToolGroupFile
} from './registry.ts';

const tool = (name: ToolName) =>
	defineTool({
		name,
		description: `The ${name} tool.`,
		input: z.object({ limit: z.optional(z.int()) }),
		output: z.object({ count: z.int() }),
		run: async () => ({ count: 0 })
	});

const file = (name: string, tools: CoachTool[]): ToolGroupFile => {
	const declared = TOOL_GROUP_FILES.find((each) => each.file === name)!;
	return { ...declared, tools };
};

describe('COACH_TOOLS', () => {
	it('registers only catalogue tools, each with the catalogue’s group and effect', () => {
		const strays = COACH_TOOLS.filter(
			(each) => !TOOL_NAMES.includes(each.name) || each.entry !== TOOL_CATALOGUE[each.name]
		);
		expect(strays).toEqual([]);
		expect(COACH_TOOLS).toHaveLength(TOOL_GROUP_FILES.flatMap((each) => each.tools).length);
	});

	it('has one file for each tool group, and no tool group without one', () => {
		expect(TOOL_GROUP_FILES.map((each) => each.file)).toEqual([
			'history.ts',
			'programming-reads.ts',
			'programming-proposals.ts',
			'workout.ts',
			'preferences.ts',
			'analytics.ts'
		]);
		const groups = new Set(TOOL_GROUP_FILES.map((each) => each.group));
		expect(groups).toEqual(new Set(Object.values(TOOL_CATALOGUE).map((entry) => entry.group)));
	});
});

describe('buildRegistry', () => {
	const files = [
		file('history.ts', [tool('get_recent_workouts'), tool('get_exercise_history')]),
		file('programming-reads.ts', [tool('get_current_program')]),
		file('programming-proposals.ts', [tool('create_training_program')]),
		file('analytics.ts', [tool('get_training_load')])
	];

	it('sorts every group file’s tools by name, the order each request sends them in', () => {
		const registry = buildRegistry(files);
		expect(registry.map((each) => each.name)).toEqual([
			'create_training_program',
			'get_current_program',
			'get_exercise_history',
			'get_recent_workouts',
			'get_training_load'
		]);
		expect(Object.isFrozen(registry)).toBe(true);
		const issues = validateRequest({
			max_tokens: 1_000,
			output_config: { effort: 'medium' },
			messages: [{ role: 'user', content: 'Hi' }],
			tools: registry.map((each) => each.definition)
		});
		expect(issues).toEqual([]);
	});

	it('refuses a tool in another group’s file', () => {
		expect(() => buildRegistry([file('history.ts', [tool('get_training_load')])])).toThrow(
			/history.ts: get_training_load is a analytics read tool/
		);
	});

	it('keeps programming reads and proposals in their own files', () => {
		expect(() =>
			buildRegistry([file('programming-reads.ts', [tool('propose_program_adjustment')])])
		).toThrow(/propose/);
		expect(() =>
			buildRegistry([file('programming-proposals.ts', [tool('get_program_history')])])
		).toThrow(/read/);
	});

	it('refuses a tool defined twice, or one that is not the catalogue’s', () => {
		expect(() =>
			buildRegistry([
				file('history.ts', [tool('get_recent_workouts'), tool('get_recent_workouts')])
			])
		).toThrow(/twice/);
		const forged = {
			...tool('get_recent_workouts'),
			entry: { group: 'history', effect: 'write', drafts: false }
		};
		expect(() => buildRegistry([file('history.ts', [forged as CoachTool])])).toThrow(/catalogue/);
	});
});

describe('toolDefinitionsForRequest', () => {
	it('is the registry’s definitions, in its order', () => {
		expect(toolDefinitionsForRequest()).toEqual(COACH_TOOLS.map((each) => each.definition));
	});
});
