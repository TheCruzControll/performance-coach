/**
 * PRD §17's two final deliverables, the Performance Report and the Design Report
 * (docs/reports/), are skeletons the tech lead fills with the councils' results. This guard keeps
 * every §17 section and every reviewer in them, so a section cannot be dropped while it is
 * filled, and a score can only be a 0–10 number or say why it is missing.
 *
 * REPORTS is the one place that names the sections and the reviewers. If a council renames a
 * role, change it here and in the report's table, nowhere else.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Report = {
	file: string;
	/** Every `## ` heading, in this order. Further headings may sit between them. */
	sections: readonly string[];
	/** The council's reviewers: exactly one row each in the scores table, in this order. */
	reviewers: readonly string[];
	/** Further tables whose first column must list exactly these rows: heading → rows. */
	rows?: Readonly<Record<string, readonly string[]>>;
};

const SCORES = 'Scores by reviewer and round';

const REPORTS = {
	performance: {
		file: 'docs/reports/performance-report.md',
		sections: [
			'Verdict',
			'Method',
			SCORES,
			'Lab measurements per route',
			'Workout interactions',
			'Real-user monitoring',
			'Server timing and query plans',
			'Optimisations',
			'Remaining bottlenecks',
			'Browser and device matrix',
			'How to reproduce',
			'Sources'
		],
		reviewers: [
			'Frontend Performance Engineer',
			'Backend Performance Engineer',
			'Mobile Performance Specialist',
			'Performance & Reliability Engineer',
			'Independent Technical Reviewer'
		]
	},
	design: {
		file: 'docs/reports/design-report.md',
		sections: [
			'Verdict',
			'Method',
			SCORES,
			'Screens and workflows evaluated',
			'Improvements',
			'Remaining usability issues',
			'Mobile assessment',
			'Desktop assessment',
			'Accessibility',
			'Sign-off',
			'Sources'
		],
		reviewers: [
			'Senior Product Designer',
			'Visual Design Specialist',
			'Mobile UX Specialist',
			'Interaction Designer',
			'Independent Design Critic'
		],
		rows: {
			// PRD §16's workout-specific questions.
			'Mobile assessment': [
				'Next exercise understood at a glance',
				'One-handed set logging',
				'Rest timer visibility',
				'Previous performance',
				'Substitution speed',
				'Interrupted workout',
				'Information density: workout vs analytics'
			]
		}
	}
} as const satisfies Record<string, Report>;

const README = 'docs/reports/README.md';

/** The `## ` headings of a markdown document, in order, outside fenced code. */
function sectionsOf(markdown: string): string[] {
	const headings: string[] = [];
	let fenced = false;
	for (const line of markdown.split('\n')) {
		if (line.startsWith('```')) fenced = !fenced;
		else if (!fenced && line.startsWith('## ')) headings.push(line.slice(3).trim());
	}
	return headings;
}

/** The body of one `## ` section, up to the next `## ` heading. */
function sectionBody(markdown: string, heading: string): string | undefined {
	const lines = markdown.split('\n');
	const start = lines.findIndex((line) => line === `## ${heading}`);
	if (start === -1) return undefined;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => line.startsWith('## '));
	return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** The cells of the first table in a section's body, header and divider rows excluded. */
function tableRows(body: string): string[][] {
	const table: string[] = [];
	for (const line of body.split('\n')) {
		if (line.trimStart().startsWith('|')) table.push(line.trim());
		else if (table.length > 0) break;
	}
	return table.slice(2).map((row) =>
		row
			.replace(/^\||\|$/g, '')
			.split('|')
			.map((cell) => cell.trim())
	);
}

/** A first-column label without its emphasis. */
const label = (cell: string | undefined) => (cell ?? '').replace(/\*\*/g, '').trim();

/**
 * A score cell, per docs/reports/README.md: still `pending (S1)`, `not run` with a reason, or a
 * 0–10 score with at most one decimal (a note after it is allowed).
 */
const SCORE_CELL = /^(?:pending \(S\d+\)|not run\b.*|(?:10|\d)(?:\.\d)?(?:\s.*)?)$/;

const read = (file: string) => readFileSync(file, 'utf8');

describe.each(Object.entries(REPORTS))('the %s report', (_name, report: Report) => {
	it('exists', () => {
		expect(existsSync(report.file), report.file).toBe(true);
	});

	it('has every required section, in order', () => {
		const present = sectionsOf(read(report.file));
		expect(present.filter((heading) => report.sections.includes(heading))).toEqual(report.sections);
	});

	it('has exactly one scores row per reviewer', () => {
		const body = sectionBody(read(report.file), SCORES);
		expect(body, `## ${SCORES}`).toBeDefined();
		const rows = tableRows(body!);
		expect(rows.map((row) => label(row[0]))).toEqual(report.reviewers);
	});

	it('holds only pending, not-run or 0–10 scores in the round columns', () => {
		const body = sectionBody(read(report.file), SCORES)!;
		const rows = tableRows(body);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			// Reviewer, then one column per round and the final score, then the evidence column.
			const scores = row.slice(1, -1);
			expect(scores.length, label(row[0])).toBeGreaterThanOrEqual(2);
			for (const cell of scores) expect(cell, `${label(row[0])}: ${cell}`).toMatch(SCORE_CELL);
		}
	});
});

const REQUIRED_ROWS = Object.values(REPORTS as Record<string, Report>).flatMap((report) =>
	Object.entries(report.rows ?? {}).map(([heading, rows]) => ({ file: report.file, heading, rows }))
);

describe.each(REQUIRED_ROWS)('$file, ## $heading', ({ file, heading, rows }) => {
	it('lists exactly the required rows', () => {
		const body = sectionBody(read(file), heading);
		expect(body, `## ${heading}`).toBeDefined();
		expect(tableRows(body!).map((row) => label(row[0]))).toEqual(rows);
	});
});

describe('the reports README', () => {
	it('links both reports', () => {
		const text = read(README);
		for (const report of Object.values(REPORTS)) {
			expect(text).toContain(`](${report.file.replace('docs/reports/', './')})`);
		}
	});
});

describe('the markdown helpers', () => {
	it('read headings outside code fences only', () => {
		expect(sectionsOf('# T\n\n## A\n\n```md\n## not a heading\n```\n\n## B\n')).toEqual(['A', 'B']);
	});

	it('read the first table of a section, without its header and divider', () => {
		const body =
			'Intro.\n\n| Who | R1 |\n| --- | --- |\n| **A** | 7 |\n| B | pending (S1) |\n\nAfter.';
		expect(tableRows(body)).toEqual([
			['**A**', '7'],
			['B', 'pending (S1)']
		]);
	});

	it('accept only the documented score cells', () => {
		for (const ok of ['pending (S1)', 'not run (stopped after round 2)', '7', '8.5', '10', '9 r3'])
			expect(ok).toMatch(SCORE_CELL);
		for (const bad of ['', 'TBD', '11', '7.25', '-1', 'pending', 'great'])
			expect(bad).not.toMatch(SCORE_CELL);
	});
});
