/**
 * Periodisation persistence: runs queries/periodisation.ts's builders one query at a time, so
 * the plan db:explain measures is the plan the app runs. Plain data access: what a decision means
 * to a screen belongs to services/periodisation.
 */
import type { DecisionKind } from '../../../domain/training/vocabulary';
import { decisionsForLineages } from '../queries/periodisation';
import type { Executor } from '../types';

export type * from '../queries/periodisation';

export function createPeriodisationRepository(db: Executor) {
	return {
		/** The program's decisions naming any of `lineages`, newest first; none for no lineage. */
		async decisionsForLineages(
			ownerId: string,
			programId: string,
			lineages: readonly string[],
			options: { kinds?: readonly DecisionKind[]; limit: number }
		) {
			if (!lineages.length) return [];
			return decisionsForLineages(db, ownerId, programId, lineages, options);
		}
	};
}
