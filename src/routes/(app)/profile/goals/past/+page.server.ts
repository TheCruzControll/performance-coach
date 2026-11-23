import {
	deleteGoalAction,
	ownerId,
	replanAction,
	saveGoalAction
} from '#lib/server/forms/profile.ts';
import { listGoals } from '#lib/server/services/profile/index.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * Profile → Goals → Past goals: the goals achieved or dropped, as the services list them (the
 * latest to leave first). A goal opens the same sheet as on Goals, which posts to this page's
 * actions: the goal actions Goals has, but the reorder, since nothing here is ranked.
 *
 * It reloads with the Profile layout after a change: otherwise the page would be handed its first
 * load's goals again, and a goal just deleted or made active would come back.
 */
export const load: PageServerLoad = async ({ locals, depends }) => {
	depends('app:profile-answers');
	const goals = await listGoals(ownerId(locals));
	return { goals: goals.filter((g) => g.priority === null) };
};

export const actions: Actions = {
	saveGoal: (event) => saveGoalAction(event),
	deleteGoal: (event) => deleteGoalAction(event),
	replan: (event) => replanAction(event)
};
