/**
 * M7's block types, deloads, tapers, volume and the fight camp (the block-type, deload-taper and
 * fight-camp slices reword it). `reason` and `signals` are whole sentences.
 */
import type { Templates } from '../../decisions.ts';

export const periodisationBlocks = {
	block_type_chosen: {
		summary: '{block}: {type}',
		why: '{block} is a {type} block of {weeks} weeks, from {startsOn}. {reason}'
	},
	deload_triggered: {
		summary: 'Deload in week {week}',
		why: '{signals} So week {week} becomes a deload: lighter targets, no sparring and easy runs. {reason}'
	},
	taper_planned: {
		summary: 'Taper before {event}: {length}',
		why: '{event} is on {date}, so the {length} before it taper: the volume drops ({steps}) and the intensity stays, so you arrive fresh. {reason}'
	},
	volume_progressed: {
		summary: '{block}: {stream} {from} to {to}',
		why: '{block} builds {stream} from {from} to {to}, {step} a week. {reason}'
	},
	sparring_load: {
		summary: 'Hard sparring: {count} a week',
		why: 'Fight camp holds hard sparring to {count} a week, the last on {last}, {days} days before {event}. {reason}'
	}
} as const satisfies Templates;
