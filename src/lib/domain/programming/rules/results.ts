/**
 * Progression from actual results (PRD §5; m6-plan open question 'Progression steps'). results.ts
 * applies these numbers to a lift's last exposures, a week's running and the fatigue signals; a
 * coaching change is a number here, not code. 'Consistently' below or above target is
 * analytics/prescribed.ts's CONSISTENCY (a mean of ±1.0 RPE in 2 of the last 3 exposures), read,
 * never redefined, and the trend is analytics/trend.ts's verdict.
 *
 * Strength, over the last `window` exposures of a lift (substitutes left out):
 * - fewer than `minExposures` → no change: nothing changes on one session
 * - a real e1RM decline with the RPE rising by `rpeCreep` or more → no increase (a reduction below
 *   still applies), `accessorySets`
 *   on that lift's accessories, a fatigue flag and a deload to consider
 * - missed reps in `missedAgree` of them → `missedRepeat`; once → hold
 * - above target → `above` (`aboveAll` when every one is above), or a set fewer when every target
 *   was hit, only harder than prescribed
 * - below target → `below` (`belowLower` for a lower-body lift, only when all of them agree)
 * - without RPEs, the reps against the target: every set hit in `missedAgree` of them → `below`
 * - within `onTarget` of target in every one → the planned progression; otherwise, noise → hold
 *
 * Every step is bounded: at most `maxUp` and `maxDown` a week, except that a light lift's single
 * smallest increment may go up to `smallestStepPct` (so 30 → 32.5 kg is +8.3 %), and a significant
 * change (a load of `significantPct` or more) needs `window` exposures, and an increase no real
 * decline, else it shrinks to `below`'s step. The plan's other significant change, 2 sets or more,
 * cannot happen here: every sets move is one set.
 */
import type { MovementPattern } from '../../training/vocabulary.ts';

export const RESULT_RULES = {
	/** Exposures read: the lift's last three. */
	window: 3,
	/** Fewer exposures than this change nothing. */
	minExposures: 2,
	/** Percent steps of the load. */
	below: 2.5,
	belowLower: 5,
	above: -2.5,
	aboveAll: -5,
	missedRepeat: -5,
	/** Exposures with missed reps that reduce the load; one only holds it. */
	missedAgree: 2,
	/** The most a load moves in a week, in percent. */
	maxUp: 5,
	maxDown: 10,
	/**
	 * A light lift's single smallest increment may pass maxUp or maxDown up to this much (one 2.5 kg
	 * plate on 20 kg or more), else it would never move; a bigger one holds.
	 */
	smallestStepPct: 12.5,
	/** A change this large is significant and waits for `window` exposures with no real decline. */
	significantPct: 5,
	/** Within this many RPE of target in every exposure: on target. */
	onTarget: 0.5,
	/** A rise in RPE of this much at the same load is creep; with a real decline, fatigue. */
	rpeCreep: 0.5,
	/** Sets taken off a declining lift's accessories. */
	accessorySets: -1,
	/** An rpe_based line moves its target by this much. */
	rpeStep: 0.5,
	/** A seconds line (a hold) moves by this many seconds. */
	secondsStep: 5,
	/** A from_e1rm share with no e1RM to round against rounds to this step of the 1RM. */
	shareRounding: 0.005
} as const;

export type ResultRules = Readonly<Record<keyof typeof RESULT_RULES, number>>;

/** Lifts of these patterns are lower body: the bigger step when all three sessions agree. */
export const LOWER_BODY_PATTERNS: readonly MovementPattern[] = ['squat', 'hinge', 'lunge'];

/**
 * Running: the week's distance rises at most `maxWeeklyRise` (10 %) over the last completed week;
 * the long run steps up only after a completed long run at or under its target RPE, and a missed
 * one is repeated; adherence under `holdBelowAdherence` (70 %) holds the volume. Distances round
 * down to `roundMetres`.
 */
export const RUN_RESULT_RULES = {
	maxWeeklyRise: 0.1,
	holdBelowAdherence: 70,
	roundMetres: 100
} as const;

/**
 * The fatigue signals and their thresholds. Each one met is a reason; `watch` with one, `high`
 * (which recommends a deload) with `highSignals` or more.
 */
export const FATIGUE_RULES = {
	signals: {
		acwr: ['above', 1.5],
		monotony: ['above', 2],
		/** On M3's 1–5 recovery scale. */
		soreness: ['at_least', 4],
		sleepHours: ['below', 6.5],
		rpeCreep: ['at_least', 0.5],
		/** Lifts that missed reps, and lifts in a real e1RM decline with rising RPE. */
		liftsMissingReps: ['at_least', 2],
		decliningLifts: ['at_least', 1]
	},
	highSignals: 2
} as const satisfies {
	signals: Record<string, readonly ['above' | 'at_least' | 'below', number]>;
	highSignals: number;
};

export type FatigueSignal = keyof typeof FATIGUE_RULES.signals;
