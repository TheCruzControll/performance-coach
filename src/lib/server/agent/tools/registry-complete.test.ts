/**
 * Every catalogue tool is registered (the M5 plan's tools-programming-proposals, the last tools
 * slice): the registry is the catalogue, name for name, each tool defined once, in its group's
 * file, with the catalogue's effect and drafts flag and an output schema.
 */
import { describe, expect, it } from 'vitest';
import { TOOL_CATALOGUE, TOOL_NAMES } from '../../../domain/coach/tools.ts';
import { compareText } from '../../../domain/programming/random.ts';
import { DRAFT_KINDS } from '../proposals/draft.ts';
import { COACH_TOOLS, TOOL_GROUP_FILES, type ToolGroupFile } from './registry.ts';
import { toStrictJsonSchema } from './schema.ts';

/** What keeps `files` from defining exactly the catalogue's tools; empty when they do. */
function registryIssues(files: readonly ToolGroupFile[]): string[] {
	const issues: string[] = [];
	for (const name of TOOL_NAMES) {
		const entry = TOOL_CATALOGUE[name];
		const homes = files.filter((f) => f.tools.some((tool) => tool.name === name));
		const definitions = files.flatMap((f) => f.tools.filter((tool) => tool.name === name));
		if (definitions.length !== 1) {
			issues.push(`${name}: ${definitions.length} definitions`);
			continue;
		}
		const [home] = homes;
		const [tool] = definitions;
		if (home!.group !== entry.group || (home!.effects && !home!.effects.includes(entry.effect)))
			issues.push(`${name}: in ${home!.file}, not its group's file`);
		if (tool!.entry.effect !== entry.effect || tool!.entry.drafts !== entry.drafts)
			issues.push(`${name}: not the catalogue's effect and drafts flag`);
		try {
			toStrictJsonSchema(tool!.outputSchema, 'output');
		} catch {
			issues.push(`${name}: no output schema`);
		}
	}
	return issues;
}

describe('the registry is the catalogue', () => {
	it('registers every catalogue tool by name, sorted as every request lists them', () => {
		expect(TOOL_NAMES).toHaveLength(24);
		expect(COACH_TOOLS.map((tool) => tool.name)).toEqual(TOOL_NAMES);
		const sorted = [...COACH_TOOLS].sort((a, b) => compareText(a.name, b.name));
		expect(sorted).toEqual(COACH_TOOLS);
	});

	it('defines each tool once, in its group’s file, with the catalogue’s effect, drafts flag and an output schema', () => {
		expect(registryIssues(TOOL_GROUP_FILES)).toEqual([]);
		for (const tool of COACH_TOOLS) expect(tool.entry).toBe(TOOL_CATALOGUE[tool.name]);
	});

	it('has as many drafting tools as the drafter has kinds', () => {
		const drafting = COACH_TOOLS.filter((tool) => tool.entry.drafts).map((tool) => tool.name);
		expect(drafting).toEqual([
			'create_next_training_cycle',
			'propose_program_adjustment',
			'update_workout'
		]);
		expect(drafting).toHaveLength(DRAFT_KINDS.length);
	});

	it('fails when any one definition is removed', () => {
		for (const name of TOOL_NAMES) {
			const without = TOOL_GROUP_FILES.map((file) => ({
				...file,
				tools: file.tools.filter((tool) => tool.name !== name)
			}));
			expect(registryIssues(without)).toEqual([`${name}: 0 definitions`]);
		}
	});

	it('fails when a definition sits in another group’s file', () => {
		const proposals = TOOL_GROUP_FILES.find((f) => f.file === 'programming-proposals.ts')!;
		const reads = TOOL_GROUP_FILES.find((f) => f.file === 'programming-reads.ts')!;
		const moved = TOOL_GROUP_FILES.map((file) =>
			file === proposals
				? { ...file, tools: file.tools.filter((t) => t.name !== 'create_training_program') }
				: file === reads
					? {
							...file,
							tools: [
								...file.tools,
								proposals.tools.find((t) => t.name === 'create_training_program')!
							]
						}
					: file
		);
		expect(registryIssues(moved)).toEqual([
			"create_training_program: in programming-reads.ts, not its group's file"
		]);
	});
});
