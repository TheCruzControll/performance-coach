import { redirect } from '@sveltejs/kit';
import { version } from '$app/env';
import { programAction } from '#lib/server/forms/program.ts';
import { ownerId } from '#lib/server/forms/read.ts';
import { archiveProgram } from '#lib/server/services/programs/index.ts';
import { addActions } from './add.server';
import type { Actions, PageServerLoad } from './$types';
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
		? {
				...week,
				road: loadTrainRoad(owner, {
					today: week.today,
					firstPlannedDay: week.program.firstPlannedDay,
					origin
				})
			}
		: week;
};

const endPlan = programAction((owner) => archiveProgram(owner));

const { addSession } = addActions();

export const actions = {
	/**
	 * Add Session: a session on a day of a planned week (add.server.ts). The sheet posts it as ?/addSession.
	 */
	addSession,
	/**
	 * End this plan: the program is archived (services/programs/archive.ts) and the owner lands on
	 * Today, where Build my program starts the next one. A workout in progress is a 409
	 * ('workout_in_progress') the plan sheet words; with no active program it lands on Today too.
	 */
	end: async (event) => {
		const result = await endPlan(event);
		if ('archived' in result) redirect(303, '/today');
		return result;
	}
} satisfies Actions;
