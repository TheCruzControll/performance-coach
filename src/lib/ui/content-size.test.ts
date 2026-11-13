import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { watchContentSize } from './content-size.ts';

/** Every observe() and unobserve(), in order, and whether a frame callback was running. */
let log: string[];
let inFrame: boolean;
let frames: Map<number, () => void>;
let nextFrame: number;
let onResize: (() => void) | undefined;
let onMutation: (() => void) | undefined;

const nameOf = (target: unknown) => (target as { id: string }).id;

class FakeResizeObserver {
	constructor(callback: () => void) {
		onResize = callback;
	}
	observe(target: unknown) {
		log.push(`observe ${nameOf(target)}${inFrame ? '' : ' (outside a frame)'}`);
	}
	unobserve(target: unknown) {
		log.push(`unobserve ${nameOf(target)}${inFrame ? '' : ' (outside a frame)'}`);
	}
	disconnect() {
		log.push('disconnect resize');
	}
}

class FakeMutationObserver {
	constructor(callback: () => void) {
		onMutation = callback;
	}
	observe() {}
	disconnect() {
		log.push('disconnect mutation');
	}
}

/** Run the frame callbacks queued so far, as the browser does before its ResizeObserver step. */
function runFrame() {
	const due = [...frames.values()];
	frames.clear();
	inFrame = true;
	for (const callback of due) callback();
	inFrame = false;
}

/** A sheet body and its children; `parentElement` is how the watcher tells a child has left. */
function body(...ids: string[]) {
	const el = { id: 'body', children: [] as { id: string; parentElement: unknown }[] };
	const add = (id: string) => el.children.push({ id, parentElement: el });
	const remove = (id: string) => {
		const index = el.children.findIndex((child) => child.id === id);
		el.children[index]!.parentElement = null;
		el.children.splice(index, 1);
	};
	ids.forEach(add);
	return { el: el as unknown as Element, add, remove };
}

beforeEach(() => {
	log = [];
	inFrame = false;
	frames = new Map();
	nextFrame = 1;
	vi.stubGlobal('ResizeObserver', FakeResizeObserver);
	vi.stubGlobal('MutationObserver', FakeMutationObserver);
	vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
		frames.set(nextFrame, callback);
		return nextFrame++;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('watchContentSize', () => {
	it('starts observing the element and its children in a frame, and measures', () => {
		const measure = vi.fn();
		watchContentSize(body('a', 'b').el, measure);
		expect(log).toEqual([]);
		runFrame();
		expect(log).toEqual(['observe body', 'observe a', 'observe b']);
		expect(measure).toHaveBeenCalledTimes(1);
	});

	it('measures on every resize the observer reports', () => {
		const measure = vi.fn();
		watchContentSize(body('a').el, measure);
		runFrame();
		onResize!();
		onResize!();
		expect(measure).toHaveBeenCalledTimes(3);
	});

	// The WebKit page error: a mutation noticed during the ResizeObserver step (a render that its
	// callback caused) that observes there queues a notification the step cannot deliver.
	it('observes nothing while the children change, only in the next frame: the new child alone', () => {
		const measure = vi.fn();
		const sheet = body('a', 'b');
		watchContentSize(sheet.el, measure);
		runFrame();
		log = [];
		measure.mockClear();

		sheet.add('c');
		sheet.remove('a');
		onMutation!();
		onMutation!();
		expect(log, 'nothing is observed in the mutation callback').toEqual([]);
		expect(frames.size, 'one frame for any number of mutations').toBe(1);

		runFrame();
		expect(log, 'the element is never observed again').toEqual(['unobserve a', 'observe c']);
		expect(measure).toHaveBeenCalledTimes(1);
	});

	it('stops: the waiting frame is cancelled and both observers disconnect', () => {
		const sheet = body('a');
		const stop = watchContentSize(sheet.el, vi.fn());
		stop();
		expect(frames.size).toBe(0);
		expect(log).toEqual(['disconnect mutation', 'disconnect resize']);

		const again = body('a');
		const stopLater = watchContentSize(again.el, vi.fn());
		runFrame();
		again.add('b');
		onMutation!();
		stopLater();
		expect(frames.size).toBe(0);
	});
});
