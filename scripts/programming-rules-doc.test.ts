/**
 * The programming rules reference is the registry's (scripts/programming-rules-doc.ts): the
 * committed docs/programming-rules.md equals a fresh render, every export of rules/ is a
 * registered rule or a listed non-rule, and every rule key the programming code and its plans cite
 * resolves to an active rule.
 *
 * `pnpm docs:rules` runs this file with PROGRAMMING_RULES_DOC=write: it writes the doc instead of
 * comparing it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildRegistry, RULES } from '../src/lib/domain/programming/rules/registry/index.ts';
import { RULE_AREAS } from '../src/lib/domain/programming/rules/registry/types.ts';
import type { RuleDefinition } from '../src/lib/domain/programming/rules/registry/types.ts';
import {
	absolute,
	AREA_TITLE,
	renderRulesDoc,
	RULES_DOC,
	SECTIONS,
	valuesJson
} from './programming-rules-doc.ts';
import { CATALOGUE } from '../src/lib/domain/exercises/index.ts';
import { buildProgrammingInput, generateProgram } from '../src/lib/domain/programming/index.ts';
import { M7_SCENARIOS } from '../src/lib/domain/programming/periodisation/scenarios.ts';
import { SCENARIO_START } from '../src/lib/domain/programming/scenarios.ts';
import { citedRuleKeys } from './rule-keys.ts';

const WRITE = process.env.PROGRAMMING_RULES_DOC === 'write';
const read = (file: string) => readFileSync(absolute(file), 'utf8');

const RULES_DIR = 'src/lib/domain/programming/rules/';
/** Every module of rules/ (the registry and tests aside), loaded for its exports. */
const MODULES = import.meta.glob(
	['/src/lib/domain/programming/rules/*.ts', '!/src/lib/domain/programming/rules/*.test.ts'],
	{ eager: true }
);

/**
 * Exports of rules/ that are not rules, each with the reason: ids, vocabularies, re-exports, and
 * functions that apply a registered constant. Anything else exported there must be registered.
 */
const NOT_RULES: Readonly<Record<string, string>> = {
	'added.ts#DEFAULT_INTENT': 're-exported from training/edits.ts, where the coach reads it',
	'concurrent.ts#CUTBACK_KIND': 'a week kind, the vocabulary concurrent.recovery_week_limits reads',
	'concurrent.ts#SEPARATION_MODERATE_SEVERITY':
		'the severity when only one of two same-day sessions is hard, which concurrent.same_day_separation’s prose states',
	'days.ts#doubleTime': 'applies days.doubles and days.other_end_of_day',
	'defaults.ts#defaultCommitmentMinutes': 'applies the defaults.* commitment minutes',
	'defaults.ts#assumptionFacts': 'the words of a default_assumed decision',
	'evaluation.ts#EVALUATION_ID': 'a version id, part of every fingerprint',
	'fatigue.ts#FATIGUE_LEVELS': 'vocabulary: fresh, elevated, overloaded',
	'maintenance.ts#lowerHalf': 'arithmetic the maintenance doses apply',
	'paces.ts#PACE_INTENSITIES': 'vocabulary: Daniels’ five intensities',
	'replan.ts#mechanismOf':
		'maps a directive to replan.regenerate, replan.splice or replan.in_place',
	'replan.ts#REPLAN_GENERATOR_ID': 'a version id, part of every re-plan fingerprint',
	'season.ts#taperOnlyUnder': 'applies season.window',
	'strength.ts#isAccessory': 'the accessory test strength and time fit apply',
	'strength-phases.ts#MEET_PHASES': 'vocabulary: the meet sequence’s phase names, in order'
};

/** Exports outside rules/ the registry must name too (the m7 plan's drift list). */
const ALSO_NAMED = [
	'src/lib/domain/programming/interference.ts#INTERFERENCE',
	'src/lib/domain/programming/interference.ts#INTERFERENCE_RULES',
	'src/lib/domain/programming/placement.ts#PLACEMENT',
	'src/lib/domain/programming/avoidance.ts#INJURY_EXCLUSIONS',
	'src/lib/domain/programming/avoidance.ts#AVOID_PHRASES',
	'src/lib/domain/programming/eligibility.ts#EQUIPMENT_NEEDED',
	'src/lib/domain/programming/alternatives.ts#RELATED_PATTERNS',
	'src/lib/domain/programming/review/next-week.ts#DELOAD',
	'src/lib/domain/programming/review/next-week.ts#LIGHT_WEEK_KINDS',
	'src/lib/domain/programming/review/next-week.ts#MAX_NEXT_WEEK_OPS',
	'src/lib/domain/programming/review/next-week.ts#MOVE_SEVERITY',
	'src/lib/domain/programming/review/next-week.ts#SESSIONS_A_DAY'
];

/** What the registry names: 'path#EXPORT', the first part of each entry's source. */
const NAMED = new Set(
	RULES.map(({ source }) => {
		const [file, name = ''] = source.split('#');
		return `${file}#${name.split('.')[0]}`;
	})
);

/** Every programming path whose code cites a rule key: M3, M4, M6 and M7, and their services. */
const SOURCES = [
	'src/lib/domain/programming/**/*.ts',
	'src/lib/domain/workout/**/*.ts',
	'src/lib/server/services/programs/**/*.ts',
	'src/lib/server/services/reviews/**/*.ts',
	'src/lib/server/services/periodisation/**/*.ts',
	'src/lib/server/services/programming/**/*.ts',
	'src/lib/server/services/coach/apply/**/*.ts'
];

describe.skipIf(WRITE)('the committed rules reference', () => {
	it('docs/programming-rules.md equals a fresh render of the registry', async () => {
		expect(read(RULES_DOC), 'run `pnpm docs:rules` and commit the result').toBe(
			await renderRulesDoc(RULES)
		);
	});

	it('places every area once, in registry order, in a section of its own, none empty', () => {
		expect(SECTIONS.flatMap((section) => section.areas)).toEqual([...RULE_AREAS]);
		expect(Object.keys(AREA_TITLE)).toEqual([...RULE_AREAS]);
		for (const area of RULE_AREAS)
			expect(RULES.filter((rule) => rule.area === area).length, area).toBeGreaterThan(0);
	});

	it('lists each rule once, by its id, with a why', async () => {
		const doc = read(RULES_DOC);
		for (const rule of RULES) {
			expect(doc.split(`#### \`${rule.id}\`\n`).length - 1, rule.id).toBe(1);
			expect(rule.rationale.trim(), rule.id).not.toBe('');
		}
	});
});

describe.skipIf(WRITE)('the drift list', () => {
	it('every export of rules/ is a registered rule or a listed non-rule', () => {
		const unnamed: string[] = [];
		for (const [path, module] of Object.entries(MODULES)) {
			const file = path.slice(1);
			for (const name of Object.keys(module as object)) {
				const id = `${file.slice(RULES_DIR.length)}#${name}`;
				if (!NAMED.has(`${file}#${name}`) && !(id in NOT_RULES)) unnamed.push(id);
			}
		}
		expect(unnamed, 'register each in its area file, or list it in NOT_RULES with why').toEqual([]);
	});

	it('lists no non-rule that is gone or registered', () => {
		for (const id of Object.keys(NOT_RULES)) {
			const [file, name] = id.split('#') as [string, string];
			const module = MODULES[`/${RULES_DIR}${file}`] as Record<string, unknown> | undefined;
			expect(module && name in module, `${id} is no longer exported`).toBe(true);
			expect(NAMED.has(`${RULES_DIR}${id}`), `${id} is registered`).toBe(false);
		}
	});

	it('names the constants outside rules/ that the m7 plan lists', () => {
		expect(ALSO_NAMED.filter((source) => !NAMED.has(source))).toEqual([]);
	});
});

describe.skipIf(WRITE)('every cited rule key', () => {
	let cited: Set<string>;
	// Scanning every programming path builds a TypeScript program: seconds, not milliseconds.
	beforeAll(() => {
		// M7's scenario plans, from the scenario start: citedRuleKeys adds M3's seven itself.
		const start = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
		const decisions = Object.values(M7_SCENARIOS).flatMap(
			(profile) =>
				generateProgram(buildProgrammingInput(profile(), { catalogue: CATALOGUE }), start).decisions
		);
		cited = citedRuleKeys(SOURCES, decisions);
	}, 180_000);

	it('resolves to an active rule', () => {
		const active = new Set(RULES.filter((r) => r.status === 'active').map((r) => r.id));
		expect(cited.size).toBeGreaterThan(150);
		expect([...cited].filter((key) => !active.has(key))).toEqual([]);
	});
});

describe('the render', () => {
	const rule = (over: Partial<RuleDefinition>) =>
		({
			id: 'test.rule',
			kind: 'constant',
			statement: 'A rule stated in a sentence.',
			rationale: 'A reason the owner can check.',
			source: 'src/lib/domain/programming/rules/load.ts#DEFAULT_RPE',
			values: 6,
			...over
		}) as RuleDefinition;

	it('a changed value changes the doc, and a superseded rule names its replacement', async () => {
		const registry = (values: unknown, supersedes?: Record<string, string>) =>
			buildRegistry({
				m3: { rules: [rule({ values })] },
				m6: {
					rules: [rule({ id: 'test.newer', kind: 'behaviour', source: 'x.ts#f' } as never)],
					...(supersedes && { supersedes })
				}
			});
		const before = await renderRulesDoc(registry(6));
		expect(await renderRulesDoc(registry(7))).not.toBe(before);
		const superseded = await renderRulesDoc(registry(6, { 'test.rule': 'test.newer' }));
		expect(superseded).toContain('#### Superseded');
		expect(superseded).toContain('- **Superseded by:** `test.newer`');
		expect(superseded).toContain('- **Applied by:** `f` in `x.ts`');
	});

	it('prints Infinity as itself, and refuses a value JSON would drop', () => {
		expect(
			valuesJson(
				[
					[3, 'a'],
					[Infinity, 'b']
				],
				'x'
			)
		).toBe('[[3,"a"],[Infinity,"b"]]');
		expect(() => valuesJson({ f: () => 1 }, 'x')).toThrow('x.f: the reference cannot print');
		expect(() => valuesJson(new Set([1]), 'x')).toThrow('cannot print a Set');
		expect(() => valuesJson([undefined], 'x')).toThrow('x[0]');
	});
});

describe.runIf(WRITE)('pnpm docs:rules', () => {
	it('writes docs/programming-rules.md', async () => {
		const doc = await renderRulesDoc(RULES);
		writeFileSync(absolute(RULES_DOC), doc);
		expect(read(RULES_DOC)).toBe(doc);
	});
});
