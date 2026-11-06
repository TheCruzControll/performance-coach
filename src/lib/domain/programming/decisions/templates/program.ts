/** The program as a whole: what it is for (m3/28) and the owner's go-ahead at build (m3/36). */
import type { Templates } from '../../decisions.ts';

export const program = {
	program_purpose: {
		summary: 'Week 1 establishes your baselines',
		why: '{purpose} Every week after it builds on what you record, toward {goal}.'
	},
	owner_confirmed: {
		summary: 'You confirmed this program',
		why: 'You reviewed the preview and built it, so this version is the plan you saw.'
	}
} as const satisfies Templates;
