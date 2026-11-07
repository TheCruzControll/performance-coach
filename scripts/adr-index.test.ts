/**
 * docs/adr/README.md indexes every ADR: each docs/adr/*.md has exactly one row there, linking to
 * it, with a status. A row links to an ADR that exists. An ADR still waiting for its number may be
 * named `NNNN-…` (#130 merged one); the docs slice of its milestone numbers it.
 *
 * Lenient until docs-m9: today's gaps are listed in scripts/docs-known-gaps.json.
 */
import { describe, expect, it } from 'vitest';
import { type Gap, isStrict, reconcile, tables } from './lib/docs-scan.ts';
import { type DocsTree, fsTree, knownGaps, memoryTree } from './lib/docs-tree.ts';

const TEST = 'adr-index';
const DOC = 'docs/adr/README.md';

/** The statuses an ADR row may start with (`Superseded by 0015` is Superseded). */
const ADR_STATUSES = ['Proposed', 'Accepted', 'Superseded', 'Deprecated'];
const ADR_FILE = /^(?:\d{4}|NNNN)-[a-z0-9-]+\.md$/;

function adrGaps(tree: DocsTree): Gap[] {
	const gap = (item: string): Gap => ({ test: TEST, doc: DOC, item });
	const adrs = tree
		.files('docs/adr')
		.map((file) => file.slice('docs/adr/'.length))
		.filter((name) => name.endsWith('.md') && name !== 'README.md' && !name.includes('/'));
	const rows = tables(tree.read(DOC) ?? '').flatMap((table) => {
		const status = table.header.findIndex((cell) => /^status$/i.test(cell));
		return table.rows.flatMap((row) => {
			const target = /\]\(\.?\/?([^)#\s]+)\)/.exec(row[0] ?? '')?.[1];
			return target ? [{ target, status: status === -1 ? '' : (row[status] ?? '') }] : [];
		});
	});
	const found: Gap[] = [];
	for (const name of adrs) {
		if (!ADR_FILE.test(name)) found.push(gap(`${name}: not named NNNN-title.md`));
		const own = rows.filter((row) => row.target === name);
		if (own.length !== 1) found.push(gap(`${name}: ${own.length} rows, expected 1`));
		for (const row of own) {
			const word = /^[*_]*([A-Za-z]+)/.exec(row.status)?.[1] ?? '';
			if (!ADR_STATUSES.includes(word)) found.push(gap(`${name}: status '${row.status}'`));
		}
	}
	for (const row of rows) {
		if (!adrs.includes(row.target)) found.push(gap(`row links to missing ${row.target}`));
	}
	return found;
}

const readme = (...rows: string[]) =>
	`# ADRs\n\n| # | Decision | Status |\n| --- | --- | --- |\n${rows.join('\n')}\n`;
const row = (file: string, status = 'Accepted') =>
	`| [${file.slice(0, 4)}](${file}) | x | ${status} |`;
const fixture = (files: string[], ...rows: string[]) =>
	memoryTree({
		[DOC]: readme(...rows),
		...Object.fromEntries(files.map((file) => [`docs/adr/${file}`, '# ADR']))
	});

describe('adr-index guard', () => {
	it('passes when every ADR has one row with a status, a placeholder number included', () => {
		const files = ['0001-one.md', '0002-two.md', 'NNNN-pending.md'];
		expect(
			adrGaps(
				fixture(
					files,
					row(files[0]!),
					row(files[1]!, 'Superseded by 0003'),
					row(files[2]!, 'Proposed')
				)
			)
		).toEqual([]);
	});

	it('finds an ADR without a row', () => {
		expect(adrGaps(fixture(['0001-one.md', '0002-two.md'], row('0001-one.md')))).toEqual([
			{ test: TEST, doc: DOC, item: '0002-two.md: 0 rows, expected 1' }
		]);
	});

	it('finds a duplicated row, a row without a known status and a row for a missing ADR', () => {
		expect(
			adrGaps(
				fixture(
					['0001-one.md', '0002-two.md'],
					row('0001-one.md'),
					row('0001-one.md'),
					row('0002-two.md', 'Draft'),
					row('0003-gone.md')
				)
			).map((found) => found.item)
		).toEqual([
			'0001-one.md: 2 rows, expected 1',
			"0002-two.md: status 'Draft'",
			'row links to missing 0003-gone.md'
		]);
	});

	it('finds an ADR that is not named after its number', () => {
		expect(adrGaps(fixture(['trend.md'], row('trend.md'))).map((found) => found.item)).toEqual([
			'trend.md: not named NNNN-title.md'
		]);
	});

	it('has no gap in the repository beyond the known-gaps list, and every listed gap still holds', () => {
		expect(reconcile(TEST, adrGaps(fsTree()), knownGaps(), isStrict(process.env))).toEqual([]);
	});
});
