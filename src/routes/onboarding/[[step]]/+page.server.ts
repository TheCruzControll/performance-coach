import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import {
	isOnboardingStep,
	nextStep,
	ONBOARDING_STEPS,
	type OnboardingStep
} from '#lib/domain/profile/onboarding.ts';
import {
	completeAction,
	deleteGoalAction,
	ownerId,
	reorderGoalsAction,
	saveGoalAction,
	stepActions
} from '#lib/server/forms/profile.ts';
import { profileSection, sectionContext } from '#lib/server/forms/sections.ts';
import { getOnboarding, getTrainingProfile } from '#lib/server/services/profile/index.ts';
import type { SectionKey } from '#lib/ui/profile/sections.ts';
import { stepHref, todayHref } from '../paths';
import type { Actions, PageServerLoad } from './$types';

/**
 * Onboarding, one step per URL (/onboarding is the welcome). There is no param matcher (it would
 * cost every route's initial JS, docs/performance.md): a step that does not exist is a 404, from
 * the load and from every action. Loads have no side effects: where to resume is the furthest
 * step advanced, which only Continue and Skip move.
 */
function stepOf(param: string | undefined): OnboardingStep {
	if (param === undefined) return 'welcome';
	// One URL per step: the welcome is /onboarding, never /onboarding/welcome.
	if (param === 'welcome' || !isOnboardingStep(param)) error(404, 'Not found');
	return param;
}

/**
 * A step opened from the review's Edit (`?then=review`, fromReviewHref): Continue and Skip go
 * back to the review instead of walking every later step again.
 */
const fromReview = (url: URL) => url.searchParams.get('then') === 'review';
const onward = (url: URL) => (fromReview(url) ? () => stepHref('review') : stepHref);

/** The Profile section a step edits: welcome edits name and units, review edits none. */
function sectionOf(step: OnboardingStep): SectionKey | null {
	if (step === 'review') return null;
	return step === 'welcome' ? 'basics' : step;
}

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const step = stepOf(params.step);
	const owner = ownerId(locals);
	const { complete, steps, progress, resume } = await getOnboarding(owner);
	if (complete) redirect(303, todayHref());
	// Specifics without a running or Muay Thai goal, say: on to the next step that applies.
	if (!steps.includes(step)) redirect(303, stepHref(nextStep(steps, step)));
	const key = sectionOf(step);
	// Separate pool calls, not one transaction: they may run together (docs/architecture.md).
	const [saved, context] = key
		? await Promise.all([profileSection(key).load(owner), sectionContext(owner)])
		: [null, null];
	return {
		step,
		key,
		saved,
		context,
		// The review shows every answer: the whole training profile, one block per step.
		profile: step === 'review' ? await getTrainingProfile(owner) : null,
		fromReview: step !== 'review' && fromReview(url),
		steps,
		completed: progress.completed.filter((s) => steps.includes(s)),
		skipped: progress.skipped.filter((s) => steps.includes(s)),
		// On the welcome, once the owner has moved past it: the step to pick up at. Not when the
		// review's Edit opened it: the owner is editing their name, and goes back to the review.
		resume: step === 'welcome' && !fromReview(url) && resume !== 'welcome' ? resume : null
	};
};

/** An action for some steps only; on any other it does not exist. */
const on =
	<T>(only: OnboardingStep[], action: (event: RequestEvent, step: OnboardingStep) => T) =>
	(event: RequestEvent) => {
		const step = stepOf(event.params.step);
		if (!only.includes(step)) error(404, 'Not found');
		return action(event, step);
	};

/** Every step but review edits a section. */
const EDITING = ONBOARDING_STEPS.filter((step) => step !== 'review');
const onboardingGoals = { source: 'onboarding' } as const;

export const actions: Actions = {
	save: on(EDITING, (event, step) =>
		stepActions(step, profileSection(sectionOf(step)!).save, onward(event.url)).save(event)
	),
	// Refused on a required step by the services (a field error): only optional steps move on.
	skip: (event) => stepActions(stepOf(event.params.step), undefined, onward(event.url)).skip(event),
	complete: on(['review'], (event) => completeAction(event, todayHref())),
	saveGoal: on(['goals'], (event) => saveGoalAction(event, onboardingGoals)),
	deleteGoal: on(['goals'], (event) => deleteGoalAction(event, onboardingGoals)),
	reorderGoals: on(['goals'], (event) => reorderGoalsAction(event, onboardingGoals))
};
