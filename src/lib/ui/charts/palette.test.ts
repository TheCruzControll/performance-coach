import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIVERGING, FURNITURE, SERIES_TOKEN, STACK_ORDER } from './palette.ts';
import {
	checkPalette,
	colourOf,
	contrast,
	cvdDeltaE,
	deltaE,
	oklch,
	readTokens,
	type Check,
	type Mode,
	type Tokens
} from './palette-check.ts';

const CSS = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
const TOKENS = readTokens(CSS);

/** The tokens with some values replaced, as a stylesheet would declare them. */
function withTokens(changes: Record<string, string>): Tokens {
	const next = new Map(TOKENS);
	for (const [name, value] of Object.entries(changes)) {
		next.set(name, readTokens(`:root { ${name}: ${value}; }`).get(name)!);
	}
	return next;
}

/** The checks that fail, with their themes: 'series lightness band (dark)'. */
const failing = (tokens: Tokens, order?: Parameters<typeof checkPalette>[1]) =>
	[...new Set(checkPalette(tokens, order).problems.map((p) => `${p.check} (${p.mode})`))].sort();

const at = (check: Check, mode: Mode) => `${check} (${mode})`;
const round = (n: number, digits = 1) => Number(n.toFixed(digits));

describe('the colour maths (ported from the dataviz palette validator)', () => {
	it('computes OKLCH, ΔE and contrast as the validator does', () => {
		expect(round(oklch('#ffffff').l, 3)).toBe(1);
		expect(round(oklch('#808080').c, 3)).toBe(0);
		expect(round(contrast('#000000', '#ffffff'), 2)).toBe(21);
		expect(round(contrast('#86867f', '#ffffff'), 2)).toBe(3.66);
		expect(round(deltaE('#000000', '#ffffff'))).toBe(100);
		// Strength and combat under deuteranopia, dark steps (the validator: ΔE 2.3).
		expect(round(deltaE('#c08600', '#ef5b3f', 'deutan'))).toBe(2.3);
		expect(round(cvdDeltaE('#3f74e6', '#c63d6b'))).toBe(19.9);
	});
});

describe('tokens.css', () => {
	it('declares every chart token in both themes, and charts sit on surface-1', () => {
		for (const name of [
			...Object.values(SERIES_TOKEN),
			...Object.values(DIVERGING),
			...Object.values(FURNITURE)
		]) {
			expect(TOKENS.get(name), name).toBeDefined();
		}
		expect(TOKENS.get(FURNITURE.surface)).toEqual({ ref: '--color-surface-1' });
		expect(colourOf(TOKENS, FURNITURE.surface, 'light')).toBe('#ffffff');
		expect(colourOf(TOKENS, FURNITURE.surface, 'dark')).toBe('#121214');
	});

	it('keeps the light series on M1’s discipline values and steps the dark ones into the band', () => {
		for (const tone of STACK_ORDER) {
			expect(colourOf(TOKENS, SERIES_TOKEN[tone], 'light')).toBe(
				colourOf(TOKENS, `--color-${tone}`, 'light')
			);
			expect(colourOf(TOKENS, SERIES_TOKEN[tone], 'dark')).not.toBe(
				colourOf(TOKENS, `--color-${tone}`, 'dark')
			);
		}
		expect(STACK_ORDER.map((tone) => colourOf(TOKENS, SERIES_TOKEN[tone], 'dark'))).toEqual([
			'#c08600',
			'#9e79e9',
			'#00ac8d',
			'#ef5b3f',
			'#0da0cd'
		]);
	});

	it('passes every palette check in both themes', () => {
		expect(checkPalette(TOKENS).problems).toEqual([]);
	});

	it('matches the validator’s figures (re-run 2026-11-06)', () => {
		const { light, dark } = checkPalette(TOKENS).measures;
		// Series, adjacent in the stack order.
		expect(round(dark.seriesAdjacentCvd)).toBe(11.1);
		expect(round(light.seriesAdjacentCvd)).toBe(10.3);
		expect(round(dark.seriesAdjacentNormal)).toBe(25.6);
		expect(round(light.seriesAdjacentNormal)).toBe(28.3);
		// The poles.
		expect(round(light.poleNormal)).toBe(27.7);
		expect(round(dark.poleNormal)).toBe(26.6);
		expect(round(light.poleCvd)).toBe(19.9);
		expect(round(dark.poleCvd)).toBe(17.3);
		// The midpoint.
		expect(round(light.midpointContrast, 2)).toBe(3.66);
		expect(round(dark.midpointContrast, 2)).toBe(4.03);
		// The closest a pole comes to a status or series colour.
		expect(light.closestPole).toMatchObject({
			pole: '--chart-diverge-warm',
			token: '--color-danger'
		});
		expect(round(light.closestPole.deltaE)).toBe(8.6);
		expect(dark.closestPole).toMatchObject({
			pole: '--chart-diverge-warm',
			token: '--chart-combat'
		});
		expect(round(dark.closestPole.deltaE)).toBe(9.6);
	});
});

describe('the checks fail by name', () => {
	it('on M1’s dark discipline values, which sit above the dark band', () => {
		const m1Dark = withTokens(
			Object.fromEntries(
				STACK_ORDER.map((tone) => {
					const light = colourOf(TOKENS, `--color-${tone}`, 'light');
					const dark = colourOf(TOKENS, `--color-${tone}`, 'dark');
					return [SERIES_TOKEN[tone], `light-dark(${light}, ${dark})`];
				})
			)
		);
		const problems = checkPalette(m1Dark).problems;
		expect(problems.filter((p) => p.check === 'series lightness band')).toHaveLength(5);
		expect(failing(m1Dark)).toEqual([
			at('series lightness band', 'dark'),
			// M1's dark strength is the warning colour within ΔE 0.7.
			at('status vs series', 'dark')
		]);
	});

	it('on strength next to combat (deuteranopia ΔE 2.3)', () => {
		// Every other neighbour in this order passes: only the strength–combat pair fails.
		const order = ['hypertrophy', 'conditioning', 'strength', 'combat', 'running'] as const;
		expect(failing(TOKENS, order)).toEqual([
			at('series adjacent CVD', 'dark'),
			at('series adjacent CVD', 'light'),
			at('series adjacent normal vision', 'dark'),
			at('series adjacent normal vision', 'light')
		]);
		const cvd = checkPalette(TOKENS, order).problems.filter(
			(p) => p.check === 'series adjacent CVD'
		);
		expect(cvd.map((p) => `${p.mode}: ${p.detail}`)).toEqual([
			'light: --chart-strength next to --chart-combat: ΔE 2.4',
			'dark: --chart-strength next to --chart-combat: ΔE 2.3'
		]);
	});

	it('on a coloured midpoint', () => {
		const tinted = withTokens({ [DIVERGING.zero]: 'light-dark(#8a8470, #74747a)' });
		expect(failing(tinted)).toEqual([at('diverging midpoint chroma', 'light')]);
	});

	it('on a pole too close to --color-danger', () => {
		const near = withTokens({ [DIVERGING.above]: 'light-dark(#c2343f, #d9507a)' });
		expect(failing(near)).toEqual([at('diverging pole distance', 'light')]);
		expect(checkPalette(near).problems[0]!.detail).toMatch(
			/^--chart-diverge-warm to --color-danger: ΔE /
		);
	});

	it('on poles that are hard to tell apart', () => {
		const close = withTokens({ [DIVERGING.below]: 'light-dark(#b04a8a, #4f78e8)' });
		expect(failing(close)).toEqual([
			at('diverging pole CVD', 'light'),
			at('diverging pole normal vision', 'light')
		]);
	});

	it('on furniture that reads as data, or charts on another surface', () => {
		expect(failing(withTokens({ [FURNITURE.grid]: 'light-dark(#86867f, #1f1f23)' }))).toEqual([
			at('chart furniture', 'light')
		]);
		expect(failing(withTokens({ [FURNITURE.surface]: 'var(--color-surface-2)' }))).toEqual([
			// The light context series drops to 2.89:1 on surface-2.
			at('chart furniture', 'light'),
			at('chart surface', 'dark'),
			at('chart surface', 'light'),
			// Light conditioning is 2.95:1 on surface-2.
			at('series mark contrast', 'light')
		]);
	});
});
