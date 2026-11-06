/**
 * Program persistence (schema/programs.ts, schema/prescriptions.ts; ADR 0010): a new program's
 * whole tree in bulk, its decisions, and any version, week or session read back through
 * queries/programs.ts.
 * Plain data access: validation and the store's rules belong to src/lib/server/services/programs.
 *
 * Rows arrive with their ids and lineages already assigned, so each table takes one multi-row
 * INSERT (chunked only past ROWS_PER_INSERT) and nothing needs RETURNING.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { alias, type PgTable } from 'drizzle-orm/pg-core';
import type { IsoDate } from '../../../domain/calendar';
import {
	completedLineages,
	currentProgram,
	plannedSessionsInRange,
	sessionByLineage,
	sessionChildren,
	sessionsWithChildren,
	upcomingSessions,
	versionTree,
	type SessionChildRows,
	type SessionLineageRow,
	type SessionRow,
	type VersionTreeRows
} from '../queries/programs';
import {
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
	setPrescriptions
} from '../schema';
import type { Executor } from '../types';

export type {
	SessionChildRows,
	SessionLineageRow,
	SessionRow,
	VersionTreeRows
} from '../queries/programs';

/** A version's blocks and weeks, without their sessions. */
export type VersionOutlineRows = Pick<VersionTreeRows, 'blocks' | 'weeks'>;

/** The children a session's one-line description reads: no set prescriptions. */
export type LineChildRows = Omit<SessionChildRows, 'sets'>;
export type SessionLineRows = LineChildRows & { sessions: SessionRow[] };

type Insert<T extends PgTable> = T['$inferInsert'];

/** A new program and its version 1, every row with its id (and lineage) set. */
export interface ProgramTreeRows {
	program: Insert<typeof programs> & { id: string };
	version: Insert<typeof programVersions> & { id: string };
	blocks: Insert<typeof programBlocks>[];
	versionBlocks: Insert<typeof programVersionBlocks>[];
	weeks: Insert<typeof programWeeks>[];
	versionWeeks: Insert<typeof programVersionWeeks>[];
	sessions: Insert<typeof plannedSessions>[];
	exercises: Insert<typeof plannedExercises>[];
	sets: Insert<typeof setPrescriptions>[];
	segments: Insert<typeof plannedRunSegments>[];
	details: Insert<typeof plannedSessionDetails>[];
}

export type DecisionValues = Insert<typeof programmingDecisions>;
export type DecisionRow = typeof programmingDecisions.$inferSelect;

/** The owner's active program, its current version and what version 1 was built from. */
export interface ActiveProgramRow {
	id: string;
	currentVersionId: string | null;
	currentNumber: number | null;
	firstFingerprint: string | null;
}

/** One version of one of the owner's programs, with the program it belongs to. */
export interface VersionRow {
	program: typeof programs.$inferSelect;
	version: typeof programVersions.$inferSelect;
}

/** Advisory-lock key for creating one owner's programs (727201 is their custom exercises'). */
const PROGRAMS_LOCK = 727202;

/** Well under Postgres's 65,535 bind parameters for the widest table (about 20 columns). */
const ROWS_PER_INSERT = 1000;

const firstVersion = alias(programVersions, 'first_version');

export function createProgramsRepository(db: Executor) {
	async function insertAll<T extends PgTable>(table: T, rows: Insert<T>[]) {
		for (let at = 0; at < rows.length; at += ROWS_PER_INSERT) {
			await db.insert(table).values(rows.slice(at, at + ROWS_PER_INSERT));
		}
	}

	return {
		/** Serialise program creation for this owner within the current transaction. */
		async lockPrograms(ownerId: string): Promise<void> {
			await db.execute(sql`select pg_advisory_xact_lock(${PROGRAMS_LOCK}, hashtext(${ownerId}))`);
		},

		async activeProgram(ownerId: string): Promise<ActiveProgramRow | null> {
			const [row] = await db
				.select({
					id: programs.id,
					currentVersionId: programs.currentVersionId,
					currentNumber: programVersions.number,
					firstFingerprint: firstVersion.inputFingerprint
				})
				.from(programs)
				.leftJoin(programVersions, eq(programVersions.id, programs.currentVersionId))
				.leftJoin(
					firstVersion,
					and(eq(firstVersion.programId, programs.id), eq(firstVersion.number, 1))
				)
				.where(and(eq(programs.ownerId, ownerId), eq(programs.status, 'active')));
			return row ?? null;
		},

		/**
		 * The head (with no version yet, as its guard requires), version 1, then the tree from the
		 * top down, and last the head's pointer to version 1.
		 */
		async insertProgramTree(tree: ProgramTreeRows): Promise<void> {
			await db.insert(programs).values(tree.program);
			await db.insert(programVersions).values(tree.version);
			await insertAll(programBlocks, tree.blocks);
			await insertAll(programVersionBlocks, tree.versionBlocks);
			await insertAll(programWeeks, tree.weeks);
			await insertAll(programVersionWeeks, tree.versionWeeks);
			await insertAll(plannedSessions, tree.sessions);
			await insertAll(plannedExercises, tree.exercises);
			await insertAll(setPrescriptions, tree.sets);
			await insertAll(plannedRunSegments, tree.segments);
			await insertAll(plannedSessionDetails, tree.details);
			await db
				.update(programs)
				.set({ currentVersionId: tree.version.id })
				.where(eq(programs.id, tree.program.id));
		},

		/** In order: their identity ids keep it. */
		async insertDecisions(rows: DecisionValues[]): Promise<void> {
			await insertAll(programmingDecisions, rows);
		},

		async findVersion(ownerId: string, programId: string, number: number) {
			const [row] = await db
				.select({ program: programs, version: programVersions })
				.from(programVersions)
				.innerJoin(programs, eq(programs.id, programVersions.programId))
				.where(
					and(
						eq(programs.ownerId, ownerId),
						eq(programVersions.programId, programId),
						eq(programVersions.number, number)
					)
				);
			return (row ?? null) satisfies VersionRow | null;
		},

		async versionTree(versionId: string): Promise<VersionTreeRows> {
			const q = versionTree(db, versionId);
			return {
				blocks: await q.blocks,
				weeks: await q.weeks,
				sessions: await q.sessions,
				exercises: await q.exercises,
				sets: await q.sets,
				segments: await q.segments,
				details: await q.details
			};
		},

		/** The owner's active program with its current version, or with version `number`. */
		async currentProgram(ownerId: string, number?: number): Promise<VersionRow | null> {
			const [row] = await currentProgram(db, ownerId, number);
			return row ?? null;
		},

		async versionOutline(versionId: string): Promise<VersionOutlineRows> {
			const q = versionTree(db, versionId);
			return { blocks: await q.blocks, weeks: await q.weeks };
		},

		async sessionsWithChildren(weekIds: string[]): Promise<SessionLineRows> {
			const q = sessionsWithChildren(db, weekIds);
			return {
				sessions: await q.sessions,
				exercises: await q.exercises,
				segments: await q.segments,
				details: await q.details
			};
		},

		async plannedSessionsInRange(
			versionId: string,
			from: IsoDate,
			to: IsoDate
		): Promise<SessionRow[]> {
			return plannedSessionsInRange(db, versionId, from, to);
		},

		async upcomingSessions(
			versionId: string,
			after: IsoDate,
			limit: number
		): Promise<SessionRow[]> {
			return upcomingSessions(db, versionId, after, limit);
		},

		/** What these sessions' lines read: their exercises, segments and details, not their sets. */
		async lineChildren(sessionIds: string[]): Promise<LineChildRows> {
			if (!sessionIds.length) return { exercises: [], segments: [], details: [] };
			const q = sessionChildren(db, sessionIds);
			return { exercises: await q.exercises, segments: await q.segments, details: await q.details };
		},

		/** Every child of these sessions, their set prescriptions included. */
		async sessionChildren(sessionIds: string[]): Promise<SessionChildRows> {
			const lines = await this.lineChildren(sessionIds);
			return {
				...lines,
				sets: sessionIds.length ? await sessionChildren(db, sessionIds).sets : []
			};
		},

		async sessionByLineage(versionId: string, lineage: string): Promise<SessionLineageRow | null> {
			const [row] = await sessionByLineage(db, versionId, lineage);
			return row ?? null;
		},

		/** The lineages among `lineages` that a completed workout of the owner's was logged against. */
		async completedLineages(ownerId: string, lineages: string[]): Promise<Set<string>> {
			if (!lineages.length) return new Set();
			const rows = await completedLineages(db, ownerId, lineages);
			return new Set(rows.flatMap((row) => (row.lineage ? [row.lineage] : [])));
		},

		/** The decisions that produced a version, in the order they were written. */
		async decisionsOf(versionId: string): Promise<DecisionRow[]> {
			return db
				.select()
				.from(programmingDecisions)
				.where(eq(programmingDecisions.versionId, versionId))
				.orderBy(asc(programmingDecisions.id));
		}
	};
}
