/**
 * Ask the coach (src/lib/ui/ask-link.ts): from a workout (the exercise's Options sheet,
 * ExerciseActionsSheet), from an exercise's history (ExerciseHistorySheet, opened from the
 * workout) and from Today (its plan's panel). Each opens Coach on a new conversation with its
 * question in the composer under its context chip; a workout's question names the workout, and
 * the turn it starts reads that workout. Offline, the link is Coach's designed offline state,
 * which loads the question once back online. The history sheet a coach answer opens (by exercise
 * id alone) has no link: it is already over a conversation.
 *
 * Serial: the program, the workout and the coach rows are the one owner's (e2e/coach-support.ts).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { StrengthKit } from '../src/lib/domain/workout';
import { lastRun, openThread, query, resetCoach, seedCoach } from './coach-support';
import { DESKTOP, expectMainCentred, expectNoSideScroll } from './desktop';
import { PROGRAM_TZ, seedProgram } from './program-support';
import { captureScreen, gotoHydrated, trackConsoleErrors } from './support';
import { startFromKit } from './workout-start-support';

test.use({ timezoneId: PROGRAM_TZ });

test.beforeEach(async ({ request }) => {
	await resetCoach(request);
});

test.afterAll(async ({ request }) => {
	await resetCoach(request);
});

const WORKOUT_QUESTION = 'Can we change today’s workout?';
const TODAY_QUESTION = 'What should I focus on next week?';

const composer = (page: Page) => page.getByRole('form', { name: 'Message your coach' });
const message = (page: Page) => composer(page).getByRole('textbox', { name: 'Message' });
const card = (page: Page) => page.getByTestId('workout-main').getByTestId('exercise');
const actionsSheet = (page: Page) => page.getByTestId('exercise-actions-sheet');
const historySheet = (page: Page) => page.getByTestId('exercise-history-sheet');

/** The card's Options sheet, open. */
async function openActions(page: Page) {
	await card(page).getByTestId('exercise-actions').click();
	await expect(actionsSheet(page).getByTestId('action-skip')).toBeVisible();
}

/** Coach, opened by an entry: its question waiting under its chip, about `ref` (or nothing). */
async function expectEntry(
	page: Page,
	{ question, chip, ref }: { question: string; chip: string; ref: string | null }
) {
	await expect(page).toHaveURL(/\/coach\?/);
	const url = new URL(page.url());
	expect(url.pathname).toBe('/coach');
	expect(url.searchParams.get('ask')).toBe(question);
	expect(url.searchParams.get('ref')).toBe(ref);
	await expect(page.getByTestId('context-chip')).toHaveText(new RegExp(chip));
	await expect(message(page)).toHaveValue(question);
}

/** axe on the page as it is, in the dark and the light theme. */
async function auditThemes(page: Page, state: string) {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate((t) => {
			if (t === 'dark') delete document.documentElement.dataset.theme;
			else document.documentElement.dataset.theme = t;
		}, theme);
		await page.waitForTimeout(400); // transitions settle: contrast on final colours
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) =>
			v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
		);
		expect(found, `axe, ${state}, ${theme}`).toEqual([]);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

test('from a workout started from its kit: the question names the workout, and the turn reads it', async ({
	page,
	request
}, testInfo) => {
	const errors = trackConsoleErrors(page);
	const { workoutId } = await startFromKit(page, request);
	await openActions(page);
	const ask = actionsSheet(page).getByTestId('ask-coach');
	await expect(ask).toContainText('Ask the coach');
	await expect(ask).toContainText(WORKOUT_QUESTION);
	await captureScreen(page, testInfo, 'coach-entry-workout-sheet');
	await auditThemes(page, 'the Options sheet');

	await ask.click();
	await expectEntry(page, {
		question: WORKOUT_QUESTION,
		chip: 'From your workout',
		ref: `workout:${workoutId}`
	});
	await expectNoSideScroll(page);
	await captureScreen(page, testInfo, 'coach-entry-workout');

	await composer(page).getByRole('button', { name: 'Send' }).click();
	await expect(page.getByTestId('owner-message')).toContainText(WORKOUT_QUESTION);
	await expect(composer(page).getByRole('button', { name: 'Send' })).toBeVisible({
		timeout: 30_000
	});
	// Either answer of the change-workout script: both come after reading the workout.
	await expect(page.locator('main')).toContainText('today’s session');

	// The conversation records where it came from, and the turn read the workout in progress.
	expect(
		await query<{ entry: unknown }>(
			'select entry from coach_threads order by created_at desc limit 1'
		)
	).toEqual([{ entry: { from: 'workout', ref: { type: 'workout', id: workoutId } } }]);
	const run = await lastRun();
	expect(
		await query<{ status: string; live: string | null }>(
			`select status, output #>> '{live,workoutId}' as live from agent_tool_calls
			where run_id = $1 and name = 'get_current_workout'`,
			[run!.id]
		)
	).toEqual([{ status: 'succeeded', live: workoutId }]);
	expect(errors).toEqual([]);
});

test('from an exercise’s history on the workout: how that exercise has progressed', async ({
	page,
	request
}, testInfo) => {
	const { kit } = await startFromKit(page, request);
	const name = (await card(page).getByRole('heading', { level: 2 }).textContent())!.trim();
	const exercise = (kit as StrengthKit).exercises.find((e) => e.exercise.name === name)!.exercise;

	await card(page).getByTestId('exercise-history-open').click();
	const ask = historySheet(page).getByTestId('ask-coach');
	await expect(ask).toContainText(`How has my ${name} progressed?`);
	await captureScreen(page, testInfo, 'coach-entry-history-sheet');

	await ask.click();
	await expectEntry(page, {
		question: `How has my ${name} progressed?`,
		chip: 'From an exercise’s history',
		ref: `exercise:${exercise.id}`
	});
});

test('from Today: what to focus on next week', async ({ page, request }, testInfo) => {
	await seedProgram(request, { fixture: 'workout-day', start: 'this_week' });
	await gotoHydrated(page, '/today');
	const ask = page.getByTestId('today-plan').getByTestId('ask-coach');
	await expect(ask).toContainText(TODAY_QUESTION);
	await captureScreen(page, testInfo, 'coach-entry-today');

	await ask.click();
	await expectEntry(page, { question: TODAY_QUESTION, chip: 'From Today', ref: null });
	await expect(page.getByTestId('owner-message')).toHaveCount(0);
});

test('the history sheet a coach answer opens has no Ask the coach link', async ({
	page,
	request
}) => {
	const seeded = await seedCoach(request, 'bench-month');
	await openThread(page, seeded.threads.bench!);
	await page
		.getByTestId('coach-message')
		.getByRole('list', { name: 'Sources' })
		.getByRole('button', { name: 'Bench press, Exercise', exact: true })
		.click();
	await expect(historySheet(page).getByTestId('history-session')).toHaveCount(4);
	await expect(historySheet(page).getByTestId('ask-coach')).toHaveCount(0);
	await expect(historySheet(page).getByRole('link', { name: /Ask the coach/ })).toHaveCount(0);
});

test.describe('offline', () => {
	// Playwright emulates offline for service-worker traffic only in Chromium (offline.e2e.ts).
	test.skip(({ browserName }) => browserName !== 'chromium', 'offline emulation is Chromium-only');

	test('offline from the workout: Coach’s offline state, which loads the question once back online', async ({
		page,
		context,
		request
	}, testInfo) => {
		const { workoutId } = await startFromKit(page, request);
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		await context.setOffline(true);
		await page.waitForFunction(() => !navigator.onLine);
		await openActions(page);
		await actionsSheet(page).getByTestId('ask-coach').click();

		await expect(page).toHaveURL(/\/coach\?/);
		await expect(page.getByTestId('offline-state')).toContainText('You’re offline');
		await expect(page.getByRole('heading', { level: 1 })).toContainText('Coach');
		await expect(page.locator('body')).not.toContainText(/500|internal error/i);
		await captureScreen(page, testInfo, 'coach-entry-offline');

		await context.setOffline(false);
		await expectEntry(page, {
			question: WORKOUT_QUESTION,
			chip: 'From your workout',
			ref: `workout:${workoutId}`
		});
	});
});

test.describe('desktop', () => {
	test.use(DESKTOP);

	test('Today’s link sits in the plan’s column, works by keyboard, and Coach opens centred', async ({
		page,
		request
	}, testInfo) => {
		await seedProgram(request, { fixture: 'workout-day', start: 'this_week' });
		await gotoHydrated(page, '/today');
		const ask = page.getByTestId('today-plan').getByTestId('ask-coach');
		await expect(ask).toBeVisible();
		const link = await ask.boundingBox();
		const upNext = await page.getByTestId('today-up-next').boundingBox();
		expect(Math.abs(link!.x - upNext!.x), 'in the plan’s column').toBeLessThanOrEqual(1);
		expect(Math.abs(link!.width - upNext!.width), 'as wide as Up next').toBeLessThanOrEqual(1);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'coach-entry-today-desktop');

		await ask.focus();
		await expect(ask).toBeFocused();
		await page.keyboard.press('Enter');
		await expectEntry(page, { question: TODAY_QUESTION, chip: 'From Today', ref: null });
		await expectMainCentred(page);
		await expectNoSideScroll(page);
	});

	test('the workout’s Options dialog offers it, and Coach opens with the workout’s question', async ({
		page,
		request
	}, testInfo) => {
		const { workoutId } = await startFromKit(page, request);
		await openActions(page);
		await expect(page.getByRole('dialog', { name: 'Exercise options' })).toBeVisible();
		const ask = actionsSheet(page).getByTestId('ask-coach');
		await ask.hover();
		await captureScreen(page, testInfo, 'coach-entry-workout-sheet-desktop');
		await ask.click();
		await expectEntry(page, {
			question: WORKOUT_QUESTION,
			chip: 'From your workout',
			ref: `workout:${workoutId}`
		});
		await expectMainCentred(page);
	});
});
