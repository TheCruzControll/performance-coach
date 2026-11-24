import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVED_IN_PLACE } from './panels/index.ts';
import type * as Panels from './panels/index.ts';

const preloadPanel = vi.hoisted(() => vi.fn(async () => {}));
const Panel = vi.hoisted(() => () => {});
const servedPanel = vi.hoisted(() => vi.fn(async () => '<section>the panel</section>'));
vi.mock('./panels', async (original) => ({
	...(await original<typeof Panels>()),
	preloadPanel,
	settledPanel: () => Panel,
	servedPanel
}));

/** +page.ts as a fresh module: in the browser (on a document opened at `pathname`) or the server. */
async function loadModule(where: { browser: false } | { browser: true; pathname: string }) {
	vi.resetModules();
	vi.doMock('$app/env', () => ({ browser: where.browser }));
	if (where.browser) vi.stubGlobal('location', { pathname: where.pathname });
	const { load } = await import('./+page.ts');
	// The panels as this fresh +page.ts sees them.
	const { PANELS } = await import('./panels');
	return { load, PANELS };
}

type Module = Awaited<ReturnType<typeof loadModule>>;
const run = async (module: Module, setup: unknown, program?: unknown, plan?: unknown) =>
	module.load({ data: { setup, program, plan } } as unknown as Parameters<Module['load']>[0]);

/** Whether the load finishes while the panel's import is still held. */
async function finishesBeforeImport(module: Module): Promise<boolean> {
	let finish = () => {};
	preloadPanel.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
	let settled = false;
	const loading = run(module, { complete: true, goals: [], week: {} }, 'none').then(
		() => (settled = true)
	);
	// Every microtask has run: only the held import can keep the load from finishing.
	await new Promise((resolve) => setTimeout(resolve, 0));
	const early = settled;
	finish();
	await loading;
	return early;
}

beforeEach(() => {
	preloadPanel.mockClear();
	servedPanel.mockClear();
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock('$app/env');
});

describe("Today's universal load", () => {
	it('imports the setup card while onboarding is incomplete, the build card with no program (no summary)', async () => {
		const module = await loadModule({ browser: false });
		const setup = { complete: false, done: 2, total: 10, next: 'experience' };
		await expect(run(module, setup)).resolves.toMatchObject({ setup });
		expect(preloadPanel).toHaveBeenCalledExactlyOnceWith(module.PANELS.setup);
		preloadPanel.mockClear();
		const done = { complete: true, goals: [], week: {} };
		await expect(run(module, done, 'none')).resolves.toMatchObject({ setup: done });
		expect(preloadPanel).toHaveBeenCalledExactlyOnceWith(module.PANELS.build);
		expect(module.PANELS).not.toHaveProperty('summary');
	});

	it('imports no panel when the setup read failed', async () => {
		const module = await loadModule({ browser: false });
		await expect(run(module, null)).resolves.toEqual({
			setup: null,
			program: undefined,
			served: {}
		});
		expect(preloadPanel).not.toHaveBeenCalled();
	});

	it('with no program, imports the Build card and sends it as markup', async () => {
		const module = await loadModule({ browser: false });
		const setup = { complete: true, goals: [], week: {} };
		await expect(run(module, setup, 'none')).resolves.toEqual({
			setup,
			program: 'none',
			served: { build: '<section>the panel</section>' }
		});
		expect(preloadPanel).toHaveBeenCalledExactlyOnceWith(module.PANELS.build);
		preloadPanel.mockClear();
		// Once the program read failed, no panel: the setup error's Retry.
		await expect(run(module, setup, null)).resolves.toEqual({
			setup,
			program: null,
			served: {}
		});
		expect(preloadPanel).not.toHaveBeenCalled();
	});

	it('with a program, waits for the streamed plan on the server and renders it into the markup', async () => {
		const module = await loadModule({ browser: false });
		const setup = { complete: true, goals: [], week: {} };
		const plan = {
			failed: false,
			today: '2026-11-05',
			dots: null,
			day: { state: 'rest', title: 'Rest day', lines: [], rows: [] },
			others: [],
			coming: [],
			review: null
		};
		const loaded = await run(module, setup, 'active', Promise.resolve(plan));
		expect(loaded).toMatchObject({ plan, served: { program: '<section>the panel</section>' } });
		expect(preloadPanel).toHaveBeenCalledExactlyOnceWith(module.PANELS.program);
		// The panel is rendered with the plan settled.
		expect(servedPanel).toHaveBeenCalledExactlyOnceWith(Panel, { setup, plan });
	});

	it('hydrating Today takes the plan as settled; a client navigation passes the promise on', async () => {
		const setup = { complete: true, goals: [], week: {} };
		const plan = { failed: true };
		const module = await loadModule({ browser: true, pathname: '/today' });
		const hydrating = await run(module, setup, 'active', Promise.resolve(plan));
		expect(hydrating).toMatchObject({ plan, served: { program: SERVED_IN_PLACE } });
		const streamed = Promise.resolve(plan);
		const navigated = (await run(module, setup, 'active', streamed)) as { plan: unknown };
		expect(navigated.plan).toBe(streamed);
	});

	it('waits for the import on the server, and sends the panel as markup', async () => {
		const module = await loadModule({ browser: false });
		expect(await finishesBeforeImport(module)).toBe(false);
		const setup = { complete: true, goals: [], week: {} };
		await expect(run(module, setup, 'none')).resolves.toEqual({
			setup,
			program: 'none',
			served: { build: '<section>the panel</section>' }
		});
		expect(servedPanel).toHaveBeenLastCalledWith(Panel, { setup, plan: undefined });
	});

	it('never waits for it in the browser: hydrating Today keeps the server’s markup instead', async () => {
		const module = await loadModule({ browser: true, pathname: '/today' });
		const setup = { complete: true, goals: [], week: {} };
		// The hydrating load finishes while the panel's import is held.
		preloadPanel.mockImplementationOnce(() => new Promise<void>(() => {}));
		const hydrating = await Promise.race([
			run(module, setup, 'none'),
			new Promise((resolve) => setTimeout(() => resolve('held'), 0))
		]);
		expect(hydrating).toEqual({ setup, program: 'none', served: { build: SERVED_IN_PLACE } });
		expect(servedPanel).not.toHaveBeenCalled();
		// Any later load in that document (an invalidation, a navigation back) shows the skeleton.
		await expect(run(module, setup, 'none')).resolves.toEqual({
			setup,
			program: 'none',
			served: {}
		});
	});

	it('does not wait on a client navigation: Today shows the panel’s skeleton at once', async () => {
		const module = await loadModule({ browser: true, pathname: '/train' });
		expect(await finishesBeforeImport(module)).toBe(true);
		expect(preloadPanel).toHaveBeenCalledExactlyOnceWith(module.PANELS.build);
	});

	it('names no panel import in its own source, which check-budgets would count as initial JS', () => {
		expect.assertions(1);
		const here = path.dirname(new URL(import.meta.url).pathname);
		const source = readFileSync(path.join(here, '+page.ts'), 'utf8');
		// scripts/check-budgets.ts (loadImports): the dynamic imports a load awaits before hydrating.
		expect(source).not.toMatch(/import\(\s*['"`]\.{1,2}\//);
	});
});
