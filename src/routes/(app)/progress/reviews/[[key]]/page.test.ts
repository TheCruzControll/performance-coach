/**
 * The reviews screen's universal load (+page.ts): the selected review's view is awaited, so the
 * server renders it and the browser hydrates it with no wait. The review's body (review-body.ts)
 * is markup on the server; the hydrating load only starts its import, and any later load waits
 * for it with the view's. Nothing is imported without a selected review.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BodyModule from './review-body.ts';

const Body = vi.hoisted(() => () => {});
const importBody = vi.hoisted(() => vi.fn(async () => Body));
const servedBody = vi.hoisted(() => vi.fn(async () => '<section>the body</section>'));
vi.mock('./review-body', async (original) => ({
	...(await original<typeof BodyModule>()),
	importBody,
	servedBody
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
const selected = { kind: 'weekly', key: 'w-2026-10-26' };
const data = { failed: false, key: 'w-2026-10-26', rows: [], empty: false, selected };
const none = { View: null, Body: undefined, body: undefined, served: undefined };

beforeEach(() => {
	importBody.mockClear();
	servedBody.mockClear();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock('$app/env');
});

describe("the reviews screen's universal load", () => {
	it('on the server, awaits the weekly view and sends the body as markup', async () => {
		const load = await loadModule({ browser: false });
		await expect(run(load, data)).resolves.toEqual({
			...data,
			View: expect.any(Function),
			Body: undefined,
			body: undefined,
			served: '<section>the body</section>'
		});
		expect(servedBody).toHaveBeenCalledExactlyOnceWith({ review: selected });
	});

	it('never waits for the body while hydrating; any later load waits for it', async () => {
		const load = await loadModule({ browser: true, pathname: '/progress/reviews/w-2026-10-26' });
		// The hydrating load finishes while the body's import is held.
		importBody.mockImplementationOnce(() => new Promise(() => {}));
		const hydrating = await Promise.race([
			run(load, data),
			new Promise((resolve) => setTimeout(() => resolve('held'), 1000))
		]);
		expect(hydrating).toMatchObject({
			View: expect.any(Function),
			Body: undefined,
			served: 'served'
		});
		expect((hydrating as Record<string, unknown>)['body']).toBeInstanceOf(Promise);
		expect(servedBody).not.toHaveBeenCalled();
		await expect(run(load, data)).resolves.toMatchObject({
			View: expect.any(Function),
			Body,
			body: undefined,
			served: undefined
		});
	});

	it('a document opened elsewhere never keeps markup it was not sent', async () => {
		const load = await loadModule({ browser: true, pathname: '/progress' });
		await expect(run(load, data)).resolves.toMatchObject({ Body, served: undefined });
	});

	it('imports nothing for the list alone or a failed load', async () => {
		const load = await loadModule({ browser: false });
		const list = { failed: false, key: null, rows: [], empty: true, selected: null };
		await expect(run(load, list)).resolves.toEqual({ ...list, ...none });
		await expect(run(load, { failed: true, key: null })).resolves.toEqual({
			failed: true,
			key: null,
			...none
		});
		expect(importBody).not.toHaveBeenCalled();
		expect(servedBody).not.toHaveBeenCalled();
	});
});
