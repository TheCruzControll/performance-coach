/**
 * The next block's input (PRD §11; M6): M3's ProgrammingInput for today's profile, overlaid with
 * what the reviewed block actually showed, so the next block's loads and running start from actual
 * results rather than the profile's starting values. Every change the overlay makes is recorded.
 *
 * - Baselines: each lift's latest e1RM from logged sets, kind estimated. A measured 1RM in the
 *   profile achieved after that e1RM stays measured; an undated one counts as older. With no e1RM
 *   the profile's value (or null) stays.
 * - Running, when it is trained: weeklyMetres from the mean of the last NEXT_BLOCK_INPUT_RULES
 *   .runWeeks complete weeks' actual distance, longestRunMetres from the last completed long run,
 *   easy pace from the last `easyRuns` easy runs, and each standard distance's best logged effort
 *   added to the races. What the block did not show keeps the profile's value.
 * - Exercises: the directives' kept exercises join the likes, and the rotated ones join the
 *   dislikes for this block (never prescribed). A liked exercise is never rotated, and a disliked
 *   one is never made liked.
 * - Overrides go through clampOverrides; each clamp is recorded, and an overridden running start
 *   replaces the actual one.
 *
 * M3's input carries baselines only for M2's baseline lifts: another kept lift's from_e1rm lines
 * resolve from M4's kit estimate. Pure and server-only at runtime, like all of domain/programming.
 */
import type { IsoDate } from '../../calendar.ts';
import { localDay } from '../../dates.ts';
import type { E1rmPoint, MaxPoint } from '../../analytics/strength.ts';
import type {
	DistanceEfforts,
	RunPace,
	WeekLongRun,
	WeekRunning
} from '../../analytics/running.ts';
import { LIFTS, RUNNING_DISCIPLINES } from '../../profile/catalog.ts';
import type { BaselineLift } from '../../training/types.ts';
import { cleanFloat, roundToIncrement } from '../../units.ts';
import { segmentPace } from '../../workout/run.ts';
import type { ExerciseKey, InputRunning, ProgrammingInput } from '../input.ts';
import { canonicalJson, compareText } from '../random.ts';
import { RUN_RESULT_RULES } from '../rules/results.ts';
import { clampOverrides, DIRECTIVE_RULES } from '../review/directives.ts';
import type { CycleDirectives, NextCycleSubset } from '../review/directives.ts';

// ---- Judgements the owner can change here ----------------------------------------------------

export const NEXT_BLOCK_INPUT_RULES = {
	/** Weekly distance starts from the mean of the last this many complete weeks (the directives'). */
	runWeeks: DIRECTIVE_RULES.runWeeks,
	/** Easy pace is the distance-weighted pace of the last this many easy runs. */
	easyRuns: 5
} as const;

// ---- Types -------------------------------------------------------------------------------------

/** What the block actually showed, as M6's strength and running analytics give it. */
export interface ResultsSnapshot {
	timeZone: string;
	/** Each baseline lift's latest e1RM (strength.ts e1rmSeries' last point of its exercise). */
	e1rms: readonly { lift: BaselineLift; point: Pick<E1rmPoint, 'value' | 'on'> }[];
	/** The profile's 1RMs with the day each was achieved (strength.ts measuredMaxes). */
	maxes: readonly Pick<MaxPoint, 'lift' | 'kind' | 'kg' | 'on'>[];
	/** Null when running is not read. */
	running: {
		/** Complete weeks only, oldest first (running.ts weeklyRunning().weeks). */
		weeks: readonly Pick<WeekRunning, 'weekStart' | 'metres'>[];
		/** Each week's long run, oldest first (running.ts longRuns). */
		longRuns: readonly Pick<WeekLongRun, 'weekStart' | 'run'>[];
		/** Runs' paces (running.ts runPace); only easy runs are read. */
		paces: readonly Pick<
			RunPace,
			'startedAt' | 'sessionType' | 'distanceMetres' | 'durationSeconds' | 'workout'
		>[];
		/** Best efforts by distance (running.ts bestEfforts); reported races are the profile's. */
		efforts: readonly Pick<DistanceEfforts, 'best'>[];
	} | null;
}

/** Why the overlay set a field. */
export const OVERLAY_RULES = [
	'e1rm_baseline',
	'measured_kept',
	'profile_baseline',
	'actual_weekly',
	'last_long_run',
	'easy_pace',
	'best_effort',
	'kept_liked',
	'rotated_excluded',
	'liked_not_rotated',
	'disliked_not_kept',
	'override_clamped'
] as const;
export type OverlayRule = (typeof OVERLAY_RULES)[number];

export interface OverlayAssumption {
	rule: OverlayRule;
	/** `baselines.squat`, `running.weeklyMetres`, `likes`, `targets.rpeCap`… */
	field: string;
	value: number | string | null;
	why: string;
}

export interface NextBlockInput {
	input: ProgrammingInput;
	assumptions: OverlayAssumption[];
	/** The owner's part after clampOverrides: what the generator's targets read. */
	subset: NextCycleSubset;
}

// ---- The overlay -------------------------------------------------------------------------------

const BASELINE_LIFTS = LIFTS.filter((lift): lift is BaselineLift => lift !== 'custom');
const metres = (m: number) => roundToIncrement(m, RUN_RESULT_RULES.roundMetres, 'down') || null;
const km = (m: number) => `${cleanFloat(m / 1000, 1)} km`;

/** The latest of several dated values: the latest day, then the higher value. */
const latest = <T>(list: readonly T[], on: (t: T) => IsoDate | null, value: (t: T) => number) =>
	[...list].sort((a, b) => compareText(on(b) ?? '', on(a) ?? '') || value(b) - value(a))[0] ?? null;

/**
 * `base` (buildProgrammingInput on today's profile) overlaid with `snapshot` and the directives'
 * keep and rotate, `overrides` held to the directives' bounds. The same arguments give the same
 * result, whatever the order of the snapshot's lists.
 */
export function nextBlockInput(
	base: ProgrammingInput,
	snapshot: ResultsSnapshot,
	directives: CycleDirectives,
	overrides: Partial<NextCycleSubset> = {}
): NextBlockInput {
	const assumptions: OverlayAssumption[] = [];
	const note = (rule: OverlayRule, field: string, value: number | string | null, why: string) =>
		assumptions.push({ rule, field, value, why });

	// Baselines: the latest e1RM, unless a measured 1RM is newer.
	const baselines = { ...base.baselines };
	for (const lift of BASELINE_LIFTS) {
		const field = `baselines.${lift}`;
		const e1rm = latest(
			snapshot.e1rms.filter((e) => e.lift === lift),
			(e) => e.point.on,
			(e) => e.point.value
		);
		const measured = latest(
			snapshot.maxes.filter((m) => m.lift === lift && m.kind === 'measured'),
			(m) => m.on,
			(m) => m.kg
		);
		const told = base.baselines[lift];
		if (e1rm && measured?.on && measured.on > e1rm.point.on && told) {
			note('measured_kept', field, told.kg, `Measured on ${measured.on}, after the latest e1RM`);
		} else if (e1rm) {
			const kg = cleanFloat(e1rm.point.value, 1);
			baselines[lift] = { kg, kind: 'estimated' };
			note('e1rm_baseline', field, kg, `Estimated from your sets on ${e1rm.point.on}`);
		} else if (told) {
			note('profile_baseline', field, told.kg, 'No estimate from your sets: your profile’s value');
		}
	}

	// Running, when it is trained: what the block showed, else the profile's.
	const { subset, clamps } = clampOverrides(overrides, directives);
	const trainsRunning = base.disciplines.some((d) => RUNNING_DISCIPLINES.includes(d));
	const actual = snapshot.running;
	let running: InputRunning | null = base.running;
	if (trainsRunning && actual) {
		const R = NEXT_BLOCK_INPUT_RULES;
		const next: InputRunning = running
			? { ...running, races: [...running.races] }
			: {
					weeklyMetres: null,
					runsPerWeek: null,
					longestRunMetres: null,
					easyPaceSecondsPerKm: null,
					races: []
				};
		const recent = actual.weeks
			.toSorted((a, b) => compareText(a.weekStart, b.weekStart))
			.slice(-R.runWeeks);
		const weekly = recent.length
			? metres(recent.reduce((a, w) => a + w.metres, 0) / recent.length)
			: null;
		if (weekly !== null) {
			next.weeklyMetres = weekly;
			note(
				'actual_weekly',
				'running.weeklyMetres',
				weekly,
				`Your mean over the last ${recent.length} complete weeks: ${km(weekly)}`
			);
		}
		const long = actual.longRuns
			.filter((w) => w.run !== null)
			.toSorted((a, b) => compareText(a.weekStart, b.weekStart))
			.at(-1)?.run;
		const longest = long ? metres(long.metres) : null;
		if (long && longest !== null) {
			next.longestRunMetres = longest;
			const on = localDay(long.startedAt, snapshot.timeZone);
			note('last_long_run', 'running.longestRunMetres', longest, `Your last long run, on ${on}`);
		}
		const easy = actual.paces
			.filter((p) => p.sessionType === 'easy_run')
			.toSorted(
				(a, b) => a.startedAt.getTime() - b.startedAt.getTime() || compareText(a.workout, b.workout)
			)
			.slice(-R.easyRuns);
		const pace = easy.length
			? segmentPace(
					{
						distanceMetres: easy.reduce((a, p) => a + p.distanceMetres, 0),
						durationSeconds: easy.reduce((a, p) => a + p.durationSeconds, 0)
					},
					'km'
				)
			: null;
		if (pace !== null) {
			next.easyPaceSecondsPerKm = cleanFloat(pace, 1);
			note(
				'easy_pace',
				'running.easyPaceSecondsPerKm',
				next.easyPaceSecondsPerKm,
				`Your last ${easy.length} easy runs`
			);
		}
		for (const { best } of actual.efforts) {
			if (!best) continue;
			const race = {
				distanceMetres: best.distanceMetres,
				timeSeconds: best.durationSeconds,
				racedOn: best.on instanceof Date ? localDay(best.on, snapshot.timeZone) : best.on
			};
			const known = next.races.some((r) => canonicalJson(r) === canonicalJson(race));
			if (known) continue;
			next.races.push(race);
			note(
				'best_effort',
				'running.races',
				best.distanceMetres,
				`Your best logged effort, on ${race.racedOn}`
			);
		}
		next.races.sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)));
		const told = Object.values(next).some((v) => v !== null && (!Array.isArray(v) || v.length));
		running = told ? next : base.running;
	}
	if (trainsRunning && running && overrides.running !== undefined && subset.running) {
		const { weeklyMetres, longRunMetres } = subset.running;
		if (weeklyMetres !== null) running = { ...running, weeklyMetres };
		if (longRunMetres !== null) running = { ...running, longestRunMetres: longRunMetres };
	}
	for (const { field, asked, used } of clamps) {
		note(
			'override_clamped',
			field,
			used,
			`Asked for ${asked}: held to ${used}, the most this review allows`
		);
	}

	// Exercises: kept ones liked, rotated ones out for the block; the owner's own choices win.
	const likes = new Set<ExerciseKey>(base.likes);
	const dislikes = new Set<ExerciseKey>(base.dislikes);
	for (const { exercise } of directives.keep) {
		if (dislikes.has(exercise))
			note('disliked_not_kept', 'likes', exercise, 'You dislike it: not kept');
		else if (!likes.has(exercise)) {
			likes.add(exercise);
			note('kept_liked', 'likes', exercise, 'Kept from your last block');
		}
	}
	for (const { exercise, reason } of directives.rotate) {
		if (likes.has(exercise))
			note('liked_not_rotated', 'dislikes', exercise, 'You like it: kept, not rotated');
		else if (!dislikes.has(exercise)) {
			dislikes.add(exercise);
			note('rotated_excluded', 'dislikes', exercise, `Rotated out for this block: ${reason}`);
		}
	}

	// A running default the actual distance replaced no longer applies.
	const assumed = base.assumptions.filter(
		(a) => !(a.field === 'running.weeklyMetres' && running?.weeklyMetres != null)
	);
	return {
		input: {
			...base,
			baselines,
			running,
			likes: [...likes].sort(compareText),
			dislikes: [...dislikes].sort(compareText),
			assumptions: assumed
		},
		assumptions,
		subset
	};
}
