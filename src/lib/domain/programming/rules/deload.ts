/**
 * Deloads (M7, PRD §5): when one is due on schedule, what sets one off sooner, what holds it back,
 * and what a deload week asks of every session. periodisation/deload.ts applies them; the rules
 * registry (registry/deload.ts) lists each with its why.
 *
 * The deload's own numbers are M3's deload week (rules/blocks.ts weekTargets('deload')), read live,
 * so the generator's first block and a deload applied later never disagree. The triggers only
 * combine M6's signals (its fatigue level, its trend verdicts and load-fatigue's levels): their
 * thresholds stay M6's and M7's load model's. Every other number is a coaching default the owner
 * can change in one line here (m7-plan open question on the coaching numbers).
 */
import type { ExperienceLevel } from '../../profile/catalog.ts';
import type { OtherSessionKind } from '../../training/vocabulary.ts';
import { LIGHT_WEEK_KINDS } from '../periodisation/kinds.ts';
import { weekTargets } from './blocks.ts';

const M3_DELOAD = weekTargets('deload', 0);

/**
 * Loading weeks before a scheduled deload, by experience, and a deload at a block's end once
 * `endAfter` loading weeks or more precede it (one week of loading has nothing to absorb). A light
 * week (LIGHT_WEEK_KINDS) already planned counts as the rest and starts the count again.
 */
export const CADENCE = {
	weeks: { new: 5, novice: 4, intermediate: 4, advanced: 3 },
	atBlockEnd: true,
	endAfter: 2,
	why: 'A beginner recovers between sessions and can build for five weeks; the stronger you are, the more each week takes out of you, so an advanced lifter deloads after three. Ending a block on a deload starts the next one fresh.'
} as const satisfies {
	weeks: Record<ExperienceLevel, number>;
	atBlockEnd: boolean;
	endAfter: number;
	why: string;
};

/** A deload's targets: TARGETS, or a variant of them. */
export interface DeloadTargets {
	setsFactor: number;
	rpeCap: number;
	loadFactor: number;
	runFactor: number;
	cutbackShare: number;
	muayThai: { kind: OtherSessionKind; sparringTo: OtherSessionKind; commitmentRpe: number };
	why: string;
}

/**
 * What a deload week asks, against the week as it was planned:
 * - strength: 40 % fewer sets (never fewer than one a line), nothing above RPE 6, loads 10 % lighter
 * - runs: 30 % shorter, every quality segment run easy (E pace, zone 2). A cutback week's runs
 *   stand at `cutbackShare` of a full week's already, so they come down only to the deload's share
 *   of a full week, and keep their cutback distance when that is the lower
 * - Muay Thai: technique, with sparring swapped for pads; a commitment class keeps its slot at
 *   RPE 6
 */
export const TARGETS = {
	setsFactor: M3_DELOAD.volumeFactor,
	rpeCap: M3_DELOAD.rpeCap,
	loadFactor: 1 + M3_DELOAD.loadStep,
	runFactor: M3_DELOAD.runVolumeFactor,
	/** The endurance plan's cutback week, as a share of a full week (m7-plan: 80 %). */
	cutbackShare: 0.8,
	muayThai: {
		kind: 'technical',
		sparringTo: 'pad_work',
		commitmentRpe: M3_DELOAD.rpeCap
	},
	why: 'Cutting volume by about 40 % while the work stays familiar lets the fatigue of the block clear in a week without losing fitness; easy runs and technique keep the habit and the skill.'
} as const satisfies DeloadTargets;

/**
 * What makes a deload needed now, whatever the schedule:
 * - M6's fatigue level 'high'
 * - or 'watch' with a real decline: the e1RM of `decliningLifts` or more main lifts really
 *   declining (M6's trend verdict), or easy runs `slowerPacePct` % or more slower at the same RPE
 * - or one body system overloaded (load-fatigue's level) on `overloadedDays` of the last
 *   `windowDays` days, which reads with or without M1's ratio
 */
export const TRIGGERS = {
	fatigue: 'high',
	watch: { decliningLifts: 2, slowerPacePct: 3 },
	overload: { overloadedDays: 5, windowDays: 7 },
	why: 'High fatigue is several warning signs at once. A watch level alone is often a bad night or a hard week, so it needs a real decline in performance with it. A system overloaded nearly every day for a week is not recovering between sessions.'
} as const;

/**
 * What holds a needed deload back:
 * - the target week is already light (LIGHT_WEEK_KINDS) → nothing more to do
 * - a light week in the `lookaheadWeeks` weeks after it → hold for it; M6's next week eases the
 *   target week instead
 * - a deload that ended within `recentDeloadDays` days of the target week → reduce volume only
 * A cutback week is light for running only, so it may still be deloaded.
 */
export const GUARDS = {
	lightKinds: LIGHT_WEEK_KINDS,
	lookaheadWeeks: 2,
	recentDeloadDays: 14,
	why: 'Two light weeks in a row cost fitness for no extra recovery, so a deload waits for a taper or a planned deload that is close, and one just after a deload trims volume instead.'
} as const;
