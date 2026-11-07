/**
 * Onboarding's URLs, for the route's server and its screens alike: one per step, built from the
 * route id (welcome is /onboarding itself).
 */
import { resolve } from '$app/paths';
import type { OnboardingStep } from '#lib/domain/profile/onboarding.ts';

export const stepHref = (step: OnboardingStep) =>
	resolve('/onboarding/[[step]]', step === 'welcome' ? {} : { step });

/** Where onboarding ends, and where "Finish later" goes. */
export const todayHref = () => resolve('/(app)/today');
