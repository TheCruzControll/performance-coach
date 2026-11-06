/**
 * The first block's shape, the outline after it, event tapers and the week's days (m3/13).
 * `available` and `notes` are empty or start with a separator, so a sentence reads whole either way.
 */
import type { Templates } from '../../decisions.ts';

export const blocks = {
	block_structure: {
		summary: '{block}: {structure}',
		why: '{block} runs {weeks} weeks: {structure}. {reason}{notes}'
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
