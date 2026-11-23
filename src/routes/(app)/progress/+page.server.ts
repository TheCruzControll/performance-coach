import { version } from '$app/env';
import { testRoutesEnabled } from '#lib/server/env.ts';
import { ownerId } from '#lib/server/forms/read.ts';
import {
	clearGoalAction,
	deleteWeightAction,
	editMilestonesAction,
	editWeightAction,
	logWeightAction,
	setGoalAction,
	setPhaseAction
} from '#lib/server/forms/weight.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import { logWhenSettled } from '#lib/server/observability/timing.ts';
import type { Actions, PageServerLoad } from './$types';
import { loadProgress, type ProgressDeps } from './load';
import { progressParams } from './params';
import { loadWeekSoFar } from './week.server';

/**
 * TEST ONLY: with test routes enabled (never in production), this cookie set to 'progress' makes
 * the view's read throw, so e2e can show the load-failed notice and recover with Retry.
 */
const FAIL_COOKIE = 'pc-test-fail';

const failing = (): never => {
	throw new Error('Forced failure (test routes)');
};

/**
 * Progress for the owner's today (worked out inside loadProgress, so it fails soft too), the view
 * and period from the URL (load.ts, params.ts), and This week's figures, streamed beside it
 * (week.server.ts) in every view. The forced failure leaves the week alone.
 */
export const load: PageServerLoad = async ({ cookies, locals, request, route, url }) => {
	const owner = ownerId(locals);
	const forced = testRoutesEnabled() && cookies.get(FAIL_COOKIE) === 'progress';
	const origin = {
		requestId: locals.requestId,
		method: request.method,
		path: url.pathname,
		routeId: route.id,
		appVersion: version
	};
	const week = ownerToday(owner, new Date())
		.then((today) => loadWeekSoFar(owner, { today, origin }))
		// ownerToday's own failure: the tiles' Retry.
		.catch(() => ({ failed: true }) as const);
	const data = await loadProgress(
		owner,
		{ ...progressParams(url.searchParams), origin },
		new Date(),
		forced
			? ({
					overview: failing,
					strength: failing,
					running: failing,
					general: failing
				} satisfies ProgressDeps)
			: {}
	);
	logWhenSettled(route.id, [week]);
	return { ...data, week };
};

/**
 * The Weight view's form actions (forms/weight.ts): log, edit and delete a weigh-in, set the goal,
 * edit its milestones, clear it, and set the nutrition phase.
 */
export const actions = {
	logWeight: logWeightAction,
	editWeight: editWeightAction,
	deleteWeight: deleteWeightAction,
	setGoal: setGoalAction,
	editMilestones: editMilestonesAction,
	clearGoal: clearGoalAction,
	setPhase: setPhaseAction
} satisfies Actions;
