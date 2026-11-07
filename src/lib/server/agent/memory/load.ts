/**
 * The coaching memory that opens a segment (the turn's hook). A stub: every section is empty
 * until coach-memory-profile replaces this file with getCoachingMemory (services/coach/memory.ts).
 */
import type { MemorySnapshot } from '../../../domain/coach/memory.ts';

export interface MemoryInput<Deps> {
	ownerId: string;
	/** The owner's local day the snapshot is built on. */
	today: string;
	deps: Deps;
}

export async function loadMemory<Deps>({ today }: MemoryInput<Deps>): Promise<MemorySnapshot> {
	return {
		asOf: today,
		profile: {
			goals: [],
			program: null,
			recentDays: [],
			baselines: [],
			trends: [],
			preferences: [],
			equipment: [],
			injuries: [],
			avoid: []
		},
		records: {
			painReports: [],
			recoveryNotes: [],
			decisions: [],
			proposals: [],
			reviews: [],
			threadSummaries: [],
			analyses: []
		}
	};
}
