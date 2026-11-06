import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { MEASURES, MOVEMENT_PATTERNS, SET_ROLES } from '../training/vocabulary';
import {
	addRest,
	DEFAULT_REST_SECONDS,
	FALLBACK_REST_SECONDS,
	pauseRest,
	pauseStopwatch,
	resetRest,
	resetStopwatch,
	REST_STEP_MS,
	restClassOf,
	restDone,
	restFor,
	restOverdue,
	restRemaining,
	resumeRest,
	resumeStopwatch,
	skipRest,
	startRest,
	startStopwatch,
	STOPWATCH_IDLE,
	stopwatchElapsed
} from './timers';
import type { RestClassInput } from './timers';
import type { RestState, StopwatchState } from './types';

/** 18:00 UTC on the device clock; `at(s)` is s seconds later (or earlier, when negative). */
const T0 = Date.UTC(2026, 10, 6, 18, 0, 0);
const sec = (seconds: number) => seconds * 1000;
const at = (seconds: number) => T0 + sec(seconds);

/** What a screen shows of a rest at an instant. */
const reading = (rest: RestState, now: number) => ({
	remaining: restRemaining(rest, now),
	done: restDone(rest, now),
	overdue: restOverdue(rest, now)
});

/** Deep-frozen, so an operation that changes its input throws (modules run in strict mode). */
function frozen<T extends object>(value: T): T {
	for (const field of Object.values(value)) {
		if (field && typeof field === 'object') frozen(field);
	}
	return Object.freeze(value);
}

describe('the rest timer', () => {
	const rest = startRest(T0, sec(120));

	it('counts down from its duration and never below zero', () => {
		expect(rest).toEqual({ startedAt: T0, durationMs: sec(120), pausedAt: null, addedMs: 0 });
		expect(reading(rest, T0)).toEqual({ remaining: sec(120), done: false, overdue: 0 });
		expect(reading(rest, at(45))).toEqual({ remaining: sec(75), done: false, overdue: 0 });
		expect(reading(rest, at(120) - 1)).toEqual({ remaining: 1, done: false, overdue: 0 });
		expect(reading(rest, at(120))).toEqual({ remaining: 0, done: true, overdue: 0 });
		expect(reading(rest, at(600))).toEqual({ remaining: 0, done: true, overdue: sec(480) });
	});

	it('reads done, with how long ago it ended, when it ended while the tab was closed', () => {
		const stored = JSON.stringify(startRest(T0, sec(90)));
		// The tab is reopened 2:12 later: the rest ended 0:42 ago.
		const reopened: RestState = JSON.parse(stored);
		expect(reading(reopened, at(132))).toEqual({ remaining: 0, done: true, overdue: sec(42) });
	});

	it('keeps the remaining time across a pause and a resume', () => {
		const paused = pauseRest(rest, at(30));
		expect(paused.pausedAt).toBe(at(30));
		expect(reading(paused, at(30))).toEqual({ remaining: sec(90), done: false, overdue: 0 });
		// Paused, it stands still, however long the tab stays closed.
		expect(reading(paused, at(3600))).toEqual({ remaining: sec(90), done: false, overdue: 0 });
		// A second pause keeps the first.
		expect(pauseRest(paused, at(60))).toBe(paused);

		const resumed = resumeRest(paused, at(300));
		expect(resumed.pausedAt).toBeNull();
		expect(restRemaining(resumed, at(300))).toBe(sec(90));
		expect(restRemaining(resumed, at(330))).toBe(sec(60));
		expect(reading(resumed, at(390))).toEqual({ remaining: 0, done: true, overdue: 0 });

		// Pauses add up across resumes: 10 s, then 40 s more of the 120 s.
		const twice = resumeRest(
			pauseRest(resumeRest(pauseRest(rest, at(10)), at(20)), at(60)),
			at(90)
		);
		expect(restRemaining(twice, at(90))).toBe(sec(70));

		// Resuming a running rest, or pausing one that is over, changes nothing.
		expect(resumeRest(rest, at(10))).toBe(rest);
		expect(pauseRest(rest, at(150))).toBe(rest);
	});

	it('adds 30 s while running and while paused', () => {
		expect(REST_STEP_MS).toBe(sec(30));

		const running = addRest(rest, at(100));
		expect(running.addedMs).toBe(sec(30));
		expect(reading(running, at(100))).toEqual({ remaining: sec(50), done: false, overdue: 0 });
		expect(restDone(running, at(150))).toBe(true);
		expect(restRemaining(addRest(running, at(100)), at(100))).toBe(sec(80));

		const paused = addRest(pauseRest(rest, at(100)), at(200));
		expect(paused.pausedAt).toBe(at(100));
		expect(restRemaining(paused, at(500))).toBe(sec(50));
		expect(restRemaining(resumeRest(paused, at(600)), at(620))).toBe(sec(30));

		// After it ended the time counts from now, not from when it ended.
		const over = addRest(rest, at(150));
		expect(reading(over, at(150))).toEqual({ remaining: sec(30), done: false, overdue: 0 });
		expect(reading(over, at(185))).toEqual({ remaining: 0, done: true, overdue: sec(5) });
	});

	it('ends now when skipped, and starts over from its duration when reset', () => {
		const skipped = skipRest(rest, at(40));
		expect(reading(skipped, at(40))).toEqual({ remaining: 0, done: true, overdue: 0 });
		expect(restOverdue(skipped, at(50))).toBe(sec(10));
		const pausedThenSkipped = skipRest(pauseRest(rest, at(20)), at(60));
		expect(pausedThenSkipped.pausedAt).toBeNull();
		expect(reading(pausedThenSkipped, at(70))).toEqual({
			remaining: 0,
			done: true,
			overdue: sec(10)
		});
		// A rest that is already over keeps when it ended.
		expect(skipRest(rest, at(200))).toBe(rest);

		const added = addRest(rest, at(100));
		const reset = resetRest(added, at(100));
		expect(reset.durationMs).toBe(sec(120));
		expect(reset.addedMs).toBe(0);
		expect(reading(reset, at(100))).toEqual({ remaining: sec(120), done: false, overdue: 0 });
		expect(restRemaining(reset, at(160))).toBe(sec(60));
		expect(restRemaining(resetRest(skipped, at(50)), at(50))).toBe(sec(120));

		// A paused rest is reset paused, at its whole duration.
		const pausedReset = resetRest(pauseRest(rest, at(30)), at(40));
		expect(restRemaining(pausedReset, at(400))).toBe(sec(120));
		expect(restRemaining(resumeRest(pausedReset, at(400)), at(430))).toBe(sec(90));
	});

	it('never shows more than its duration when the device clock moves backwards', () => {
		const anHourEarlier = at(-3600);
		expect(reading(rest, anHourEarlier)).toEqual({ remaining: sec(120), done: false, overdue: 0 });
		// With 30 s added, its duration is 2:30.
		expect(restRemaining(addRest(rest, T0), anHourEarlier)).toBe(sec(150));

		// Paused, then the clock jumps back: it resumes where it stood.
		const paused = pauseRest(rest, at(30));
		expect(restRemaining(paused, at(-600))).toBe(sec(90));
		const resumed = resumeRest(paused, at(-600));
		expect(restRemaining(resumed, at(-600))).toBe(sec(90));
		expect(restRemaining(resumed, at(-570))).toBe(sec(60));

		// Paused at an instant before it started.
		expect(restRemaining(pauseRest(rest, at(-60)), at(10))).toBe(sec(120));

		for (const offset of [-86_400, -1, 0, 1, 59, 119, 120, 121, 86_400]) {
			const shown = reading(rest, at(offset));
			expect(shown.remaining).toBeGreaterThanOrEqual(0);
			expect(shown.remaining).toBeLessThanOrEqual(rest.durationMs);
			expect(shown.overdue).toBeGreaterThanOrEqual(0);
		}
	});

	it('ignores a duration or an addition that is not a positive number', () => {
		for (const bad of [-sec(30), Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(startRest(T0, bad).durationMs).toBe(0);
			expect(addRest(rest, at(10), bad)).toBe(rest);
		}
		expect(reading(startRest(T0, 0), T0)).toEqual({ remaining: 0, done: true, overdue: 0 });
	});

	it('never changes the rest it is given', () => {
		const stored = frozen(startRest(T0, sec(120)));
		const paused = frozen(pauseRest(stored, at(30)));
		const done = frozen(startRest(T0, sec(10)));
		expect(() => {
			addRest(stored, at(10));
			addRest(paused, at(40));
			addRest(done, at(40));
			resumeRest(paused, at(40));
			resetRest(stored, at(10));
			resetRest(paused, at(40));
			skipRest(stored, at(10));
			skipRest(paused, at(40));
		}).not.toThrow();
		expect(stored).toEqual(startRest(T0, sec(120)));
	});
});

describe('the workout stopwatch', () => {
	const stopwatch = startStopwatch(T0);

	it('adds up its running time across pauses and resumes', () => {
		expect(stopwatch).toEqual({ startedAt: T0, accumulatedMs: 0, runningSince: T0 });
		expect(stopwatchElapsed(stopwatch, at(10))).toBe(sec(10));

		const paused = pauseStopwatch(stopwatch, at(10));
		expect(paused).toEqual({ startedAt: T0, accumulatedMs: sec(10), runningSince: null });
		expect(stopwatchElapsed(paused, at(100))).toBe(sec(10));

		const resumed = resumeStopwatch(paused, at(100));
		expect(stopwatchElapsed(resumed, at(120))).toBe(sec(30));
		const again = resumeStopwatch(pauseStopwatch(resumed, at(120)), at(200));
		expect(stopwatchElapsed(again, at(205))).toBe(sec(35));
		expect(again.startedAt).toBe(T0);

		// Pausing a paused stopwatch, or resuming a running one, changes nothing.
		expect(pauseStopwatch(paused, at(50))).toBe(paused);
		expect(resumeStopwatch(stopwatch, at(50))).toBe(stopwatch);
	});

	it('reads zero until it starts, and resuming one that never ran starts it', () => {
		expect(STOPWATCH_IDLE).toEqual({ startedAt: null, accumulatedMs: 0, runningSince: null });
		expect(stopwatchElapsed(STOPWATCH_IDLE, at(600))).toBe(0);
		const started = resumeStopwatch(STOPWATCH_IDLE, T0);
		expect(started).toEqual(startStopwatch(T0));
		expect(stopwatchElapsed(started, at(5))).toBe(sec(5));
		expect(resetStopwatch(STOPWATCH_IDLE, T0)).toBe(STOPWATCH_IDLE);
	});

	it('resets to zero and keeps running, or stays paused', () => {
		const running = resetStopwatch(stopwatch, at(50));
		expect(stopwatchElapsed(running, at(50))).toBe(0);
		expect(stopwatchElapsed(running, at(60))).toBe(sec(10));

		const paused = resetStopwatch(pauseStopwatch(stopwatch, at(30)), at(50));
		expect(paused.runningSince).toBeNull();
		expect(stopwatchElapsed(paused, at(500))).toBe(0);
	});

	it('never counts below what it has counted when the device clock moves backwards', () => {
		expect(stopwatchElapsed(stopwatch, at(-60))).toBe(0);
		const resumed = resumeStopwatch(pauseStopwatch(stopwatch, at(10)), at(20));
		expect(stopwatchElapsed(resumed, at(-100))).toBe(sec(10));
		expect(pauseStopwatch(resumed, at(-100)).accumulatedMs).toBe(sec(10));
	});

	it('never changes the stopwatch it is given', () => {
		const running = frozen(startStopwatch(T0));
		const paused = frozen(pauseStopwatch(running, at(10)));
		expect(() => {
			pauseStopwatch(running, at(10));
			resumeStopwatch(paused, at(20));
			resetStopwatch(running, at(30));
			resetStopwatch(paused, at(30));
		}).not.toThrow();
	});
});

describe('stored timers', () => {
	it('give the same reading once serialised and restored', () => {
		const rest = startRest(T0, sec(150));
		const rests: RestState[] = [
			rest,
			pauseRest(rest, at(20)),
			addRest(pauseRest(rest, at(20)), at(30)),
			addRest(rest, at(40)),
			skipRest(rest, at(50)),
			resetRest(rest, at(60))
		];
		const stopwatch = startStopwatch(T0);
		const stopwatches: StopwatchState[] = [
			STOPWATCH_IDLE,
			stopwatch,
			pauseStopwatch(stopwatch, at(90)),
			resumeStopwatch(pauseStopwatch(stopwatch, at(90)), at(120))
		];
		const instants = [at(-30), T0, at(45), at(150), at(181), at(7200)];

		for (const restore of [
			<T>(value: T): T => JSON.parse(JSON.stringify(value)),
			<T>(value: T): T => structuredClone(value)
		]) {
			for (const stored of rests) {
				const restored = restore(stored);
				expect(restored).toEqual(stored);
				for (const now of instants) expect(reading(restored, now)).toEqual(reading(stored, now));
			}
			for (const stored of stopwatches) {
				const restored = restore(stored);
				for (const now of instants) {
					expect(stopwatchElapsed(restored, now)).toBe(stopwatchElapsed(stored, now));
				}
			}
		}
	});
});

describe('which rest a set gets', () => {
	const kit = workoutDayKits({ date: '2026-11-06' }).strength;
	const [squat, legPress, , pullUp, plank] = kit.exercises;
	const unprescribed = { role: 'working', restSeconds: null } as const;

	it('ships the default rest per class, and 2:00 when there is none', () => {
		expect(DEFAULT_REST_SECONDS).toEqual({ main: 180, compound: 120, isolation: 90, timed: 60 });
		expect(FALLBACK_REST_SECONDS).toBe(120);
	});

	it('takes the prescription first, then the device default for the class, then 2:00', () => {
		// 1. The prescription, a prescribed 0 included (inside a superset round).
		expect(restFor(squat!.sets[0]!, squat!.exercise, DEFAULT_REST_SECONDS)).toBe(sec(180));
		expect(restFor(legPress!.sets[0]!, legPress!.exercise, DEFAULT_REST_SECONDS)).toBe(sec(120));
		expect(restFor(pullUp!.sets[0]!, pullUp!.exercise, DEFAULT_REST_SECONDS)).toBe(0);
		expect(restFor(plank!.sets[0]!, plank!.exercise, DEFAULT_REST_SECONDS)).toBe(sec(90));
		expect(restFor({ role: 'working', restSeconds: 45 }, plank!.exercise, {})).toBe(sec(45));

		// 2. The device default for the exercise's class: the device's own over the shipped one.
		const isolation = { restClass: 'isolation' } as const;
		expect(restFor(unprescribed, isolation, DEFAULT_REST_SECONDS)).toBe(sec(90));
		expect(restFor(unprescribed, isolation, { ...DEFAULT_REST_SECONDS, isolation: 60 })).toBe(
			sec(60)
		);
		expect(restFor(null, { restClass: 'timed' }, DEFAULT_REST_SECONDS)).toBe(sec(60));
		expect(restFor(unprescribed, plank!.exercise, { timed: 75 })).toBe(sec(75));
		// A top set rests as a main lift, whatever the exercise.
		expect(restFor({ role: 'top', restSeconds: null }, isolation, DEFAULT_REST_SECONDS)).toBe(
			sec(180)
		);

		// 3. 2:00 when the device has no usable default for the class.
		expect(restFor(unprescribed, isolation, {})).toBe(sec(120));
		expect(restFor(unprescribed, isolation, { main: 300, compound: 30 })).toBe(sec(120));
		for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(restFor(unprescribed, isolation, { isolation: bad })).toBe(sec(120));
			expect(restFor({ role: 'working', restSeconds: bad }, isolation, { isolation: 50 })).toBe(
				sec(50)
			);
		}
	});
});

describe('rest classes', () => {
	const none: Pick<RestClassInput, 'tags'> = { tags: [] };

	it('classes every pattern and measure, isolation before timed', () => {
		for (const pattern of MOVEMENT_PATTERNS) {
			for (const measure of MEASURES) {
				const expected =
					pattern === 'isolation' ? 'isolation' : measure === 'time' ? 'timed' : 'compound';
				const exercise = { ...none, pattern, measure };
				expect(restClassOf(exercise), `${pattern}, ${measure}`).toBe(expected);
				for (const role of SET_ROLES.filter((r) => r !== 'top')) {
					expect(restClassOf(exercise, { role }), `${pattern}, ${measure}, ${role}`).toBe(expected);
				}
				// A baseline or competition lift, or a top set, is a main lift.
				expect(restClassOf({ ...exercise, tags: ['compound', 'competition'] })).toBe('main');
				expect(restClassOf({ ...exercise, baselineLift: 'overhead_press' })).toBe('main');
				expect(restClassOf(exercise, { role: 'top' }), `${pattern}, ${measure}, top`).toBe('main');
			}
		}
	});

	it('classes catalogue lifts as main, compound, isolation or timed', () => {
		const lift = (exercise: Partial<RestClassInput>): RestClassInput => ({
			pattern: 'squat',
			measure: 'reps',
			tags: ['compound'],
			baselineLift: null,
			...exercise
		});
		// A baseline lift without the competition tag is still a main lift.
		expect(restClassOf(lift({ baselineLift: 'front_squat' }))).toBe('main');
		expect(
			restClassOf(lift({ tags: ['compound', 'competition'], baselineLift: 'back_squat' }))
		).toBe('main');
		expect(restClassOf(lift({}))).toBe('compound');
		expect(restClassOf(lift({ pattern: 'carry', measure: 'distance' }))).toBe('compound');
		expect(restClassOf(lift({ pattern: 'isolation', tags: [] }))).toBe('isolation');
		expect(restClassOf(lift({ pattern: 'anti_extension', measure: 'time', tags: [] }))).toBe(
			'timed'
		);
		// The owner's own exercises carry no baseline lift.
		expect(restClassOf({ pattern: 'hinge', measure: 'reps', tags: [] })).toBe('compound');
	});

	it("agrees with the shared fixture's kit", () => {
		const kit = workoutDayKits({ date: '2026-11-06' }).strength;
		expect(kit.exercises.map(({ exercise }) => restClassOf(exercise))).toEqual(
			kit.exercises.map(({ exercise }) => exercise.restClass)
		);
		expect(kit.exercises.map(({ exercise }) => exercise.restClass)).toEqual([
			'main',
			'compound',
			'compound',
			'compound',
			'timed'
		]);
	});
});
