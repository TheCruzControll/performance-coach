/**
 * The first block's shape, event tapers and the week's days (m3/13). `available` is empty or
 * starts with a separator, so the sentence reads whole either way.
 */
import type { Templates } from '../../decisions.ts';

export const blocks = {
	block_structure: {
		summary: 'First block: {structure}',
		why: 'The first block runs {weeks} weeks: {structure}. {reason}'
	},
	event_taper: {
		summary: 'Taper before {event}',
		why: '{event} on {date} falls inside the first block, so the week before it is a taper: less volume at the same intensity, so you arrive fresh.'
	},
	day_allocation: {
		summary: '{days} training days a week',
		why: 'You train {stated} days a week{available}. Your fixed commitments take {commitmentDays}, which leaves {freeDays} free: {allocation}.'
	}
} as const satisfies Templates;
