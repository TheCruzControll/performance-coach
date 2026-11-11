/**
 * The workout screens' riskiest UX claims, measured (PRD §7–§8, M4 criteria 3 and 4): a set is
 * logged in one tap and shows as done in under 100 ms, and every interaction answers within INP's
 * "good" 200 ms, even on a slow phone. Under DevTools 4× CPU throttling, over FIVE fresh loads of
 * /workout (a new page each, the device's workout carried over in IndexedDB), 20 sets of the
 * shared kit fixture (the superset included) are logged with real taps on the steppers, the RPE
 * chips and Complete set, and each load also swipes the exercise card away and back, opens and
 * closes the exercise's options sheet and works the rest timer (+30 s, Pause, Resume, Skip). Sync
 * runs against the real endpoint, so every number includes the flusher's work. Gates:
 * - pc:set-confirmed (Logger.svelte: from the tap to the frame that shows the row done), over the
 *   20 sets: p95 < 100 ms, with the median and every sample annotated;
 * - INP p75 over the loads ≤ 200 ms (M4 criterion 4, read as CrUX reads a page: one INP per load,
 *   then its 75th percentile), from both sources: Event Timing over every interaction of the load,
 *   and the web-vitals INP the app beaconed for route_id '/workout' (read from Postgres once the
 *   page is hidden, idle first, so web-vitals has every interaction when it reports);
 * - layout shift 0 while logging: every shift from the steppers, the chips, Complete set and what
 *   they change (the rows, the logger's next set, Up next after an exercise's last set), input or
 *   not, each one's sources in the message. Starting the next exercise, the swipes, the sheet and
 *   the rest timer change the screen by design: measured apart and annotated;
 * - /workout/run and /workout/session, a shorter run each (steppers, chips or switches, and their
 *   log or save): INP ≤ 200 ms from Event Timing and from web-vitals' row for the route;
 * - /workout's main-thread blocking on a reload the service worker controls, with the workout
 *   active: median of 5 ≤ 250 ms (target 200), measured as perf.e2e.ts measures every screen;
 * - every interaction named by what was tapped (tagged on pointerdown, since Event Timing's target
 *   is null once a sheet's Close, Up next's Start or a swiped card has left the page), none left
 *   unattributed, and the slowest of each load ≤ 200 ms: INP's "good" for every tap, not just
 *   p75 (CI measured 56 ms at worst, run 42977173433, all of it then unattributed);
 * - dropped frames: no frame over 32 ms (two 60 Hz frames: one dropped) while the options sheet
 *   opens and closes, the card is swiped and comes back, and the rest bar runs and is worked,
 *   leaving out the frames a tap was answered in, which the INP gates above hold (e2e/frames.ts).
 *   The Options tap is answered until its sheet starts to move: on a page's first tap the sheet's
 *   chunk loads first, so it mounts after the tap's first paint, where Event Timing has stopped;
 *   that wait is annotated. Only the page's own work is measured: the sheet's motion is awaited by
 *   its transition events, not polled (Playwright's visible and stable checks read the moving
 *   sheet's box every frame, which restyles it on the main thread), and the trace keeps no DOM
 *   snapshots (each is a 15-35 ms task on the page's main thread at 4×, CI run 43023511877).
 * Its own file in the perf project (playwright.config.ts), so perf.e2e.ts stays M3's. Never raise
 * a threshold without a measured reason recorded in docs/performance.md.
 */
import { expect, test, type Page } from '@playwright/test';
import type { KitExercise, StartKit, StrengthKit } from '../src/lib/domain/workout';
import { adHoc } from '../scripts/lib/workout-seed';
import { longFrames } from './frames';
import { attribute, inp, percentile, type Tag } from './inp';
import { resetPrograms } from './program-support';
import { query } from './support';
import { gotoWorkout, seedWorkout, workoutDay } from './workout-support';

/** Tap to the frame that shows the set done (M4 criterion 3). */
const CONFIRM_P95_MS = 100;
/** Web Vitals' "good" INP, at p75 (M4 criterion 4). */
const INP_MS = 200;
/** web-vitals reports no INP while every interaction is shorter than this (its durationThreshold). */
const WEB_VITALS_THRESHOLD_MS = 40;
/** perf.e2e.ts's main-thread target and guard, for /workout's reload. */
const BLOCKING_TARGET_MS = 200;
const BLOCKING_GUARD_MS = 250;
const LOADS = 5;
/** Every exercise of the fixture at four sets: 20 sets to log, four a load. */
const SETS_EACH = 4;
const SETS = 5 * SETS_EACH;
const SETS_PER_LOAD = SETS / LOADS;
/** How far a swipe drags the card: well past swipe.ts's distance threshold. */
const SWIPE_PX = 200;
/** Two 60 Hz frames: a frame longer than this dropped at least one. */
const FRAME_MS = 32;
/** How long the rest bar is watched running, untouched, before its controls: one 1 Hz tick at least. */
const REST_WATCH_MS = 1_100;

/** The interactions logging a set is: layout shift is gated on them. */
const LOGGING_KINDS = ['stepper', 'chip', 'complete-set'] as const;
/** What else a load does: the next exercise, the rest timer, the options sheet and the swipes. */
const OTHER_KINDS = ['start', 'rest', 'sheet', 'swipe', 'other'] as const;
/** The motion the dropped-frame gate watches. */
const MOTION_KINDS = ['sheet', 'swipe', 'rest'] as const;

type Kind = (typeof LOGGING_KINDS)[number] | (typeof OTHER_KINDS)[number];
type Motion = (typeof MOTION_KINDS)[number];

interface Interaction {
	id: number;
	duration: number;
	startTime: number;
	kind: Kind;
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
		sets: Array.from({ length: SETS_EACH }, (_, i) => slot.sets[i] ?? slot.sets.at(-1)!)
	});
	kit = adHoc({ ...strength, exercises: strength.exercises.map(four) });
	expect(kit.exercises.reduce((sum, slot) => sum + slot.sets.length, 0)).toBe(SETS);
});

// Each test's workouts are its own: none left in progress for the next one, or for perf.e2e.ts.
test.beforeEach(() => resetPrograms());
test.afterAll(() => resetPrograms());

const logger = (page: Page) => page.getByTestId('set-logger');
const card = (page: Page) => page.getByTestId('workout-main').getByTestId('exercise');
const heading = (page: Page) => card(page).getByRole('heading', { level: 2 });
const pill = (page: Page) => page.getByTestId('rest-timer');
const sheet = (page: Page) => page.getByTestId('exercise-actions-sheet');
const increase = (page: Page, field: 'logger-load' | 'logger-amount') =>
	logger(page)
		.getByTestId(field)
		.getByRole('button', { name: /^Increase / });
const decrease = (page: Page, field: 'logger-amount') =>
	logger(page)
		.getByTestId(field)
		.getByRole('button', { name: /^Decrease / });

/**
 * Records Event Timing interactions (by what their target is), pointerdown tags (what was tapped,
 * while it is still in the page) and layout shifts, from the start; and animation frames while
 * __frames.start() is on, until __frames.stop() returns them.
 */
function observe() {
	/** A transition of the options sheet itself (BottomSheet's panel, a child of the dialog). */
	const sheetMotion = (event: TransitionEvent) =>
		event.propertyName === 'transform' &&
		event.target instanceof Element &&
		event.target.parentElement?.getAttribute('data-testid') === 'exercise-actions-sheet';
	const interactions: Interaction[] = [];
	const tags: Tag<Kind>[] = [];
	const shifts: Shift[] = [];
	const kindOf = (target: EventTarget | null): Kind => {
		const el = target instanceof Element ? target : null;
		if (el?.closest('[data-testid="complete-set"]')) return 'complete-set';
		if (el?.closest('[data-testid="rpe-chips"]')) return 'chip';
		if (el?.closest('[data-testid="logger-load"], [data-testid="logger-amount"]')) return 'stepper';
		if (el?.closest('[data-testid="up-next"]')) return 'start';
		if (el?.closest('[data-testid="rest-timer"]')) return 'rest';
		if (el?.closest('[data-testid="exercise-actions"], [data-testid="exercise-actions-sheet"]'))
			return 'sheet';
		if (el?.closest('[data-testid="exercise"]')) return 'swipe';
		return 'other';
	};
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries() as PerformanceEventTiming[]) {
			if (!entry.interactionId) continue;
			interactions.push({
				id: entry.interactionId,
				duration: entry.duration,
				startTime: entry.startTime,
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
	// An Event Timing entry's startTime is its event's timeStamp, on the same clock.
	addEventListener(
		'pointerdown',
		(event) => tags.push({ at: event.timeStamp, kind: kindOf(event.target) }),
		{
			capture: true,
			passive: true
		}
	);
	// The Options tap's answer: from its pointerdown to the sheet's first transition (its motion).
	const answers: [number, number][] = [];
	let asked: number | null = null;
	addEventListener(
		'pointerdown',
		(event) => {
			const el = event.target instanceof Element ? event.target : null;
			if (el?.closest('[data-testid="exercise-actions"]')) asked = event.timeStamp;
		},
		{ capture: true, passive: true }
	);
	addEventListener(
		'transitionrun',
		(event) => {
			if (asked === null || !sheetMotion(event)) return;
			answers.push([asked, performance.now()]);
			asked = null;
		},
		{ capture: true, passive: true }
	);
	let recording: { on: boolean; times: number[] } = { on: false, times: [] };
	const frames = {
		start() {
			const now = { on: true, times: [] as number[] };
			recording = now;
			const tick = (at: number) => {
				if (!now.on) return;
				now.times.push(at);
				requestAnimationFrame(tick);
			};
			requestAnimationFrame(tick);
		},
		stop() {
			recording.on = false;
			return recording.times;
		}
	};
	Object.assign(window, {
		__interactions: interactions,
		__tags: tags,
		__answers: answers,
		__shifts: shifts,
		__frames: frames
	});
}

interface Frames {
	start(): void;
	stop(): number[];
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
				// A weighted exercise with no history starts at 0 (the leg press and the Romanian
				// deadlift): its first set taps a weight in; the next ones keep it.
				weigh: set === 0 && slot.exercise.loadType === 'external' && slot.previous === null
			});
		}
	}
	return order;
}

/** A motion's animation frames: their timestamps, one window's worth. */
interface MotionFrames {
	kind: Motion;
	times: number[];
}

/**
 * Runs `action` and records when, painted before and after, so its shifts are told apart. With
 * `motion`, also records its animation frames into `frames`, for the dropped-frame gate, from
 * `watchMs` before the window opens.
 */
async function apart(
	page: Page,
	windows: [number, number][],
	action: () => Promise<void>,
	motion?: { kind: Motion; frames: MotionFrames[]; watchMs?: number }
) {
	await painted(page);
	if (motion)
		await page.evaluate(() => (window as unknown as { __frames: Frames }).__frames.start());
	// Watched for its frames only: a late shift from the step before stays out of this window.
	if (motion?.watchMs) await page.waitForTimeout(motion.watchMs);
	const from = await now(page);
	await action();
	await painted(page);
	if (motion) {
		const times = await page.evaluate(() =>
			(window as unknown as { __frames: Frames }).__frames.stop()
		);
		motion.frames.push({ kind: motion.kind, times });
	}
	windows.push([from, await now(page)]);
}

/**
 * Arms a wait for the end of the options sheet's next motion (its panel's transform transition),
 * for `sheetSettled`: by event, since a poll would read the moving sheet every frame. Armed before
 * the tap that starts the motion; a motion that never ends lets go after 3 s, for the checks after.
 */
const armSheetSettled = (page: Page) =>
	page.evaluate(() => {
		(window as unknown as { __sheetSettled: Promise<void> }).__sheetSettled = new Promise(
			(done) => {
				const ended = (event: TransitionEvent) => {
					if (event.propertyName !== 'transform') return;
					const el = event.target instanceof Element ? event.target : null;
					if (el?.parentElement?.getAttribute('data-testid') !== 'exercise-actions-sheet') return;
					removeEventListener('transitionend', ended, true);
					done();
				};
				addEventListener('transitionend', ended, true);
				setTimeout(done, 3_000);
			}
		);
	});

const sheetSettled = (page: Page) =>
	page.evaluate(() => (window as unknown as { __sheetSettled: Promise<void> }).__sheetSettled);

/** A mouse drag across the card's name, in steps, as a hand would (workout-navigation.e2e.ts). */
async function swipe(page: Page, dx: number) {
	const box = (await heading(page).boundingBox())!;
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + dx, y, { steps: 8 });
	await page.mouse.up();
}

/** Two idle periods on, web-vitals has read every interaction: then the page is hidden. */
async function hide(page: Page) {
	await painted(page);
	await page.evaluate(async () => {
		for (let i = 0; i < 2; i++)
			await new Promise((done) => requestIdleCallback(done, { timeout: 2_000 }));
	});
	// Hidden, with the page kept alive (as platform.e2e.ts hides it), so no navigation races the
	// beacon: the app beacons its web-vitals INP for the route.
	await page.evaluate(() => {
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
	});
}

const dbNow = async () => (await query<{ at: Date }>('select now() as at'))[0]!.at;

/**
 * The web-vitals INP the hidden page beaconed for `route` since `since`, or undefined when its
 * longest interaction was under web-vitals' threshold (rounded to 8 ms), which reports none.
 */
async function beaconedInp(route: string, since: Date, longest: number) {
	const beaconed = async () =>
		(
			await query<{ value: number }>(
				`select value from web_vitals where name = 'INP' and route_id = $1
				and recorded_at >= $2 order by recorded_at desc limit 1`,
				[route, since]
			)
		)[0]?.value;
	if (longest >= WEB_VITALS_THRESHOLD_MS + 8) {
		await expect.poll(beaconed, { timeout: 10_000 }).toBeDefined();
	} else {
		await new Promise((done) => setTimeout(done, 2_000));
	}
	return beaconed();
}

/**
 * What the page observed: its Event Timing interactions, pointerdown tags, layout shifts and the
 * Options taps' answers ([pointerdown, the sheet's first transition], observe()).
 */
const observed = (page: Page) =>
	page.evaluate(() => {
		const w = window as unknown as {
			__interactions: Interaction[];
			__tags: Tag<Kind>[];
			__shifts: Shift[];
			__answers: [number, number][];
		};
		return {
			interactions: w.__interactions,
			tags: w.__tags,
			shifts: w.__shifts,
			answers: w.__answers
		};
	});

/** The interactions, each named by what was tapped (inp.ts attribute). */
function attributed(interactions: Interaction[], tags: Tag<Kind>[]): Interaction[] {
	const kinds = attribute(interactions, tags, 'other');
	return interactions.map((i) => ({ ...i, kind: kinds.get(i.id) ?? i.kind }));
}

/** Opens a workout page against the real server, the store connected, at 4× CPU from here on. */
async function openThrottled(page: Page, kind: StartKit['kind']) {
	await gotoWorkout(page, kind, { sync: 'real' });
	await expect(page.locator('main#main[data-store]')).toBeAttached();
	const cdp = await page.context().newCDPSession(page);
	await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}

test.describe('workout screen at 4× CPU', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CPU throttling uses CDP');
	// A trace's DOM snapshots are taken on the page's main thread at every step: in the frames.
	test.use({ trace: { mode: 'retain-on-failure', snapshots: false } });

	test(`20 sets over ${LOADS} fresh loads, with swipes, sheets and rest controls: confirmed p95 < ${CONFIRM_P95_MS} ms, INP p75 ≤ ${INP_MS} ms and every tap attributed and ≤ ${INP_MS} ms, no layout shift while logging, no dropped frame in the motion`, async ({
		page,
		context
	}, testInfo) => {
		test.setTimeout(360_000);
		await context.addInitScript(observe);
		const workoutId = await seedWorkout(page, kit);
		const order = setsInOrder(kit);
		expect(order).toHaveLength(SETS);

		const samples: number[] = [];
		/** Per load: Event Timing INP, web-vitals INP (or none), and its taps by kind. */
		const eventInps: number[] = [];
		const rumInps: (number | undefined)[] = [];
		const kinds: string[] = [];
		const loggingShifts: Shift[] = [];
		let apartShift = 0;
		/** Per load: its slowest interaction and what it was; and the taps nothing named. */
		const slowest: { kind: Kind; duration: number }[] = [];
		const unattributed: string[] = [];
		/** Per motion: frames watched, the longest of them, and the long ones no tap explains. */
		const motion = new Map(
			MOTION_KINDS.map((kind) => [kind, { frames: 0, longest: 0, dropped: [] as string[] }])
		);
		/** Per load: the Options tap to the frame its sheet starts to move in. */
		const sheetWaits: string[] = [];
		let restTaps = 0;
		let done = 0;
		let current = page;
		for (let load = 0; load < LOADS; load++) {
			// A fresh load: a new page on the same device, which still holds the workout.
			if (load > 0) current = await context.newPage();
			const since = await dbNow();
			await openThrottled(current, 'strength');
			await expect(logger(current).or(current.getByTestId('up-next')).first()).toBeVisible();
			// From here on: what this load's taps shift, not what loading did.
			await current.evaluate(() => {
				(window as unknown as { __shifts: unknown[] }).__shifts.length = 0;
			});
			// Every tap: the INP denominator, since the observer omits the fast ones.
			let taps = 0;
			// What changes the screen by design: navigation, a sheet, the rest timer.
			const windows: [number, number][] = [];
			// The sheet's, the swipes' and the rest bar's animation frames.
			const frames: MotionFrames[] = [];

			// The card swiped to a neighbour and back: the next one, or the previous at the end.
			const name = (await heading(current).textContent())!.trim();
			const last = await current.getByTestId('exercise-next').isDisabled();
			await apart(
				current,
				windows,
				async () => {
					await swipe(current, last ? SWIPE_PX : -SWIPE_PX);
					await expect(heading(current)).not.toHaveText(name);
					await swipe(current, last ? -SWIPE_PX : SWIPE_PX);
					await expect(heading(current)).toHaveText(name);
				},
				{ kind: 'swipe', frames }
			);
			taps += 2;

			for (const [i, set] of order
				.slice(load * SETS_PER_LOAD, (load + 1) * SETS_PER_LOAD)
				.entries()) {
				if (set.start) {
					const next = set.start;
					await apart(current, windows, async () => {
						await current
							.getByTestId('up-next')
							.getByRole('button', { name: `Start ${next}` })
							.click();
						await expect(heading(current)).toHaveText(next);
						await expect(logger(current).getByTestId('complete-set')).toBeVisible();
					});
					taps += 1;
				}
				if (i === 0) {
					// The exercise's options, opened and closed.
					await apart(
						current,
						windows,
						async () => {
							await armSheetSettled(current);
							await card(current).getByTestId('exercise-actions').click();
							await sheetSettled(current);
							await expect(sheet(current)).toBeVisible();
							await armSheetSettled(current);
							await sheet(current).getByRole('button', { name: 'Close' }).click();
							await sheetSettled(current);
							await expect(sheet(current)).toBeHidden();
						},
						{ kind: 'sheet', frames }
					);
					taps += 2;
				}
				// pc:set-confirmed counts this page's sets only.
				taps += await logOne(current, done - load * SETS_PER_LOAD, { weigh: set.weigh });
				done += 1;
				// The rest the set started, watched running, then worked once a load: +30 s, Pause,
				// Resume, Skip.
				if (restTaps < (load + 1) * 4 && (await pill(current).isVisible())) {
					await apart(
						current,
						windows,
						async () => {
							for (const control of ['+30 s', 'Pause rest', 'Resume rest', 'Skip']) {
								await pill(current).getByRole('button', { name: control, exact: true }).click();
							}
							await expect(pill(current)).toHaveCount(0);
						},
						{ kind: 'rest', frames, watchMs: REST_WATCH_MS }
					);
					taps += 4;
					restTaps += 4;
				}
			}

			const confirmations = await current.evaluate(() =>
				performance.getEntriesByName('pc:set-confirmed').map((entry) => entry.duration)
			);
			expect(confirmations).toHaveLength(SETS_PER_LOAD);
			samples.push(...confirmations);
			const seen = await observed(current);
			const { shifts } = seen;
			const interactions = attributed(seen.interactions, seen.tags);
			await expect(current.locator('html')).toHaveAttribute('data-rum', 'ready');

			eventInps.push(inp(interactions, taps));
			const top = interactions.reduce<Interaction | undefined>(
				(max, i) => (max && max.duration >= i.duration ? max : i),
				undefined
			);
			if (top) slowest.push({ kind: top.kind, duration: top.duration });
			for (const id of new Set(interactions.filter((i) => i.kind === 'other').map((i) => i.id)))
				unattributed.push(`load ${load + 1}: interaction ${id}`);
			// A frame a tap was answered in is the INP gates' (frames.ts longFrames).
			const busy = interactions.map((i) => [i.startTime, i.startTime + i.duration] as const);
			for (const { kind, times } of frames) {
				const of = motion.get(kind)!;
				of.frames += Math.max(0, times.length - 1);
				for (let f = 1; f < times.length; f++)
					of.longest = Math.max(of.longest, round(times[f]! - times[f - 1]!));
				// The Options tap is answered until the frame its sheet starts to move in: the last
				// frame begun by its first transition's event (frames begin before their events).
				const answered =
					kind === 'sheet'
						? seen.answers.map(([tap, ran]) => {
								const moving = Math.max(tap, ...times.filter((t) => t <= ran));
								sheetWaits.push(`load ${load + 1}: ${round(moving - tap)}`);
								return [tap, moving] as const;
							})
						: [];
				for (const late of longFrames(times, [...busy, ...answered], FRAME_MS))
					of.dropped.push(`load ${load + 1}: ${late.ms} ms at ${round(late.at)}`);
			}
			kinds.push(
				[...LOGGING_KINDS, ...OTHER_KINDS]
					.map((kind) => {
						const of = interactions.filter((i) => i.kind === kind);
						return `${kind} ${new Set(of.map((i) => i.id)).size}× max ${round(Math.max(0, ...of.map((i) => i.duration)))}`;
					})
					.join(', ')
			);
			const inWindow = (s: Shift) => windows.some(([from, to]) => s.at >= from && s.at <= to);
			loggingShifts.push(...shifts.filter((s) => !inWindow(s)));
			apartShift += shifts.filter(inWindow).reduce((sum, s) => sum + s.value, 0);

			await hide(current);
			const longest = Math.max(0, ...interactions.map((i) => i.duration));
			rumInps.push(await beaconedInp('/workout', since, longest));
			await current.close();
		}
		expect(done).toBe(SETS);
		expect(restTaps, 'the rest timer was worked').toBeGreaterThan(0);

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

		const sorted = [...samples].sort((a, b) => a - b);
		const median = (sorted[SETS / 2 - 1]! + sorted[SETS / 2]!) / 2;
		const p95 = percentile(samples, 0.95);
		testInfo.annotations.push({
			type: 'set confirmed (ms)',
			description: `median ${round(median)} · p95 ${round(p95)} · samples ${samples.map(round).join(', ')}`
		});
		const eventP75 = percentile(eventInps, 0.75);
		testInfo.annotations.push({
			type: 'Event Timing INP (ms)',
			description: `p75 ${round(eventP75)} over ${LOADS} loads · loads ${eventInps.map(round).join(', ')} · ${kinds.map((k, i) => `load ${i + 1}: ${k}`).join(' | ')}`
		});
		// A load whose every interaction was under web-vitals' threshold beaconed none: its INP is
		// under 40 ms, so it counts as 40 (an upper bound) in the p75.
		const rum = rumInps.map((v) => v ?? WEB_VITALS_THRESHOLD_MS);
		const rumP75 = percentile(rum, 0.75);
		testInfo.annotations.push({
			type: 'web-vitals INP (ms)',
			description: `p75 ${round(rumP75)} (route_id /workout) · loads ${rumInps.map((v) => (v === undefined ? `none (< ${WEB_VITALS_THRESHOLD_MS})` : round(v))).join(', ')}`
		});
		testInfo.annotations.push({
			type: 'slowest interaction (ms)',
			description: `${slowest.map((s, i) => `load ${i + 1}: ${s.kind} ${round(s.duration)}`).join(' · ')} · unattributed ${unattributed.length}`
		});
		testInfo.annotations.push({
			type: 'frames (ms)',
			description: [...motion]
				.map(
					([kind, of]) =>
						`${kind}: ${of.frames} frames, longest ${of.longest} (a tap's included), over ${FRAME_MS} with no tap to answer: ${of.dropped.length ? of.dropped.join(', ') : 'none'}`
				)
				.join(' | ')
		});
		testInfo.annotations.push({
			type: 'options sheet: tap to motion (ms)',
			description: sheetWaits.join(' · ')
		});
		const shifted = loggingShifts.reduce((sum, s) => sum + s.value, 0);
		const what = loggingShifts.flatMap((s) => s.sources).join(' · ');
		testInfo.annotations.push({
			type: 'layout shift',
			description: `${shifted} while logging${what && ` (${what})`} · ${apartShift} starting exercises, swiping, the sheet and the rest timer`
		});

		expect(p95, `set confirmed: ${samples.map(round).join(', ')} ms`).toBeLessThan(CONFIRM_P95_MS);
		expect(
			eventP75,
			`Event Timing INP per load: ${eventInps.map(round).join(', ')}`
		).toBeLessThanOrEqual(INP_MS);
		expect(rumP75, `web-vitals INP per load: ${rum.map(round).join(', ')}`).toBeLessThanOrEqual(
			INP_MS
		);
		expect(shifted, `layout shift while logging: ${what}`).toBe(0);
		expect(unattributed, 'every interaction is named by what was tapped').toEqual([]);
		for (const [i, { kind, duration }] of slowest.entries())
			expect(duration, `load ${i + 1}'s slowest interaction (${kind})`).toBeLessThanOrEqual(INP_MS);
		for (const [kind, of] of motion) {
			expect(of.frames, `${kind}: frames were watched`).toBeGreaterThan(0);
			expect(of.dropped, `${kind}: frames over ${FRAME_MS} ms`).toEqual([]);
		}
	});

	for (const [kind, route, interact] of [
		[
			'run',
			'/workout/run',
			async (page: Page) => {
				const entry = page.getByTestId('run-entry');
				const distance = entry.getByTestId('segment-distance');
				// The list shows every planned segment: the ones logged read Done.
				const logged = page.getByTestId('run-segment').filter({ hasText: 'Done' });
				for (let segment = 1; segment <= 3; segment++) {
					await distance.getByRole('button', { name: /^Increase / }).click();
					await distance.getByRole('button', { name: /^Decrease / }).click();
					await entry.getByTestId('log-segment').click();
					await expect(logged).toHaveCount(segment);
				}
				return 9;
			}
		],
		[
			'other',
			'/workout/session',
			async (page: Page) => {
				const entry = page.getByTestId('session-entry');
				const duration = entry.getByTestId('session-duration');
				await duration.getByRole('button', { name: /^Increase / }).click();
				await duration.getByRole('button', { name: /^Decrease / }).click();
				await entry.getByRole('radio', { name: '8', exact: true }).click();
				await entry.getByRole('switch', { name: 'Sparred' }).click();
				await page.getByTestId('save-session').click();
				await expect(page.getByTestId('session-status')).toHaveText(/^Saved/);
				return 5;
			}
		]
	] as const) {
		test(`${route}: its logging taps at INP ≤ ${INP_MS} ms, from Event Timing and web-vitals`, async ({
			page,
			context
		}, testInfo) => {
			test.setTimeout(120_000);
			await context.addInitScript(observe);
			const { run, other } = await workoutDay();
			await seedWorkout(page, adHoc(kind === 'run' ? run : other));
			const since = await dbNow();
			await openThrottled(page, kind);
			const taps = await interact(page);
			const { interactions } = await observed(page);
			await expect(page.locator('html')).toHaveAttribute('data-rum', 'ready');
			const eventInp = inp(interactions, taps);
			await hide(page);
			const longest = Math.max(0, ...interactions.map((i) => i.duration));
			const rum = await beaconedInp(route, since, longest);
			testInfo.annotations.push({
				type: 'INP (ms)',
				description: `Event Timing ${round(eventInp)} over ${taps} interactions · web-vitals ${rum === undefined ? `none beaconed: every interaction under ${WEB_VITALS_THRESHOLD_MS} ms` : `${round(rum)} (route_id ${route})`}`
			});
			expect(eventInp).toBeLessThanOrEqual(INP_MS);
			if (rum !== undefined) expect(rum).toBeLessThanOrEqual(INP_MS);
		});
	}

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
