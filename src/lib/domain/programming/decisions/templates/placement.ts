/**
 * Where sessions go in the week (m3/23). priority_tradeoff is also written by the day allocation
 * (m3/13), the long run (m3/18) and volume (m3/22), so its words stay general.
 */
import type { Templates } from '../../decisions.ts';

export const placement = {
	session_placed: {
		summary: '{session} on {day}',
		why: '{session} goes on {day}: {reason}.'
	},
	interference_resolved: {
		summary: '{session} kept clear of {other}',
		why: '{conflict}, so {session} goes on {day} instead.'
	},
	priority_tradeoff: {
		summary: '{kept} over {given}',
		why: '{reason}'
	},
	session_dropped: {
		summary: '{session} left out this week',
		why: 'The week has no room for {session}: {reason}. It serves your lowest-priority goal, so it goes first.'
	}
} as const satisfies Templates;
