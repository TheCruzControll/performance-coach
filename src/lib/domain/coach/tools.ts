/**
 * PLACEHOLDER, replaced only by coach-tool-catalogue (m5/02): the coach's 24 tools, each named
 * once with its group, its effect and whether it drafts. The names and types below are the
 * contract that slice keeps; until it lands the catalogue is empty, so no tool can run.
 */

/** The brief's five tool groups (PRD §4), in the order the catalogue lists them. */
export const TOOL_GROUP_LABEL = {
	history: 'History',
	programming: 'Programming',
	workout: 'Workout',
	preferences: 'Preferences',
	analytics: 'Analytics'
};
export type ToolGroup = keyof typeof TOOL_GROUP_LABEL;
export const TOOL_GROUPS = Object.keys(TOOL_GROUP_LABEL) as readonly ToolGroup[];

/** read: no writes; propose: a coach_proposals row only; write: one of the two direct writes. */
export const TOOL_EFFECTS = ['read', 'propose', 'write'] as const;
export type ToolEffect = (typeof TOOL_EFFECTS)[number];

/** A tool's name; coach-tool-catalogue narrows it to the catalogue's keys. */
export type ToolName = string;

export interface ToolCatalogueEntry {
	group: ToolGroup;
	effect: ToolEffect;
	/** True when running it includes a structured-output draft, which needs a longer deadline. */
	drafts: boolean;
}

export const TOOL_CATALOGUE: Readonly<Record<ToolName, ToolCatalogueEntry>> = {};

/** Every tool name, sorted (the order the request lists tools in, for a byte-stable prefix). */
export const TOOL_NAMES: readonly ToolName[] = [];
