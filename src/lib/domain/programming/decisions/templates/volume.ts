/** Weekly hard sets per muscle group (m3/22). */
import type { Templates } from '../../decisions.ts';

export const volume = {
	volume_adjusted: {
		summary: '{group}: {sets} hard sets a week',
		why: '{group} gets {sets} hard sets a week, inside the {range} that suits {goal}. {reason}'
	}
} as const satisfies Templates;
