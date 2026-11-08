/**
 * The week evaluation's contract (m7-contract; types and labels only). evaluateWeek is the one
 * judge of a week: Train, the Move sheet, the coach's tools, the scheduler, the generator and
 * M6's weekly review all read these shapes, so they say the same thing about the same week.
 */
import type { IsoDate } from '../../calendar.ts';
import type { RuleArea, RuleSeverity } from '../rules/registry/types.ts';

/** The body systems a session loads, each with its own recovery. */
export const SYSTEM_LABEL = {
	lower: 'Lower body',
	upper: 'Upper body',
	aerobic: 'Aerobic',
	combat: 'Combat',
	cns: 'Nervous system'
} as const;
export type LoadSystem = keyof typeof SYSTEM_LABEL;
export const SYSTEMS = Object.keys(SYSTEM_LABEL) as readonly LoadSystem[];

/** One day's load: M1's sRPE (minutes × RPE), split by system. */
export interface DayLoad {
	date: IsoDate;
	/** Known load, planned at its target RPE or logged, by system. */
	bySystem: Readonly<Record<LoadSystem, number>>;
	/** The day's known load: M6's dailyLoads for the same logged sessions. */
	total: number;
	/** Load from a planned session with no target RPE, at the default RPE: a separate series. */
	estimated: number;
	/** Logged sessions with no RPE or no duration: counted and named, never 0 (M6's rule). */
	unknown: number;
}

/** How a finding was left, when the week keeps it. */
export type ResolutionHint = 'priority_kept' | 'owner_moved' | 'commitment_fixed' | 'no_room';

/** One rule a week breaks, in words, with the sessions it names. */
export interface Finding {
	/** The registry id of the rule broken. */
	rule: string;
	area: RuleArea;
	severity: RuleSeverity;
	/** The dates it spans, earliest first. */
	days: IsoDate[];
	/** The sessions it names, the earlier first; lineage when the session is stored. */
	sessions: { lineage?: string; title: string; date: IsoDate }[];
	/** A few words: 'Heavy squats the day before sparring'. */
	headline: string;
	/** One sentence naming its days and sessions. */
	message: string;
	/** The rule's reason. */
	why: string;
	/** Why the week keeps it, when it does: the trade-off in one sentence. */
	resolution?: { kind: ResolutionHint; text: string };
	/** The owner could still act on it: a session ahead that a move or an ease would fix. */
	actionable: boolean;
}

export interface WeekEvaluation {
	/** 0 to 100: 100 breaks nothing. */
	score: number;
	grade: 'clear' | 'minor' | 'conflicts';
	findings: Finding[];
	/** Each day's load, when the context carries it. */
	days?: DayLoad[];
	/** A digest of what was judged, so a stale evaluation is recognised. */
	fingerprint: string;
}

/** A goal's part in a block: it leads, keeps its own training, or is held at its dose. */
export type GoalMode = 'primary' | 'secondary' | 'maintenance';

/** A goal's priority as the engine applies it at a date, with the sentence that says why. */
export interface EffectivePriority {
	goalId: string;
	/** Its place, 0 the leader. */
	rank: number;
	/** Its rank weight: the costs of its sessions' findings are multiplied by it. */
	weight: number;
	mode: GoalMode;
	/** Names the goals, the dates and the rule. */
	why: string;
}
