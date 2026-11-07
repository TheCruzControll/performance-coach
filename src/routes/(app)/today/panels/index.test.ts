import { describe, expect, it } from 'vitest';
import type { Component } from 'svelte';
import { preloadPanel, settledPanel } from './index.ts';

const Panel = (() => {}) as unknown as Component;

describe('preloadPanel', () => {
	it('records the imported component for PanelLoader to render as the server sent it', async () => {
		const load = async () => ({ default: Panel });
		expect(settledPanel(load)).toBeUndefined();
		await preloadPanel(load);
		expect(settledPanel(load)).toBe(Panel);
	});

	it('records a failed import instead of rejecting, and the next call imports again', async () => {
		const gone = new TypeError('Failed to fetch dynamically imported module');
		let attempts = 0;
		const load = async () => {
			attempts++;
			if (attempts === 1) throw gone;
			return { default: Panel };
		};
		await expect(preloadPanel(load)).resolves.toBeUndefined();
		expect(settledPanel(load)).toBe(gone);
		await preloadPanel(load);
		expect(attempts).toBe(2);
		expect(settledPanel(load)).toBe(Panel);
	});

	it('records a non-Error rejection as an Error, so PanelLoader still offers Retry', async () => {
		const load = () => Promise.reject('offline');
		await preloadPanel(load);
		expect(settledPanel(load)).toEqual(new Error('offline'));
	});
});
