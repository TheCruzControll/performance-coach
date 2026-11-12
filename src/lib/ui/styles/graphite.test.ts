import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseCss } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';
import { LEGEND_COLUMNS } from '../../../routes/(app)/today/panels/week-legend.ts';
import { DIVERGING, FURNITURE, SERIES_TOKEN } from '../charts/palette.ts';
import {
	checkPalette,
	colourOf,
	contrast,
	MODES,
	readTokens,
	type Mode,
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

interface CssNode {
	type: string;
	name?: string;
	prelude: string | { start: number; end: number };
	property?: string;
	value?: string;
	block?: { children: CssNode[] } | null;
}

/** The stylesheet's top level: each node as its at-rule and prelude, or its selector list. */
const AST = parseCss(GRAPHITE).children as unknown as CssNode[];
const preludeOf = (node: CssNode) =>
	typeof node.prelude === 'string'
		? `@${node.name}${node.prelude ? ` ${node.prelude}` : ''}`
		: GRAPHITE.slice(node.prelude.start, node.prelude.end).replace(/\s+/g, ' ').trim();
const TOP = AST.map((node) => ({ at: preludeOf(node), node }));

const ruleOf = (node: CssNode) => ({
	selectors: preludeOf(node)
		.split(/,(?![^()]*\))/)
		.map((selector) => selector.trim()),
	declarations: new Map(
		(node.block?.children ?? []).map((d) => [d.property!, d.value!.replace(/\s+/g, ' ')])
	)
});
/** Every style rule, inside @media too: its selectors and declarations. */
const RULES = AST.flatMap((node) =>
	node.type === 'Atrule' ? (node.block?.children ?? []) : [node]
)
	.filter((node) => node.type === 'Rule')
	.map(ruleOf);
/** The rules outside any at-rule, the ones every pointer sees. */
const TOP_RULES = AST.filter((node) => node.type === 'Rule').map(ruleOf);

/** What the rules listing this selector (outside @media) declare, the later winning. */
function rule(selector: string): ReadonlyMap<string, string> {
	const found = TOP_RULES.filter((r) => r.selectors.includes(`${SCOPE} ${selector}`));
	expect(found.length, selector).toBeGreaterThan(0);
	return new Map(found.flatMap((r) => [...r.declarations]));
}

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
	it('is the font faces, then rules that each select only inside the Graphite scope', () => {
		// Nothing in it can reach a page on today's design, and the token rule comes first.
		expect(TOP.slice(0, 3).map((node) => node.at)).toEqual(['@font-face', '@font-face', SCOPE]);
		const unscoped = RULES.flatMap(({ selectors }) =>
			selectors.filter((selector) => !selector.startsWith(SCOPE))
		);
		expect(unscoped).toEqual([]);
		// The only at-rules around a rule keep hover to fine pointers and split the shell at its
		// breakpoint (scripts/layout-rules.test.ts); none nests another, which would hide its rules
		// from the scope check above.
		const media = TOP.filter((node) => node.at.startsWith('@media')).map((node) => node.at);
		expect(media.length).toBeGreaterThan(0);
		expect(new Set(media)).toEqual(
			new Set([
				'@media (hover: hover) and (pointer: fine)',
				'@media (width < 64rem)',
				'@media (width >= 64rem)'
			])
		);
		const nested = AST.filter((node) => node.type === 'Atrule').flatMap((node) =>
			(node.block?.children ?? []).filter((child) => child.type === 'Atrule')
		);
		expect(nested).toEqual([]);
		expect(GRAPHITE).not.toMatch(/@import|!important/);
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

/** A material's colour stops in one theme: its light-dark() pairs, or a plain gradient's hexes. */
function stopsOf(value: string, mode: Mode): string[] {
	const pairs = [...value.matchAll(/light-dark\(\s*(#[0-9a-f]{6})\s*,\s*(#[0-9a-f]{6})\s*\)/gi)];
	if (pairs.length > 0) return pairs.map(([, light, dark]) => (mode === 'light' ? light! : dark!));
	return [...value.matchAll(/#[0-9a-f]{6}/gi)].map(([hex]) => hex);
}

/**
 * The colours a declared value paints in one theme: a token's colour, or a material's stops. Of a
 * four-stop plastic, the pair either side of its middle edge, where a label sits.
 */
function paints(value: string, mode: Mode): string[] {
	const token = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
	if (token && OWN.has(token)) return [colourOf(TOKENS, token, mode)];
	const stops = stopsOf(token ? DECLARED.get(token)! : value, mode);
	return stops.length === 4 ? stops.slice(1, 3) : stops;
}

describe('Graphite’s controls', () => {
	/** A label: the rule (or token) that sets its ink, and the rule that paints what is under it. */
	const LABELS: { where: string; ink: string; under: string; prop?: string }[] = [
		{
			where: 'a secondary button',
			ink: "[data-ui='button'][data-variant='secondary']",
			under: "[data-ui='button'][data-variant='secondary']"
		},
		{
			where: 'a danger button',
			ink: "[data-ui='button'][data-variant='danger']",
			under: "[data-ui='button'][data-variant='danger']"
		},
		{
			where: 'the primary button',
			ink: "[data-ui='button'][data-variant='primary']",
			under: "[data-ui='button'][data-variant='primary']"
		},
		{
			where: 'a segment',
			ink: "[data-ui='segmented'] > .option",
			under: "[data-ui='segmented']"
		},
		{
			where: 'the chosen segment',
			ink: "[data-ui='segmented'] > .option[aria-checked='true']",
			under: "[data-ui='segmented'] > .thumb"
		},
		{
			where: 'a choice',
			ink: "[data-ui='choices'] .face",
			under: "[data-ui='choices'] .face"
		},
		{
			where: 'the chosen choice',
			ink: "[data-ui='choices'] .input:checked + .face",
			under: "[data-ui='choices'] .input:checked + .face"
		},
		{
			where: 'a chosen card’s hint',
			ink: 'var(--color-text-secondary)',
			under: "[data-ui='choices'] .input:checked + .face"
		},
		{
			where: 'a card’s strip title',
			ink: "[data-ui='card-head'] .title",
			under: "[data-ui='surface'] > [data-ui='card-head']"
		},
		{
			where: 'a card’s strip eyebrow',
			ink: "[data-ui='card-head'] .eyebrow",
			under: "[data-ui='surface'] > [data-ui='card-head']"
		},
		{
			where: 'the switch’s OFF',
			ink: "[data-ui='toggle'] > .track",
			under: "[data-ui='toggle'] > .track"
		},
		{
			where: 'the switch’s ON',
			ink: "[data-ui='toggle'] > .input:checked + .track",
			under: "[data-ui='toggle'] > .input:checked + .track"
		},
		{
			where: 'a chip',
			ink: 'var(--color-text-secondary)',
			under: "[data-ui='chip']"
		},
		{
			where: 'the open list row’s subtitle',
			ink: 'var(--color-text-secondary)',
			under: "[data-ui='list-row'][aria-current='page']"
		},
		{
			where: 'a toast’s action',
			ink: "[data-ui='toaster'] .action",
			under: "[data-ui='toaster'] > .toast"
		}
	];

	it('set every label at 4.5:1 or more on the material under it, in both themes', () => {
		const low: string[] = [];
		for (const mode of MODES) {
			for (const { where, ink, under } of LABELS) {
				const colour = ink.startsWith('var(') ? ink : rule(ink).get('color');
				const background = rule(under).get('background');
				expect(colour, `${where}: ink`).toMatch(/^var\(--[\w-]+\)$/);
				expect(background, `${where}: background`).toBeDefined();
				const [fg] = paints(colour!, mode);
				const stops = paints(background!, mode);
				expect(stops.length, where).toBeGreaterThan(0);
				for (const stop of stops) {
					const ratio = contrast(fg!, stop);
					if (ratio < 4.5) low.push(`${where} (${mode}): ${fg} on ${stop} ${ratio.toFixed(2)}`);
				}
			}
		}
		expect(low).toEqual([]);
	});

	it('drop a toned box’s tint but keep --tone for the discipline dots inside it', () => {
		// ScheduleEditor's commitment card paints its dot with var(--tone), set by Surface.
		expect(RULES.filter((r) => r.declarations.has('--tone'))).toEqual([]);
		expect(rule("[data-ui='surface']:not([data-tone='default'])").get('background')).toBe(
			'var(--surface-bg)'
		);
	});

	it('keep an invalid choice’s red border over every face and hover rule', () => {
		const invalid = "[data-ui='choices'].invalid .input:not(:checked) + .face";
		expect(rule(invalid).get('border-color')).toBe('var(--color-danger)');
		// The hover rules live in the fine-pointer block, so they are looked up in every rule.
		for (const selector of [
			"[data-ui='choices'].invalid .input:not(:checked):hover + .face",
			"[data-ui='choices'].invalid[data-variant='card'] .input:not(:checked):hover + .face"
		]) {
			const found = RULES.filter((r) => r.selectors.includes(`${SCOPE} ${selector}`));
			expect(
				found.map((r) => r.declarations.get('border-color')),
				selector
			).toEqual(['var(--color-danger)']);
		}
	});

	it('set fields in a well whose border clears 3:1 against the well and what holds it', () => {
		const input = rule("[data-ui='field'] .input");
		expect(input.get('border-color')).toBe('var(--color-border-strong)');
		expect(input.get('background')).toBe('var(--color-surface-2)');
		// Today's ring was a box-shadow; Graphite's is an outline, so forced colours keep it.
		const focused = rule("[data-ui='field'] .input:focus-visible");
		expect(focused.get('outline')).toBe('2px solid var(--color-accent-ring)');
		expect(focused.get('box-shadow')).not.toMatch(/var\(--color-accent-ring\)/);
		const low: string[] = [];
		for (const mode of MODES) {
			const border = colourOf(TOKENS, '--color-border-strong', mode);
			for (const bg of ['--color-surface-2', '--color-surface-1', '--color-canvas']) {
				const ratio = contrast(border, colourOf(TOKENS, bg, mode));
				if (ratio < 3) low.push(`border on ${bg} (${mode}): ${ratio.toFixed(2)}`);
			}
		}
		expect(low).toEqual([]);
	});

	it('draw focus as a 2 px Aqua-ink outline, 2 px out, at the weight of today’s ring', () => {
		// :where() keeps the selector at base.css's weight plus the scope, so a component's own
		// offset (inset inside clipped containers) still wins whatever order the sheets load in.
		const ring = rule(':where(:focus-visible)');
		expect(Object.fromEntries(ring)).toEqual({
			outline: '2px solid var(--color-accent-ring)',
			'outline-offset': '2px'
		});
		for (const clipped of [
			"[data-ui='segmented'] > .option:focus-visible",
			"[data-ui='stepper'] > .row > .icon-btn:focus-visible"
		]) {
			expect(rule(clipped).get('outline-offset'), clipped).toBe('-3px');
		}
	});

	it('keep the switch’s whole row the 44 px target and move only on motion tokens', () => {
		// The row (Toggle.svelte) is the target; Graphite restyles only the track inside it.
		expect(RULES.some((r) => r.selectors.includes(`${SCOPE} [data-ui='toggle']`))).toBe(false);
		// No duration of its own anywhere: reduced motion zeroes the tokens, and so all of this.
		const timed = RULES.flatMap((r) =>
			[...r.declarations].filter(
				([prop, value]) => /^(transition|animation)/.test(prop) && /\d+m?s\b/.test(value)
			)
		);
		expect(timed).toEqual([]);
		expect(rule("[data-ui='sheet'] > .sheet").get('transition-timing-function')).toBe(
			'var(--ease-spring)'
		);
	});
});

/** What every rule listing this selector declares, inside `at` (an @media prelude) or outside any. */
function ruleAt(at: string | null, selector: string): ReadonlyMap<string, string> {
	const nodes =
		at === null
			? AST.filter((n) => n.type === 'Rule')
			: TOP.filter((n) => n.at === at).flatMap((n) => n.node.block?.children ?? []);
	const found = nodes
		.filter((n) => n.type === 'Rule')
		.map(ruleOf)
		.filter((r) => r.selectors.includes(`${SCOPE} ${selector}`));
	expect(found.length, `${at ?? 'top'}: ${selector}`).toBeGreaterThan(0);
	return new Map(found.flatMap((r) => [...r.declarations]));
}

const PHONE = '@media (width < 64rem)';
const DESKTOP = '@media (width >= 64rem)';
const rem = (value: string) => Number(/^([\d.]+)rem$/.exec(value)?.[1]);

describe('Graphite’s shell', () => {
	it('keeps the tab bar at --nav-height, each tab a target of 44 px or more', () => {
		const tokenHeight = /--nav-height:\s*([\d.]+rem)/.exec(TOKENS_CSS)?.[1];
		expect(tokenHeight).toBeDefined();
		const list = ruleAt(PHONE, "[data-ui='nav'] > ul");
		const tab = ruleAt(PHONE, "[data-ui='nav'] .item");
		expect(tab.get('height')).toBe('auto');
		// The bar's room is what --nav-inset-bottom reserves: the tab and the padding either side.
		expect(rem(tab.get('min-height')!) + 2 * rem(list.get('padding-block')!)).toBe(
			rem(tokenHeight!)
		);
		expect(rem(tab.get('min-height')!) * 16).toBeGreaterThanOrEqual(44);
		expect(
			rem(ruleAt(DESKTOP, "[data-ui='nav'] .item").get('min-height')!) * 16
		).toBeGreaterThanOrEqual(44);
	});

	it('puts the current tab in the selection well with a filled glyph, and widens only its rail', () => {
		expect(ruleAt(PHONE, "[data-ui='nav'] .item[aria-current='page']").get('background')).toBe(
			'var(--select)'
		);
		expect(ruleAt(DESKTOP, "[data-ui='nav'] .item[aria-current='page']").get('background')).toBe(
			'var(--select)'
		);
		expect(
			Object.fromEntries(ruleAt(null, "[data-ui='nav'] .item[aria-current='page'] .icon"))
		).toEqual({
			fill: 'currentColor',
			'fill-opacity': '0.22'
		});
		// The source list is the rail at another width: today's stays the icon rail.
		expect(DECLARED.get('--rail-width')).toBe('14.5rem');
		expect(/--rail-width:\s*([\d.]+rem)/.exec(TOKENS_CSS)?.[1]).toBe('5.5rem');
		expect(ruleAt(DESKTOP, "[data-ui='nav'] .item").get('flex-direction')).toBe('row');
	});

	it('hides the page header’s eyebrow, but keeps a date as the subtitle under the title', () => {
		expect(rule("[data-ui='page-header'] > .titles > .eyebrow").get('display')).toBe('none');
		const date = rule("[data-ui='page-header'] > .titles > .eyebrow[data-date]");
		expect(date.get('display')).toBe('block');
		expect(date.get('order')).toBe('1');
		expect(rule("[data-ui='page-header'] > .titles").get('flex-direction')).toBe('column');
	});

	it('set every shell label at 4.5:1 or more on the material under it, in both themes', () => {
		const LABELS = [
			{
				where: 'a tab',
				ink: ruleAt(PHONE, "[data-ui='nav'] .item").get('color')!,
				under: ruleAt(PHONE, "[data-ui='nav']").get('background')!
			},
			{
				where: 'the current tab',
				ink: ruleAt(PHONE, "[data-ui='nav'] .item[aria-current='page']").get('color')!,
				under: ruleAt(PHONE, "[data-ui='nav'] .item[aria-current='page']").get('background')!
			},
			{
				where: 'a source-list item',
				ink: ruleAt(DESKTOP, "[data-ui='nav'] .item").get('color')!,
				under: ruleAt(DESKTOP, "[data-ui='nav']").get('background')!
			},
			{
				where: 'the current source-list item',
				ink: ruleAt(DESKTOP, "[data-ui='nav'] .item[aria-current='page']").get('color')!,
				under: ruleAt(DESKTOP, "[data-ui='nav'] .item[aria-current='page']").get('background')!
			},
			{
				where: 'the resume bar',
				ink: 'var(--color-text)',
				under: rule("[data-ui='resume-slot'] > .resume-bar").get('background')!
			},
			{
				where: 'the resume bar’s detail',
				ink: 'var(--color-text-secondary)',
				under: rule("[data-ui='resume-slot'] > .resume-bar").get('background')!
			},
			{
				where: 'the Status Display',
				ink: rule("[data-ui='status'][data-kind] > .line").get('color')!,
				under: rule("[data-ui='status'][data-kind]").get('background')!
			},
			{
				where: 'its dim line',
				ink: rule("[data-ui='status'][data-kind] > .line.dim").get('color')!,
				under: rule("[data-ui='status'][data-kind]").get('background')!
			},
			{
				where: 'its footer',
				ink: rule("[data-ui='status'][data-kind] > .foot").get('color')!,
				under: rule("[data-ui='status'][data-kind]").get('background')!
			},
			{
				where: 'a paused rest',
				ink: rule("[data-ui='rest'][data-phase='paused'] > .reading > .time").get('color')!,
				under: rule("[data-ui='rest'][data-phase]").get('background')!
			},
			{
				where: 'the rest timer’s Skip',
				ink: 'var(--color-accent-text)',
				under: rule("[data-ui='rest'][data-phase] > .controls").get('background')!
			}
		];
		const low: string[] = [];
		for (const mode of MODES) {
			for (const { where, ink, under } of LABELS) {
				const [fg] = paints(ink, mode);
				const stops = paints(under, mode);
				expect(fg, where).toBeDefined();
				expect(stops.length, where).toBeGreaterThan(0);
				for (const stop of stops) {
					const ratio = contrast(fg!, stop);
					if (ratio < 4.5) low.push(`${where} (${mode}): ${fg} on ${stop} ${ratio.toFixed(2)}`);
				}
			}
		}
		expect(low).toEqual([]);
	});

	it('holds the Status Display’s room from the first paint, and outranks the rest timer’s own rules', () => {
		expect(Object.fromEntries(rule("div[data-ui='status-room']"))).toEqual({
			display: 'grid',
			order: '0',
			'min-height': 'var(--status-room)'
		});
		// RestTimer's own phase rules weigh up to five classes and attributes (its paused time):
		// each Graphite rule for it carries the hook, the phase and the path to the element.
		const restRules = RULES.flatMap((r) => r.selectors).filter((sel) =>
			sel.includes("[data-ui='rest']")
		);
		expect(restRules.length).toBeGreaterThan(5);
		for (const selector of restRules)
			expect(selector, selector).toMatch(/\[data-ui='rest'\]\[data-phase(='\w+')?\]/);
		expect(
			rule("[data-ui='rest'][data-phase] > .reading > .time").get('font-variant-numeric')
		).toBe('tabular-nums lining-nums');
	});
});

describe('Graphite’s screens', () => {
	/** The screens' rules: everything after the Screens heading. */
	const RAW = readFileSync(new URL('./graphite.css', import.meta.url), 'utf8');
	const SCREENS = RAW.slice(RAW.indexOf('==== Screens')).replace(/\/\*[\s\S]*?\*\//g, '');
	/** Every Svelte file under src, tests aside (git ls-files: quick on a busy runner). */
	const SVELTE = execFileSync(
		'git',
		['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src/**/*.svelte'],
		{ encoding: 'utf8' }
	)
		.split('\n')
		.filter(Boolean)
		.map((file) => readFileSync(file, 'utf8').replace(/<style[\s\S]*?<\/style>/g, ''));

	it('start from test ids the screens still render, so a rename cannot silently drop a rule', () => {
		const ids = new Set([...SCREENS.matchAll(/\[data-testid='([\w-]+)'\]/g)].map(([, id]) => id!));
		expect(ids.size).toBeGreaterThan(8);
		const missing = [...ids].filter(
			(id) => !SVELTE.some((markup) => markup.includes(`data-testid="${id}"`))
		);
		expect(missing).toEqual([]);
	});

	it('reach in only by class names a component still gives its markup', () => {
		const given = new Set(
			SVELTE.flatMap((markup) => [
				...[...markup.matchAll(/\bclass="([^"]*)"/g)].flatMap(([, list]) =>
					list!.replace(/\{[^}]*\}/g, ' ').split(/\s+/)
				),
				...[...markup.matchAll(/\bclass:([\w-]+)/g)].map(([, name]) => name!)
			])
		);
		// Class selectors, not the decimals inside values (0.875rem).
		const named = new Set(
			[...SCREENS.matchAll(/(?<![\w.-])\.([a-z][\w-]*)/g)].map(([, name]) => name!)
		);
		expect(named.size).toBeGreaterThan(20);
		expect([...named].filter((name) => !given.has(name))).toEqual([]);
	});

	it('set every label at 4.5:1 or more on the material under it, in both themes', () => {
		const LABELS = [
			{
				where: 'an RPE key',
				ink: rule("[data-testid='rpe-chips'] .face").get('color')!,
				under: rule("[data-testid='rpe-chips'] .face").get('background')!
			},
			{
				where: 'the chosen RPE',
				ink: rule("[data-testid='rpe-chips'] .input:checked + .face").get('color')!,
				under: rule("[data-testid='rpe-chips'] .input:checked + .face").get('background')!
			},
			{
				where: 'a view tab',
				ink: rule('nav.views > a.view').get('color')!,
				under: rule('nav.views').get('background')!
			},
			{
				where: 'the current view and period',
				ink: rule("nav.views > a.view[aria-current='page']").get('color')!,
				under: rule("nav.views > a.view[aria-current='page']").get('background')!
			},
			{
				where: 'the pain sheet’s strip',
				ink: rule("[data-testid='pain-sheet'] .choices > h3.heading").get('color')!,
				under: rule("[data-testid='pain-sheet'] .choices > h3.heading").get('background')!
			},
			{
				// ProposalCard's own eyebrow colour, on Graphite's strip.
				where: 'the proposal’s strip',
				ink: 'var(--color-text-secondary)',
				under: rule('article.proposal[data-status] > .head').get('background')!
			},
			{
				where: 'the docked composer’s count',
				ink: 'var(--color-text-secondary)',
				under: ruleAt(PHONE, 'form.composer.chrome').get('background')!
			}
		];
		const low: string[] = [];
		for (const mode of MODES) {
			for (const { where, ink, under } of LABELS) {
				const [fg] = paints(ink, mode);
				const stops = paints(under, mode);
				expect(fg, where).toBeDefined();
				expect(stops.length, where).toBeGreaterThan(0);
				for (const stop of stops) {
					const ratio = contrast(fg!, stop);
					if (ratio < 4.5) low.push(`${where} (${mode}): ${fg} on ${stop} ${ratio.toFixed(2)}`);
				}
			}
		}
		expect(low).toEqual([]);
	});

	it('use the period control’s rules for the view tabs too, so both read as one control', () => {
		const pairs = [
			['nav.views', '.period-view > nav.picker > ul'],
			['nav.views > a.view', '.period-view > nav.picker a.period'],
			[
				"nav.views > a.view[aria-current='page']",
				".period-view > nav.picker a.period[aria-current='page']"
			]
		] as const;
		for (const [view, period] of pairs) {
			const found = TOP_RULES.find((r) => r.selectors.includes(`${SCOPE} ${view}`));
			expect(found?.selectors, view).toContain(`${SCOPE} ${period}`);
		}
	});

	it('never shrink a target: no rule sizes a key, tab, day, set or sheet row', () => {
		const TARGETS = /\.face|a\.view|a\.period|\.entry|\.day\b|\.set\b|\.chips/;
		const sized = RULES.filter((r) =>
			r.selectors.some((s) => s.startsWith(SCOPE) && SCREENS.includes(s.slice(SCOPE.length + 1)))
		)
			.filter((r) => r.selectors.some((s) => TARGETS.test(s.split(' ').at(-1)!)))
			.flatMap((r) =>
				['height', 'min-height', 'min-width', 'block-size', 'width']
					.filter((p) => r.declarations.has(p))
					.map((p) => `${r.selectors[0]}: ${p}`)
			);
		// A view tab and a period give up only their spare min-width: each is a column of the
		// control, wider than 44 px at 390 px (four views, five periods), and keeps its 44 px height.
		expect(sized).toEqual([`${SCOPE} nav.views > a.view: min-width`]);
	});

	it('put Complete set on the bar material only where the logger is stuck to the foot', () => {
		const logger = ruleAt(PHONE, "[data-testid='set-logger']");
		// The band: the large button (3.5rem in Graphite), its gap above and the padding below.
		expect(rule("[data-ui='button'][data-size='lg']").get('--btn-height')).toBe('3.5rem');
		expect(logger.get('--action-bar')).toBe(
			'calc(3.5rem + 2 * var(--space-3) + var(--safe-bottom))'
		);
		expect(logger.get('background')).toContain('var(--bar) left bottom / 100% var(--action-bar)');
		// From 1024 px it is a card in the column: no bar there, nor for every width.
		expect(RULES.filter((r) => r.selectors.some((s) => s.includes('set-logger')))).toHaveLength(1);
	});

	it('hold the legend’s room to the rows Program.svelte counts', () => {
		const legend = rule("[data-ui='week-legend']");
		expect(legend.get('grid-template-columns')).toBe(`repeat(${LEGEND_COLUMNS}, max-content)`);
		expect(legend.get('line-height')).toBe('1.25rem');
		expect(legend.get('gap')).toMatch(/^0\.25rem /);
		const program = readFileSync(
			new URL('../../../routes/(app)/today/panels/Program.svelte', import.meta.url),
			'utf8'
		);
		expect(program).toContain(`Math.ceil(keys / ${LEGEND_COLUMNS}) * ${1.25 + 0.25} - 0.25`);
		expect(rule("[data-ui='week-legend'] > li").get('white-space')).toBe('nowrap');
	});

	it('dash a line only in a chart of estimates, and label a measured value in words', () => {
		const dashed = RULES.find((r) =>
			r.selectors.some((s) => s.includes("path[data-testid='line-path']"))
		);
		expect(dashed?.selectors).toEqual([
			`${SCOPE} [data-testid='line-chart']:has(.pc-marker[data-kind='estimated']) path[data-testid='line-path']`
		]);
		expect(dashed?.declarations.get('stroke-dasharray')).toBe('5 4');
		expect(
			rule("[data-testid='line-chart'] .pc-marker[data-kind='measured']::after").get('content')
		).toBe("'measured'");
	});

	it('dock the composer on the tab bar only below 1024 px, flush with its top edge', () => {
		const dock = ruleAt(PHONE, 'form.composer.chrome');
		expect(dock.get('bottom')).toBe('var(--nav-inset-bottom)');
		expect(dock.get('background')).toBe('var(--bar)');
		expect(dock.get('width')).toBe('100%');
		expect(TOP_RULES.some((r) => r.selectors.some((s) => s.includes('form.composer')))).toBe(false);
	});
});
