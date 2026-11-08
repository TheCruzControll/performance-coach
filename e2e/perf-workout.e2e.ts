/**
 * The workout screen's riskiest UX claim, measured (PRD §7–§8, M4 criterion 3): a set is logged in
 * one tap and shows as done in under 100 ms, even on a slow phone. Under DevTools 4× CPU
 * throttling, 20 sets of the shared kit fixture (the superset included) are logged with real taps
 * on the steppers, the RPE chips and Complete set, with sync running against the real endpoint,
 * so every number includes the flusher's work. Gates:
 * - pc:set-confirmed (Logger.svelte: from the tap to the frame that shows the row done):
 *   p95 < 100 ms, with the median and every sample annotated;
 * - INP ≤ 200 ms, from Event Timing over the steppers, the chips and Complete set, and the
 *   web-vitals INP the app beaconed for route_id '/workout' (read from Postgres once the page is
 *   hidden, idle first, so the beacon the page sends first carries it);
 * - layout shift 0 while logging: every shift from the steppers, the chips, Complete set and what
 *   they change (the rows, the logger's next set, Up next after an exercise's last set), input or
 *   not, each one's sources in the message. Starting the next exercise, which swaps the screen's
 *   content by design, is measured apart and annotated;
 * - /workout's main-thread blocking on a reload the service worker controls, with the workout
 *   active: median of 5 ≤ 250 ms (target 200), measured as perf.e2e.ts measures every screen.
 * Its own file in the perf project (playwright.config.ts), so perf.e2e.ts stays M3's. Never raise
 * a threshold without a measured reason recorded in docs/performance.md.
 */
import { expect, test, type Page } from '@playwright/test';
import type { KitExercise, StrengthKit } from '../src/lib/domain/workout';
import { inp } from './inp';
import { resetPrograms } from './program-support';
import { query } from './support';
import { gotoWorkout, seedWorkout, workoutDay } from './workout-support';

/** Tap to the frame that shows the set done (M4 criterion 3). */
const CONFIRM_P95_MS = 100;
/** Web Vitals' "good" INP. */
const INP_MS = 200;
/** web-vitals reports no INP while every interaction is shorter than this (its durationThreshold). */
const WEB_VITALS_THRESHOLD_MS = 40;
/** perf.e2e.ts's main-thread target and guard, for /workout's reload. */
const BLOCKING_TARGET_MS = 200;
const BLOCKING_GUARD_MS = 250;
const LOADS = 5;
/** Every exercise of the fixture at four sets: 20 sets to log. */
const SETS_EACH = 4;
const SETS = 5 * SETS_EACH;

/** The interactions Event Timing INP is read over. */
const LOGGING_KINDS = ['stepper', 'chip', 'complete-set'] as const;

interface Interaction {
	id: number;
	duration: number;
	kind: (typeof LOGGING_KINDS)[number] | 'start' | 'other';
}

interface LayoutShift {
	value: number;
	startTime: number;
	sources: { node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }[];
}

/** A layout shift, when it happened and what moved. */
interface Shift {
	value: number;
	at: number;
	sources: string[];
}

let kit: StrengthKit;
test.beforeAll(async () => {
	const { strength } = await workoutDay();
	// Ad hoc, so sync lands in Postgres (the fixture's planned session is not in this database), and
	// every exercise at four sets: the fixture's last set, repeated.
	const four = (slot: KitExercise): KitExercise => ({
		...slot,
		plannedLineage: null,
		sets: Array.from({ length: SETS_EACH }, (_, i) => slot.sets[i] ?? slot.sets.at(-1)!)
	});
	kit = {
		...strength,
		plannedLineage: null,
		plannedSessionId: null,
		programId: null,
		exercises: strength.exercises.map(four)
	};
	expect(kit.exercises.reduce((sum, slot) => sum + slot.sets.length, 0)).toBe(SETS);
});

test.afterAll(() => resetPrograms());

const logger = (page: Page) => page.getByTestId('set-logger');
const heading = (page: Page) =>
	page.getByTestId('workout-main').getByTestId('exercise').getByRole('heading', { level: 2 });
const increase = (page: Page, field: 'logger-load' | 'logger-amount') =>
	logger(page)
		.getByTestId(field)
		.getByRole('button', { name: /^Increase / });
const decrease = (page: Page, field: 'logger-amount') =>
	logger(page)
		.getByTestId(field)
		.getByRole('button', { name: /^Decrease / });

/** Records Event Timing interactions (by what was tapped) and layout shifts, from the start. */
function observe() {
	const interactions: Interaction[] = [];
	const shifts: Shift[] = [];
	const kindOf = (target: Node | null): Interaction['kind'] => {
		const el = target instanceof Element ? target : null;
		if (el?.closest('[data-testid="complete-set"]')) return 'complete-set';
		if (el?.closest('[data-testid="rpe-chips"]')) return 'chip';
		if (el?.closest('[data-testid="logger-load"], [data-testid="logger-amount"]')) return 'stepper';
		if (el?.closest('[data-testid="up-next"]')) return 'start';
		return 'other';
	};
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries() as PerformanceEventTiming[]) {
			if (!entry.interactionId) continue;
			interactions.push({
				id: entry.interactionId,
				duration: entry.duration,
				kind: kindOf(entry.target)
			});
		}
	}).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries() as unknown as LayoutShift[])
			shifts.push({
				value: entry.value,
				at: entry.startTime,
				sources: entry.sources.map(({ node, previousRect: a, currentRect: b }) => {
					const el = node instanceof Element ? node : node?.parentElement;
					const at = (r: DOMRectReadOnly) => `${Math.round(r.x)},${Math.round(r.y)}`;
					return `${el?.closest('[data-testid]')?.getAttribute('data-testid')} .${el?.getAttribute('class')} ${at(a)} → ${at(b)}`;
				})
			});
	}).observe({ type: 'layout-shift', buffered: true });
	Object.assign(window, { __interactions: interactions, __shifts: shifts });
}

const round = (ms: number) => Math.round(ms * 10) / 10;

const now = (page: Page) => page.evaluate(() => performance.now());

/** Two frames: whatever the last change laid out has been painted and observed. */
const painted = (page: Page) =>
	page.evaluate(
		() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
	);

/** Waits until `count` sets have been confirmed on screen (Logger's pc:set-confirmed). */
const confirmed = (page: Page, count: number) =>
	page.waitForFunction((n) => performance.getEntriesByName('pc:set-confirmed').length >= n, count);

/**
 * One set, with real taps: the amount stepper up and back down, an RPE chip, then Complete set.
 * `weigh` first taps the load up once, for an RPE-picked load the logger leaves at 0. Returns the
 * taps, every one a logging interaction.
 */
async function logOne(page: Page, done: number, { weigh = false } = {}): Promise<number> {
	if (weigh) await increase(page, 'logger-load').click();
	await increase(page, 'logger-amount').click();
	await decrease(page, 'logger-amount').click();
	await logger(page).getByRole('radio', { name: '9', exact: true }).click();
	await logger(page).getByTestId('complete-set').click();
	await confirmed(page, done + 1);
	return weigh ? 5 : 4;
}

test.describe('workout screen at 4× CPU', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CPU throttling uses CDP');

	test(`20 sets logged with real taps: confirmed p95 < ${CONFIRM_P95_MS} ms, INP ≤ ${INP_MS} ms, no layout shift`, async ({
		page
	}, testInfo) => {
		test.setTimeout(180_000);
		const { since } = (await query<{ since: Date }>('select now() as since'))[0]!;
		await page.addInitScript(observe);
		const workoutId = await seedWorkout(page, kit);
		await gotoWorkout(page, 'strength', { sync: 'real' });
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await expect(logger(page)).toBeVisible();
		// From here on: what logging shifts, not what loading did.
		await page.evaluate(() => {
			(window as unknown as { __shifts: unknown[] }).__shifts.length = 0;
		});
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

		let done = 0;
		// Every logging tap: the INP denominator, since the observer omits the fast ones.
		let taps = 0;
		// Starting the next exercise swaps the card and the logger by design: navigation, not logging.
		const moves: [number, number][] = [];
		for (const [position, slot] of kit.exercises.entries()) {
			const name = slot.exercise.name;
			// The superset's A2 is logged in turn with A1, which moves to it after each of its sets.
			if (slot.superset !== null && position > 0 && kit.exercises[position - 1]!.superset) continue;
			if (position > 0) {
				await painted(page);
				const from = await now(page);
				await page
					.getByTestId('up-next')
					.getByRole('button', { name: `Start ${name}` })
					.click();
				await expect(heading(page)).toHaveText(name);
				await expect(logger(page).getByTestId('complete-set')).toBeVisible();
				await painted(page);
				moves.push([from, await now(page)]);
			}
			const rounds = slot.superset === null ? 1 : 2;
			for (let set = 0; set < SETS_EACH * rounds; set += 1) {
				// A weighted exercise with no history starts at 0 (the leg press and the Romanian
				// deadlift): its first set taps a weight in; the next ones keep it.
				const weigh = set === 0 && slot.exercise.loadType === 'external' && slot.previous === null;
				taps += await logOne(page, done, { weigh });
				done += 1;
			}
		}
		expect(done).toBe(SETS);

		// Sync ran against the real endpoint all along: every set lands in Postgres.
		await expect
			.poll(
				async () =>
					(
						await query<{ count: number }>(
							`select count(*)::int as count from set_records s join workouts w on w.id = s.workout_id
							where w.client_id = $1 and s.deleted_at is null`,
							[workoutId]
						)
					)[0]!.count,
				{ timeout: 20_000 }
			)
			.toBe(SETS);

		const samples = await page.evaluate(() =>
			performance.getEntriesByName('pc:set-confirmed').map((entry) => entry.duration)
		);
		const { interactions, shifts } = await page.evaluate(() => ({
			interactions: (window as unknown as { __interactions: Interaction[] }).__interactions,
			shifts: (window as unknown as { __shifts: Shift[] }).__shifts
		}));
		await expect(page.locator('html')).toHaveAttribute('data-rum', 'ready');

		expect(samples).toHaveLength(SETS);
		const sorted = [...samples].sort((a, b) => a - b);
		const median = (sorted[SETS / 2 - 1]! + sorted[SETS / 2]!) / 2;
		const p95 = sorted[Math.ceil(0.95 * SETS) - 1]!;
		testInfo.annotations.push({
			type: 'set confirmed (ms)',
			description: `median ${round(median)} · p95 ${round(p95)} · samples ${samples.map(round).join(', ')}`
		});

		const logging = interactions.filter((i) =>
			(LOGGING_KINDS as readonly string[]).includes(i.kind)
		);
		const eventInp = inp(logging, taps);
		const byKind = [...LOGGING_KINDS, 'start', 'other'].map((kind) => {
			const of = interactions.filter((i) => i.kind === kind);
			return `${kind} ${new Set(of.map((i) => i.id)).size}× max ${round(Math.max(0, ...of.map((i) => i.duration)))}`;
		});
		testInfo.annotations.push({
			type: 'Event Timing INP (ms)',
			description: `${round(eventInp)} over ${taps} interactions (${new Set(logging.map((i) => i.id)).size} over 16 ms) · ${byKind.join(' · ')}`
		});
		const moving = (s: Shift) => moves.some(([from, to]) => s.at >= from && s.at <= to);
		const whileLogging = shifts.filter((s) => !moving(s));
		const shifted = whileLogging.reduce((sum, s) => sum + s.value, 0);
		const moved = shifts.filter(moving).reduce((sum, s) => sum + s.value, 0);
		const what = whileLogging.flatMap((s) => s.sources).join(' · ');
		testInfo.annotations.push({
			type: 'layout shift',
			description: `${shifted} while logging${what && ` (${what})`} · ${moved} starting the next exercise`
		});

		// web-vitals reads the interactions an observer delivers in an idle callback, and the app
		// queues INP as it changes: two idle periods on, the first beacon at hide carries it.
		await painted(page);
		await page.evaluate(async () => {
			for (let i = 0; i < 2; i++)
				await new Promise((done) => requestIdleCallback(done, { timeout: 2_000 }));
		});
		// Hidden: the app beacons its web-vitals INP for /workout.
		await page.goto('/robots.txt');
		const beaconed = async () =>
			(
				await query<{ value: number }>(
					`select value from web_vitals where name = 'INP' and route_id = '/workout'
					and recorded_at >= $1 order by recorded_at desc limit 1`,
					[since]
				)
			)[0]?.value;
		const longest = Math.max(0, ...logging.map((i) => i.duration));
		// web-vitals stays silent while every interaction is under its threshold (rounded to 8 ms).
		const expectBeacon = longest >= WEB_VITALS_THRESHOLD_MS + 8;
		let rum: number | undefined;
		if (expectBeacon) {
			await expect.poll(beaconed, { timeout: 10_000 }).toBeDefined();
			rum = await beaconed();
		} else {
			await page.waitForTimeout(2_000);
			rum = await beaconed();
		}
		testInfo.annotations.push({
			type: 'web-vitals INP (ms)',
			description:
				rum === undefined
					? `none beaconed: every interaction under ${WEB_VITALS_THRESHOLD_MS} ms`
					: `${round(rum)} (route_id /workout)`
		});

		expect(p95, `set confirmed: ${samples.map(round).join(', ')} ms`).toBeLessThan(CONFIRM_P95_MS);
		expect(eventInp, byKind.join(' · ')).toBeLessThanOrEqual(INP_MS);
		if (rum !== undefined) expect(rum).toBeLessThanOrEqual(INP_MS);
		expect(shifted, `layout shift while logging: ${what}`).toBe(0);
	});

	test(`/workout blocks the main thread ≤ ${BLOCKING_GUARD_MS} ms on a service-worker reload with a workout active`, async ({
		page
	}, testInfo) => {
		test.setTimeout(120_000);
		await page.goto('/workout');
		await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
			timeout: 15_000
		});
		await seedWorkout(page, kit);
		await page.addInitScript(() => {
			const tasks: number[] = [];
			Object.assign(window, { __longTasks: tasks });
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) tasks.push(entry.duration);
			}).observe({ type: 'longtask', buffered: true });
		});
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

		const samples: number[] = [];
		for (let i = 0; i < LOADS; i++) {
			await page.reload({ waitUntil: 'load' });
			await page.waitForTimeout(1_500);
			const { tasks, controlled } = await page.evaluate(() => ({
				tasks: (window as unknown as { __longTasks: number[] }).__longTasks,
				controlled: navigator.serviceWorker.controller !== null
			}));
			expect(controlled, 'the service worker controls the reload').toBe(true);
			// The workout is the active one, restored from the device.
			await expect(heading(page)).toHaveText(kit.exercises[0]!.exercise.name);
			samples.push(tasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0));
		}
		samples.sort((a, b) => a - b);
		const median = samples[Math.floor(samples.length / 2)]!;
		const status =
			median <= BLOCKING_TARGET_MS ? 'meets target' : `above the ${BLOCKING_TARGET_MS} ms target`;
		testInfo.annotations.push({
			type: 'blocking time (ms)',
			description: `median ${Math.round(median)} (${status}) · runs ${samples.map(Math.round).join(', ')}`
		});
		expect(median, `/workout reload: ${samples.map(Math.round).join(', ')} ms`).toBeLessThanOrEqual(
			BLOCKING_GUARD_MS
		);
	});
});
