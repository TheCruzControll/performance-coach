/**
 * One exercise's figures recomputed in SQL, for e2e/progress-exercise.serial.e2e.ts. No app code:
 * the definition is written out here, as in the other oracle files.
 *
 * - Only live sets of completed, undeleted workouts count.
 * - Days are the owner's local day of performed_at (athlete_profiles.time_zone).
 */
import { query } from '../support';

/** The highest stored e1rm_kg of `key`'s sets between `from` and `to` inclusive; null with none. */
export async function bestE1rmBetween(
	key: string,
	from: string,
	to: string
): Promise<number | null> {
	const [row] = await query<{ best: number | null }>(
		`select max(s.e1rm_kg)::float8 as best
		from set_records s
		join workouts w on w.id = s.workout_id
		join exercises e on e.id = s.exercise_id
		join athlete_profiles p on p.owner_id = s.owner_id
		where w.status = 'completed' and w.deleted_at is null and s.deleted_at is null
			and e.key = $1
			and (s.performed_at at time zone p.time_zone)::date between $2::date and $3::date`,
		[key, from, to]
	);
	return row?.best ?? null;
}
