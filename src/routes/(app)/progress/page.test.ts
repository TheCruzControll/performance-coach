import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Trends from './trends.ts';

const preloadTrends = vi.hoisted(() => vi.fn(async () => {}));
const servedTrends = vi.hoisted(() => vi.fn(async () => '<section>the trends</section>'));
vi.mock('./trends', async (original) => ({
	...(await original<typeof Trends>()),
	preloadTrends,
	servedTrends
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

beforeEach(() => {
	preloadTrends.mockClear();
	servedTrends.mockClear();
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
	});
});
