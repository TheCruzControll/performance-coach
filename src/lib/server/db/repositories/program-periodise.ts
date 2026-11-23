/**
 * Re-plans (M7; ADR 0010 and docs/adr/NNNN-replans-as-versions.md): the writes and reads a re-plan
 * adds to M3's repository (./programs.ts) and M6's (./program-replan.ts), which keep theirs. A
 * re-planned version shares every block before `from` and, after a taper, every block after the
 * event (M6's insertVersionSharing); what this file adds:
 * - cutBlock: a block running across `from` comes back as a new row with the same lineage and its
 *   new dates (a taper's tail, after the event, under a new lineage). History rows are never
 *   updated, so its weeks are copied under it by M3's copyWeekSubtree, keeping their lineages.
 *   A block starting on or after `from` is simply not shared (dropped), never cut to zero weeks.
 * - touchedFrom: the base's sessions from a day on that are skipped or have a workout logged
 * - cutShortLineages: the blocks of a version a re-plan cut short, which get no cycle review
 * Plain data access: what is planned, and whether the version holds, is the service's.
 */
import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { IsoDate } from '../../../domain/calendar';
import {
	plannedSessions,
	programBlocks,
	programVersionBlocks,
	programVersionWeeks,
	programWeeks,
	workouts
} from '../schema';
import type { Executor } from '../types';

/** A block row re-inserted into a version with new dates. */
export interface CutBlock {
	/** The base's block row it is cut from. */
	fromId: string;
	id: string;
	lineageId: string;
	position: number;
	startsOn: IsoDate;
	endsOn: IsoDate;
}

export function createPeriodiseRepository(db: Executor) {
	return {
		/**
		 * The block row `fromId` again as `cut`, every other column as stored, in the version. Unlike
		 * a shared block, a cut one cannot keep its week ids: week.block_id names the block row, so its
		 * weeks before the cut are copied as new rows under the same lineages (copyWeekSubtree).
		 */
		async cutBlock(versionId: string, cut: CutBlock): Promise<void> {
			const set: Record<string, SQL> = {
				id: sql`${cut.id}::uuid`,
				lineage_id: sql`${cut.lineageId}::uuid`,
				position: sql`${cut.position}::int`,
				starts_on: sql`${cut.startsOn}::date`,
				ends_on: sql`${cut.endsOn}::date`
			};
			// Every column as stored (a column added later included) but the five a cut sets.
			const names = Object.values(getTableColumns(programBlocks)).map((c) => c.name);
			const values = names.map((name) => set[name] ?? sql.identifier(name));
			await db.execute(sql`insert into ${programBlocks}
				(${sql.join(
					names.map((n) => sql.identifier(n)),
					sql`, `
				)})
				select ${sql.join(values, sql`, `)} from ${programBlocks} where id = ${cut.fromId}`);
			await db.insert(programVersionBlocks).values({ versionId, blockId: cut.id });
		},

		/**
		 * The first of the version's sessions on or after `from` that is skipped or has a workout of
		 * the owner's (not deleted, any status) logged against its lineage; null when none has.
		 */
		async touchedFrom(ownerId: string, versionId: string, from: IsoDate) {
			const { rows } = await db.execute<{ date: IsoDate; title: string }>(
				sql`select s.scheduled_on::text as date, s.title from ${programVersionWeeks} m
					join ${programWeeks} w on w.id = m.week_id
					join ${plannedSessions} s on s.week_id = w.id
					where m.version_id = ${versionId} and s.scheduled_on >= ${from}::date
						and (s.status = 'skipped' or exists (select 1 from ${workouts} o
							where o.owner_id = ${ownerId} and o.planned_lineage_id = s.lineage_id
								and o.deleted_at is null))
					order by s.scheduled_on, s.order_in_day limit 1`
			);
			return rows[0] ?? null;
		},

		/**
		 * The lineages of the version's blocks that a re-plan cut short: an earlier planned row of
		 * the same lineage ran later. A planned block keeps its outline's lineage (M6), so outline
		 * rows are left out.
		 */
		async cutShortLineages(versionId: string): Promise<Set<string>> {
			const { rows } = await db.execute<{ lineage: string }>(
				sql`select distinct b.lineage_id::text as lineage from ${programVersionBlocks} m
					join ${programBlocks} b on b.id = m.block_id
					where m.version_id = ${versionId} and exists (select 1 from ${programBlocks} o
						where o.program_id = b.program_id and o.lineage_id = b.lineage_id
							and not o.outline and o.ends_on > b.ends_on)`
			);
			return new Set(rows.map((r) => r.lineage));
		}
	};
}
