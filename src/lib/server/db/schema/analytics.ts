/**
 * The Strength view's closed weeks, summed once (PRD §10; services/analytics/strength-weeks.ts):
 * one row per owner and Monday, holding domain/analytics/strength-weeks.ts's StrengthWeek for
 * that week (packWeek's stored form), so Progress over two years reads about a hundred rows
 * instead of every set.
 *
 * - Derived data only: every row can be rebuilt from the training log, and a row nobody trusts
 *   is simply summed again from the facts.
 * - A write to the log marks the weeks it may change stale, in the database
 *   (drizzle/<n>_strength_week_rollups_stale.sql): set_records and workouts inserts and updates,
 *   and an exercise whose measure, load type or muscles change. Marking bumps `generation` and
 *   clears `written_at`, so a sum worked out from facts read before the change never lands: a
 *   write keeps the row only while its generation is the one read before the facts.
 * - A row is current only for the time zone, analytics version and digest version it records;
 *   anything else is summed from the facts until the next write.
 * - `split`: a workout of the week has a set or its start in another week, so the week is summed
 *   with its neighbours on each read and holds no digest.
 * - `digest` is json, not jsonb: kept as written, so each number reads back as the same double and
 *   each object's keys in the same order.
 */
import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	integer,
	json,
	pgTable,
	primaryKey,
	text,
	timestamp
} from 'drizzle-orm/pg-core';
import type { PackedWeek } from '../../../domain/analytics/strength-weeks';
import { ownerRef } from './columns';

export const strengthWeekRollups = pgTable(
	'strength_week_rollups',
	{
		ownerId: ownerRef(),
		/** The week's Monday, on the owner's calendar. */
		weekStart: date('week_start', { mode: 'string' }).notNull(),
		/** Bumped by every change that may alter the week. */
		generation: integer('generation').notNull().default(0),
		/** When it was last summed; null while stale. */
		writtenAt: timestamp('written_at', { withTimezone: true }),
		timeZone: text('time_zone'),
		analyticsVersion: integer('analytics_version'),
		digestVersion: integer('digest_version'),
		split: boolean('split').notNull().default(false),
		digest: json('digest').$type<PackedWeek>()
	},
	(t) => [
		primaryKey({ name: 'strength_week_rollups_pk', columns: [t.ownerId, t.weekStart] }),
		check(
			'strength_week_rollups_written_ck',
			sql`${t.writtenAt} is null or (${t.timeZone} is not null and ${t.analyticsVersion} is not null and ${t.digestVersion} is not null and (${t.digest} is null) = ${t.split})`
		)
	]
);
