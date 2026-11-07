import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

it('a setter used before anything loaded the saved preferences keeps the other saved ones', async () => {
	const stored = new Map([['pc:prefs:v1', '{"theme":"light","units":"lb","distance":"mi"}']]);
	vi.stubGlobal('window', {});
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => void stored.set(key, value)
	});
	const { PREFERENCES_KEY, preferences } = await import('./preferences.svelte.ts');

	preferences.setUnits('kg');
	expect(JSON.parse(stored.get(PREFERENCES_KEY)!)).toEqual({
		theme: 'light',
		units: 'kg',
		distance: 'mi'
	});
});
