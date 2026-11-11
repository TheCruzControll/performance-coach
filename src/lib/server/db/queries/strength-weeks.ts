/**
 * The Strength view's week rollups (schema/analytics.ts; services/analytics/strength-weeks.ts):
 * reading a range of an owner's weeks, the spans of the workouts a week holds, and writing weeks
 * back only while nothing marked them stale since they were read.
 * STRENGTH_WEEKS_INDEXES names the index each read is shaped for, for db:explain to gate.
 * Nothing runs until a builder is awaited; await them in turn on one connection.
 */
import { and, asc, between, eq, isNull, max, min, sql } from 'drizzle-orm';
import type { IsoDate } from '../../../domain/calendar';
import { setRecords, strengthWeekRollups, workouts } from '../schema';
import type { Executor } from '../types';

export const STRENGTH_WEEKS_INDEXES = {
	weeks: 'strength_week_rollups_pk',
	spans: 'set_records_workout_order_idx'
} as const;

/** The owner's rollups of the weeks starting `from` to `to` (Mondays), oldest first. */
export function strengthWeekRows(db: Executor, ownerId: string, from: IsoDate, to: IsoDate) {
	const t = strengthWeekRollups;
	return db
		.select({
			weekStart: t.weekStart,
			generation: t.generation,
			writtenAt: t.writtenAt,
			timeZone: t.timeZone,
			analyticsVersion: t.analyticsVersion,
			digestVersion: t.digestVersion,
			split: t.split,
			digest: t.digest
		})
		.from(t)
		.where(and(eq(t.ownerId, ownerId), between(t.weekStart, from, to)))
		.orderBy(asc(t.weekStart));
}

export type StrengthWeekRow = Awaited<ReturnType<typeof strengthWeekRows>>[number];

/**
 * When each of these workouts started, and its first and last undeleted set (null without any):
 * whether a week holds them whole. Each workout probes its own sets (a LATERAL from the few
 * workouts), so a week's spans never read the whole table.
 */
export function workoutSpans(db: Executor, ownerId: string, workoutIds: readonly string[]) {
	const sets = db
		.select({
			firstSet: min(setRecords.performedAt).as('first_set'),
			lastSet: max(setRecords.performedAt).as('last_set')
		})
		.from(setRecords)
		.where(and(eq(setRecords.workoutId, workouts.id), isNull(setRecords.deletedAt)))
		.as('sets');
	return db
		.select({
			id: workouts.id,
			startedAt: workouts.startedAt,
			firstSet: sets.firstSet,
			lastSet: sets.lastSet
		})
		.from(workouts)
		.innerJoinLateral(sets, sql`true`)
		.where(
			and(
				eq(workouts.ownerId, ownerId),
				sql`${workouts.id} = any(${sql.param([...workoutIds])}::uuid[])`
			)
		);
}

export type StrengthWeekWrite = typeof strengthWeekRollups.$inferInsert;

/**
 * Write these weeks (oldest first, as the stale marking locks them). A week already stored is
 * replaced only while its generation is still the one given, the one read before its facts: a
 * week marked stale since keeps its mark, and is summed again by the next write. Returns the
 * weeks written.
 */
export function writeStrengthWeeks(db: Executor, rows: readonly StrengthWeekWrite[]) {
	const t = strengthWeekRollups;
	const excluded = (column: string) => sql.raw(`excluded.${column}`);
	return db
		.insert(t)
		.values([...rows])
		.onConflictDoUpdate({
			target: [t.ownerId, t.weekStart],
			set: {
				writtenAt: excluded('written_at'),
				timeZone: excluded('time_zone'),
				analyticsVersion: excluded('analytics_version'),
				digestVersion: excluded('digest_version'),
				split: excluded('split'),
				digest: excluded('digest')
			},
			setWhere: sql`${t.generation} = excluded.generation`
		})
		.returning({ weekStart: t.weekStart });
}
