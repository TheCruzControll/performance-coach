/**
 * Form actions shared by the onboarding steps (/onboarding/*) and the Profile edit screens
 * (/profile/*): both save through the same services (src/lib/server/services/profile), so a
 * section behaves the same wherever it is edited — and the same as when the coach edits it.
 *
 * Sections post their state as JSON in a `payload` field (src/lib/client/profile-form.ts).
 * Validation failures become `fail(400, { errors })` keyed by field path.
 */
import { error, fail, redirect, type Action, type RequestEvent } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import type { OnboardingStep } from '#lib/domain/profile/onboarding.ts';
import {
	advanceOnboarding,
	completeOnboarding,
	createGoal,
	deleteGoal,
	getAthleteProfile,
	getOnboarding,
	isProfileInputError,
	listGoals,
	ProfileNotFoundError,
	reorderGoals,
	setGoalStatus,
	updateGoal,
	type ChangeSource,
	type ProfileDeps
} from '#lib/server/services/profile/index.ts';

/** The signed-in owner (the auth guard already refused anyone else). */
export function ownerId(locals: App.Locals): string {
	if (!locals.session || locals.session.kind !== 'owner') error(401, 'Sign in to continue.');
	return locals.session.ownerId;
}

async function readForm(request: Request) {
	const form = await request.formData();
	const raw = form.get('payload');
	let payload: unknown = undefined;
	if (typeof raw === 'string' && raw !== '') {
		try {
			payload = JSON.parse(raw);
		} catch {
			error(400, 'The form could not be read. Reload and try again.');
		}
	}
	const then = form.get('then');
	return { payload, then: typeof then === 'string' ? then : null };
}

/** Run a save; the owner's input errors and missing records become form failures. */
async function attempt<T>(fn: () => Promise<T>) {
	try {
		return { ok: true as const, value: await fn() };
	} catch (err) {
		if (isProfileInputError(err)) return { ok: false as const, failure: fail(400, { errors: err.errors }) };
		if (err instanceof ProfileNotFoundError) {
			return {
				ok: false as const,
				failure: fail(404, { message: 'That no longer exists. Reload to see the latest.' })
			};
		}
		throw err;
	}
}

type Save = (owner: string, payload: unknown, deps: ProfileDeps) => Promise<unknown>;

/** The URL of an onboarding step. */
export function stepPath(step: OnboardingStep): string {
	return step === 'welcome' ? resolve('/onboarding') : `${resolve('/onboarding')}/${step}`;
}

/** Context every section editor needs: the disciplines in play and the owner's units. */
export async function sectionContext(owner: string) {
	const [onboarding, profile] = await Promise.all([
		getOnboarding(owner),
		getAthleteProfile(owner)
	]);
	return {
		disciplines: onboarding.disciplines,
		weightUnit: profile.weightUnit,
		distanceUnit: profile.distanceUnit
	};
}

/**
 * Onboarding step actions: `save` stores the section and moves on (`then=back` stores it and
 * goes back instead, without marking the step done); `skip` moves on without saving.
 */
export function stepActions(step: OnboardingStep, saveSection?: Save) {
	const save: Action = async ({ locals, request }) => {
		const owner = ownerId(locals);
		const { payload, then } = await readForm(request);
		if (saveSection) {
			const result = await attempt(() => saveSection(owner, payload, { source: 'onboarding' }));
			if (!result.ok) return result.failure;
		}
		if (then === 'back') {
			const { steps } = await getOnboarding(owner);
			const i = steps.indexOf(step);
			redirect(303, stepPath(steps[Math.max(0, i - 1)] ?? 'welcome'));
		}
		if (step === 'goals' && !(await listGoals(owner)).some((g) => g.priority !== null)) {
			return fail(400, { errors: { goals: 'Add at least one goal to continue' } });
		}
		redirect(303, stepPath(await advanceOnboarding(owner, { step, action: 'complete' })));
	};
	const skip: Action = async ({ locals }) => {
		const owner = ownerId(locals);
		redirect(303, stepPath(await advanceOnboarding(owner, { step, action: 'skip' })));
	};
	return { save, skip };
}

/** The review step: finish onboarding (a goal and a schedule are required) and go to Today. */
export const completeAction: Action = async ({ locals }) => {
	const owner = ownerId(locals);
	const result = await attempt(() => completeOnboarding(owner));
	if (!result.ok) return result.failure;
	redirect(303, resolve('/(app)/today'));
};

/** Profile edit screen action: save the section and return what was stored. */
export function editAction(saveSection: Save): Action {
	return async ({ locals, request }) => {
		const owner = ownerId(locals);
		const { payload } = await readForm(request);
		const result = await attempt(() => saveSection(owner, payload, { source: 'profile' }));
		if (!result.ok) return result.failure;
		return { saved: true };
	};
}

/**
 * Goal actions (the goals step and Profile → Goals): every change persists at once and the
 * screen gets the new ranked list back.
 */
export function goalActions(source: ChangeSource) {
	const deps = { source };
	const done = async (owner: string) => ({ goals: await listGoals(owner) });
	return {
		saveGoal: async ({ locals, request }: RequestEvent) => {
			const owner = ownerId(locals);
			const { payload } = await readForm(request);
			const { id, ...goal } = (payload ?? {}) as { id?: unknown };
			const result = await attempt(() =>
				typeof id === 'string' && id
					? updateGoal(owner, id, goal, deps)
					: createGoal(owner, goal, deps)
			);
			if (!result.ok) return result.failure;
			return { ...(await done(owner)), savedId: result.value.id };
		},
		deleteGoal: async ({ locals, request }: RequestEvent) => {
			const owner = ownerId(locals);
			const { payload } = await readForm(request);
			const id = (payload as { id?: unknown } | undefined)?.id;
			if (typeof id !== 'string') return fail(400, { message: 'Which goal?' });
			const result = await attempt(() => deleteGoal(owner, id, deps));
			if (!result.ok) return result.failure;
			return done(owner);
		},
		reorderGoals: async ({ locals, request }: RequestEvent) => {
			const owner = ownerId(locals);
			const { payload } = await readForm(request);
			const result = await attempt(() => reorderGoals(owner, payload, deps));
			if (!result.ok) return result.failure;
			return done(owner);
		},
		goalStatus: async ({ locals, request }: RequestEvent) => {
			const owner = ownerId(locals);
			const { payload } = await readForm(request);
			const { id, ...status } = (payload ?? {}) as { id?: unknown };
			if (typeof id !== 'string') return fail(400, { message: 'Which goal?' });
			const result = await attempt(() => setGoalStatus(owner, id, status, deps));
			if (!result.ok) return result.failure;
			return done(owner);
		}
	};
}
