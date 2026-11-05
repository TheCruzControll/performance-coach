import { describe, expect, it } from 'vitest';
import {
	nextStep,
	onboardingFraction,
	onboardingSteps,
	previousStep,
	resumeStep,
	type OnboardingProgress
} from './onboarding';

const progress = (p: Partial<OnboardingProgress> = {}): OnboardingProgress => ({
	current: null,
	completed: [],
	skipped: [],
	completedAt: null,
	...p
});

describe('onboarding steps', () => {
	it('asks for running/Muay Thai specifics only when one of those is trained', () => {
		expect(onboardingSteps(['powerlifting', 'hypertrophy'])).not.toContain('specifics');
		expect(onboardingSteps(['distance_running'])).toContain('specifics');
		expect(onboardingSteps(['muay_thai'])).toContain('specifics');
		expect(onboardingSteps([])[0]).toBe('welcome');
		expect(onboardingSteps([]).at(-1)).toBe('review');
	});

	it('moves forward and back among the applicable steps', () => {
		const steps = onboardingSteps(['strength']);
		expect(nextStep(steps, 'strength')).toBe('equipment');
		expect(previousStep(steps, 'equipment')).toBe('strength');
		expect(previousStep(steps, 'welcome')).toBeNull();
		expect(nextStep(steps, 'review')).toBe('review');
		// A step that stopped applying (the last runner goal went) continues after itself.
		expect(nextStep(steps, 'specifics')).toBe('equipment');
		expect(previousStep(steps, 'specifics')).toBe('strength');
	});

	it('resumes at the stored step, or the next one that still applies', () => {
		const steps = onboardingSteps(['strength']);
		expect(resumeStep(progress(), steps)).toBe('welcome');
		expect(resumeStep(progress({ current: 'injuries' }), steps)).toBe('injuries');
		expect(resumeStep(progress({ current: 'specifics' }), steps)).toBe('equipment');
	});

	it('counts completed and skipped steps (review excluded) towards progress', () => {
		const steps = onboardingSteps(['strength']);
		expect(onboardingFraction(progress(), steps)).toBe(0);
		expect(
			onboardingFraction(
				progress({ completed: ['welcome', 'goals'], skipped: ['strength'] }),
				steps
			)
		).toBeCloseTo(3 / 9);
		expect(onboardingFraction(progress({ completedAt: new Date() }), steps)).toBe(1);
	});
});
