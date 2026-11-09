/**
 * Logged sessions as the load model reads them (M7's load model in the periodisation engine ADR):
 * M6's facts (completed, undeleted workouts with their sets, runs and other-session records) turned
 * into load/systems.ts's LoadSession, so a logged day costs each system what Progress and the
 * weekly review count.
 *
 * - The basis is M6's sessionLoads for the same workout: its minutes, its RPE (the workout's,
 *   else its run's, else its other record's) and its owner's calendar day. A workout M6 calls
 *   'load unknown' keeps a null RPE or duration, so systemLoads names it unknown too.
 * - A strength workout's region split counts its live working sets by M3's hard-set rule; a set
 *   is heavy, as a planned line is, at RPE 8 or more on a compound lift (a logged set records no
 *   percentage of a 1RM).
 * - The facts are already M6's: the facts loader reads completed, undeleted workouts only. A
 *   deleted set is left out here as well, since M6's strength facts carry it.
 *
 * Pure. Server-only, like all of domain/programming.
 */
import { ROUND_KEYS, sessionLoads } from '../../analytics/workload.ts';
import type { RunFact } from '../../analytics/running.ts';
import type { StrengthFact } from '../../analytics/strength.ts';
import type { CustomMetric } from '../../training/types.ts';
import { isWorking } from '../../workout/logging.ts';
import {
	catalogueTraits,
	hardSetsIn,
	INTERFERENCE,
	isHeavySet,
	regionOf
} from '../interference.ts';
import type { Region, TraitsOf } from '../interference.ts';
import type { ReviewWorkout } from '../review/weekly.ts';
import type { LoadSession, RegionSets } from './systems.ts';

/** A logged session, with the workout it came from and the planned session it was logged against. */
export type LoggedLoad = LoadSession & {
	source: 'logged';
	workoutId: string;
	plannedLineage: string | null;
};

/** M6's facts for the workouts to read: what its facts loader gives. */
export interface LoggedFacts {
	workouts: readonly ReviewWorkout[];
	sets: readonly StrengthFact[];
	runs: readonly RunFact[];
	/** The profile's time zone: a session's day is the owner's calendar day, as M6 counts it. */
	timeZone: string;
}

/** The live working sets of one workout, by region, through the planned-line rules. */
function setsOf(sets: readonly StrengthFact[], traitsOf: TraitsOf) {
	const out: Record<Region, RegionSets> = {
		lower: { hard: 0, heavy: 0 },
		upper: { hard: 0, heavy: 0 }
	};
	for (const set of sets) {
		if (set.deletedAt !== null) continue;
		const traits = traitsOf({ key: set.exercise });
		const region = traits ? regionOf(traits) : null;
		if (!traits || !region) continue;
		const line = {
			role: isWorking(set) ? 'working' : 'warm_up',
			sets: 1,
			targetRpe: set.rpe,
			loadKind: 'rpe_based',
			loadValue: null
		} as const;
		const hard = hardSetsIn(line);
		out[region].hard += hard;
		const compound = traits.tags.some((tag) => INTERFERENCE.heavyLiftTags.includes(tag));
		if (compound && isHeavySet(line)) out[region].heavy += hard;
	}
	return out;
}

const roundsOf = (metrics: readonly CustomMetric[]) => {
	const counts = metrics.flatMap(({ key, value }) =>
		(ROUND_KEYS as readonly string[]).includes(key) && typeof value === 'number' ? [value] : []
	);
	return counts.length ? counts.reduce((sum, n) => sum + n, 0) : null;
};

/**
 * Each workout as a logged LoadSession, in the order given, numbered within its day by start
 * time. `traitsOf` reads an exercise's traits by its key: the catalogue's by default.
 */
export function fromLogged(facts: LoggedFacts, traitsOf: TraitsOf = catalogueTraits): LoggedLoad[] {
	const m6 = sessionLoads(facts.workouts, facts.timeZone);
	const setsBy = Map.groupBy(facts.sets, (set) => set.workoutId);
	const runBy = new Map(facts.runs.map((run) => [run.workout, run]));
	return facts.workouts.map((workout, n) => {
		const { date, minutes, rpe } = m6[n]!;
		const orderInDay =
			1 +
			facts.workouts.filter(
				(other, i) =>
					m6[i]!.date === date &&
					(other.startedAt < workout.startedAt ||
						(+other.startedAt === +workout.startedAt && i < n))
			).length;
		const base = {
			date,
			timeOfDay: null,
			orderInDay,
			type: workout.sessionType,
			title: workout.title,
			discipline: workout.discipline,
			intensity: null,
			minutes,
			rpe,
			source: 'logged' as const,
			workoutId: workout.id,
			plannedLineage: workout.plannedLineage
		};
		const run = runBy.get(workout.id);
		if (workout.run || run) {
			const kinds = (run?.segments ?? []).map((segment) => segment.kind);
			return {
				...base,
				kind: 'run',
				metres: run?.metres ?? null,
				intervals:
					INTERFERENCE.intervalTypes.includes(workout.sessionType) ||
					kinds.some((kind) => INTERFERENCE.intervalSegments.includes(kind)),
				long:
					INTERFERENCE.longRunTypes.includes(workout.sessionType) ||
					(minutes ?? 0) >= INTERFERENCE.longRunMinutes
			};
		}
		if (workout.other) {
			const { kind, metrics } = workout.other;
			return { ...base, kind: 'other', format: kind, rounds: roundsOf(metrics) };
		}
		return { ...base, kind: 'strength', sets: setsOf(setsBy.get(workout.id) ?? [], traitsOf) };
	});
}
