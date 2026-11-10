import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const goto = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$app/navigation', () => ({ goto }));

const { reloadFresh, startOfflineRecovery, trackPress, RETRY_DELAYS_MS } =
	await import('./recovery');

const SCRIPT = 'https://app.test/_app/immutable/nodes/2.js';

/** A script response whose body arrives only when `deliver` is called. */
function slowScript(status = 200) {
	let deliver!: () => void;
	const body = new Promise<ArrayBuffer>((resolve) => (deliver = () => resolve(new ArrayBuffer(1))));
	const arrayBuffer = vi.fn(() => body);
	return { response: { ok: status < 400, status, arrayBuffer }, arrayBuffer, deliver };
}

/**
 * A <link rel="stylesheet"> as the page holds it: `sheet` is null when its load failed. Its copy
 * (the reload of it) loads or fails when the test says so.
 */
function styleLink(href: string, applied = false, disabled = false) {
	const page = { links: [] as unknown[] };
	const copy = {
		href,
		sheet: null,
		onload: null as (() => void) | null,
		onerror: null as (() => void) | null,
		remove: vi.fn(() => page.links.splice(page.links.indexOf(copy), 1))
	};
	const link = {
		href,
		sheet: applied ? {} : null,
		disabled,
		cloneNode: vi.fn(() => copy),
		after: vi.fn((node: unknown) => page.links.splice(page.links.indexOf(link) + 1, 0, node)),
		remove: vi.fn(() => page.links.splice(page.links.indexOf(link), 1))
	};
	page.links.push(link);
	return {
		link,
		copy,
		/** The stylesheet links in the page, in order. */
		links: () => page.links,
		load: () => copy.onload?.(),
		fail: () => copy.onerror?.()
	};
}

let reload: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let stylesheets: unknown[];

beforeEach(() => {
	vi.useFakeTimers();
	goto.mockClear();
	reload = vi.fn();
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal('location', { pathname: '/today', href: 'https://app.test/today', reload });
	vi.stubGlobal('navigator', { onLine: true });
	vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {} });
	// The page's one module script failed: it has a modulepreload link and no timing entry.
	stylesheets = [];
	vi.stubGlobal('document', {
		querySelectorAll: (selector: string) =>
			selector === 'link[rel="modulepreload"]' ? [{ href: SCRIPT }] : [...stylesheets],
		addEventListener: () => {},
		removeEventListener: () => {}
	});
	vi.stubGlobal('performance', { getEntriesByName: () => [] });
	vi.stubGlobal('addEventListener', () => {});
	vi.stubGlobal('removeEventListener', () => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('reloadFresh (Try again)', () => {
	it('reloads only after the failed script has arrived in full', async () => {
		const script = slowScript();
		fetchMock.mockResolvedValue(script.response);
		reloadFresh();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledWith(SCRIPT, expect.objectContaining({ cache: 'reload' }));
		expect(script.arrayBuffer).toHaveBeenCalled();
		expect(reload, 'headers alone do not reload').not.toHaveBeenCalled();

		script.deliver();
		await vi.advanceTimersByTimeAsync(0);
		expect(reload).toHaveBeenCalledOnce();
	});

	it('a navigation while the script is pending cancels the reload', async () => {
		const script = slowScript();
		fetchMock.mockResolvedValue(script.response);
		const cancel = reloadFresh();
		await vi.advanceTimersByTimeAsync(0);
		cancel();

		script.deliver();
		await vi.advanceTimersByTimeAsync(0);
		expect(reload).not.toHaveBeenCalled();
	});

	it.each([
		['an error status', () => slowScript(503).response],
		[
			'a body that fails to arrive',
			() => ({ ok: true, status: 200, arrayBuffer: () => Promise.reject(new TypeError('network')) })
		]
	])('does not reload when the script comes back with %s', async (_, response) => {
		fetchMock.mockResolvedValue(response());
		reloadFresh();
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();
	});
});

describe('a stylesheet that failed to load (Vite never links its URL again)', () => {
	const CSS = 'https://app.test/_app/immutable/assets/12.css';

	beforeEach(() =>
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: async () => new ArrayBuffer(1)
		})
	);

	it('Try again loads it again from a fresh link in its place, and reloads once it applies', async () => {
		const css = styleLink(CSS);
		stylesheets = css.links();
		reloadFresh();
		await vi.advanceTimersByTimeAsync(0);
		expect(css.links(), 'the copy goes right after the failed link').toEqual([css.link, css.copy]);
		expect(css.copy.href).toBe(CSS);
		expect(reload, 'not before the styles apply').not.toHaveBeenCalled();

		css.load();
		await vi.advanceTimersByTimeAsync(0);
		expect(css.links(), 'the failed link is gone').toEqual([css.copy]);
		expect(reload).toHaveBeenCalledOnce();
	});

	it('leaves the stylesheets that applied alone', async () => {
		const css = styleLink(CSS, true);
		stylesheets = css.links();
		reloadFresh();
		await vi.advanceTimersByTimeAsync(0);
		expect(css.link.cloneNode).not.toHaveBeenCalled();
		expect(reload).toHaveBeenCalledOnce();
	});

	it('leaves the disabled links SvelteKit puts in for the stylesheets it inlined alone', async () => {
		const css = styleLink(CSS, false, true);
		stylesheets = css.links();
		reloadFresh();
		await vi.advanceTimersByTimeAsync(0);
		expect(css.link.cloneNode).not.toHaveBeenCalled();
		expect(reload).toHaveBeenCalledOnce();
	});

	it('the recovery loads the screen again only once its stylesheet applies', async () => {
		// Another screen: each path loads again in place once per document.
		vi.stubGlobal('location', { pathname: '/train', href: 'https://app.test/train', reload });
		const css = styleLink(CSS);
		stylesheets = css.links();
		const stop = startOfflineRecovery({ onDeviceStatus: () => {}, probe: async () => true });
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
		expect(goto).not.toHaveBeenCalled();

		css.load();
		await vi.advanceTimersByTimeAsync(0);
		expect(goto).toHaveBeenCalledWith('https://app.test/train', expect.anything());
		expect(css.links()).toEqual([css.copy]);
		stop();
	});

	it('when the copy fails too, it goes, the failed link stays, and the recovery tries again', async () => {
		vi.stubGlobal('location', { pathname: '/progress', href: 'https://app.test/progress', reload });
		const css = styleLink(CSS);
		stylesheets = css.links();
		const stop = startOfflineRecovery({ onDeviceStatus: () => {}, probe: async () => true });
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
		css.fail();
		await vi.advanceTimersByTimeAsync(0);
		expect(css.links()).toEqual([css.link]);
		expect(goto).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]);
		expect(css.link.cloneNode).toHaveBeenCalledTimes(2);
		stop();
	});
});

describe('startOfflineRecovery', () => {
	it('loads the screen again once the server answers and the script has arrived in full', async () => {
		const script = slowScript();
		fetchMock.mockResolvedValue(script.response);
		const stop = startOfflineRecovery({ onDeviceStatus: () => {}, probe: async () => true });
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
		expect(goto).not.toHaveBeenCalled();

		script.deliver();
		await vi.advanceTimersByTimeAsync(0);
		expect(goto).toHaveBeenCalledWith('https://app.test/today', expect.anything());
		stop();
	});

	it('keeps retrying while the script itself still fails', async () => {
		fetchMock.mockResolvedValue(slowScript(503).response);
		const stop = startOfflineRecovery({ onDeviceStatus: () => {}, probe: async () => true });
		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]);
		expect(goto).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		stop();
	});
});

describe('trackPress (the screen replacing the offline view waits for a press to end)', () => {
	/** The window's pointer listeners, and a way to fire one. */
	function pointerWindow() {
		const listeners = new Map<string, (event: { pointerId: number }) => void>();
		vi.stubGlobal('addEventListener', (type: string, fn: (event: { pointerId: number }) => void) =>
			listeners.set(type, fn)
		);
		vi.stubGlobal('removeEventListener', (type: string) => listeners.delete(type));
		return {
			fire: (type: string, pointerId = 1) => listeners.get(type)?.({ pointerId }),
			listening: () => [...listeners.keys()]
		};
	}

	it('lets a navigation through at once when nothing is pressed', () => {
		pointerWindow();
		const press = trackPress();
		expect(press.released()).toBeUndefined();
		press.stop();
	});

	it('holds it while a press is down, until a task after the release (after its click)', async () => {
		const win = pointerWindow();
		const press = trackPress();
		win.fire('pointerdown');
		let done = false;
		void press.released()?.then(() => (done = true));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(done, 'held while pressed').toBe(false);

		win.fire('pointerup');
		await Promise.resolve();
		expect(done, 'not in the task of the release, where its click fires').toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(done).toBe(true);
		expect(press.released(), 'nothing pressed any more').toBeUndefined();
		press.stop();
	});

	it('waits for the last of several presses, and a cancelled press ends too', async () => {
		const win = pointerWindow();
		const press = trackPress();
		win.fire('pointerdown', 1);
		win.fire('pointerdown', 2);
		let done = false;
		void press.released()?.then(() => (done = true));
		win.fire('pointerup', 1);
		await vi.advanceTimersByTimeAsync(0);
		expect(done, 'one finger still down').toBe(false);

		win.fire('pointercancel', 2);
		await vi.advanceTimersByTimeAsync(0);
		expect(done).toBe(true);
		press.stop();
	});

	it('stop lets a held navigation go and stops listening', async () => {
		const win = pointerWindow();
		const press = trackPress();
		win.fire('pointerdown');
		let done = false;
		void press.released()?.then(() => (done = true));
		press.stop();
		await Promise.resolve();
		expect(done).toBe(true);
		expect(win.listening()).toEqual([]);
	});
});
