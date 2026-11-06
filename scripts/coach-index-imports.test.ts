/**
 * src/lib/domain/coach/index.ts is what screens, the stream client and the server import the
 * coach's contract from, so it must stay client-safe at runtime: no zod (or any package), no
 * server-only coach module (the answer parser, markdown, proposals, grounding and the others the
 * server-only rule lists) and neither server-only domain package. Any of them would ship in the
 * initial JavaScript of every coach screen, or put server code in the browser.
 *
 * The check follows every runtime import and re-export from the index through the source tree,
 * so a module a later slice adds cannot reach one indirectly. `import type` and `export type` are
 * erased; `import { type X }` is not (verbatimModuleSyntax keeps the import). It lives in
 * scripts/ because the domain lint block forbids node:fs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const domain = (file: string) => path.join(root, 'src/lib/domain', file);

/** The coach modules that are server-only (m5 plan, layers): imported by path, never by the index. */
const SERVER_ONLY_COACH = [
	'answer',
	'markdown',
	'proposals',
	'proposal-rules',
	'diff',
	'grounding',
	'memory-format',
	'summary',
	'trends',
	'notes'
].map((name) => domain(`coach/${name}.ts`));
const SERVER_ONLY_PACKAGES = [domain('exercises') + path.sep, domain('programming') + path.sep];

/** Why a runtime import is not allowed from the index, or null. */
function forbidden(specifier: string, target: string | null): string | null {
	if (!target) return `the package ${specifier}`;
	if (SERVER_ONLY_COACH.includes(target)) return 'a server-only coach module';
	if (SERVER_ONLY_PACKAGES.some((dir) => target.startsWith(dir))) return 'a server-only package';
	return null;
}

/** The specifiers a module still imports once its types are erased. */
function runtimeImports(file: string): string[] {
	const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
	return source.statements.flatMap((statement) => {
		if (ts.isImportDeclaration(statement)) {
			const typeOnly = statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
			return typeOnly ? [] : [(statement.moduleSpecifier as ts.StringLiteral).text];
		}
		if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
			return statement.isTypeOnly ? [] : [(statement.moduleSpecifier as ts.StringLiteral).text];
		}
		return [];
	});
}

/** A path or `#lib/` specifier as a file on disk; null for a package. */
function resolve(from: string, specifier: string): string | null {
	const lib = specifier.startsWith('#lib/') && path.join(root, 'src/lib', specifier.slice(5));
	const local = /^\.{0,2}\//.test(specifier) && path.resolve(path.dirname(from), specifier);
	const target = lib || local;
	if (!target) return null;
	const candidates = [target, `${target}.ts`, path.join(target, 'index.ts')];
	const file = candidates.find((c) => existsSync(c) && statSync(c).isFile());
	if (!file) throw new Error(`${path.relative(root, from)}: cannot resolve '${specifier}'`);
	return file;
}

/** Every chain of runtime imports from `entry` to something forbidden, and the modules visited. */
function forbiddenChains(entry: string) {
	const chains: string[] = [];
	const visited = new Set<string>();
	const visit = (file: string, chain: string[]) => {
		if (visited.has(file)) return;
		visited.add(file);
		for (const specifier of runtimeImports(file)) {
			const target = resolve(file, specifier);
			const next = [...chain, target ? path.relative(root, target) : specifier];
			const reason = forbidden(specifier, target);
			if (reason) chains.push(`${next.join(' → ')} (${reason})`);
			else if (target) visit(target, next);
		}
	};
	visit(entry, [path.relative(root, entry)]);
	return { chains, visited: [...visited].map((file) => path.relative(root, file)) };
}

describe('domain/coach/index.ts', () => {
	it('reaches no package, server-only coach module or server-only domain package', () => {
		const { chains, visited } = forbiddenChains(domain('coach/index.ts'));
		expect(chains).toEqual([]);
		// The walk really follows the index's runtime re-exports, through to other domain modules.
		for (const module of ['vocabulary', 'events', 'sources', 'rich', 'memory', 'tools', 'budgets'])
			expect(visited).toContain(`src/lib/domain/coach/${module}.ts`);
		expect(visited).toContain('src/lib/domain/calendar.ts');
		expect(visited.filter((file) => !file.startsWith('src/lib/domain/'))).toEqual([]);
	});
});

describe('the import walk', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'coach-index-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const module = (name: string, text: string) => {
		const file = path.join(dir, name);
		writeFileSync(file, text);
		return file;
	};
	const answer = JSON.stringify(domain('coach/answer.ts'));
	const exercises = JSON.stringify(domain('exercises/index.ts'));

	it.each([
		['a zod import', `import * as z from 'zod/mini';\nexport const s = z.string();`, 'the package'],
		['a re-export of answer.ts', `export * from ${answer};`, 'a server-only coach module'],
		[
			'a named re-export of the parser',
			`export { createAnswerParser } from ${answer};`,
			'a server-only coach module'
		],
		[
			'an inline type import, which keeps the import',
			`import { type AnswerBlock } from ${answer};`,
			'a server-only coach module'
		],
		['a re-export of domain/exercises', `export * from ${exercises};`, 'a server-only package']
	])('catches %s', (name, text, reason) => {
		const entry = module(`${name.replace(/\W+/g, '-')}.ts`, text);
		const { chains } = forbiddenChains(entry);
		expect(chains).toHaveLength(1);
		expect(chains[0]).toContain(`(${reason}`);
	});

	it('finds a forbidden module two modules away and names the chain', () => {
		module('inner.ts', `export { parseAnswer } from ${answer};`);
		const entry = module('outer.ts', `export * from './inner.ts';`);
		expect(forbiddenChains(entry).chains).toEqual([
			`${path.relative(root, entry)} → ${path.relative(root, path.join(dir, 'inner.ts'))} → src/lib/domain/coach/answer.ts (a server-only coach module)`
		]);
	});

	it('lets type-only imports and re-exports through, since they are erased', () => {
		const entry = module(
			'types-only.ts',
			`import type { AnswerBlock } from ${answer};\nexport type * from ${exercises};\nexport type { AnswerBlock };`
		);
		expect(forbiddenChains(entry).chains).toEqual([]);
	});
});
