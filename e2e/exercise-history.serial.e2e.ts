/**
 * The exercise-history sheet (src/lib/ui/workout/ExerciseHistorySheet.svelte): an exercise's last
 * performances, each session's sets newest session first and paged, its best e1RM labelled
 * estimated and its rep PRs. It opens from an exercise's name in a History workout's detail,
 * shallow-routed so Back closes it and a reload shows the detail without it, and from the
 * exercise's name on the workout screen, where offline it shows the session the device holds and
 * says so. A request that fails or hangs past 5 s shows the designed error, whose Retry recovers.
 *
 * Workouts are synced through the real sync API with the page's request context, as a device
 * would send them. Serial: workouts are the one owner's, and every test starts from none.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type {
	Mutation,
	MutationInput,
	MutationType,
	StartKit,
	StrengthKit,
	SyncResponse
} from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { type WorkoutDayKits } from '../tests/fixtures/workout-day';
import { DESKTOP, expectNoSideScroll } from './desktop';
import {
	captureScreen,
	gotoHydrated,
	resetTrainingProfile,
	SAME_ORIGIN,
	trackConsoleErrors
} from './support';
import { gotoWorkout, seedWorkout, workoutDay } from './workout-support';

const HISTORY = '/progress/workouts';
const DAY = 24 * 60 * 60 * 1000;
const HISTORY_API = '**/api/exercises/*/history*';

// page.route never sees a request from a page the service worker controls on WebKit.
test.use({ serviceWorkers: 'block' });

let kits: WorkoutDayKits;
test.beforeAll(async () => {
	kits = await workoutDay();
});
test.beforeEach(async () => {
	await resetTrainingProfile();
});

const adHoc = (kit: StrengthKit): StrengthKit => ({
	...kit,
	plannedSessionId: null,
	plannedLineage: null,
	programId: null
});

/** A finished strength workout of back squat sets, [weight, reps, rpe] each, from `startedAt`. */
function squatWorkout(startedAt: number, sets: [number, number, number][]) {
	const kit = adHoc(kits.strength as StrengthKit);
	const squat = kit.exercises.find((e) => e.exercise.key === 'back_squat')!;
	const workoutId = crypto.randomUUID();
	let at = startedAt;
	const mutations: Mutation[] = [];
	const add = <T extends MutationType>(
		type: T,
		input: Omit<MutationInput<T>, 'workoutId' | 'at'>
	) => {
		const iso = new Date(at).toISOString();
		mutations.push(createMutation(type, { workoutId, at: iso, ...input } as MutationInput<T>));
		at += 60_000;
	};
	const { kind, title, sessionType, discipline } = kit as StartKit;
	add('workout.start', {
		payload: {
			kind,
			title,
			sessionType,
			discipline,
			plannedSessionId: null,
			plannedLineage: null,
			programId: null
		}
	});
	sets.forEach(([weight, reps, rpe], i) =>
		add('set.log', {
			payload: {
				position: squat.position,
				plannedLineage: null,
				exerciseId: squat.exercise.id,
				setIndex: i + 1,
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
			}
		})
	);
	add('workout.finish', { payload: { sessionRpe: 8, durationSeconds: 3000, notes: null } });
	return { workoutId, mutations, name: squat.exercise.name };
}

/** Sends mutations through the real sync endpoint, 20 at a time; every one must apply. */
async function sync(page: Page, mutations: Mutation[]) {
	for (let i = 0; i < mutations.length; i += 20) {
		const batch = mutations.slice(i, i + 20);
		const response = await page.request.post('/api/workouts/sync', {
			headers: SAME_ORIGIN,
			data: { v: 1, mutations: batch }
		});
		expect(response.status()).toBe(200);
		const { results } = (await response.json()) as SyncResponse;
		expect(results.map((r) => r.status)).toEqual(batch.map(() => 'applied'));
	}
}

const sheet = (page: Page) => page.getByTestId('exercise-history-sheet');
const sessions = (page: Page) => sheet(page).getByTestId('history-session');

/** axe on the page as it is (the sheet open), in the dark and the light theme. */
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

test.describe('with two synced workouts of back squat', () => {
	let older: ReturnType<typeof squatWorkout>;
	let latest: ReturnType<typeof squatWorkout>;

	test.beforeEach(async ({ page }) => {
		const now = Date.now();
		older = squatWorkout(now - 8 * DAY, [
			[100, 5, 8],
			[100, 5, 8.5]
		]);
		latest = squatWorkout(now - DAY, [
			[105, 5, 8],
			[105, 5, 9]
		]);
		await sync(page, [...older.mutations, ...latest.mutations]);
	});

	/** Both sessions, newest first, each set in the order done, and the estimated best. */
	async function expectBothSessions(page: Page) {
		await expect(sheet(page)).toBeVisible();
		await expect(sheet(page).getByRole('heading', { name: latest.name })).toBeVisible();
		await expect(sessions(page)).toHaveCount(2);
		await expect(sessions(page).nth(0).getByTestId('history-set')).toHaveText([
			/Set 1\s*105 kg × 5 reps · RPE 8\s*$/,
			/Set 2\s*105 kg × 5 reps · RPE 9\s*$/
		]);
		await expect(sessions(page).nth(1).getByTestId('history-set')).toHaveText([
			/Set 1\s*100 kg × 5 reps · RPE 8\s*$/,
			/Set 2\s*100 kg × 5 reps · RPE 8.5\s*$/
		]);
		await expect(sheet(page).getByTestId('history-best')).toContainText(
			/^Estimated 1RM · [\d.]+ kg/
		);
		await expect(sheet(page).getByTestId('history-rep-prs')).toContainText(/5 reps\s*105 kg/);
	}

	test('opened from the History detail, it lists both sessions and the estimated best; Back closes it, and a reload shows the detail without it', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		const detail = `${HISTORY}/${latest.workoutId}`;
		await gotoHydrated(page, detail);
		const open = page.getByTestId('workout-detail').getByTestId('exercise-history-open');
		await expect(open).toHaveText(latest.name);
		await open.click();
		await expectBothSessions(page);
		await expect(page).toHaveURL(detail);
		await captureScreen(page, testInfo, 'exercise-history');
		await auditThemes(page, 'ready');

		await page.goBack();
		await expect(sheet(page)).toBeHidden();
		await expect(page).toHaveURL(detail);
		await expect(page.getByTestId('workout-detail')).toBeVisible();

		await open.click();
		await expect(sessions(page)).toHaveCount(2);
		await page.reload();
		await page.waitForLoadState('networkidle');
		await expect(page.getByTestId('workout-detail')).toBeVisible();
		await expect(sheet(page)).toHaveCount(0);

		// Closing it is Back too: it leaves no entry behind.
		await open.click();
		await expect(sessions(page)).toHaveCount(2);
		await sheet(page).getByRole('button', { name: 'Close' }).click();
		await expect(sheet(page)).toBeHidden();
		await expect(page).toHaveURL(detail);
		await expect(open, 'focus returns to the name').toBeFocused();
		// The reloaded entry's sheet is gone: closing did not bring it back, and it opens again.
		await page.waitForTimeout(500);
		await expect(sheet(page)).toBeHidden();
		await open.click();
		await expect(sheet(page)).toBeVisible();
		await expect(sessions(page)).toHaveCount(2);
		await sheet(page).getByRole('button', { name: 'Close' }).click();
		await expect(sheet(page)).toBeHidden();
		expect(errors).toEqual([]);
	});

	test('opened from the workout, the same; offline, the session the device holds, saying so', async ({
		page,
		context
	}) => {
		await seedWorkout(page, kits.strength);
		await gotoWorkout(page);
		const open = page.getByTestId('exercise').getByTestId('exercise-history-open');
		await expect(open).toHaveText(latest.name);
		await open.click();
		await expectBothSessions(page);
		await sheet(page).getByRole('button', { name: 'Close' }).click();
		await expect(sheet(page)).toBeHidden();

		await context.setOffline(true);
		await open.click();
		const note = sheet(page).getByTestId('exercise-history-offline');
		await expect(note).toContainText('You’re offline');
		await expect(note).toContainText('Showing the last session saved on this device.');
		// The kit's previous session (tests/fixtures/workout-day.ts), not the server's.
		await expect(sessions(page)).toHaveCount(1);
		await expect(sessions(page).getByTestId('history-set')).toHaveText([
			/Set 1\s*100 kg × 5 reps · RPE 8\s*$/,
			/Set 2\s*85 kg × 5 reps · RPE 7\s*$/,
			/Set 3\s*85 kg × 5 reps · RPE 7\s*$/,
			/Set 4\s*85 kg × 5 reps · RPE 7.5\s*$/
		]);
		await auditThemes(page, 'offline');
		await context.setOffline(false);
	});

	test('a history request answering 500 shows the error with Retry, which recovers', async ({
		page
	}, testInfo) => {
		await gotoHydrated(page, `${HISTORY}/${latest.workoutId}`);
		await page.route(HISTORY_API, (route) => route.fulfill({ status: 500, json: { error: 'x' } }));
		await page.getByTestId('workout-detail').getByTestId('exercise-history-open').click();
		const error = sheet(page).getByTestId('exercise-history-error');
		await expect(error).toContainText('Couldn’t load this history');
		await captureScreen(page, testInfo, 'exercise-history-error');
		await auditThemes(page, 'error');

		await page.unrouteAll({ behavior: 'ignoreErrors' });
		await error.getByRole('button', { name: 'Retry' }).click();
		await expectBothSessions(page);
		await expect(error).toHaveCount(0);
	});

	test('a history request held past 5 s shows the error with Retry, which recovers', async ({
		page
	}) => {
		await gotoHydrated(page, `${HISTORY}/${latest.workoutId}`);
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(HISTORY_API, async (route) => {
			await held;
			await route.abort().catch(() => {});
		});
		await page.getByTestId('workout-detail').getByTestId('exercise-history-open').click();
		await expect(sheet(page).getByTestId('exercise-history-loading')).toBeVisible();
		const error = sheet(page).getByTestId('exercise-history-error');
		await page.waitForTimeout(4_000);
		await expect(error, 'still waiting before 5 s').toHaveCount(0);
		await expect(error).toBeVisible({ timeout: 5_000 });

		await page.unrouteAll({ behavior: 'ignoreErrors' });
		release();
		await error.getByRole('button', { name: 'Retry' }).click();
		await expectBothSessions(page);
	});
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test('opened from the History detail it is a dialog over the split view; it pages by keyboard, with hover and focus states', async ({
		page
	}, testInfo) => {
		// Six sessions of four sets: a first page of 20 sets, and Show older for the rest.
		const now = Date.now();
		const all = Array.from({ length: 6 }, (_, n) =>
			squatWorkout(now - (n + 1) * DAY, [
				[100 + n, 5, 8],
				[100 + n, 5, 8],
				[100 + n, 5, 8],
				[100 + n, 5, 8]
			])
		);
		await sync(
			page,
			all.flatMap((w) => w.mutations)
		);
		await gotoHydrated(page, `${HISTORY}/${all[0]!.workoutId}`);
		const open = page.getByTestId('workout-detail').getByTestId('exercise-history-open');

		const colour = () => open.evaluate((el) => getComputedStyle(el).color);
		const resting = await colour();
		await open.hover();
		await expect.poll(colour).not.toBe(resting);
		await page.mouse.move(720, 880);

		for (let i = 0; i < 40 && !(await open.evaluate((el) => el === document.activeElement)); i++) {
			await page.keyboard.press('Tab');
		}
		await expect(open).toBeFocused();
		expect(await open.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
		expect(await open.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');

		await page.keyboard.press('Enter');
		const dialog = page.getByRole('dialog', { name: all[0]!.name });
		await expect(dialog).toBeVisible();
		await expect(sessions(page)).toHaveCount(5); // 20 sets: five sessions of four
		await expect(page.getByTestId('workout-row').first()).toBeAttached();
		const box = await sheet(page).locator('.sheet').boundingBox();
		expect(box!.width, 'a dialog, never a stretched phone sheet').toBeLessThanOrEqual(512);
		expect(box!.y + box!.height, 'clear of the window’s bottom edge').toBeLessThan(900);
		await expectNoSideScroll(page);
		await captureScreen(page, testInfo, 'desktop-exercise-history');

		const more = sheet(page).getByTestId('history-older');
		for (let i = 0; i < 40 && !(await more.evaluate((el) => el === document.activeElement)); i++) {
			await page.keyboard.press('Tab');
		}
		await expect(more).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(sessions(page)).toHaveCount(6);
		await expect(sessions(page).nth(5).getByTestId('history-set')).toHaveCount(4);
		await expect(more).toHaveCount(0);

		await page.keyboard.press('Escape');
		await expect(dialog).toBeHidden();
		await expect(open).toBeFocused();
	});
});
