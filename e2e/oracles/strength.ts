/**
 * Strength figures recomputed in SQL, for the dashboard specs to compare the screens with. No app
 * code: each definition is written out here, and a new figure gets a new file, never an edit.
 *
 * - Only sets of completed workouts count: workouts.status = 'completed' and deleted_at null,
 *   and the set's own deleted_at null. Abandoned, in-progress and soft-deleted workouts never do.
 * - A working set is neither a warm-up nor skipped. Weights are kg (weight_kg), days are the
 *   owner's local day of performed_at (athlete_profiles.time_zone), weeks run Monday to Sunday.
 * - `today` is the day the fixture was seeded on (SeededAnalytics.today): its week is the week in
 *   progress, flagged and never a complete week.
 */
import { query } from '../support';

/** Live sets of completed, undeleted workouts, with their exercise and local day. */
const SETS = `sets as (
	select s.id, s.weight_kg, s.reps, s.rpe, s.e1rm_kg, s.assistance,
		not s.is_warmup and not s.is_skipped as working,
		s.planned_exercise_lineage_id, w.planned_session_id,
		w.id as workout_id, w.started_at, e.key, e.primary_muscles, e.secondary_muscles,
		(s.performed_at at time zone p.time_zone)::date as day
	from set_records s
	join workouts w on w.id = s.workout_id
	join exercises e on e.id = s.exercise_id
	join athlete_profiles p on p.owner_id = s.owner_id
	where w.status = 'completed' and w.deleted_at is null and s.deleted_at is null
)`;

const WEEK = (column: string) => `date_trunc('week', ${column})::date`;
const ISO = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;

export interface TonnageWeek {
	weekStart: string;
	tonnageKg: number;
	inProgress: boolean;
}

/**
 * Σ weight_kg × reps of working sets with a weight (assisted sets have none), each week from the
 * first set's week to today's, zero-filled.
 */
export function weeklyTonnage(today: string): Promise<TonnageWeek[]> {
	return query<TonnageWeek>(
		`with ${SETS},
		weeks as (
			select generate_series(${WEEK('(select min(day) from sets)')}, ${WEEK('$1::date')}, interval '7 days')::date as week
		)
		select ${ISO('week')} as "weekStart",
			coalesce(sum(s.weight_kg * s.reps), 0)::float8 as "tonnageKg",
			week = ${WEEK('$1::date')} as "inProgress"
		from weeks
		left join sets s on ${WEEK('s.day')} = week and s.working and s.weight_kg is not null
			and s.reps is not null and s.assistance is null and s.day <= $1::date
		group by week order by week`,
		[today]
	);
}

/** The highest stored e1rm_kg per exercise key. */
export function bestE1rms(): Promise<{ key: string; e1rmKg: number }[]> {
	return query(
		`with ${SETS}
		select key, max(e1rm_kg)::float8 as "e1rmKg" from sets
		where e1rm_kg is not null group by key order by key`
	);
}

export interface E1rmChange {
	first: number;
	last: number;
	change: number;
	/** change ÷ first × 100. */
	pct: number;
}

/**
 * The best e1RM of `key`'s first and last sessions (workouts) between `from` and `to` inclusive,
 * and the change between them; null with no session in the range.
 */
export async function e1rmChange(
	key: string,
	from: string,
	to: string
): Promise<E1rmChange | null> {
	const [row] = await query<{ first: number | null; last: number | null }>(
		`with ${SETS},
		sessions as (
			select workout_id, min(started_at) as started, max(e1rm_kg) as best from sets
			where key = $1 and day between $2::date and $3::date and e1rm_kg is not null
			group by workout_id
		)
		select (select best from sessions order by started limit 1)::float8 as first,
			(select best from sessions order by started desc limit 1)::float8 as last`,
		[key, from, to]
	);
	if (row?.first == null || row.last == null) return null;
	const change = row.last - row.first;
	return { first: row.first, last: row.last, change, pct: (change / row.first) * 100 };
}

/** The heaviest working weight_kg at each rep count from 1 to 10. */
export function repMaxes(key: string): Promise<{ reps: number; weightKg: number }[]> {
	return query(
		`with ${SETS}
		select reps, max(weight_kg)::float8 as "weightKg" from sets
		where key = $1 and working and weight_kg > 0 and reps between 1 and 10
		group by reps order by reps`,
		[key]
	);
}

export interface PrRow {
	kind: 'e1rm' | 'rep_max' | 'volume';
	/** The rep count of a rep_max; null otherwise. */
	reps: number | null;
	day: string;
	value: number;
	/** The record it beat. */
	previous: number;
}

/**
 * Every record `key` broke, in date order (then kind, then reps). Per session (workout): its best
 * e1RM, its heaviest weight at each rep count 1–10, and its volume (Σ weight × reps of working
 * sets). A session sets a record when its value is strictly above every earlier session's (a
 * tie is not a record), and the first session with a value is the baseline, never a record.
 */
export function prRows(key: string): Promise<PrRow[]> {
	return query<PrRow>(
		`with ${SETS},
		per as (
			select workout_id, min(started_at) as started, min(day) as day, max(e1rm_kg) as e1rm,
				sum(weight_kg * reps) filter (where working and weight_kg is not null and reps is not null) as volume
			from sets where key = $1 group by workout_id
		),
		reps as (
			select workout_id, min(started_at) as started, min(day) as day, reps, max(weight_kg) as value
			from sets where key = $1 and working and weight_kg > 0 and reps between 1 and 10
			group by workout_id, reps
		),
		records as (
			select 'e1rm' as kind, null::int as reps, day, started, e1rm as value,
				max(e1rm) over (order by started rows between unbounded preceding and 1 preceding) as previous
			from per where e1rm is not null
			union all
			select 'volume', null, day, started, volume,
				max(volume) over (order by started rows between unbounded preceding and 1 preceding)
			from per where volume is not null
			union all
			select 'rep_max', reps, day, started, value,
				max(value) over (partition by reps order by started rows between unbounded preceding and 1 preceding)
			from reps
		)
		select kind, reps, ${ISO('day')} as day, value::float8 as value, previous::float8 as previous
		from records where previous is not null and value > previous
		order by started, kind, reps nulls first`,
		[key]
	);
}

/** M3's muscle groups (domain/training/vocabulary.ts MUSCLE_GROUP), written out. */
const GROUPS = `groups(muscle, grp) as (values
	('chest', 'chest'), ('front_delts', 'shoulders'), ('side_delts', 'shoulders'),
	('rear_delts', 'shoulders'), ('lats', 'back'), ('upper_back', 'back'), ('traps', 'back'),
	('lower_back', 'back'), ('biceps', 'biceps'), ('triceps', 'triceps'), ('forearms', 'forearms'),
	('abs', 'core'), ('obliques', 'core'), ('glutes', 'hips'), ('adductors', 'hips'),
	('hip_flexors', 'hips'), ('quads', 'quads'), ('hamstrings', 'hamstrings'), ('calves', 'calves'),
	('neck', 'neck')
)`;

/**
 * Hard sets per muscle group per week, up to today. A hard set is a working set at RPE 7 or more,
 * or with no RPE. The documented weighting: each primary muscle 1, each secondary 0.5, and a
 * group takes its best credit once per set (a row is one back set, not two).
 */
export function hardSetsByGroup(
	today: string
): Promise<{ weekStart: string; group: string; hardSets: number }[]> {
	return query(
		`with ${SETS}, ${GROUPS},
		credit as (
			select s.id, ${WEEK('s.day')} as week, g.grp, max(c.credit) as credit
			from sets s
			cross join lateral (
				select unnest(s.primary_muscles) as muscle, 1.0 as credit
				union all select unnest(s.secondary_muscles), 0.5
			) c
			join groups g on g.muscle = c.muscle
			where s.working and (s.rpe is null or s.rpe >= 7) and s.day <= $1::date
			group by s.id, week, g.grp
		)
		select ${ISO('week')} as "weekStart", grp as "group", sum(credit)::float8 as "hardSets"
		from credit group by week, grp order by week, grp`,
		[today]
	);
}

export interface RpeSummary {
	/** Working sets in the range, and how many carry an RPE. */
	sets: number;
	rated: number;
	/** The mean RPE of those that do; null when none does. */
	meanRpe: number | null;
	/**
	 * The mean of RPE − target over rated sets whose planned exercise has a target: the highest
	 * target_rpe among its working prescription lines (roles other than warm_up and ramp) in the
	 * version the workout was logged from. Null when no set has one.
	 */
	deviation: number | null;
	deviationSets: number;
}

/** RPE over working sets between `from` and `to` inclusive. */
export async function rpeSummary(from: string, to: string): Promise<RpeSummary> {
	const [row] = await query<RpeSummary>(
		`with ${SETS},
		targets as (
			select s.id, s.rpe, (
				select max(sp.target_rpe) from planned_exercises pe
				join set_prescriptions sp on sp.planned_exercise_id = pe.id
				where pe.session_id = s.planned_session_id and pe.lineage_id = s.planned_exercise_lineage_id
					and sp.role not in ('warm_up', 'ramp')
			) as target
			from sets s where s.working and s.day between $1::date and $2::date
		)
		select count(*)::int as sets, count(rpe)::int as rated, avg(rpe)::float8 as "meanRpe",
			avg(rpe - target)::float8 as deviation,
			count(*) filter (where rpe is not null and target is not null)::int as "deviationSets"
		from targets`,
		[from, to]
	);
	return row!;
}
