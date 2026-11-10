/**
 * /design → Workout for its specs (design-workout.e2e.ts, design-workout.desktop.e2e.ts) and the
 * axe audit (a11y-suite.ts): opening the section, picking a state, and answering the history
 * sheet's endpoint with a fixture. A test that answers it runs with the service worker blocked:
 * on WebKit, page.route does not see requests from a page the service worker controls.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { gotoHydrated } from './support';

export const HISTORY_API = '**/api/exercises/*/history*';

/** The workout states, their code loaded (the button only works once the page has hydrated). */
export async function openWorkoutPanel(page: Page): Promise<Locator> {
	await gotoHydrated(page, '/design');
	await page.getByTestId('toggle-workout').click();
	const panel = page.getByTestId('workout-panel');
	await expect(panel.getByRole('heading', { name: 'Exercise history' })).toBeVisible();
	return panel;
}

/** Picks one state of a one-at-a-time component: 'logger-kind', 'card-kind' or 'up-next-kind'. */
export async function pick(panel: Locator, group: string, label: string): Promise<void> {
	const radio = panel.getByTestId(group).getByRole('radio', { name: label, exact: true });
	await radio.check();
	await expect(radio).toBeChecked();
}

const done = (setIndex: number, weight: number, reps: number, rpe: number, day: number) => ({
	id: 900 + setIndex + day * 10,
	workoutId: `00000000-0000-4000-8000-00000000${String(day).padStart(4, '0')}`,
	setIndex,
	isSkipped: false,
	performedAt: `2026-10-${String(day).padStart(2, '0')}T18:0${setIndex}:00.000Z`,
	reps,
	seconds: null,
	metres: null,
	weight,
	assistance: null,
	unit: 'kg',
	rpe,
	missedReps: 0,
	isWarmup: false,
	isExtra: false
});

const TOP = done(1, 100, 5, 8, 30);

/** The endpoint's answer: two sessions newest first, a best e1RM and a rep PR. */
export const HISTORY = {
	exercise: { id: '00000000-0000-4000-8000-0000000d0101', name: 'Back squat' },
	previous: null,
	sets: [done(2, 85, 5, 7, 30), TOP, done(2, 82.5, 5, 7, 23), done(1, 97.5, 5, 8, 23)],
	next: null,
	records: {
		bestE1rm: { kind: 'estimated', value: 123.3, set: TOP },
		repMaxes: [{ reps: 5, weightKg: 100, set: TOP }]
	}
};

/** Answers the history endpoint with HISTORY. */
export const answerHistory = (page: Page) =>
	page.route(HISTORY_API, (route) => route.fulfill({ json: HISTORY }));
