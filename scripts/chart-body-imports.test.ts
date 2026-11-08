/**
 * Chart bodies (src/lib/ui/charts/bodies/) draw a chart in the browser after hydration. While the
 * server build can reach one, SvelteKit links its CSS into every page that might show it, as a
 * render-blocking stylesheet, and the body's code joins the server bundle. So a body is imported
 * only by the registry, src/lib/ui/charts/bodies.ts, only through import(), and only as
 * `import.meta.env.SSR ? never() : import('./bodies/X.svelte')`.
 *
 * The check walks every runtime import of every source file (scripts/import-graph.ts, the walker
 * the other import tests share) and fails, naming the file, on any other import of a body; then it
 * reads the registry's syntax tree for the guard. `import type` is erased and passes. It lives in
 * scripts/ because the domain lint block forbids node:fs.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { chains, filesUnder, resolve, ROOT, type ImportEdge } from './import-graph.ts';

const BODIES = 'src/lib/ui/charts/bodies';
const REGISTRY = 'src/lib/ui/charts/bodies.ts';
/** The one guard a body import may sit behind. */
const GUARD = 'import.meta.env.SSR';

const isSource = (file: string) => /\.(ts|svelte)$/.test(file) && !/\.(test|spec)\.ts$/.test(file);

/** Is `node` the false branch of `import.meta.env.SSR ? never() : …`, through any parentheses? */
function guarded(node: ts.Node): boolean {
	let child = node;
	let parent = node.parent;
	while (ts.isParenthesizedExpression(parent)) [child, parent] = [parent, parent.parent];
	if (!ts.isConditionalExpression(parent) || parent.whenFalse !== child) return false;
	const never = parent.whenTrue;
	return (
		parent.condition.getText() === GUARD &&
		ts.isCallExpression(never) &&
		never.expression.getText() === 'never' &&
		never.arguments.length === 0
	);
}

/** Each body import in the registry that is static, or an import() outside the guard. */
function registryProblems(root: string, isBody: (file: string | null) => boolean): string[] {
	const file = path.join(root, REGISTRY);
	const source = ts.createSourceFile(
		file,
		readFileSync(file, 'utf8'),
		ts.ScriptTarget.Latest,
		true
	);
	const problems: string[] = [];
	const body = (specifier: ts.Node | undefined) =>
		specifier &&
		ts.isStringLiteralLike(specifier) &&
		isBody(resolve(file, specifier.text, { root }))
			? specifier.text
			: null;
	const visit = (node: ts.Node) => {
		if (
			ts.isImportDeclaration(node) &&
			node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword
		) {
			const name = body(node.moduleSpecifier);
			if (name)
				problems.push(`${REGISTRY} imports ${name} statically: use import() behind ${GUARD}`);
		} else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
			const name = body(node.moduleSpecifier);
			if (name) problems.push(`${REGISTRY} re-exports ${name}: use import() behind ${GUARD}`);
		} else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
			const name = body(node.arguments[0]);
			if (name && !guarded(node)) {
				problems.push(`${REGISTRY} imports ${name} outside \`${GUARD} ? never() : import(…)\``);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return problems;
}

/** Every import of a chart body that breaks the rule, in words, and the walk behind it. */
function bodyImportProblems(root = ROOT) {
	const dir = path.join(root, BODIES) + path.sep;
	const registry = path.join(root, REGISTRY);
	const isBody = (file: string | null) => file !== null && file.startsWith(dir);
	const entries = filesUnder(path.join(root, 'src'), isSource);
	const imports: ImportEdge[] = [];
	const walk = chains(
		entries,
		(edge) => {
			if (isBody(edge.file)) imports.push(edge);
			return isBody(edge.file);
		},
		{ root }
	);
	const name = (file: string) => path.relative(root, file);
	const outside = imports
		.filter((edge) => edge.from !== registry)
		.map((edge) => `${name(edge.from)} imports ${name(edge.file!)}: only ${REGISTRY} may`);
	return {
		problems: [...outside, ...registryProblems(root, isBody)],
		bodies: imports.filter((edge) => edge.from === registry).map((edge) => name(edge.file!)),
		visited: walk.visited
	};
}

describe('the real tree', () => {
	it('loads every chart body through the guarded registry alone', () => {
		const { problems, visited } = bodyImportProblems();
		expect(problems).toEqual([]);
		// The walk read the whole tree: browser and server code, the registry included.
		expect(visited).toContain(REGISTRY);
		expect(visited).toContain('src/routes/+layout.svelte');
		expect(visited).toContain('src/hooks.server.ts');
		expect(visited).toContain('src/lib/ui/charts/ChartFrame.svelte');
		expect(visited.filter((file) => /\.(test|spec)\.ts$/.test(file))).toEqual([]);
		// It parses every source file: give it room on a busy machine.
	}, 30_000);
});

describe('the check, on fixture trees', () => {
	const roots: string[] = [];
	afterAll(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

	const svelte = (script: string) => `<script lang="ts">\n\t${script}\n</script>\n\n<p>chart</p>\n`;
	const GUARDED = `export const never = () => new Promise<never>(() => {});\nexport const CHART_BODIES = {\n\tline: () => (import.meta.env.SSR ? never() : import('./bodies/LineBody.svelte'))\n};\n`;

	/** A fixture tree laid out like the repository, with two bodies and the guarded registry. */
	function tree(files: Record<string, string>): string {
		const root = mkdtempSync(path.join(tmpdir(), 'chart-bodies-'));
		roots.push(root);
		const base = {
			[`${BODIES}/LineBody.svelte`]: svelte(`let { values }: { values: number[] } = $props();`),
			[`${BODIES}/BarBody.svelte`]: svelte(`let { values }: { values: number[] } = $props();`),
			[REGISTRY]: GUARDED,
			'src/routes/progress/+page.svelte': svelte(
				`import { CHART_BODIES } from '#lib/ui/charts/bodies.ts';\n\tconst line = CHART_BODIES.line;`
			)
		};
		for (const [name, text] of Object.entries({ ...base, ...files })) {
			const at = path.join(root, name);
			mkdirSync(path.dirname(at), { recursive: true });
			writeFileSync(at, text);
		}
		return root;
	}

	it('passes a body behind the guard in the registry, with or without parentheses', () => {
		const { problems, bodies } = bodyImportProblems(tree({}));
		expect(problems).toEqual([]);
		expect(bodies).toEqual([`${BODIES}/LineBody.svelte`]);
		const bare = tree({
			[REGISTRY]: `import { never } from './never.ts';\nexport const line = () => import.meta.env.SSR ? never() : import('./bodies/LineBody.svelte');\n`,
			'src/lib/ui/charts/never.ts': 'export const never = () => new Promise<never>(() => {});'
		});
		expect(bodyImportProblems(bare).problems).toEqual([]);
	});

	it('fails a route that imports a body, statically or through import()', () => {
		const root = tree({
			'src/routes/progress/+page.svelte': svelte(
				`import LineBody from '#lib/ui/charts/bodies/LineBody.svelte';`
			),
			'src/lib/ui/analytics/Tile.svelte': svelte(
				`const load = () => (import.meta.env.SSR ? never() : import('../charts/bodies/BarBody.svelte'));`
			)
		});
		expect(bodyImportProblems(root).problems).toEqual([
			`src/lib/ui/analytics/Tile.svelte imports ${BODIES}/BarBody.svelte: only ${REGISTRY} may`,
			`src/routes/progress/+page.svelte imports ${BODIES}/LineBody.svelte: only ${REGISTRY} may`
		]);
	});

	it('fails a body that imports another body, and server code that imports one', () => {
		const root = tree({
			[`${BODIES}/BarBody.svelte`]: svelte(`import Line from './LineBody.svelte';`),
			'src/lib/server/render.ts': `export { default } from '#lib/ui/charts/bodies/LineBody.svelte';`
		});
		expect(bodyImportProblems(root).problems).toEqual([
			`src/lib/server/render.ts imports ${BODIES}/LineBody.svelte: only ${REGISTRY} may`,
			`${BODIES}/BarBody.svelte imports ${BODIES}/LineBody.svelte: only ${REGISTRY} may`
		]);
	});

	it('passes `import type` from a body anywhere: it is erased', () => {
		const root = tree({
			'src/routes/progress/+page.svelte': svelte(
				`import type LineBody from '#lib/ui/charts/bodies/LineBody.svelte';\n\tlet body: typeof LineBody | undefined;`
			)
		});
		expect(bodyImportProblems(root).problems).toEqual([]);
	});

	it('fails the registry importing a body statically or re-exporting it', () => {
		const root = tree({
			[REGISTRY]: `import LineBody from './bodies/LineBody.svelte';\nexport { default as Bar } from './bodies/BarBody.svelte';\nexport const CHART_BODIES = { LineBody };\n`
		});
		expect(bodyImportProblems(root).problems).toEqual([
			`${REGISTRY} imports ./bodies/LineBody.svelte statically: use import() behind ${GUARD}`,
			`${REGISTRY} re-exports ./bodies/BarBody.svelte: use import() behind ${GUARD}`
		]);
	});

	it('fails an import() in the registry without the guard, or with it the wrong way round', () => {
		const unguarded = (expression: string) =>
			tree({
				[REGISTRY]: `export const never = () => new Promise<never>(() => {});\nconst browser = typeof window !== 'undefined';\nexport const CHART_BODIES = { line: () => ${expression} };\n`
			});
		const problem = `${REGISTRY} imports ./bodies/LineBody.svelte outside \`${GUARD} ? never() : import(…)\``;
		for (const expression of [
			`import('./bodies/LineBody.svelte')`,
			`(import.meta.env.SSR ? import('./bodies/LineBody.svelte') : never())`,
			`(browser ? never() : import('./bodies/LineBody.svelte'))`,
			`(import.meta.env.SSR ? Promise.reject() : import('./bodies/LineBody.svelte'))`
		]) {
			expect(bodyImportProblems(unguarded(expression)).problems, expression).toEqual([problem]);
		}
	});
});
