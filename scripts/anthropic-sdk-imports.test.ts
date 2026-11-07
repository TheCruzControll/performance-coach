/**
 * @anthropic-ai/sdk is pinned to one exact 1.x release (1.0.0 is the first that sends
 * anthropic-version 2026-10-21), and until anthropic-provider lands nothing imports it at runtime:
 * src/ uses it only through `import type`, which is erased, so neither the SDK nor a key can reach
 * a bundle. Once that slice adds agent/provider/anthropic.ts, that file is the one exception (and
 * provider-selection's ESLint block enforces the same rule as code is written).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const SDK = /^@anthropic-ai\//;
const RUNTIME_IMPORT_ALLOWED = [
	'src/lib/server/agent/provider/anthropic.ts',
	// Its unit test builds SDK errors to prove the mapping; a test never reaches a bundle.
	'src/lib/server/agent/provider/anthropic.test.ts'
];

const sources = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) return sources(file);
		return /\.(ts|js|svelte)$/.test(entry.name) ? [file] : [];
	});

/** The SDK specifiers a module still imports once its types are erased, dynamic ones included. */
function runtimeImports(name: string, text: string): string[] {
	// A component never mentions the SDK, not even its types.
	if (name.endsWith('.svelte')) return text.includes('@anthropic-ai/') ? ['(in a component)'] : [];
	const found: string[] = [];
	const visit = (node: ts.Node) => {
		const specifier =
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
				? node.moduleSpecifier.text
				: ts.isCallExpression(node) &&
					  node.expression.kind === ts.SyntaxKind.ImportKeyword &&
					  node.arguments[0] &&
					  ts.isStringLiteral(node.arguments[0])
					? node.arguments[0].text
					: null;
		const typeOnly = ts.isImportDeclaration(node)
			? node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
			: ts.isExportDeclaration(node) && node.isTypeOnly;
		if (specifier && SDK.test(specifier) && !typeOnly) found.push(specifier);
		ts.forEachChild(node, visit);
	};
	visit(ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true));
	return found;
}

describe('@anthropic-ai/sdk', () => {
	it('is pinned to one exact 1.x release', () => {
		const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
		expect(pkg.dependencies['@anthropic-ai/sdk']).toMatch(/^1\.\d+\.\d+$/);
	});

	it('is imported at runtime nowhere in src/, only as types', () => {
		const offenders = sources(path.join(root, 'src')).flatMap((file) => {
			const name = path.relative(root, file);
			if (RUNTIME_IMPORT_ALLOWED.includes(name)) return [];
			return runtimeImports(name, readFileSync(file, 'utf8')).map((spec) => `${name}: ${spec}`);
		});
		expect(offenders).toEqual([]);
		// The check sees the type imports the provider seam really has.
		const seam = readFileSync(path.join(root, 'src/lib/server/agent/provider/types.ts'), 'utf8');
		expect(seam).toMatch(/import type \{[^}]+\} from '@anthropic-ai\/sdk\/resources\/beta/);
	});

	it.each([
		['a value import', `import Anthropic from '@anthropic-ai/sdk';`],
		[
			'an inline type import, which keeps the import',
			`import { type X } from '@anthropic-ai/sdk';`
		],
		['a side-effect import', `import '@anthropic-ai/sdk/shims';`],
		['a re-export', `export { Anthropic } from '@anthropic-ai/sdk';`],
		['a dynamic import', `const sdk = await import('@anthropic-ai/sdk');`],
		['a component that names it', `<script>import type X from '@anthropic-ai/sdk';</script>`]
	])('catches %s', (name, text) => {
		const file = name.startsWith('a component') ? 'x.svelte' : 'x.ts';
		expect(runtimeImports(file, text)).toHaveLength(1);
	});

	it('lets type-only imports and exports through', () => {
		const text = `import type A from '@anthropic-ai/sdk';\nexport type { B } from '@anthropic-ai/sdk/resources';`;
		expect(runtimeImports('x.ts', text)).toEqual([]);
	});
});
