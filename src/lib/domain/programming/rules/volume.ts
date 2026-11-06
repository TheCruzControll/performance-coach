/**
 * Weekly hard sets per muscle group (PRD §5; m3-plan open question 'The coaching thresholds').
 * volume.ts applies these numbers to the block's strength sessions; a coaching change is a row
 * here, not code. A hard set is metrics.ts's isHardSet, counted by plannedHardSets, so the plan
 * and the training log always count alike.
 *
 * - The range is the split's: its style's, or maintenance's when a goal of another kind ranks
 *   first (splits.ts). It holds in every week at full volume (VOLUME_WEEK_MIN); the deload, taper
 *   and event weeks take their share of it through their volume factor (progression, m3/21).
 * - Pulling gets at least as many hard sets as pushing (PULL_PER_PUSH), weighed set for set with
 *   the groups' floors: where the time holds neither, the trade-off names pulling.
 * - A group's floor comes before its ceiling: the main lifts keep their sets, and their back-off
 *   sets turn hard in the heavier weeks, so the heaviest weeks may go over the top.
 * - The nutrition phase moves the range: a cut keeps about 80 % of the sets at the same
 *   intensity, a bulk aims three quarters of the way up the range, as far as the heaviest week
 *   stays inside it. Maintenance and recomp keep the range.
 * - Sets are added only while the session stays within its length (timefit.ts estimateMinutes);
 *   when the range cannot fit, a priority_tradeoff decision says so.
 */
import type { NutritionPhase } from '../../profile/catalog.ts';
import type { MovementPattern, MuscleGroup } from '../../training/vocabulary.ts';
import type { SlotKindKey, StyleKey } from './strength.ts';

/** The weekly hard sets each major group gets, by the split's style, and what they suit. */
export const HARD_SET_RANGES = {
	hypertrophy: { sets: [10, 20], suits: 'building muscle' },
	strength: { sets: [8, 14], suits: 'getting stronger' },
	maintenance: { sets: [4, 10], suits: 'keeping your strength' }
} as const satisfies Record<StyleKey, { sets: readonly [number, number]; suits: string }>;

/**
 * The groups the range holds for, and the work that may be added to one: an exercise of these
 * patterns with a primary muscle in the group, isolation work first. The smaller groups (arms,
 * calves, core, forearms, neck) get theirs from the compound lifts and the split's accessories.
 */
// prettier-ignore
export const MAJOR_GROUPS = {
	chest: { kind: 'hpush', patterns: ['isolation', 'horizontal_push'] },
	back: { kind: 'hpull', patterns: ['horizontal_pull', 'vertical_pull'] },
	shoulders: { kind: 'side_delts', patterns: ['isolation', 'horizontal_pull'] },
	quads: { kind: 'quads', patterns: ['isolation', 'lunge', 'squat'] },
	hamstrings: { kind: 'hamstrings', patterns: ['isolation', 'hinge'] },
	hips: { kind: 'lunge', patterns: ['hinge', 'lunge', 'isolation'] }
} as const satisfies Partial<Record<MuscleGroup, { kind: SlotKindKey; patterns: readonly MovementPattern[] }>>;
export type MajorGroup = keyof typeof MAJOR_GROUPS;

/** The range holds in the weeks whose volume factor is at least this: the full-volume weeks. */
export const VOLUME_WEEK_MIN = 1;

/** Pushing and pulling are counted by pattern; pulling gets at least this many sets per push. */
export const PUSH_PATTERNS: readonly MovementPattern[] = ['horizontal_push', 'vertical_push'];
export const PULL_PATTERNS: readonly MovementPattern[] = ['horizontal_pull', 'vertical_pull'];
export const PULL_PER_PUSH = 1;

/**
 * How the nutrition phase moves the range. A cut only takes sets off, a main lift's back-offs
 * among them but never its top set, and keeps `keep` of the sets the goal would get, never under
 * `keep` of the range, with every RPE unchanged; a bulk raises the floor `toward` of the way up
 * the range. `why` is read after the sets it changed in the group's decision.
 */
export const PHASES: Partial<
	Record<NutritionPhase, { keep: number; toward: number; why: string }>
> = {
	cut: {
		keep: 0.8,
		toward: 0,
		why: 'Your cut takes about a fifth of the sets off, at the same intensity'
	},
	bulk: {
		keep: 1,
		toward: 0.75,
		why: 'Your bulk moves it toward the top of the range'
	}
};

/** No line grows past this many sets: more work for a group comes as another exercise. */
export const MAX_LINE_SETS = 5;

/** At most this many exercises are added to one session. */
export const MAX_ADDED_EXERCISES = 2;
