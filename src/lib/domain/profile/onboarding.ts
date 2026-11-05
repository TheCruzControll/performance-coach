/**
 * The onboarding flow (PRD §2, §3): its steps, which of them apply, and where to resume.
 * Pure: the server stores progress, the UI renders it, both use these rules.
 */
import { RUNNING_DISCIPLINES, type Discipline } from './catalog';

export const ONBOARDING_STEPS = [
	'welcome',
	'goals',
	'experience',
	'strength',
	'specifics',
	'equipment',
	'injuries',
	'exercises',
	'schedule',
	'body',
	'review'
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface StepInfo {
	title: string;
	/** Short label for the progress indicator and the review screen. */
	short: string;
	/** Optional steps can be skipped; the coach treats them as "not told yet". */
	optional: boolean;
}

export const STEP_INFO: Record<OnboardingStep, StepInfo> = {
	welcome: { title: 'Welcome', short: 'You', optional: false },
	goals: { title: 'Your goals', short: 'Goals', optional: false },
	experience: { title: 'Experience', short: 'Experience', optional: false },
	strength: { title: 'Strength baselines', short: 'Strength', optional: true },
	specifics: { title: 'Running & Muay Thai', short: 'Specifics', optional: true },
	equipment: { title: 'Equipment', short: 'Equipment', optional: true },
	injuries: { title: 'Injuries & limits', short: 'Injuries', optional: true },
	exercises: { title: 'Exercise preferences', short: 'Exercises', optional: true },
	schedule: { title: 'Schedule', short: 'Schedule', optional: false },
	body: { title: 'Body & nutrition', short: 'Body', optional: true },
	review: { title: 'Review', short: 'Review', optional: false }
};

/** True when the running or Muay Thai specifics apply to these disciplines. */
export function needsSpecifics(disciplines: Iterable<Discipline>): boolean {
	for (const d of disciplines)
		if (d === 'muay_thai' || RUNNING_DISCIPLINES.includes(d)) return true;
	return false;
}

/** The steps that apply, in order (the specifics step only with running or Muay Thai). */
export function onboardingSteps(disciplines: Iterable<Discipline>): OnboardingStep[] {
	const specifics = needsSpecifics(disciplines);
	return ONBOARDING_STEPS.filter((step) => step !== 'specifics' || specifics);
}

export function isOnboardingStep(value: unknown): value is OnboardingStep {
	return typeof value === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

/** The step after `step` among `steps` (review is last). */
export function nextStep(steps: readonly OnboardingStep[], step: OnboardingStep): OnboardingStep {
	const i = steps.indexOf(step);
	if (i === -1) {
		// A step that no longer applies (e.g. specifics after the last runner goal went):
		// continue with the first applicable step after it in the full order.
		const after = ONBOARDING_STEPS.slice(ONBOARDING_STEPS.indexOf(step) + 1);
		return after.find((s) => steps.includes(s)) ?? 'review';
	}
	return steps[Math.min(i + 1, steps.length - 1)]!;
}

export function previousStep(
	steps: readonly OnboardingStep[],
	step: OnboardingStep
): OnboardingStep | null {
	const i = steps.indexOf(step);
	if (i === -1) {
		const before = ONBOARDING_STEPS.slice(0, ONBOARDING_STEPS.indexOf(step)).reverse();
		return before.find((s) => steps.includes(s)) ?? null;
	}
	return i > 0 ? steps[i - 1]! : null;
}

export interface OnboardingProgress {
	/** The step to resume at (null before the owner started). */
	current: OnboardingStep | null;
	completed: OnboardingStep[];
	skipped: OnboardingStep[];
	completedAt: Date | null;
}

/** Where "Continue setting up" goes: the stored step if it still applies, else the next one. */
export function resumeStep(
	progress: OnboardingProgress,
	steps: readonly OnboardingStep[]
): OnboardingStep {
	if (!progress.current) return 'welcome';
	if (steps.includes(progress.current)) return progress.current;
	return nextStep(steps, progress.current);
}

/** 0–1, counting finished (completed or skipped) steps before review. */
export function onboardingFraction(
	progress: OnboardingProgress,
	steps: readonly OnboardingStep[]
): number {
	if (progress.completedAt) return 1;
	const countable = steps.filter((s) => s !== 'review');
	const done = countable.filter(
		(s) => progress.completed.includes(s) || progress.skipped.includes(s)
	).length;
	return countable.length ? done / countable.length : 0;
}
