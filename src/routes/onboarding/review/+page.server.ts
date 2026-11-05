import { getTrainingProfile } from '#lib/server/services/profile/index.ts';
import { completeAction, ownerId } from '../../profile-forms.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => ({
	profile: await getTrainingProfile(ownerId(locals))
});

export const actions: Actions = { complete: completeAction };
