import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Trends from './trends.ts';

vi.mock('./trends', async (original) => ({
	...(await original<typeof Trends>()),
	preloadTrends: vi.fn(async () => {}),
	servedTrends: vi.fn(async () => '<section>the trends</section>')
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

const view = { failed: false, tiles: [], against: 'Nothing logged by Monday last week.' };
const overview = (week: unknown) => ({
	failed: false,
	view: 'overview',
	period: '12w',
	overview: { stage: 'history' },
	week
});
const failed = (week: unknown) => ({ failed: true, view: 'overview', period: '12w', week });

afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock('$app/env');
});

describe("Progress's This week, streamed", () => {
	it('waits for this week’s figures on the server and when hydrating; a navigation passes them on', async () => {
		const server = await loadModule({ browser: false });
		expect(await run(server, overview(Promise.resolve(view)))).toMatchObject({ week: view });
		expect(await run(server, failed(Promise.resolve(view)))).toMatchObject({ week: view });

		const browser = await loadModule({ browser: true, pathname: '/progress' });
		expect(await run(browser, overview(Promise.resolve(view)))).toMatchObject({ week: view });
		const streamed = Promise.resolve(view);
		expect((await run(browser, overview(streamed)))['week']).toBe(streamed);
		const failing = Promise.resolve(view);
		expect((await run(browser, failed(failing)))['week']).toBe(failing);
	});

	it('a failed load hydrating still waits for the week', async () => {
		const browser = await loadModule({ browser: true, pathname: '/progress' });
		expect(await run(browser, failed(Promise.resolve(view)))).toMatchObject({ week: view });
	});
});
