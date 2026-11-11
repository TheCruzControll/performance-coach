import { describe, expect, it } from 'vitest';
import {
	envNames,
	type Gap,
	isStrict,
	patternToRegExp,
	pnpmCommands,
	reconcile,
	relativeLinks,
	repoPaths,
	splitFences,
	tables
} from './docs-scan.ts';
import { citedPathExists, fsTree, memoryTree } from './docs-tree.ts';

const gap = (item: string, test = 'docs-env'): Gap => ({ test, doc: 'docs/environment.md', item });

describe('reconcile (the known-gaps list only shrinks)', () => {
	const known = [gap('A: no row'), gap('B: no row'), gap('x', 'adr-index')];

	it('passes when the gaps found are exactly the listed ones', () => {
		expect(reconcile('docs-env', [gap('B: no row'), gap('A: no row')], known, false)).toEqual([]);
	});

	it('fails a gap that is not listed', () => {
		expect(
			reconcile('docs-env', [gap('A: no row'), gap('B: no row'), gap('C: no row')], known, false)
		).toEqual([
			'docs/environment.md: C: no row (new gap: fix the doc; never add it to the known-gaps list)'
		]);
	});

	it('fails a listed gap that no longer reproduces, and ignores other guards’ entries', () => {
		expect(reconcile('docs-env', [gap('A: no row')], known, false)).toEqual([
			'docs/environment.md: B: no row (fixed: remove it from scripts/docs-known-gaps.json)'
		]);
	});

	it('fails every gap when strict, listed or not', () => {
		expect(reconcile('docs-env', [gap('A: no row')], known, true)).toEqual([
			'docs/environment.md: A: no row (strict: no gap is allowed)'
		]);
		expect(reconcile('docs-env', [], known, true)).toEqual([]);
	});

	it('is lenient by default and strict with STRICT=1', () => {
		expect(isStrict({})).toBe(false);
		expect(isStrict({ STRICT: '0' })).toBe(false);
		expect(isStrict({ STRICT: '1' })).toBe(true);
	});
});

describe('markdown extraction', () => {
	const doc = [
		'# Title',
		'',
		'See [setup](deployment.md#owner-setup), [env](../src/lib/server/env.ts "schema"), [web](https://x.test) and [here](#top).',
		'The guard `scripts/check-budgets.ts:12`, a folder `src/lib/server/`, a sentence `src/x is here`, and `README.md`.',
		'Run `pnpm test:unit`, `ORIGIN=http://localhost:4173 pnpm build:node` and `pnpm --silent run db:migrate`.',
		'',
		'```sh',
		'pnpm lighthouse --runs 5   # `src/inside-fence.ts` [not a link](nope.md)',
		'```',
		'',
		'[ref]: ./testing.md'
	].join('\n');

	it('blanks fenced blocks in place, keeping their text', () => {
		const { prose, fenced } = splitFences(doc);
		expect(prose.split('\n')).toHaveLength(doc.split('\n').length);
		expect(prose).not.toContain('inside-fence');
		expect(fenced).toEqual([
			'pnpm lighthouse --runs 5   # `src/inside-fence.ts` [not a link](nope.md)\n'
		]);
	});

	it('reads relative links, without anchors, schemes or links in fences', () => {
		expect(relativeLinks(doc)).toEqual([
			'deployment.md',
			'../src/lib/server/env.ts',
			'./testing.md'
		]);
	});

	it('reads backticked repository paths, dropping a line number', () => {
		expect(repoPaths(doc)).toEqual(['scripts/check-budgets.ts', 'src/lib/server/']);
	});

	it('reads the script of every pnpm command, in code spans and fences', () => {
		expect(pnpmCommands(doc)).toEqual(['test:unit', 'build:node', 'db:migrate', 'lighthouse']);
		expect(pnpmCommands('`pnpm 10` and `pnpm exec playwright test`')).toEqual(['exec']);
	});

	it('reads tables with their heading, escaped pipes kept in a cell', () => {
		const text =
			'## Variables\n\n| Variable | Purpose |\n| --- | --- |\n| `A_B` | one \\| two |\n| `C` | |\n\nprose';
		expect(tables(text)).toEqual([
			{
				heading: 'Variables',
				header: ['Variable', 'Purpose'],
				rows: [
					['`A_B`', 'one \\| two'],
					['`C`', '']
				]
			}
		]);
		expect(envNames('`A_B`, `C`, `lower`, `DB_`')).toEqual(['A_B', 'C']);
	});

	it('matches cited patterns: *, **, braces and <placeholders>', () => {
		const tree = memoryTree({
			'scripts/auth-setup-token.ts': '',
			'e2e/auth/signin.e2e.ts': '',
			'drizzle/meta/0001_snapshot.json': ''
		});
		expect(citedPathExists(tree, 'scripts/auth-*.ts')).toBe(true);
		expect(citedPathExists(tree, 'scripts/backup-*.ts')).toBe(false);
		expect(citedPathExists(tree, 'e2e/**/*.e2e.ts')).toBe(true);
		expect(citedPathExists(tree, 'drizzle/meta/<n>_snapshot.json')).toBe(true);
		expect(citedPathExists(tree, 'scripts/{auth,db}-setup-token.ts')).toBe(true);
		expect(citedPathExists(tree, 'scripts/')).toBe(true);
		expect(patternToRegExp('src/a.b/*.ts').test('src/aXb/c.ts')).toBe(false);
	});

	it('matches cited patterns on disk, in nested folders, and nothing for a pattern no file fits', () => {
		const tree = fsTree();
		expect(citedPathExists(tree, 'scripts/lib/docs-*.ts')).toBe(true);
		expect(citedPathExists(tree, 'src/**/docs-tree.ts')).toBe(false);
		expect(citedPathExists(tree, 'scripts/**/docs-tree.ts')).toBe(true);
		expect(citedPathExists(tree, 'e2e/**/*.e2e.ts')).toBe(true);
		expect(citedPathExists(tree, 'tests/integration/**/no-such-file-*.test.ts')).toBe(false);
		expect(citedPathExists(tree, 'no-such-folder/**/*.ts')).toBe(false);
	});
});
