import { getAthleteProfile, getOnboarding } from '#lib/server/services/profile/index.ts';
import { ownerId } from '../profile-forms.server';
import type { LayoutServerLoad } from './$types';

/** Progress for the step indicator, and the context every step needs (disciplines, units). */
export const load: LayoutServerLoad = async ({ locals }) => {
	const owner = ownerId(locals);
	const [onboarding, profile] = await Promise.all([getOnboarding(owner), getAthleteProfile(owner)]);
	return {
		onboarding: {
			steps: onboarding.steps,
			completed: onboarding.progress.completed,
			skipped: onboarding.progress.skipped,
			complete: onboarding.complete,
			resume: onboarding.resume,
			started: onboarding.progress.completed.length + onboarding.progress.skipped.length > 0
		},
		profile: { name: profile.name },
		context: {
			disciplines: onboarding.disciplines,
			weightUnit: profile.weightUnit,
			distanceUnit: profile.distanceUnit
		}
	};
};
