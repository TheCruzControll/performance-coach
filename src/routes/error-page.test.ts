/**
 * The root error page loads on demand (src/routes/error-page.ts): +error.svelte renders it
 * synchronously once it has loaded (the server, hydration, any error after the load that
 * follows hydration) and waits for it otherwise.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Component } from 'svelte';
import { errorPage, lazy, loadErrorPage, provideErrorPage } from './error-page.ts';

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

describe('loadErrorPage', () => {
	it('starts the load at once, with no idle wait (WebKit has no requestIdleCallback)', async () => {
		const importer = vi.fn(() => Promise.resolve('page'));
		const page = lazy(importer);
		loadErrorPage(page);
		expect(importer).toHaveBeenCalledOnce();
		await vi.waitFor(() => expect(page.current()).toBe('page'));
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
			loadErrorPage(page);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).not.toHaveBeenCalled();
			expect(await page.current()).toBe('page');
		} finally {
			process.off('unhandledRejection', unhandled);
		}
	});
});
