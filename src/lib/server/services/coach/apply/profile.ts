/**
 * Applying goal and preference proposals (the M5 plan's apply-profile-proposals): through the
 * same services the Profile screens use, with source 'coach', so validation, ranking, history and
 * the per-owner locks are the screens' own. Each records a coach_decision note carrying the
 * proposal's rationale as its why.
 *
 * - goal_update runs its ops in order through M2's goal services (each in a savepoint of the
 *   accept transaction), so goalHistory shows every change with source 'coach'. Its applied_ref
 *   is the first goal it changes: the goal it adds or edits, or the new top goal of a reorder.
 * - preference_update records the like or dislike through recordExercisePreference, under the
 *   preference lock every writer takes. Its applied_ref is the preference; no version is made.
 *
 * What a service refuses at accept (a goal deleted meanwhile, a ranking that no longer names
 * every open goal, an exercise no longer in the library) is a ProposalRefusedError at the op's
 * payload path: the accept transaction writes nothing and the proposal stays proposed.
 */
import { RULE_MESSAGES } from '../../../../domain/coach/proposal-rules';
import type { GoalOp, Proposal } from '../../../../domain/coach/proposals';
import { REF_LABEL_MAX, type SourceRef } from '../../../../domain/coach/sources';
import type { FieldErrors } from '../../../../domain/validation';
import {
	createGoal,
	ProfileInputError,
	ProfileNotFoundError,
	reorderGoals,
	setGoalStatus,
	updateGoal,
	type ProfileDeps
} from '../../profile';
import { recordExercisePreference } from '../../training/preferences';
import { TrainingInputError, TrainingNotFoundError } from '../../training/shared';
import { recordCoachDecision } from '../notes';
import { ProposalRefusedError } from '../proposals';
import type { Appliers, ApplyInput } from './types';

/**
 * `error` as a refusal when a service refused the change: what it could not find at `missing`,
 * field errors under `fields`. Anything else is returned as it is.
 */
function refusal(
	error: unknown,
	{ fields, missing, message }: { fields: string; missing: string; message: string }
): unknown {
	if (error instanceof ProfileNotFoundError || error instanceof TrainingNotFoundError) {
		return new ProposalRefusedError({ [missing]: message });
	}
	if (error instanceof ProfileInputError || error instanceof TrainingInputError) {
		const errors: FieldErrors = {};
		for (const [field, text] of Object.entries(error.errors)) {
			errors[field ? `${fields}.${field}` : fields] = text;
		}
		return new ProposalRefusedError(errors);
	}
	return error;
}

/** A ref's label, cut to what a ref may carry. */
const label = (text: string) => Array.from(text).slice(0, REF_LABEL_MAX).join('').trim();

/** Run one goal op through M2's services; the goals it changed, the first one first. */
async function applyGoalOp(ownerId: string, op: GoalOp, deps: ProfileDeps): Promise<string[]> {
	switch (op.op) {
		case 'add':
			return [(await createGoal(ownerId, op.goal, deps)).id];
		case 'edit':
			return [(await updateGoal(ownerId, op.goalId, op.goal, deps)).id];
		case 'set_status':
			return [(await setGoalStatus(ownerId, op.goalId, { status: op.status }, deps)).id];
		case 'reorder':
			await reorderGoals(ownerId, { ids: op.ids }, deps);
			return [...op.ids];
	}
}

/** The coach_decision note for an applied proposal: its title, its rationale, what it changed. */
function recordDecision(
	input: Pick<ApplyInput, 'ownerId' | 'proposalId' | 'deps'> & {
		proposal: Pick<Proposal, 'kind' | 'title' | 'rationale'>;
	},
	subjects: SourceRef[]
) {
	const { ownerId, proposalId, proposal, deps } = input;
	return recordCoachDecision(
		ownerId,
		{
			decision: {
				kind: proposal.kind,
				what: proposal.title,
				why: proposal.rationale,
				proposalId,
				ownerWords: null
			},
			subjects
		},
		deps
	);
}

export const PROFILE_APPLIERS: Pick<Appliers, 'goal_update' | 'preference_update'> = {
	async goal_update(input) {
		const { ownerId, proposal, deps } = input;
		const profileDeps: ProfileDeps = { db: deps.db, now: deps.now, source: 'coach' };
		const changed: string[] = [];
		for (const [i, op] of proposal.payload.ops.entries()) {
			const at = `payload.ops.${i}`;
			try {
				changed.push(...(await applyGoalOp(ownerId, op, profileDeps)));
			} catch (error) {
				throw refusal(error, {
					fields: op.op === 'add' || op.op === 'edit' ? `${at}.goal` : at,
					missing: `${at}.goalId`,
					message: RULE_MESSAGES.unknownGoal
				});
			}
		}
		const goals = [...new Set(changed)];
		await recordDecision(
			input,
			goals.map((id): SourceRef => ({ type: 'goal', id }))
		);
		return { status: 'applied', appliedRef: { kind: 'goal', id: goals[0]! } };
	},

	async preference_update(input) {
		const { ownerId, proposal, deps } = input;
		const { exerciseId, sentiment, reason } = proposal.payload;
		let preference;
		try {
			preference = await recordExercisePreference(
				ownerId,
				{ exerciseId, sentiment, reason, source: 'coach' },
				{ db: deps.db, now: deps.now }
			);
		} catch (error) {
			throw refusal(error, {
				fields: 'payload',
				missing: 'payload.exerciseId',
				message: RULE_MESSAGES.unknownExercise
			});
		}
		const name = label(preference.exercise);
		await recordDecision(input, [
			{ type: 'preference', id: preference.id, ...(name && { label: name }) },
			{ type: 'exercise', id: exerciseId, ...(name && { label: name }) }
		]);
		return { status: 'applied', appliedRef: { kind: 'preference', id: preference.id } };
	}
};
