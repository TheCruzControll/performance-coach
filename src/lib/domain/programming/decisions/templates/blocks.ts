/** The first block's shape, event tapers and the week's days (m3/13). */
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
		why: 'You train {days} days a week. Your fixed commitments take {commitmentDays}, and the {freeDays} free days go to your goals in priority order: {allocation}.'
	}
} as const satisfies Templates;
