/**
 * The root error page loads on demand (src/routes/error-page.ts): +error.svelte renders it
 * synchronously once it has loaded (the server, hydration, any error after the idle load) and
 * waits for it otherwise.
 */
import { describe, expect, it, vi } from 'vitest';
import { FALLBACK_DELAY_MS, IDLE_TIMEOUT_MS } from '#lib/client/service-worker.ts';
import type { Component } from 'svelte';
import {
	errorPage,
	lazy,
	loadErrorPageWhenIdle,
	provideErrorPage,
	type IdleHost
} from './error-page.ts';

describe('lazy', () => {
	it('loads nothing until asked', () => {
		const importer = vi.fn(() => Promise.resolve('page'));
		lazy(importer);
		expect(importer).not.toHaveBeenCalled();
	});

	it('gives the load until it has finished, then the value itself, importing once', async () => {
		const importer = vi.fn(() => Promise.resolve('page'));
		const page = lazy(importer);
		const first = page.current();
		expect(first).toBeInstanceOf(Promise);
		expect(page.current()).toBe(first);
		expect(page.load()).toBe(first);
		expect(await first).toBe('page');
		// Synchronous from now on: {#await} renders it at once and hydration matches the server.
		expect(page.current()).toBe('page');
		expect(importer).toHaveBeenCalledOnce();
	});

	it('loads again after a failed load (offline), and keeps the value once it arrives', async () => {
		const importer = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
			.mockResolvedValueOnce('page');
		const page = lazy(importer);
		await expect(page.load()).rejects.toThrow(TypeError);
		const retry = page.current();
		expect(retry).toBeInstanceOf(Promise);
		expect(await retry).toBe('page');
		expect(page.current()).toBe('page');
		expect(importer).toHaveBeenCalledTimes(2);
	});
});

describe('errorPage', () => {
	it('loads with the import +error.svelte provides, and fails until it has', async () => {
		await expect(errorPage.load()).rejects.toThrow(/not been provided/);
		const ErrorPage = (() => {}) as unknown as Component;
		const importer = vi.fn(() => Promise.resolve({ default: ErrorPage }));
		provideErrorPage(importer);
		expect(await errorPage.load()).toBe(ErrorPage);
		expect(errorPage.current()).toBe(ErrorPage);
		expect(importer).toHaveBeenCalledOnce();
	});
});

describe('loadErrorPageWhenIdle', () => {
	function fakeHost(idle: boolean) {
		const idles: { callback: () => void; timeout: number }[] = [];
		const timers: { callback: () => void; ms: number }[] = [];
		const host: IdleHost = {
			setTimeout: (callback, ms) => timers.push({ callback, ms }),
			...(idle
				? {
						requestIdleCallback: (callback: () => void, { timeout }: { timeout: number }) =>
							idles.push({ callback, timeout })
					}
				: {})
		};
		return { host, idles, timers };
	}

	it('loads the page in the next idle period, not before', async () => {
		const importer = vi.fn(() => Promise.resolve('page'));
		const page = lazy(importer);
		const { host, idles, timers } = fakeHost(true);
		loadErrorPageWhenIdle(page, host);
		expect(importer).not.toHaveBeenCalled();
		expect(idles.map((i) => i.timeout)).toEqual([IDLE_TIMEOUT_MS]);
		expect(timers).toEqual([]);

		idles[0]!.callback();
		expect(importer).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(page.current()).toBe('page'));
	});

	it('waits a fixed delay where requestIdleCallback is missing (WebKit)', () => {
		const importer = vi.fn(() => Promise.resolve('page'));
		const { host, timers } = fakeHost(false);
		loadErrorPageWhenIdle(lazy(importer), host);
		expect(timers.map((t) => t.ms)).toEqual([FALLBACK_DELAY_MS]);
		timers[0]!.callback();
		expect(importer).toHaveBeenCalledOnce();
	});

	it('swallows a failed load: no unhandled rejection, and the page loads again on demand', async () => {
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		try {
			const importer = vi
				.fn<() => Promise<string>>()
				.mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
				.mockResolvedValueOnce('page');
			const page = lazy(importer);
			const { host, idles } = fakeHost(true);
			loadErrorPageWhenIdle(page, host);
			idles[0]!.callback();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).not.toHaveBeenCalled();
			expect(await page.current()).toBe('page');
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});
});
