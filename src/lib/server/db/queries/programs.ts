/**
 * Program read builders (ADR 0010). Each is one keyed query that a repository runs and that
 * `pnpm db:explain` (m3/33) explains as it is; later M3 slices add the week, session and history
 * builders here.
 */
import { asc, eq, getTableColumns } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
	exercises,
	plannedExercises,
	plannedRunSegments,
	plannedSessionDetails,
	plannedSessions,
	programBlocks,
	programVersionBlocks,
	programVersionWeeks,
	programWeeks,
	setPrescriptions
} from '../schema';
import type { Executor } from '../types';

const substitutedFrom = alias(exercises, 'substituted_from');

/**
 * One version's whole tree through its membership rows: its blocks, weeks, sessions, and their
 * exercises, set prescriptions, run segments and details, one query each. Every query is keyed by
 * the version alone (the membership primary keys, then each child's parent index), so the count
 * never grows with the program. Rows come in stored order and name their parent:
 * - blocks by position, weeks by date, sessions by day and order in the day
 * - exercises, sets and segments by their parent, then position
 * Nothing runs until a builder is awaited; await them in turn on one connection.
 */
export function versionTree(db: Executor, versionId: string) {
	const inVersion = eq(programVersionWeeks.versionId, versionId);
	return {
		blocks: db
			.select(getTableColumns(programBlocks))
			.from(programVersionBlocks)
			.innerJoin(programBlocks, eq(programBlocks.id, programVersionBlocks.blockId))
			.where(eq(programVersionBlocks.versionId, versionId))
			.orderBy(asc(programBlocks.position)),
		weeks: db
			.select(getTableColumns(programWeeks))
			.from(programVersionWeeks)
			.innerJoin(programWeeks, eq(programWeeks.id, programVersionWeeks.weekId))
			.where(inVersion)
			.orderBy(asc(programWeeks.startsOn)),
		sessions: db
			.select(getTableColumns(plannedSessions))
			.from(programVersionWeeks)
			.innerJoin(plannedSessions, eq(plannedSessions.weekId, programVersionWeeks.weekId))
			.where(inVersion)
			.orderBy(asc(plannedSessions.scheduledOn), asc(plannedSessions.orderInDay)),
		exercises: db
			.select({
				...getTableColumns(plannedExercises),
				exerciseKey: exercises.key,
				substitutedFromKey: substitutedFrom.key
			})
			.from(programVersionWeeks)
			.innerJoin(plannedSessions, eq(plannedSessions.weekId, programVersionWeeks.weekId))
			.innerJoin(plannedExercises, eq(plannedExercises.sessionId, plannedSessions.id))
			.innerJoin(exercises, eq(exercises.id, plannedExercises.exerciseId))
			.leftJoin(substitutedFrom, eq(substitutedFrom.id, plannedExercises.substitutedFromExerciseId))
			.where(inVersion)
			.orderBy(asc(plannedExercises.sessionId), asc(plannedExercises.position)),
		sets: db
			.select(getTableColumns(setPrescriptions))
			.from(programVersionWeeks)
			.innerJoin(plannedSessions, eq(plannedSessions.weekId, programVersionWeeks.weekId))
			.innerJoin(plannedExercises, eq(plannedExercises.sessionId, plannedSessions.id))
			.innerJoin(setPrescriptions, eq(setPrescriptions.plannedExerciseId, plannedExercises.id))
			.where(inVersion)
			.orderBy(asc(setPrescriptions.plannedExerciseId), asc(setPrescriptions.position)),
		segments: db
			.select(getTableColumns(plannedRunSegments))
			.from(programVersionWeeks)
			.innerJoin(plannedSessions, eq(plannedSessions.weekId, programVersionWeeks.weekId))
			.innerJoin(plannedRunSegments, eq(plannedRunSegments.sessionId, plannedSessions.id))
			.where(inVersion)
			.orderBy(asc(plannedRunSegments.sessionId), asc(plannedRunSegments.position)),
		details: db
			.select(getTableColumns(plannedSessionDetails))
			.from(programVersionWeeks)
			.innerJoin(plannedSessions, eq(plannedSessions.weekId, programVersionWeeks.weekId))
			.innerJoin(plannedSessionDetails, eq(plannedSessionDetails.sessionId, plannedSessions.id))
			.where(inVersion)
	};
}

/** What each versionTree builder returns. */
export type VersionTreeRows = {
	[K in keyof ReturnType<typeof versionTree>]: Awaited<ReturnType<typeof versionTree>[K]>;
};
