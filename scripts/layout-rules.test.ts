/**
 * The responsive contract (docs/design-system.md, "Responsive layout"), checked on every
 * stylesheet and on the browser code under src, so a stray breakpoint, a hover style a touch
 * screen keeps, fixed chrome offset by the nav's height or a layout switched in JavaScript fails
 * here with its file, line and the one-line fix:
 *
 * - every `<style>` block and .css file, parsed with svelte/compiler's parseCss:
 *   - a width (or height) @media query is one of the five breakpoint forms;
 *   - a hover or pointer query is exactly `(hover: hover) and (pointer: fine)`;
 *   - a `:hover` selector sits inside such a query;
 *   - `--nav-height` is read only by the tokens and the nav itself (in markup too);
 * - the browser code (src/lib/ui, src/lib/client, src/routes, src/app.html: scripts and markup)
 *   never reads the viewport's size, listens for resize, or asks matchMedia (or svelte/reactivity's
 *   MediaQuery) anything but reduced motion, colour scheme or display mode.
 *
 * Allowed throughout: @container, @supports, prefers-*, display-mode, forced-colors, print, and
 * the CSS `resize` property.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { parseCss } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';

type Rule = 'breakpoint' | 'hover-query' | 'hover-outside' | 'nav-height' | 'js-layout';

interface Finding {
	file: string;
	line: number;
	rule: Rule;
	/** The offending query, selector, declaration or expression. */
	found: string;
}

/** The only width queries: phone below 40rem, tablet to 64rem, desktop from 64rem. */
const BREAKPOINTS = [
	'(width >= 40rem)',
	'(width >= 64rem)',
	'(width < 40rem)',
	'(width < 64rem)',
	'(40rem <= width < 64rem)'
];
const FINE_POINTER = ['(hover:hover)', '(pointer:fine)'];
/** The files that may read --nav-height: the token itself and the nav it measures. */
const NAV_HEIGHT_OWNERS = [
	'src/lib/ui/styles/tokens.css',
	'src/lib/ui/components/BottomNav.svelte'
];
/** What matchMedia and MediaQuery may ask: preferences and display mode, never the viewport. */
const MATCH_MEDIA_FEATURES = ['prefers-reduced-motion', 'prefers-color-scheme', 'display-mode'];
const STYLESHEET = /\.(css|svelte|html)$/;
const BROWSER_CODE = /^src\/(lib\/ui|lib\/client|routes)\/.+\.(svelte|ts|js)$|^src\/app\.html$/;
/** Code that ships to the browser; its tests never do. */
const isBrowserCode = (file: string) => BROWSER_CODE.test(file) && !/\.(test|spec)\.ts$/.test(file);

const RULES: Record<Rule, { broke: string; fix: string; section: string }> = {
	breakpoint: {
		broke: 'is not one of the breakpoints',
		fix: `write ${BREAKPOINTS.join(', ')}; components adapt with @container`,
		section: 'Widths & tokens'
	},
	'hover-query': {
		broke: 'is not the fine-pointer query',
		fix: 'write @media (hover: hover) and (pointer: fine)',
		section: 'Pointer & hover'
	},
	'hover-outside': {
		broke: 'is outside a (hover: hover) and (pointer: fine) block, so touch screens keep it',
		fix: 'move the rule into @media (hover: hover) and (pointer: fine)',
		section: 'Pointer & hover'
	},
	'nav-height': {
		broke: 'reads --nav-height, which is wrong once the nav is a rail at the left',
		fix:
			'use var(--nav-inset-bottom) (the bar and the home indicator), and centre fixed chrome ' +
			'with left: calc(50% + var(--nav-inset-left) / 2)',
		section: 'Fixed and sticky chrome'
	},
	'js-layout': {
		broke: 'switches layout in JavaScript, which SSR cannot paint',
		fix: `use a breakpoint or a container query in CSS; matchMedia or MediaQuery only for ${MATCH_MEDIA_FEATURES.join(', ')}`,
		section: 'Widths & tokens'
	}
};

const format = ({ file, line, rule, found }: Finding) =>
	`${file}:${line}: ${found} ${RULES[rule].broke}. Fix: ${RULES[rule].fix} ` +
	`(docs/design-system.md, Responsive layout → ${RULES[rule].section}).`;

const lineAt = (source: string, offset: number) => source.slice(0, offset).split('\n').length;

/** Blank a region, keeping its newlines, so every offset after it still points at its line. */
const blank = (text: string) => text.replace(/[^\n]/g, ' ');

// ---- Stylesheets -------------------------------------------------------------------------

interface CssNode {
	type: string;
	start: number;
	name?: string;
	prelude?: string | CssNode;
	property?: string;
	value?: string;
	block?: { children: CssNode[] } | null;
}

/** The queries of a @media prelude, split on top-level commas, with their features. */
function mediaQueries(prelude: string) {
	return prelude.split(',').map((query) => ({
		query: query.trim(),
		negated: /\bnot\b/i.test(query),
		features: [...query.matchAll(/\(([^()]*)\)/g)].map((m) => `(${m[1]!.trim()})`)
	}));
}

const squash = (text: string) => text.replace(/\s+/g, '').toLowerCase();
const isSize = (feature: string) =>
	/\b((min-|max-)?(device-)?(width|height)|(device-)?aspect-ratio|orientation)\b/i.test(feature);
const isPointer = (feature: string) => /^\(\s*(any-)?(hover|pointer)\b/i.test(feature);

/** Does every query of this @media prelude select fine pointers (and so allow :hover)? */
const selectsFinePointers = (prelude: string) =>
	mediaQueries(prelude).every(
		({ features, negated }) =>
			!negated &&
			FINE_POINTER.every((wanted) => features.some((feature) => squash(feature) === wanted))
	);

function hasHover(node: unknown): boolean {
	if (!node || typeof node !== 'object') return false;
	const { type, name } = node as { type?: string; name?: string };
	if (type === 'PseudoClassSelector' && name === 'hover') return true;
	return Object.entries(node).some(([key, value]) => key !== 'metadata' && hasHover(value));
}

/** Check one stylesheet; `offset` places it in `source` (a style block inside a component). */
function checkCss(file: string, source: string, css: string, offset: number): Finding[] {
	const findings: Finding[] = [];
	const at = (rule: Rule, start: number, found: string) =>
		findings.push({ file, line: lineAt(source, offset + start), rule, found });

	const walk = (nodes: CssNode[], finePointer: boolean) => {
		for (const node of nodes) {
			let fine = finePointer;
			if (node.type === 'Atrule' && node.name === 'media' && typeof node.prelude === 'string') {
				for (const { query, negated, features } of mediaQueries(node.prelude)) {
					const pointer = features.filter(isPointer).map(squash).sort();
					if (
						pointer.length > 0 &&
						(negated || pointer.join() !== [...FINE_POINTER].sort().join())
					) {
						at('hover-query', node.start, `@media ${query}`);
					}
					for (const feature of features.filter(isSize)) {
						if (!BREAKPOINTS.some((form) => squash(form) === squash(feature))) {
							at('breakpoint', node.start, `@media ${feature}`);
						}
					}
				}
				fine ||= selectsFinePointers(node.prelude);
			}
			if (node.type === 'Rule' && typeof node.prelude === 'object' && !fine) {
				if (hasHover(node.prelude)) at('hover-outside', node.prelude.start, 'a :hover rule');
			}
			if (
				node.type === 'Declaration' &&
				/var\(\s*--nav-height\b/.test(node.value ?? '') &&
				!NAV_HEIGHT_OWNERS.includes(file)
			) {
				at('nav-height', node.start, `${node.property}: ${node.value}`);
			}
			if (node.block) walk(node.block.children, fine);
		}
	};
	walk(parseCss(css).children as unknown as CssNode[], false);
	return findings;
}

const STYLE_BLOCK = /(<style\b[^>]*>)([\s\S]*?)<\/style>/g;

function checkStyles(file: string, source: string): Finding[] {
	if (file.endsWith('.css')) return checkCss(file, source, source, 0);
	return [...source.matchAll(STYLE_BLOCK)].flatMap((m) =>
		checkCss(file, source, m[2]!, m.index + m[1]!.length)
	);
}

// ---- Browser code ------------------------------------------------------------------------

/**
 * Strings are skipped (a `//` inside one is not a comment; a quote or an apostrophe holds to its
 * line); JS, CSS and HTML comments are blanked, so prose that names innerWidth is not a read.
 */
const COMMENT_OR_STRING =
	/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g;

const VIEWPORT_READS = [
	// The viewport's size, in a script or a <svelte:window bind:…> (and a screen's size).
	/\b(innerWidth|innerHeight|outerWidth|outerHeight|visualViewport)\b/g,
	/\bscreen\s*\.\s*(width|height|availWidth|availHeight)\b/g,
	// Resize listeners: addEventListener('resize'), window.onresize, <svelte:window onresize>.
	/\baddEventListener\s*\(\s*(['"`])resize\1/g,
	/\bon:?resize\b/g
];

function checkScripts(file: string, source: string): Finding[] {
	const code = source
		.replace(STYLE_BLOCK, blank)
		.replace(COMMENT_OR_STRING, (match) => (/^['"`]/.test(match) ? match : blank(match)));
	const findings: Finding[] = [];
	const at = (index: number, found: string, rule: Rule = 'js-layout') =>
		findings.push({ file, line: lineAt(source, index), rule, found });

	for (const pattern of VIEWPORT_READS) {
		for (const m of code.matchAll(pattern)) at(m.index, m[0]);
	}
	// matchMedia(…), matchMedia?.(…) and svelte/reactivity's new MediaQuery(…), which also takes a
	// query without parentheses.
	const query = /\b(?:matchMedia\s*(?:\?\.)?|new\s+MediaQuery)\s*\(\s*(?:(['"`])(.*?)\1)?/g;
	for (const m of code.matchAll(query)) {
		const features = [...(m[2] ?? '').matchAll(/(?:^|\()\s*([a-z-]+)/gi)].map((f) => f[1]!);
		const allowed =
			features.length > 0 && features.every((name) => MATCH_MEDIA_FEATURES.includes(name));
		if (!allowed) at(m.index, m[2] === undefined ? `${m[0].trim()}<computed>)` : `${m[0]})`);
	}
	// Markup offsets chrome too: a style attribute, a style: directive or a string in a script.
	if (!NAV_HEIGHT_OWNERS.includes(file)) {
		for (const m of code.matchAll(/var\(\s*--nav-height\b[^)]*\)/g)) {
			at(m.index, m[0], 'nav-height');
		}
	}
	return findings.sort((a, b) => a.line - b.line);
}

/** Every rule that applies to a file under src, by its path. */
function check(file: string, source: string): Finding[] {
	return [
		...(STYLESHEET.test(file) ? checkStyles(file, source) : []),
		...(isBrowserCode(file) ? checkScripts(file, source) : [])
	];
}

const SRC_FILES = readdirSync('src', { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile())
	.map((entry) => `${entry.parentPath}/${entry.name}`.split('\\').join('/'));

const short = (findings: Finding[]) => findings.map((f) => `${f.file}:${f.line} ${f.rule}`);

describe('the responsive layout rules', () => {
	it('scans every stylesheet and the browser code, not the server or tests', () => {
		expect(SRC_FILES.filter((file) => STYLESHEET.test(file))).toEqual(
			expect.arrayContaining([
				'src/lib/ui/styles/tokens.css',
				'src/lib/ui/styles/base.css',
				'src/lib/ui/components/Button.svelte',
				'src/routes/(app)/AppShell.svelte'
			])
		);
		const browser = SRC_FILES.filter(isBrowserCode);
		expect(browser).toEqual(
			expect.arrayContaining([
				'src/app.html',
				'src/lib/client/preferences.svelte.ts',
				'src/lib/ui/components/Toaster.svelte',
				'src/routes/(app)/+layout.svelte'
			])
		);
		expect(
			browser.filter((file) => !/^src\/(lib\/(ui|client)|routes)\/|^src\/app\.html$/.test(file))
		).toEqual([]);
		expect(browser.filter((file) => file.endsWith('.test.ts'))).toEqual([]);
	});

	it('holds on the tree', () => {
		const findings = SRC_FILES.filter((file) => /\.(css|svelte|html|ts|js)$/.test(file)).flatMap(
			(file) => check(file, readFileSync(file, 'utf8'))
		);
		expect(findings.map(format), 'docs/design-system.md, Responsive layout').toEqual([]);
	});

	it('names the file, the line, what broke, the fix and the rule it breaks', () => {
		const findings = check('src/lib/ui/fixture.css', '.a {\n}\n\n.a:hover {\n}\n');
		expect(findings.map(format)).toEqual([
			'src/lib/ui/fixture.css:4: a :hover rule is outside a (hover: hover) and (pointer: fine) ' +
				'block, so touch screens keep it. Fix: move the rule into @media (hover: hover) and ' +
				'(pointer: fine) (docs/design-system.md, Responsive layout → Pointer & hover).'
		]);
	});

	describe('fails, naming file:line', () => {
		const page = 'src/routes/(app)/fixture/+page.svelte';
		const css = 'src/lib/ui/styles/fixture.css';
		const component = (style: string) => `<div class="a">A</div>\n\n<style>\n${style}\n</style>\n`;

		it('a bare :hover, in a component style block and in a .css file', () => {
			expect(short(check(page, component('\t.a:hover {\n\t\tcolor: red;\n\t}')))).toEqual([
				`${page}:4 hover-outside`
			]);
			expect(short(check(css, '.b {\n}\n:global(.a):not(.b):hover {\n}\n'))).toEqual([
				`${css}:3 hover-outside`
			]);
			// Nested inside a rule or a width query, still outside the fine-pointer query.
			expect(short(check(css, '.a {\n\t&:hover {\n\t}\n}\n'))).toEqual([`${css}:2 hover-outside`]);
			expect(short(check(css, '@media (width >= 64rem) {\n\t.a:hover {\n\t}\n}\n'))).toEqual([
				`${css}:2 hover-outside`
			]);
		});

		it(':hover inside (hover: hover) alone', () => {
			expect(short(check(css, '@media (hover: hover) {\n\t.a:hover {\n\t}\n}\n'))).toEqual([
				`${css}:1 hover-query`,
				`${css}:2 hover-outside`
			]);
		});

		it.each([
			['(pointer: coarse)', 'hover-query'],
			['(any-hover: hover)', 'hover-query'],
			['(any-pointer: fine)', 'hover-query'],
			['(hover: none)', 'hover-query'],
			['not all and (hover: hover) and (pointer: fine)', 'hover-query'],
			['(min-width: 48rem)', 'breakpoint'],
			['(max-width: 40rem)', 'breakpoint'],
			['(width >= 900px)', 'breakpoint'],
			['(width >= 40em)', 'breakpoint'],
			['screen and (height < 40rem)', 'breakpoint'],
			['(orientation: landscape)', 'breakpoint']
		])('@media %s', (query, rule) => {
			expect(short(check(css, `.a {\n}\n@media ${query} {\n\t.a {\n\t}\n}\n`))).toEqual([
				`${css}:3 ${rule}`
			]);
		});

		it('bottom: var(--nav-height) in a page', () => {
			const style =
				'\t.bar {\n\t\tposition: fixed;\n\t\tbottom: calc(var(--nav-height) + 1rem);\n\t}';
			expect(short(check(page, component(style)))).toEqual([`${page}:6 nav-height`]);
		});

		it('a width query in matchMedia, in a .ts module and in a .svelte script', () => {
			const module = 'src/lib/client/fixture.ts';
			expect(
				short(check(module, "// Desktop?\nexport const wide = matchMedia('(width >= 64rem)');\n"))
			).toEqual([`${module}:2 js-layout`]);
			const svelte = `<script lang="ts">\n\tlet open = $state(false);\n\tconst wide = window.matchMedia('(width >= 64rem)').matches;\n</script>\n`;
			expect(short(check(page, svelte))).toEqual([`${page}:3 js-layout`]);
			// A query it cannot read is refused too.
			const computed = `export const wide = (query: string) =>\n\tmatchMedia(query).matches;\n`;
			expect(short(check(module, computed))).toEqual([`${module}:2 js-layout`]);
		});

		it("svelte/reactivity's MediaQuery and matchMedia?.(), asking for a width", () => {
			const module = 'src/lib/ui/fixture.svelte.ts';
			const source = [
				"import { MediaQuery } from 'svelte/reactivity';",
				"export const large = new MediaQuery('min-width: 800px');",
				"export const wide = window.matchMedia?.('(width >= 64rem)').matches;"
			].join('\n');
			expect(short(check(module, source))).toEqual([
				`${module}:2 js-layout`,
				`${module}:3 js-layout`
			]);
		});

		it.each([
			['window.innerWidth', 'const narrow = window.innerWidth < 640;'],
			['visualViewport.width', 'const width = visualViewport?.width ?? 0;'],
			['screen.width', 'const wide = screen.width > 1024;'],
			['a resize listener', "addEventListener('resize', layout);"],
			['window.onresize', 'window.onresize = layout;']
		])('%s', (_, line) => {
			const module = 'src/lib/ui/fixture.ts';
			expect(short(check(module, `export {};\n${line}\n`))).toEqual([`${module}:2 js-layout`]);
		});

		it('<svelte:window bind:innerWidth> and <svelte:window onresize>', () => {
			const markup = (tag: string) =>
				`<script lang="ts">\n\tlet w = $state(0);\n\tconst f = () => {};\n</script>\n\n${tag}\n`;
			expect(short(check(page, markup('<svelte:window bind:innerWidth={w} />')))).toEqual([
				`${page}:6 js-layout`
			]);
			expect(short(check(page, markup('<svelte:window onresize={f} />')))).toEqual([
				`${page}:6 js-layout`
			]);
		});

		it('var(--nav-height) in a style attribute and a style: directive', () => {
			const markup =
				'<div style="bottom: calc(var(--nav-height) + 1rem)"></div>\n' +
				'<div style:bottom="var(--nav-height)"></div>\n';
			expect(short(check(page, markup))).toEqual([`${page}:1 nav-height`, `${page}:2 nav-height`]);
		});
	});

	describe('allows', () => {
		const css = 'src/lib/ui/styles/fixture.css';

		it('the five width queries, and hover for fine pointers at a width', () => {
			const style = [
				...BREAKPOINTS.map((query) => `@media ${query} {\n\t.a {\n\t\tgap: 1rem;\n\t}\n}`),
				'@media (width >= 64rem) and (hover: hover) and (pointer: fine) {\n\t.a:hover {\n\t}\n}',
				'@media (hover: hover) and (pointer: fine) {\n\t.a:hover:not(:disabled) {\n\t}\n}'
			].join('\n');
			expect(check(css, style)).toEqual([]);
		});

		it('preferences, display mode, forced colours and print', () => {
			const style = [
				'@media (prefers-reduced-motion: reduce) {\n\t.a {\n\t}\n}',
				'@media (prefers-color-scheme: light) {\n\t.a {\n\t}\n}',
				'@media (display-mode: standalone) {\n\t.a {\n\t}\n}',
				'@media (forced-colors: active) {\n\t.a {\n\t}\n}',
				'@media print {\n\t.a {\n\t}\n}'
			].join('\n');
			expect(check(css, style)).toEqual([]);
		});

		it('container queries and the CSS resize property', () => {
			const page = 'src/lib/ui/components/Fixture.svelte';
			const source =
				'<textarea></textarea>\n\n<style>\n\t@container (min-width: 34rem) {\n\t\t.a {\n\t\t}\n\t}\n\n\ttextarea {\n\t\tresize: vertical;\n\t}\n</style>\n';
			expect(check(page, source)).toEqual([]);
		});

		it('matchMedia for reduced motion, colour scheme and display mode', () => {
			const module = 'src/lib/client/fixture.ts';
			const source = [
				"export const still = matchMedia('(prefers-reduced-motion: reduce)').matches;",
				'export const light = window.matchMedia("(prefers-color-scheme: light)");',
				'export const app = matchMedia(`(display-mode: standalone)`).matches;',
				// MediaQuery puts a query without parentheses in them.
				"export const calm = new MediaQuery('prefers-reduced-motion: reduce');",
				"export const dark = window.matchMedia?.('(prefers-color-scheme: dark)');"
			].join('\n');
			expect(check(module, source)).toEqual([]);
		});

		it('words in comments and strings, and the nav reading its own height', () => {
			const module = 'src/lib/ui/fixture.ts';
			const source =
				"// never read innerWidth or listen for 'resize'\n/* onresize */\nexport const url = 'https://example.com/a//b';\n";
			expect(check(module, source)).toEqual([]);
			const nav =
				'<nav style:min-height="var(--nav-height)"></nav>\n\n<style>\n\t.item {\n\t\theight: var(--nav-height);\n\t}\n</style>\n';
			expect(check('src/lib/ui/components/BottomNav.svelte', nav)).toEqual([]);
		});
	});
});
