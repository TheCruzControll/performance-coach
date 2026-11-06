/**
 * Program read builders (ADR 0010). Each is one keyed query that a repository runs and that
 * `pnpm db:explain` (m3/33) explains as it is; later M3 slices add the week, session and history
 * builders here.
 */
import {
	and,
	asc,
	between,
	desc,
	eq,
	getTableColumns,
	gt,
	inArray,
	isNull,
	lt,
	sql,
	type SQL,
	type SQLWrapper
} from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { IsoDate } from '../../../domain/calendar';
import {
	exercises,
	plannedExercises,
	plannedRunSegments,
	plannedSessionDetails,
	plannedSessions,
	programBlocks,
	programmingDecisions,
	programs,
	programVersionBlocks,
	programVersions,
	programVersionWeeks,
	programWeeks,
	setPrescriptions,
	workouts
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
		weeks: versionWeeks(db, versionId),
		...sessionsWithChildren(
			db,
			db.select({ weekId: programVersionWeeks.weekId }).from(programVersionWeeks).where(inVersion)
		)
	};
}

/** A version's weeks by date, through its membership rows (program_version_weeks_pk). */
export function versionWeeks(db: Executor, versionId: string) {
	return db
		.select(getTableColumns(programWeeks))
		.from(programVersionWeeks)
		.innerJoin(programWeeks, eq(programWeeks.id, programVersionWeeks.weekId))
		.where(eq(programVersionWeeks.versionId, versionId))
		.orderBy(asc(programWeeks.startsOn));
}

/** What each versionTree builder returns. */
export type VersionTreeRows = {
	[K in keyof ReturnType<typeof versionTree>]: Awaited<ReturnType<typeof versionTree>[K]>;
};

// ---- program reads (Train, Today, the session screen, the coach) ----------------------------

/**
 * The owner's active program with its current version, or with version `number` of it: one row
 * or none, by the owner's one active program (programs_owner_active_uq), then the version's
 * primary key or (program, number).
 */
export function currentProgram(db: Executor, ownerId: string, number?: number) {
	return db
		.select({ program: programs, version: programVersions })
		.from(programs)
		.innerJoin(
			programVersions,
			number === undefined
				? eq(programVersions.id, programs.currentVersionId)
				: and(eq(programVersions.programId, programs.id), eq(programVersions.number, number))
		)
		.where(and(eq(programs.ownerId, ownerId), eq(programs.status, 'active')));
}

/**
 * A version's sessions that `where` picks, by day and order in the day: its membership rows,
 * then each week's sessions through planned_sessions_week_day_idx.
 */
function versionSessions(db: Executor, versionId: string, where: SQL) {
	return db
		.select(getTableColumns(plannedSessions))
		.from(programVersionWeeks)
		.innerJoin(plannedSessions, eq(plannedSessions.weekId, programVersionWeeks.weekId))
		.where(and(eq(programVersionWeeks.versionId, versionId), where))
		.orderBy(asc(plannedSessions.scheduledOn), asc(plannedSessions.orderInDay));
}

/**
 * The one planned-session range builder: a version's sessions dated `from` to `to`, both
 * included. history.ts's sessionsInRange composes it with the logged workouts (m3/26).
 */
export function plannedSessionsInRange(
	db: Executor,
	versionId: string,
	from: IsoDate,
	to: IsoDate
) {
	return versionSessions(db, versionId, between(plannedSessions.scheduledOn, from, to));
}

/** A version's next `limit` sessions dated after `after`, across week boundaries. */
export function upcomingSessions(db: Executor, versionId: string, after: IsoDate, limit: number) {
	return versionSessions(db, versionId, gt(plannedSessions.scheduledOn, after)).limit(limit);
}

/** The version's session with this lineage (planned_sessions_lineage_idx), its week and block. */
export function sessionByLineage(db: Executor, versionId: string, lineage: string) {
	return db
		.select({ session: plannedSessions, week: programWeeks, block: programBlocks })
		.from(plannedSessions)
		.innerJoin(
			programVersionWeeks,
			and(
				eq(programVersionWeeks.versionId, versionId),
				eq(programVersionWeeks.weekId, plannedSessions.weekId)
			)
		)
		.innerJoin(programWeeks, eq(programWeeks.id, plannedSessions.weekId))
		.innerJoin(programBlocks, eq(programBlocks.id, programWeeks.blockId))
		.where(eq(plannedSessions.lineageId, lineage));
}

/** `column` is one of the ids `parents` selects, gathered once: a probe of the column's index. */
const oneOf = (column: AnyPgColumn, parents: SQLWrapper) => sql`${column} = any(array(${parents}))`;

/**
 * The exercises (with their library names), set prescriptions, run segments and details of the
 * sessions `where` picks, by parent and then position. Each child table is probed through its
 * parent's index with its parents' ids (oneOf) rather than joined to them: a child's rows sit
 * together on disk, but their random uuids give the planner no sign of it, so a join would rather
 * scan a large child table than probe it for one week's sessions (db:explain, m3/33). Lazy: a
 * read awaits only the builders it needs.
 */
function childrenOf(db: Executor, where: SQL) {
	const sessionIds = db.select({ id: plannedSessions.id }).from(plannedSessions).where(where);
	const ofSessions = (sessionId: AnyPgColumn) => oneOf(sessionId, sessionIds);
	const exerciseIds = db
		.select({ id: plannedExercises.id })
		.from(plannedExercises)
		.where(ofSessions(plannedExercises.sessionId));
	return {
		exercises: db
			.select({
				...getTableColumns(plannedExercises),
				exerciseKey: exercises.key,
				exerciseName: exercises.name,
				substitutedFromKey: substitutedFrom.key
			})
			.from(plannedExercises)
			.innerJoin(exercises, eq(exercises.id, plannedExercises.exerciseId))
			.leftJoin(substitutedFrom, eq(substitutedFrom.id, plannedExercises.substitutedFromExerciseId))
			.where(ofSessions(plannedExercises.sessionId))
			.orderBy(asc(plannedExercises.sessionId), asc(plannedExercises.position)),
		sets: db
			.select(getTableColumns(setPrescriptions))
			.from(setPrescriptions)
			.where(oneOf(setPrescriptions.plannedExerciseId, exerciseIds))
			.orderBy(asc(setPrescriptions.plannedExerciseId), asc(setPrescriptions.position)),
		segments: db
			.select(getTableColumns(plannedRunSegments))
			.from(plannedRunSegments)
			.where(ofSessions(plannedRunSegments.sessionId))
			.orderBy(asc(plannedRunSegments.sessionId), asc(plannedRunSegments.position)),
		details: db
			.select(getTableColumns(plannedSessionDetails))
			.from(plannedSessionDetails)
			.where(ofSessions(plannedSessionDetails.sessionId))
	};
}

/**
 * The sessions of these weeks (planned_sessions_week_day_idx), by day and order in the day, and
 * their children. `weekIds` may be a subquery: versionTree passes its version's membership.
 */
export function sessionsWithChildren(db: Executor, weekIds: string[] | SQLWrapper) {
	const inWeeks = inArray(plannedSessions.weekId, weekIds);
	return {
		sessions: db
			.select(getTableColumns(plannedSessions))
			.from(plannedSessions)
			.where(inWeeks)
			.orderBy(asc(plannedSessions.scheduledOn), asc(plannedSessions.orderInDay)),
		...childrenOf(db, inWeeks)
	};
}

/** The children of these sessions, by their ids. */
export function sessionChildren(db: Executor, sessionIds: string[]) {
	return childrenOf(db, inArray(plannedSessions.id, sessionIds));
}

/**
 * Which of `lineages` has a completed, undeleted workout of the owner's logged against it
 * (workouts_planned_lineage_idx). 'Completed' goes by lineage, so it holds in every version.
 */
export function completedLineages(db: Executor, ownerId: string, lineages: string[]) {
	return db
		.selectDistinct({ lineage: workouts.plannedLineageId })
		.from(workouts)
		.where(
			and(
				inArray(workouts.plannedLineageId, lineages),
				eq(workouts.ownerId, ownerId),
				eq(workouts.status, 'completed'),
				isNull(workouts.deletedAt)
			)
		);
}

// ---- version history (History, the coach) ---------------------------------------------------

/**
 * One page of a program's versions, newest first, with each one's decisions in the order they
 * were written, in one query: a keyset on (program, number) (program_versions_program_number_uq)
 * below `beforeNumber` when given, then programming_decisions_version_idx. A version with no
 * decisions comes once, with decision: null.
 */
export function versionHistory(
	db: Executor,
	programId: string,
	{ beforeNumber, limit }: { beforeNumber?: number; limit: number }
) {
	const page = db
		.select({ id: programVersions.id })
		.from(programVersions)
		.where(
			and(
				eq(programVersions.programId, programId),
				beforeNumber === undefined ? undefined : lt(programVersions.number, beforeNumber)
			)
		)
		.orderBy(desc(programVersions.number))
		.limit(limit);
	return db
		.select({ version: programVersions, decision: programmingDecisions })
		.from(programVersions)
		.leftJoin(programmingDecisions, eq(programmingDecisions.versionId, programVersions.id))
		.where(inArray(programVersions.id, page))
		.orderBy(desc(programVersions.number), asc(programmingDecisions.id));
}

/**
 * The sessions and planned exercises named in `lineages`, in each of these versions, with the
 * title and date History shows for them: every copy of each lineage through its lineage index
 * (planned_sessions_lineage_idx, planned_exercises_lineage_idx; oneOf), kept where a version's
 * membership lists its week. `lineages` travels as one jsonb parameter, so the statement never
 * grows with the decisions it resolves.
 */
export function affectedNodes(db: Executor, versionIds: string[], lineages: string[]) {
	const named = sql`(select value::uuid from jsonb_array_elements_text(${JSON.stringify(lineages)}::jsonb))`;
	const member = and(
		inArray(programVersionWeeks.versionId, versionIds),
		eq(programVersionWeeks.weekId, plannedSessions.weekId)
	);
	const place = { versionId: programVersionWeeks.versionId, date: plannedSessions.scheduledOn };
	return {
		sessions: db
			.select({ ...place, lineage: plannedSessions.lineageId, title: plannedSessions.title })
			.from(plannedSessions)
			.innerJoin(programVersionWeeks, member)
			.where(oneOf(plannedSessions.lineageId, named)),
		exercises: db
			.select({ ...place, lineage: plannedExercises.lineageId, title: exercises.name })
			.from(plannedSessions)
			.innerJoin(programVersionWeeks, member)
			.innerJoin(plannedExercises, eq(plannedExercises.sessionId, plannedSessions.id))
			.innerJoin(exercises, eq(exercises.id, plannedExercises.exerciseId))
			.where(oneOf(plannedExercises.lineageId, named))
	};
}

/** What the read builders return. */
export type SessionRow = Awaited<ReturnType<typeof plannedSessionsInRange>>[number];
export type SessionLineageRow = Awaited<ReturnType<typeof sessionByLineage>>[number];
export type SessionChildRows = {
	[K in keyof ReturnType<typeof sessionChildren>]: Awaited<ReturnType<typeof sessionChildren>[K]>;
};
