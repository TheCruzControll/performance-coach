/**
 * The programming rules reference, generated from the rules registry so it cannot drift from the
 * code (m7/58 rules-reference):
 *
 *   pnpm docs:rules
 *
 * It writes docs/programming-rules.md, the whole file, from RULES
 * (src/lib/domain/programming/rules/registry/index.ts): one section per group of areas, one
 * subsection per area in RULE_AREAS order, and per rule its id, statement, rationale, severity,
 * status and source; a constant's live values as JSON, a behaviour's function. A superseded rule
 * sits in its area's Superseded list, naming the rule that replaced it. A value JSON cannot print
 * exactly (a function, a Map or Set, a non-finite number, undefined) throws, so nothing in a
 * constant is left out. scripts/programming-rules-doc.test.ts fails when the file is stale.
 *
 * The registry's modules import each other extensionless, which plain node cannot resolve, so
 * `pnpm docs:rules` runs the test file in write mode (PROGRAMMING_RULES_DOC=write) through Vitest,
 * as `pnpm docs:coach-tools` does.
 */
import { format, resolveConfig } from 'prettier';
import { fileURLToPath } from 'node:url';
import type { RuleArea, RuleEntry } from '../src/lib/domain/programming/rules/registry/types.ts';

export const RULES_DOC = 'docs/programming-rules.md';
const REGISTRY = 'src/lib/domain/programming/rules/registry/';

/** A repository-relative path, resolved from this script (whatever the working directory). */
export const absolute = (file: string) => fileURLToPath(new URL(`../${file}`, import.meta.url));

/** The doc's sections, in order: each area once, in RULE_AREAS order (the test checks both). */
export const SECTIONS: readonly { title: string; areas: readonly RuleArea[] }[] = [
	{ title: 'Interference and evaluation', areas: ['interference', 'evaluation'] },
	{ title: 'Load and fatigue', areas: ['load', 'fatigue'] },
	{ title: 'Concurrent training and the schedule', areas: ['concurrent', 'schedule'] },
	{ title: 'Priority and maintenance', areas: ['priority', 'maintenance'] },
	{ title: 'Season and road', areas: ['season', 'road'] },
	{
		title: 'Block types, deload and taper',
		areas: ['strength-phases', 'hypertrophy', 'endurance', 'fight-camp', 'deload', 'taper']
	},
	{ title: 'Paces and heart rate', areas: ['paces'] },
	{ title: 'The generator, re-plans and week targets', areas: ['generator', 'replan', 'targets'] },
	{ title: 'First block, pain and reviews (M3, M4, M6)', areas: ['m3', 'm4', 'm6'] }
];

/** Each area's heading. */
export const AREA_TITLE: Readonly<Record<RuleArea, string>> = {
	interference: 'Interference',
	evaluation: 'Week evaluation',
	load: 'Load',
	fatigue: 'Fatigue',
	concurrent: 'Concurrent training',
	schedule: 'Week schedule',
	priority: 'Goal priority',
	maintenance: 'Maintenance doses',
	season: 'Season windows',
	road: 'The road ahead',
	'strength-phases': 'Strength phases',
	hypertrophy: 'Hypertrophy blocks',
	endurance: 'Endurance blocks',
	'fight-camp': 'Fight camps',
	deload: 'Deloads',
	taper: 'Tapers',
	paces: 'Paces and heart-rate zones',
	generator: 'The generator',
	replan: 'Re-plans',
	targets: 'Week targets',
	m3: 'M3: the first block and added sessions',
	m4: 'M4: pain and quick actions',
	m6: 'M6: results, reviews and next blocks'
};

/** Inline prose: one line, with nothing markdown would read as markup. */
const prose = (text: string) =>
	text
		.replace(/\s*\n\s*/g, ' ')
		.replace(/([\\`*_[\]<>|])/g, '\\$1')
		.trim();
const code = (text: string) => `\`${text}\``;

/** `value` as JSON, refusing anything JSON would drop or change. */
export function valuesJson(value: unknown, at: string): string {
	const walk = (node: unknown, path: string): void => {
		if (node === undefined || typeof node === 'function' || typeof node === 'symbol')
			throw new Error(`${path}: the reference cannot print ${typeof node}`);
		if (typeof node === 'bigint') throw new Error(`${path}: the reference cannot print bigint`);
		if (Number.isNaN(node)) throw new Error(`${path}: the reference cannot print NaN`);
		if (typeof node !== 'object' || node === null) return;
		if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}[${i}]`));
		if (node instanceof RegExp) return;
		if (Object.getPrototypeOf(node) !== Object.prototype)
			throw new Error(`${path}: the reference cannot print a ${node.constructor.name}`);
		for (const [key, item] of Object.entries(node)) walk(item, `${path}.${key}`);
	};
	walk(value, at);
	// JSON has no Infinity: a bound with no top (strength.ts's last row) prints as the bare word.
	// A pattern prints as its /source/flags string.
	const INFINITY = '\u0000Infinity';
	return JSON.stringify(value, (_, item: unknown) =>
		item === Infinity
			? INFINITY
			: item === -Infinity
				? `-${INFINITY}`
				: item instanceof RegExp
					? String(item)
					: item
	).replace(/"(-?)\\u0000Infinity"/g, '$1Infinity');
}

/** 'path#NAME' as "`NAME` in `path`", so the docs guard can check the path. */
function where(source: string): string {
	const [file = '', name = ''] = source.split('#');
	return `${code(name)} in ${code(file)}`;
}

function ruleBlock(rule: RuleEntry): string {
	const facts = [
		`- **Why:** ${prose(rule.rationale)}`,
		...(rule.severity ? [`- **Severity:** ${rule.severity}`] : []),
		`- **${rule.kind === 'constant' ? 'Source' : 'Applied by'}:** ${where(rule.source)}`,
		...(rule.supersededBy ? [`- **Superseded by:** ${code(rule.supersededBy)}`] : [])
	];
	return [
		`#### ${code(rule.id)}`,
		'',
		prose(rule.statement),
		'',
		...facts,
		...(rule.kind === 'constant' ? ['', '```json', valuesJson(rule.values, rule.id), '```'] : [])
	].join('\n');
}

function areaBlock(area: RuleArea, rules: readonly RuleEntry[]): string[] {
	const active = rules.filter((rule) => rule.status === 'active');
	const superseded = rules.filter((rule) => rule.status === 'superseded');
	return [
		`### ${AREA_TITLE[area]}`,
		'',
		`${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}, from ${code(`${REGISTRY}${area}.ts`)}.`,
		'',
		...active.flatMap((rule) => [ruleBlock(rule), '']),
		...(superseded.length
			? ['#### Superseded', '', ...superseded.flatMap((rule) => [ruleBlock(rule), ''])]
			: [])
	];
}

const slug = (title: string) =>
	title
		.toLowerCase()
		.replace(/[^a-z0-9 -]/g, '')
		.replace(/ /g, '-');

async function formatted(source: string): Promise<string> {
	const path = absolute(RULES_DOC);
	return format(source, { ...(await resolveConfig(path)), filepath: path });
}

/** docs/programming-rules.md, whole. */
export async function renderRulesDoc(rules: readonly RuleEntry[]): Promise<string> {
	const of = (area: RuleArea) => rules.filter((rule) => rule.area === area);
	const constants = rules.filter((rule) => rule.kind === 'constant').length;
	const superseded = rules.filter((rule) => rule.status === 'superseded').length;
	const source = [
		'# Programming rules',
		'',
		'Generated by `pnpm docs:rules` from the rules registry',
		'(`src/lib/domain/programming/rules/registry/index.ts`): do not edit this file by hand. Each',
		'rule is listed by the key the decisions cite, with what it does, why, and where it lives. A',
		'constant rule shows its values, read from the live constant, so a number changed in the code',
		'changes here; a behaviour rule names the function that applies it.',
		'',
		`${rules.length} rules: ${constants} constants and ${rules.length - constants} behaviours, ${superseded} superseded.`,
		'',
		...SECTIONS.map(
			({ title, areas }) =>
				`- [${title}](#${slug(title)}): ${areas.map((area) => `${AREA_TITLE[area]} (${of(area).length})`).join(', ')}`
		),
		'',
		...SECTIONS.flatMap(({ title, areas }) => [
			`## ${title}`,
			'',
			...areas.flatMap((area) => areaBlock(area, of(area)))
		])
	].join('\n');
	return formatted(source);
}
