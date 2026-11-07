/**
 * M6's decisions: reviews applied, progression from results, fatigue, deloads and the next block
 * with the exercises it keeps or rotates (m6/12 owns the kinds; later M6 slices write them).
 * `reason` is a whole sentence: results.ts's why, or the review's. `lost` is empty or starts with
 * a space.
 */
import type { Templates } from '../../decisions.ts';

export const results = {
	review_applied: {
		summary: 'Applied {changes} from your {review}',
		why: '{who} applied {changes} from your {review}. {reason}'
	},
	results_progression: {
		summary: '{exercise}: {change}',
		why: '{reason}'
	},
	fatigue_managed: {
		summary: 'Fatigue {level}: {change}',
		why: '{signals}. {reason}'
	},
	deload_scheduled: {
		summary: 'Deload in week {week}',
		why: 'Week {week} is a deload: fewer sets, none above RPE {rpeCap}, so the fatigue clears. {reason}'
	},
	next_block_planned: {
		summary: 'Next block: {block}, from {startsOn}',
		why: '{block} starts on {startsOn} and runs {weeks} weeks. {reason}{lost}'
	},
	exercise_kept: {
		summary: 'Kept {exercise} for the {slot}',
		why: '{exercise} stays in the {slot} slot: {reason}.'
	},
	exercise_rotated: {
		summary: '{exercise} instead of {previous}',
		why: '{previous} has had its run in the {slot} slot, so {exercise} takes it: {reason}.'
	}
} as const satisfies Templates;
