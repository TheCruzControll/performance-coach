import { describe, expect, it } from 'vitest';
import { swipeStep } from './swipe';

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
