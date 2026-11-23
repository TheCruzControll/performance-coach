/**
 * The owner's one weight goal (weight_goals, weight_goal_milestones): set it, edit its milestones,
 * clear it, and set the nutrition phase. A new goal ends the active one, which stays in the
 * history. The profile's target (targetWeight, targetWeightUnit, targetDate) mirrors the active
 * goal. Every write is scoped to the owner and runs in one transaction.
 *
 * The weight services' own source (WeightSource, which includes 'log') records who set a goal;
 * the profile's ChangeSource is not used here.
 */
import type { IsoDate } from '../../../domain/calendar';
import { dailyTrend, trendOn } from '../../../domain/analytics/weight';
import {
	DEFAULT_MILESTONE_STEP,
	directionOf,
	generateMilestones,
	MILESTONES_MAX,
	phaseSuggestion,
	validateMilestones,
	type MilestoneIssue,
	type WeightGoal
} from '../../../domain/analytics/weight-goal';
import { localDay } from '../../../domain/dates';
import {
	BODY_WEIGHT_RANGE,
	NUTRITION_PHASES,
	type NutritionPhase
} from '../../../domain/profile/catalog';
import {
	milestonesSchema,
	weightGoalSchema,
	type FieldErrors
} from '../../../domain/profile/schemas';
import type { AthleteProfile } from '../../../domain/profile/types';
import { cleanFloat, convertWeight, type WeightUnit } from '../../../domain/units';
import {
	createProfileRepository,
	createWeightRepository,
	type AthleteProfileRow,
	type Executor,
	type WeightEntryRow,
	type WeightGoalRow,
	type WeightMilestoneRow
} from '../../db';
import { measure } from '../../observability/timing';
import { parseWith, ProfileInputError, ProfileNotFoundError, toProfile } from '../profile/shared';
import { resolveWeightDeps, type WeightDeps } from './entries';

/** A new goal, and the nutrition phase it suggests: 'cut' for a loss, 'bulk' for a gain. */
export interface WeightGoalResult {
	goal: WeightGoalRow;
	/** Null for a maintain goal, or when the phase already matches the suggestion. */
	phasePrompt: 'cut' | 'bulk' | null;
}

/** The profile's weight target as the body editor saves it: the weight, its unit and its day. */
export interface WeightTarget {
	weight: number;
	unit: WeightUnit;
	/**
	 * The goal-by day. Null for a target with no date: it is written to the profile only, and it
	 * ends the active goal, if there is one (syncWeightTarget).
	 */
	date: IsoDate | null;
}

/** A goal row as the domain reads it. */
function goalOf(row: WeightGoalRow): WeightGoal {
	return {
		unit: row.unit,
		startOn: row.startOn,
		startWeight: row.startWeight,
		targetOn: row.targetOn,
		targetWeight: row.targetWeight
	};
}

/** The input with the unit filled in when the caller left it out or blank: the profile's unit. */
function withUnit(input: unknown, unit: WeightUnit): unknown {
	if (typeof input !== 'object' || input === null) return input;
	const goal = input as Record<string, unknown>;
	const given = goal.unit;
	return given === undefined || given === null || given === '' ? { ...goal, unit } : input;
}

/**
 * The start weight: the trend today, in `unit`. trendOn is null only with no weigh-in up to today,
 * which the caller refuses; a goal has no start without one.
 */
function startWeightOf(rows: WeightEntryRow[], unit: WeightUnit, today: IsoDate): number | null {
	const weighIns = rows.map(({ measuredOn, value, unit: from }) => ({
		measuredOn,
		value,
		unit: from
	}));
	return trendOn(dailyTrend(weighIns, unit), today)?.trend ?? null;
}

/**
 * The body editor shows a target in the profile's unit to one decimal, so a posted target in another
 * unit is only as exact as that display: it is the same weight when it lies within half a display
 * step of the stored one. Compared in the stored unit (`storedUnit`), so no rounding of two
 * converted values can split a target that did not change (78.25 kg reads back as 78.24 kg through
 * lb). The same unit compares exactly.
 */
const HALF_DISPLAY_STEP = 0.05;
function sameWeight(
	stored: number,
	storedUnit: WeightUnit,
	posted: number,
	postedUnit: WeightUnit
): boolean {
	if (storedUnit === postedUnit) return stored === posted;
	const tolerance = convertWeight(HALF_DISPLAY_STEP, postedUnit, storedUnit);
	return Math.abs(stored - convertWeight(posted, postedUnit, storedUnit)) <= tolerance + 1e-9;
}

/** Whether the active goal already holds this target: the same day and the same weight. */
function sameGoalTarget(goal: WeightGoalRow, target: WeightTarget): boolean {
	return (
		goal.targetOn === target.date &&
		sameWeight(goal.targetWeight, goal.unit, target.weight, target.unit)
	);
}

/** Whether the profile already holds this target as its own stored target (no goal needed). */
function profileHolds(profile: AthleteProfileRow, target: WeightTarget): boolean {
	return (
		profile.targetDate === target.date &&
		profile.targetWeight !== null &&
		profile.targetWeightUnit !== null &&
		sameWeight(profile.targetWeight, profile.targetWeightUnit, target.weight, target.unit)
	);
}

/** The target a goal sets on the profile: its own weight, unit and day. */
function targetOf(goal: WeightGoalRow): WeightTarget {
	return { weight: goal.targetWeight, unit: goal.unit, date: goal.targetOn };
}

/**
 * A goal's refusal under the body form's field names: the goal-by day is `targetDate`, and the
 * milestone step (the body has none) is `targetWeight`. Anything else is kept as it is.
 */
function asBodyErrors(err: unknown): unknown {
	if (!(err instanceof ProfileInputError)) return err;
	const errors: FieldErrors = {};
	for (const [key, message] of Object.entries(err.errors)) {
		const field = key === 'targetOn' ? 'targetDate' : key === 'step' ? 'targetWeight' : key;
		errors[field] ??= message;
	}
	return new ProfileInputError(errors);
}

/** The milestone a day and weight name, for comparing rows. */
const keyOf = (day: IsoDate, weight: number) => `${day}|${cleanFloat(weight, 2)}`;

/** The domain's milestone problems as field errors, keyed the way the forms show them. */
function milestoneErrors(issues: MilestoneIssue[], unit: WeightUnit): FieldErrors {
	const [min, max] = BODY_WEIGHT_RANGE[unit]!;
	const errors: FieldErrors = {};
	for (const { index, problem } of issues) {
		const row = index === null ? 'milestones' : `milestones.${index}`;
		const [key, message] =
			problem === 'outside_goal'
				? [`${row}.day`, 'Pick a day between the start and the goal day']
				: problem === 'same_day'
					? [`${row}.day`, 'That day already has a milestone']
					: problem === 'weight_out_of_range'
						? [`${row}.weight`, `Between ${min} and ${max} ${unit}`]
						: ['milestones', `Up to ${MILESTONES_MAX} milestones`];
		errors[key] ??= message;
	}
	return errors;
}

/**
 * Set the owner's goal: the target, its goal-by day and (optionally) the unit and the weight
 * between milestones. The start is today, at the trend today (else the latest weigh-in), in the
 * goal's unit (the profile's, when left out). The goal-by day must be after today. The milestones
 * are generated at the step (the unit's default when left out). The active goal, if any, ends as
 * 'replaced'. The profile's target is set to this goal. Nothing else changes, the phase included.
 * The owner's profile row is locked first, so two goal writes run one after the other.
 */
export async function setWeightGoal(
	ownerId: string,
	input: unknown,
	deps: WeightDeps = {}
): Promise<WeightGoalResult> {
	const { db, now, source } = resolveWeightDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const at = now();
			const profiles = createProfileRepository(tx);
			const repo = createWeightRepository(tx);
			const profile = await profiles.ensureProfile(ownerId);
			await profiles.lockProfile(ownerId);
			const today = localDay(at, profile.timeZone);
			const parsed = parseWith(weightGoalSchema, withUnit(input, profile.weightUnit));
			if (parsed.targetOn <= today) {
				throw new ProfileInputError({ targetOn: 'Pick a day after today' });
			}
			const { unit } = parsed;
			const rows = await repo.listRange(ownerId, null, today);
			const startWeight = startWeightOf(rows, unit, today);
			if (startWeight === null) {
				throw new ProfileInputError({
					targetWeight: 'Log your weight first, so the goal has a start'
				});
			}
			const goal: WeightGoal = {
				unit,
				startOn: today,
				startWeight,
				targetOn: parsed.targetOn,
				targetWeight: parsed.targetWeight
			};
			const made = generateMilestones(goal, {
				kind: 'weight',
				step: parsed.step ?? DEFAULT_MILESTONE_STEP[unit]
			});
			if (!made.ok) {
				throw new ProfileInputError({
					step: `More than ${MILESTONES_MAX} milestones at this step: pick a larger one`
				});
			}
			await repo.endActiveGoal(ownerId, 'replaced', at);
			const row = await repo.insertGoal({
				ownerId,
				unit,
				startOn: today,
				startWeight,
				targetOn: parsed.targetOn,
				targetWeight: parsed.targetWeight,
				source,
				createdAt: at,
				updatedAt: at
			});
			await repo.replaceMilestones(
				ownerId,
				row.id,
				made.milestones.map(({ day, weight }) => ({ onDate: day, weight, source: 'generated' })),
				at
			);
			await profiles.updateProfile(
				ownerId,
				{ targetWeight: row.targetWeight, targetWeightUnit: row.unit, targetDate: row.targetOn },
				at
			);
			return {
				goal: row,
				phasePrompt: phaseSuggestion(directionOf(goal), profile.nutritionPhase)
			};
		})
	);
}

/**
 * Replace the active goal's milestones with `input`'s list, in the goal's unit. Every day must fall
 * strictly between the goal's start and goal-by day, days are unique and the weights are in range
 * (validateMilestones). A milestone is 'generated' when it is one the goal already had as
 * generated, or the default step gives for its day and weight; otherwise 'edited'. The goal must be
 * the active one, or ProfileNotFoundError. The profile row is locked, then the goal is read FOR
 * UPDATE, so an edit that waited behind a clear or a new goal finds the goal ended and writes nothing.
 */
export async function editMilestones(
	ownerId: string,
	goalId: string,
	input: unknown,
	deps: WeightDeps = {}
): Promise<WeightMilestoneRow[]> {
	const { db, now } = resolveWeightDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			await createProfileRepository(tx).lockProfile(ownerId);
			const repo = createWeightRepository(tx);
			const active = await repo.getActiveGoal(ownerId, { forUpdate: true });
			if (!active || active.id !== goalId) throw new ProfileNotFoundError('Weight goal');
			const parsed = parseWith(milestonesSchema, input);
			const goal = goalOf(active);
			const issues = validateMilestones(goal, parsed.milestones);
			if (issues.length > 0) throw new ProfileInputError(milestoneErrors(issues, goal.unit));

			const stored = await repo.listMilestones(ownerId, goalId);
			const generated = new Set(
				stored.filter((m) => m.source === 'generated').map((m) => keyOf(m.onDate, m.weight))
			);
			const fromDefault = generateMilestones(goal, {
				kind: 'weight',
				step: DEFAULT_MILESTONE_STEP[goal.unit]
			});
			if (fromDefault.ok) {
				for (const m of fromDefault.milestones) generated.add(keyOf(m.day, m.weight));
			}
			const rows = [...parsed.milestones]
				.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
				.map(({ day, weight }) => ({
					onDate: day,
					weight,
					source: generated.has(keyOf(day, weight)) ? ('generated' as const) : ('edited' as const)
				}));
			const saved = await repo.replaceMilestones(ownerId, goalId, rows, now());
			if (!saved) throw new ProfileNotFoundError('Weight goal');
			return saved;
		})
	);
}

/**
 * End the owner's active goal as 'cleared' (it stays in the history) and clear the profile's
 * target. Returns the goal that ended, or null when there was none. The profile target is cleared
 * either way. The profile row is locked first, like every goal write.
 */
export async function clearWeightGoal(
	ownerId: string,
	deps: WeightDeps = {}
): Promise<WeightGoalRow | null> {
	const { db, now } = resolveWeightDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const at = now();
			const profiles = createProfileRepository(tx);
			await profiles.ensureProfile(ownerId);
			await profiles.lockProfile(ownerId);
			const ended = await createWeightRepository(tx).endActiveGoal(ownerId, 'cleared', at);
			await profiles.updateProfile(
				ownerId,
				{ targetWeight: null, targetWeightUnit: null, targetDate: null },
				at
			);
			return ended;
		})
	);
}

/**
 * The nutrition phase (nutrition_phase only; null clears it). Setting it changes nothing else and
 * adds no re-plan: a program change still goes through the proposal the owner accepts.
 */
export async function setNutritionPhase(
	ownerId: string,
	phase: unknown,
	deps: WeightDeps = {}
): Promise<AthleteProfile> {
	if (phase !== null && !(NUTRITION_PHASES as readonly unknown[]).includes(phase)) {
		throw new ProfileInputError({ nutritionPhase: 'Pick a phase' });
	}
	const { db, now } = resolveWeightDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const profiles = createProfileRepository(tx);
			await profiles.ensureProfile(ownerId);
			const row = await profiles.updateProfile(
				ownerId,
				{ nutritionPhase: phase as NutritionPhase | null },
				now()
			);
			return toProfile(row!);
		})
	);
}

/**
 * The profile's weight target, as the body editor saves it. The profile and the active goal never
 * disagree after it runs:
 * - No target weight (null) clears the target: the goal, if any, ends as 'cleared' and the
 *   profile's three target fields are null. A body save with no target weight but a date clears
 *   the date too, and saveBody passes null here, so the day it was sent with is dropped with it.
 * - A target with a day, when the active goal already holds it (same day, same weight to the
 *   editor's precision), keeps the goal and writes the goal's own weight, unit and day to the
 *   profile. Otherwise it sets a new goal (setWeightGoal), from the caller's source at today's
 *   trend. Its refusals come back under the body form's fields (targetDate, targetWeight).
 * - With no active goal, a target the profile already holds is left as it is: no goal is made
 *   from a target that was on the profile before any goal existed. Any other dated target sets a
 *   goal, as above.
 * - A target with no day stays on the profile only. The active goal, if any, ends as 'cleared'
 *   (an undated target cannot be a goal), and the profile takes the target as given.
 * The owner's profile row is locked before the goal is read, like every goal write.
 */
export async function syncWeightTarget(
	ownerId: string,
	target: WeightTarget | null,
	deps: WeightDeps = {}
): Promise<void> {
	const { db, now } = resolveWeightDeps(deps);
	await measure('db', () =>
		db.transaction(async (tx) => {
			const at = now();
			const scoped = { ...deps, db: tx, now: () => at };
			if (target === null) {
				await clearWeightGoal(ownerId, scoped);
				return;
			}
			const profiles = createProfileRepository(tx);
			const profile = await profiles.ensureProfile(ownerId);
			await profiles.lockProfile(ownerId);
			const repo = createWeightRepository(tx);
			const active = await repo.getActiveGoal(ownerId);
			if (target.date === null) {
				await repo.endActiveGoal(ownerId, 'cleared', at);
				await writeProfileTarget(tx, ownerId, target, at);
				return;
			}
			if (active) {
				if (sameGoalTarget(active, target)) {
					await writeProfileTarget(tx, ownerId, targetOf(active), at);
					return;
				}
			} else if (profileHolds(profile, target)) {
				return;
			}
			try {
				await setWeightGoal(
					ownerId,
					{ unit: target.unit, targetWeight: target.weight, targetOn: target.date },
					scoped
				);
			} catch (err) {
				throw asBodyErrors(err);
			}
		})
	);
}

/** The profile's target columns as given: the weight in its unit, and the day (null for none). */
async function writeProfileTarget(
	db: Executor,
	ownerId: string,
	target: WeightTarget,
	at: Date
): Promise<void> {
	const profiles = createProfileRepository(db);
	await profiles.ensureProfile(ownerId);
	await profiles.updateProfile(
		ownerId,
		{ targetWeight: target.weight, targetWeightUnit: target.unit, targetDate: target.date },
		at
	);
}
