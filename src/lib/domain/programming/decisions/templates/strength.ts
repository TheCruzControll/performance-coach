/** Strength sessions: the split, the exercises and the time fit (m3/12, m3/17). */
import type { Templates } from '../../decisions.ts';

export const strength = {
	split_chosen: {
		summary: 'Split: {split}, {days} days a week',
		why: 'With {days} strength days a week{classes}, {article} {split} split {reason}.'
	},
	exercise_selected: {
		summary: '{exercise} for the {slot}',
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
		summary: 'Nothing fits the {slot} slot',
		why: 'Nothing in the library can fill the {slot} slot in {sessions}. {reason}. The rest of the session goes ahead.'
	},
	unmapped_avoidance: {
		summary: 'Could not match “{text}”',
		why: 'You asked to avoid “{text}”, but it names no movement the coach knows, so nothing was left out for it. Swap anything that does not suit you.'
	},
	time_trimmed: {
		summary: '{session} trimmed to about {after} min',
		why: '{session} came to about {estimate} min, more than your {minutes}-minute sessions allow, so {trimmed}. It now takes about {after} min.'
	}
} as const satisfies Templates;
