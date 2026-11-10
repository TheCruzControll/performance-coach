/**
 * Workout History (src/routes/(app)/progress/workouts/[[id]]): every completed workout newest
 * first, 20 at a time, each opening its detail: every set with its RPE and its skipped, extra and
 * missed marks, the best e1RM labelled estimated, substitutions, pain notes, a run's segments and
 * a session's metrics. Finished workouts this device has not synced yet sit on top as 'Waiting to
 * sync'. Empty, not-found, failed-load and offline states are designed. At 1440 × 900 the list
 * sits beside the selected workout's detail on the same route.
 *
 * Workouts are seeded through the real sync API with the page's request context (its cookie and
 * Origin), as a device would send them. Serial: workouts are the one owner's, and every test
 * starts from none (resetTrainingProfile truncates them).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DB_NAME, STORES } from '../src/lib/client/workout/names';
import type {
	LoggedSet,
	Mutation,
	MutationInput,
	MutationType,
	StartKit,
	StrengthKit,
	SyncResponse
} from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { DESKTOP, expectNoSideScroll } from './desktop';
import {
	captureScreen,
	gotoHydrated,
	resetTrainingProfile,
	SAME_ORIGIN,
	trackConsoleErrors
} from './support';
import { type WorkoutDayKits } from '../tests/fixtures/workout-day';
import { seedWorkout, workoutDay } from './workout-support';

const HISTORY = '/progress/workouts';
const DAY = 24 * 60 * 60 * 1000;

let kits: WorkoutDayKits;
test.beforeAll(async () => {
	kits = await workoutDay();
});
test.beforeEach(async () => {
	await resetTrainingProfile();
});

/** Ad hoc: the fixture's planned sessions are not in this database. */
const adHoc = <K extends StartKit>(kit: K): K => ({
	...kit,
	plannedSessionId: null,
	plannedLineage: null,
	programId: null
});

/** A workout's mutations, each `at` a minute after the one before, from `startedAt`. */
function workout(kit: StartKit, startedAt: number) {
	const workoutId = crypto.randomUUID();
	let at = startedAt;
	const mutations: Mutation[] = [];
	const add = <T extends MutationType>(
		type: T,
		input: Omit<MutationInput<T>, 'workoutId' | 'at'>
	) => {
		mutations.push(
			createMutation(type, {
				workoutId,
				at: new Date(at).toISOString(),
				...input
			} as MutationInput<T>)
		);
		at += 60_000;
	};
	const { kind, title, sessionType, discipline } = kit;
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
	return { workoutId, mutations, add };
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
		expect(results.map((r) => `${r.status} ${r.code ?? ''}`.trim())).toEqual(
			batch.map(() => 'applied')
		);
	}
}

const SET: LoggedSet = {
	reps: 5,
	seconds: null,
	metres: null,
	weight: 100,
	assistance: null,
	unit: 'kg',
	rpe: null,
	missedReps: 0,
	isWarmup: false,
	isExtra: false
};

/** A strength workout: a squat warm-up, a set with RPE and a missed rep, a skip and an extra set; a swap; a pain report. */
function strengthWorkout(startedAt: number) {
	const kit = adHoc(kits.strength) as StrengthKit;
	const slot = (key: string) => kit.exercises.find((e) => e.exercise.key === key)!;
	const squat = slot('back_squat');
	const press = slot('leg_press');
	const rdl = slot('romanian_deadlift');
	const w = workout(kit, startedAt);
	const at = { position: squat.position, plannedLineage: null, exerciseId: squat.exercise.id };
	w.add('set.log', { payload: { ...at, setIndex: 1, ...SET, weight: 60, isWarmup: true } });
	w.add('set.log', { payload: { ...at, setIndex: 2, ...SET, rpe: 8, missedReps: 1 } });
	w.add('set.skip', { payload: { ...at, setIndex: 3, unit: 'kg' } });
	w.add('set.log', {
		payload: { ...at, setIndex: 4, ...SET, weight: 90, reps: 8, rpe: 9, isExtra: true }
	});
	w.add('exercise.substitute', {
		payload: {
			position: press.position,
			plannedLineage: null,
			fromExerciseId: press.exercise.id,
			toExerciseId: rdl.exercise.id,
			reason: 'equipment_unavailable'
		}
	});
	w.add('set.log', {
		payload: {
			position: press.position,
			plannedLineage: null,
			exerciseId: rdl.exercise.id,
			setIndex: 1,
			...SET,
			weight: 80,
			reps: 8,
			rpe: 7
		}
	});
	w.add('pain.report', {
		payload: {
			...at,
			area: 'knee',
			severity: 'mild',
			action: 'stopped',
			substitutionId: null,
			note: 'Twinge at the bottom'
		}
	});
	w.add('workout.finish', {
		payload: { sessionRpe: 8, durationSeconds: 3000, notes: 'Felt strong' }
	});
	return {
		...w,
		names: { squat: squat.exercise.name, press: press.exercise.name, rdl: rdl.exercise.name }
	};
}

function runWorkout(startedAt: number) {
	const w = workout(adHoc(kits.run), startedAt);
	const none = { avgHr: null, rpe: null };
	w.add('run.segment', {
		payload: { position: 1, kind: 'warm_up', distanceMetres: 1000, durationSeconds: 360, ...none }
	});
	w.add('run.segment', {
		payload: { position: 2, kind: 'interval', distanceMetres: 400, durationSeconds: 96, ...none }
	});
	w.add('run.log', {
		payload: { distanceMetres: 1400, durationSeconds: 456, avgHr: 150, rpe: 8, notes: null }
	});
	w.add('workout.finish', { payload: {} });
	return w;
}

function classWorkout(startedAt: number) {
	const w = workout(adHoc(kits.other), startedAt);
	w.add('other.log', {
		payload: {
			kind: 'class',
			durationMinutes: 60,
			rpe: 8,
			metrics: [{ key: 'rounds', label: 'Rounds', unit: null, value: 6 }],
			notes: null
		}
	});
	w.add('workout.finish', { payload: {} });
	return w;
}

const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const rows = (page: Page) => page.getByTestId('workout-row');
const detail = (page: Page) => page.getByTestId('workout-detail');
const rowFor = (page: Page, workoutId: string) =>
	page.locator(`[data-testid="workout-row"][href="${HISTORY}/${workoutId}"]`);

/** Count layout shifts that no input explains (CLS), where the browser reports them. */
async function watchShifts(page: Page) {
	await page.addInitScript(() => {
		const shifts: number[] = [];
		Object.assign(window, { __shifts: shifts });
		if (!PerformanceObserver.supportedEntryTypes.includes('layout-shift')) return;
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries() as (PerformanceEntry & {
				value: number;
				hadRecentInput: boolean;
			})[]) {
				if (!entry.hadRecentInput) shifts.push(entry.value);
			}
		}).observe({ type: 'layout-shift', buffered: true });
	});
}
const shifts = (page: Page) =>
	page.evaluate(() => (window as unknown as { __shifts: number[] }).__shifts);

/** axe on `path` in the dark and the light theme. */
async function auditThemes(page: Page, path: string) {
	for (const theme of ['dark', 'light'] as const) {
		await page.evaluate(
			(t) => localStorage.setItem('pc:prefs:v1', JSON.stringify({ theme: t })),
			theme
		);
		await gotoHydrated(page, path);
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(400); // entrance transitions settle: contrast on final colours
		const { violations } = await new AxeBuilder({ page })
			.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
			.analyze();
		const found = violations.flatMap((v) =>
			v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')} — ${n.failureSummary}`)
		);
		expect(found, `axe, ${theme}`).toEqual([]);
	}
}

test.describe('with a strength workout, a run and a Muay Thai class synced', () => {
	let strength: ReturnType<typeof strengthWorkout>;
	let run: ReturnType<typeof runWorkout>;
	let thai: ReturnType<typeof classWorkout>;

	test.beforeEach(async ({ page }) => {
		const now = Date.now();
		thai = classWorkout(now - 3 * DAY);
		run = runWorkout(now - 2 * DAY);
		strength = strengthWorkout(now - DAY);
		await sync(page, [...thai.mutations, ...run.mutations, ...strength.mutations]);
	});

	test('Progress links to History, which lists the synced workouts newest first', async ({
		page
	}, testInfo) => {
		const errors = trackConsoleErrors(page);
		await watchShifts(page);
		await gotoHydrated(page, '/progress');
		await page.getByTestId('workout-history-row').click();
		await expect(heading(page)).toHaveText('History');
		await expect(page).toHaveURL(/\/progress\/workouts$/);

		await expect(rows(page)).toHaveCount(3);
		await expect(rows(page).nth(0)).toHaveAttribute('href', `${HISTORY}/${strength.workoutId}`);
		await expect(rows(page).nth(0)).toContainText(kits.strength.title);
		await expect(rows(page).nth(0)).toContainText('3 sets');
		await expect(rows(page).nth(0)).toContainText('50 min');
		await expect(rows(page).nth(1)).toContainText('1.4 km');
		await expect(rows(page).nth(2)).toContainText(kits.other.title);
		await expect(page.getByTestId('show-older')).toHaveCount(0);
		await expect(page.getByTestId('history-empty')).toHaveCount(0);
		await captureScreen(page, testInfo, 'history-list');

		expect(await shifts(page), 'layout shifts no input explains').toEqual([]);
		expect(errors).toEqual([]);
		await auditThemes(page, HISTORY);
	});

	test('a strength workout shows every set with its RPE and marks, the estimated e1RM, the swap and the pain note', async ({
		page
	}, testInfo) => {
		await watchShifts(page);
		await gotoHydrated(page, HISTORY);
		await rowFor(page, strength.workoutId).click();
		await expect(page).toHaveURL(`${HISTORY}/${strength.workoutId}`);
		const shown = detail(page);
		await expect(shown.getByRole('heading', { name: kits.strength.title })).toBeFocused();

		const squat = shown.getByTestId('workout-exercise').filter({ hasText: strength.names.squat });
		await expect(squat.getByTestId('workout-set')).toHaveText([
			/Warm-up\s*60 kg × 5/,
			/Set 2\s*100 kg × 5\s*RPE 8\s*1 missed/,
			/Set 3\s*Not done\s*Skipped/,
			/Set 4\s*90 kg × 8\s*RPE 9\s*Extra set/
		]);
		await expect(squat.getByTestId('best-e1rm')).toHaveText(/^Estimated 1RM · [\d.]+ kg$/);
		await expect(shown.getByTestId('workout-substitutions')).toContainText(
			`${strength.names.press} → ${strength.names.rdl} · Equipment busy or missing`
		);
		await expect(shown.getByTestId('workout-pain')).toContainText(
			`${strength.names.squat} · Knee · Mild · Stopped the exercise`
		);
		await expect(shown.getByTestId('workout-pain')).toContainText('Twinge at the bottom');
		await expect(shown.getByTestId('workout-notes')).toContainText('Felt strong');
		await captureScreen(page, testInfo, 'history-detail');
		expect(await shifts(page), 'layout shifts no input explains').toEqual([]);

		// A phone shows the list and the detail as separate screens.
		await expect(page.getByTestId('workout-row').first()).toBeHidden();
		await page.getByTestId('back-to-list').click();
		await expect(rows(page)).toHaveCount(3);
		await expect(detail(page)).toHaveCount(0);
		await auditThemes(page, `${HISTORY}/${strength.workoutId}`);
	});

	test('a run shows its segments with pace, and a Muay Thai class its metrics', async ({
		page
	}) => {
		await gotoHydrated(page, `${HISTORY}/${run.workoutId}`);
		await expect(detail(page).getByTestId('workout-segment')).toHaveText([
			/1\. Warm-up\s*1 km · 6:00 · 6:00 \/km/,
			/2\. Interval\s*0\.4 km · 1:36 · 4:00 \/km/
		]);
		await expect(detail(page).getByTestId('workout-stats')).toContainText('150 bpm');

		await gotoHydrated(page, `${HISTORY}/${thai.workoutId}`);
		await expect(detail(page)).toContainText('Class ·');
		await expect(detail(page).getByTestId('workout-metrics')).toContainText(/Rounds\s*6/);
		await expect(detail(page).getByTestId('workout-exercise')).toHaveCount(0);
	});

	test.describe('on a desktop window', () => {
		test.use(DESKTOP);

		test('the list sits beside the detail; a row opens its workout and keeps the list and focus', async ({
			page
		}, testInfo) => {
			await gotoHydrated(page, HISTORY);
			await expectNoSideScroll(page);
			await expect(page.getByTestId('pick-workout')).toContainText('Pick a workout');

			const first = rowFor(page, strength.workoutId);
			const border = () => first.evaluate((el) => getComputedStyle(el).borderColor);
			const resting = await border();
			await first.hover();
			await expect.poll(border).not.toBe(resting);
			await page.mouse.move(720, 880);

			for (let i = 0; i < 20 && !(await first.evaluate((a) => a === document.activeElement)); i++) {
				await page.keyboard.press('Tab');
			}
			await expect(first).toBeFocused();
			expect(await first.evaluate((a) => a.matches(':focus-visible'))).toBe(true);
			expect(await first.evaluate((a) => getComputedStyle(a).outlineStyle)).toBe('solid');

			await page.keyboard.press('Enter');
			await expect(page).toHaveURL(`${HISTORY}/${strength.workoutId}`);
			await expect(detail(page)).toBeVisible();
			await expect(first).toBeFocused();
			await expect(first).toHaveAttribute('aria-current', 'page');
			await expect(rows(page)).toHaveCount(3);
			const list = await rows(page).first().boundingBox();
			const shown = await detail(page).boundingBox();
			expect(list!.x + list!.width, 'the list is left of the detail').toBeLessThanOrEqual(shown!.x);
			expect(Math.abs(list!.y - shown!.y), 'side by side').toBeLessThan(80);
			await expectNoSideScroll(page);
			await captureScreen(page, testInfo, 'desktop-history-detail');

			await rowFor(page, run.workoutId).click();
			await expect(detail(page).getByTestId('workout-segment')).toHaveCount(2);
			await expect(rowFor(page, run.workoutId)).toHaveAttribute('aria-current', 'page');
			await expect(first).not.toHaveAttribute('aria-current');

			await page.goBack();
			await expect(page).toHaveURL(`${HISTORY}/${strength.workoutId}`);
			await expect(first).toHaveAttribute('aria-current', 'page');
			await expect(detail(page).getByTestId('workout-exercise').first()).toBeVisible();
			await page.goForward();
			await expect(rowFor(page, run.workoutId)).toHaveAttribute('aria-current', 'page');
			await expect(detail(page).getByTestId('workout-segment')).toHaveCount(2);
		});
	});
});

test('with nothing finished, History is empty, with no way to open a workout', async ({
	page
}, testInfo) => {
	await gotoHydrated(page, HISTORY);
	await expect(page.getByTestId('history-empty')).toContainText('No workouts yet');
	await expect(rows(page)).toHaveCount(0);
	await expect(page.locator('main a[href^="/workout"]')).toHaveCount(0);
	await captureScreen(page, testInfo, 'history-empty');
	await auditThemes(page, HISTORY);
});

test('an unknown or malformed id is the 404 page, in the shell', async ({ page }) => {
	for (const path of [`${HISTORY}/${crypto.randomUUID()}`, `${HISTORY}/sample`, `${HISTORY}/1`]) {
		const response = await page.goto(path);
		expect(response?.status(), path).toBe(404);
		await expect(page.getByTestId('error-view'), path).toHaveAttribute('data-kind', 'not-found');
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
	}
});

test.describe('22 workouts', () => {
	// page.route never sees a request from a page the service worker controls on WebKit.
	test.use({ serviceWorkers: 'block' });

	test('are paged as 20, then 2 from Show older, which is busy while it loads', async ({
		page
	}) => {
		const now = Date.now();
		const all = Array.from({ length: 22 }, (_, n) => classWorkout(now - (n + 1) * DAY));
		await sync(
			page,
			all.flatMap((w) => w.mutations)
		);
		await gotoHydrated(page, HISTORY);
		await expect(rows(page)).toHaveCount(20);

		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		await page.route(
			(url) => url.pathname === `${HISTORY}/__data.json` && url.searchParams.has('before'),
			async (route) => {
				await held;
				await route.continue();
			}
		);
		const older = page.getByTestId('show-older');
		await older.click();
		await expect(older).toHaveAttribute('aria-busy', 'true');
		await expect(older).toBeDisabled();
		release();
		await expect(rows(page)).toHaveCount(22);
		await expect(rows(page).nth(21)).toHaveAttribute('href', `${HISTORY}/${all[21]!.workoutId}`);
		await expect(older).toHaveCount(0);
	});
});

test.describe('with the network in the test’s hands', () => {
	// page.route never sees a request from a page the service worker controls on WebKit.
	test.use({ serviceWorkers: 'block' });

	test('a finished workout on this device, not synced yet, is on top as Waiting to sync', async ({
		page
	}) => {
		const strength = strengthWorkout(Date.now() - DAY);
		await sync(page, strength.mutations);
		// Nothing on this device may reach the server: the waiting workout stays waiting.
		await page.route('**/api/workouts/**', () => {});
		const workoutId = await seedWorkout(page, adHoc(kits.other), { startedMinutesAgo: 30 });
		await page.evaluate(
			async ({ name, store, workoutId }) => {
				const db = await new Promise<IDBDatabase>((resolve, reject) => {
					const request = indexedDB.open(name);
					request.onsuccess = () => resolve(request.result);
					request.onerror = () => reject(request.error);
				});
				const workouts = db.transaction(store, 'readwrite').objectStore(store);
				const record = await new Promise<Record<string, unknown>>((resolve) => {
					const request = workouts.get(workoutId);
					request.onsuccess = () => resolve(request.result as Record<string, unknown>);
				});
				await new Promise((resolve) => {
					workouts.put({ ...record, status: 'completed', finishedAt: new Date().toISOString() });
					workouts.transaction.oncomplete = resolve;
				});
				db.close();
			},
			{ name: DB_NAME, store: STORES.workouts, workoutId }
		);

		// Hydrated once the resume bar has looked: never networkidle, which the held sync of this
		// workout's pending changes (the bar's engine runs on every tab) keeps from happening.
		await page.goto(HISTORY);
		await expect(
			page.locator(`[data-testid="resume-slot"][data-looked="${HISTORY}"]`)
		).toBeAttached();
		const waiting = page.getByTestId('workout-waiting');
		await expect(waiting).toHaveCount(1);
		await expect(waiting).toContainText(kits.other.title);
		await expect(waiting).toContainText('Waiting to sync');
		await expect(waiting.locator('a')).toHaveCount(0);
		await expect(rows(page)).toHaveCount(1);
		// It is listed first, above the synced workout.
		const [above, below] = [await waiting.boundingBox(), await rows(page).boundingBox()];
		expect(above!.y).toBeLessThan(below!.y);
	});

	test('History whose data fails to load shows the designed error, whose Try again loads it', async ({
		page
	}) => {
		await gotoHydrated(page, '/progress');
		await page.route(`**${HISTORY}/__data.json*`, (route) =>
			route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'Something went wrong on our side.', requestId: 'e2e' })
			})
		);
		await page.getByTestId('workout-history-row').click();
		const error = page.getByTestId('error-view');
		await expect(error).toContainText('Something went wrong');
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

		await page.unrouteAll({ behavior: 'ignoreErrors' });
		await error.getByRole('button', { name: 'Try again' }).click();
		await expect(heading(page)).toHaveText('History');
		await expect(page.getByTestId('history-empty')).toBeVisible();
	});

	test('History whose read fails shows its own error with Retry, which loads it', async ({
		page
	}) => {
		// The load's own soft failure, once: a 200 whose page data is { state: 'error' }, as when the
		// database read fails (devalue's flattened form, in place of the real page node's).
		await gotoHydrated(page, '/progress');
		await page.route(
			`**${HISTORY}/__data.json*`,
			async (route) => {
				const response = await route.fetch();
				const body = (await response.json()) as { nodes: { data: unknown }[] };
				body.nodes.at(-1)!.data = [{ state: 1 }, 'error'];
				await route.fulfill({ response, json: body });
			},
			{ times: 1 }
		);
		await page.getByTestId('workout-history-row').click();
		const card = page.getByTestId('history-error');
		await expect(card).toContainText('Couldn’t load your workouts');
		await card.getByRole('button', { name: 'Retry' }).click();
		await expect(page.getByTestId('history-empty')).toBeVisible();
		await expect(card).toHaveCount(0);
	});

	test('opening History offline shows the designed offline state, never a 500', async ({
		page,
		context
	}) => {
		await gotoHydrated(page, '/progress');
		await context.setOffline(true);
		await page.getByTestId('workout-history-row').click();
		await expect(page.getByTestId('offline-state')).toBeVisible();
		await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
		await expect(page.locator('body')).not.toContainText(/internal error/i);
		await context.setOffline(false);
	});
});
