import { logWhenSettled } from '#lib/server/observability/timing.ts';
import { vitalsFor } from '../../about.server';
import type { PageServerLoad } from './$types';

/** Profile → About this app → Speed: the p75 web vitals of the last 7 days, streamed. */
export const load: PageServerLoad = (event) => {
	const vitals = vitalsFor(event);
	logWhenSettled(event.route.id, [vitals]);
	return { vitals };
};
