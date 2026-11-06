/** Week-1 loads and the block's progression (m3/21). */
import type { Templates } from '../../decisions.ts';

export const loads = {
	load_basis: {
		summary: '{exercise}: {basis}',
		why: '{exercise} is loaded from {basis}. {reason}'
	},
	progression: {
		summary: 'Progression: {change}',
		why: '{reason}'
	}
} as const satisfies Templates;
