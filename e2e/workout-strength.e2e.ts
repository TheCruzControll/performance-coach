/**
 * The strength view (/workout): the current exercise readable mid-set, from the shared kit
 * fixture seeded in IndexedDB. Sync is held ('hold'), so nothing here writes Postgres. The
 * desktop layout is workout-strength.desktop.e2e.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { BASELINE_INSTRUCTION } from '../src/lib/domain/training/describe';
import type { StartKit, StrengthKit } from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { DB_NAME, STORES } from '../src/lib/client/workout/names';
import { expectNoSideScroll } from './desktop';
import { captureScreen } from './support';
import { gotoWorkout, injectMutation, seedWorkout, workoutDay } from './workout-support';

let kit: StrengthKit;
test.beforeAll(async () => {
	kit = (await workoutDay()).strength;
});

/** Seeds the workout with `position` as the current exercise, as the device state keeps it. */
async function seedAt(page: Page, start: StartKit, position: number): Promise<string> {
	const workoutId = await seedWorkout(page, start);
	await setPosition(page, workoutId, position);
	return workoutId;
}

/** Makes `position` the stored workout's current exercise (before the page reads it). */
async function setPosition(page: Page, workoutId: string, position: number) {
	await page.evaluate(
		async ({ name, store, workoutId, position }) => {
			const db = await new Promise<IDBDatabase>((resolve, reject) => {
				const request = indexedDB.open(name);
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			});
			const objects = db.transaction(store, 'readwrite').objectStore(store);
			const read = objects.get(workoutId);
			await new Promise((resolve) => (read.onsuccess = resolve));
			const record = read.result as { device: { position: number } };
			record.device.position = position;
			objects.put(record);
			await new Promise((resolve) => (objects.transaction.oncomplete = resolve));
			db.close();
		},
		{ name: DB_NAME, store: STORES.workouts, workoutId, position }
	);
}

const card = (page: Page) => page.getByTestId('workout-main').getByTestId('exercise');
const target = (page: Page) => card(page).getByTestId('exercise-target');
const lines = (page: Page) => target(page).locator('.lines');
const previous = (page: Page) => card(page).getByTestId('exercise-previous');

async function audit(page: Page): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page })
		.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
		.analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
	);
}

test.describe('the strength view (IndexedDB only)', () => {
	// gotoWorkout holds /api/workouts/* with page.route, which WebKit applies only without a worker.
	test.use({ serviceWorkers: 'block' });

	test('the back squat asks to work up to a set of 5 @ RPE 7, with no weight, and shows last time', async ({
		page
	}, testInfo) => {
		const workouts: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/workouts')) workouts.push(request.url());
		});
		await seedWorkout(page, kit);
		await gotoWorkout(page);

		await expect(card(page).getByRole('heading', { level: 2 })).toHaveText('Back squat');
		await expect(card(page)).toContainText('Exercise 1 of 5');
		await expect(lines(page)).toHaveText('Work up to a set of 5 @ RPE 7 · 3 × 5');
		// The set at hand is the baseline: its instruction, never an invented weight.
		await expect(target(page)).toContainText(BASELINE_INSTRUCTION);
		await expect(target(page)).toContainText('Rest 3:00');
		await expect(target(page)).not.toContainText(/\d\s*(kg|lb)/);
		// Last session's sets, inline, as they were done.
		await expect(previous(page).getByRole('heading')).toHaveText('Last time · 7 days ago');
		await expect(previous(page).getByRole('listitem')).toHaveText([
			'100 kg × 5 reps · RPE 8',
			'85 kg × 5 reps · RPE 7',
			'85 kg × 5 reps · RPE 7',
			'85 kg × 5 reps · RPE 7.5'
		]);
		await expect(card(page).getByTestId('set')).toHaveText([
			/^1\s*5 reps · RPE 7\s*Now$/,
			/^2\s*5 reps · ≈ 100 kg\s*To do$/,
			/^3\s*5 reps · ≈ 100 kg\s*To do$/,
			/^4\s*5 reps · ≈ 100 kg\s*To do$/
		]);
		await expect(card(page).getByTestId('set').first()).toHaveAttribute('aria-current', 'step');
		await captureScreen(page, testInfo, 'workout-baseline');
		expect(workouts).toEqual([]);
	});

	test('the leg press shows 3 × 10 @ RPE 7 and its rest, and says it has no previous sets', async ({
		page
	}, testInfo) => {
		await seedAt(page, kit, 2);
		await gotoWorkout(page);
		await expect(card(page).getByRole('heading', { level: 2 })).toHaveText('Leg press');
		await expect(card(page)).toContainText('Exercise 2 of 5');
		await expect(lines(page)).toHaveText('3 × 10 @ RPE 7');
		await expect(target(page)).toContainText('Rest 2:00');
		await expect(target(page)).not.toContainText(/\d\s*(kg|lb)/);
		await expect(previous(page).getByRole('heading')).toHaveText('Last time · none yet');
		await expect(card(page).getByTestId('set')).toHaveCount(3);
		await captureScreen(page, testInfo, 'workout-exercise');
	});

	test('the superset: the pull-up reads A1 with its bodyweight wording; the plank A2 and 3 × 0:45', async ({
		page
	}) => {
		const workoutId = await seedAt(page, kit, 4);
		await gotoWorkout(page);
		await expect(card(page).getByRole('heading', { level: 2 })).toHaveText('Pull-up');
		await expect(card(page)).toContainText('A1');
		await expect(card(page)).toContainText('Exercise 4 of 5');
		await expect(lines(page)).toHaveText('3 × 6–10 @ RPE 8');
		await expect(target(page)).toContainText('Bodyweight · add weight if you like');
		await expect(target(page)).toContainText('No rest');

		await setPosition(page, workoutId, 5);
		await page.reload();
		await expect(card(page).getByRole('heading', { level: 2 })).toHaveText('Plank');
		await expect(card(page)).toContainText('A2');
		await expect(lines(page)).toHaveText('3 × 0:45');
		await expect(target(page)).toContainText('Bodyweight · add weight if you like');
		await expect(target(page)).toContainText('Rest 1:30');
		await expect(card(page).getByTestId('set').first()).toHaveText(/^1\s*0:45\s*Now$/);
	});

	test('a reload restores the same exercise, and no request reaches /api/workouts', async ({
		page
	}) => {
		const workouts: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/workouts')) workouts.push(request.url());
		});
		await seedAt(page, kit, 3);
		await gotoWorkout(page);
		await expect(card(page).getByRole('heading', { level: 2 })).toHaveText('Romanian deadlift');
		const shown = await page.getByTestId('workout-main').innerText();
		await page.reload();
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(card(page).getByRole('heading', { level: 2 })).toHaveText('Romanian deadlift');
		expect(await page.getByTestId('workout-main').innerText()).toBe(shown);
		expect(workouts).toEqual([]);
	});

	test('set rows say done, missed, skipped, extra and now in words', async ({ page }) => {
		const workoutId = await seedWorkout(page, kit);
		const squat = kit.exercises[0]!;
		const place = (setIndex: number) => ({
			position: 1,
			plannedLineage: squat.plannedLineage,
			setIndex,
			exerciseId: squat.exercise.id
		});
		const set = { seconds: null, metres: null, assistance: null, unit: 'kg' as const };
		const at = new Date().toISOString();
		const log = (setIndex: number, values: object) =>
			createMutation('set.log', {
				workoutId,
				at,
				payload: {
					...place(setIndex),
					...set,
					reps: 5,
					weight: 100,
					rpe: 8,
					missedReps: 0,
					isWarmup: false,
					isExtra: false,
					...values
				}
			});
		await injectMutation(page, log(1, {}));
		await injectMutation(page, log(2, { reps: 3, missedReps: 2, rpe: 10 }));
		await injectMutation(
			page,
			createMutation('set.skip', { workoutId, at, payload: { ...place(3), unit: 'kg' } })
		);
		await injectMutation(page, log(5, { weight: 60, reps: 8, rpe: 6, isExtra: true }));
		await gotoWorkout(page);

		await expect(card(page).getByTestId('set')).toHaveText([
			/^1\s*100 kg × 5 reps · RPE 8\s*Done$/,
			/^2\s*100 kg × 3 reps · RPE 10\s*2 missed$/,
			/^3\s*5 reps · ≈ 100 kg\s*Skipped$/,
			/^4\s*5 reps · ≈ 100 kg\s*Now$/,
			/^5\s*60 kg × 8 reps · RPE 6\s*Extra set$/
		]);
		// The set at hand is a back-off now: its prescribed weight, not the baseline instruction.
		await expect(target(page)).toContainText('≈ 100 kg');
		await expect(target(page)).not.toContainText(BASELINE_INSTRUCTION);
		expect(await audit(page)).toEqual([]);
	});

	test('long names and lb loads fit 393 px and 150 % text, with no sideways scroll', async ({
		page
	}) => {
		const long = structuredClone(kit);
		long.units = { weight: 'lb', distance: 'km' };
		const squat = long.exercises[0]!;
		squat.exercise.name = 'Single-arm dumbbell Bulgarian split squat with a three-second pause';
		squat.sets = squat.sets.map((set) => ({
			...set,
			prescribedWeight: set.prescribedWeight && { value: 227.5, unit: 'lb', basis: 'estimated' }
		}));
		squat.previous = {
			...squat.previous!,
			sets: squat.previous!.sets.map((set) => ({ ...set, weight: 222.5, unit: 'lb' }))
		};
		await seedAt(page, long, 1);
		await gotoWorkout(page);
		await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(squat.exercise.name);
		await expect(card(page).getByTestId('set').nth(1)).toContainText('≈ 227.5 lb');
		await expect(previous(page)).toContainText('222.5 lb × 5 reps · RPE 8');
		await expectNoSideScroll(page);
		await page.evaluate(() => (document.documentElement.style.fontSize = '150%'));
		await expectNoSideScroll(page);
		const heading = await card(page).getByRole('heading', { level: 2 }).boundingBox();
		const box = await card(page).boundingBox();
		expect(heading!.x + heading!.width).toBeLessThanOrEqual(box!.x + box!.width);
	});

	for (const theme of ['dark', 'light'] as const) {
		test(`no WCAG A/AA violations (${theme} theme)`, async ({ page }) => {
			await page.addInitScript(
				(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
				theme
			);
			const workoutId = await seedWorkout(page, kit);
			await gotoWorkout(page);
			await expect(card(page)).toBeVisible();
			expect(await audit(page), 'baseline').toEqual([]);

			await setPosition(page, workoutId, 4);
			await page.reload();
			await expect(card(page).getByRole('heading', { level: 2 })).toHaveText('Pull-up');
			expect(await audit(page), 'superset').toEqual([]);
		});
	}
});
