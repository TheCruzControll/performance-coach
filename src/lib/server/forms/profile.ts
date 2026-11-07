/**
 * Form actions for the training profile, shared by the Profile edit screens and the onboarding
 * steps: both save through the same services (src/lib/server/services/profile), so a section
 * behaves the same wherever it is edited, and the same as when the coach edits it. A change made
 * from onboarding is recorded as one (`source: 'onboarding'`).
 *
 * A section posts its state as JSON in a `payload` field (src/lib/client/profile-form.ts). The
 * services validate it again and stay the authority: input the owner can fix becomes
 * `fail(400, { errors })` keyed by dotted field path, a record that no longer exists
 * `fail(404, { message })`.
 */
import { fail, redirect } from '@sveltejs/kit';
import { previousStep, type OnboardingStep } from '../../domain/profile/onboarding';
import {
	advanceOnboarding,
	completeOnboarding,
	createGoal,
	deleteGoal,
	getOnboarding,
	isProfileInputError,
	listGoals,
	ProfileNotFoundError,
	reorderGoals,
	updateGoal,
	type ChangeSource,
	type ProfileDeps
} from '../services/profile';
import { ownerId, readForm, type FormEvent } from './read';

export { ownerId, type FormEvent };

/** A service function that saves one section, e.g. `saveEquipment`. */
export type SaveSection = (owner: string, payload: unknown, deps: ProfileDeps) => Promise<unknown>;

/** Run a save; the owner's input errors and missing records become form failures. */
async function attempt<T>(save: () => Promise<T>) {
	try {
		return { ok: true as const, value: await save() };
	} catch (err) {
		if (isProfileInputError(err)) {
			return { ok: false as const, failure: fail(400, { errors: err.errors }) };
		}
		if (err instanceof ProfileNotFoundError) {
			const message = 'That no longer exists. Reload to see the latest.';
			return { ok: false as const, failure: fail(404, { message }) };
		}
		throw err;
	}
}

/**
 * A Profile edit screen's `save` action: store the section, then `{ saved: true, section }`
 * with the section as stored, which the screen edits from then on (a new injury's id, say).
 */
export function editAction(saveSection: SaveSection) {
	return async ({ locals, request }: FormEvent) => {
		const owner = ownerId(locals);
		const { payload } = await readForm(request);
		const result = await attempt(() => saveSection(owner, payload, { source: 'profile' }));
		if (!result.ok) return result.failure;
		return { saved: true as const, section: result.value };
	};
}

/** What a goal action runs with: a Profile change unless `source` says otherwise. */
type GoalDeps = Pick<ProfileDeps, 'db' | 'source'>;
const goalChange = (deps: GoalDeps) => ({ source: 'profile' as ChangeSource, ...deps });

/**
 * Profile → Goals' `saveGoal` action: add a goal, or change the one its `id` names (an id that
 * names no goal is a 404, never a new goal), as a Profile change. Returns the ranking the
 * services keep, so the screen shows it as stored, and the saved goal's id.
 */
export async function saveGoalAction({ locals, request }: FormEvent, deps: GoalDeps = {}) {
	const owner = ownerId(locals);
	const { payload } = await readForm(request);
	const { id, ...goal } = (payload ?? {}) as { id?: unknown };
	const change = goalChange(deps);
	const result = await attempt(() =>
		id === undefined
			? createGoal(owner, goal, change)
			: updateGoal(owner, typeof id === 'string' ? id : '', goal, change)
	);
	if (!result.ok) return result.failure;
	return { goals: await listGoals(owner, deps), saved: result.value.id };
}

/**
 * Profile → Goals' `deleteGoal` action: delete for good the goal its `id` names (an id that names
 * none of the owner's goals is a 404), as a Profile change. The services close the gap it leaves
 * in the ranking and keep its history; returns the ranking as stored.
 */
export async function deleteGoalAction({ locals, request }: FormEvent, deps: GoalDeps = {}) {
	const owner = ownerId(locals);
	const { payload } = await readForm(request);
	const { id } = (payload ?? {}) as { id?: unknown };
	const change = goalChange(deps);
	const result = await attempt(() => deleteGoal(owner, typeof id === 'string' ? id : '', change));
	if (!result.ok) return result.failure;
	return { goals: await listGoals(owner, deps) };
}

/**
 * Profile → Goals' `reorderGoals` action: rank the open goals in the order its `ids` list them,
 * top priority first, as a Profile change. The services refuse a list that leaves out, repeats or
 * adds a goal (a field error, so nothing is stored); returns the ranking as stored.
 */
export async function reorderGoalsAction({ locals, request }: FormEvent, deps: GoalDeps = {}) {
	const owner = ownerId(locals);
	const { payload } = await readForm(request);
	const result = await attempt(() => reorderGoals(owner, payload, goalChange(deps)));
	if (!result.ok) return result.failure;
	return { goals: result.value };
}

// ---- onboarding --------------------------------------------------------------------------------

/** Where a step lives (the route's own URLs: these actions never build one). */
export type StepHref = (step: OnboardingStep) => string;

/** Mark `step` done or skipped, then go on to the next step that applies. */
async function advance(
	owner: string,
	step: OnboardingStep,
	action: 'complete' | 'skip',
	href: StepHref,
	deps: Pick<ProfileDeps, 'db'>
) {
	// A step that cannot be skipped is a field error, and nothing is stored.
	const result = await attempt(() => advanceOnboarding(owner, { step, action }, deps));
	if (!result.ok) return result.failure;
	redirect(303, href(result.value));
}

/**
 * One onboarding step's actions. `save` (Continue) stores the step's section, when it has one,
 * as an onboarding change, marks the step done and redirects to the next step: save as you go.
 * Goals save one at a time, so their Continue only checks that one is open. `skip` marks an
 * optional step skipped and moves on without saving; the services refuse it on a required step.
 *
 * Leaving a step saves it too, without marking it done: `then=back` (Back) redirects to the step
 * before among those that apply now (the domain's previousStep, so a step that no longer applies
 * goes back to the one before it in the full order), and `then=later` (Finish later) returns
 * `{ saved: true }` for the screen to go on to Today.
 */
export function stepActions(
	step: OnboardingStep,
	saveSection: SaveSection | undefined,
	href: StepHref,
	deps: Pick<ProfileDeps, 'db'> = {}
) {
	return {
		save: async ({ locals, request }: FormEvent) => {
			const owner = ownerId(locals);
			const { payload, then } = await readForm(request);
			if (saveSection) {
				const change = { ...deps, source: 'onboarding' } as const;
				const result = await attempt(() => saveSection(owner, payload, change));
				if (!result.ok) return result.failure;
			}
			if (then === 'later') return { saved: true as const };
			if (then === 'back') {
				// The steps that apply once this save is in: experience can bring or drop specifics.
				const { steps } = await getOnboarding(owner, deps);
				redirect(303, href(previousStep(steps, step) ?? step));
			}
			if (step === 'goals' && !(await listGoals(owner, deps)).some((g) => g.priority !== null)) {
				return fail(400, { errors: { goals: 'Add at least one goal to continue.' } });
			}
			return advance(owner, step, 'complete', href, deps);
		},
		skip: ({ locals }: FormEvent) => advance(ownerId(locals), step, 'skip', href, deps)
	};
}

/**
 * The review step's Start coaching: finish onboarding, which needs one open goal and a schedule
 * (each missing one is a field error), and redirect to `to` (Today).
 */
export async function completeAction(
	{ locals }: FormEvent,
	to: string,
	deps: Pick<ProfileDeps, 'db'> = {}
) {
	const result = await attempt(() => completeOnboarding(ownerId(locals), deps));
	if (!result.ok) return result.failure;
	redirect(303, to);
}
