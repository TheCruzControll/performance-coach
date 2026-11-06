/** Strength sessions: the split, the exercises and the time fit (m3/12, m3/17). */
import type { Templates } from '../../decisions.ts';

export const strength = {
	split_chosen: {
		summary: '{split} split',
		why: 'With {days} strength days a week, a {split} split {reason}.'
	},
	exercise_selected: {
		summary: '{exercise} for {slot}',
		why: '{exercise} fills the {slot} slot: {reason}.'
	},
	exercise_excluded: {
		summary: '{exercise} left out',
		why: '{exercise} is never prescribed in this program: {reason}.'
	},
	exercise_substituted: {
		summary: '{exercise} instead of {original}',
		why: '{original} would be the usual choice, but {reason}. {exercise} keeps its purpose: {intent}'
	},
	slot_empty: {
		summary: 'Nothing fits {slot}',
		why: 'No exercise in the library fits the {slot} slot: {reason}. The session goes ahead without it.'
	},
	unmapped_avoidance: {
		summary: 'Could not match “{text}”',
		why: 'You asked to avoid “{text}”, but it names no movement the coach knows, so nothing was left out for it. Swap anything that does not suit you.'
	},
	time_trimmed: {
		summary: '{session} trimmed to {minutes} min',
		why: '{session} came to about {estimate} min, more than your {minutes}-minute sessions allow, so {trimmed} came out. The top set stays.'
	}
} as const satisfies Templates;
