/**
 * Finishing a workout on /workout (WorkoutMenu, FinishSheet, Summary, the Shell's completed state
 * and fix/workout.ts), against the real server:
 * - Once a set is logged, a visible Finish sits at the end of the title's line, before the
 *   stopwatch and the More button, whose menu keeps Finish workout; it opens the same finish, and
 *   nothing in the header moves when it arrives.
 * - Finish with planned sets still open asks first; the summary shows the best set's e1RM as M1
 *   estimates it, marked estimated, a PR only above the kit's best, and the plank's seconds, not
 *   volume; the session RPE, the notes and the stopwatch's duration are stored; Done opens the
 *   History detail; Train and Today show the session as Done.
 * - On a slow connection Done shows the summary at once and never jumps late: the server held
 *   past Done's wait, 'View in History' once the sync confirms, and the page stays put.
 * - (Chromium) offline, Done shows the completed state, which an offline reload keeps; back
 *   online it syncs, 'View in History' opens the detail, and the workout is listed once.
 * - A replayed finish completes once; a refused finish is fixed from the summary and lands once.
 * - Discard abandons a workout, synced or not: an unsynced one reaches Postgres abandoned.
 * - axe in both themes, the screens, and the desktop dialog by keyboard, hovered and focused.
 * Serial: programs, workouts and the profile are the one owner's (resetTrainingProfile).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { SYNC_URL } from '../src/lib/client/workout/sync';
import { estimateOneRepMax } from '../src/lib/domain/e1rm';
import { formatWeight } from '../src/lib/domain/units';
import type {
	LoggedSet,
	Mutation,
	StrengthKit,
	SyncRequest,
	SyncResponse
} from '../src/lib/domain/workout';
import { createMutation } from '../src/lib/domain/workout/mutations';
import { boxOf, DESKTOP, expectNoSideScroll } from './desktop';
import { PROGRAM_TZ } from './program-support';
import { captureScreen, query, resetTrainingProfile, SAME_ORIGIN } from './support';
import {
	gotoWorkout,
	historyAfterDone,
	injectMutation,
	readOutbox,
	seedWorkout,
	workoutDay
} from './workout-support';
import { startFromKit } from './workout-start-support';

test.use({ timezoneId: PROGRAM_TZ });

test.beforeEach(async () => {
	await resetTrainingProfile();
});

const DAY = 24 * 60 * 60 * 1000;

const menuButton = (page: Page) => page.getByTestId('workout-menu-button');
const menu = (page: Page) => page.getByTestId('workout-menu');
const sheet = (page: Page) => page.getByTestId('finish-sheet');
const summary = (page: Page) => page.getByTestId('workout-summary');
const pill = (page: Page) => page.getByTestId('sync-pill');
const headerFinish = (page: Page) => page.getByTestId('header-finish');
const synced = (page: Page) => expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);

const SET: LoggedSet = {
	reps: null,
	seconds: null,
	metres: null,
	weight: null,
	assistance: null,
	unit: 'kg',
	rpe: null,
	missedReps: 0,
	isWarmup: false,
	isExtra: false
};

/** The id of the catalogue exercise with this key. */
async function exerciseId(key: string): Promise<string> {
	const [row] = await query<{ id: string }>(
		'select id from exercises where owner_id is null and key = $1',
		[key]
	);
	if (!row) throw new Error(`no catalogue exercise '${key}'`);
	return row.id;
}

/** A finished ad-hoc workout yesterday, one set of each, through the real sync API. */
async function history(page: Page, sets: { key: string; weight: number; reps: number }[]) {
	const workoutId = crypto.randomUUID();
	const at = (minutes: number) => new Date(Date.now() - DAY + minutes * 60_000).toISOString();
	const mutations: Mutation[] = [
		createMutation('workout.start', {
			workoutId,
			at: at(0),
			payload: {
				kind: 'strength',
				title: 'Earlier',
				sessionType: 'strength',
				discipline: 'strength',
				plannedSessionId: null,
				plannedLineage: null,
				programId: null
			}
		})
	];
	for (const [i, { key, weight, reps }] of sets.entries()) {
		mutations.push(
			createMutation('set.log', {
				workoutId,
				at: at(5 + i),
				payload: {
					position: i + 1,
					plannedLineage: null,
					setIndex: 1,
					exerciseId: await exerciseId(key),
					...SET,
					weight,
					reps,
					rpe: 8
				}
			})
		);
	}
	mutations.push(createMutation('workout.finish', { workoutId, at: at(30), payload: {} }));
	const response = await page.request.post(SYNC_URL, {
		headers: SAME_ORIGIN,
		data: { v: 1, mutations } satisfies SyncRequest
	});
	expect(response.status()).toBe(200);
	const { results } = (await response.json()) as SyncResponse;
	expect(results.every((r) => r.status === 'applied')).toBe(true);
}

/** A set of the kit's exercise `key`, as the logger would send it. */
function setOf(
	kit: StrengthKit,
	workoutId: string,
	key: string,
	index: number,
	values: Partial<LoggedSet>
) {
	const slot = kit.exercises.find((e) => e.exercise.key === key)!;
	return createMutation('set.log', {
		workoutId,
		at: new Date().toISOString(),
		payload: {
			position: slot.position,
			plannedLineage: slot.plannedLineage,
			setIndex: index,
			exerciseId: slot.exercise.id,
			...SET,
			...values
		}
	});
}

const workoutRow = async (clientId: string) =>
	(
		await query<{
			status: string;
			session_rpe: number | null;
			notes: string | null;
			duration_s: number | null;
			finished_at: Date | null;
		}>(
			`select status, session_rpe::float8 as session_rpe, notes, duration_s, finished_at
			   from workouts where client_id = $1`,
			[clientId]
		)
	)[0];

const finishes = async (clientId: string) =>
	(
		await query<{ n: number }>(
			`select count(*)::int as n from sync_mutations
			  where workout_client_id = $1 and type = 'workout.finish'`,
			[clientId]
		)
	)[0]!.n;

/** Opens Finish from the header's menu. */
async function openFinish(page: Page) {
	await menuButton(page).click();
	await expect(menu(page)).toBeVisible();
	await menu(page).getByTestId('menu-finish').click();
	await expect(sheet(page)).toBeVisible();
}

/** Picks the session RPE in the summary. */
const pickRpe = (page: Page, value: number) =>
	sheet(page)
		.getByRole('radio', { name: String(value), exact: true })
		.check();

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

/** The kit's planned sets, every exercise's. */
const plannedSets = (kit: StrengthKit) => kit.exercises.reduce((n, e) => n + e.sets.length, 0);

/** An ad-hoc copy of the fixture's strength kit: its planned session is not in this database. */
async function adHocKit(): Promise<StrengthKit> {
	const { strength } = await workoutDay();
	return {
		...strength,
		plannedLineage: null,
		plannedSessionId: null,
		programId: null,
		exercises: strength.exercises.map((e) => ({ ...e, plannedLineage: null }))
	};
}

test.describe('finishing a workout', () => {
	test('asks first, then the summary: estimated e1RM, PRs above the best, the plank in seconds; Done stores it and opens History; Train and Today say Done', async ({
		page,
		request
	}, testInfo) => {
		const started = await startFromKit(page, request, {
			before: () =>
				history(page, [
					{ key: 'back_squat', weight: 100, reps: 5 },
					{ key: 'leg_press', weight: 200, reps: 10 }
				])
		});
		const kit = started.kit as StrengthKit;
		const { workoutId, session } = started;
		expect(kit.units.weight).toBe('kg');
		const logged = [
			setOf(kit, workoutId, 'back_squat', 1, { weight: 110, reps: 5, rpe: 8 }),
			setOf(kit, workoutId, 'leg_press', 1, { weight: 150, reps: 10, rpe: 8 }),
			setOf(kit, workoutId, 'romanian_deadlift', 1, { weight: 100, reps: 5, rpe: 8 }),
			setOf(kit, workoutId, 'plank', 1, { seconds: 45 }),
			setOf(kit, workoutId, 'plank', 2, { seconds: 45 })
		];
		for (const m of logged) await injectMutation(page, m);
		await synced(page);

		await openFinish(page);
		const open = plannedSets(kit) - logged.length;
		await expect(sheet(page).getByRole('heading', { name: 'Finish workout?' })).toBeVisible();
		await expect(sheet(page)).toContainText(`${open} planned sets are still open`);
		await captureScreen(page, testInfo, 'workout-finish');
		await audit(page, 'the question');
		await sheet(page).getByTestId('keep-going').click();
		await expect(sheet(page)).toBeHidden();

		await openFinish(page);
		await sheet(page).getByTestId('finish-anyway').click();
		await expect(summary(page)).toBeVisible();

		const exercise = (name: string) =>
			summary(page).getByTestId('summary-exercise').filter({ hasText: name });
		const rdl = estimateOneRepMax({ weight: 100, reps: 5, rpe: 8 })!.value;
		await expect(exercise('Romanian deadlift')).toContainText(
			`100 kg × 5 · Estimated 1RM ${formatWeight(rdl, 'kg')} · First time`
		);
		const prs = summary(page).getByTestId('summary-pr');
		await expect(prs).toHaveCount(2);
		await expect(prs.nth(0)).toContainText('New estimated best · Back squat');
		await expect(prs.nth(0)).toContainText(/Estimated 1RM [\d.,]+ kg, was [\d.,]+ kg/);
		await expect(prs.nth(1)).toContainText('New best for its reps · Back squat');
		await expect(prs.nth(1)).toContainText('5 reps at 110 kg, was 100 kg');
		await expect(prs.filter({ hasText: 'Leg press' })).toHaveCount(0);
		await expect(summary(page)).not.toContainText(/record/i);
		await expect(exercise('Plank')).toContainText('2 sets · 1:30');
		await expect(exercise('Plank')).not.toContainText('kg');
		await expect(exercise('Leg press')).toContainText('1 set · 1,500 kg');

		await pickRpe(page, 8);
		await sheet(page).getByTestId('summary-notes').fill('Squats moved well');
		await captureScreen(page, testInfo, 'workout-summary');
		await audit(page, 'the summary');
		await sheet(page).getByTestId('finish-done').click();

		await historyAfterDone(page);
		await expect(page).toHaveURL(new RegExp(`/progress/workouts/${workoutId}$`));
		await expect(page.getByTestId('workout-detail')).toBeVisible();
		await expect(page.getByTestId('workout-notes')).toContainText('Squats moved well');
		const row = (await workoutRow(workoutId))!;
		expect(row).toMatchObject({ status: 'completed', session_rpe: 8, notes: 'Squats moved well' });
		// The stopwatch ran from the seeded start, 5 minutes before the page opened.
		expect(row.duration_s).toBeGreaterThanOrEqual(5 * 60);
		expect(row.duration_s).toBeLessThan(20 * 60);
		expect(await finishes(workoutId)).toBe(1);

		const card = (from: Page) =>
			from.locator(`[data-testid="session-card"][href$="/train/session/${session.lineage}"]`);
		await page.goto('/train');
		await expect(card(page)).toHaveAttribute('data-status', 'completed');
		await expect(card(page)).toContainText('Done');
		// Today lists the day's sessions once onboarding is done (the seeded program skips it).
		await query('update athlete_profiles set onboarding_completed_at = now()');
		await page.goto('/today');
		await expect(card(page).first()).toHaveAttribute('data-status', 'completed');
	});

	test('a visible Finish once a set is logged, beside the menu that keeps it', async ({
		page,
		request
	}) => {
		await startFromKit(page, request);
		await expect(menuButton(page)).toBeVisible();
		await expect(headerFinish(page)).toHaveCount(0);
		const header = page.getByTestId('workout-header');
		const title = header.getByRole('heading', { level: 1 });
		const stopwatch = header.getByTestId('stopwatch');
		const [headerBefore, titleBefore] = [await boxOf(header), await boxOf(title)];
		const [clockBefore, moreBefore] = [await boxOf(stopwatch), await boxOf(menuButton(page))];

		// The first set works up to a weight with none suggested: it logs once a weight is in.
		const logger = page.getByTestId('set-logger');
		await logger
			.getByTestId('logger-load')
			.getByRole('button', { name: /^Increase / })
			.click();
		await logger.getByTestId('complete-set').click();
		await expect(headerFinish(page)).toBeVisible();
		await expect(headerFinish(page)).toHaveText('Finish');
		await expect(headerFinish(page)).toBeInViewport();
		await expectNoSideScroll(page);
		// The title keeps to its one line, so the header (and the page under it) never moves.
		const [headerAfter, titleAfter] = [await boxOf(header), await boxOf(title)];
		expect(Math.abs(headerAfter.height - headerBefore.height)).toBeLessThanOrEqual(1);
		expect(Math.abs(titleAfter.height - titleBefore.height)).toBeLessThanOrEqual(1);
		// It takes the title's room, never the stopwatch's: the stopwatch and More stay put.
		const [clockAfter, moreAfter] = [await boxOf(stopwatch), await boxOf(menuButton(page))];
		expect(Math.abs(clockAfter.x - clockBefore.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(moreAfter.x - moreBefore.x)).toBeLessThanOrEqual(1);
		// Apart, so Finish's widened hit area never reaches over the stopwatch's.
		const own = await boxOf(headerFinish(page));
		expect(clockAfter.x - (own.x + own.width)).toBeGreaterThanOrEqual(8);

		// The menu keeps Finish workout.
		await menuButton(page).click();
		await expect(menu(page).getByTestId('menu-finish')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(menu(page)).toBeHidden();

		await headerFinish(page).click();
		await expect(sheet(page)).toBeVisible();
		await expect(sheet(page).getByRole('heading', { name: 'Finish workout?' })).toBeVisible();
	});

	test('a replayed finish completes once', async ({ page, request }) => {
		const { workoutId } = await startFromKit(page, request);
		const sent: Mutation[] = [];
		page.on('request', (r) => {
			if (r.method() === 'POST' && r.url().endsWith(SYNC_URL)) {
				sent.push(...(r.postDataJSON() as SyncRequest).mutations);
			}
		});
		await openFinish(page);
		await sheet(page).getByTestId('finish-anyway').click();
		await sheet(page).getByTestId('finish-done').click();
		await historyAfterDone(page);
		await expect(page).toHaveURL(new RegExp(`/progress/workouts/${workoutId}$`));
		const finish = sent.find((m) => m.type === 'workout.finish')!;
		expect(finish).toBeDefined();
		const before = (await workoutRow(workoutId))!;

		const response = await page.request.post(SYNC_URL, {
			headers: SAME_ORIGIN,
			data: { v: 1, mutations: [finish] } satisfies SyncRequest
		});
		const { results } = (await response.json()) as SyncResponse;
		expect(results.map((r) => r.status)).toEqual(['duplicate']);
		expect(await workoutRow(workoutId)).toEqual(before);
		expect(await finishes(workoutId)).toBe(1);
	});

	test('a refused finish opens the summary with the error from Fix, and the corrected one lands once', async ({
		page
	}) => {
		const kit = await adHocKit();
		const workoutId = await seedWorkout(page, kit);
		await gotoWorkout(page, 'strength', { sync: 'real' });
		await synced(page);

		// Injected as another tab's dispatch would leave it: a session RPE no chip offers.
		const refused = createMutation('workout.finish', {
			workoutId,
			at: new Date().toISOString(),
			payload: { sessionRpe: 11, durationSeconds: 1800, notes: 'Too keen' }
		});
		await injectMutation(page, refused);
		await expect(summary(page)).toBeVisible();
		await expect(pill(page)).toContainText(/attention/);
		await pill(page).click();
		await page.getByTestId('sync-sheet').getByTestId('fix-change').click();

		await expect(sheet(page).getByRole('heading', { name: 'Fix the summary' })).toBeVisible();
		await expect(sheet(page).getByTestId('fix-reason')).toBeVisible();
		await expect(sheet(page)).toContainText('RPE between 1 and 10, in half steps');
		await expect(sheet(page).getByTestId('summary-notes')).toHaveValue('Too keen');
		await pickRpe(page, 8);
		await sheet(page).getByTestId('save-fix').click();

		await synced(page);
		expect(await workoutRow(workoutId)).toMatchObject({
			status: 'completed',
			session_rpe: 8,
			notes: 'Too keen',
			duration_s: 1800
		});
		expect(await finishes(workoutId)).toBe(1);
		await expect(summary(page).getByTestId('view-in-history')).toBeVisible();
	});
});

test.describe('on a slow connection', () => {
	// The finish's sync is held with page.route: WebKit's page.route misses a controlled page's
	// requests.
	test.use({ serviceWorkers: 'block' });

	test('Done shows the summary at once and never jumps late: View in History once the sync confirms', async ({
		page,
		request
	}) => {
		const { workoutId } = await startFromKit(page, request);
		let lift!: () => void;
		const lifted = new Promise<void>((resolve) => (lift = resolve));
		const held: Route[] = [];
		await page.route(`**${SYNC_URL}`, async (route) => {
			const body = route.request().postDataJSON() as SyncRequest | null;
			if (body?.mutations.some((m) => m.type === 'workout.finish')) {
				held.push(route);
				await lifted;
			}
			await route.continue().catch(() => {});
		});

		await openFinish(page);
		await sheet(page).getByTestId('finish-anyway').click();
		await pickRpe(page, 7);
		await sheet(page).getByTestId('finish-done').click();

		// The local summary at once, while the server has not answered.
		await expect(summary(page).getByTestId('summary-saved-here')).toHaveText(
			'Saved on this device — syncing now.'
		);
		await expect(summary(page).getByTestId('summary-rpe')).toHaveText('Session RPE 7');
		await expect.poll(() => held.length).toBe(1);
		// Held well past Done's wait (about 300 ms), then the server answers.
		await page.waitForTimeout(1_000);
		await expect(page).toHaveURL(/\/workout$/);
		lift();

		const view = summary(page).getByTestId('view-in-history');
		await expect(view).toBeVisible({ timeout: 15_000 });
		await expect(summary(page).getByTestId('summary-synced')).toBeVisible();
		expect((await workoutRow(workoutId))!.status).toBe('completed');
		// A late jump would land here, as the sync confirms: the page stays on the summary.
		await page.waitForTimeout(500);
		await expect(page).toHaveURL(/\/workout$/);

		await view.click();
		await page.waitForURL(`**/progress/workouts/${workoutId}`);
		await expect(page.getByTestId('workout-detail')).toBeVisible();
		expect(await finishes(workoutId)).toBe(1);
	});
});

test.describe('finished offline', () => {
	// Playwright emulates offline for service-worker traffic only in Chromium.
	test.skip(({ browserName }) => browserName !== 'chromium', 'offline emulation is Chromium-only');

	test('Done shows the completed state, an offline reload keeps it, and back online it syncs once, with View in History', async ({
		page,
		request,
		context
	}, testInfo) => {
		await page.goto('/workout');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		const { workoutId } = await startFromKit(page, request);

		await context.setOffline(true);
		await page.waitForFunction(() => !navigator.onLine);
		await openFinish(page);
		await sheet(page).getByTestId('finish-anyway').click();
		await pickRpe(page, 7);
		await sheet(page).getByTestId('finish-done').click();

		const saved = summary(page).getByTestId('summary-saved-here');
		await expect(saved).toHaveText("Saved on this device — it syncs when you're back online.");
		await expect(summary(page).getByTestId('back-to-today')).toBeVisible();
		await expect(summary(page).getByTestId('view-in-history')).toHaveCount(0);
		await expect(page).toHaveURL(/\/workout$/);

		await page.goto('/workout');
		await expect(page.locator('main#main[data-ready]')).toBeAttached();
		await expect(saved).toBeVisible();
		await expect(summary(page).getByTestId('summary-rpe')).toHaveText('Session RPE 7');
		await captureScreen(page, testInfo, 'workout-completed-offline');
		await audit(page, 'the completed state, offline');
		expect(await query('select status from workouts where client_id = $1', [workoutId])).toEqual([
			{ status: 'in_progress' }
		]);

		await context.setOffline(false);
		const view = summary(page).getByTestId('view-in-history');
		await expect(view).toBeVisible({ timeout: 15_000 });
		expect((await workoutRow(workoutId))!.status).toBe('completed');
		await view.click();
		await page.waitForURL(`**/progress/workouts/${workoutId}`);
		await expect(page.getByTestId('workout-detail')).toBeVisible();
		await expect(
			page.locator(`[data-testid="workout-row"][href$="/progress/workouts/${workoutId}"]`)
		).toHaveCount(1);
		await expect(page.getByTestId('workout-waiting')).toHaveCount(0);
		expect(await finishes(workoutId)).toBe(1);
	});
});

test.describe('discarding a workout', () => {
	test('a synced workout is abandoned on the server', async ({ page, request }, testInfo) => {
		const { workoutId } = await startFromKit(page, request);
		await menuButton(page).click();
		await menu(page).getByTestId('menu-discard').click();
		await expect(menu(page).getByTestId('discard-consequence')).toHaveText(
			'Discarding keeps it in your history as abandoned. It never shows as done.'
		);
		await expect(menu(page).getByTestId('keep-workout')).toBeFocused();
		await captureScreen(page, testInfo, 'workout-discard');
		await audit(page, 'the discard question');
		await menu(page).getByTestId('confirm-discard').click();

		await expect(page.getByTestId('workout-empty')).toBeVisible();
		await expect
			.poll(async () => (await workoutRow(workoutId))?.status, { timeout: 15_000 })
			.toBe('abandoned');
	});

	test.describe('before it syncs', () => {
		// The sync is held with page.route: WebKit's page.route misses a controlled page's requests.
		test.use({ serviceWorkers: 'block' });

		test('an unsynced workout is abandoned, never left in progress in Postgres', async ({
			page
		}) => {
			const workoutId = await seedWorkout(page, await adHocKit());
			// Held here, and aborted before the hold lifts: WebKit sends a request still held when
			// its route goes, which would reach the server after the discard.
			const held: Route[] = [];
			await page.route('**/api/workouts/**', (route) => void held.push(route));
			await gotoWorkout(page, 'strength', { sync: 'real' });
			await expect(page.locator('main#main[data-store]')).toBeAttached();
			await menuButton(page).click();
			await menu(page).getByTestId('menu-discard').click();
			// Its start may already have reached the server, so it is abandoned, not deleted.
			await expect(menu(page).getByTestId('discard-consequence')).toHaveText(
				'Discarding keeps it in your history as abandoned. It never shows as done.'
			);
			await menu(page).getByTestId('confirm-discard').click();
			await expect(page.getByTestId('workout-empty')).toBeVisible();

			for (const route of held.splice(0)) await route.abort().catch(() => {});
			await page.unroute('**/api/workouts/**');
			await page.reload();
			await expect(page.locator('main#main[data-store]')).toBeAttached();
			await synced(page);
			expect((await workoutRow(workoutId))?.status).toBe('abandoned');
		});
	});
});

test.describe('on a desktop window', () => {
	test.use(DESKTOP);

	test('the visible Finish sits beside the More button, with hover and focus states', async ({
		page,
		request
	}) => {
		const { kit, workoutId } = await startFromKit(page, request);
		await injectMutation(
			page,
			setOf(kit as StrengthKit, workoutId, 'back_squat', 1, { weight: 100, reps: 5, rpe: 8 })
		);
		const finish = headerFinish(page);
		await expect(finish).toBeVisible();
		const [own, more] = [await boxOf(finish), await boxOf(menuButton(page))];
		expect(own.x + own.width).toBeLessThanOrEqual(more.x);
		expect(Math.abs(own.y + own.height / 2 - (more.y + more.height / 2))).toBeLessThanOrEqual(2);

		const background = () => finish.evaluate((el) => getComputedStyle(el).backgroundColor);
		const resting = await background();
		await finish.hover();
		await expect.poll(background).not.toBe(resting);
		await page.mouse.move(0, 0);

		await menuButton(page).focus();
		await page.keyboard.press('Shift+Tab');
		await expect(finish).toBeFocused();
		expect(await finish.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
		await page.keyboard.press('Enter');
		await expect(sheet(page)).toBeVisible();
		await expectNoSideScroll(page);
	});

	test('the summary is a centred dialog at the readable width, its RPE and notes by keyboard, with hover and focus states', async ({
		page
	}, testInfo) => {
		await seedWorkout(page, await adHocKit());
		await gotoWorkout(page, 'strength', { sync: 'real' });
		await synced(page);

		await menuButton(page).focus();
		await page.keyboard.press('Enter');
		await expect(menu(page)).toBeVisible();
		await menu(page).getByTestId('menu-finish').focus();
		await page.keyboard.press('Enter');
		await sheet(page).getByTestId('finish-anyway').focus();
		await page.keyboard.press('Enter');
		await expect(summary(page)).toBeVisible();

		// The summary's own sheet, once it has risen: the menu's may still be closing under it.
		const panel = sheet(page).locator('.sheet');
		await expect.poll(() => panel.evaluate((el) => el.getAnimations().length)).toBe(0);
		const [dialog, window] = [await boxOf(panel), await boxOf(sheet(page))];
		expect(dialog.width).toBeLessThanOrEqual(40 * 16);
		expect(
			Math.abs(dialog.x + dialog.width / 2 - (window.x + window.width / 2))
		).toBeLessThanOrEqual(2);
		await expectNoSideScroll(page);

		// The chips are one radio group: the arrows move the choice.
		await sheet(page).getByRole('radio', { name: '6', exact: true }).focus();
		await page.keyboard.press('Space');
		await page.keyboard.press('ArrowRight');
		await expect(sheet(page).getByRole('radio', { name: '7', exact: true })).toBeChecked();
		const notes = sheet(page).getByTestId('summary-notes');
		await notes.focus();
		await page.keyboard.type('Typed at the desk');
		await expect(notes).toHaveValue('Typed at the desk');

		const done = sheet(page).getByTestId('finish-done');
		await done.hover();
		await captureScreen(page, testInfo, 'desktop-workout-summary-hover');
		await done.focus();
		await page.keyboard.press('Shift+Tab');
		await page.keyboard.press('Tab');
		await expect(done).toBeFocused();
		expect(await done.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
		await captureScreen(page, testInfo, 'desktop-workout-summary');
		await audit(page, 'the desktop summary');
	});
});
