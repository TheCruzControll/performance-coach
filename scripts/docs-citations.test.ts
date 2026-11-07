/**
 * What the operational docs cite exists. In each doc below:
 *
 * - every relative link resolves to a file or folder;
 * - every backticked repository path (`src/…`, `tests/…`, `e2e/…`, `scripts/…`, `docs/…`,
 *   `drizzle/…`, `.github/…`) exists, and a pattern (`scripts/auth-*.ts`) matches a file;
 * - every `pnpm <name>` is a package.json script, a pnpm command or an installed binary;
 * - every finding of a register (a table row whose first cell is `F<n>`) has a status, and a
 *   finding whose status is Fixed names an existing regression test by its path.
 *
 * Lenient until docs-m9: today's gaps are listed in scripts/docs-known-gaps.json.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	type Gap,
	isStrict,
	PNPM_COMMANDS,
	pnpmCommands,
	reconcile,
	relativeLinks,
	repoPaths,
	tables
} from './lib/docs-scan.ts';
import { citedPathExists, type DocsTree, fsTree, knownGaps, memoryTree } from './lib/docs-tree.ts';

const TEST = 'docs-citations';

/** The docs whose citations are checked; the security review joins once attack-surface adds it. */
const CITED_DOCS = [
	'docs/security.md',
	'docs/testing.md',
	'docs/performance.md',
	'docs/development.md',
	'docs/deployment.md',
	'docs/environment.md'
];
const ONCE_IT_EXISTS = ['docs/reports/security-review.md'];

const TEST_FILE = /\.(?:test|e2e|spec)\.ts$/;

/** Paths a run creates and git ignores: cited as outputs, never present in a clean clone. */
const GENERATED = [
	'e2e/.auth/' // Playwright's stored sessions and virtual passkeys (e2e/global-setup.ts)
];

function registerGaps(tree: DocsTree, text: string): string[] {
	const found: string[] = [];
	for (const table of tables(text)) {
		const status = table.header.findIndex((cell) => /^status$/i.test(cell));
		for (const row of table.rows) {
			const id = /^\**(F\d+)\**$/.exec(row[0] ?? '')?.[1];
			if (!id) continue;
			const value = status === -1 ? '' : (row[status] ?? '').replace(/[*_]/g, '').trim();
			if (!value || /^[-—–]$/.test(value)) {
				found.push(`finding ${id}: no status`);
			} else if (/^fixed\b/i.test(value)) {
				const tests = repoPaths(row.join(' | ')).filter((cited) => TEST_FILE.test(cited));
				if (!tests.some((cited) => tree.exists(cited))) {
					found.push(`finding ${id}: fixed, but names no existing regression test`);
				}
			}
		}
	}
	return found;
}

function citationGaps(tree: DocsTree): Gap[] {
	const scripts = Object.keys(
		(JSON.parse(tree.read('package.json') ?? '{}') as { scripts?: object }).scripts ?? {}
	);
	const known = (name: string) =>
		scripts.includes(name) || PNPM_COMMANDS.has(name) || tree.exists(`node_modules/.bin/${name}`);
	const found: Gap[] = [];
	for (const doc of [...CITED_DOCS, ...ONCE_IT_EXISTS.filter((file) => tree.exists(file))]) {
		const text = tree.read(doc);
		if (text === undefined) {
			found.push({ test: TEST, doc, item: 'the doc is missing' });
			continue;
		}
		const items = new Set([
			...relativeLinks(text)
				.filter((link) => !tree.exists(path.posix.join(path.posix.dirname(doc), link)))
				.map((link) => `link ${link}`),
			...repoPaths(text)
				.filter((cited) => !GENERATED.some((prefix) => cited.startsWith(prefix)))
				.filter((cited) => !citedPathExists(tree, cited))
				.map((cited) => `path ${cited}`),
			...pnpmCommands(text)
				.filter((name) => !known(name))
				.map((name) => `pnpm ${name}`),
			...registerGaps(tree, text)
		]);
		for (const item of items) found.push({ test: TEST, doc, item });
	}
	return found;
}

/** A tree where every cited doc exists; `docs/testing.md` holds the text under test. */
const fixture = (testing: string, extra: Record<string, string> = {}) =>
	memoryTree({
		'package.json': JSON.stringify({ scripts: { 'test:unit': 'vitest', 'db:migrate': 'node' } }),
		'node_modules/.bin/drizzle-kit': '',
		'scripts/check-budgets.ts': '',
		'scripts/auth-setup-token.ts': '',
		'tests/integration/auth/signin.test.ts': '',
		...Object.fromEntries(CITED_DOCS.map((doc) => [doc, '# Doc\n'])),
		'docs/testing.md': testing,
		...extra
	});
const itemsIn = (tree: DocsTree) => citationGaps(tree).map((gap) => `${gap.doc}: ${gap.item}`);

describe('docs-citations guard', () => {
	it('passes a doc whose links, paths, patterns and commands all exist', () => {
		const doc = [
			'See [deployment](deployment.md#owner-setup) and [the token](../scripts/auth-setup-token.ts).',
			'Budgets: `scripts/check-budgets.ts`, the auth scripts `scripts/auth-*.ts`, `tests/integration/**`.',
			'Run `pnpm test:unit`, `pnpm run db:migrate`, `pnpm exec playwright test` or `pnpm drizzle-kit generate`.',
			'```sh\nDATABASE_URL=x pnpm db:migrate   # then\npnpm install --frozen-lockfile\n```',
			'An [external link](https://example.test/x) and an [anchor](#top) are not checked.'
		].join('\n\n');
		expect(itemsIn(fixture(doc))).toEqual([]);
	});

	it('finds a broken link, a missing path, a pattern that matches nothing and an unknown script', () => {
		const doc = [
			'See [the runbook](runbook.md).',
			'Lives in `src/lib/server/gone.ts:12` and `scripts/backup-*.ts`.',
			'Run `pnpm backup:restore` first.',
			'```sh\npnpm run db:seed\n```'
		].join('\n\n');
		expect(itemsIn(fixture(doc))).toEqual([
			'docs/testing.md: link runbook.md',
			'docs/testing.md: path src/lib/server/gone.ts',
			'docs/testing.md: path scripts/backup-*.ts',
			'docs/testing.md: pnpm backup:restore',
			'docs/testing.md: pnpm db:seed'
		]);
	});

	it('ignores paths and links inside fenced blocks, and reports a missing doc', () => {
		const tree = memoryTree({
			'package.json': '{}',
			...Object.fromEntries(
				CITED_DOCS.slice(1).map((doc) => [doc, '```\n`src/nope.ts` [x](nope.md)\n```\n'])
			)
		});
		expect(itemsIn(tree)).toEqual(['docs/security.md: the doc is missing']);
	});

	it('checks the security review once it exists: a finding without a status or without its test', () => {
		const register = [
			'| ID | Severity | Evidence | Owner | Status |',
			'| --- | --- | --- | --- | --- |',
			'| F1 | High | `tests/integration/auth/signin.test.ts` | sec-fix-f1 | Fixed |',
			'| F2 | Low | — | runtime-role | Open |',
			'| F3 | Medium | — | secrets-scan | |',
			'| F4 | Medium | `scripts/check-budgets.ts` | headers | **Fixed** in #200 |'
		].join('\n');
		const tree = fixture('# Testing\n', { 'docs/reports/security-review.md': register });
		expect(itemsIn(tree)).toEqual([
			'docs/reports/security-review.md: finding F3: no status',
			'docs/reports/security-review.md: finding F4: fixed, but names no existing regression test'
		]);
	});

	it('has no gap in the repository beyond the known-gaps list, and every listed gap still holds', () => {
		expect(reconcile(TEST, citationGaps(fsTree()), knownGaps(), isStrict(process.env))).toEqual([]);
	});
});
