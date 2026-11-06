/** Fixed commitments and the running week: volume, paces and quality sessions (m3/18). */
import type { Templates } from '../../decisions.ts';

export const running = {
	commitment_placed: {
		summary: '{commitment} on {days}',
		why: '{commitment} is one of your fixed commitments, so it goes in first, every {days}, and the rest of the week is planned around it.'
	},
	run_volume: {
		summary: 'Week 1 running: {volume}',
		why: 'Week 1 starts from {basis}. After it, running grows by at most {step} a week, so your legs adapt before the load does.'
	},
	run_pace_source: {
		summary: 'Paces from {source}',
		why: 'Target paces come from {source}, so they match what you can run now. Effort (RPE) stays alongside as the check.'
	},
	quality_session: {
		summary: 'Quality running: {choice}',
		why: '{reason}'
	}
} as const satisfies Templates;
