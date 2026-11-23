import { describe, expect, it } from 'vitest';
import { shouldPreloadFont } from './fonts.ts';

// The file names SvelteKit reports for the faces declared in src/lib/ui/styles/fonts.css.
const GEIST_LATIN = 'geist-latin-wght-normal.woff2';
const GEIST_MONO_LATIN = 'geist-mono-latin-wght-normal.woff2';
const GEIST_LATIN_EXT = 'geist-latin-ext-wght-normal.woff2';
const GEIST_MONO_LATIN_EXT = 'geist-mono-latin-ext-wght-normal.woff2';

describe('shouldPreloadFont', () => {
	it('preloads the Geist latin face, which every screen paints its text in', () => {
		expect(shouldPreloadFont(GEIST_LATIN)).toBe(true);
	});

	it('preloads the Geist Mono latin face, which paints every label and number', () => {
		expect(shouldPreloadFont(GEIST_MONO_LATIN)).toBe(true);
	});

	it('leaves latin-ext and any other file to its unicode-range', () => {
		expect(shouldPreloadFont(GEIST_LATIN_EXT)).toBe(false);
		expect(shouldPreloadFont(GEIST_MONO_LATIN_EXT)).toBe(false);
		expect(shouldPreloadFont('geist-latin-wght-italic.woff2')).toBe(false);
		expect(shouldPreloadFont('geist-latin-wght-normal.woff')).toBe(false);
		expect(shouldPreloadFont('mona-sans-latin-wght-normal.woff2')).toBe(false);
	});
});
