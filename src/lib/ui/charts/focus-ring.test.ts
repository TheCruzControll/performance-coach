import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrast, MODES, type Mode } from './palette-check.ts';

/**
 * The keyboard focus ring (`--color-accent-ring`) against every surface it can sit on, in both
 * themes. WCAG 1.4.11 (non-text contrast) and 2.4.13 (focus appearance) need 3:1 between the
 * ring and what is next to it. A translucent ring is measured as it renders: blended over the
 * surface first.
 */

const CSS = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');

/** WCAG's minimum for a focus indicator against its neighbour. */
const RING_CONTRAST = 3;

type Rgba = readonly [number, number, number, number];

/** `#rrggbb` or `rgb(r g b / a)` as red, green, blue (0-255) and alpha (0-1). */
function parseColour(value: string): Rgba {
	const hex = /^#([0-9a-f]{6})$/i.exec(value);
	if (hex) {
		const c = (i: number) => parseInt(hex[1]!.slice(i, i + 2), 16);
		return [c(0), c(2), c(4), 1];
	}
	const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)\s*)?\)$/.exec(value);
	if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4] ?? 1)];
	throw new Error(`not a colour this test reads: ${value}`);
}

/** A token's colour in one theme, from its `light-dark(<light>, <dark>)` declaration. */
function token(name: string, mode: Mode): Rgba {
	const declaration = new RegExp(`${name}:\\s*light-dark\\((.+?)\\);`).exec(CSS);
	if (!declaration) throw new Error(`${name} is not declared with light-dark()`);
	const parts = declaration[1]!.split(/,(?![^(]*\))/).map((part) => part.trim());
	expect(parts, name).toHaveLength(2);
	return parseColour(parts[mode === 'light' ? 0 : 1]!);
}

/** `top` painted over an opaque `bottom`, as `#rrggbb`. */
function over(top: Rgba, bottom: Rgba): string {
	expect(bottom[3], 'the backdrop is opaque').toBe(1);
	const a = top[3];
	return (
		'#' +
		[0, 1, 2]
			.map((i) => Math.round(top[i]! * a + bottom[i]! * (1 - a)))
			.map((c) => c.toString(16).padStart(2, '0'))
			.join('')
	);
}

/** The opaque surfaces, and the glass bars (blended over the canvas they float on). */
function surfaces(mode: Mode): Record<string, Rgba> {
	const canvas = token('--color-canvas', mode);
	const opaque: Record<string, Rgba> = {
		canvas,
		'surface-1': token('--color-surface-1', mode),
		'surface-2': token('--color-surface-2', mode),
		'surface-3': token('--color-surface-3', mode)
	};
	return { ...opaque, glass: parseColour(over(token('--color-glass', mode), canvas)) };
}

describe('the focus ring', () => {
	for (const mode of MODES) {
		it(`reaches 3:1 against the canvas and every surface (${mode})`, () => {
			const ring = token('--color-accent-ring', mode);
			const measured = Object.entries(surfaces(mode)).map(([name, surface]) => {
				const ratio = contrast(over(ring, surface), over(surface, surface));
				return { name, ratio: Number(ratio.toFixed(2)) };
			});
			expect(measured.filter((m) => m.ratio < RING_CONTRAST)).toEqual([]);
		});
	}

	it('is opaque in light, so its contrast never depends on what it sits on', () => {
		expect(token('--color-accent-ring', 'light')[3]).toBe(1);
	});
});
