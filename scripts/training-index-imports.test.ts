/**
 * src/lib/domain/training/index.ts is what screens import for the training vocabulary and types,
 * so it must never load a validator at runtime: domain/training/schemas.ts, edits.ts or zod would
 * then ship in the initial JavaScript of every page that imports it. Validators are imported by
 * path instead (servers always, browsers on demand).
 *
 * The check follows every runtime import and re-export from the index through the source tree,
 * so a module added later cannot reach a validator indirectly. `import type` and `export type`
 * are erased; `import { type X }` is not (verbatimModuleSyntax keeps the import for its side
 * effects). It lives in scripts/ because the domain lint block forbids node:fs.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const training = (file: string) => path.join(root, 'src/lib/domain/training', file);
const VALIDATORS = [training('schemas.ts'), training('edits.ts')];
const isZod = (specifier: string) => specifier === 'zod' || specifier.startsWith('zod/');

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

/** Every chain of runtime imports from `entry` to a validator, and the modules visited. */
function validatorChains(entry: string) {
	const chains: string[] = [];
	const visited = new Set<string>();
	const visit = (file: string, chain: string[]) => {
		if (visited.has(file)) return;
		visited.add(file);
		for (const specifier of runtimeImports(file)) {
			const target = resolve(file, specifier);
			const next = [...chain, target ? path.relative(root, target) : specifier];
			if (isZod(specifier) || (target && VALIDATORS.includes(target)))
				chains.push(next.join(' → '));
			else if (target) visit(target, next);
		}
	};
	visit(entry, [path.relative(root, entry)]);
	return { chains, visited: [...visited].map((file) => path.relative(root, file)) };
}

describe('domain/training/index.ts', () => {
	it('loads no validator at runtime, directly or through what it re-exports', () => {
		const { chains, visited } = validatorChains(training('index.ts'));
		expect(chains).toEqual([]);
		// The walk really follows the index's runtime re-exports.
		expect(visited).toContain('src/lib/domain/training/vocabulary.ts');
		expect(visited).toContain('src/lib/domain/profile/catalog.ts');
	});
});

describe('the import walk', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'training-index-'));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const module = (name: string, text: string) => {
		const file = path.join(dir, name);
		writeFileSync(file, text);
		return file;
	};
	const schemas = JSON.stringify(training('schemas.ts'));

	it.each([
		['a re-export of the schemas', `export * from ${schemas};`],
		['a named re-export of one schema', `export { programPlanSchema } from ${schemas};`],
		['a zod import', `import * as z from 'zod/mini';\nexport const s = z.string();`],
		[
			'an inline type import, which keeps the import',
			`import { type ProgramPlan } from ${schemas};`
		]
	])('finds %s', (name, text) => {
		const entry = module(`${name.replaceAll(' ', '-')}.ts`, text);
		expect(validatorChains(entry).chains).toHaveLength(1);
	});

	it('finds a validator two modules away and names the chain', () => {
		module(
			'inner.ts',
			`export { validate } from ${JSON.stringify(path.join(root, 'src/lib/domain/validation.ts'))};`
		);
		const entry = module('outer.ts', `export * from './inner.ts';`);
		expect(validatorChains(entry).chains).toEqual([
			`${path.relative(root, entry)} → ${path.relative(root, path.join(dir, 'inner.ts'))} → src/lib/domain/validation.ts → zod/mini`
		]);
	});

	it('lets type-only imports and re-exports through, since they are erased', () => {
		const entry = module(
			'types-only.ts',
			`import type { ProgramPlan } from ${schemas};\nexport type * from ${schemas};\nexport type { ProgramPlan };`
		);
		expect(validatorChains(entry).chains).toEqual([]);
	});
});
