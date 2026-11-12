import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIVERGING, FURNITURE, SERIES_TOKEN } from '../charts/palette.ts';
import {
	checkPalette,
	colourOf,
	contrast,
	MODES,
	readTokens,
	STATUS_TOKENS,
	type Tokens
} from '../charts/palette-check.ts';

const read = (name: string) =>
	readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const GRAPHITE = read('graphite.css');
const TOKENS_CSS = read('tokens.css');

const SCOPE = ":root[data-design='graphite']";
/** The one rule that sets Graphite's tokens. */
const BLOCK = (() => {
	const start = GRAPHITE.indexOf(`${SCOPE} {`);
	return GRAPHITE.slice(start + SCOPE.length + 2, GRAPHITE.indexOf('\n}', start));
})();
/** Each custom property Graphite sets, with its value. */
const DECLARED = new Map(
	[...BLOCK.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()])
);
/** Every custom property tokens.css declares, in any of its rules. */
const TOKEN_NAMES = new Set([...TOKENS_CSS.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name!));

/** The roles Graphite adds (the proposal's materials), which today's design has no use for. */
const MATERIALS = [
	'--strip',
	'--strip-edge',
	'--gel',
	'--gel-pressed',
	'--gel-edge',
	'--plastic',
	'--plastic-pressed',
	'--plastic-edge',
	'--on-plastic',
	'--select',
	'--select-edge',
	'--select-ink',
	'--bar',
	'--bar-edge',
	'--lcd',
	'--lcd-edge',
	'--lcd-ink',
	'--lcd-ink-2',
	'--lcd-track'
];

/** Graphite's own colour tokens. */
const OWN = readTokens(`:root {${BLOCK}}`);
/** Today's colour tokens with Graphite's laid over them, as the cascade does in that design. */
const TOKENS: Tokens = new Map([...readTokens(TOKENS_CSS), ...OWN]);

/** The tokens a check reads that Graphite sets itself, so the check measures Graphite's values. */
const own = (names: readonly string[]) => names.filter((name) => OWN.has(name));

describe('graphite.css', () => {
	it('is the font faces and the one rule scoped to Graphite, and nothing else', () => {
		const rules = [...GRAPHITE.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(([, selector]) =>
			selector!.trim()
		);
		expect(rules).toEqual(['@font-face', '@font-face', SCOPE]);
		expect(GRAPHITE).not.toMatch(/@import|@media|!important/);
	});

	it('sets only the token names components already read, plus the new material roles', () => {
		const unknown = [...DECLARED.keys()].filter(
			(name) => !TOKEN_NAMES.has(name) && !MATERIALS.includes(name)
		);
		expect(unknown).toEqual([]);
		for (const name of MATERIALS) {
			expect(DECLARED.has(name), name).toBe(true);
			expect(TOKEN_NAMES.has(name), `${name} is new`).toBe(false);
		}
		// Palette, type, radii, materials, charts: every family of the proposal is mapped.
		for (const name of [
			'--color-accent',
			'--font-sans',
			'--text-base',
			'--radius-md',
			'--chart-combat'
		]) {
			expect(DECLARED.has(name), name).toBe(true);
		}
	});

	it('leaves the motion durations alone, so reduced motion still stops everything', () => {
		expect([...DECLARED.keys()].filter((name) => name.startsWith('--duration-'))).toEqual([]);
	});

	it('wraps only colour stops in light-dark(), never a gradient or a shadow', () => {
		expect(BLOCK).not.toMatch(/light-dark\(\s*[\w-]*gradient/);
		const calls = [...BLOCK.matchAll(/light-dark\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)];
		expect(calls.length).toBeGreaterThan(40);
		const COLOUR = /^(#[0-9a-f]{6}|rgb\([\d\s./]+\))$/i;
		for (const [call, args] of calls) {
			const stops = args!.split(/,(?![^()]*\))/).map((stop) => stop.trim());
			expect(stops.length, call).toBe(2);
			for (const stop of stops) expect(stop, call).toMatch(COLOUR);
		}
	});

	it('loads Source Sans 3 latin only, behind a metric-matched fallback', () => {
		const sources = [...GRAPHITE.matchAll(/url\('([^']+)'\)/g)].map(([, url]) => url);
		expect(sources).toEqual([
			'@fontsource-variable/source-sans-3/files/source-sans-3-latin-wght-normal.woff2'
		]);
		expect(GRAPHITE).toMatch(/font-family: 'Source Sans 3 Fallback';[^}]*size-adjust: [\d.]+%/);
		expect(DECLARED.get('--font-sans')).toMatch(/^'Source Sans 3', 'Source Sans 3 Fallback',/);
		expect(DECLARED.get('--font-display')).toBe('var(--font-sans)');
	});

	it('is in no route’s CSS: only the server imports it, as a URL', () => {
		// Every file under src that names it in a string (an import), tests aside; git grep is
		// quick where reading the whole tree is not on a busy runner.
		const importers = execFileSync(
			'git',
			['grep', '-l', '--untracked', '-E', `['"][^'"]*graphite\\.css`, '--', 'src', ':!*.test.ts'],
			{ encoding: 'utf8' }
		)
			.split('\n')
			.filter(Boolean);
		expect(importers).toEqual(['src/lib/server/design-assets.ts']);
		expect(readFileSync('src/lib/server/design-assets.ts', 'utf8')).toContain(
			"from '#lib/ui/styles/graphite.css?url'"
		);
	});
});

describe('Graphite’s colours', () => {
	it('pass every chart palette check on the box, in both themes', () => {
		const charted = [
			'--color-surface-1',
			...STATUS_TOKENS,
			...Object.values(SERIES_TOKEN),
			DIVERGING.zero,
			...Object.values(FURNITURE).filter((name) => name !== FURNITURE.surface)
		];
		expect(own(charted)).toEqual(charted);
		expect(checkPalette(TOKENS).problems).toEqual([]);
	});

	it('keep text and status colours at 4.5:1 or more on the canvas, the box and the well', () => {
		const measured = [
			'--color-text',
			'--color-text-secondary',
			'--color-text-tertiary',
			'--color-accent-text',
			'--color-canvas',
			'--color-surface-1',
			'--color-surface-2',
			'--color-on-accent',
			'--color-accent'
		];
		expect(own(measured)).toEqual(measured);
		const low: string[] = [];
		for (const mode of MODES) {
			for (const fg of [
				'--color-text',
				'--color-text-secondary',
				'--color-text-tertiary',
				'--color-accent-text',
				'--color-positive',
				'--color-warning',
				'--color-danger',
				'--color-info'
			]) {
				for (const bg of ['--color-canvas', '--color-surface-1', '--color-surface-2']) {
					const ratio = contrast(colourOf(TOKENS, fg, mode), colourOf(TOKENS, bg, mode));
					if (ratio < 4.5) low.push(`${fg} on ${bg} (${mode}): ${ratio.toFixed(2)}`);
				}
			}
			for (const fill of ['--color-accent', '--color-accent-hover', '--color-accent-pressed']) {
				const ratio = contrast(
					colourOf(TOKENS, '--color-on-accent', mode),
					colourOf(TOKENS, fill, mode)
				);
				if (ratio < 4.5) low.push(`--color-on-accent on ${fill} (${mode}): ${ratio.toFixed(2)}`);
			}
		}
		expect(low).toEqual([]);
	});

	it('trade volt for Aqua', () => {
		expect(colourOf(TOKENS, '--color-accent', 'dark')).toBe('#1a6bd6');
		expect(colourOf(readTokens(TOKENS_CSS), '--color-accent', 'dark')).toBe('#c8f031');
	});
});
