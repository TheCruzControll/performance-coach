/**
 * Program persistence (schema/programs.ts, schema/prescriptions.ts; ADR 0010): a new program's
 * whole tree in bulk, its decisions, a revision's copy-on-write version, and any version, week,
 * session or page of history read back through queries/programs.ts.
 * Plain data access: validation and the store's rules belong to src/lib/server/services/programs.
 *
 * Rows arrive with their ids and lineages already assigned, so each table takes one multi-row
 * INSERT (chunked only past ROWS_PER_INSERT) and nothing needs RETURNING. A revision copies a
 * week's subtree with one INSERT … SELECT per table instead, its changes written in as it goes.
 */
import { and, asc, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import { alias, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';
import type { IsoDate } from '../../../domain/calendar';
import {
	affectedNodes,
	completedLineages,
	currentProgram,
	plannedSessionsInRange,
	sessionById,
	sessionByLineage,
	sessionChildren,
	sessionsWithChildren,
	upcomingSessions,
	versionHistory,
	versionTree,
	versionWeeks,
	type SessionByIdRow,
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
	SessionByIdRow,
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

/** The owner's active program head, as a revision locks it. */
export interface ProgramHead {
	id: string;
	currentVersionId: string | null;
}

/** What a revision may change on a copied row: its values, never its keys, parent or lineage. */
type Change<T extends PgTable, Keys extends keyof Insert<T>> = Partial<Omit<Insert<T>, Keys>>;
export type SessionChange = Change<typeof plannedSessions, 'id' | 'weekId' | 'lineageId'>;
export type ExerciseChange = Change<typeof plannedExercises, 'id' | 'sessionId' | 'lineageId'>;
export type SetChange = Change<typeof setPrescriptions, 'id' | 'plannedExerciseId'>;
export type SegmentChange = Change<typeof plannedRunSegments, 'id' | 'sessionId'>;
export type DetailChange = Change<typeof plannedSessionDetails, 'sessionId'>;

/** The rows a revision copies: each base row's id → its copy's, and the version they join. */
export interface SubtreeCopy {
	versionId: string;
	weeks: Map<string, string>;
	sessions: Map<string, string>;
	exercises: Map<string, string>;
}

/** How copies differ from their base rows, by the base row's id (or its parent's, then position). */
export interface SubtreeChanges {
	sessions: Map<string, SessionChange>;
	exercises: Map<string, ExerciseChange>;
	/** By the session's id. */
	details: Map<string, DetailChange>;
	segments: Map<string, Map<number, SegmentChange>>;
	sets: Map<string, Map<number, SetChange>>;
}

/** A jsonb parameter: one bind value however many ids or changes it carries. */
const jsonb = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

/** Base ids and their copies' as the relation `name`(old_id, new_id). */
const idPairs = (ids: Map<string, string>, name: string) =>
	sql`(select key::uuid as old_id, value::uuid as new_id from jsonb_each_text(${jsonb(Object.fromEntries(ids))})) ${sql.raw(name)}`;

/** Per-position changes under their parent's id, filed as `<parent id>:<position>`. */
const byPosition = <T>(changes: Map<string, Map<number, T>>) =>
	new Map(
		[...changes].flatMap(([parent, at]) =>
			[...at].map(([position, change]) => [`${parent}:${position}`, change] as const)
		)
	);

/** One table's part of a subtree copy. */
interface CopyOf {
	table: PgTable;
	/** The copies' ids by their base rows'; without it, each copy gets a new random id. */
	ids?: Map<string, string>;
	/** The parent column, and the copied parents' ids: every row under one is copied. */
	parent?: { column: PgColumn; ids: Map<string, string> };
	/** The changes, by the key that `key` (an expression on base row `s`) gives each row. */
	changes?: Map<string, object>;
	key?: string;
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

	/**
	 * INSERT … SELECT the base rows `ids` or `parent` picks into copies: every column as stored
	 * (a column added later included), but a new id, the copied parent's id, and the row's change
	 * written over it by jsonb_populate_record (a null in a change sets null).
	 */
	async function copyRows({ table, ids, parent, changes = new Map(), key = 's.id::text' }: CopyOf) {
		const columns = Object.entries(getTableColumns(table));
		const nameOf = new Map(columns.map(([field, column]) => [field, column.name]));
		const column = (field: string) => {
			const name = nameOf.get(field);
			if (!name) throw new Error(`${field} is not a column of the copied rows`);
			return name;
		};
		const patches = Object.fromEntries(
			[...changes].map(([at, change]) => [
				at,
				Object.fromEntries(Object.entries(change).map(([field, value]) => [column(field), value]))
			])
		);
		const names = columns.map(([, c]) => sql.identifier(c.name));
		const values = columns.map(([, c]): SQL => {
			if (c === parent?.column) return sql`p.new_id`;
			if (c.primary) return ids ? sql`m.new_id` : sql`gen_random_uuid()`;
			return sql`r.${sql.identifier(c.name)}`;
		});
		const byId = ids ? sql`join ${idPairs(ids, 'm')} on m.old_id = s.id` : sql``;
		const byParent = parent
			? sql`join ${idPairs(parent.ids, 'p')} on p.old_id = s.${sql.identifier(parent.column.name)}`
			: sql``;
		const patch = sql`coalesce(${jsonb(patches)} -> (${sql.raw(key)}), '{}'::jsonb)`;
		await db.execute(
			sql`insert into ${table} (${sql.join(names, sql`, `)})
				select ${sql.join(values, sql`, `)} from ${table} s ${byId} ${byParent}
				cross join lateral jsonb_populate_record(s, ${patch}) r`
		);
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

		/**
		 * The owner's active program head, locked FOR UPDATE until the transaction ends: a revision's
		 * compare-and-set. Only the head row is read, so a waiter that gets the lock re-reads it.
		 */
		async lockProgram(ownerId: string): Promise<ProgramHead | null> {
			const [row] = await db
				.select({ id: programs.id, currentVersionId: programs.currentVersionId })
				.from(programs)
				.where(and(eq(programs.ownerId, ownerId), eq(programs.status, 'active')))
				.for('update');
			return row ?? null;
		},

		/** Move the head from `from` to `to`, only while it still points at `from`. */
		async setCurrentVersion(programId: string, from: string, to: string): Promise<boolean> {
			const moved = await db
				.update(programs)
				.set({ currentVersionId: to })
				.where(and(eq(programs.id, programId), eq(programs.currentVersionId, from)))
				.returning({ id: programs.id });
			return moved.length === 1;
		},

		async versionWeeks(versionId: string): Promise<VersionTreeRows['weeks']> {
			return versionWeeks(db, versionId);
		},

		/** The ids and lineages of every session and planned exercise in these weeks. */
		async weekSubtree(weekIds: string[]) {
			const q = sessionsWithChildren(db, weekIds);
			const node = ({ id, lineageId }: { id: string; lineageId: string }) => ({ id, lineageId });
			return { sessions: (await q.sessions).map(node), exercises: (await q.exercises).map(node) };
		},

		/** A version sharing its parent's blocks and weeks, except the weeks it will copy. */
		async insertVersion(
			version: Insert<typeof programVersions> & { id: string; parentVersionId: string },
			copiedWeekIds: string[]
		): Promise<void> {
			await db.insert(programVersions).values(version);
			const { id, parentVersionId: parent } = version;
			await db.execute(sql`insert into ${programVersionBlocks} (version_id, block_id)
				select ${id}::uuid, block_id from ${programVersionBlocks} where version_id = ${parent}`);
			await db.execute(sql`insert into ${programVersionWeeks} (version_id, week_id)
				select ${id}::uuid, week_id from ${programVersionWeeks} where version_id = ${parent}
				and week_id not in (select value::uuid from jsonb_array_elements_text(${jsonb(copiedWeekIds)}))`);
		},

		/**
		 * Copy these weeks into the version, top down: the weeks and their membership, then their
		 * sessions, the sessions' exercises, segments and details, and the exercises' sets.
		 */
		async copyWeekSubtree(copy: SubtreeCopy, changes: SubtreeChanges): Promise<void> {
			const { versionId, weeks, sessions, exercises } = copy;
			await copyRows({ table: programWeeks, ids: weeks });
			await db
				.insert(programVersionWeeks)
				.values([...weeks.values()].map((weekId) => ({ versionId, weekId })));
			await copyRows({
				table: plannedSessions,
				ids: sessions,
				parent: { column: plannedSessions.weekId, ids: weeks },
				changes: changes.sessions
			});
			await copyRows({
				table: plannedExercises,
				ids: exercises,
				parent: { column: plannedExercises.sessionId, ids: sessions },
				changes: changes.exercises
			});
			await copyRows({
				table: setPrescriptions,
				parent: { column: setPrescriptions.plannedExerciseId, ids: exercises },
				changes: byPosition(changes.sets),
				key: "s.planned_exercise_id::text || ':' || s.position"
			});
			await copyRows({
				table: plannedRunSegments,
				parent: { column: plannedRunSegments.sessionId, ids: sessions },
				changes: byPosition(changes.segments),
				key: "s.session_id::text || ':' || s.position"
			});
			await copyRows({
				table: plannedSessionDetails,
				parent: { column: plannedSessionDetails.sessionId, ids: sessions },
				changes: changes.details,
				key: 's.session_id::text'
			});
		},

		/** One page of a program's versions, newest first, each with its decisions. */
		async versionHistory(programId: string, page: { beforeNumber?: number; limit: number }) {
			return versionHistory(db, programId, page);
		},

		/** The titles and dates of the sessions and exercises named in `lineages`, by version. */
		async affectedNodes(versionIds: string[], lineages: string[]) {
			if (!versionIds.length || !lineages.length) return [];
			const q = affectedNodes(db, versionIds, lineages);
			return [...(await q.sessions), ...(await q.exercises)];
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

		/** These weeks' sessions and every child of theirs, set prescriptions included. */
		async weekSessions(
			weekIds: string[]
		): Promise<SessionLineRows & Pick<SessionChildRows, 'sets'>> {
			const q = sessionsWithChildren(db, weekIds);
			return {
				sessions: await q.sessions,
				exercises: await q.exercises,
				sets: await q.sets,
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

		/** A session row by id in one of the owner's programs, with the newest version holding it. */
		async sessionById(ownerId: string, sessionId: string): Promise<SessionByIdRow | null> {
			const [row] = await sessionById(db, ownerId, sessionId);
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
