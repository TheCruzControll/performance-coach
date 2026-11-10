/**
 * The overview's figures recomputed in SQL, for e2e/progress.serial.e2e.ts to compare Progress
 * with. No app code: each definition is written out here (as in the other oracle files), over a
 * span of the owner's local days, so a spec can ask for a period's complete weeks or for the week
 * so far and the same days of last week.
 *
 * - Only completed, undeleted workouts count (and live sets of them).
 * - Days are the owner's local day (athlete_profiles.time_zone).
 */
import { query } from '../support';

export interface OverviewFigures {
	/** Σ weight_kg × reps of working sets with a weight and no assistance. */
	tonnageKg: number;
	/** Σ run_records.distance_m. */
	metres: number;
	/** Completed workouts, planned and off plan. */
	sessions: number;
	/** Σ minutes × RPE (session RPE, else the run's or the other record's). */
	loadAu: number;
	/** Completed ÷ (completed + skipped + missed) planned sessions × 100; null with none due. */
	adherencePct: number | null;
}

/** The figures over `from`–`to` (both included); `today` decides what is missed. */
export async function figuresBetween(
	from: string,
	to: string,
	today: string
): Promise<OverviewFigures> {
	const [row] = await query<OverviewFigures>(
		`with done as (
			select w.id, w.planned_lineage_id, w.duration_s,
				coalesce(w.session_rpe, r.rpe, o.rpe) as rpe, r.distance_m,
				(w.started_at at time zone p.time_zone)::date as day
			from workouts w
			join athlete_profiles p on p.owner_id = w.owner_id
			left join run_records r on r.workout_id = w.id
			left join other_session_records o on o.workout_id = w.id
			where w.status = 'completed' and w.deleted_at is null
		),
		lifted as (
			select coalesce(sum(s.weight_kg * s.reps), 0)::float8 as kg
			from set_records s
			join workouts w on w.id = s.workout_id
			join athlete_profiles p on p.owner_id = s.owner_id
			where w.status = 'completed' and w.deleted_at is null and s.deleted_at is null
				and not s.is_warmup and not s.is_skipped and s.weight_kg is not null
				and s.reps is not null and s.assistance is null
				and (s.performed_at at time zone p.time_zone)::date between $1::date and $2::date
		),
		planned as (
			select s.scheduled_on as day, s.status,
				exists (select 1 from done d where d.planned_lineage_id = s.lineage_id) as completed
			from programs pr
			join program_version_weeks vw on vw.version_id = pr.current_version_id
			join planned_sessions s on s.week_id = vw.week_id
			where s.scheduled_on between $1::date and $2::date
		),
		due as (
			select count(*) filter (where completed)::int as completed,
				count(*) filter (where completed or status = 'skipped' or day < $3::date)::int as due
			from planned
		)
		select (select kg from lifted) as "tonnageKg",
			coalesce(sum(d.distance_m), 0)::float8 as metres,
			count(d.id)::int as sessions,
			coalesce(sum(d.duration_s / 60.0 * d.rpe), 0)::float8 as "loadAu",
			(select (completed * 100.0 / nullif(due, 0))::float8 from due) as "adherencePct"
		from done d where d.day between $1::date and $2::date`,
		[from, to, today]
	);
	return row!;
}
