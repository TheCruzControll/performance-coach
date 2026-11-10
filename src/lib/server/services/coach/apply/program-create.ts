/**
 * Applying a first program or a next cycle (the M5 plan's apply-session-program-cycle).
 *
 * - new_program is M3's generator, never the coach's own plan: buildProgram regenerates from the
 *   owner's profile with the dates and fingerprints the preview showed, confirmed with source
 *   'coach', and stores version 1. The proposal is applied with program_id and
 *   applied_version_id set together. It is refused while a program is active (acceptProposal's
 *   check, NEW_PROGRAM_NEEDS_NO_PROGRAM, and the store's own refusal). A profile or library
 *   changed since the preview supersedes it ('program_changed': the program a build would make is
 *   not the one shown), and nothing is written.
 * - next_cycle is ./next-cycle.ts's (M6's cycle review plans it).
 */
import { buildProgram, ProgrammingConflictError } from '../../programming/index';
import { ProgramExistsError } from '../../programs/store';
import { TrainingInputError } from '../../training/shared';
import { PROGRAM_ACTIVE, ProposalRefusedError } from '../proposals';
import type { Appliers, ApplyOutcome } from './types';

export const PROGRAM_CREATE_APPLIERS: Pick<Appliers, 'new_program'> = {
	async new_program({ ownerId, proposal, today, deps }): Promise<ApplyOutcome> {
		const { start, startsOn, firstPlannedDay, fingerprint, digest } = proposal.payload;
		const request = { today, start, startsOn, firstPlannedDay, fingerprint, digest };
		try {
			const built = await buildProgram(ownerId, request, {
				db: deps.db,
				now: deps.now,
				source: 'coach'
			});
			return { status: 'applied', programId: built.programId, appliedVersionId: built.versionId };
		} catch (error) {
			if (error instanceof ProgrammingConflictError) {
				return { status: 'superseded', reason: 'program_changed' };
			}
			if (error instanceof ProgramExistsError) {
				throw new ProposalRefusedError({ kind: PROGRAM_ACTIVE });
			}
			if (error instanceof TrainingInputError) {
				throw new ProposalRefusedError(
					Object.fromEntries(Object.entries(error.errors).map(([k, m]) => [`payload.${k}`, m]))
				);
			}
			throw error;
		}
	}
};
