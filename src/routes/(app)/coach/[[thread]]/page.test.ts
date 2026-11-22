import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThreadCode from './thread-code.ts';

const servedThread = vi.hoisted(() => vi.fn(async () => '<article>the conversation</article>'));
vi.mock('./thread-code', async (original) => ({
	...(await original<typeof ThreadCode>()),
	servedThread
}));

/** +page.ts as a fresh module: in the browser (on a document opened at `pathname`) or the server. */
async function loadModule(where: { browser: false } | { browser: true; pathname: string }) {
	vi.resetModules();
	vi.doMock('$app/env', () => ({ browser: where.browser }));
	if (where.browser) vi.stubGlobal('location', { pathname: where.pathname });
	return (await import('./+page.ts')).load;
}

type Load = Awaited<ReturnType<typeof loadModule>>;
const run = async (load: Load, data: object, pathname = '/coach/t1') =>
	(await load({
		data,
		url: new URL(pathname, 'https://coach.test')
	} as unknown as Parameters<Load>[0])) as Record<string, unknown>;
const thread = { id: 't1', title: 'Squat depth', archived: false, messages: [] };
const opened = { failed: false, prefill: null, threads: [], next: null, thread };
const list = { ...opened, thread: null };

beforeEach(() => servedThread.mockClear());
afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock('$app/env');
});

describe("the coach screen's universal load", () => {
	it('on the server, sends an open conversation as markup', async () => {
		const load = await loadModule({ browser: false });
		await expect(run(load, opened)).resolves.toEqual({
			...opened,
			served: '<article>the conversation</article>'
		});
		expect(servedThread).toHaveBeenCalledExactlyOnceWith(thread);
	});

	it('serves nothing for the list or a failed load', async () => {
		const load = await loadModule({ browser: false });
		await expect(run(load, list, '/coach')).resolves.toMatchObject({ served: undefined });
		await expect(run(load, { failed: true, prefill: null })).resolves.toMatchObject({
			served: undefined
		});
		expect(servedThread).not.toHaveBeenCalled();
	});

	it('in the browser, only the hydrating load keeps the server’s markup', async () => {
		const load = await loadModule({ browser: true, pathname: '/coach/t1' });
		await expect(run(load, opened)).resolves.toMatchObject({ served: 'served' });
		// Any later load in that document (another conversation, Retry) shows loading rows.
		await expect(run(load, opened)).resolves.toMatchObject({ served: undefined });
		expect(servedThread).not.toHaveBeenCalled();
	});

	it('a conversation opened by a client navigation shows loading rows', async () => {
		// The page's module first loads for the navigation, while the address is still the list's.
		const load = await loadModule({ browser: true, pathname: '/coach' });
		await expect(run(load, opened)).resolves.toMatchObject({ served: undefined });
	});
});
