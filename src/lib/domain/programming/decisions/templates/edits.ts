/**
 * Edits by the owner or the coach (m3/34, m3/39). `who` is 'You' or 'The coach'. A 'why' is never
 * empty: with no reason given, `reason` is NO_REASON. `warnings` is empty or starts with a space.
 */
import type { Templates } from '../../decisions.ts';

export const NO_REASON = 'No reason given.';

export const edits = {
	session_moved: {
		summary: 'Moved {session} from {from} to {to}',
		why: '{who} moved {session} from {from} to {to}. {reason}{warnings}'
	},
	session_skipped: {
		summary: 'Skipped {session} on {day}',
		why: '{who} skipped {session} on {day}. {reason}'
	},
	exercise_swapped: {
		summary: 'Swapped {from} for {to}',
		why: '{who} swapped {from} for {to} {scope}. {reason}'
	},
	prescription_adjusted: {
		summary: 'Adjusted {what}',
		why: '{who} changed {what}: {before} → {after}. {reason}'
	},
	preference_recorded: {
		summary: '{exercise} is never prescribed again',
		why: '{who} asked for {exercise} never to be prescribed again, so it is saved as a dislike and swapped for {to} in {sessions} from today. {reason}'
	}
} as const satisfies Templates;
