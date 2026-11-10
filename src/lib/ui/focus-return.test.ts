import { describe, expect, it } from 'vitest';
import { RETURN_FOCUS_FRAMES, returnFocus, type Focusable } from './focus-return.ts';

/** An opener whose first `refusals` focus() calls do nothing, as WebKit's do while a sheet loads. */
function opener(refusals: number) {
	const state = { focused: false, calls: 0, isConnected: true };
	const target: Focusable = {
		get isConnected() {
			return state.isConnected;
		},
		focus: () => {
			state.calls += 1;
			if (state.calls > refusals) state.focused = true;
		}
	};
	return { target, state };
}

/** Frames run one at a time, when the test says. */
function frames() {
	const queue: (() => void)[] = [];
	return {
		frame: (callback: () => void) => queue.push(callback),
		next: () => queue.shift()?.(),
		get waiting() {
			return queue.length;
		}
	};
}

describe('returnFocus', () => {
	it('focuses the opener once when it takes focus at once', () => {
		const { target, state } = opener(0);
		const f = frames();
		returnFocus(target, () => !state.focused, f.frame);
		expect(state).toMatchObject({ focused: true, calls: 1 });
		expect(f.waiting).toBe(0);
	});

	it('tries again on the next frames while focus is nowhere, until the opener takes it', () => {
		const { target, state } = opener(2);
		const f = frames();
		returnFocus(target, () => !state.focused, f.frame);
		expect(state.focused).toBe(false);
		f.next();
		expect(state.focused).toBe(false);
		f.next();
		expect(state).toMatchObject({ focused: true, calls: 3 });
		expect(f.waiting).toBe(0);
	});

	it('stops once focus is somewhere else, never taking it back', () => {
		const { target, state } = opener(Infinity);
		const f = frames();
		let elsewhere = false;
		returnFocus(target, () => !elsewhere, f.frame);
		elsewhere = true;
		f.next();
		expect(state.calls).toBe(1);
		expect(f.waiting).toBe(0);
	});

	it('stops when the opener has left the page', () => {
		const { target, state } = opener(Infinity);
		const f = frames();
		returnFocus(target, () => true, f.frame);
		state.isConnected = false;
		f.next();
		expect(state.calls).toBe(1);
		expect(f.waiting).toBe(0);
	});

	it('gives up after about a second of frames', () => {
		const { target, state } = opener(Infinity);
		const f = frames();
		returnFocus(target, () => true, f.frame);
		while (f.waiting) f.next();
		expect(state.calls).toBe(RETURN_FOCUS_FRAMES + 1);
	});
});
