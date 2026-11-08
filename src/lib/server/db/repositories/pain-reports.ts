/**
 * Pain reports (schema/feedback.ts): what pain.report writes. A report is addressed by its
 * device client id, its primary key, so a replayed create writes nothing and returns the stored
 * row. Plain data access: what a report means is services/workouts/apply/pain.ts's to decide.
 */
import { and, eq } from 'drizzle-orm';
import { painReports } from '../schema';
import type { Executor } from '../types';
import type { Stored } from './training-log';

export type PainReportRow = typeof painReports.$inferSelect;
export type NewPainReport = typeof painReports.$inferInsert;

export function createPainReportsRepository(db: Executor) {
	const repo = {
		/** The owner's report with this client id, deleted ones included; null when none. */
		async report(ownerId: string, id: string): Promise<PainReportRow | null> {
			const [row] = await db
				.select()
				.from(painReports)
				.where(and(eq(painReports.ownerId, ownerId), eq(painReports.id, id)));
			return row ?? null;
		},

		/**
		 * Write a report unless its id is stored already. Null only when another owner's report
		 * holds the id.
		 */
		async insertReport(values: NewPainReport): Promise<Stored<PainReportRow> | null> {
			const [row] = await db
				.insert(painReports)
				.values(values)
				.onConflictDoNothing({ target: painReports.id })
				.returning();
			if (row) return { row, created: true };
			const stored = await repo.report(values.ownerId, values.id);
			return stored && { row: stored, created: false };
		}
	};
	return repo;
}
