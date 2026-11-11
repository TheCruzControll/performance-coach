/**
 * SvelteKit's find_deps (patches/@sveltejs__kit@*.patch) decides which chunks a page's HTML
 * modulepreloads. Unpatched, a chunk it reaches through a dynamic import before the entry's own
 * static import of it is left out, so the browser fetches it only once a module that imports it
 * has run: a late round trip (seven chunks on /today). `pnpm budgets` fails on any such chunk.
 */
import { describe, expect, it } from 'vitest';

type Manifest = Record<
	string,
	{ file: string; imports?: string[]; dynamicImports?: string[]; css?: string[] }
>;
type FindDeps = (
	manifest: Manifest,
	entry: string,
	addDynamicCss: boolean,
	root: string
) => { file: string; imports: string[]; stylesheets: string[] };

const utils = new URL(
	'../node_modules/@sveltejs/kit/src/exports/vite/build/utils.js',
	import.meta.url
).href;
const { find_deps } = (await import(/* @vite-ignore */ utils)) as { find_deps: FindDeps };

/**
 * The page imports `panels` (which imports a panel on demand) before `Button`; the panel imports
 * Button and Spinner statically, and Button imports Spinner.
 */
const manifest: Manifest = {
	'nodes/14.js': { file: 'n14.js', imports: ['_panels.js', '_Button.js'], css: ['14.css'] },
	'_panels.js': { file: 'panels.js', dynamicImports: ['Program.svelte'] },
	'Program.svelte': {
		file: 'Program.js',
		imports: ['_Button.js', '_Spinner.js'],
		css: ['Program.css']
	},
	'_Button.js': { file: 'Button.js', imports: ['_Spinner.js'], css: ['Button.css'] },
	'_Spinner.js': { file: 'Spinner.js' }
};

describe('SvelteKit find_deps (patched)', () => {
	it('preloads a statically imported chunk that a dynamic import reached first', () => {
		const { imports } = find_deps(manifest, 'nodes/14.js', true, process.cwd());
		expect(imports).toEqual(['n14.js', 'panels.js', 'Button.js', 'Spinner.js']);
	});

	it('still leaves out what only the dynamic import loads', () => {
		const { imports } = find_deps(manifest, 'nodes/14.js', true, process.cwd());
		expect(imports).not.toContain('Program.js');
	});
});
