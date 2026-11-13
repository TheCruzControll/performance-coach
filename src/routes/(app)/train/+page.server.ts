import { version } from '$app/env';
import { ownerId } from '#lib/server/forms/read.ts';
import type { PageServerLoad } from './$types';
import { loadTrainRoad } from './road.server';
import { loadTrainWeek } from './week.server';

/**
 * Train's week, server-rendered for the owner's today or for ?week=n (week.server.ts), and with a
 * program the season for the plan sheet, streamed after it (road.server.ts: null when its read
 * fails, which is recorded).
 */
export const load: PageServerLoad = async ({ locals, request, route, url }) => {
	const owner = ownerId(locals);
	const origin = {
		requestId: locals.requestId,
		method: request.method,
		path: url.pathname,
		routeId: route.id,
		appVersion: version
	};
	const week = await loadTrainWeek(owner, {
		now: new Date(),
		week: url.searchParams.get('week'),
		origin
	});
	return week.state === 'program'
		? { ...week, road: loadTrainRoad(owner, { today: week.today, origin }) }
		: week;
};
