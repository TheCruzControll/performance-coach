/**
 * M7's week scheduler (week-scheduler and generator-schedule reword it). `conflict` is the
 * clause naming the rule and its sessions; `reason` is a whole sentence.
 */
import type { Templates } from '../../decisions.ts';

export const periodisationSchedule = {
	schedule_repaired: {
		summary: 'Moved {session} from {from} to {to}',
		why: '{conflict}, so {session} moves from {from} to {to}. {reason}'
	},
	load_eased: {
		summary: '{session} eased to RPE {rpe}',
		why: '{conflict}, and no day of the week avoids it, so {session} is eased to RPE {rpe}. {reason}'
	}
} as const satisfies Templates;
