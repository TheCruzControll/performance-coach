/**
 * Coach note read builders (M5): each one keyed query that repositories/coach-notes.ts runs,
 * shaped for the indexes in schema/coach.ts.
 * - Every predicate repeats the owner, so a note, a run or a workout is found only through its
 *   owner: someone else's id reads as no row at all.
 * - COACH_NOTE_INDEXES names the index each builder is shaped for; coach-explain (m5/54) adds
 *   them to `pnpm db:explain`.
 * Nothing runs until a builder is awaited; await them in turn on one connection.
 */
import { and, desc, eq, exists, isNull, sql, type SQLWrapper } from 'drizzle-orm';
import { agentRuns, coachNotes, owners, workouts } from '../schema';
import type { Executor } from '../types';

/** The index each builder is shaped for. */
export const COACH_NOTE_INDEXES = {
	latestNotes: 'coach_notes_owner_kind_idx',
	ownership: 'owners_pkey'
} as const;

/** A note as memory and the tools read it. */
export const noteColumns = {
	id: coachNotes.id,
	kind: coachNotes.kind,
	subjects: coachNotes.subjects,
	body: coachNotes.body,
	summary: coachNotes.summary,
	runId: coachNotes.runId,
	createdAt: coachNotes.createdAt
};

/** The owner's newest notes of one kind. */
export function latestNotes(db: Executor, ownerId: string, kind: string, limit: number) {
	return db
		.select(noteColumns)
		.from(coachNotes)
		.where(and(eq(coachNotes.ownerId, ownerId), eq(coachNotes.kind, kind)))
		.orderBy(desc(coachNotes.createdAt), desc(coachNotes.id))
		.limit(limit);
}

/**
 * In one query: the owner's row (none when there is no such owner), with whether the run and the
 * workout a note names (when it names them) are the owner's; a deleted workout is not.
 */
export function ownership(
	db: Executor,
	ownerId: string,
	{ runId, workoutId }: { runId: string | null; workoutId: string | null }
) {
	const owned = (query: SQLWrapper) => sql<boolean>`${exists(query)}`;
	const one = { one: sql`1` };
	return db
		.select({
			run:
				runId === null
					? sql<boolean>`true`
					: owned(
							db
								.select(one)
								.from(agentRuns)
								.where(and(eq(agentRuns.id, runId), eq(agentRuns.ownerId, ownerId)))
						),
			workout:
				workoutId === null
					? sql<boolean>`true`
					: owned(
							db
								.select(one)
								.from(workouts)
								.where(
									and(
										eq(workouts.id, workoutId),
										eq(workouts.ownerId, ownerId),
										isNull(workouts.deletedAt)
									)
								)
						)
		})
		.from(owners)
		.where(eq(owners.id, ownerId));
}
