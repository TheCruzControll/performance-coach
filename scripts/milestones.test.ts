/**
 * docs/milestones.md keeps its shape: every row of the status table has a status, and every
 * milestone section (`## M<n> — …`) lists numbered acceptance criteria. Strict mode (docs-m9,
 * once every milestone is done) also asks for what a finished project has: a PR link on every
 * done milestone, and evidence on every M9 criterion.
 *
 * Lenient until docs-m9: today's gaps are listed in scripts/docs-known-gaps.json.
 */
import { describe, expect, it } from 'vitest';
import { type Gap, isStrict, reconcile, splitFences, tables } from './lib/docs-scan.ts';
import { type DocsTree, fsTree, knownGaps, memoryTree } from './lib/docs-tree.ts';

const TEST = 'milestones';
const DOC = 'docs/milestones.md';

/** A PR reference: `#123`, or a link to a pull request. */
const PR_LINK = /(?<![\w&])#\d+\b|\/pull\/\d+/;
/** Evidence on a criterion: a PR, a link, or an `Evidence:` note. */
const EVIDENCE = new RegExp(`${PR_LINK.source}|\\]\\(|\\bEvidence\\b`, 'i');

/** Each `## M<n>` section's numbered acceptance criteria, as one string per criterion. */
function criteriaBySection(text: string): Map<string, string[]> {
	const sections = new Map<string, string[]>();
	let current: string | null = null;
	let inCriteria = false;
	for (const line of splitFences(text).prose.split('\n')) {
		const heading = /^##\s+(M\d+)\b/.exec(line);
		if (heading || /^##\s/.test(line)) {
			current = heading?.[1] ?? null;
			inCriteria = false;
			if (current) sections.set(current, []);
			continue;
		}
		if (!current) continue;
		const criteria = sections.get(current)!;
		if (/^Acceptance criteria:?\s*$/i.test(line.trim())) inCriteria = true;
		else if (inCriteria && /^\d+\.\s/.test(line)) criteria.push(line);
		else if (inCriteria && /^\s+\S/.test(line) && criteria.length > 0) {
			criteria[criteria.length - 1] += ` ${line.trim()}`;
		} else if (inCriteria && criteria.length > 0 && line.trim() !== '') inCriteria = false;
	}
	return sections;
}

function milestoneGaps(tree: DocsTree, strict: boolean): Gap[] {
	const text = tree.read(DOC) ?? '';
	const gap = (item: string): Gap => ({ test: TEST, doc: DOC, item });
	const found: Gap[] = [];
	const table = tables(text).find(
		(t) => t.header.includes('Milestone') && t.header.includes('Status')
	);
	if (!table) return [gap('no status table')];
	const status = table.header.indexOf('Status');
	for (const row of table.rows) {
		const value = (row[status] ?? '').replace(/[*_]/g, '').trim();
		if (!value) found.push(gap(`${row[0]}: no status`));
		else if (strict && /^done\b/i.test(value) && !PR_LINK.test(value)) {
			found.push(gap(`${row[0]}: done without a PR link`));
		}
	}
	const sections = criteriaBySection(text);
	for (const [milestone, criteria] of sections) {
		if (criteria.length === 0) found.push(gap(`${milestone}: no numbered acceptance criteria`));
	}
	if (strict) {
		(sections.get('M9') ?? []).forEach((criterion, index) => {
			if (!EVIDENCE.test(criterion)) found.push(gap(`M9 criterion ${index + 1}: no evidence`));
		});
	}
	return found;
}

const doc = (rows: string, ...sections: string[]) =>
	`# Milestones\n\n| # | Milestone | Status |\n| --- | --- | --- |\n${rows}\n\n---\n\n${sections.join('\n\n')}\n`;
const section = (id: string, ...criteria: string[]) =>
	`## ${id} — Something [§1]\n\n- scope\n\nAcceptance criteria:\n\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`;
const tree = (text: string) => memoryTree({ [DOC]: text });
const items = (text: string, strict = false) =>
	milestoneGaps(tree(text), strict).map((found) => found.item);

describe('milestones guard', () => {
	const rows = '| M1 | One | **Done** (PR #1) |\n| M9 | Release | Planned |';

	it('passes a table with statuses and sections with numbered criteria', () => {
		const text = doc(rows, section('M1', 'a', 'b'), section('M9', 'x\n   continued (#300)'));
		expect(items(text)).toEqual([]);
		expect(items(text, true)).toEqual([]);
	});

	it('finds a row without a status and a section without numbered criteria', () => {
		const text = doc(
			'| M1 | One | **Done** (PR #1) |\n| M2 | Two | |',
			section('M1', 'a'),
			'## M2 — Two\n\n- scope only'
		);
		expect(items(text)).toEqual(['M2: no status', 'M2: no numbered acceptance criteria']);
	});

	it('asks for PR links and M9 evidence only when strict', () => {
		const text = doc(
			'| M1 | One | **Done** (merged) |',
			section('M1', 'a'),
			section('M9', 'x (#300)', 'y')
		);
		expect(items(text)).toEqual([]);
		expect(items(text, true)).toEqual([
			'M1: done without a PR link',
			'M9 criterion 2: no evidence'
		]);
	});

	it('reads the real milestones: nine rows and a section with criteria for each', () => {
		const text = fsTree().read(DOC)!;
		const sections = criteriaBySection(text);
		expect([...sections.keys()]).toEqual(expect.arrayContaining(['M1', 'M4', 'M9']));
		expect(sections.get('M1')!.length).toBeGreaterThanOrEqual(10);
		expect(sections.get('M1')![0]).toMatch(
			/^1\. `pnpm install --frozen-lockfile` succeeds .* report 0 errors\.$/
		);
	});

	it('has no gap in the repository beyond the known-gaps list, and every listed gap still holds', () => {
		const strict = isStrict(process.env);
		expect(reconcile(TEST, milestoneGaps(fsTree(), strict), knownGaps(), strict)).toEqual([]);
	});
});
