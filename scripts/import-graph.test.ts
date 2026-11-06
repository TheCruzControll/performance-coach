/**
 * The shared runtime-import walker (scripts/import-graph.ts), on fixture trees in a temporary
 * directory laid out like the repository, so `#lib/` and `$lib/` resolve inside the fixture.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chains, filesUnder, resolve, runtimeImports } from './import-graph.ts';

const root = mkdtempSync(path.join(tmpdir(), 'import-graph-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Writes `text` at `name` under the fixture root and returns its absolute path. */
function file(name: string, text = 'export const x = 1;\n'): string {
	const at = path.join(root, name);
	mkdirSync(path.dirname(at), { recursive: true });
	writeFileSync(at, text);
	return at;
}

const options = { root };
/** The chains from `entry` to any module whose path contains `needle`. */
const chainsTo = (entry: string, needle: string) =>
	chains([entry], ({ file }) => file?.includes(needle) ?? false, options).chains;

describe('runtimeImports', () => {
	it('reads static imports, re-exports and string-literal import(), in source order', () => {
		const at = file(
			'src/lib/all.ts',
			[
				`import { a } from './a.ts';`,
				`import './side-effect.ts';`,
				`export * from './b.ts';`,
				`export { c } from './c.ts';`,
				`export * as d from './d.ts';`,
				`export const lazy = () => import('./e.ts');`,
				'export const template = () => import(`./f.ts`);',
				`export async function nested() { if (a) { return (await import('./g.ts')).g; } }`
			].join('\n')
		);
		expect(runtimeImports(at)).toEqual([
			'./a.ts',
			'./side-effect.ts',
			'./b.ts',
			'./c.ts',
			'./d.ts',
			'./e.ts',
			'./f.ts',
			'./g.ts'
		]);
	});

	it('erases `import type` and `export type` but keeps `import { type X }` and `export { type X }`', () => {
		const at = file(
			'src/lib/types.ts',
			[
				`import type { A } from './erased-a.ts';`,
				`import type * as B from './erased-b.ts';`,
				`export type { C } from './erased-c.ts';`,
				`export type * from './erased-d.ts';`,
				`type E = typeof import('./erased-e.ts');`,
				`import { type F } from './kept-f.ts';`,
				`export { type G } from './kept-g.ts';`
			].join('\n')
		);
		expect(runtimeImports(at)).toEqual(['./kept-f.ts', './kept-g.ts']);
	});

	it('ignores an import() whose specifier is not a string literal', () => {
		const at = file('src/lib/computed.ts', 'export const load = (name: string) => import(name);');
		expect(runtimeImports(at)).toEqual([]);
	});

	it('reads every <script> block of a .svelte file, and never its markup', () => {
		const at = file(
			'src/lib/ui/Widget.svelte',
			[
				`<script lang="ts" module>`,
				`\timport { shared } from './module-block.ts';`,
				`</script>`,
				``,
				`<script lang="ts" generics="T extends Record<string, number>">`,
				`\timport type { Props } from './erased.ts';`,
				`\timport Child from './Child.svelte';`,
				`\tconst sheet = () => import('./Sheet.svelte');`,
				`</script>`,
				``,
				`<p>import('./markup-text.ts') is text here, not code.</p>`,
				`<Child />`
			].join('\n')
		);
		expect(runtimeImports(at)).toEqual(['./module-block.ts', './Child.svelte', './Sheet.svelte']);
	});

	it('treats a file that is not code (CSS, SVG) as a leaf', () => {
		expect(runtimeImports(file('src/lib/ui/app.css', `@import './fonts.css';`))).toEqual([]);
	});
});

describe('resolve', () => {
	const from = file('src/routes/page/+page.ts');
	file('src/lib/domain/plain.ts');
	file('src/lib/domain/pkg/index.ts');
	file('src/lib/ui/Card.svelte', '<p>card</p>');
	file('src/lib/index.ts');
	file('src/routes/page/local.ts');

	it.each([
		['#lib/ with its .ts', '#lib/domain/plain.ts', 'src/lib/domain/plain.ts'],
		['#lib/ without an extension', '#lib/domain/plain', 'src/lib/domain/plain.ts'],
		['$lib/ like #lib/', '$lib/domain/plain.ts', 'src/lib/domain/plain.ts'],
		['a folder to its index.ts', '#lib/domain/pkg', 'src/lib/domain/pkg/index.ts'],
		['a .svelte component', '$lib/ui/Card.svelte', 'src/lib/ui/Card.svelte'],
		['a .svelte component without its extension', '#lib/ui/Card', 'src/lib/ui/Card.svelte'],
		['bare #lib to src/lib/index.ts', '#lib', 'src/lib/index.ts'],
		['bare $lib to src/lib/index.ts', '$lib', 'src/lib/index.ts'],
		['a relative path', './local.ts', 'src/routes/page/local.ts'],
		['a relative path upwards', '../../lib/domain/plain', 'src/lib/domain/plain.ts'],
		['a path with a query', '#lib/ui/Card.svelte?url', 'src/lib/ui/Card.svelte']
	])('resolves %s', (_name, specifier, expected) => {
		expect(resolve(from, specifier, options)).toBe(path.join(root, expected));
	});

	it('resolves an absolute path as itself', () => {
		const plain = path.join(root, 'src/lib/domain/plain.ts');
		expect(resolve(from, plain, options)).toBe(plain);
	});

	it.each(['zod', 'zod/mini', '$app/navigation', '@sveltejs/kit', 'node:fs', 'library'])(
		'gives null for the package %s',
		(specifier) => {
			expect(resolve(from, specifier, options)).toBeNull();
		}
	);

	it('throws for a path that resolves to nothing, naming the importing file', () => {
		expect(() => resolve(from, './missing.ts', options)).toThrow(
			"src/routes/page/+page.ts: cannot resolve './missing.ts'"
		);
		expect(() => resolve(from, '#lib/domain/nowhere', options)).toThrow(
			"src/routes/page/+page.ts: cannot resolve '#lib/domain/nowhere'"
		);
	});

	it('resolves against the repository by default', () => {
		expect(resolve(from, '#lib/domain/calendar.ts')).toMatch(/src\/lib\/domain\/calendar\.ts$/);
	});
});

describe('chains', () => {
	it('follows a dynamic import to a target and names the chain', () => {
		file('src/lib/dyn/target.ts');
		const entry = file('src/lib/dyn/entry.ts', `export const x = () => import('./target.ts');`);
		expect(chainsTo(entry, 'dyn/target')).toEqual(['src/lib/dyn/entry.ts → src/lib/dyn/target.ts']);
	});

	it('follows a .svelte script block through #lib/, $lib/ and relative paths', () => {
		file('src/lib/hop/target.ts');
		file('src/lib/hop/third.ts', `export * from './target.ts';`);
		file('src/lib/hop/second.ts', `export { x } from '$lib/hop/third';`);
		const entry = file(
			'src/routes/hop/+page.svelte',
			`<script lang="ts">\n\timport { x } from '#lib/hop/second.ts';\n</script>\n{x}`
		);
		expect(chainsTo(entry, 'hop/target')).toEqual([
			'src/routes/hop/+page.svelte → src/lib/hop/second.ts → src/lib/hop/third.ts → src/lib/hop/target.ts'
		]);
	});

	it('does not follow `import type`, and follows `import { type X }`', () => {
		file('src/lib/kinds/target.ts', 'export type T = number;');
		const erased = file('src/lib/kinds/erased.ts', `import type { T } from './target.ts';`);
		const kept = file('src/lib/kinds/kept.ts', `import { type T } from './target.ts';`);
		expect(chainsTo(erased, 'kinds/target')).toEqual([]);
		expect(chainsTo(kept, 'kinds/target')).toEqual([
			'src/lib/kinds/kept.ts → src/lib/kinds/target.ts'
		]);
	});

	it('enters each module once, stops at a target and reports every import of one', () => {
		file('src/lib/once/target.ts');
		file('src/lib/once/shared.ts', `import './target.ts';`);
		const a = file('src/lib/once/a.ts', `import './shared.ts';\nimport './target.ts';`);
		const b = file('src/lib/once/b.ts', `import './shared.ts';`);
		const walk = chains([a, b], ({ file }) => file?.endsWith('once/target.ts') ?? false, options);
		expect(walk.chains).toEqual([
			'src/lib/once/a.ts → src/lib/once/shared.ts → src/lib/once/target.ts',
			'src/lib/once/a.ts → src/lib/once/target.ts'
		]);
		// The target is never entered; shared.ts is entered once, through the first entry.
		expect(walk.visited).toEqual([
			'src/lib/once/a.ts',
			'src/lib/once/shared.ts',
			'src/lib/once/b.ts'
		]);
	});

	it('lists packages as leaves and can target one by its specifier', () => {
		const entry = file(
			'src/lib/pkgs/entry.ts',
			`import * as z from 'zod/mini';\nimport { goto } from '$app/navigation';\nimport './style.css';`
		);
		file('src/lib/pkgs/style.css', 'p { color: red; }');
		const walk = chains([entry], ({ specifier }) => specifier.startsWith('zod'), options);
		expect(walk.chains).toEqual(['src/lib/pkgs/entry.ts → zod/mini']);
		expect(walk.packages).toEqual(['zod/mini', '$app/navigation']);
		expect(walk.visited).toEqual(['src/lib/pkgs/entry.ts', 'src/lib/pkgs/style.css']);
	});

	it('throws, naming the file, when a module on the walk imports a path that does not exist', () => {
		file('src/lib/broken/inner.ts', `import './gone.ts';`);
		const entry = file('src/lib/broken/entry.ts', `import './inner.ts';`);
		expect(() => chains([entry], () => false, options)).toThrow(
			"src/lib/broken/inner.ts: cannot resolve './gone.ts'"
		);
	});
});

describe('filesUnder', () => {
	it('lists the files under a folder, recursively and sorted, filtered by the predicate', () => {
		file('src/lib/list/b.ts');
		file('src/lib/list/a/deep.svelte', '<p>deep</p>');
		file('src/lib/list/a.test.ts');
		const listed = filesUnder(path.join(root, 'src/lib/list'), (f) => !f.endsWith('.test.ts'));
		expect(listed.map((f) => path.relative(root, f))).toEqual([
			'src/lib/list/a/deep.svelte',
			'src/lib/list/b.ts'
		]);
		expect(filesUnder(path.join(root, 'src/lib/absent'))).toEqual([]);
	});
});
