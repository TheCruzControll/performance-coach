/**
 * The coach's 24 tools, each named once (PRD §4, the M5 brief): its group, its effect and whether
 * it drafts. The registry (server/agent/tools) defines one tool per entry, the activity chips
 * word them (activity.ts), the per-tool deadlines read `drafts` (budgets.ts) and diagnostics
 * group by them, so a tool that is not here cannot run.
 *
 * They are the brief's 21 plus get_program_history, get_exercise_alternatives and
 * get_coach_proposals. Every get_* tool only reads. Six tools only propose: they store a
 * coach_proposals row that changes nothing until the owner accepts it. The two that write are the
 * brief's only direct writes: the coach's own workout analysis, and a preference the owner stated
 * explicitly in this turn. Three proposing tools draft their payload with a structured-output
 * call, so their deadline includes the draft's time.
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

export interface ToolCatalogueEntry {
	group: ToolGroup;
	effect: ToolEffect;
	/** True when running it includes a structured-output draft, which needs a longer deadline. */
	drafts: boolean;
}

const read = (group: ToolGroup): ToolCatalogueEntry => ({ group, effect: 'read', drafts: false });
const propose = (group: ToolGroup, drafts = false): ToolCatalogueEntry => ({
	group,
	effect: 'propose',
	drafts
});
const write = (group: ToolGroup): ToolCatalogueEntry => ({ group, effect: 'write', drafts: false });

const CATALOGUE = {
	// History: what the owner did, with sources.
	get_training_history: read('history'),
	get_exercise_history: read('history'),
	get_running_history: read('history'),
	get_recent_workouts: read('history'),
	get_personal_records: read('history'),
	// Programming: the plan as Train shows it, its history, and the coach's own proposals.
	get_current_program: read('programming'),
	get_current_training_week: read('programming'),
	get_training_schedule: read('programming'),
	get_program_history: read('programming'),
	get_coach_proposals: read('programming'),
	propose_program_adjustment: propose('programming', true),
	/** M3's previewProgram builds it deterministically: no draft. */
	create_training_program: propose('programming'),
	/** A proposal only; M6 applies an accepted one. */
	create_next_training_cycle: propose('programming', true),
	// Workout: today's session, M4's substitution semantics, and the coach's analysis note.
	get_current_workout: read('workout'),
	get_exercise_alternatives: read('workout'),
	update_workout: propose('workout', true),
	substitute_exercise: propose('workout'),
	save_workout_analysis: write('workout'),
	// Preferences: likes, dislikes and goals.
	get_training_preferences: read('preferences'),
	/** Writes only for an explicit statement in this turn; otherwise it proposes or refuses. */
	update_exercise_preferences: write('preferences'),
	update_training_goals: propose('preferences'),
	// Analytics: metrics computed by code, with their method.
	get_weekly_training_summary: read('analytics'),
	get_training_load: read('analytics'),
	get_performance_trends: read('analytics')
} satisfies Record<string, ToolCatalogueEntry>;

/** A tool's name: one of the catalogue's keys. */
export type ToolName = keyof typeof CATALOGUE;

for (const entry of Object.values(CATALOGUE)) Object.freeze(entry);

export const TOOL_CATALOGUE: Readonly<Record<ToolName, Readonly<ToolCatalogueEntry>>> =
	Object.freeze(CATALOGUE);

/** Every tool name, sorted (the order the request lists tools in, for a byte-stable prefix). */
export const TOOL_NAMES: readonly ToolName[] = Object.freeze(
	(Object.keys(CATALOGUE) as ToolName[]).sort()
);

/** True for a catalogue name; the model can ask for any string. */
export function isToolName(name: string): name is ToolName {
	return Object.hasOwn(CATALOGUE, name);
}
