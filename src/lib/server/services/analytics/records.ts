/**
 * The owner's strength records as Progress judges them (PRD §10), for the coach's
 * get_personal_records and get_exercise_history: the best e1RM and the heaviest load at each rep
 * count that one exercise, or every exercise, ever reached, and its PR timeline (e1RM, rep-max,
 * most-reps and session-volume PRs, each with the record it beat).
 *
 * - The same functions on the same facts as the strength dashboard and the exercise detail:
 *   prTimeline, M3's bestE1rm and personalRecords over the sets M4's rules let compete for each
 *   kind (prCandidates), so the coach and Progress never disagree on a PR.
 * - Only completed, undeleted workouts count (the facts loader's rule): a set in an abandoned or
 *   unfinished workout is never a record. M3's history reads (the start kit's prior bests) still
 *   count every live set; the M6 plan records the difference.
 * - Reads run one at a time, so `db` may be a transaction.
 */
import { prTimeline, type StrengthPr } from '../../../domain/analytics/strength';
import type { IsoDate } from '../../../domain/calendar';
import {
	bestE1rm,
	personalRecords,
	type BestE1rm,
	type RepRecord
} from '../../../domain/training/metrics';
import { prCandidates, type PrKind } from '../../../domain/workout/logging';
import type { SetFact } from '../../db/repositories/analytics';
import type { Executor } from '../../db/types';
import { getExercisesByIds } from '../exercises/index';
import { getAthleteProfile } from '../profile/index';
import { createFactsLoader } from './facts';

export interface LiftRecords {
	exerciseId: string;
	name: string;
	/** Always an estimate from one set, never a measured max; null when no set gives one. */
	bestE1rm: BestE1rm<SetFact> | null;
	/** Lightest rep count first, from 1 to PR_MAX_REPS. */
	repMaxes: RepRecord<SetFact>[];
	/** Every PR, newest session first. */
	prs: StrengthPr[];
}

/**
 * The records of `exerciseId`, or of every exercise with a counted set, by name. Each reads every
 * counted set of the lift since the owner's first activity, as the dashboards judge records.
 */
export async function getStrengthRecords(
	db: Executor,
	ownerId: string,
	{ today, exerciseId }: { today: IsoDate; exerciseId?: string }
): Promise<LiftRecords[]> {
	const { timeZone } = await getAthleteProfile(ownerId, { db });
	const first = await createFactsLoader(db, ownerId, {
		from: today,
		to: today,
		timeZone
	}).firstActivity();
	if (first === null || first > today) return [];
	const all = await createFactsLoader(db, ownerId, { from: first, to: today, timeZone }).sets();
	const sets = exerciseId === undefined ? all : all.filter((set) => set.exercise === exerciseId);
	const exercises = await getExercisesByIds(ownerId, [...new Set(sets.map((s) => s.exercise))], {
		db
	});
	return [...Map.groupBy(sets, (set) => set.exercise)]
		.flatMap(([id, own]): LiftRecords[] => {
			const lift = exercises.get(id);
			if (!lift) return [];
			const competing = (kind: PrKind) =>
				own.filter((set) => set.deletedAt === null && prCandidates(set, lift).includes(kind));
			const records = {
				exerciseId: id,
				name: lift.name,
				bestE1rm: bestE1rm(competing('e1rm')),
				repMaxes: personalRecords(competing('rep_max')).sort((a, b) => a.reps - b.reps),
				// Newest session first, each session's PRs in prTimeline's order, as the dashboard lists them.
				prs: prTimeline(own, lift, timeZone).sort((a, b) =>
					a.on === b.on ? 0 : a.on < b.on ? 1 : -1
				)
			};
			return records.bestE1rm || records.repMaxes.length || records.prs.length ? [records] : [];
		})
		.sort((a, b) => a.name.localeCompare(b.name) || a.exerciseId.localeCompare(b.exerciseId));
}
