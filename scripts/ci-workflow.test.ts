/**
 * The run rules in .github/workflows/ci.yml. Every merge to `main` gets a complete run: only a
 * newer push to the same pull request cancels a run. Artifact uploads keep the hidden files they
 * list, such as the e2e production server's `.e2e-server.log`: upload-artifact skips dot-files
 * unless `include-hidden-files` is set.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINES, GROUPS, LEGS } from '../e2e/projects.ts';
import { CEILING_MINUTES } from './e2e-timing.ts';

/** A line of the workflow and the more-indented lines under it. */
interface Line {
	indent: number;
	text: string;
	children: Line[];
}

/**
 * The workflow's lines nested by indentation, without blank lines and comments: all the
 * structure these checks need from its block-style YAML (this is not a YAML parser).
 */
function outline(source: string): Line[] {
	const root: Line = { indent: -1, text: '', children: [] };
	const open = [root];
	for (const raw of source.split('\n')) {
		const text = raw.trim();
		if (text === '' || text.startsWith('#')) continue;
		const line: Line = { indent: raw.length - raw.trimStart().length, text, children: [] };
		while (open.at(-1)!.indent >= line.indent) open.pop();
		open.at(-1)!.children.push(line);
		open.push(line);
	}
	return root.children;
}

const ci = outline(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));

/** The line that holds `key` among a mapping's lines (a list item's `- key:` included). */
function find(lines: Line[], key: string): Line | undefined {
	return lines.find((line) => line.text.replace(/^- /, '').split(/:(?:\s|$)/)[0] === key);
}

/** The lines under `key`, which must exist. */
function under(lines: Line[], key: string): Line[] {
	const line = find(lines, key);
	if (!line) throw new Error(`ci.yml has no "${key}" here`);
	return line.children;
}

const flatten = (line: Line): string[] =>
	line.children.flatMap((child) => [child.text, ...flatten(child)]);

/** The scalar value of `key`; a block scalar (`key: |`) comes back line by line. */
function value(lines: Line[], key: string): string | undefined {
	const line = find(lines, key);
	if (!line) return undefined;
	const raw = line.text.slice(line.text.indexOf(':') + 1).trim();
	if (/^[|>][-+]?$/.test(raw)) return flatten(line).join('\n');
	const quoted = /^(['"])(.*)\1$/.exec(raw);
	return quoted ? quoted[2]! : raw.replace(/\s+#.*$/, '');
}

type Context = Record<string, string>;

/**
 * Evaluates a GitHub Actions expression with the operators the run rules use: context
 * properties, string literals, `==` and `!=` (strings compare ignoring case, as on GitHub), and
 * `&&` before `||`, which return one of their operands. Anything else throws, so a rule this
 * cannot read fails the tests instead of passing them.
 */
function evaluate(expression: string, context: Context): string | boolean {
	const tokens = expression.match(/'(?:[^']|'')*'|==|!=|&&|\|\||[\w.-]+|\S/g) ?? [];
	let at = 0;
	const unreadable = () => new Error(`cannot evaluate "${tokens[at] ?? '(end)'}" in ${expression}`);
	const operand = (): string => {
		const token = tokens[at] ?? '';
		const literal = /^'(.*)'$/.exec(token)?.[1];
		if (literal === undefined && !Object.hasOwn(context, token)) throw unreadable();
		at++;
		return literal === undefined ? context[token]! : literal.replaceAll("''", "'");
	};
	const comparison = (): string | boolean => {
		const left = operand();
		const operator = tokens[at];
		if (operator !== '==' && operator !== '!=') return left;
		at++;
		const same = left.toLowerCase() === operand().toLowerCase();
		return operator === '==' ? same : !same;
	};
	const all = (): string | boolean => {
		let result = comparison();
		while (tokens[at] === '&&') {
			at++;
			const next = comparison();
			result = result ? next : result;
		}
		return result;
	};
	let result = all();
	while (tokens[at] === '||') {
		at++;
		const next = all();
		result = result ? result : next;
	}
	if (at < tokens.length) throw unreadable();
	return result;
}

/** The concurrency group and cancel-in-progress GitHub computes for a run with this context. */
function concurrencyOf(context: Context) {
	const rules = under(ci, 'concurrency');
	const group = value(rules, 'group');
	if (!group) throw new Error('ci.yml has no concurrency group');
	const cancel = value(rules, 'cancel-in-progress') ?? 'false';
	const expression = /^\$\{\{(.*)\}\}$/.exec(cancel)?.[1];
	return {
		group: group.replace(/\$\{\{(.*?)\}\}/g, (_, inner: string) =>
			String(evaluate(inner, context))
		),
		cancelInProgress:
			expression === undefined ? cancel === 'true' : Boolean(evaluate(expression, context))
	};
}

/** A run's `github` context, as far as the run rules may read it. */
function run(event: string, ref: string, runId: string, headRef = ''): Context {
	return {
		'github.workflow': value(ci, 'name') ?? '.github/workflows/ci.yml',
		'github.event_name': event,
		'github.ref': ref,
		'github.head_ref': headRef,
		'github.run_id': runId
	};
}

const merge = (runId: string) => concurrencyOf(run('push', 'refs/heads/main', runId));
const manualRun = (runId: string) =>
	concurrencyOf(run('workflow_dispatch', 'refs/heads/main', runId));
const pullRequestPush = (pr: number, runId: string) =>
	concurrencyOf(run('pull_request', `refs/pull/${pr}/merge`, runId, `branch-${pr}`));

// GitHub runs one run per concurrency group and keeps one more waiting. A newer run replaces the
// waiting one whatever cancel-in-progress says, and with it also cancels the running one.
describe('CI concurrency', () => {
	it('gives each merge to main and each manual run a group of its own', () => {
		const runs = [merge('101'), merge('102'), merge('103'), manualRun('104')];
		const groups = new Set(runs.map((r) => r.group));
		expect([...groups], 'runs that share a group can replace each other').toHaveLength(runs.length);
	});

	it('cancels a run in progress only for a newer push to the same pull request', () => {
		const older = pullRequestPush(7, '201');
		const newer = pullRequestPush(7, '202');
		expect(newer.group, 'one group per pull request').toBe(older.group);
		expect(newer.cancelInProgress, 'a newer push cancels the older run').toBe(true);
		expect(pullRequestPush(8, '203').group, 'another pull request').not.toBe(older.group);
		expect(merge('204').cancelInProgress, 'a merge to main').toBe(false);
		expect(manualRun('205').cancelInProgress, 'a manual run').toBe(false);
	});
});

/** Every actions/upload-artifact step, with the paths it lists. */
function uploads() {
	return under(ci, 'jobs').flatMap((job) =>
		(find(job.children, 'steps')?.children ?? [])
			.map((step) => [step, ...step.children])
			.filter((fields) => value(fields, 'uses')?.startsWith('actions/upload-artifact@'))
			.map((fields) => {
				const inputs = under(fields, 'with');
				return {
					job: job.text.replace(/:$/, ''),
					paths: (value(inputs, 'path') ?? '')
						.split('\n')
						.map((path) => path.trim())
						.filter(Boolean),
					includesHiddenFiles: value(inputs, 'include-hidden-files') === 'true'
				};
			})
	);
}

/** A path naming a dot-file or dot-directory (not an exclusion), which upload-artifact skips. */
const isHidden = (path: string) =>
	!path.startsWith('!') && path.split('/').some((part) => /^\.[^./]/.test(part));

describe('CI artifacts', () => {
	it('uploads the e2e production server log, a dot-file, with hidden files included', () => {
		// e2e/global-setup.ts writes the server's output there.
		const upload = uploads().find((step) => step.paths.includes('.e2e-server.log'));
		expect(upload?.job, 'the job that uploads .e2e-server.log').toBe('e2e-legs');
		expect(upload?.includesHiddenFiles, 'include-hidden-files').toBe(true);
	});

	it('includes hidden files in every upload that lists one', () => {
		const skipping = uploads().filter(
			(step) => step.paths.some(isHidden) && !step.includesHiddenFiles
		);
		expect(skipping).toEqual([]);
	});
});

const legsJob = () => under(under(ci, 'jobs'), 'e2e-legs');

/** The e2e matrix's entries: each `- { key: value, … }` line under `include`. */
function entries(): Record<string, string>[] {
	const include = under(under(under(legsJob(), 'strategy'), 'matrix'), 'include');
	return include.map((line) => {
		const flow = /^- \{(.*)\}$/.exec(line.text)?.[1];
		if (flow === undefined) throw new Error(`not a one-line entry: ${line.text}`);
		return Object.fromEntries(flow.split(',').map((pair) => pair.split(':').map((s) => s.trim())));
	});
}

/** A legs step's fields, found by its name. */
function legStep(name: string): Line[] {
	const step = under(legsJob(), 'steps').find((s) => value([s, ...s.children], 'name') === name);
	if (!step) throw new Error(`no step "${name}"`);
	return [step, ...step.children];
}

/** `${{ matrix.x }}` and `${{ github.run_id }}` filled in for one entry. */
const fill = (template: string, entry: Record<string, string>) =>
	template.replace(/\$\{\{\s*([\w.-]+)\s*\}\}/g, (_, name: string) => {
		if (name === 'github.run_id') return '42';
		const key = name.replace(/^matrix\./, '');
		if (!name.startsWith('matrix.') || !(key in entry)) throw new Error(`unknown ${name}`);
		return entry[key]!;
	});

const PLAYWRIGHT = 'Playwright (global setup builds and starts the production Node server)';

describe('CI e2e legs', () => {
	it('cover every leg of e2e/projects.ts, with contiguous, well-formed shards', () => {
		const legs = new Map<string, Record<string, string>[]>();
		for (const entry of entries()) {
			expect(GROUPS, JSON.stringify(entry)).toContain(entry.group);
			expect(ENGINES, JSON.stringify(entry)).toContain(entry.engine);
			for (const key of ['shard', 'of', 'minutes']) {
				expect(entry[key], `${key} in ${JSON.stringify(entry)}`).toMatch(/^[1-9]\d*$/);
			}
			const leg = `${entry.group}/${entry.engine}`;
			legs.set(leg, [...(legs.get(leg) ?? []), entry]);
		}
		expect([...legs.keys()].sort()).toEqual(LEGS.map((l) => `${l.group}/${l.engine}`).sort());
		for (const [leg, shards] of legs) {
			const of = Number(shards[0]!.of);
			expect(
				shards.map((s) => s.of),
				leg
			).toEqual(shards.map(() => String(of)));
			expect(
				shards.map((s) => Number(s.shard)).sort((a, b) => a - b),
				leg
			).toEqual(Array.from({ length: of }, (_, i) => i + 1));
		}
	});

	it('run every entry to the end and each leg’s projects and shard', () => {
		expect(value(under(legsJob(), 'strategy'), 'fail-fast')).toBe('false');
		const step = legStep(PLAYWRIGHT);
		const env = under(step, 'env');
		expect(value(env, 'E2E_ENGINE')).toBe('${{ matrix.engine }}');
		expect(value(env, 'E2E_GROUP')).toBe('${{ matrix.group }}');
		expect(value(step, 'run')).toBe('pnpm test:e2e --shard ${{ matrix.shard }}/${{ matrix.of }}');
		const timing = legStep('Where the minutes went');
		expect(value(timing, 'if')).toBe('${{ !cancelled() }}');
		expect(value(timing, 'run')).toMatch(
			/^node scripts\/e2e-timing\.ts test-results\/report\.json /
		);
	});

	it('bound each entry by its measured minutes, inside the job with room for the installs', () => {
		const step = legStep(PLAYWRIGHT);
		expect(value(step, 'timeout-minutes')).toBe('${{ matrix.minutes }}');
		const minutes = entries().map((entry) => Number(entry.minutes));
		for (const m of minutes) expect(m).toBeLessThanOrEqual(Math.ceil(1.5 * CEILING_MINUTES));
		const installs = ['Install Playwright system dependencies', 'Install Playwright browsers'].map(
			(name) => Number(value(legStep(name), 'timeout-minutes'))
		);
		expect(installs).toEqual([12, 8]);
		const job = Number(value(legsJob(), 'timeout-minutes'));
		expect(job).toBeGreaterThanOrEqual(Math.ceil(1.5 * CEILING_MINUTES) + 12 + 8);
	});

	it('upload each entry’s files under a name of its own, hidden files included', () => {
		const inputs = under(legStep('Upload screenshots and report'), 'with');
		expect(value(inputs, 'include-hidden-files')).toBe('true');
		const template = value(inputs, 'name')!;
		const names = entries().map((entry) => fill(template, entry));
		expect(new Set(names).size, names.join(', ')).toBe(names.length);
		expect(fill(template, { group: 'main', engine: 'webkit', shard: '2' })).toBe(
			'playwright-42-main-webkit-2'
		);
	});

	it('report through one check, under its old name, that passes only when every leg did', () => {
		const jobs = under(ci, 'jobs');
		const checks = jobs.filter(
			(job) => value(job.children, 'name') === 'E2E (iPhone viewport · Chromium + WebKit)'
		);
		expect(checks.map((job) => job.text)).toEqual(['e2e:']);
		const aggregate = checks[0]!.children;
		expect(value(aggregate, 'needs')).toBe('[e2e-legs]');
		// A required check that is skipped counts as passed, so it must run after a failed leg too.
		expect(value(aggregate, 'if')).toBe('${{ always() }}');
		const step = under(aggregate, 'steps')[0]!;
		const fields = [step, ...step.children];
		expect(value(under(fields, 'env'), 'LEGS')).toBe('${{ needs.e2e-legs.result }}');
		expect(value(fields, 'run')).toMatch(/^if \[ "\$LEGS" != success \]; then\n.*\n\s*exit 1\n/);
	});
});
