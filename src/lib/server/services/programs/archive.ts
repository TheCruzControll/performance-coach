/**
 * End the owner's plan (the PROGRAM lifecycle's `end`): the active program is archived, so Today
 * offers Build my program again. Nothing is deleted. Its versions, its decisions and every
 * workout logged against it stay, in History and in analytics.
 *
 * In one transaction, under the owner's program lock (creation) and the head's row lock (edits):
 * - refused (ProgramArchiveConflictError, 'workout_in_progress') while one of the program's
 *   workouts is in progress on the server, so a session being logged never loses its plan under
 *   it. A workout still only on a device syncs later as before: its program row is kept.
 * - its open coach proposals (proposed or accepted) are superseded as 'program_changed', the
 *   reason an accept would find anyway, so the inbox shows nothing that can no longer apply.
 * - with no active program (a second tap, another tab) nothing changes and `archived` is false.
 */
import { PROGRAM } from '../../../domain/training/program-lifecycle';
import { PROPOSAL } from '../../../domain/training/lifecycles';
import type { ProposalStatus } from '../../../domain/training/vocabulary';
import { createCoachProposalsRepository } from '../../db/repositories/coach-proposals';
import { createProgramsRepository } from '../../db/repositories/programs';
import { measure } from '../../observability/timing';
import { transition } from '../lifecycle-guard';
import { ConflictError, resolveDeps, type TrainingDeps } from '../training/shared';

export type ProgramArchiveConflictReason = 'workout_in_progress';

/** The program cannot end now: a workout of it is being logged. Nothing was written. */
export class ProgramArchiveConflictError extends ConflictError<ProgramArchiveConflictReason> {
	constructor() {
		super('workout_in_progress', 'a workout of this program is in progress');
		this.name = 'ProgramArchiveConflictError';
	}
}

export interface ArchivedProgram {
	/** The program archived, or null when the owner had no active program. */
	programId: string | null;
	archived: boolean;
	/** How many of its open coach proposals were superseded. */
	supersededProposals: number;
}

/** Archive the owner's active program; see the module doc for what it refuses and closes. */
export async function archiveProgram(
	ownerId: string,
	deps: Omit<TrainingDeps, 'source'> = {}
): Promise<ArchivedProgram> {
	const { db, now } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const programs = createProgramsRepository(tx);
			await programs.lockPrograms(ownerId);
			const head = await programs.lockProgram(ownerId);
			if (!head) return { programId: null, archived: false, supersededProposals: 0 };
			if ((await programs.workoutsInProgress(ownerId, head.id)) > 0) {
				throw new ProgramArchiveConflictError();
			}
			const at = now();
			transition(PROGRAM, 'active', 'end');
			if (!(await programs.archiveProgram(head.id, at))) {
				throw new Error('the active program moved under its lock');
			}
			const proposals = createCoachProposalsRepository(tx);
			const open = await proposals.lockOpenForProgram(ownerId, head.id);
			for (const row of open) {
				const t = transition(PROPOSAL, row.status as ProposalStatus, 'supersede');
				await proposals.decide(ownerId, row.id, t, {
					supersededReason: 'program_changed',
					closedAt: at,
					updatedAt: at
				});
			}
			return { programId: head.id, archived: true, supersededProposals: open.length };
		})
	);
}
