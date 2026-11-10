import { describe, expect, it } from 'vitest';
import { shouldPreloadFont } from './fonts.ts';

// The file names SvelteKit reports for the faces declared in src/lib/ui/styles/fonts.css.
const MONA_LATIN = 'mona-sans-latin-wght-normal.woff2';
const MONA_LATIN_EXT = 'mona-sans-latin-ext-wght-normal.woff2';
const HUBOT_LATIN = 'hubot-sans-latin-wght-normal.woff2';

describe('shouldPreloadFont', () => {
	it('preloads the Mona Sans latin face, which every screen paints its text and numbers in', () => {
		expect(shouldPreloadFont(MONA_LATIN)).toBe(true);
	});

	it('leaves the Hubot Sans headings face to load when a heading uses it', () => {
		// Preloaded, its 48 KB shared the connection with the app's start-up on every route.
		expect(shouldPreloadFont(HUBOT_LATIN)).toBe(false);
	});

	it('leaves latin-ext and any other file to its unicode-range', () => {
		expect(shouldPreloadFont(MONA_LATIN_EXT)).toBe(false);
		expect(shouldPreloadFont('mona-sans-latin-wght-italic.woff2')).toBe(false);
		expect(shouldPreloadFont('mona-sans-latin-wght-normal.woff')).toBe(false);
	});
});
