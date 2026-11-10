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
const run = async (load: Load, data: object) =>
	(await load({ data } as unknown as Parameters<Load>[0])) as Record<string, unknown>;
const detail = { id: 'squat', name: 'Back squat', waiting: null };
const ready = { failed: false, period: '12w', detail };

beforeEach(() => {
	preloadTrends.mockClear();
	servedTrends.mockClear();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock('$app/env');
});

describe("the exercise detail's universal load", () => {
	it('on the server, waits for the trends and sends them as markup', async () => {
		const load = await loadModule({ browser: false });
		await expect(run(load, ready)).resolves.toEqual({
			...ready,
			served: '<section>the trends</section>'
		});
		expect(servedTrends).toHaveBeenCalledExactlyOnceWith({ detail });
	});

	it('never waits for the trends in the browser: hydrating keeps the server’s markup', async () => {
		const load = await loadModule({ browser: true, pathname: '/progress/exercises/squat' });
		// The hydrating load finishes while the trends' import is held.
		preloadTrends.mockImplementationOnce(() => new Promise<void>(() => {}));
		const hydrating = await Promise.race([
			run(load, ready),
			new Promise((resolve) => setTimeout(() => resolve('held'), 1000))
		]);
		expect(hydrating).toMatchObject({ served: 'served' });
		expect(preloadTrends).toHaveBeenCalledOnce();
		expect(servedTrends).not.toHaveBeenCalled();
		// Any later load in that document (a period link, another lift, Retry) shows placeholders.
		await expect(run(load, ready)).resolves.toMatchObject({ served: undefined });
		expect(preloadTrends).toHaveBeenCalledTimes(2);
	});

	it('a document opened elsewhere never keeps markup it was not sent', async () => {
		const load = await loadModule({ browser: true, pathname: '/progress' });
		await expect(run(load, ready)).resolves.toMatchObject({ served: undefined });
	});

	it('imports no trends for a failed load', async () => {
		const load = await loadModule({ browser: false });
		await expect(run(load, { failed: true, period: '12w' })).resolves.toEqual({
			failed: true,
			period: '12w',
			served: undefined
		});
		expect(preloadTrends).not.toHaveBeenCalled();
		expect(servedTrends).not.toHaveBeenCalled();
	});
});
