/**
 * Fixed commitments and the running week: volume, paces and quality sessions (m3/18). `time`,
 * `assumed`, `justification` and `notes` are empty or start with a separator, so a sentence reads
 * whole either way. A race's paces are worded by its VDOT (generator-running), for example 'from
 * your half marathon in 1:45:30 on 3 Oct, a VDOT of 43, by Daniels’ formula'.
 */
import type { Templates } from '../../decisions.ts';

export const running = {
	commitment_placed: {
		summary: '{commitment} on {days}',
		why: '{commitment} is one of your fixed commitments, so it goes in first, every {days}{time}, for {minutes} min at {intensity} intensity, and the rest of the week is planned around it. {counts}{assumed}'
	},
	run_volume: {
		summary: 'Week 1 running: {volume}',
		why: 'Week 1 starts from {basis}. After it, a week runs at most {step} more than the biggest week before it, and the lighter weeks drop it, so your legs adapt before the load does.{justification}{notes}'
	},
	run_pace_source: {
		summary: 'Run targets from {source}',
		why: '{reason} Every segment also has an RPE and a heart-rate zone, so effort stays the check.'
	},
	quality_session: {
		summary: 'Quality running: {choice}',
		why: '{reason}'
	}
} as const satisfies Templates;
