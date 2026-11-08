/**
 * The rules registry's contract (m7-contract): one entry per programming rule, whose id is the
 * rule key decisions cite. An entry is one of two kinds:
 * - constant: `source` is 'path#EXPORT' (or 'path#EXPORT.key'), and `values` is that live
 *   constant, read by the area file, never copied, so the registry cannot drift from the code
 * - behaviour: `source` is 'path#function', the exported function that applies the rule, with no
 *   values (goals.paused, days.free_days, edits.move: rules with no constant behind them)
 * Paths are from the repository root. Each area file is filled by exactly one slice;
 * ./index.ts gathers them and marks what each area's supersedes map replaces.
 */

/** The registry's areas: one file each in this folder. */
export const RULE_AREAS = [
	'interference',
	'evaluation',
	'load',
	'fatigue',
	'concurrent',
	'schedule',
	'priority',
	'maintenance',
	'season',
	'road',
	'strength-phases',
	'hypertrophy',
	'endurance',
	'fight-camp',
	'deload',
	'taper',
	'paces',
	'generator',
	'replan',
	'targets',
	'm3',
	'm4',
	'm6'
] as const;
export type RuleArea = (typeof RULE_AREAS)[number];

/** 'avoid' is a rule to keep; 'prefer' is advice (interference.ts's Severity). */
export type RuleSeverity = 'avoid' | 'prefer';

interface RuleBase {
	/** The rule key decisions cite: dotted snake_case. */
	id: string;
	/** What the rule does, in one or two plain sentences. */
	statement: string;
	/** Why: the coaching reason, in words the owner can check. */
	rationale: string;
	severity?: RuleSeverity;
	/** 'path#EXPORT' for a constant, 'path#function' for a behaviour. */
	source: string;
}

export interface ConstantRule extends RuleBase {
	kind: 'constant';
	/** The live constant `source` names. */
	values: unknown;
}

export interface BehaviourRule extends RuleBase {
	kind: 'behaviour';
}

/** An entry as an area file writes it. */
export type RuleDefinition = ConstantRule | BehaviourRule;

/** What an area file exports. `supersedes` maps an old rule's id to the id replacing it. */
export interface RuleAreaModule {
	readonly rules: readonly RuleDefinition[];
	readonly supersedes?: Readonly<Record<string, string>>;
}

/** An entry as the registry holds it. A superseded rule keeps its live values. */
export type RuleEntry = RuleDefinition & {
	area: RuleArea;
	status: 'active' | 'superseded';
	supersededBy?: string;
};
