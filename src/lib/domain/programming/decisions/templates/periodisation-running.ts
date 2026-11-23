/**
 * M7's running progressions and heart-rate zones (endurance-blocks, generator-running and
 * hr-zones reword it). `reason` is a whole sentence.
 */
import type { Templates } from '../../decisions.ts';

export const periodisationRunning = {
	long_run_progressed: {
		summary: 'Long run: {from} to {to}',
		why: 'The long run grows from {from} to {to} across {block}, {step} a week, never past {cap}. {reason}'
	},
	hr_zones_set: {
		summary: 'Heart-rate zones from your {source}',
		why: '{zones}, from your {basis}. {reason} Each run keeps its zone number.'
	}
} as const satisfies Templates;
