/**
 * docs/environment.md and the server's env schema describe the same variables. Every key of
 * `envSchema` (src/lib/server/env.ts, read with the TypeScript compiler API, so a key is found
 * however its validator is written) has a row in one of the doc's tables, and every row of the
 * app's table (the first table under "Variables") names a key. The "Test tooling" table holds
 * variables the app never reads and is checked only the first way.
 *
 * Lenient until docs-m9: today's gaps are listed in scripts/docs-known-gaps.json (see
 * scripts/lib/docs-scan.ts, `reconcile`).
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { envNames, type Gap, isStrict, reconcile, tables } from './lib/docs-scan.ts';
import { type DocsTree, fsTree, knownGaps, memoryTree } from './lib/docs-tree.ts';

const TEST = 'docs-env';
const DOC = 'docs/environment.md';
const SCHEMA = 'src/lib/server/env.ts';

/** The property names of the object literal passed to `z.object` in `export const envSchema`. */
function envSchemaKeys(source: string): string[] {
	const file = ts.createSourceFile(SCHEMA, source, ts.ScriptTarget.Latest, true);
	let keys: string[] | undefined;
	const visit = (node: ts.Node): void => {
		if (keys) return;
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === 'object' &&
			node.expression.expression.getText(file) === 'z' &&
			node.arguments[0] &&
			ts.isObjectLiteralExpression(node.arguments[0])
		) {
			keys = node.arguments[0].properties.flatMap((property) =>
				property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
					? [property.name.text]
					: []
			);
			return;
		}
		ts.forEachChild(node, visit);
	};
	file.forEachChild((statement) => {
		if (!ts.isVariableStatement(statement)) return;
		for (const declaration of statement.declarationList.declarations) {
			if (declaration.name.getText(file) === 'envSchema' && declaration.initializer) {
				visit(declaration.initializer);
			}
		}
	});
	if (!keys) throw new Error(`${SCHEMA}: no \`envSchema = z.object({ … })\` found`);
	return keys;
}

function envGaps(tree: DocsTree): Gap[] {
	const keys = envSchemaKeys(tree.read(SCHEMA) ?? '');
	const doc = tables(tree.read(DOC) ?? '');
	const rowName = (row: string[]) => envNames(row[0] ?? '')[0];
	const documented = new Set(doc.flatMap((table) => table.rows.map(rowName)));
	const appRows = doc.find((table) => table.heading === 'Variables')?.rows ?? [];
	const gap = (item: string): Gap => ({ test: TEST, doc: DOC, item });
	return [
		...keys.filter((key) => !documented.has(key)).map((key) => gap(`${key}: no row`)),
		...appRows
			.map(rowName)
			.filter((name) => name !== undefined && !keys.includes(name))
			.map((name) => gap(`${name}: not a key of envSchema`))
	];
}

const schemaWith = (...keys: string[]) =>
	`export const envSchema = z\n\t.object({\n${keys.map((key) => `\t\t${key}: z.string(),`).join('\n')}\n\t})\n\t.transform((env) => env);`;
const docWith = (...rows: string[]) =>
	`# Environment variables\n\n## Variables\n\n| Variable | Purpose |\n| --- | --- |\n${rows.map((row) => `| \`${row}\` | x |`).join('\n')}\n\nTest tooling:\n\n| Variable | Used by |\n| --- | --- |\n| \`E2E_PORT\` | e2e |\n`;
const fixture = (keys: string[], rows: string[]) =>
	memoryTree({ [SCHEMA]: schemaWith(...keys), [DOC]: docWith(...rows) });

describe('docs-env guard', () => {
	it('reads every key of the real schema, including optional and defaulted ones', () => {
		const keys = envSchemaKeys(fsTree().read(SCHEMA)!);
		expect(keys).toEqual(
			expect.arrayContaining(['DATABASE_URL', 'DB_POOL_MAX', 'OWNER_EMAIL', 'ANTHROPIC_API_KEY'])
		);
		expect(keys).not.toContain('appEnv');
	});

	it('passes a tree where the schema and the table agree', () => {
		expect(envGaps(fixture(['DATABASE_URL', 'LOG_LEVEL'], ['DATABASE_URL', 'LOG_LEVEL']))).toEqual(
			[]
		);
	});

	it('finds an undocumented variable', () => {
		expect(envGaps(fixture(['DATABASE_URL', 'CRON_SECRET'], ['DATABASE_URL']))).toEqual([
			{ test: TEST, doc: DOC, item: 'CRON_SECRET: no row' }
		]);
	});

	it('finds a row that names no key, but not a test-tooling row', () => {
		expect(envGaps(fixture(['DATABASE_URL'], ['DATABASE_URL', 'REMOVED_VAR']))).toEqual([
			{ test: TEST, doc: DOC, item: 'REMOVED_VAR: not a key of envSchema' }
		]);
	});

	it('accepts a key documented in the test-tooling table', () => {
		expect(envGaps(fixture(['DATABASE_URL', 'E2E_PORT'], ['DATABASE_URL']))).toEqual([]);
	});

	it('has no gap in the repository beyond the known-gaps list, and every listed gap still holds', () => {
		expect(reconcile(TEST, envGaps(fsTree()), knownGaps(), isStrict(process.env))).toEqual([]);
	});
});
