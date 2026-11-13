/**
 * The program as a whole: what it is for (m3/28), the owner's go-ahead at build (m3/36) and a
 * moved start (start-move.ts). `who` is 'You' or 'The coach'; `from` and `to` are week 1's first
 * days in words ('Mon 16 Nov').
 */
import type { Templates } from '../../decisions.ts';

export const program = {
	program_purpose: {
		summary: 'Week 1 establishes your baselines',
		why: '{purpose} Every week after it builds on what you record, toward {goal}.'
	},
	owner_confirmed: {
		summary: 'You confirmed this program',
		why: 'You reviewed the preview and built it, so this version is the plan you saw.'
	},
	start_moved: {
		summary: 'Moved the start to {to}',
		why: '{who} moved the start from {from} to {to}, before any training on it. Every week was planned again from your profile for the new dates, and dated goals keep their dates, so a taper still comes just before its event.'
	}
} as const satisfies Templates;
