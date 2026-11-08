/**
 * scripts/rule-keys.ts finds every way code cites a rule key, and nothing else: run over a small
 * source tree written for the test, then over M3's scenario plans and DEFAULTS.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { citedRuleKeys, scenarioRuleKeys, sourceFiles, staticRuleKeys } from './rule-keys';

const root = mkdtempSync(path.join(tmpdir(), 'rule-keys-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function tree(files: Record<string, string>) {
	const at = mkdtempSync(path.join(root, 'tree-'));
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(at, file)), { recursive: true });
		writeFileSync(path.join(at, file), text);
	}
	return at;
}

const LOG = `
export class Log {
	add(kind: string, ruleKey: string, refs: string[], facts: object) { return { kind, ruleKey, refs, facts }; }
}
export const log = new Log();
`;

const CITES = `
import { log } from './log.ts';
type Shape = 'default' | 'marathon';
declare const shape: Shape;
declare const fill: boolean;
declare const free: string;
// log.add('block_structure', 'blocks.in_a_comment', [], {});
/* { ruleKey: 'blocks.in_a_block_comment' } */
log.add('block_structure', 'blocks.literal', [], {});
log.add('block_structure', \`blocks.\${shape}\`, [], {});
log.add('day_allocation', fill ? \`days.\${shape}\` : 'days.free', [], {});
const rule = \`loads.\${shape}_set\` as const;
const key = \`\${rule}.at_limit\`;
log.add('load_basis', key, [], {});
log.add('load_basis', free, [], {});
const note = (kind: string, id: string) => id;
note('priority_tradeoff', 'placement.noted');
const drop = (ruleKey: string) => ruleKey;
drop('placement.dropped');
export const outcome = { ruleKey: 'results.property', why: 'not a key' };
export const label = 'blocks.just_a_string';
`;

/** Each case builds a TypeScript program, a few seconds on a busy machine. */
const SLOW = { timeout: 60_000 };

describe('staticRuleKeys', SLOW, () => {
	it('finds literal, template, conditional and property keys, and none in a comment', () => {
		const at = tree({ 'src/log.ts': LOG, 'src/cites.ts': CITES });
		expect([...staticRuleKeys(['src/**/*.ts'], at)].sort()).toEqual([
			'blocks.default',
			'blocks.literal',
			'blocks.marathon',
			'days.default',
			'days.free',
			'days.marathon',
			'loads.default_set.at_limit',
			'loads.marathon_set.at_limit',
			'placement.dropped',
			'placement.noted',
			'results.property'
		]);
	});

	it('throws on a template it cannot expand, naming the file and line', () => {
		const at = tree({
			'src/log.ts': LOG,
			'src/open.ts': `import { log } from './log.ts';\ndeclare const any: string;\nlog.add('progression', \`progression.\${any}\`, [], {});\n`
		});
		expect(() => staticRuleKeys(['src/**/*.ts'], at)).toThrow(
			'src/open.ts:3: cannot expand the rule key template'
		);
	});

	it('reads only the files its globs name, never a test', () => {
		const at = tree({
			'src/log.ts': LOG,
			'src/a/cites.ts': `import { log } from '../log.ts';\nlog.add('progression', 'a.kept', [], {});\n`,
			'src/a/cites.test.ts': `import { log } from '../log.ts';\nlog.add('progression', 'a.test', [], {});\n`,
			'src/b/cites.ts': `import { log } from '../log.ts';\nlog.add('progression', 'b.excluded', [], {});\n`
		});
		const globs = ['src/**/*.ts', '!src/b/**'];
		expect(sourceFiles(globs, at).map((file) => path.relative(at, file))).toEqual([
			'src/a/cites.ts',
			'src/log.ts'
		]);
		expect([...staticRuleKeys(globs, at)]).toEqual(['a.kept']);
	});
});

describe('citedRuleKeys', SLOW, () => {
	it('adds every DEFAULTS key, the scenario plans’ keys and the decisions given', () => {
		const at = tree({ 'src/log.ts': LOG });
		const scenarios = scenarioRuleKeys();
		expect(scenarios).toContain('defaults.session_minutes');
		expect(scenarios).toContain('program.baseline_week');
		const keys = citedRuleKeys(
			['src/**/*.ts'],
			[{ ruleKey: 'edits.fixture' }, { ruleKey: null }],
			at
		);
		expect(keys).toEqual(new Set([...scenarios, 'edits.fixture']));
	});
});
