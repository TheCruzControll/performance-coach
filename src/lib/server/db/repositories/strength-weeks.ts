/**
 * The Strength view's week rollups (schema/analytics.ts): runs queries/strength-weeks.ts's reads
 * and write one at a time. Plain data access: when a rollup is current and what it holds belong
 * to services/analytics/strength-weeks.ts.
 */
import type { IsoDate } from '../../../domain/calendar';
import {
	strengthWeekRows,
	workoutSpans,
	writeStrengthWeeks,
	type StrengthWeekRow,
	type StrengthWeekWrite
} from '../queries/strength-weeks';
import type { Executor } from '../types';

export type { StrengthWeekRow, StrengthWeekWrite };

/** When a workout started, and its first and last undeleted set (null without any). */
export interface WorkoutSpan {
	id: string;
	startedAt: Date;
	firstSet: Date | null;
	lastSet: Date | null;
}

export function createStrengthWeeksRepository(db: Executor) {
	return {
		/** The owner's rollups of the weeks starting `from` to `to`, oldest first. */
		rows: (ownerId: string, from: IsoDate, to: IsoDate): Promise<StrengthWeekRow[]> =>
			strengthWeekRows(db, ownerId, from, to),

		async spans(ownerId: string, workoutIds: readonly string[]): Promise<WorkoutSpan[]> {
			if (!workoutIds.length) return [];
			const rows = await workoutSpans(db, ownerId, workoutIds);
			return rows.map((row) => ({ ...row, startedAt: row.startedAt! }));
		},

		/** Write these weeks, each only while its generation is the one given: how many were. */
		async write(rows: readonly StrengthWeekWrite[]): Promise<number> {
			return rows.length ? (await writeStrengthWeeks(db, rows)).length : 0;
		}
	};
}

export type StrengthWeeksRepository = ReturnType<typeof createStrengthWeeksRepository>;
