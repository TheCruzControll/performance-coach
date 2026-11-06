/**
 * Weekly hard sets per muscle group (m3/22). `target` is what the sets are for, read after 'for'
 * ('the 10–20 that suits building muscle'). `reason` (what changed and why) and `over` (why the
 * group stays over the range) are each empty or a sentence with a space before it.
 */
import type { Templates } from '../../decisions.ts';

export const volume = {
	volume_adjusted: {
		summary: '{group}: {sets} hard sets a week',
		why: '{group} gets {sets} hard sets a week, for {target}.{reason}{over}'
	}
} as const satisfies Templates;
