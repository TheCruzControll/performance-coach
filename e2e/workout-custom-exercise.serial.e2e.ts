/**
 * Add my own exercise on /workout (CustomExerciseSheet.svelte, custom-exercise.ts, library.ts
 * addCustomExercise, actions.ts replaceWithOwn, fix/exercises.ts), against the real server:
 * - offline, in an ad-hoc strength session, an exercise of the owner's own is created from the
 *   picker and logged; back online, Postgres holds it under the device's id, with its sets
 * - a time-measured one asks how long one bout lasts, and its sets log seconds
 * - with bodyweight only, the power clean's nothing-fits state offers it, and it replaces the
 *   power clean for this session (an owner's choice)
 * - a catalogue name is refused in the form, before anything is sent
 * - a name the owner retired is refused by the server; Fix reopens the form, and renamed it lands
 *   once under the device's id, with its sets
 * - after a reload, the picker finds it by name
 * - axe in both themes, the screens, and the desktop dialog by keyboard, with hover and focus.
 * Serial: programs, workouts, exercises and the profile are the one owner's.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { CustomExercise } from '../src/lib/domain/training/types';
import type { SyncResponse } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { DESKTOP, expectNoSideScroll } from './desktop';
import { PROGRAM_TZ } from './program-support';
import { captureScreen, profileAction, query, resetTrainingProfile, SAME_ORIGIN } from './support';
import { readOutbox } from './workout-support';
import { startFromKit } from './workout-start-support';

test.use({ timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

const main = (page: Page) => page.getByTestId('workout-main');
const card = (page: Page) => main(page).getByTestId('exercise');
const heading = (page: Page) => card(page).getByRole('heading', { level: 2 });
const picker = (page: Page) => page.getByTestId('exercise-picker');
const search = (page: Page) => picker(page).getByTestId('picker-search');
const options = (page: Page) => picker(page).getByTestId('picker-option');
const form = (page: Page) => page.getByTestId('custom-exercise');
const logger = (page: Page) => page.getByTestId('set-logger');
const stepper = (page: Page, id: string) => logger(page).getByTestId(id).getByRole('spinbutton');
const sheet = (page: Page) => page.getByTestId('exercise-actions-sheet');

/** Starts a strength session of the owner's own from the empty workout screen. */
async function startAdHocStrength(page: Page): Promise<string> {
	await page.goto('/workout');
	await page.getByTestId('workout-empty').getByRole('link', { name: 'Strength' }).click();
	await expect(page).toHaveURL(/\/workout$/);
	await expect(page.locator('main#main[data-store]')).toBeAttached();
	await expect(main(page).getByTestId('workout-no-exercises')).toBeVisible();
	const [entry] = await readOutbox(page);
	const id = entry?.envelope.workoutId;
	if (id) return id;
	const [row] = await query<{ client_id: string }>(
		"select client_id from workouts where status = 'in_progress'"
	);
	return row!.client_id;
}

async function openPicker(page: Page) {
	const first = main(page).getByTestId('add-first-exercise');
	await ((await first.isVisible()) ? first : main(page).getByTestId('add-exercise')).click();
	await expect(picker(page)).toBeVisible();
	await expect(search(page)).toBeVisible();
}

/** Opens the form from the picker. */
async function openForm(page: Page, text = '') {
	await openPicker(page);
	if (text) await search(page).fill(text);
	await picker(page).getByTestId('picker-add-own').click();
	await expect(form(page)).toBeVisible();
	await expect(picker(page)).toBeHidden();
}

/** Picks a pill in one of the form's choice groups by its label. */
const choose = (page: Page, group: string, label: string) =>
	form(page).getByTestId(group).getByText(label, { exact: true }).click();

/** Fills the form: the name, how it is measured and loaded, and its movement. */
async function fill(
	page: Page,
	{
		name,
		measure,
		load,
		pattern
	}: { name: string; measure: string; load: string; pattern?: string }
) {
	await form(page).getByTestId('custom-name').fill(name);
	await choose(page, 'custom-measure', measure);
	await choose(page, 'custom-load', load);
	if (pattern) await choose(page, 'custom-pattern', pattern);
}

async function enter(page: Page, id: string, value: string) {
	const field = stepper(page, id);
	await field.click();
	await field.fill(value);
	await field.press('Enter');
}

async function logSets(page: Page, count: number) {
	for (let i = 1; i <= count; i++) {
		await logger(page).getByTestId('complete-set').click();
		await expect(card(page).getByTestId('set')).toHaveCount(i);
	}
}

const synced = (page: Page) => expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);

/** The owner's exercise of this name, as Postgres holds it. */
const ownExercise = (name: string) =>
	query<{
		id: string;
		measure: string;
		load_type: string;
		pattern: string;
		default_seconds: number | null;
		retired: boolean;
	}>(
		`select id, measure, load_type, pattern, default_seconds, retired_at is not null as retired
		   from exercises where owner_id is not null and name = $1`,
		[name]
	);

const setsOn = (exerciseId: string) =>
	query<{ reps: number | null; seconds: number | null; weight: number | null }>(
		`select reps, seconds, weight::float as weight from set_records
		  where exercise_id = $1 and deleted_at is null order by set_index`,
		[exerciseId]
	);

/** axe in the dark and the light theme, the page as it is. */
async function audit(page: Page, what: string) {
	for (const theme of ['dark', 'light']) {
		await page.evaluate((t) => {
			if (t === 'light') document.documentElement.dataset.theme = t;
			else delete document.documentElement.dataset.theme;
		}, theme);
		await page.waitForFunction(() =>
			document
				.getAnimations()
				.every(
					(a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity
				)
		);
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(' ')}`));
		expect(found, `${what}, ${theme}`).toEqual([]);
	}
	await page.evaluate(() => delete document.documentElement.dataset.theme);
}

const offline = (context: BrowserContext, on: boolean) => context.setOffline(on);

/** Loads the picker's and the form's code online, as a device with them precached has them. */
async function warm(page: Page) {
	await openForm(page);
	await form(page).getByRole('button', { name: 'Close' }).click();
	await expect(form(page)).toBeHidden();
}

test.describe('from the picker', () => {
	test('offline in an ad-hoc session: created, logged, and in Postgres under the device’s id once online', async ({
		page,
		context
	}, testInfo) => {
		await startAdHocStrength(page);
		await warm(page);

		await offline(context, true);
		await openForm(page);
		await fill(page, {
			name: 'Sandbag shouldering',
			measure: 'Reps',
			load: 'Added weight',
			pattern: 'Hinge'
		});
		await expect(form(page).getByTestId('custom-summary')).toHaveText(
			'Glutes, Hamstrings · No equipment'
		);
		await captureScreen(page, testInfo, 'workout-custom-exercise');
		await audit(page, 'the form');
		await form(page).getByTestId('custom-save').click();
		await expect(form(page)).toBeHidden();
		await expect(heading(page)).toHaveText('Sandbag shouldering');

		await enter(page, 'logger-load', '40');
		await enter(page, 'logger-amount', '5');
		await logSets(page, 2);
		const created = (await readOutbox(page)).find((e) => e.envelope.type === 'exercise.create')!;
		expect(created.envelope.id).toBe(created.envelope.entityId);

		await offline(context, false);
		await synced(page);
		const [row] = await ownExercise('Sandbag shouldering');
		expect(row).toMatchObject({
			id: created.envelope.entityId,
			measure: 'reps',
			load_type: 'external',
			pattern: 'hinge',
			retired: false
		});
		expect(await setsOn(row!.id)).toEqual([
			{ reps: 5, seconds: null, weight: 40 },
			{ reps: 5, seconds: null, weight: 40 }
		]);

		// After a reload, the picker finds it by name.
		await page.reload();
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await openPicker(page);
		await search(page).fill('sandbag');
		await expect(options(page).first()).toHaveText(/Sandbag shouldering/);
	});

	test('a time-measured exercise asks how long one bout lasts, and its sets log seconds', async ({
		page
	}) => {
		await startAdHocStrength(page);
		// The search that found nothing becomes its name.
		await openForm(page, 'Bulgarian bag spin');
		await expect(form(page).getByTestId('custom-name')).toHaveValue('Bulgarian bag spin');
		await expect(form(page).getByTestId('custom-seconds')).toHaveCount(0);
		await fill(page, { name: 'Bulgarian bag spin', measure: 'Time', load: 'Added weight' });
		const seconds = form(page).getByTestId('custom-seconds');
		await expect(seconds).toHaveValue('30');
		await seconds.fill('40');
		await choose(page, 'custom-pattern', 'Rotation');
		await form(page).getByTestId('custom-save').click();
		await expect(heading(page)).toHaveText('Bulgarian bag spin');

		await enter(page, 'logger-load', '12');
		await enter(page, 'logger-amount', '40');
		await logSets(page, 1);
		await synced(page);
		const [row] = await ownExercise('Bulgarian bag spin');
		expect(row).toMatchObject({ measure: 'time', pattern: 'rotation', default_seconds: 40 });
		expect(await setsOn(row!.id)).toEqual([{ reps: null, seconds: 40, weight: 12 }]);
	});

	test('a catalogue name is refused in the form, before anything is sent', async ({ page }) => {
		await startAdHocStrength(page);
		const before = (await readOutbox(page)).length;
		await openForm(page);
		await fill(page, {
			name: 'Back squat',
			measure: 'Reps',
			load: 'Added weight',
			pattern: 'Squat'
		});
		await form(page).getByTestId('custom-save').click();
		await expect(form(page).getByTestId('custom-name')).toHaveAccessibleDescription(
			'Already in the library as Back squat'
		);
		await expect(form(page)).toBeVisible();
		expect((await readOutbox(page)).length).toBe(before);
	});
});

test.describe('when nothing fits', () => {
	test('with bodyweight only, it replaces the power clean for this session', async ({
		page,
		request
	}) => {
		await profileAction(request, '/profile/equipment?/save', {
			gymType: 'none',
			equipment: [],
			homeEquipment: [],
			notes: null
		});
		const { workoutId } = await startFromKit(page, request, {
			fixture: 'hybrid',
			pick: (p) => p.sessions.find((s) => s.title === 'Full body')
		});
		for (let i = 0; i < 6 && (await heading(page).textContent())?.trim() !== 'Power clean'; i++) {
			await main(page).getByTestId('exercise-next').click();
		}
		await expect(heading(page)).toHaveText('Power clean');
		await card(page).getByTestId('exercise-actions').click();
		await sheet(page).getByTestId('action-suggest_alternative').click();
		const empty = sheet(page).getByTestId('alternatives-empty');
		await expect(empty).toContainText('Nothing fits right now');
		await empty.getByTestId('empty-add-own').click();

		await expect(form(page)).toBeVisible();
		await expect(form(page)).toContainText('It replaces Power clean for this session');
		// The movement comes from the power clean.
		await expect(form(page).getByTestId('custom-pattern').getByLabel('Olympic lift')).toBeChecked();
		await form(page).getByTestId('custom-name').fill('Jump squat to stand');
		await choose(page, 'custom-measure', 'Reps');
		await choose(page, 'custom-load', 'Bodyweight');
		await form(page).getByTestId('custom-save').click();
		await expect(heading(page)).toHaveText('Jump squat to stand');

		await synced(page);
		const [row] = await ownExercise('Jump squat to stand');
		expect(row).toMatchObject({ load_type: 'bodyweight', pattern: 'olympic' });
		const swaps = await query<{ reason: string; to_id: string }>(
			`select s.reason, s.to_exercise_id as to_id
			   from workout_substitutions s join workouts w on w.id = s.workout_id
			  where w.client_id = $1 and s.deleted_at is null`,
			[workoutId]
		);
		expect(swaps).toEqual([{ reason: 'owner_choice', to_id: row!.id }]);
	});
});

test.describe('a name the owner retired', () => {
	test('the server refuses it, the sync sheet says why, and Fix renames it under the same id', async ({
		page
	}, testInfo) => {
		test.setTimeout(90_000);
		// Created through the service, then retired.
		const exercise: CustomExercise = {
			name: 'Sandbag carry',
			aliases: [],
			pattern: 'carry',
			primaryMuscles: ['forearms'],
			secondaryMuscles: [],
			equipment: [],
			substitutionGroup: null,
			skillLevel: 'beginner',
			repMin: null,
			repMax: null,
			defaultSeconds: null,
			unilateral: false,
			measure: 'distance',
			loadType: 'external',
			tags: [],
			disciplines: []
		};
		// In a session of its own, ended at once, so nothing else is in progress.
		const workoutId = crypto.randomUUID();
		const at = new Date(Date.now() - 60 * 60_000).toISOString();
		const seed = createMutation('exercise.create', { workoutId, at, payload: exercise });
		const mutations = [
			createMutation('workout.start', {
				workoutId,
				at,
				payload: {
					kind: 'strength',
					title: 'Strongman',
					sessionType: 'strength',
					discipline: 'strength',
					plannedSessionId: null,
					plannedLineage: null,
					programId: null
				}
			}),
			seed,
			createMutation('workout.abandon', { workoutId, at, payload: {} })
		];
		const response = await page.request.post('/api/workouts/sync', {
			headers: SAME_ORIGIN,
			data: { v: 1, mutations }
		});
		expect(response.status()).toBe(200);
		const { results } = (await response.json()) as SyncResponse;
		expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
		await query('update exercises set retired_at = now() where id = $1', [seed.entityId]);

		await startAdHocStrength(page);
		await openForm(page);
		await fill(page, {
			name: 'Sandbag carry',
			measure: 'Reps',
			load: 'Added weight',
			pattern: 'Carry'
		});
		await form(page).getByTestId('custom-save').click();
		await expect(heading(page)).toHaveText('Sandbag carry');
		await enter(page, 'logger-load', '30');
		await enter(page, 'logger-amount', '8');
		await logSets(page, 1);
		const created = (await readOutbox(page)).find((e) => e.envelope.type === 'exercise.create')!;

		const pill = page.getByTestId('sync-pill');
		await expect(pill).toHaveText(/needs attention/, { timeout: 15_000 });
		await pill.click();
		const issue = page
			.getByTestId('sync-sheet')
			.getByTestId('sync-issue')
			.filter({ hasText: 'New exercise · Sandbag carry' });
		await expect(issue).toContainText('You removed Sandbag carry from your exercises earlier');
		await issue.getByTestId('fix-change').click();

		await expect(form(page)).toBeVisible();
		await expect(form(page).getByTestId('custom-exercise-problem')).toBeVisible();
		await expect(form(page).getByTestId('custom-name')).toHaveValue('Sandbag carry');
		await captureScreen(page, testInfo, 'workout-custom-exercise-fix');
		await form(page).getByTestId('custom-name').fill('Sandbag bear-hug carry');
		await form(page).getByTestId('custom-save').click();
		await expect(form(page)).toBeHidden();

		// The set waited on the exercise, and backs off before it is sent again.
		await expect.poll(() => readOutbox(page), { timeout: 45_000 }).toEqual([]);
		const rows = await ownExercise('Sandbag bear-hug carry');
		expect(rows).toEqual([expect.objectContaining({ id: created.envelope.entityId })]);
		expect(await setsOn(created.envelope.entityId)).toEqual([
			{ reps: 8, seconds: null, weight: 30 }
		]);
		// The retired one stays retired, under its own id.
		expect(await ownExercise('Sandbag carry')).toEqual([
			expect.objectContaining({ id: seed.entityId, retired: true })
		]);
	});
});

test.describe('desktop', () => {
	test.use(DESKTOP);

	test('the form is a dialog, usable by keyboard, with hover and focus states', async ({
		page
	}, testInfo) => {
		await startAdHocStrength(page);
		await openForm(page);
		const dialog = page.getByRole('dialog', { name: 'Add my own exercise' });
		await expect(dialog).toBeVisible();

		const name = form(page).getByTestId('custom-name');
		await name.focus();
		await page.keyboard.type('Sandbag shouldering');
		// Tab into the measure, arrows choose within it.
		await page.keyboard.press('Tab');
		await page.keyboard.press('Space');
		await expect(form(page).getByTestId('custom-measure').getByLabel('Reps')).toBeChecked();
		await page.keyboard.press('Tab');
		await page.keyboard.press('Space');
		await expect(form(page).getByTestId('custom-load').getByLabel('Added weight')).toBeChecked();
		await page.keyboard.press('Tab');
		await page.keyboard.press('ArrowRight');
		await expect(form(page).getByTestId('custom-pattern').getByLabel('Hinge')).toBeChecked();

		const toggle = form(page).getByTestId('custom-more-toggle');
		await toggle.focus();
		await expect(toggle).toHaveCSS('outline-style', 'solid');
		const before = await toggle.evaluate((el) => getComputedStyle(el).backgroundColor);
		await toggle.hover();
		await expect
			.poll(() => toggle.evaluate((el) => getComputedStyle(el).backgroundColor))
			.not.toBe(before);
		await page.keyboard.press('Enter');
		await expect(toggle).toHaveAttribute('aria-expanded', 'true');
		await expect(form(page).getByTestId('custom-muscles').getByLabel('Glutes')).toBeChecked();
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'workout-custom-exercise-desktop');

		await form(page).getByTestId('custom-save').focus();
		await page.keyboard.press('Enter');
		await expect(dialog).toBeHidden();
		await expect(heading(page)).toHaveText('Sandbag shouldering');
	});
});
