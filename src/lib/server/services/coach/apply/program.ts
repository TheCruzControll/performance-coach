/**
 * Applying program proposals (the M5 plan's apply-program-proposals): a program_adjustment or a
 * workout_update is every one of its ops as one new version of the active program, through M3's
 * edits (applyProgramEdits, source 'coach'), with one coach decision per op whose 'why' is the
 * proposal's rationale and whose evidence names the proposal. acceptProposal then stores the
 * version as applied_version_id and closes the proposal, in the same transaction.
 *
 * - The version is made on the base the proposal was drafted on. If another version became
 *   current meanwhile (an owner edit racing the accept), it is superseded ('program_changed') and
 *   nothing is written.
 * - An op its edit refuses at accept (a session done since, two ops at odds) is a
 *   ProposalRefusedError at payload.ops.n: nothing is written and the proposal stays proposed.
 * - A workout_update is refused once its workout has started (WORKOUT_STARTED): a workout in
 *   progress or completed against its session, which a session substitution changes instead.
 * - new_program and next_cycle stay stubs until apply-session-program-cycle replaces them.
 */
import type { Proposal } from '../../../../domain/coach/proposals';
import { createProgramsRepository } from '../../../db/repositories/programs';
import { applyProgramEdits } from '../../programs/batch';
import { ProgramConflictError, TrainingInputError } from '../../training/shared';
import { listActiveWorkouts } from '../../workouts/canonical';
import { ProposalRefusedError } from '../proposals';
import { unavailable, type ApplyInput, type ApplyOutcome, type Appliers } from './types';

/** Why a workout_update is refused at accept once its session's workout has begun. */
export const WORKOUT_STARTED = 'This workout has already started';

const PROGRAM_CHANGED: ApplyOutcome = { status: 'superseded', reason: 'program_changed' };

/**
 * Whether a workout has begun on `lineage`: one in progress (among the newest the owner has, as
 * Today lists them), or one completed.
 */
async function workoutStarted(ownerId: string, lineage: string, { db }: ApplyInput['deps']) {
	const { workouts } = await listActiveWorkouts(ownerId, { db });
	if (workouts.some((w) => w.plannedLineage === lineage)) return true;
	const done = await createProgramsRepository(db).completedLineages(ownerId, [lineage]);
	return done.has(lineage);
}

/** Apply the proposal's ops as one version on its base. */
async function applyOps(
	input: Omit<ApplyInput, 'proposal'>,
	proposal: Extract<Proposal, { kind: 'program_adjustment' | 'workout_update' }>
): Promise<ApplyOutcome> {
	const { ownerId, proposalId, baseVersionId, today, deps } = input;
	const current = await createProgramsRepository(deps.db).currentProgram(ownerId);
	if (!current || current.version.id !== baseVersionId) return PROGRAM_CHANGED;
	const { title, rationale, payload } = proposal;
	try {
		const version = await applyProgramEdits(
			ownerId,
			{
				baseVersion: current.version.number,
				today,
				ops: payload.ops,
				title,
				rationale,
				evidence: { proposalId }
			},
			{ db: deps.db, now: deps.now, source: 'coach' }
		);
		return { status: 'applied', appliedVersionId: version.versionId };
	} catch (error) {
		if (error instanceof ProgramConflictError) return PROGRAM_CHANGED;
		if (error instanceof TrainingInputError) {
			throw new ProposalRefusedError(
				Object.fromEntries(Object.entries(error.errors).map(([k, m]) => [`payload.${k}`, m]))
			);
		}
		throw error;
	}
}

export const PROGRAM_APPLIERS: Pick<
	Appliers,
	'program_adjustment' | 'workout_update' | 'new_program' | 'next_cycle'
> = {
	program_adjustment: (input) => applyOps(input, input.proposal),

	async workout_update(input) {
		// proposal-rules holds every op of a workout_update to one session.
		const lineage = input.proposal.payload.ops[0]!.sessionLineage;
		if (await workoutStarted(input.ownerId, lineage, input.deps)) {
			throw new ProposalRefusedError({ 'payload.ops.0.sessionLineage': WORKOUT_STARTED });
		}
		return applyOps(input, input.proposal);
	},

	new_program: unavailable('new_program'),
	next_cycle: unavailable('next_cycle')
};
