/**
 * The chart palette checks, computed (never judged by eye) from the tokens in tokens.css. A test
 * helper for palette.test.ts: no screen imports it.
 *
 * The colour maths is ported from the dataviz palette validator (validate_palette.js), and its
 * thresholds are calibrated to it:
 * - OKLab and OKLCH from sRGB (Björn Ottosson's matrices);
 * - protanopia and deuteranopia simulated with Machado, Oliveira & Fernandes (2009) at
 *   severity 1.0, in linear RGB (the thresholds assume this model: another one moves
 *   borderline pairs);
 * - ΔE as Euclidean distance in OKLab ×100, and the WCAG 2 contrast ratio.
 */
import { DIVERGING, FURNITURE, SERIES_TOKEN, STACK_ORDER } from './palette.ts';
import type { DisciplineTone } from '#lib/domain/profile/catalog.ts';

export type Mode = 'light' | 'dark';
export const MODES: readonly Mode[] = ['light', 'dark'];

/** OKLCH lightness a series must sit in, per theme (the validator's bands). */
export const LIGHTNESS_BAND: Readonly<Record<Mode, readonly [number, number]>> = {
	light: [0.43, 0.77],
	dark: [0.48, 0.67]
};
/** Below this OKLCH chroma a hue reads as grey. */
export const CHROMA_FLOOR = 0.1;
/** Above this OKLCH chroma a grey reads as a hue. */
export const GREY_CEILING = 0.02;
/** Neighbours under simulated protanopia and deuteranopia (the lower of the two). */
export const CVD_MIN = 8;
/** Neighbours under normal vision. */
export const NORMAL_MIN = 15;
/** A diverging pole against every status and series colour, under normal vision. */
export const POLE_TOKEN_MIN = 8;
/**
 * A status colour against a series colour, under normal vision: about the just-noticeable
 * difference in OKLab, so the two are never the same colour. Status never relies on colour to
 * tell it from a series: it always carries an icon and a word.
 */
export const STATUS_SERIES_MIN = 2;
/** WCAG non-text contrast: a mark against the chart surface. */
export const MARK_CONTRAST = 3;

export const STATUS_TOKENS = [
	'--color-positive',
	'--color-warning',
	'--color-danger',
	'--color-info'
] as const;

// ---- Colour maths ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

const MACHADO = {
	protan: [
		[0.152286, 1.052583, -0.204868],
		[0.114503, 0.786281, 0.099216],
		[-0.003882, -0.048116, 1.051998]
	],
	deutan: [
		[0.367322, 0.860646, -0.227968],
		[0.280085, 0.672501, 0.047413],
		[-0.01182, 0.04294, 0.968881]
	]
} as const;
export type Deficiency = keyof typeof MACHADO;

function linearRgb(hex: string): Rgb {
	const match = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!match) throw new Error(`not a #rrggbb colour: ${hex}`);
	const channel = (i: number) => {
		const c = parseInt(match[1]!.slice(i, i + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return [channel(0), channel(2), channel(4)];
}

function oklabOf([r, g, b]: Rgb): Rgb {
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
	];
}

function simulate(rgb: Rgb, kind: Deficiency): Rgb {
	const clamp = (c: number) => Math.max(0, Math.min(1, c));
	const [r, g, b] = rgb;
	const [x, y, z] = MACHADO[kind].map((row) => clamp(row[0] * r + row[1] * g + row[2] * b));
	return [x!, y!, z!];
}

export const oklab = (hex: string): Rgb => oklabOf(linearRgb(hex));

/** OKLCH lightness and chroma. */
export function oklch(hex: string): { l: number; c: number } {
	const [l, a, b] = oklab(hex);
	return { l, c: Math.hypot(a, b) };
}

/** OKLab ΔE ×100, under normal vision or a simulated deficiency. */
export function deltaE(a: string, b: string, kind?: Deficiency): number {
	const lab = (hex: string) => oklabOf(kind ? simulate(linearRgb(hex), kind) : linearRgb(hex));
	const [x, y] = [lab(a), lab(b)];
	return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** The lower ΔE of protanopia and deuteranopia. */
export const cvdDeltaE = (a: string, b: string) =>
	Math.min(deltaE(a, b, 'protan'), deltaE(a, b, 'deutan'));

/** WCAG 2 contrast ratio. */
export function contrast(a: string, b: string): number {
	const luminance = (hex: string) => {
		const [r, g, bl] = linearRgb(hex);
		return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
	};
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}

// ---- Tokens ---------------------------------------------------------------------------------

/** A token's declared value: a light and a dark colour, or another token. */
export type TokenValue = { light: string; dark: string } | { ref: string };
export type Tokens = ReadonlyMap<string, TokenValue>;

/**
 * The colour tokens declared in the first `:root` block of a tokens stylesheet: `#rrggbb`,
 * `light-dark(#rrggbb, #rrggbb)` or `var(--other)`. Other values are left out.
 */
export function readTokens(css: string): Tokens {
	const root = /:root\s*\{([^}]*)\}/.exec(css.replace(/\/\*[\s\S]*?\*\//g, ''));
	if (!root) throw new Error('no :root block');
	const tokens = new Map<string, TokenValue>();
	for (const [, name, raw] of root[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
		const value = raw!.trim();
		const pair = /^light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)$/i.exec(value);
		const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(value);
		if (pair) tokens.set(name!, { light: pair[1]!, dark: pair[2]! });
		else if (/^#[0-9a-f]{6}$/i.test(value)) tokens.set(name!, { light: value, dark: value });
		else if (ref) tokens.set(name!, { ref: ref[1]! });
	}
	return tokens;
}

/** A token's colour in a theme, following `var()` references. */
export function colourOf(tokens: Tokens, name: string, mode: Mode): string {
	const seen = new Set<string>();
	let current = name;
	for (;;) {
		const value = tokens.get(current);
		if (!value) throw new Error(`no colour token ${current}`);
		if (!('ref' in value)) return value[mode];
		if (seen.has(current)) throw new Error(`token cycle at ${current}`);
		seen.add(current);
		current = value.ref;
	}
}

// ---- The checks -----------------------------------------------------------------------------

export type Check =
	| 'series lightness band'
	| 'series chroma floor'
	| 'series adjacent CVD'
	| 'series adjacent normal vision'
	| 'series mark contrast'
	| 'diverging pole contrast'
	| 'diverging pole CVD'
	| 'diverging pole normal vision'
	| 'diverging midpoint chroma'
	| 'diverging midpoint contrast'
	| 'diverging pole distance'
	| 'status vs series'
	| 'chart surface'
	| 'chart furniture';

export interface Problem {
	check: Check;
	mode: Mode;
	detail: string;
}

/** The figures the checks compare, per theme, for the record (the PR and the docs quote them). */
export interface ModeMeasures {
	/** The lowest neighbour ΔE in the stack order: under a deficiency, and under normal vision. */
	seriesAdjacentCvd: number;
	seriesAdjacentNormal: number;
	poleNormal: number;
	poleCvd: number;
	midpointContrast: number;
	/** The closest any pole comes to a status or series colour (normal vision). */
	closestPole: { pole: string; token: string; deltaE: number };
}

export interface PaletteReport {
	problems: Problem[];
	measures: Record<Mode, ModeMeasures>;
}

const f1 = (n: number) => n.toFixed(1);
const f2 = (n: number) => n.toFixed(2);

/** Every palette check, in both themes, on the chart surface. `order` defaults to STACK_ORDER. */
export function checkPalette(
	tokens: Tokens,
	order: readonly DisciplineTone[] = STACK_ORDER
): PaletteReport {
	const problems: Problem[] = [];
	const measures = {} as Record<Mode, ModeMeasures>;

	const surface = tokens.get(FURNITURE.surface);
	if (!surface || !('ref' in surface) || surface.ref !== '--color-surface-1') {
		for (const mode of MODES) {
			problems.push({
				check: 'chart surface',
				mode,
				detail: `${FURNITURE.surface} is not surface-1`
			});
		}
	}

	for (const mode of MODES) {
		const fail = (check: Check, detail: string) => problems.push({ check, mode, detail });
		const hex = (name: string) => colourOf(tokens, name, mode);
		const bg = hex(FURNITURE.surface);
		const series = order.map((tone) => ({
			name: SERIES_TOKEN[tone],
			hex: hex(SERIES_TOKEN[tone])
		}));

		// Series: each one, then each neighbour.
		const [lo, hi] = LIGHTNESS_BAND[mode];
		for (const s of series) {
			const { l, c } = oklch(s.hex);
			if (l < lo || l > hi)
				fail('series lightness band', `${s.name} L ${l.toFixed(3)} outside ${lo}–${hi}`);
			if (c < CHROMA_FLOOR)
				fail('series chroma floor', `${s.name} C ${c.toFixed(3)} < ${CHROMA_FLOOR}`);
			const ratio = contrast(s.hex, bg);
			if (ratio < MARK_CONTRAST) fail('series mark contrast', `${s.name} ${f2(ratio)}:1`);
		}
		let adjacentCvd = Infinity;
		let adjacentNormal = Infinity;
		for (let i = 1; i < series.length; i++) {
			const [a, b] = [series[i - 1]!, series[i]!];
			const cvd = cvdDeltaE(a.hex, b.hex);
			const normal = deltaE(a.hex, b.hex);
			adjacentCvd = Math.min(adjacentCvd, cvd);
			adjacentNormal = Math.min(adjacentNormal, normal);
			if (cvd < CVD_MIN) fail('series adjacent CVD', `${a.name} next to ${b.name}: ΔE ${f1(cvd)}`);
			if (normal < NORMAL_MIN) {
				fail('series adjacent normal vision', `${a.name} next to ${b.name}: ΔE ${f1(normal)}`);
			}
		}

		// The diverging pair.
		const cool = { name: DIVERGING.below, hex: hex(DIVERGING.below) };
		const warm = { name: DIVERGING.above, hex: hex(DIVERGING.above) };
		const mid = hex(DIVERGING.zero);
		for (const pole of [cool, warm]) {
			const ratio = contrast(pole.hex, bg);
			if (ratio < MARK_CONTRAST) fail('diverging pole contrast', `${pole.name} ${f2(ratio)}:1`);
		}
		const poleNormal = deltaE(cool.hex, warm.hex);
		const poleCvd = cvdDeltaE(cool.hex, warm.hex);
		if (poleCvd < CVD_MIN) fail('diverging pole CVD', `ΔE ${f1(poleCvd)}`);
		if (poleNormal < NORMAL_MIN) fail('diverging pole normal vision', `ΔE ${f1(poleNormal)}`);
		const midChroma = oklch(mid).c;
		if (midChroma >= GREY_CEILING) {
			fail('diverging midpoint chroma', `${DIVERGING.zero} C ${midChroma.toFixed(3)}`);
		}
		const midpointContrast = contrast(mid, bg);
		if (midpointContrast < MARK_CONTRAST) {
			fail('diverging midpoint contrast', `${DIVERGING.zero} ${f2(midpointContrast)}:1`);
		}
		let closestPole = { pole: '', token: '', deltaE: Infinity };
		for (const pole of [cool, warm]) {
			for (const token of [...STATUS_TOKENS, ...series.map((s) => s.name)]) {
				const d = deltaE(pole.hex, hex(token));
				if (d < closestPole.deltaE) closestPole = { pole: pole.name, token, deltaE: d };
				if (d < POLE_TOKEN_MIN)
					fail('diverging pole distance', `${pole.name} to ${token}: ΔE ${f1(d)}`);
			}
		}

		// Status is never a series colour.
		for (const status of STATUS_TOKENS) {
			for (const s of series) {
				const d = deltaE(hex(status), s.hex);
				if (d < STATUS_SERIES_MIN) fail('status vs series', `${status} to ${s.name}: ΔE ${f1(d)}`);
			}
		}

		// Furniture: greys; the quiet ones recede in order and stay below a mark's contrast.
		const ratioOf = (name: string) => contrast(hex(name), bg);
		for (const name of Object.values(FURNITURE).filter((n) => n !== FURNITURE.surface)) {
			const c = oklch(hex(name)).c;
			if (c >= GREY_CEILING) fail('chart furniture', `${name} is not grey (C ${c.toFixed(3)})`);
		}
		const quiet = [FURNITURE.grid, FURNITURE.axis, FURNITURE.baseline];
		for (let i = 1; i < quiet.length; i++) {
			if (ratioOf(quiet[i]!) <= ratioOf(quiet[i - 1]!)) {
				fail('chart furniture', `${quiet[i]} does not stand out more than ${quiet[i - 1]}`);
			}
		}
		for (const name of [...quiet, FURNITURE.band]) {
			if (ratioOf(name) >= MARK_CONTRAST) fail('chart furniture', `${name} reads as a mark`);
		}
		if (ratioOf(FURNITURE.muted) < MARK_CONTRAST) {
			fail('chart furniture', `${FURNITURE.muted} ${f2(ratioOf(FURNITURE.muted))}:1`);
		}

		measures[mode] = {
			seriesAdjacentCvd: adjacentCvd,
			seriesAdjacentNormal: adjacentNormal,
			poleNormal,
			poleCvd,
			midpointContrast,
			closestPole
		};
	}
	return { problems, measures };
}
