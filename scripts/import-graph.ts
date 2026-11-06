/**
 * The one runtime-import walker the import tests share (M3's training index, M6's client-safe
 * analytics, and later the chart bodies). It answers one question: which modules can a file load
 * at runtime, and by which chain of imports?
 *
 * - It reads static imports, re-exports and string-literal `import()`, in .ts files and in every
 *   `<script>` block of a .svelte file (instance and module).
 * - `import type` and `export type` are erased; `import { type X }` still counts, because
 *   verbatimModuleSyntax keeps the import for its side effects.
 * - It resolves what Vite resolves for this repository: `#lib/` (package.json imports), `$lib/`
 *   (SvelteKit), relative and absolute paths, with an exact file, `.ts`, `.svelte` or `index.ts`.
 *   A query (`?url`) is dropped. Anything else (`zod`, `$app/…`) is a package, a leaf of the walk.
 * - A path that resolves to nothing throws, naming the importing file, so a typo cannot hide a
 *   module from a test.
 *
 * It lives in scripts/ because the domain lint block forbids node:fs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** The repository root: where `src/lib` is, and what chains are written relative to. */
export const ROOT = fileURLToPath(new URL('../', import.meta.url));

export interface GraphOptions {
	/** A tree laid out like the repository (`src/lib/…`); the repository itself by default. */
	root?: string;
}

/** Files whose imports the walker reads; any other file (CSS, SVG) is a leaf. */
const CODE = /\.(ts|js|mjs|svelte)$/;
/** A `<script>` block, whatever its attributes (`lang="ts"`, `module`, `generics="…"`). */
const SCRIPT_BLOCK = /<script\b(?:[^>"']|"[^"]*"|'[^']*')*>([\s\S]*?)<\/script>/g;

/** The source text the walker parses: a .svelte file's script blocks, or the whole file. */
function scriptText(file: string): string {
	const text = readFileSync(file, 'utf8');
	if (!file.endsWith('.svelte')) return text;
	return [...text.matchAll(SCRIPT_BLOCK)].map(([, body]) => body).join('\n;\n');
}

const literal = (node: ts.Node | undefined) =>
	node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

/** The specifiers a module still imports once its types are erased, in source order. */
export function runtimeImports(file: string): string[] {
	if (!CODE.test(file)) return [];
	const source = ts.createSourceFile(file, scriptText(file), ts.ScriptTarget.Latest, true);
	const found: string[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isImportDeclaration(node)) {
			const typeOnly = node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
			if (!typeOnly) found.push((node.moduleSpecifier as ts.StringLiteral).text);
			return;
		}
		if (ts.isExportDeclaration(node)) {
			if (node.moduleSpecifier && !node.isTypeOnly) found.push(literal(node.moduleSpecifier)!);
			return;
		}
		if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const specifier = literal(node.arguments[0]);
			if (specifier !== null) found.push(specifier);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

/** A path or alias specifier as a file on disk; null for a package. */
export function resolve(
	from: string,
	specifier: string,
	options: GraphOptions = {}
): string | null {
	const root = options.root ?? ROOT;
	const bare = specifier.replace(/\?.*$/, '');
	const alias = /^[#$]lib(\/|$)/.test(bare) && path.join(root, 'src/lib', bare.slice(5));
	const local = /^\.{0,2}\//.test(bare) && path.resolve(path.dirname(from), bare);
	const target = alias || local;
	if (!target) return null;
	const candidates = [target, `${target}.ts`, `${target}.svelte`, path.join(target, 'index.ts')];
	const file = candidates.find((c) => existsSync(c) && statSync(c).isFile());
	if (!file) throw new Error(`${path.relative(root, from)}: cannot resolve '${specifier}'`);
	return file;
}

/** One runtime import: the importing file, what it wrote, and the file it loads (null: a package). */
export interface ImportEdge {
	from: string;
	specifier: string;
	file: string | null;
}

export interface Walk {
	/** Each chain to a target, `a.ts → b.svelte → target.ts`, paths relative to the root. */
	chains: string[];
	/** Every module the walk entered, entries included, relative to the root. Targets are not. */
	visited: string[];
	/** Every package specifier the walked modules import. */
	packages: string[];
}

/**
 * Every runtime import chain from `entries` to a target. The walk enters each module once (the
 * first chain to reach it), stops at a target and reports one chain for each import of one, so
 * the entries' order decides which chain a module is reported through.
 */
export function chains(
	entries: readonly string[],
	isTarget: (edge: ImportEdge) => boolean,
	options: GraphOptions = {}
): Walk {
	const root = options.root ?? ROOT;
	const name = (file: string) => path.relative(root, file);
	const found: string[] = [];
	const visited = new Set<string>();
	const packages = new Set<string>();
	const visit = (file: string, chain: string[]) => {
		if (visited.has(file)) return;
		visited.add(file);
		for (const specifier of runtimeImports(file)) {
			const target = resolve(file, specifier, options);
			if (!target) packages.add(specifier);
			const next = [...chain, target ? name(target) : specifier];
			if (isTarget({ from: file, specifier, file: target })) found.push(next.join(' → '));
			else if (target) visit(target, next);
		}
	};
	for (const entry of entries) visit(entry, [name(entry)]);
	return { chains: found, visited: [...visited].map(name), packages: [...packages] };
}

/** Every file under `dir` (none when it does not exist) for which `keep` holds, sorted. */
export function filesUnder(dir: string, keep: (file: string) => boolean = () => true): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { recursive: true, encoding: 'utf8' })
		.map((entry) => path.join(dir, entry))
		.filter((file) => statSync(file).isFile() && keep(file))
		.sort();
}
