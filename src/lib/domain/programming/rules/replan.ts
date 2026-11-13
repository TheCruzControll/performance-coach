/**
 * Re-plans (M7, PRD §5; docs/adr/NNNN-replans-as-versions.md): where a re-plan starts, which of
 * three mechanisms each directive uses, when a deload keeps M6's lighter path, and the refusals in
 * the owner's words. periodisation/replan.ts applies these; the rules registry (registry/replan.ts)
 * lists each with its why. The numbers and sentences are defaults the owner can change here;
 * REPLAN_START and REPLAN_SCOPE record the m7-plan open questions' answers without switching code.
 */
import type { ReplanDirectiveKind } from '../../training/replan.ts';
import type { Phase, WeekKind } from '../../training/vocabulary.ts';
import { LIGHT_WEEK_KINDS } from '../periodisation/kinds.ts';
import { GENERATOR_ID } from '../random.ts';
import { GUARDS } from './deload.ts';
import { PLAN_BUDGET } from './road.ts';

/** How a re-plan changes the plan. */
export type ReplanMechanism = 'regenerate' | 'splice' | 'in_place';

/**
 * Where a regenerating or splicing re-plan starts: the first Monday, from M3's next Monday (today
 * when today is a Monday), with nothing logged or skipped on or after it. `fromTomorrow` records
 * the open question's default (false); no code reads it, so starting mid-week would need
 * replanStart and the splice to change, not only this value.
 */
export const REPLAN_START = {
	from: 'next_monday',
	fromTomorrow: false,
	skipTouchedWeeks: true,
	why: 'The week in progress is never rewritten: what you have already done or skipped this week stays as you planned it, and the new plan starts clean on a Monday.'
} as const;

/**
 * Each directive's mechanism, and what it never does:
 * - regenerate (priorities, block): the blocks from `from` are planned again, a block running across
 *   it cut on the Sunday before, never to zero weeks; every still-eligible exercise is kept and none
 *   rotated (the cycle review rotates)
 * - splice (taper): the event's taper replaces the weeks before it, the same sessions with less
 *   volume, and every block after the event is kept
 * - in place (deload): the week's sessions still ahead get a deload's values, nothing else changes
 */
export const MECHANISMS = {
	regenerate: {
		directives: ['priorities', 'block'],
		rotates: false,
		why: 'New priorities or a chosen block change what the coming weeks are for, so they are planned again from a clean Monday; the exercises you know stay, because a change of plan is not a reason to relearn movements.'
	},
	splice: {
		directives: ['taper'],
		rotates: false,
		why: 'A taper only takes volume out of the weeks before your event, so those weeks keep their days and exercises and everything after the event stays as planned.'
	},
	in_place: {
		directives: ['deload'],
		rotates: false,
		why: 'A deload is one lighter week: the same sessions on the same days with less work, so the rest of the plan does not move.'
	}
} as const satisfies Record<
	ReplanMechanism,
	{ directives: readonly ReplanDirectiveKind[]; rotates: boolean; why: string }
>;

/** The mechanism a directive kind uses. */
export const mechanismOf = (kind: ReplanDirectiveKind): ReplanMechanism =>
	kind === 'taper' ? 'splice' : kind === 'deload' ? 'in_place' : 'regenerate';

/**
 * A deload in place keeps M6's lighter adjustment when a deload, taper, event or recovery week falls
 * in the target week or the `weeksAfter` after it, and only this week or next may be deloaded by the
 * owner or the coach (a review's deload is its own next week). An outline block has no weeks yet:
 * one of the `phases` starting there holds it the same way.
 */
export const DELOAD_HOLD = {
	kinds: LIGHT_WEEK_KINDS,
	phases: ['taper', 'marathon_taper', 'half_taper', 'recovery'],
	weeksAfter: GUARDS.lookaheadWeeks,
	ownerWeeksAhead: 1,
	why: 'A light week is already coming, so a deload now would make two light stretches in a row; the planned one does the rest.'
} as const satisfies {
	kinds: readonly WeekKind[];
	phases: readonly Phase[];
	weeksAfter: number;
	ownerWeeksAhead: number;
	why: string;
};

/**
 * What a re-planned version replaces (the open question on the owner's own moves): with
 * `ownMoves` 'replaced', a regenerated week plans its days afresh and the proposal lists each move
 * it drops; 'carried' would keep them where they still fit. It records the default: no code reads
 * it, so carrying moves over would be new work in the re-plan service, not a one-line change.
 */
export const REPLAN_SCOPE = {
	ownMoves: 'replaced',
	why: 'A new plan places every session for the new priorities, and the proposal lists each of your moves it changes, so nothing is dropped silently.'
} as const;

/** The generator a re-planned version stores: its own part, then M3's (fingerprint hashes it). */
export const REPLAN_GENERATOR_ID = `perfo-replan/1+${GENERATOR_ID}`;

/** Why a re-plan is refused. */
export type ReplanRefusalReason =
	| 'too_close'
	| 'not_applicable'
	| 'conflicts_with_event'
	| typeof PLAN_BUDGET.refusal
	| 'nothing_ahead';

/** Each refusal's sentence; the engine adds the specifics after it. */
export const REFUSALS = {
	too_close:
		'The event is too close to taper for: its taper would have started before the next clean Monday.',
	not_applicable: 'This change does not apply to your plan as it stands.',
	conflicts_with_event:
		'That block would work against your main event, so the plan keeps its run-up.',
	too_many_blocks: `Your plan already holds as many blocks as it can (${PLAN_BUDGET.blocks}), so a new program has to start from here.`,
	nothing_ahead: 'Nothing in that week is still ahead of you, so there is nothing left to change.',
	why: 'A re-plan never touches the past or an event date, and never builds a plan the store would refuse, so each case it cannot plan is said plainly instead.'
} as const satisfies Record<ReplanRefusalReason, string> & { why: string };
