/**
 * Best efforts and reported races recomputed in SQL, for the Running view's spec. No app code:
 * each definition is written out here, and a new figure gets a new file, never an edit.
 *
 * - A best effort is the fastest run (by pace, the earliest of equals) of a completed, undeleted
 *   workout whose distance is within ±2 % of 5 km, 10 km, the half or the marathon, edges
 *   included, run on a local day between `from` and `to`.
 * - A reported race is M2's race_results row at one of those distances, dated between them.
 */
import { query } from '../support';

export interface OracleEffort {
	distance: string;
	source: 'best_effort' | 'reported';
	seconds: number;
	day: string | null;
	eventName: string | null;
}

const DISTANCES = `(values ('5k', 5000.0), ('10k', 10000.0), ('half_marathon', 21097.5),
	('marathon', 42195.0)) as d(distance, metres)`;

export async function effortsBetween(from: string, to: string): Promise<OracleEffort[]> {
	const best = await query<OracleEffort>(
		`select d.distance, 'best_effort' as source, b.duration_s::int as seconds,
			to_char(b.day, 'YYYY-MM-DD') as day, null as "eventName"
		from ${DISTANCES}
		join lateral (
			select r.duration_s, (w.started_at at time zone p.time_zone)::date as day
			from workouts w
			join run_records r on r.workout_id = w.id
			join athlete_profiles p on p.owner_id = w.owner_id
			where w.status = 'completed' and w.deleted_at is null
				and r.duration_s is not null
				and abs(r.distance_m - d.metres) <= d.metres * 0.02
				and (w.started_at at time zone p.time_zone)::date between $1::date and $2::date
			order by r.duration_s / r.distance_m, w.started_at limit 1
		) b on true
		order by d.metres`,
		[from, to]
	);
	const reported = await query<OracleEffort>(
		`select distance, 'reported' as source, time_seconds as seconds,
			to_char(raced_on, 'YYYY-MM-DD') as day, event_name as "eventName"
		from race_results
		where distance in ('5k', '10k', 'half_marathon', 'marathon')
			and raced_on between $1::date and $2::date
		order by raced_on`,
		[from, to]
	);
	return [...best, ...reported];
}
