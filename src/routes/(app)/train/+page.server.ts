import { redirect } from '@sveltejs/kit';
import { version } from '$app/env';
import { programAction } from '#lib/server/forms/program.ts';
import { ownerId } from '#lib/server/forms/read.ts';
import { archiveProgram } from '#lib/server/services/programs/index.ts';
import type { Actions, PageServerLoad } from './$types';
import { loadTrainWeek } from './week.server';

/** Train's week, server-rendered for the owner's today or for ?week=n (week.server.ts). */
export const load: PageServerLoad = ({ locals, request, route, url }) =>
	loadTrainWeek(ownerId(locals), {
		now: new Date(),
		week: url.searchParams.get('week'),
		origin: {
			requestId: locals.requestId,
			method: request.method,
			path: url.pathname,
			routeId: route.id,
			appVersion: version
		}
	});

const endPlan = programAction((owner) => archiveProgram(owner));

export const actions = {
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
