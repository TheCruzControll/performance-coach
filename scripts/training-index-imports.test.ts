/**
 * src/lib/domain/training/index.ts is what screens import for the training vocabulary and types,
 * so it must never load a validator at runtime: domain/training/schemas.ts, edits.ts or zod would
 * then ship in the initial JavaScript of every page that imports it. Validators are imported by
 * path instead (servers always, browsers on demand).
 *
 * The check follows every runtime import and re-export from the index through the source tree,
 * so a module added later cannot reach a validator indirectly. `import type` and `export type`
 * are erased; `import { type X }` is not (verbatimModuleSyntax keeps the import for its side
 * effects). The walk is scripts/import-graph.ts, which the other import tests share. It lives in
 * scripts/ because the domain lint block forbids node:fs.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { chains, ROOT as root } from './import-graph.ts';

const training = (file: string) => path.join(root, 'src/lib/domain/training', file);
const VALIDATORS = [training('schemas.ts'), training('edits.ts')];
const isZod = (specifier: string) => specifier === 'zod' || specifier.startsWith('zod/');

/** Every chain of runtime imports from `entry` to a validator, the modules and the packages. */
const validatorChains = (entry: string) =>
	chains(
		[entry],
		({ specifier, file }) => isZod(specifier) || (file !== null && VALIDATORS.includes(file))
	);

describe('domain/training/index.ts', () => {
	it('loads no validator at runtime, directly or through what it re-exports', () => {
		const { chains, visited } = validatorChains(training('index.ts'));
		expect(chains).toEqual([]);
		// The walk really follows the index's runtime re-exports.
		expect(visited).toContain('src/lib/domain/training/vocabulary.ts');
		expect(visited).toContain('src/lib/domain/training/describe.ts');
		expect(visited).toContain('src/lib/domain/profile/catalog.ts');
	});

	it('keeps describe.ts, in Train’s and Today’s initial JS, to domain modules and no package', () => {
		const { packages, visited } = validatorChains(training('describe.ts'));
		expect(packages).toEqual([]);
		expect(visited.filter((file) => !file.startsWith('src/lib/domain/'))).toEqual([]);
		expect(visited).toContain('src/lib/domain/units.ts');
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
