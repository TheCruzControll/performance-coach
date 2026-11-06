/**
 * The athlete profile (name, units, body, nutrition phase), onboarding progress, and the
 * read models the screens and the coach use: the full training profile and a short overview.
 */
import { localDay } from '../../../domain/dates';
import {
	isOnboardingStep,
	nextStep,
	onboardingFraction,
	onboardingSteps,
	resumeStep,
	STEP_INFO,
	type OnboardingProgress,
	type OnboardingStep
} from '../../../domain/profile/onboarding';
import type { Discipline } from '../../../domain/profile/catalog';
import { basicsSchema, bodySchema } from '../../../domain/profile/schemas';
import type {
	AthleteProfile,
	BodyWeightEntry,
	Goal,
	Schedule,
	TrainingProfile
} from '../../../domain/profile/types';
import { createProfileRepository, type ProfileRepository } from '../../db';
import { measure } from '../../observability/timing';
import { listGoals } from './goals';
import {
	getEquipment,
	getExercisePreferences,
	getExperience,
	getInjuries,
	getSchedule,
	getSpecifics
} from './sections';
import {
	parseWith,
	ProfileInputError,
	resolveDeps,
	toBaseline,
	toGoal,
	toProfile,
	type ProfileDeps
} from './shared';

export async function getAthleteProfile(
	ownerId: string,
	deps: ProfileDeps = {}
): Promise<AthleteProfile> {
	const { db } = resolveDeps(deps);
	const row = await measure('db', () => createProfileRepository(db).ensureProfile(ownerId));
	return toProfile(row);
}

/** Name, units and time zone (onboarding's first step; Profile → Body & units). */
export async function saveBasics(
	ownerId: string,
	input: unknown,
	deps: ProfileDeps = {}
): Promise<AthleteProfile> {
	const basics = parseWith(basicsSchema, input);
	const { db, now } = resolveDeps(deps);
	return measure('db', async () => {
		const repo = createProfileRepository(db);
		await repo.ensureProfile(ownerId);
		return toProfile((await repo.updateProfile(ownerId, basics, now()))!);
	});
}

function toWeight(row: {
	id: number;
	value: number;
	unit: 'kg' | 'lb';
	measuredOn: string;
	source: string;
}): BodyWeightEntry {
	return {
		id: row.id,
		value: row.value,
		unit: row.unit,
		measuredOn: row.measuredOn,
		source: row.source
	};
}

export async function getBody(ownerId: string, deps: ProfileDeps = {}) {
	const { db } = resolveDeps(deps);
	const repo = createProfileRepository(db);
	const [profile, history] = await measure('db', async () => {
		const p = await repo.ensureProfile(ownerId);
		return [p, await repo.listBodyWeight(ownerId)] as const;
	});
	return { profile: toProfile(profile), bodyWeight: history.map(toWeight) };
}

/**
 * Body weight, nutrition phase and weight target. A body weight is recorded as today's entry
 * in the history (re-saving the same day replaces it); leaving it blank never deletes history.
 * "Today" is the owner's calendar day in their time zone, not the UTC one.
 */
export async function saveBody(ownerId: string, input: unknown, deps: ProfileDeps = {}) {
	const body = parseWith(bodySchema, input);
	const { db, now, source } = resolveDeps(deps);
	await measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			const profile = await repo.ensureProfile(ownerId);
			const at = now();
			const today = localDay(at, profile.timeZone);
			await repo.updateProfile(
				ownerId,
				{
					birthYear: body.birthYear,
					nutritionPhase: body.nutritionPhase,
					targetWeight: body.targetWeight,
					targetWeightUnit: body.targetWeight == null ? null : body.weightUnit,
					targetDate: body.targetDate
				},
				at
			);
			if (body.bodyWeight != null) {
				const [latest] = await repo.listBodyWeight(ownerId, 1);
				const unchanged =
					latest && latest.value === body.bodyWeight && latest.unit === body.weightUnit;
				if (!unchanged || latest.measuredOn === today) {
					await repo.upsertBodyWeightForDay({
						ownerId,
						value: body.bodyWeight,
						unit: body.weightUnit,
						measuredOn: today,
						source,
						createdAt: at
					});
				}
			}
		})
	);
	return getBody(ownerId, deps);
}

// ---- onboarding --------------------------------------------------------------------------------

/** Disciplines the athlete trains (from open goals and experience): decides the steps. */
async function trainedDisciplines(repo: ProfileRepository, ownerId: string) {
	const [goals, experience] = await Promise.all([
		repo.listGoals(ownerId),
		repo.listExperience(ownerId)
	]);
	const set = new Set<Discipline>();
	for (const g of goals) if (g.priority !== null) g.disciplines.forEach((d) => set.add(d));
	for (const e of experience) set.add(e.discipline);
	return set;
}

export interface OnboardingState {
	progress: OnboardingProgress;
	steps: OnboardingStep[];
	resume: OnboardingStep;
	fraction: number;
	complete: boolean;
	disciplines: Discipline[];
}

function onboardingState(profile: AthleteProfile, disciplines: Set<Discipline>): OnboardingState {
	const progress = profile.onboarding;
	const steps = onboardingSteps(disciplines);
	return {
		progress,
		steps,
		resume: resumeStep(progress, steps),
		fraction: onboardingFraction(progress, steps),
		complete: progress.completedAt !== null,
		disciplines: [...disciplines]
	};
}

export async function getOnboarding(
	ownerId: string,
	deps: ProfileDeps = {}
): Promise<OnboardingState> {
	const { db } = resolveDeps(deps);
	const repo = createProfileRepository(db);
	const [profile, disciplines] = await measure('db', () =>
		Promise.all([repo.ensureProfile(ownerId), trainedDisciplines(repo, ownerId)])
	);
	return onboardingState(toProfile(profile), disciplines);
}

/**
 * Record a finished step (`complete` after its save, or `skip` for an optional step) and move
 * the resume point to the next applicable step. Returns that step.
 */
export async function advanceOnboarding(
	ownerId: string,
	input: { step: OnboardingStep; action: 'complete' | 'skip' },
	deps: ProfileDeps = {}
): Promise<OnboardingStep> {
	// The types do not hold at runtime: form posts and coach tool calls arrive untyped.
	if (!isOnboardingStep(input.step)) throw new ProfileInputError({ step: 'Unknown step' });
	if (input.action !== 'complete' && input.action !== 'skip') {
		throw new ProfileInputError({ action: 'Unknown action' });
	}
	if (input.action === 'skip' && !STEP_INFO[input.step].optional) {
		throw new ProfileInputError({ step: 'This step can’t be skipped' });
	}
	const { db, now } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			const profile = await repo.ensureProfile(ownerId);
			const steps = onboardingSteps(await trainedDisciplines(repo, ownerId));
			const next = nextStep(steps, input.step);
			const completed = new Set(profile.onboardingCompleted);
			const skipped = new Set(profile.onboardingSkipped);
			if (input.action === 'complete') {
				completed.add(input.step);
				skipped.delete(input.step);
			} else {
				skipped.add(input.step);
				completed.delete(input.step);
			}
			await repo.updateProfile(
				ownerId,
				{
					onboardingStep: next,
					onboardingCompleted: [...completed],
					onboardingSkipped: [...skipped]
				},
				now()
			);
			return next;
		})
	);
}

/** Remember the step the owner is on (opening a step, or going back to one). */
export async function rememberOnboardingStep(
	ownerId: string,
	step: OnboardingStep,
	deps: ProfileDeps = {}
): Promise<void> {
	if (!isOnboardingStep(step)) throw new ProfileInputError({ step: 'Unknown step' });
	const { db, now } = resolveDeps(deps);
	await measure('db', async () => {
		const repo = createProfileRepository(db);
		const profile = await repo.ensureProfile(ownerId);
		if (profile.onboardingStep !== step && !profile.onboardingCompletedAt) {
			await repo.updateProfile(ownerId, { onboardingStep: step }, now());
		}
	});
}

/**
 * Finish onboarding from the review step. A plan needs at least one open goal and a schedule;
 * everything else may stay blank (1RMs included).
 */
export async function completeOnboarding(ownerId: string, deps: ProfileDeps = {}) {
	const { db, now } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProfileRepository(tx);
			const profile = await repo.ensureProfile(ownerId);
			const [goals, schedule] = await Promise.all([
				repo.listGoals(ownerId),
				repo.getSchedule(ownerId)
			]);
			const errors: Record<string, string> = {};
			if (!goals.some((g) => g.priority !== null)) errors.goals = 'Add at least one goal';
			if (!schedule?.daysPerWeek) errors.schedule = 'Tell your coach how many days you can train';
			if (Object.keys(errors).length) throw new ProfileInputError(errors);
			const at = now();
			const completed = new Set(profile.onboardingCompleted);
			completed.add('review');
			await repo.updateProfile(
				ownerId,
				{
					onboardingStep: 'review',
					onboardingCompleted: [...completed],
					onboardingCompletedAt: profile.onboardingCompletedAt ?? at
				},
				at
			);
			return profile.onboardingCompletedAt ?? at;
		})
	);
}

// ---- read models -------------------------------------------------------------------------------

/** Everything the coach knows about the athlete. */
export async function getTrainingProfile(
	ownerId: string,
	deps: ProfileDeps = {}
): Promise<TrainingProfile> {
	const { db } = resolveDeps(deps);
	const repo = createProfileRepository(db);
	const profileRow = await measure('db', () => repo.ensureProfile(ownerId));
	const [
		bodyWeight,
		goals,
		experience,
		baselines,
		specifics,
		equipment,
		injuries,
		exercises,
		schedule
	] = await Promise.all([
		measure('db', () => repo.listBodyWeight(ownerId)),
		listGoals(ownerId, deps),
		getExperience(ownerId, deps),
		measure('db', () => repo.listCurrentBaselines(ownerId)),
		getSpecifics(ownerId, deps),
		getEquipment(ownerId, deps),
		getInjuries(ownerId, deps),
		getExercisePreferences(ownerId, deps),
		getSchedule(ownerId, deps)
	]);
	return {
		profile: toProfile(profileRow),
		bodyWeight: bodyWeight.map(toWeight),
		goals,
		experience,
		baselines: baselines.map(toBaseline),
		running: specifics.running,
		muayThai: specifics.muayThai,
		equipment,
		injuries,
		exercises,
		schedule
	};
}

export interface ProfileOverview {
	profile: AthleteProfile;
	onboarding: OnboardingState;
	/** Open goals by rank. */
	goals: Goal[];
	schedule: Schedule;
}

/** What Today and Profile show: onboarding state, ranked goals and the week's shape. */
export async function getProfileOverview(
	ownerId: string,
	deps: ProfileDeps = {}
): Promise<ProfileOverview> {
	const { db } = resolveDeps(deps);
	const repo = createProfileRepository(db);
	const [profileRow, goals, experience, schedule] = await Promise.all([
		measure('db', () => repo.ensureProfile(ownerId)),
		measure('db', () => repo.listGoals(ownerId)),
		measure('db', () => repo.listExperience(ownerId)),
		getSchedule(ownerId, deps)
	]);
	const open = goals.filter((g) => g.priority !== null);
	const disciplines = new Set<Discipline>();
	for (const g of open) g.disciplines.forEach((d) => disciplines.add(d));
	for (const e of experience) disciplines.add(e.discipline);
	const profile = toProfile(profileRow);
	return {
		profile,
		onboarding: onboardingState(profile, disciplines),
		goals: open.map(toGoal),
		schedule
	};
}
