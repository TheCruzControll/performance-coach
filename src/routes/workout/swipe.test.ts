import { describe, expect, it } from 'vitest';
import {
	dragAxis,
	dragOffset,
	pushSample,
	release,
	releaseVelocity,
	rubberBand,
	SPRING_MAX_MS,
	SPRING_MAX_VELOCITY,
	springFrames,
	SWIPE_LOCK_DISTANCE,
	swipeStep,
	VELOCITY_WINDOW_MS,
	type Sample
} from './swipe';

/** The card on a 393 px phone: a quarter of it is 90 px. */
const WIDTH = 361;

describe('swipeStep', () => {
	it('a slow drag left past a quarter of the width goes to the next exercise, right to the previous', () => {
		expect(swipeStep(-100, 0, 800, WIDTH)).toBe(1);
		expect(swipeStep(100, 10, 800, WIDTH)).toBe(-1);
	});

	it('a slow drag short of the distance stays', () => {
		expect(swipeStep(-80, 0, 800, WIDTH)).toBe(0);
		expect(swipeStep(50, 0, 800, WIDTH)).toBe(0);
	});

	it('a narrow area still asks for 56 px', () => {
		expect(swipeStep(-50, 0, 800, 120)).toBe(0);
		expect(swipeStep(-56, 0, 800, 120)).toBe(1);
	});

	it('a quick flick counts from 24 px', () => {
		expect(swipeStep(-30, 0, 40, WIDTH)).toBe(1);
		expect(swipeStep(30, 0, 40, WIDTH)).toBe(-1);
		expect(swipeStep(-20, 0, 10, WIDTH)).toBe(0);
	});

	it('a vertical or diagonal drag never changes the exercise, however far or fast', () => {
		expect(swipeStep(0, -400, 200, WIDTH)).toBe(0);
		expect(swipeStep(-150, -100, 100, WIDTH)).toBe(0);
		expect(swipeStep(-60, 40, 20, WIDTH)).toBe(0);
	});

	it('a tap is no swipe', () => {
		expect(swipeStep(0, 0, 0, WIDTH)).toBe(0);
	});
});

describe('dragAxis', () => {
	it('picks no axis until the pointer has moved SWIPE_LOCK_DISTANCE', () => {
		expect(dragAxis(0, 0)).toBeNull();
		expect(dragAxis(SWIPE_LOCK_DISTANCE - 1, 0)).toBeNull();
		expect(dragAxis(-SWIPE_LOCK_DISTANCE, 0)).toBe('x');
	});

	it('is sideways only when clearly sideways, so a scroll never moves the card', () => {
		expect(dragAxis(20, 5)).toBe('x');
		expect(dragAxis(-20, 9)).toBe('x');
		expect(dragAxis(20, 11)).toBe('y');
		expect(dragAxis(0, -12)).toBe('y');
	});
});

describe('rubberBand', () => {
	it('gives way less and less, and never past the area’s width', () => {
		const small = rubberBand(20, WIDTH);
		const large = rubberBand(200, WIDTH);
		expect(small).toBeGreaterThan(0);
		expect(small).toBeLessThan(20);
		expect(large).toBeLessThan(200 * 0.5);
		expect(large).toBeGreaterThan(small);
		expect(rubberBand(1e6, WIDTH)).toBeLessThan(WIDTH);
	});

	it('keeps the direction, and is still at rest', () => {
		expect(rubberBand(-200, WIDTH)).toBeCloseTo(-rubberBand(200, WIDTH));
		expect(rubberBand(0, WIDTH)).toBe(0);
	});
});

describe('dragOffset', () => {
	it('follows the pointer 1:1 toward an exercise that exists', () => {
		expect(dragOffset(-140, WIDTH, { previous: true, next: true })).toBe(-140);
		expect(dragOffset(140, WIDTH, { previous: true, next: true })).toBe(140);
	});

	it('resists past the first and the last exercise', () => {
		expect(dragOffset(140, WIDTH, { previous: false, next: true })).toBe(rubberBand(140, WIDTH));
		expect(dragOffset(-140, WIDTH, { previous: true, next: false })).toBe(rubberBand(-140, WIDTH));
		// At the first exercise a drag toward the next one still follows 1:1.
		expect(dragOffset(-140, WIDTH, { previous: false, next: true })).toBe(-140);
	});
});

describe('releaseVelocity', () => {
	it('reads the last 100 ms, so a drag that stops before release lands still', () => {
		const samples: Sample[] = [];
		for (let t = 0; t <= 200; t += 10) pushSample(samples, { x: -t, t });
		expect(releaseVelocity(samples)).toBeCloseTo(-1);
		pushSample(samples, { x: -200, t: 400 });
		expect(releaseVelocity(samples)).toBe(0);
	});

	it('ignores samples older than the window, however it is given them', () => {
		const samples = [
			{ x: 0, t: 0 },
			{ x: -150, t: 100 },
			{ x: -200, t: 250 },
			{ x: -220, t: 300 }
		];
		// Only the last 100 ms: 20 px over 50 ms.
		expect(releaseVelocity(samples)).toBeCloseTo(-0.4);
	});

	it('keeps only the window it reads', () => {
		const samples: Sample[] = [];
		for (let t = 0; t <= 1_000; t += 8) pushSample(samples, { x: t, t });
		expect(samples.length).toBeLessThanOrEqual(VELOCITY_WINDOW_MS / 8 + 2);
	});

	it('is still with fewer than two samples or none apart in time', () => {
		expect(releaseVelocity([])).toBe(0);
		expect(releaseVelocity([{ x: 5, t: 3 }])).toBe(0);
		expect(
			releaseVelocity([
				{ x: 5, t: 3 },
				{ x: 9, t: 3 }
			])
		).toBe(0);
	});
});

describe('springFrames', () => {
	it('starts where the card is and ends exactly at rest', () => {
		const { offsets, duration } = springFrames(-120, 0, 0);
		expect(offsets[0]).toBe(-120);
		expect(offsets.at(-1)).toBe(0);
		expect(duration).toBeGreaterThan(100);
		expect(duration).toBeLessThan(1_000);
		expect(duration).toBeCloseTo(((offsets.length - 1) * 1000) / 60);
	});

	it('leaves at the release velocity: a fling carries the card on before it returns', () => {
		const still = springFrames(-120, 0, 0).offsets;
		const flung = springFrames(-120, 0, -1.5).offsets;
		// Held still it heads straight back; flung left it first carries on left. The first 60 Hz
		// frame at 1.5 px/ms is up to 25 px, less what the spring takes back in that frame.
		expect(still[1]! - still[0]!).toBeGreaterThan(0);
		expect(flung[1]! - flung[0]!).toBeLessThan(-5);
		expect(flung[1]! - still[1]!).toBeLessThan(-12);
		expect(flung[1]! - still[1]!).toBeGreaterThan(-25);
		expect(Math.min(...flung)).toBeLessThan(-125);
		expect(flung.at(-1)).toBe(0);
	});

	it('lands without a wobble, even from a fast swipe onto the next card', () => {
		// The next card, in from the right after a 140 px drag, at a hard flick's speed.
		const { offsets } = springFrames(WIDTH - 140, 0, -SPRING_MAX_VELOCITY);
		expect(Math.min(...offsets)).toBeGreaterThan(-2);
		expect(Math.min(...springFrames(-120, 0, 0).offsets)).toBeGreaterThanOrEqual(-120);
		expect(Math.max(...springFrames(-120, 0, 0).offsets)).toBeLessThan(1);
	});

	it('takes on a release no faster than a hard flick, so a synthetic drag never flings it past rest', () => {
		const capped = springFrames(WIDTH - 140, 0, -SPRING_MAX_VELOCITY).offsets;
		expect(springFrames(WIDTH - 140, 0, -40).offsets).toEqual(capped);
		expect(springFrames(-120, 0, 40).offsets).toEqual(
			springFrames(-120, 0, SPRING_MAX_VELOCITY).offsets
		);
	});

	it('never runs past its cap', () => {
		const wild = springFrames(1e5, 0, 50);
		expect(wild.duration).toBeLessThanOrEqual(SPRING_MAX_MS);
		expect(wild.offsets.at(-1)).toBe(0);
	});

	it('is still when the card is already at rest', () => {
		expect(springFrames(0, 0, 0).offsets).toEqual([0]);
		expect(springFrames(0, 0, 0).duration).toBe(0);
	});
});

describe('release', () => {
	const both = { previous: true, next: true };

	it('a swipe moves on, and the next card enters from where its neighbour would be', () => {
		expect(release({ offset: -140, dx: -140, dy: 0, ms: 600, width: WIDTH, ends: both })).toEqual({
			delta: 1,
			from: -140 + WIDTH
		});
		expect(release({ offset: 140, dx: 140, dy: 0, ms: 600, width: WIDTH, ends: both })).toEqual({
			delta: -1,
			from: 140 - WIDTH
		});
	});

	it('a short drag springs back from where it is', () => {
		expect(release({ offset: -40, dx: -40, dy: 0, ms: 600, width: WIDTH, ends: both })).toEqual({
			delta: 0,
			from: -40
		});
	});

	it('past the first or last exercise there is nowhere to go: it springs back', () => {
		const offset = rubberBand(200, WIDTH);
		expect(
			release({
				offset,
				dx: 200,
				dy: 0,
				ms: 300,
				width: WIDTH,
				ends: { previous: false, next: true }
			})
		).toEqual({ delta: 0, from: offset });
		expect(
			release({
				offset: -60,
				dx: -200,
				dy: 0,
				ms: 300,
				width: WIDTH,
				ends: { previous: true, next: false }
			})
		).toEqual({ delta: 0, from: -60 });
	});
});
