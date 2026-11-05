import { getSchedule, saveSchedule } from '#lib/server/services/profile/index.ts';
import { ownerId, stepActions } from '../../profile-forms.server';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => ({
	schedule: await getSchedule(ownerId(locals))
});

export const actions: Actions = stepActions('schedule', saveSchedule);
