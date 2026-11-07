/**
 * Adherence, time, load and Muay Thai figures recomputed in SQL, for the dashboard specs to
 * compare the screens with. No app code: each definition is written out here, and a new figure
 * gets a new file, never an edit.
 *
 * - Only completed workouts count: workouts.status = 'completed' and deleted_at null.
 * - Days are the owner's local day of the workout's start (athlete_profiles.time_zone); a
 *   planned session's day is its scheduled_on (a moved session counts on its new day). Weeks run
 *   Monday to Sunday.
 * - `today` is the day the fixture was seeded on: its week is the week in progress.
 */
import { query } from '../support';

/** Completed, undeleted workouts with their local day and the RPE their load takes. */
const DONE = `done as (
	select w.id, w.discipline, w.planned_session_id, w.planned_lineage_id, w.duration_s,
		coalesce(w.session_rpe, r.rpe, o.rpe) as rpe, o.metrics, o.duration_minutes,
		(w.started_at at time zone p.time_zone)::date as day
	from workouts w
	join athlete_profiles p on p.owner_id = w.owner_id
	left join run_records r on r.workout_id = w.id
	left join other_session_records o on o.workout_id = w.id
	where w.status = 'completed' and w.deleted_at is null
)`;

const WEEK = (column: string) => `date_trunc('week', ${column})::date`;
const ISO = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;

export interface AdherenceWeek {
	weekStart: string;
	planned: number;
	completed: number;
	/** The owner's choice. */
	skipped: number;
	/** Past (before today), neither done nor skipped. */
	missed: number;
	/** Moved to this week's day (also counted by what became of it). */
	moved: number;
	/** Today or later and not done: left out of the rate. */
	pending: number;
	/** Completed off-plan workouts. */
	extra: number;
	/** completed ÷ (completed + skipped + missed) × 100; null with nothing to rate. */
	pct: number | null;
}

/**
 * The planned sessions of every program's current version scheduled between `from` and `to`,
 * per week. A session is completed when a completed workout carries its lineage.
 */
export function adherence(from: string, to: string, today: string): Promise<AdherenceWeek[]> {
	return query<AdherenceWeek>(
		`with ${DONE},
		planned as (
			select s.scheduled_on as day, s.status,
				exists (select 1 from done d where d.planned_lineage_id = s.lineage_id) as completed
			from programs p
			join program_version_weeks vw on vw.version_id = p.current_version_id
			join planned_sessions s on s.week_id = vw.week_id
			where s.scheduled_on between $1::date and $2::date
		),
		weeks as (
			select ${WEEK('day')} as week, count(*)::int as planned,
				count(*) filter (where completed)::int as completed,
				count(*) filter (where not completed and status = 'skipped')::int as skipped,
				count(*) filter (where not completed and status <> 'skipped' and day < $3::date)::int as missed,
				count(*) filter (where status = 'moved')::int as moved,
				count(*) filter (where not completed and status <> 'skipped' and day >= $3::date)::int as pending
			from planned group by 1
		),
		extra as (
			select ${WEEK('day')} as week, count(*)::int as extra from done
			where planned_session_id is null and day between $1::date and $2::date group by 1
		)
		select ${ISO('coalesce(w.week, e.week)')} as "weekStart",
			coalesce(planned, 0) as planned, coalesce(completed, 0) as completed,
			coalesce(skipped, 0) as skipped, coalesce(missed, 0) as missed, coalesce(moved, 0) as moved,
			coalesce(pending, 0) as pending, coalesce(extra, 0) as extra,
			(completed * 100.0 / nullif(completed + skipped + missed, 0))::float8 as pct
		from weeks w full join extra e on e.week = w.week
		order by coalesce(w.week, e.week)`,
		[from, to, today]
	);
}

export interface DisciplineWeek {
	weekStart: string;
	discipline: string;
	sessions: number;
	/** Σ duration of the sessions that have one, in minutes. */
	minutes: number;
	/** Sessions with no duration: counted, never taken as 0 minutes. */
	unknownDuration: number;
}

/** Completed sessions and training time per discipline per week, up to today. */
export function disciplineWeeks(today: string): Promise<DisciplineWeek[]> {
	return query<DisciplineWeek>(
		`with ${DONE}
		select ${ISO(WEEK('day'))} as "weekStart", discipline, count(*)::int as sessions,
			(coalesce(sum(duration_s), 0) / 60.0)::float8 as minutes,
			count(*) filter (where duration_s is null)::int as "unknownDuration"
		from done where day <= $1::date
		group by ${WEEK('day')}, discipline order by ${WEEK('day')}, discipline`,
		[today]
	);
}

export interface LoadWeek {
	weekStart: string;
	/** Σ minutes × RPE (session RPE, else the run's or the other record's RPE), in AU. */
	loadAu: number;
	/** Sessions with no duration or no RPE: counted, left out of the load. */
	unknown: number;
}

/** Weekly session-RPE load, each week with a completed session, up to today. */
export function weeklyLoad(today: string): Promise<LoadWeek[]> {
	return query<LoadWeek>(
		`with ${DONE}
		select ${ISO(WEEK('day'))} as "weekStart",
			coalesce(sum(duration_s / 60.0 * rpe), 0)::float8 as "loadAu",
			count(*) filter (where duration_s is null or rpe is null)::int as unknown
		from done where day <= $1::date
		group by ${WEEK('day')} order by ${WEEK('day')}`,
		[today]
	);
}

export interface MuayThaiWeek {
	weekStart: string;
	sessions: number;
	/** Σ the other session records' duration_minutes. */
	minutes: number;
	/** Σ numeric metrics keyed 'rounds', and keyed 'sparring_rounds'. */
	rounds: number;
	sparringRounds: number;
}

/** Completed Muay Thai sessions per week, up to today. */
export function muayThaiWeeks(today: string): Promise<MuayThaiWeek[]> {
	return query<MuayThaiWeek>(
		`with ${DONE},
		sessions as (
			select d.id, d.day, d.duration_minutes,
				coalesce(sum((m->>'value')::float8) filter (where m->>'key' = 'rounds'), 0) as rounds,
				coalesce(sum((m->>'value')::float8) filter (where m->>'key' = 'sparring_rounds'), 0) as sparring
			from done d left join lateral jsonb_array_elements(d.metrics) m
				on jsonb_typeof(m->'value') = 'number'
			where d.discipline = 'muay_thai' and d.day <= $1::date
			group by d.id, d.day, d.duration_minutes
		)
		select ${ISO(WEEK('day'))} as "weekStart", count(*)::int as sessions,
			coalesce(sum(duration_minutes), 0)::float8 as minutes,
			sum(rounds)::float8 as rounds, sum(sparring)::float8 as "sparringRounds"
		from sessions group by ${WEEK('day')} order by ${WEEK('day')}`,
		[today]
	);
}
