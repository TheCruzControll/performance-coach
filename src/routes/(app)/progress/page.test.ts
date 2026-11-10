import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trends from './trends.ts';

const preloadTrends = vi.hoisted(() => vi.fn(async () => {}));
const servedTrends = vi.hoisted(() => vi.fn(async () => '<section>the trends</section>'));
const preloadStrengthTrends = vi.hoisted(() => vi.fn(async () => {}));
const servedStrengthTrends = vi.hoisted(() => vi.fn(async () => '<section>the strength</section>'));
const preloadRunningTrends = vi.hoisted(() => vi.fn(async () => {}));
const servedRunningTrends = vi.hoisted(() => vi.fn(async () => '<section>the running</section>'));
const preloadGeneralTrends = vi.hoisted(() => vi.fn(async () => {}));
const servedGeneralTrends = vi.hoisted(() => vi.fn(async () => '<section>the general</section>'));
vi.mock('./trends', async (original) => ({
	...(await original<typeof Trends>()),
	preloadTrends,
	servedTrends,
	preloadStrengthTrends,
	servedStrengthTrends,
	preloadRunningTrends,
	servedRunningTrends,
	preloadGeneralTrends,
	servedGeneralTrends
}));

/** +page.ts as a fresh module: in the browser (on a document opened at `pathname`) or the server. */
async function loadModule(where: { browser: false } | { browser: true; pathname: string }) {
	vi.resetModules();
	vi.doMock('$app/env', () => ({ browser: where.browser }));
	if (where.browser) vi.stubGlobal('location', { pathname: where.pathname });
	return (await import('./+page.ts')).load;
}

type Load = Awaited<ReturnType<typeof loadModule>>;
const overview = (stage: string) => ({ stage });
const run = async (load: Load, data: object) =>
	(await load({ data } as unknown as Parameters<Load>[0])) as Record<string, unknown>;
const history = { failed: false, view: 'overview', period: '12w', overview: overview('history') };
const strength = { failed: false, view: 'strength', period: '12w', strength: { stage: 'history' } };
const running = { failed: false, view: 'running', period: '12w', running: { stage: 'history' } };
const general = { failed: false, view: 'general', period: '12w', general: { stage: 'history' } };

beforeEach(() => {
	preloadTrends.mockClear();
	servedTrends.mockClear();
	preloadStrengthTrends.mockClear();
	servedStrengthTrends.mockClear();
	preloadRunningTrends.mockClear();
	servedRunningTrends.mockClear();
	preloadGeneralTrends.mockClear();
	servedGeneralTrends.mockClear();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock('$app/env');
});

describe("Progress's universal load", () => {
	it('on the server, waits for the trends and sends them as markup', async () => {
		const load = await loadModule({ browser: false });
		const loaded = await run(load, history);
		expect(loaded).toMatchObject({ served: '<section>the trends</section>' });
		expect(loaded['View']).toBeTypeOf('function');
		expect(servedTrends).toHaveBeenCalledExactlyOnceWith({ overview: history.overview });
	});

	it('never waits for the trends in the browser: hydrating keeps the server’s markup', async () => {
		const load = await loadModule({ browser: true, pathname: '/progress' });
		// The hydrating load finishes while the trends' import is held.
		preloadTrends.mockImplementationOnce(() => new Promise<void>(() => {}));
		const hydrating = await Promise.race([
			run(load, history),
			new Promise((resolve) => setTimeout(() => resolve('held'), 1000))
		]);
		expect(hydrating).toMatchObject({ served: 'served' });
		expect(preloadTrends).toHaveBeenCalledOnce();
		expect(servedTrends).not.toHaveBeenCalled();
		// Any later load in that document (a period link, Retry) shows the skeleton.
		await expect(run(load, history)).resolves.toMatchObject({ served: undefined });
	});

	it('a document opened elsewhere never keeps markup it was not sent', async () => {
		const load = await loadModule({ browser: true, pathname: '/today' });
		await expect(run(load, history)).resolves.toMatchObject({ served: undefined });
	});

	it('sends a new owner’s timeline as markup too', async () => {
		const load = await loadModule({ browser: false });
		const fresh = { ...history, overview: overview('new') };
		await expect(run(load, fresh)).resolves.toMatchObject({
			served: '<section>the trends</section>'
		});
		expect(servedTrends).toHaveBeenCalledExactlyOnceWith({ overview: fresh.overview });
	});

	it('on the server, sends Strength’s trends as markup, and never Overview’s', async () => {
		const load = await loadModule({ browser: false });
		const loaded = await run(load, strength);
		expect(loaded).toMatchObject({ served: '<section>the strength</section>' });
		expect(loaded['View']).toBeTypeOf('function');
		expect(servedStrengthTrends).toHaveBeenCalledExactlyOnceWith({ strength: strength.strength });
		expect(servedTrends).not.toHaveBeenCalled();
	});

	it('in the browser, keeps the server’s Strength markup while hydrating, and waits for it after', async () => {
		const load = await loadModule({ browser: true, pathname: '/progress' });
		// The hydrating load finishes while the trends' import is held.
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		preloadStrengthTrends.mockImplementation(() => held);
		const settles = (loaded: Promise<unknown>) =>
			Promise.race([loaded, new Promise((resolve) => setTimeout(() => resolve('held'), 500))]);
		await expect(settles(run(load, strength))).resolves.toMatchObject({ served: 'served' });
		expect(preloadTrends).not.toHaveBeenCalled();
		expect(servedStrengthTrends).not.toHaveBeenCalled();
		// Any later load in that document (a period link, Retry) waits for the trends' code.
		const later = run(load, strength);
		await expect(settles(later)).resolves.toBe('held');
		release();
		await expect(later).resolves.toMatchObject({ served: undefined });
		expect(preloadStrengthTrends).toHaveBeenCalledTimes(2);
		preloadStrengthTrends.mockReset();
		preloadStrengthTrends.mockImplementation(async () => {});
	});

	it('on the server, sends Running’s trends as markup, and never another view’s', async () => {
		const load = await loadModule({ browser: false });
		const loaded = await run(load, running);
		expect(loaded).toMatchObject({ served: '<section>the running</section>' });
		expect(loaded['View']).toBeTypeOf('function');
		expect(servedRunningTrends).toHaveBeenCalledExactlyOnceWith({ running: running.running });
		expect(servedTrends).not.toHaveBeenCalled();
		expect(servedStrengthTrends).not.toHaveBeenCalled();
		expect(servedGeneralTrends).not.toHaveBeenCalled();
	});

	it('on the server, sends General’s trends as markup, and never another view’s', async () => {
		const load = await loadModule({ browser: false });
		const loaded = await run(load, general);
		expect(loaded).toMatchObject({ served: '<section>the general</section>' });
		expect(loaded['View']).toBeTypeOf('function');
		expect(servedGeneralTrends).toHaveBeenCalledExactlyOnceWith({ general: general.general });
		expect(servedRunningTrends).not.toHaveBeenCalled();
		expect(servedTrends).not.toHaveBeenCalled();
		expect(servedStrengthTrends).not.toHaveBeenCalled();
	});

	it('in the browser, keeps the server’s Running markup while hydrating, and waits for it after', async () => {
		const load = await loadModule({ browser: true, pathname: '/progress' });
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		preloadRunningTrends.mockImplementation(() => held);
		const settles = (loaded: Promise<unknown>) =>
			Promise.race([loaded, new Promise((resolve) => setTimeout(() => resolve('held'), 500))]);
		await expect(settles(run(load, running))).resolves.toMatchObject({ served: 'served' });
		expect(preloadTrends).not.toHaveBeenCalled();
		expect(preloadStrengthTrends).not.toHaveBeenCalled();
		expect(servedRunningTrends).not.toHaveBeenCalled();
		// Any later load in that document (a period link, Retry) waits for the trends' code.
		const later = run(load, running);
		await expect(settles(later)).resolves.toBe('held');
		release();
		await expect(later).resolves.toMatchObject({ served: undefined });
		expect(preloadRunningTrends).toHaveBeenCalledTimes(2);
		preloadRunningTrends.mockReset();
		preloadRunningTrends.mockImplementation(async () => {});
	});

	it('in the browser, keeps the server’s General markup while hydrating, and waits for it after', async () => {
		const load = await loadModule({ browser: true, pathname: '/progress' });
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		preloadGeneralTrends.mockImplementation(() => held);
		const settles = (loaded: Promise<unknown>) =>
			Promise.race([loaded, new Promise((resolve) => setTimeout(() => resolve('held'), 500))]);
		await expect(settles(run(load, general))).resolves.toMatchObject({ served: 'served' });
		expect(preloadTrends).not.toHaveBeenCalled();
		expect(preloadRunningTrends).not.toHaveBeenCalled();
		expect(servedGeneralTrends).not.toHaveBeenCalled();
		// Any later load in that document (a period link, Retry) waits for the trends' code.
		const later = run(load, general);
		await expect(settles(later)).resolves.toBe('held');
		release();
		await expect(later).resolves.toMatchObject({ served: undefined });
		expect(preloadGeneralTrends).toHaveBeenCalledTimes(2);
		preloadGeneralTrends.mockReset();
		preloadGeneralTrends.mockImplementation(async () => {});
	});

	it('imports no trends for a failed load', async () => {
		const load = await loadModule({ browser: false });
		await expect(run(load, { failed: true, view: 'overview', period: '12w' })).resolves.toEqual({
			failed: true,
			view: 'overview',
			period: '12w',
			View: null,
			served: undefined
		});
		expect(preloadTrends).not.toHaveBeenCalled();
		expect(servedTrends).not.toHaveBeenCalled();
		expect(preloadStrengthTrends).not.toHaveBeenCalled();
		expect(servedStrengthTrends).not.toHaveBeenCalled();
		expect(preloadRunningTrends).not.toHaveBeenCalled();
		expect(servedRunningTrends).not.toHaveBeenCalled();
		expect(preloadGeneralTrends).not.toHaveBeenCalled();
		expect(servedGeneralTrends).not.toHaveBeenCalled();
	});
});
