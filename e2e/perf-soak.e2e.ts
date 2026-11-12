/**
 * A long workout on one page (PRD §7–§8): perf-workout.e2e.ts logs four sets per fresh load, so it
 * never sees what an hour on the same page does. Here one /workout page logs 40 sets of the shared
 * kit fixture (every exercise at eight, the superset in turn) with real taps under DevTools 4× CPU
 * throttling, over about 75 minutes of Playwright's clock: each set synced to the real endpoint,
 * then the clock jumped to the next (the rest timer runs out on its own, or is worked: +30 s,
 * Pause, Resume, Skip, every fifth set). The options sheet opens and closes every other set, 20
 * times in all. Gates:
 * - heap: the JS heap after a full garbage collection (CDP HeapProfiler.collectGarbage, then
 *   Performance.getMetrics) grows ≤ 10% from the warm page (after WARM_SETS sets, once the sheet's,
 *   Up next's and the rest timer's code has loaded) to the end, every sample annotated with the
 *   DOM's node and listener counts, so a leak shows its curve;
 * - INP late in the workout (the last 10 sets, an hour in) within perf-workout.e2e.ts's gate, 200
 *   ms (Web Vitals' "good"), from Event Timing, and the slowest tap then within it too.
 * Playwright's clock replaces `performance` (its marks and entries are no-ops), so neither
 * pc:set-confirmed nor the web-vitals beacon can be read here; perf-workout.e2e.ts gates both.
 * Event Timing (PerformanceObserver is not faked) and CDP measure without the page's clock. Its
 * own file in the perf project (playwright.config.ts). Never raise a threshold without a measured
 * reason recorded in docs/performance.md.
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { KitExercise, StrengthKit } from '../src/lib/domain/workout';
import { adHoc } from '../scripts/lib/workout-seed';
import { heapGrowth, lateInp, type HeapSample, type PhasedEntry } from './soak';
import { resetPrograms } from './program-support';
import { query } from './support';
import { gotoWorkout, readOutbox, seedWorkout, workoutDay } from './workout-support';

/** Web Vitals' "good" INP: perf-workout.e2e.ts's gate, late in the workout too. */
const INP_MS = 200;
/** The most the warm heap may grow by the last set. */
const HEAP_GROWTH = 0.1;
/** Every exercise of the fixture at eight sets: 40 to log. */
const SETS_EACH = 8;
const SETS = 5 * SETS_EACH;
/** About 75 minutes of the clock over the 40 sets: each set's rest and the walk to the next. */
const WORKOUT_MS = 75 * 60_000;
const SET_GAP_MS = Math.round(WORKOUT_MS / SETS);
/** Sets before the heap is warm: the first exercise, the next one started, the sheet and rest worked. */
const WARM_SETS = 10;
/** Heap samples every this many sets from the warm one on. */
const SAMPLE_EVERY = 5;
/** Late in the workout: the interactions from this many sets logged on (an hour in). */
const LATE_FROM = SETS - 10;
/** The options sheet every other set; the rest timer's controls every fifth. */
const SHEET_EVERY = 2;
const REST_EVERY = 5;

let kit: StrengthKit;
test.beforeAll(async () => {
	const { strength } = await workoutDay();
	// Ad hoc, so sync lands in Postgres (the fixture's planned session is not in this database), and
	// every exercise at eight sets: the fixture's last set, repeated.
	const eight = (slot: KitExercise): KitExercise => ({
		...slot,
		sets: Array.from({ length: SETS_EACH }, (_, i) => slot.sets[i] ?? slot.sets.at(-1)!)
	});
	kit = adHoc({ ...strength, exercises: strength.exercises.map(eight) });
	expect(kit.exercises.reduce((sum, slot) => sum + slot.sets.length, 0)).toBe(SETS);
});

test.use({ trace: { mode: 'retain-on-failure', snapshots: false } });
test.beforeEach(() => resetPrograms());
test.afterAll(() => resetPrograms());

const logger = (page: Page) => page.getByTestId('set-logger');
const card = (page: Page) => page.getByTestId('workout-main').getByTestId('exercise');
const heading = (page: Page) => card(page).getByRole('heading', { level: 2 });
const doneRows = (page: Page) =>
	page.getByTestId('workout-main').locator('[data-testid="set"][data-state="done"]');
const pill = (page: Page) => page.getByTestId('rest-timer');
const sheet = (page: Page) => page.getByTestId('exercise-actions-sheet');

/**
 * Records every Event Timing interaction with how many sets were logged when it was reported
 * (window.__set, which the harness moves on once a set has synced, its entries long reported).
 */
function observe() {
	const entries: PhasedEntry[] = [];
	Object.assign(window, { __entries: entries, __set: 0 });
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries() as PerformanceEventTiming[]) {
			if (!entry.interactionId) continue;
			entries.push({
				id: entry.interactionId,
				duration: entry.duration,
				set: (window as unknown as { __set: number }).__set
			});
		}
	}).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
}

/** A set to log, in workout order: the exercise to start first (from Up next), if any. */
interface PlannedSet {
	start: string | null;
	weigh: boolean;
}

/** Every set of the kit in the order the screen asks for them, the superset's in turn. */
function setsInOrder(kit: StrengthKit): PlannedSet[] {
	const order: PlannedSet[] = [];
	for (const [position, slot] of kit.exercises.entries()) {
		// The superset's A2 is logged in turn with A1, which moves to it after each of its sets.
		if (slot.superset !== null && position > 0 && kit.exercises[position - 1]!.superset) continue;
		const rounds = slot.superset === null ? 1 : 2;
		for (let set = 0; set < SETS_EACH * rounds; set += 1) {
			order.push({
				start: position > 0 && set === 0 ? slot.exercise.name : null,
				// A weighted exercise with no history starts at 0: its first set taps a weight in.
				weigh: set === 0 && slot.exercise.loadType === 'external' && slot.previous === null
			});
		}
	}
	return order;
}

/**
 * One set with real taps: the amount up once, an RPE chip, Complete set; `weigh` first taps the
 * load up from 0. Done once the screen shows it: a row more done, or the superset's partner up.
 * Returns the taps.
 */
async function logOne(page: Page, { weigh }: PlannedSet): Promise<number> {
	const name = (await heading(page).textContent())!.trim();
	const done = await doneRows(page).count();
	if (weigh)
		await logger(page)
			.getByTestId('logger-load')
			.getByRole('button', { name: /^Increase / })
			.click();
	await logger(page)
		.getByTestId('logger-amount')
		.getByRole('button', { name: /^Increase / })
		.click();
	await logger(page).getByRole('radio', { name: '9', exact: true }).click();
	await logger(page).getByTestId('complete-set').click();
	await expect
		.poll(
			async () =>
				(await heading(page).textContent())!.trim() !== name ||
				(await doneRows(page).count()) > done
		)
		.toBe(true);
	return weigh ? 4 : 3;
}

/** The page's heap and DOM after a full garbage collection (Performance is enabled on `cdp`). */
async function heapAfterGc(cdp: CDPSession, sets: number): Promise<HeapSample> {
	await cdp.send('HeapProfiler.collectGarbage');
	const { metrics } = await cdp.send('Performance.getMetrics');
	const metric = (name: string) => metrics.find((m) => m.name === name)?.value ?? Number.NaN;
	return {
		sets,
		heapBytes: metric('JSHeapUsedSize'),
		nodes: metric('Nodes'),
		listeners: metric('JSEventListeners')
	};
}

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(2)} MB`;

test.describe('a long workout at 4× CPU', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CPU throttling and heap use CDP');

	test(`${SETS} sets over ${WORKOUT_MS / 60_000} minutes on one page, the sheet opened ${SETS / SHEET_EVERY} times: the heap grows ≤ ${HEAP_GROWTH * 100}% once warm, and the last 10 sets' INP ≤ ${INP_MS} ms`, async ({
		page
	}, testInfo) => {
		test.setTimeout(420_000);
		await page.clock.install();
		await page.addInitScript(observe);
		const workoutId = await seedWorkout(page, kit);
		const order = setsInOrder(kit);
		expect(order).toHaveLength(SETS);

		await gotoWorkout(page, 'strength', { sync: 'real' });
		await expect(page.locator('main#main[data-store]')).toBeAttached();
		await expect(logger(page)).toBeVisible();
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Performance.enable');
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

		const samples: HeapSample[] = [];
		const started = await page.evaluate(() => Date.now());
		/** Every tap from LATE_FROM sets on: the late INP's denominator, fast ones included. */
		let lateTaps = 0;
		let sheets = 0;
		let restWorked = 0;
		for (const [i, set] of order.entries()) {
			let taps = 0;
			if (set.start) {
				await page
					.getByTestId('up-next')
					.getByRole('button', { name: `Start ${set.start}` })
					.click();
				await expect(heading(page)).toHaveText(set.start);
				taps += 1;
			}
			if (i % SHEET_EVERY === 0) {
				await card(page).getByTestId('exercise-actions').click();
				await expect(sheet(page)).toBeVisible();
				await sheet(page).getByRole('button', { name: 'Close' }).click();
				await expect(sheet(page)).toBeHidden();
				taps += 2;
				sheets += 1;
			}
			taps += await logOne(page, set);
			if (i % REST_EVERY === 0 && (await pill(page).isVisible())) {
				for (const control of ['+30 s', 'Pause rest', 'Resume rest', 'Skip'])
					await pill(page).getByRole('button', { name: control, exact: true }).click();
				await expect(pill(page)).toHaveCount(0);
				taps += 4;
				restWorked += 1;
			}
			if (i >= LATE_FROM) lateTaps += taps;
			// The set syncs before the clock moves on, so no request is in flight across the jump.
			await expect.poll(() => readOutbox(page), { timeout: 15_000 }).toEqual([]);
			await page.evaluate((n) => Object.assign(window, { __set: n }), i + 1);
			await page.clock.fastForward(SET_GAP_MS);
			const logged = i + 1;
			if (logged >= WARM_SETS && (logged - WARM_SETS) % SAMPLE_EVERY === 0)
				samples.push(await heapAfterGc(cdp, logged));
		}
		const minutes = ((await page.evaluate(() => Date.now())) - started) / 60_000;
		expect(minutes, 'the clock ran the whole workout').toBeGreaterThanOrEqual(WORKOUT_MS / 60_000);
		expect(sheets).toBe(SETS / SHEET_EVERY);
		expect(restWorked, 'the rest timer was worked').toBeGreaterThan(0);

		// Sync ran against the real endpoint all along: every set lands in Postgres.
		const rows = await query<{ count: number }>(
			`select count(*)::int as count from set_records s join workouts w on w.id = s.workout_id
			where w.client_id = $1 and s.deleted_at is null`,
			[workoutId]
		);
		expect(rows[0]!.count).toBe(SETS);

		const { warm, last, growth } = heapGrowth(samples, WARM_SETS);
		testInfo.annotations.push({
			type: 'heap after GC',
			description: `${(growth * 100).toFixed(1)}% from set ${warm.sets} (${mb(warm.heapBytes)}) to set ${last.sets} (${mb(last.heapBytes)}) over ${Math.round(minutes)} min · ${samples.map((s) => `set ${s.sets}: ${mb(s.heapBytes)}, ${s.nodes} nodes, ${s.listeners} listeners`).join(' · ')}`
		});
		const entries = await page.evaluate(
			() => (window as unknown as { __entries: PhasedEntry[] }).__entries
		);
		const late = lateInp(entries, LATE_FROM, lateTaps);
		const earlySlowest = Math.max(
			0,
			...entries.filter((e) => e.set < WARM_SETS).map((e) => e.duration)
		);
		testInfo.annotations.push({
			type: 'Event Timing INP (ms)',
			description: `last ${SETS - LATE_FROM} sets: INP ${Math.round(late.inp)}, slowest ${Math.round(late.slowest)} over ${lateTaps} taps (${late.interactions} reported) · first ${WARM_SETS} sets: slowest ${Math.round(earlySlowest)}`
		});

		expect(
			growth,
			`heap growth once warm: ${samples.map((s) => mb(s.heapBytes)).join(', ')}`
		).toBeLessThanOrEqual(HEAP_GROWTH);
		expect(late.inp, `INP over the last ${SETS - LATE_FROM} sets`).toBeLessThanOrEqual(INP_MS);
		expect(
			late.slowest,
			`the slowest tap of the last ${SETS - LATE_FROM} sets`
		).toBeLessThanOrEqual(INP_MS);
	});
});
