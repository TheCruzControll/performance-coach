/**
 * Planning a later block (M6; ADR 0010 and the planning-later-blocks ADR): the writes that store
 * a next block, and any bridge before it, as a new program version. M3's repository
 * (./programs.ts) keeps the head, the decisions and the reads; this one adds what a replan writes
 * that an edit never does:
 * - a version that shares only some of its parent's blocks: the planned ones, with their weeks.
 *   The outline blocks the replan plans or moves are not shared; they come back as new rows.
 * - new block rows with their weeks and sessions, one multi-row INSERT per table, each row
 *   arriving with its id and lineage already set (chunked only past ROWS_PER_INSERT).
 * Plain data access: what is planned, and whether the whole version holds, is the service's.
 */
import { sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
	plannedExercises,
	plannedRunSegments,
	plannedSessionDetails,
	plannedSessions,
	programBlocks,
	programVersionBlocks,
	programVersions,
	programVersionWeeks,
	programWeeks,
	setPrescriptions
} from '../schema';
import type { Executor } from '../types';
import type { ProgramTreeRows } from './programs';

type Insert<T extends PgTable> = T['$inferInsert'];

/** New blocks of a version and everything under them, every row with its id (and lineage) set. */
export type PlannedBlockRows = Omit<ProgramTreeRows, 'program' | 'version'>;

/** Well under Postgres's 65,535 bind parameters for the widest table (about 20 columns). */
const ROWS_PER_INSERT = 1000;

/** A jsonb parameter: one bind value however many ids it carries. */
const ids = (values: string[]) =>
	sql`(select value::uuid from jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`;

export function createReplanRepository(db: Executor) {
	async function insertAll<T extends PgTable>(table: T, rows: Insert<T>[]) {
		for (let at = 0; at < rows.length; at += ROWS_PER_INSERT) {
			await db.insert(table).values(rows.slice(at, at + ROWS_PER_INSERT));
		}
	}

	return {
		/**
		 * A version sharing these of its parent's blocks, and every week of theirs the parent holds;
		 * the parent's other blocks (and their weeks) are left out of it.
		 */
		async insertVersionSharing(
			version: Insert<typeof programVersions> & { id: string; parentVersionId: string },
			sharedBlockIds: string[]
		): Promise<void> {
			await db.insert(programVersions).values(version);
			const { id, parentVersionId: parent } = version;
			await db.execute(sql`insert into ${programVersionBlocks} (version_id, block_id)
				select ${id}::uuid, block_id from ${programVersionBlocks}
				where version_id = ${parent} and block_id in ${ids(sharedBlockIds)}`);
			await db.execute(sql`insert into ${programVersionWeeks} (version_id, week_id)
				select ${id}::uuid, m.week_id from ${programVersionWeeks} m
				join ${programWeeks} w on w.id = m.week_id
				where m.version_id = ${parent} and w.block_id in ${ids(sharedBlockIds)}`);
		},

		/** New blocks from the top down: blocks, their membership, weeks, theirs, then sessions. */
		async insertPlannedBlocks(rows: PlannedBlockRows): Promise<void> {
			await insertAll(programBlocks, rows.blocks);
			await insertAll(programVersionBlocks, rows.versionBlocks);
			await insertAll(programWeeks, rows.weeks);
			await insertAll(programVersionWeeks, rows.versionWeeks);
			await insertAll(plannedSessions, rows.sessions);
			await insertAll(plannedExercises, rows.exercises);
			await insertAll(setPrescriptions, rows.sets);
			await insertAll(plannedRunSegments, rows.segments);
			await insertAll(plannedSessionDetails, rows.details);
		}
	};
}
