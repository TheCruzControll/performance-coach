/**
 * How a week is scored and graded (m7/03 week-evaluation): judgement calls held as data, each
 * with its reason, so the owner can tune them cheaply. evaluate/week.ts applies them; the rules
 * registry lists them (registry/evaluation.ts).
 */
import type { ResolutionHint, WeekEvaluation } from '../evaluate/types.ts';

/**
 * The evaluation's version, part of every fingerprint. Bump it whenever the same week could be
 * judged differently: a weight, a grade, a resolution's words.
 */
export const EVALUATION_ID = 'week-evaluation/1';

/**
 * What each finding costs the week's 0–100 score (m7-plan open question on the coaching numbers;
 * the plan's default):
 * - avoid 25: four unresolved avoid findings leave nothing, because each one risks injury or a
 *   session done badly
 * - prefer 8: advice, so a week with a few still scores well
 * - resolved 0.5: a finding the week keeps for a stated reason (your move, a commitment, a goal's
 *   priority, no room) still costs, at half its weight, because the body pays it all the same
 */
export const SCORE_WEIGHTS = { avoid: 25, prefer: 8, resolved: 0.5 } as const;

/**
 * The week's grade, from the findings the owner can still act on, checked in this order:
 * - conflicts: an avoid finding ahead with no reason given for keeping it
 * - minor: findings ahead, but only advice or kept for a stated reason
 * - clear: nothing ahead to act on, because the week breaks no rule or only on days already past
 */
export const GRADES = {
	conflicts: 'An avoid rule is broken on a day still ahead, and nothing in the plan explains it.',
	minor: 'What is left ahead is advice, or a trade-off the plan already explains.',
	clear: 'Nothing left in the week to act on.'
} as const satisfies Record<WeekEvaluation['grade'], string>;

/**
 * Which reason a kept finding gives when more than one applies, first first:
 * - owner_moved: the owner's own choice says most about why the week looks this way
 * - commitment_fixed: classes and clubs keep their days, so nothing can be moved
 * - priority_kept: the generator kept it for a goal's priority, and says which
 * - no_room: the week has no free day to move a session to
 */
export const RESOLUTION_ORDER = [
	'owner_moved',
	'commitment_fixed',
	'priority_kept',
	'no_room'
] as const satisfies readonly ResolutionHint[];
