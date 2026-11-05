import { listGoals } from '#lib/server/services/profile/index.ts';
import { goalActions, ownerId, stepActions } from '../../profile-forms.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const goals = await listGoals(ownerId(locals));
	return { goals: goals.filter((g) => g.priority !== null) };
};

export const actions: Actions = { ...stepActions('goals'), ...goalActions('onboarding') };
