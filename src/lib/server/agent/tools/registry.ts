/**
 * Every coach tool, from one file per tool group: each tools slice replaces only its own file, so
 * no two slices edit this one. A tool sits in its catalogue group's file (programming reads and
 * proposals in two), and the registry is sorted by name, the order every request lists tools in,
 * so the cached prefix is byte-stable.
 */
import {
	TOOL_CATALOGUE,
	isToolName,
	type ToolEffect,
	type ToolGroup
} from '../../../domain/coach/tools.ts';
import { compareText } from '../../../domain/programming/random.ts';
import { ANALYTICS_TOOLS } from './analytics.ts';
import type { CoachTool, ToolDefinition } from './define.ts';
import { HISTORY_TOOLS } from './history.ts';
import { PREFERENCE_TOOLS } from './preferences.ts';
import { PROGRAMMING_PROPOSAL_TOOLS } from './programming-proposals.ts';
import { PROGRAMMING_READ_TOOLS } from './programming-reads.ts';
import { WORKOUT_TOOLS } from './workout.ts';

export interface ToolGroupFile {
	file: string;
	group: ToolGroup;
	/** When set, the only effects the file's tools may have. */
	effects?: readonly ToolEffect[];
	tools: readonly CoachTool[];
}

const file = (
	name: string,
	group: ToolGroup,
	tools: readonly CoachTool[],
	effects?: ToolEffect[]
) => ({ file: name, group, tools, ...(effects && { effects }) }) satisfies ToolGroupFile;

export const TOOL_GROUP_FILES: readonly ToolGroupFile[] = Object.freeze([
	file('history.ts', 'history', HISTORY_TOOLS),
	file('programming-reads.ts', 'programming', PROGRAMMING_READ_TOOLS, ['read']),
	file('programming-proposals.ts', 'programming', PROGRAMMING_PROPOSAL_TOOLS, ['propose']),
	file('workout.ts', 'workout', WORKOUT_TOOLS),
	file('preferences.ts', 'preferences', PREFERENCE_TOOLS),
	file('analytics.ts', 'analytics', ANALYTICS_TOOLS)
]);

/** The files' tools sorted by name; a tool outside the catalogue or its group's file throws. */
export function buildRegistry(files: readonly ToolGroupFile[]): readonly CoachTool[] {
	const tools = files.flatMap(({ file, group, effects, tools }) =>
		tools.map((tool) => {
			const entry = isToolName(tool.name) ? TOOL_CATALOGUE[tool.name] : undefined;
			if (!entry || tool.entry !== entry)
				throw new Error(`${file}: ${tool.name} is not the catalogue's tool`);
			if (entry.group !== group || (effects && !effects.includes(entry.effect)))
				throw new Error(`${file}: ${tool.name} is a ${entry.group} ${entry.effect} tool`);
			return tool;
		})
	);
	const sorted = tools.sort((a, b) => compareText(a.name, b.name));
	const twice = sorted.find((tool, index) => index > 0 && sorted[index - 1]!.name === tool.name);
	if (twice) throw new Error(`${twice.name} is defined twice`);
	return Object.freeze(sorted);
}

export const COACH_TOOLS: readonly CoachTool[] = buildRegistry(TOOL_GROUP_FILES);

const DEFINITIONS = Object.freeze(COACH_TOOLS.map((tool) => tool.definition));

/** The tools every coach request sends: the same frozen, sorted definitions each time. */
export const toolDefinitionsForRequest = (): readonly Readonly<ToolDefinition>[] => DEFINITIONS;
