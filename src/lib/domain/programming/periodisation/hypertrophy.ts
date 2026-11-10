/**
 * Hypertrophy blocks as week plans (m7-plan hypertrophy-blocks; PRD §5): building weeks whose
 * hard sets per major muscle group rise inside the split's band, then a deload. Each week is a
 * skeleton, its kind (kinds.ts BLOCK_WEEK_KINDS.hypertrophy), its phase and its targets, from
 * rules/hypertrophy.ts; setsPerGroup is the week's own range, so M6 can judge the week by it. The
 * generator fills in dates and sessions. Pure and deterministic.
 */
import type { ExperienceLevel, NutritionPhase } from '../../profile/catalog.ts';
import type { WeekTargets } from '../../training/types.ts';
import { MUSCLE_GROUP } from '../../training/vocabulary.ts';
import type { ExerciseTag, Muscle, MuscleGroup, WeekKind } from '../../training/vocabulary.ts';
import { HYPERTROPHY } from '../rules/hypertrophy.ts';
import type { HypertrophyExerciseKind } from '../rules/hypertrophy.ts';
import { isAccessory } from '../rules/strength.ts';
import { MAJOR_GROUPS, PHASES } from '../rules/volume.ts';
import { BLOCK_WEEK_KINDS } from './kinds.ts';

/** One week of a hypertrophy block, before it has dates and sessions. */
export interface HypertrophyWeek {
	kind: WeekKind;
	phase: 'hypertrophy';
	targets: WeekTargets & {
		mainLifts: NonNullable<WeekTargets['mainLifts']>;
		setsPerGroup: NonNullable<WeekTargets['setsPerGroup']>;
	};
}

/** The split's weekly hard-set band per major group: volume.ts hardSetBand's `sets`. */
export interface HardSetBand {
	sets: readonly [low: number, high: number];
}

const { step: STEP, deload: DELOAD, rpe: RPE, block: BLOCK } = HYPERTROPHY;
const [COMPOUND_MIN, COMPOUND_MAX] = HYPERTROPHY.reps.compound;
const hundredths = (n: number) => Math.round(n * 100) / 100;

function checkWeeks(weeks: number): void {
	const [fewest, most] = BLOCK.building;
	if (!Number.isInteger(weeks) || weeks < fewest || weeks > most) {
		throw new RangeError(`A hypertrophy block has ${fewest} to ${most} building weeks`);
	}
}

/**
 * Each building week's floor of hard sets per group: from the band's low end (`keep` of it on a
 * cut), up by the level's step (the top step on a bulk), never by more than a fifth of the week
 * before, and never so high that the week's range would pass the ceiling.
 */
function floors(
	band: HardSetBand,
	weeks: number,
	level: ExperienceLevel,
	phase: NutritionPhase | null
) {
	const { keep, toward } = (phase && PHASES[phase]) || { keep: 1, toward: 0 };
	const low = Math.ceil(keep * band.sets[0]);
	const ceiling = Math.max(low, Math.floor(keep * band.sets[1]));
	const width = Math.min(STEP.width, ceiling - low);
	const step = toward > 0 ? STEP.climb : STEP.sets[level];
	const out = [low];
	for (let i = 1; i < weeks; i++) {
		const before = out[i - 1]!;
		const rise = Math.min(step, Math.floor(before * STEP.maxShare));
		out.push(Math.min(before + rise, ceiling - width));
	}
	return { floors: out, width };
}

/** The top set's RPE in building week `i` of `weeks`: the ramp spread evenly over the block. */
const topRpeOf = (i: number, weeks: number) =>
	RPE.ramp[Math.round((i * (RPE.ramp.length - 1)) / (weeks - 1))]!;

/**
 * A hypertrophy block at `level` in `nutritionPhase`: `weeks` building weeks (kind accumulation)
 * whose hard sets per major group rise inside `band`, then a deload at 0.6 of the first week.
 * `band` is the style's band, before the nutrition phase moves it: a cut keeps `keep` of it here,
 * from rules/volume.ts PHASES, the constant hardSetBand reads. Throws a RangeError for a block of
 * fewer or more building weeks than HYPERTROPHY.block allows.
 */
export function hypertrophyWeeks(
	band: HardSetBand,
	weeks: number,
	level: ExperienceLevel,
	nutritionPhase: NutritionPhase | null
): HypertrophyWeek[] {
	checkWeeks(weeks);
	const { floors: mins, width } = floors(band, weeks, level, nutritionPhase);
	const first = mins[0]!;
	const building = mins.map((min, i): HypertrophyWeek => {
		const topRpe = topRpeOf(i, weeks);
		const setsFactor = hundredths(min / first);
		return {
			kind: BLOCK_WEEK_KINDS.hypertrophy.building,
			phase: 'hypertrophy',
			targets: {
				rpeCap: topRpe + RPE.isolationLastSet,
				volumeFactor: setsFactor,
				loadStep: RPE.loadStep,
				runVolumeFactor: 1,
				mainLifts: { repsMin: COMPOUND_MIN, repsMax: COMPOUND_MAX, topRpe, setsFactor },
				setsPerGroup: { min, max: min + width, step: i ? min - mins[i - 1]! : 0 }
			}
		};
	});
	const deload: HypertrophyWeek = {
		kind: BLOCK_WEEK_KINDS.hypertrophy.deload,
		phase: 'hypertrophy',
		targets: {
			rpeCap: DELOAD.rpe,
			volumeFactor: DELOAD.share,
			loadStep: DELOAD.loadStep,
			runVolumeFactor: DELOAD.runVolumeFactor,
			mainLifts: {
				repsMin: COMPOUND_MIN,
				repsMax: COMPOUND_MAX,
				topRpe: DELOAD.rpe,
				setsFactor: DELOAD.share
			},
			setsPerGroup: {
				min: Math.floor(DELOAD.share * first),
				max: Math.floor(DELOAD.share * (first + width)),
				step: 0
			}
		}
	};
	return [...building, deload];
}

const MAJOR = new Set<MuscleGroup>(Object.keys(MAJOR_GROUPS) as MuscleGroup[]);

/**
 * An exercise's kind in a hypertrophy block: compound (rules/strength.ts isAccessory's opposite),
 * an isolation for a small muscle (every primary muscle outside MAJOR_GROUPS: arms, calves, core,
 * forearms, neck), or an isolation.
 */
export function hypertrophyKindOf(exercise: {
	tags: readonly ExerciseTag[];
	primaryMuscles: readonly Muscle[];
}): HypertrophyExerciseKind {
	if (!isAccessory(exercise)) return 'compound';
	return exercise.primaryMuscles.every((m) => !MAJOR.has(MUSCLE_GROUP[m])) ? 'small' : 'isolation';
}

/** An exercise's rep range in a hypertrophy block, by its kind. */
export function hypertrophyReps(exercise: Parameters<typeof hypertrophyKindOf>[0]) {
	const [min, max] = HYPERTROPHY.reps[hypertrophyKindOf(exercise)];
	return { min, max };
}
