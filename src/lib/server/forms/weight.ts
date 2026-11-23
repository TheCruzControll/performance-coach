/**
 * Form actions for the weight screens: the Weight view on Progress, and Today's log card. Each one
 * posts its state as JSON in a `payload` field (read.ts), and the weight services
 * (src/lib/server/services/weight) validate it again and stay the authority:
 * - input the owner can fix becomes `fail(400, { errors })`, keyed by field path
 * - a weigh-in, or a goal's milestones, that no longer exists becomes `fail(404, { message })`
 *
 * Only the actions that name a record can answer 404: editWeight, deleteWeight and editMilestones.
 * logWeight and setGoal create, and clearGoal and setPhase change the profile, which always exists.
 *
 * Every write is the owner's own, so it is recorded with source 'log' (WeightSource), never
 * 'coach': the coach's writes come through its tools and Undo, not these forms.
 */
import { ProfileInputError } from '../services/profile';
import {
	clearWeightGoal,
	deleteWeight,
	editMilestones,
	editWeight,
	logWeight,
	setNutritionPhase,
	setWeightGoal,
	type WeightDeps
} from '../services/weight';
import { attempt } from './profile';
import { ownerId, readForm, type FormEvent } from './read';

/** What an action runs with: the database and the clock (a test's own), never the source. */
export type WeightFormDeps = Pick<WeightDeps, 'db' | 'now'>;

/** The owner's own writes: the services record them as 'log'. */
const logged = (deps: WeightFormDeps): WeightDeps => ({ ...deps, source: 'log' });

/** A payload as its fields. Anything that is not an object has none, so the services refuse it. */
function fieldsOf(payload: unknown): Record<string, unknown> {
	return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
		? (payload as Record<string, unknown>)
		: {};
}

/** The weigh-in an `id` names: a positive whole number. Anything else is a field error (400). */
function weighInId(id: unknown): number {
	if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return id;
	throw new ProfileInputError({ id: 'Pick a weigh-in' });
}

/**
 * Today's log card, and the Weight view's log form: record the weigh-in for its day (today unless
 * the payload names another). A day that already has one is replaced; the answer is the entry as
 * stored and the one it replaced, if any.
 */
export async function logWeightAction(event: FormEvent, deps: WeightFormDeps = {}) {
	const owner = ownerId(event.locals);
	const { payload } = await readForm(event.request);
	const result = await attempt(() => logWeight(owner, payload, logged(deps)));
	if (!result.ok) return result.failure;
	return { entry: result.value.entry, replaced: result.value.replaced };
}

/**
 * The Weight view's edit form: change the weigh-in the payload's `id` names. Its day may move,
 * onto a day with no weigh-in (a day that has one is a 400 at `measuredOn`). The answer is the
 * entry as stored. An id that names no weigh-in of the owner's is a 404.
 */
export async function editWeightAction(event: FormEvent, deps: WeightFormDeps = {}) {
	const owner = ownerId(event.locals);
	const { payload } = await readForm(event.request);
	const { id, ...fields } = fieldsOf(payload);
	const result = await attempt(() => editWeight(owner, weighInId(id), fields, logged(deps)));
	if (!result.ok) return result.failure;
	return { entry: result.value };
}

/**
 * The Weight view's delete: remove the weigh-in the payload's `id` names, for good. An id that
 * names no weigh-in of the owner's is a 404.
 */
export async function deleteWeightAction(event: FormEvent, deps: WeightFormDeps = {}) {
	const owner = ownerId(event.locals);
	const { payload } = await readForm(event.request);
	const { id } = fieldsOf(payload);
	const result = await attempt(async () => {
		await deleteWeight(owner, weighInId(id), logged(deps));
	});
	if (!result.ok) return result.failure;
	return { deleted: true as const };
}

/**
 * The goal sheet's save: set the owner's one goal (the target, its goal-by day, and optionally the
 * unit and the step between milestones). A new goal ends the active one. The answer is the goal as
 * stored, and the nutrition phase it suggests: 'cut' for a loss, 'bulk' for a gain, or null.
 */
export async function setGoalAction(event: FormEvent, deps: WeightFormDeps = {}) {
	const owner = ownerId(event.locals);
	const { payload } = await readForm(event.request);
	const result = await attempt(() => setWeightGoal(owner, payload, logged(deps)));
	if (!result.ok) return result.failure;
	return { goal: result.value.goal, phasePrompt: result.value.phasePrompt };
}

/**
 * The goal sheet's milestone editor: replace the milestones of the active goal the payload's
 * `goalId` names, with its `milestones` list. A goal that is not the active one (ended, or never
 * the owner's) is a 404, and a milestone outside the goal's days, or out of range, is a 400.
 */
export async function editMilestonesAction(event: FormEvent, deps: WeightFormDeps = {}) {
	const owner = ownerId(event.locals);
	const { payload } = await readForm(event.request);
	const { goalId, ...list } = fieldsOf(payload);
	const result = await attempt(() =>
		editMilestones(owner, typeof goalId === 'string' ? goalId : '', list, logged(deps))
	);
	if (!result.ok) return result.failure;
	return { milestones: result.value };
}

/**
 * The goal sheet's clear: end the active goal as 'cleared' (it stays in the history) and clear the
 * profile's target. With no goal it still clears the profile's target, and answers `goal: null`.
 */
export async function clearGoalAction(event: FormEvent, deps: WeightFormDeps = {}) {
	const owner = ownerId(event.locals);
	const goal = await clearWeightGoal(owner, logged(deps));
	return { goal };
}

/**
 * The phase prompt's answer: set the owner's nutrition phase (`nutritionPhase`; null clears it).
 * Only the phase changes: a program re-plan still goes through the proposal the owner accepts. A
 * payload with no `nutritionPhase` key, or an unknown phase, is a 400.
 */
export async function setPhaseAction(event: FormEvent, deps: WeightFormDeps = {}) {
	const owner = ownerId(event.locals);
	const { payload } = await readForm(event.request);
	const { nutritionPhase } = fieldsOf(payload);
	const result = await attempt(() => setNutritionPhase(owner, nutritionPhase, logged(deps)));
	if (!result.ok) return result.failure;
	return { nutritionPhase: result.value.nutritionPhase };
}
