/**
 * The coaching memory that opens a segment (the turn's hook): getCoachingMemory's snapshot of
 * the owner's records as of their local day (services/coach/memory.ts). The turn stores it as
 * the segment's preamble, frozen for the segment, and records the program version the segment
 * starts on beside it (coach_threads.segment_program_version_id), so each turn's context says
 * when the program has changed since the snapshot was taken.
 */
import type { MemorySnapshot } from '../../../domain/coach/memory.ts';
import { getCoachingMemory } from '../../services/coach/memory.ts';
import type { CoachDeps } from '../../services/coach/shared.ts';
import type { RoadView } from '../../services/periodisation/road-view.ts';

export interface MemoryInput {
	ownerId: string;
	/** The owner's local day the snapshot is built on. */
	today: string;
	deps: CoachDeps;
	/** The periodisation road the turn read (turn-facts.ts): the goals' modes; null when unread. */
	road?: RoadView | null;
}

export function loadMemory({ ownerId, today, deps, road }: MemoryInput): Promise<MemorySnapshot> {
	return getCoachingMemory(ownerId, { today, road }, deps);
}
