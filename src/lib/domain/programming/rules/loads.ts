/**
 * Loads and their progression (PRD §5; the M3 brief's baseline rules; m3-plan open question 'The
 * coaching thresholds'). loads.ts applies them to week 1 and progression.ts to the weeks after,
 * and the first block stores them as its progression (BlockPlan.progression), so M4 and M6 adapt
 * a block from data: the same functions take the stored copy. A coaching change is a number here.
 * Each week's own targets, its RPE cap, load step and volume factor, are rules/blocks.ts's.
 *
 * - A main lift is an exercise with a top set and a baseline lift. A blank 1RM is worked up to by
 *   RPE in its first week, and every later load is a share of the estimate that set gives
 *   (from_e1rm); a known one gives percentages of a snapshot of it (percent_1rm). An estimated
 *   1RM is never treated as a measured one.
 * - All other work stays as the strength stage prescribes it (rules/strength.ts): RPE-based at
 *   WORKING_RPE (7) or the week's cap if lower, its rest by slot role, and holds and carries in
 *   seconds and metres.
 */

export const LOAD_RULES = {
	/**
	 * A measured 1RM loads week 1 at this share of what M1's table (percentOfOneRepMax) gives its
	 * reps at the week's RPE cap: a set of 5 at RPE 7 is 78.6 % of a 1RM, so week 1's sets of 5 are
	 * at 72.5 %, about an RPE under the cap, in case the max has moved since it was tested.
	 */
	measuredShare: 0.925,
	/** An estimated 1RM loads this much less of it than a measured one would, every week. */
	estimateDiscount: 0.025,
	/**
	 * A back-off set's share of its top set's load. The plan allows 0.85–0.9; 0.9 because week 1's
	 * top set is only RPE 7.
	 */
	backOffShare: 0.9,
	/** Percentages of a known 1RM and back-off shares round down to this step: 2.5 %. */
	loadRounding: 0.025,
	/** Back-off sets each main lift gains in a week whose volume factor is above 1. */
	extraMainSets: 1
} as const;

/** The rules as numbers: LOAD_RULES, or a block's stored progression read back. */
export type LoadRules = Readonly<Record<keyof typeof LOAD_RULES, number>>;
