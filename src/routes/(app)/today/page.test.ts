import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Panels from './panels/index.ts';

const preloadPanel = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./panels', async (original) => ({
	...(await original<typeof Panels>()),
	preloadPanel
}));

/** +page.ts as a fresh module: in the browser (on a document opened at `pathname`) or the server. */
async function loadModule(where: { browser: false } | { browser: true; pathname: string }) {
	vi.resetModules();
	vi.doMock('$app/env', () => ({ browser: where.browser }));
	if (where.browser) vi.stubGlobal('location', { pathname: where.pathname });
	return import('./+page.ts');
}

type Module = Awaited<ReturnType<typeof loadModule>>;
const run = async (module: Module, setup: unknown) =>
	module.load({ data: { setup } } as unknown as Parameters<Module['load']>[0]);

/** Whether the load finishes while the panel's import is still held. */
async function finishesBeforeImport(module: Module): Promise<boolean> {
	let finish = () => {};
	preloadPanel.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
	let settled = false;
	const loading = run(module, { complete: true, goals: [], week: {} }).then(() => (settled = true));
	// Every microtask has run: only the held import can keep the load from finishing.
	await new Promise((resolve) => setTimeout(resolve, 0));
	const early = settled;
	finish();
	await loading;
	return early;
}

beforeEach(() => preloadPanel.mockClear());
afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock('$app/env');
});

describe("Today's universal load", () => {
	it('imports the setup card while onboarding is incomplete, the summary once complete', async () => {
		const module = await loadModule({ browser: false });
		const setup = { complete: false, done: 2, total: 10, next: 'experience' };
		await expect(run(module, setup)).resolves.toEqual({ setup });
		expect(preloadPanel).toHaveBeenCalledExactlyOnceWith(module._PANELS.setup);
		preloadPanel.mockClear();
		const done = { complete: true, goals: [], week: {} };
		await expect(run(module, done)).resolves.toEqual({ setup: done });
		expect(preloadPanel).toHaveBeenCalledExactlyOnceWith(module._PANELS.summary);
	});

	it('imports no panel when the setup read failed', async () => {
		const module = await loadModule({ browser: false });
		await expect(run(module, null)).resolves.toEqual({ setup: null });
		expect(preloadPanel).not.toHaveBeenCalled();
	});

	it('waits for the import on the server, so the panel is in the HTML', async () => {
		expect(await finishesBeforeImport(await loadModule({ browser: false }))).toBe(false);
	});

	it('waits for it while hydrating Today, so hydration finds the markup the server sent', async () => {
		const module = await loadModule({ browser: true, pathname: '/today' });
		expect(await finishesBeforeImport(module)).toBe(false);
		// Any later load in that document (an invalidation, a navigation back) does not wait.
		expect(await finishesBeforeImport(module)).toBe(true);
	});

	it('does not wait on a client navigation: Today shows the panel’s skeleton at once', async () => {
		const module = await loadModule({ browser: true, pathname: '/train' });
		expect(await finishesBeforeImport(module)).toBe(true);
		expect(preloadPanel).toHaveBeenCalledExactlyOnceWith(module._PANELS.summary);
	});

	it('names every panel’s import in its own source, where check-budgets counts it as initial JS', async () => {
		const { _PANELS } = await loadModule({ browser: false });
		const here = path.dirname(new URL(import.meta.url).pathname);
		const source = readFileSync(path.join(here, '+page.ts'), 'utf8');
		// scripts/check-budgets.ts (loadImports): the dynamic imports its load can await.
		const counted = [...source.matchAll(/import\(\s*['"`](\.{1,2}\/[^'"`]+)['"`]\s*\)/g)].map(
			([, spec]) => spec
		);
		expect(counted).toEqual(['./panels/Setup.svelte', './panels/Summary.svelte']);
		expect(Object.keys(_PANELS)).toHaveLength(counted.length);
	});
});
