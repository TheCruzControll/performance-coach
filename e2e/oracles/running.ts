/**
 * Running figures recomputed in SQL, for the dashboard specs to compare the screens with. No app
 * code: each definition is written out here, and a new figure gets a new file, never an edit.
 *
 * - Only runs of completed workouts count: workouts.status = 'completed' and deleted_at null.
 * - Distances are metres (run_records.distance_m), times seconds, paces seconds per km. Days are
 *   the owner's local day of the workout's start; weeks run Monday to Sunday.
 * - `today` is the day the fixture was seeded on: its week is the week in progress.
 */
import { query } from '../support';

/** Run records of completed, undeleted workouts, with their local day. */
const RUNS = `runs as (
	select w.id, w.session_type, w.started_at, r.distance_m, r.duration_s, r.avg_hr,
		(w.started_at at time zone p.time_zone)::date as day
	from workouts w
	join run_records r on r.workout_id = w.id
	join athlete_profiles p on p.owner_id = w.owner_id
	where w.status = 'completed' and w.deleted_at is null
)`;

const WEEK = (column: string) => `date_trunc('week', ${column})::date`;

export interface RunningWeek {
	weekStart: string;
	metres: number;
	runs: number;
	seconds: number;
	/** The week's longest run; 0 with none. */
	longestMetres: number;
	inProgress: boolean;
	/** The week before's metres, and the change on it (null for the first week). */
	previousMetres: number | null;
	changeMetres: number | null;
	/** changeMetres ÷ previousMetres × 100; null when there is nothing to compare with. */
	changePct: number | null;
}

/** Each week from the first run's week to today's, zero-filled. */
export function weeklyRunning(today: string): Promise<RunningWeek[]> {
	return query<RunningWeek>(
		`with ${RUNS},
		weeks as (
			select generate_series(${WEEK('(select min(day) from runs)')}, ${WEEK('$1::date')}, interval '7 days')::date as week
		),
		totals as (
			select week, coalesce(sum(r.distance_m), 0)::float8 as metres, count(r.id)::int as runs,
				coalesce(sum(r.duration_s), 0)::int as seconds,
				coalesce(max(r.distance_m), 0)::float8 as longest
			from weeks left join runs r on ${WEEK('r.day')} = week and r.day <= $1::date
			group by week
		)
		select to_char(week, 'YYYY-MM-DD') as "weekStart", metres, runs, seconds,
			longest as "longestMetres", week = ${WEEK('$1::date')} as "inProgress",
			lag(metres) over w as "previousMetres", metres - lag(metres) over w as "changeMetres",
			(metres - lag(metres) over w) * 100 / nullif(lag(metres) over w, 0) as "changePct"
		from totals window w as (order by week) order by week`,
		[today]
	);
}

/** The longest run of all, the earliest of equals. */
export async function longestRun(): Promise<{
	day: string;
	metres: number;
	sessionType: string;
} | null> {
	const [row] = await query<{ day: string; metres: number; sessionType: string }>(
		`with ${RUNS}
		select to_char(day, 'YYYY-MM-DD') as day, distance_m::float8 as metres, session_type as "sessionType"
		from runs where distance_m is not null order by distance_m desc, started_at limit 1`
	);
	return row ?? null;
}

export interface TypePace {
	sessionType: string;
	secondsPerKm: number;
	runs: number;
}

/**
 * Pace per session type between `from` and `to` inclusive: Σ seconds ÷ Σ km over the type's runs
 * (distance-weighted). Intervals count only their interval segments; a tempo run its tempo
 * segments when it has any, otherwise the whole run; every other type the whole run. A run
 * without both a distance and a time for what it counts is left out.
 */
export function paceByType(from: string, to: string): Promise<TypePace[]> {
	return query<TypePace>(
		`with ${RUNS},
		parts as (
			select r.id, r.session_type, s.kind, s.distance_m, s.duration_s
			from runs r join run_record_segments s on s.workout_id = r.id
			where s.distance_m is not null and s.duration_s is not null
		),
		basis as (
			select r.id, r.session_type,
				case
					when r.session_type = 'interval_run' then
						(select sum(duration_s) from parts where id = r.id and kind = 'interval')
					when r.session_type = 'tempo_run' and exists (select 1 from parts where id = r.id and kind = 'tempo') then
						(select sum(duration_s) from parts where id = r.id and kind = 'tempo')
					else r.duration_s
				end as seconds,
				case
					when r.session_type = 'interval_run' then
						(select sum(distance_m) from parts where id = r.id and kind = 'interval')
					when r.session_type = 'tempo_run' and exists (select 1 from parts where id = r.id and kind = 'tempo') then
						(select sum(distance_m) from parts where id = r.id and kind = 'tempo')
					else r.distance_m
				end as metres
			from runs r where r.day between $1::date and $2::date
		)
		select session_type as "sessionType", (sum(seconds) * 1000.0 / sum(metres))::float8 as "secondsPerKm",
			count(*)::int as runs
		from basis where seconds is not null and metres > 0
		group by session_type order by session_type`,
		[from, to]
	);
}
