import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const goto = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('$app/navigation', () => ({ goto }));

const { reloadFresh, startOfflineRecovery, RETRY_DELAYS_MS } = await import('./recovery');

const SCRIPT = 'https://app.test/_app/immutable/nodes/2.js';

/** A script response whose body arrives only when `deliver` is called. */
function slowScript(status = 200) {
	let deliver!: () => void;
	const body = new Promise<ArrayBuffer>((resolve) => (deliver = () => resolve(new ArrayBuffer(1))));
	const arrayBuffer = vi.fn(() => body);
	return { response: { ok: status < 400, status, arrayBuffer }, arrayBuffer, deliver };
}

let reload: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

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
	vi.stubGlobal('document', {
		querySelectorAll: () => [{ href: SCRIPT }],
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
