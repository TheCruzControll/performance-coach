/**
 * Applying a session substitution (the M5 plan's apply-session-program-cycle) with M4's
 * semantics: a situational swap ('machine unavailable', 'just this once') stays in its session. It
 * never records a preference, and it never makes a program version while the workout is live.
 *
 * - In a workout (the one the proposal names, or one in progress on its session now): M4's
 *   exercise.substitute through the sync dispatcher's per-mutation entry point (applyMutation),
 *   with the proposal's id as the mutation id, so the substitution is claimed once in the ledger.
 *   Its applied_ref is the substitution row; the program's version stays as it was.
 * - With no workout: M3's one-off swap (scope 'once') as one new version of the active program,
 *   with a coach decision carrying the proposal's rationale.
 * - The workout gone (deleted, abandoned, another owner's) or finished, or the session done since:
 *   superseded, and nothing is written.
 * - What the dispatcher or M3's swap refuses (an exercise no longer the owner's) is a
 *   ProposalRefusedError at the payload's field: nothing is written and it stays proposed.
 */
import type { Proposal } from '../../../../domain/coach/proposals';
import type { SupersededReason } from '../../../../domain/coach/vocabulary';
import { SUBSTITUTION_REASON_LABEL } from '../../../../domain/training/vocabulary';
import type { FieldErrors } from '../../../../domain/validation';
import { createProgramsRepository } from '../../../db/repositories/programs';
import { createTrainingLogRepository } from '../../../db/repositories/training-log';
import { applyProgramEdits } from '../../programs/batch';
import { ProgramConflictError, TrainingInputError } from '../../training/shared';
import { listActiveWorkouts } from '../../workouts/canonical';
import { applyMutation } from '../../workouts/sync';
import { ProposalRefusedError } from '../proposals';
import type { ApplyInput, ApplyOutcome, Appliers } from './types';

/**
 * Decision (the M5 plan's 'gone or finished → superseded (expired)'): the stored superseded reasons
 * are a closed list that Postgres checks (coach_proposals_superseded_reason_ck), and this slice
 * adds no migration, so a substitution whose workout is over is superseded as 'program_changed'.
 * A dedicated reason ('session_ended') is one vocabulary entry and one migration in the schema
 * track; change it here then.
 */
export const SESSION_ENDED: SupersededReason = 'program_changed';

/** The proposal's workout or session no longer takes the substitution. */
const ENDED: ApplyOutcome = { status: 'superseded', reason: SESSION_ENDED };

/**
 * Whether a substitution today's rules refuse is over instead: the workout it names gone or
 * finished, or its session done. acceptProposal supersedes it then, so one accepted after its
 * session's day leaves the inbox rather than staying proposed as 'Already past'.
 */
export async function substitutionEnded(
	ownerId: string,
	proposal: Proposal,
	db: ApplyInput['deps']['db']
): Promise<boolean> {
	if (proposal.kind !== 'session_substitution') return false;
	const s = proposal.payload;
	if (s.workoutId) {
		const row = await createTrainingLogRepository(db).workout(ownerId, s.workoutId);
		return !row || row.deletedAt !== null || row.status !== 'in_progress';
	}
	const done = await createProgramsRepository(db).completedLineages(ownerId, [s.sessionLineage]);
	return done.has(s.sessionLineage);
}

/** Why a substitution naming another session's workout is refused. */
export const OTHER_SESSION = 'Not this session’s workout';

type Substitution = Extract<Proposal, { kind: 'session_substitution' }>['payload'];
type Input = ApplyInput<'session_substitution'>;

/** Where the dispatcher and M3's swap name a field, as the payload names it. */
const PAYLOAD_FIELD: Readonly<Record<string, string>> = {
	plannedLineage: 'plannedExerciseLineage',
	exercisePosition: 'position',
	exerciseId: 'toExerciseId'
};

/** Errors at the dispatcher's or the swap's paths, at the payload's. */
function atPayload(errors: FieldErrors | undefined, prefix: RegExp): FieldErrors {
	const entries = Object.entries(errors ?? {}).map(([path, message]) => {
		const field = path.replace(prefix, '').split('.')[0] ?? '';
		return [`payload.${PAYLOAD_FIELD[field] ?? field}`, message] as const;
	});
	return entries.length ? Object.fromEntries(entries) : { payload: 'This change cannot be made' };
}

/**
 * The live workout the substitution goes into: the one the payload names, or one in progress on
 * its session now. 'ended' when the named workout is gone or finished, null when there is none.
 */
async function workoutFor(input: Input, s: Substitution): Promise<string | 'ended' | null> {
	const { ownerId, deps } = input;
	if (s.workoutId) {
		const row = await createTrainingLogRepository(deps.db).workout(ownerId, s.workoutId);
		if (!row || row.deletedAt || row.status !== 'in_progress') return 'ended';
		if (row.plannedLineageId !== s.sessionLineage) {
			throw new ProposalRefusedError({ 'payload.workoutId': OTHER_SESSION });
		}
		return row.clientId;
	}
	const { workouts } = await listActiveWorkouts(ownerId, { db: deps.db });
	const live = workouts.find((w) => w.plannedLineage === s.sessionLineage);
	return live?.id ?? null;
}

/** M4's exercise.substitute in the live workout, under the proposal's id. */
async function substituteInWorkout(
	input: Input,
	s: Substitution,
	workoutId: string
): Promise<ApplyOutcome> {
	const { ownerId, proposalId, deps } = input;
	const mutation = {
		v: 1,
		id: proposalId,
		type: 'exercise.substitute',
		workoutId,
		entityId: proposalId,
		at: deps.now().toISOString(),
		payload: {
			position: s.position,
			plannedLineage: s.plannedExerciseLineage,
			fromExerciseId: s.fromExerciseId,
			toExerciseId: s.toExerciseId,
			reason: s.reason
		}
	};
	const result = await applyMutation(ownerId, mutation, { db: deps.db, now: deps.now });
	if (result.status === 'deferred' && result.code === 'missing') return ENDED;
	if (result.status !== 'applied' && result.status !== 'duplicate') {
		throw new ProposalRefusedError(atPayload(result.errors, /^payload\./));
	}
	const row = await createTrainingLogRepository(deps.db).substitution(ownerId, proposalId);
	if (!row) throw new Error('the applied substitution is not stored');
	return { status: 'applied', appliedRef: { kind: 'substitution', id: row.id } };
}

/** M3's one-off swap in the session, as one version on the proposal's base. */
async function swapOnce(input: Input, s: Substitution): Promise<ApplyOutcome> {
	const { ownerId, proposalId, baseVersionId, today, deps, proposal } = input;
	const programs = createProgramsRepository(deps.db);
	const done = await programs.completedLineages(ownerId, [s.sessionLineage]);
	if (done.has(s.sessionLineage)) return ENDED;
	const current = await programs.currentProgram(ownerId);
	if (!current || current.version.id !== baseVersionId) {
		return { status: 'superseded', reason: 'program_changed' };
	}
	const swap = {
		op: 'swap',
		sessionLineage: s.sessionLineage,
		plannedExerciseLineage: s.plannedExerciseLineage,
		toExerciseId: s.toExerciseId,
		scope: 'once',
		reason: SUBSTITUTION_REASON_LABEL[s.reason]
	} as const;
	try {
		const version = await applyProgramEdits(
			ownerId,
			{
				baseVersion: current.version.number,
				today,
				ops: [swap],
				title: proposal.title,
				rationale: proposal.rationale,
				evidence: { proposalId }
			},
			{ db: deps.db, now: deps.now, source: 'coach' }
		);
		return { status: 'applied', appliedVersionId: version.versionId };
	} catch (error) {
		if (error instanceof ProgramConflictError) {
			return { status: 'superseded', reason: 'program_changed' };
		}
		if (error instanceof TrainingInputError) {
			throw new ProposalRefusedError(atPayload(error.errors, /^ops\.0\./));
		}
		throw error;
	}
}

export const SESSION_APPLIERS: Pick<Appliers, 'session_substitution'> = {
	async session_substitution(input) {
		const s = input.proposal.payload;
		const workout = await workoutFor(input, s);
		if (workout === 'ended') return ENDED;
		return workout ? substituteInWorkout(input, s, workout) : swapOnce(input, s);
	}
};
