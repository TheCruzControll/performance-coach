import { describe, expect, it } from 'vitest';
import { BLOCKS_EDIT, INTERFERENCE, INTERFERENCE_RULES } from '../../interference';
import { PLACEMENT } from '../../placement';
import { AREAS, buildRegistry, RULE_BY_ID, RULES } from './index';
import { RULE_AREAS } from './types';
import type { RuleArea, RuleAreaModule, RuleDefinition, RuleEntry } from './types';

/** Every source module, loaded only when an entry names it. */
const MODULES = import.meta.glob(['/src/lib/**/*.ts', '!/src/lib/**/*.test.ts']);

/** What a source names: { found: false } for a missing file or export. */
async function resolve(source: string): Promise<{ found: boolean; value?: unknown }> {
	const [file, name = ''] = source.split('#');
	const load = MODULES[`/${file}`];
	if (!load) return { found: false };
	const [exported = '', ...keys] = name.split('.');
	let value: unknown = await load();
	for (const key of [exported, ...keys]) {
		if (typeof value !== 'object' || value === null || !(key in value)) return { found: false };
		value = (value as Record<string, unknown>)[key];
	}
	return { found: true, value };
}

/** What is wrong with an entry; empty when its source and values hold. */
async function problemsOf(entry: RuleDefinition): Promise<string[]> {
	const problems: string[] = [];
	if (entry.statement.trim().length < 20) problems.push('a short statement');
	if (entry.rationale.trim().length < 20) problems.push('a short rationale');
	const { found, value } = await resolve(entry.source);
	if (!found) return [...problems, 'a source that does not exist'];
	if (entry.kind === 'constant' && entry.values !== value)
		problems.push('values not the live constant');
	if (entry.kind === 'behaviour') {
		if (typeof value !== 'function') problems.push('a behaviour that is not a function');
		if ('values' in entry) problems.push('a behaviour with values');
	}
	return problems;
}

const FILE = 'src/lib/domain/programming/interference.ts';
const entry = (over: Partial<RuleDefinition>) =>
	({
		id: 'test.rule',
		kind: 'behaviour',
		statement: 'A rule stated in a sentence.',
		rationale: 'A reason the owner can check.',
		source: `${FILE}#checkWeek`,
		...over
	}) as RuleDefinition;

describe('the rules registry', () => {
	it('has one file per area, and every entry carries its own file’s area', () => {
		expect(Object.keys(AREAS)).toEqual([...RULE_AREAS]);
		for (const [area, { rules }] of Object.entries(AREAS)) {
			for (const rule of rules) expect(RULE_BY_ID.get(rule.id)?.area, rule.id).toBe(area);
		}
	});

	it('registers each id once, as a dotted snake_case rule key', () => {
		const ids = RULES.map((rule) => rule.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/);
		expect(RULES.length).toBeGreaterThan(0);
	});

	it.each(RULES.map((rule) => [rule.id, rule] as const))(
		'%s: its source exists, its values are live, and it is stated and explained',
		async (_, rule) => {
			expect(await problemsOf(rule)).toEqual([]);
			if (rule.status === 'superseded') expect(RULE_BY_ID.has(rule.supersededBy!)).toBe(true);
		}
	);

	it('catches a missing export, copied values, a behaviour that is not a function or has values', async () => {
		expect(await problemsOf(entry({}))).toEqual([]);
		expect(await problemsOf(entry({ source: `${FILE}#checkWeekly` }))).toEqual([
			'a source that does not exist'
		]);
		expect(await problemsOf(entry({ source: 'src/lib/nowhere.ts#x' }))).toEqual([
			'a source that does not exist'
		]);
		const copied = {
			kind: 'constant',
			source: `${FILE}#INTERFERENCE`,
			values: { ...INTERFERENCE }
		};
		expect(await problemsOf(entry(copied as never))).toEqual(['values not the live constant']);
		expect(await problemsOf(entry({ source: `${FILE}#INTERFERENCE` }))).toEqual([
			'a behaviour that is not a function'
		]);
		expect(await problemsOf(entry({ values: 1 } as never))).toEqual(['a behaviour with values']);
		expect(await problemsOf(entry({ statement: 'Short.', rationale: ' ' }))).toEqual([
			'a short statement',
			'a short rationale'
		]);
	});

	it("holds M3's interference rules with their rationale, severity and live values", () => {
		for (const [rule, data] of Object.entries(INTERFERENCE_RULES)) {
			const registered = RULE_BY_ID.get(`placement.${rule}`);
			expect(registered, rule).toMatchObject({
				area: 'interference',
				kind: 'constant',
				status: 'active',
				severity: data.severity,
				rationale: data.why,
				source: `${FILE}#INTERFERENCE_RULES.${rule}`
			});
			expect(registered?.kind === 'constant' && registered.values, rule).toBe(data);
		}
		const live = (id: string) => {
			const rule = RULE_BY_ID.get(id);
			return rule?.kind === 'constant' ? rule.values : undefined;
		};
		expect(live('interference.thresholds')).toBe(INTERFERENCE);
		expect(live('interference.blocks_edit')).toBe(BLOCKS_EDIT);
		expect(live('placement.order')).toBe(PLACEMENT);
	});
});

describe('buildRegistry', () => {
	const old = entry({
		id: 'old.rule',
		kind: 'constant',
		source: `${FILE}#BLOCKS_EDIT`,
		values: BLOCKS_EDIT
	} as never);
	const replacement = entry({ id: 'new.rule' });
	const areas = (
		supersedes?: Record<string, string>
	): Partial<Record<RuleArea, RuleAreaModule>> => ({
		m3: { rules: [old] },
		generator: { rules: [replacement], ...(supersedes && { supersedes }) }
	});

	it('marks a superseded rule with the rule replacing it, keeping its live values', () => {
		const registry = buildRegistry(areas({ 'old.rule': 'new.rule' }));
		expect(registry).toEqual<RuleEntry[]>([
			{ ...old, area: 'm3', status: 'superseded', supersededBy: 'new.rule' },
			{ ...replacement, area: 'generator', status: 'active' }
		]);
		expect(registry[0]!.kind === 'constant' && registry[0]!.values).toBe(BLOCKS_EDIT);
		expect(buildRegistry(areas()).map((rule) => rule.status)).toEqual(['active', 'active']);
	});

	it('refuses a supersedes map naming a rule nobody registered, and an id used twice', () => {
		expect(() => buildRegistry(areas({ 'old.rule': 'gone.rule' }))).toThrow(
			"'old.rule' superseded by 'gone.rule': both must be registered"
		);
		expect(() => buildRegistry(areas({ 'gone.rule': 'new.rule' }))).toThrow(
			'both must be registered'
		);
		expect(() => buildRegistry({ m3: { rules: [old] }, m4: { rules: [old] } })).toThrow(
			"The rule 'old.rule' is registered twice"
		);
	});
});
