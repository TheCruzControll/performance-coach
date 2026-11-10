/**
 * RPE against target per lift for one week, recomputed in SQL, for the weekly review spec to
 * compare its RPE section with. No app code: each definition is written out here, and a new
 * figure gets a new file, never an edit.
 *
 * - Only sets of completed, undeleted workouts count, and the set's own deleted_at null; a
 *   working set is neither a warm-up nor skipped. Days are the owner's local day of performed_at.
 * - A set's target is the highest target_rpe among its planned exercise's working prescription
 *   lines (roles other than warm_up and ramp) in the version the workout was logged from, as
 *   strength.ts's rpeSummary reads it. Only sets with both an RPE and a target count.
 */
import { query } from '../support';

export interface LiftRpe {
	key: string;
	/** The catalogue name, as the review labels the lift. */
	name: string;
	actual: number;
	target: number;
	/** The mean of RPE − target. */
	deviation: number;
	sets: number;
}

/** Each lift's mean RPE, mean target and mean deviation between `from` and `to` inclusive. */
export function liftRpe(from: string, to: string): Promise<LiftRpe[]> {
	return query<LiftRpe>(
		`with sets as (
			select s.rpe, e.key, e.name, s.planned_exercise_lineage_id, w.planned_session_id
			from set_records s
			join workouts w on w.id = s.workout_id
			join exercises e on e.id = s.exercise_id
			join athlete_profiles p on p.owner_id = s.owner_id
			where w.status = 'completed' and w.deleted_at is null and s.deleted_at is null
				and not s.is_warmup and not s.is_skipped and s.rpe is not null
				and (s.performed_at at time zone p.time_zone)::date between $1::date and $2::date
		),
		targets as (
			select s.key, s.name, s.rpe, (
				select max(sp.target_rpe) from planned_exercises pe
				join set_prescriptions sp on sp.planned_exercise_id = pe.id
				where pe.session_id = s.planned_session_id and pe.lineage_id = s.planned_exercise_lineage_id
					and sp.role not in ('warm_up', 'ramp')
			) as target
			from sets s
		)
		select key, name, avg(rpe)::float8 as actual, avg(target)::float8 as target,
			avg(rpe - target)::float8 as deviation, count(*)::int as sets
		from targets where target is not null group by key, name order by key`,
		[from, to]
	);
}
