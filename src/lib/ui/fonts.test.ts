import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shouldPreloadFont } from './fonts.ts';

// The file names SvelteKit reports for the faces declared in src/lib/ui/styles/fonts.css.
const MONA_LATIN = 'mona-sans-latin-wght-normal.woff2';
const MONA_LATIN_EXT = 'mona-sans-latin-ext-wght-normal.woff2';
const HUBOT_LATIN = 'hubot-sans-latin-wght-normal.woff2';
const HUBOT_LATIN_EXT = 'hubot-sans-latin-ext-wght-normal.woff2';

describe('shouldPreloadFont', () => {
	it('preloads the Mona Sans latin face, which every screen paints its text and numerals in', () => {
		expect(shouldPreloadFont(MONA_LATIN)).toBe(true);
	});

	it('leaves latin-ext, Hubot Sans, italic, the non-woff2 files and Geist to their own loading', () => {
		expect(shouldPreloadFont(MONA_LATIN_EXT)).toBe(false);
		expect(shouldPreloadFont(HUBOT_LATIN)).toBe(false);
		expect(shouldPreloadFont(HUBOT_LATIN_EXT)).toBe(false);
		expect(shouldPreloadFont('mona-sans-latin-wght-italic.woff2')).toBe(false);
		expect(shouldPreloadFont('mona-sans-latin-wght-normal.woff')).toBe(false);
		expect(shouldPreloadFont('geist-latin-wght-normal.woff2')).toBe(false);
	});
});

describe('the type stack', () => {
	// The tokens and the faces must not mention Geist or the removed mono family.
	const SOURCES = ['./styles/tokens.css', './styles/fonts.css'].map((path) =>
		readFileSync(new URL(path, import.meta.url), 'utf8')
	);

	it('names no Geist face and no --font-mono in tokens.css or fonts.css', () => {
		for (const css of SOURCES) {
			expect(css).not.toMatch(/geist/i);
			expect(css).not.toContain('--font-mono');
		}
	});
});
