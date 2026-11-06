import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEAVING_RESET_MS, whenLeaveEnds } from './leaving';

/** The browser window as far as leaving.ts sees it: the head script's note and its events. */
const page = new EventTarget() as EventTarget & { __pcLeftAt?: number };

/** What the head script in src/app.html does on `beforeunload` / `pagehide`. */
const startLeaving = () => (page.__pcLeftAt = Date.now());
/** …and on a `pageshow` that restores the page from the back/forward cache. */
function restoreFromBackForwardCache() {
	page.__pcLeftAt = undefined;
	page.dispatchEvent(new Event('pageshow'));
}

/** Whether `promise` has settled, once pending timers and microtasks have run. */
async function settled(promise: Promise<void>): Promise<boolean> {
	let done = false;
	void promise.then(() => (done = true));
	await vi.advanceTimersByTimeAsync(0);
	return done;
}

beforeEach(() => {
	vi.useFakeTimers();
	page.__pcLeftAt = undefined;
	vi.stubGlobal('window', page);
	vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
	vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('leaving a page', () => {
	it('is over at once for a page nobody is leaving', async () => {
		expect(await settled(whenLeaveEnds())).toBe(true);
	});

	it('holds a page being left until the leave expires: one really left never gets there', async () => {
		startLeaving();
		const ended = whenLeaveEnds();
		vi.advanceTimersByTime(LEAVING_RESET_MS - 1);
		expect(await settled(ended)).toBe(false);
		vi.advanceTimersByTime(1);
		expect(await settled(ended)).toBe(true);
	});

	it('ends when the page comes back from the back/forward cache', async () => {
		startLeaving();
		const ended = whenLeaveEnds();
		vi.advanceTimersByTime(1_000);
		expect(await settled(ended)).toBe(false);
		restoreFromBackForwardCache();
		expect(await settled(ended)).toBe(true);
	});

	it('goes on through a first pageshow, and a leave that starts again starts the wait again', async () => {
		startLeaving();
		const ended = whenLeaveEnds();
		page.dispatchEvent(new Event('pageshow')); // a page's first show: the note stays
		vi.advanceTimersByTime(LEAVING_RESET_MS / 2);
		startLeaving();
		vi.advanceTimersByTime(LEAVING_RESET_MS / 2);
		expect(await settled(ended)).toBe(false);
		vi.advanceTimersByTime(LEAVING_RESET_MS / 2);
		expect(await settled(ended)).toBe(true);
	});
});
