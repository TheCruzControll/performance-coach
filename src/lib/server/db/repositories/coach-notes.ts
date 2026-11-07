/**
 * Coach note persistence: runs queries/coach-notes.ts's builders one query at a time, and the
 * insert the note guards allow (notes are insert-only). Plain data access: validation and owner
 * scoping belong to src/lib/server/services/coach/notes.ts.
 */
import * as q from '../queries/coach-notes';
import { coachNotes } from '../schema';
import type { Executor } from '../types';

export type NoteRow = Awaited<ReturnType<typeof q.latestNotes>>[number];
export type NewNoteRow = typeof coachNotes.$inferInsert;
export interface NoteOwnership {
	run: boolean;
	workout: boolean;
}

export function createCoachNotesRepository(db: Executor) {
	return {
		latestNotes: (ownerId: string, kind: string, limit: number) =>
			q.latestNotes(db, ownerId, kind, limit),

		/** Null when there is no such owner; else whether the named run and workout are theirs. */
		ownership: async (
			ownerId: string,
			named: { runId: string | null; workoutId: string | null }
		): Promise<NoteOwnership | null> => (await q.ownership(db, ownerId, named))[0] ?? null,

		insertNote: async (values: NewNoteRow): Promise<NoteRow> =>
			(await db.insert(coachNotes).values(values).returning(q.noteColumns))[0]!
	};
}
