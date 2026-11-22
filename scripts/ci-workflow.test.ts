/**
 * The run rules in .github/workflows/ci.yml. Every merge to `main` gets a run of its own: only a
 * newer push to the same pull request cancels a run. A run's scope job decides whether its heavy
 * jobs run. Artifact uploads keep the hidden files they
 * list, such as the e2e production servers' `.e2e-server*.log`: upload-artifact skips dot-files
 * unless `include-hidden-files` is set.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINES, LEGS } from '../e2e/projects.ts';
import { CHROMIUM_LEGS, JOURNEYS_CHROMIUM, JOURNEYS_WEBKIT, type Leg, legsFor } from './ci-legs.ts';
import { KEY_PATTERN, MIN_SCANNED_KEY_LENGTH } from './client-secret-scan.ts';
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
const nightlyRun = (runId: string) => concurrencyOf(run('schedule', 'refs/heads/main', runId));
const pullRequestPush = (pr: number, runId: string) =>
	concurrencyOf(run('pull_request', `refs/pull/${pr}/merge`, runId, `branch-${pr}`));

// GitHub runs one run per concurrency group and keeps one more waiting. A newer run replaces the
// waiting one whatever cancel-in-progress says, and with it also cancels the running one.
describe('CI concurrency', () => {
	it('runs main nightly in a group of its own, never cancelled by another run', () => {
		expect(under(ci, 'on').map((line) => line.text)).toContain('schedule:');
		expect(nightlyRun('1')).toEqual({
			group: expect.stringContaining('-1'),
			cancelInProgress: false
		});
		expect(nightlyRun('1').group).not.toBe(nightlyRun('2').group);
	});

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

/** The `if` of every job that waits for the scope job: it runs only on a full run. */
const FULL_ONLY = "${{ needs.changes.outputs.scope == 'full' }}";
/** The jobs that wait for the scope job: the heavy ones, which a light run skips, and the two aggregate checks. */
const HEAVY = ['integration', 'e2e-legs'];
const AGGREGATES = ['test', 'e2e'];
/** The results a `needs` context can hold, and the run scopes the scope job can answer. */
const RESULTS = ['success', 'failure', 'cancelled', 'skipped'];
const SCOPES = ['full', 'light', ''];

/** The job ids a job's `needs` lists. */
const needsOf = (job: Line[]) =>
	(value(job, 'needs') ?? '')
		.replace(/[[\]]/g, '')
		.split(/[\s,]+/)
		.filter(Boolean);

describe('CI scope', () => {
	it('decides the scope in its own first job, from the full history and the event', () => {
		const jobs = under(ci, 'jobs');
		expect(jobs[0]!.text).toBe('changes:');
		const job = under(jobs, 'changes');
		expect(value(under(job, 'outputs'), 'scope')).toBe('${{ steps.scope.outputs.scope }}');
		expect(value(under(job, 'outputs'), 'legs')).toBe('${{ steps.scope.outputs.legs }}');
		const steps = stepsOf(job);
		const checkout = steps.find((fields) => value(fields, 'uses')?.startsWith('actions/checkout@'));
		expect(value(under(checkout!, 'with'), 'fetch-depth')).toBe('0');
		const scope = steps.find((fields) => value(fields, 'id') === 'scope')!;
		expect(value(scope, 'run')).toBe('node scripts/ci-scope.ts >> "$GITHUB_OUTPUT"');
		const env = under(scope, 'env');
		expect(value(env, 'EVENT_NAME')).toBe('${{ github.event_name }}');
		expect(value(env, 'BASE_SHA')).toBe('${{ github.event.pull_request.base.sha }}');
		expect(value(env, 'HEAD_SHA')).toBe('${{ github.event.pull_request.head.sha }}');
		expect(value(env, 'BEFORE_SHA')).toBe('${{ github.event.before }}');
		expect(value(env, 'SHA')).toBe('${{ github.sha }}');
	});

	it('runs the heavy jobs only on a full run, after the scope job, and no other job', () => {
		const jobs = under(ci, 'jobs');
		for (const id of HEAVY) {
			const job = under(jobs, id);
			expect(value(job, 'needs'), id).toBe('[changes]');
			expect(value(job, 'if'), id).toBe(FULL_ONLY);
		}
		for (const id of ['quality', 'unit', 'build']) {
			const job = under(jobs, id);
			expect(value(job, 'needs'), id).toBeUndefined();
			expect(value(job, 'if'), id).toBeUndefined();
		}
		const waiting = jobs
			.filter((job) => needsOf(job.children).includes('changes'))
			.map((job) => job.text.replace(/:$/, ''));
		expect(waiting.sort()).toEqual([...AGGREGATES, ...HEAVY].sort());
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
	it('uploads the e2e production server logs, dot-files, with hidden files included', () => {
		// e2e/global-setup.ts writes each owner world's server output to one (worldFiles): world 0's
		// to .e2e-server.log, world n's to .e2e-server-w<n>.log.
		const upload = uploads().find((step) => step.paths.includes('.e2e-server*.log'));
		expect(upload?.job, 'the job that uploads .e2e-server*.log').toBe('e2e-legs');
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

/** A leg's fields as the matrix entry Actions expands `${{ matrix.x }}` from (`only` when set). */
const asEntry = (leg: Leg): Record<string, string> =>
	Object.fromEntries(Object.entries(leg).map(([key, field]) => [key, String(field)]));

/** The legs of each kind of run: a scheduled run's, and a pull request's. */
const RUNS = [legsFor('schedule'), legsFor('pull_request')];
/** Every leg any run can get, for the checks that hold for each leg whatever its event. */
const EVERY_LEG = [...CHROMIUM_LEGS, JOURNEYS_WEBKIT, JOURNEYS_CHROMIUM];

/** `<group>/<engine>` of a leg, as e2e/projects.ts names its legs. */
const legKey = (leg: { group: string; engine: string }) => `${leg.group}/${leg.engine}`;

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
	it('take their matrix from scripts/ci-legs.ts, through the scope job', () => {
		const strategy = under(legsJob(), 'strategy');
		expect(value(strategy, 'fail-fast')).toBe('false');
		expect(value(strategy, 'matrix')).toBe('${{ fromJSON(needs.changes.outputs.legs) }}');
	});

	it('cover every Chromium group of e2e/projects.ts but alone, and WebKit only through the journeys', () => {
		// Performance is not tested in CI, by the owner's decision: the `alone` group (perf) runs
		// locally only (E2E_GROUP=alone pnpm test:e2e), and so does pnpm lighthouse.
		const covered = [...new Set(CHROMIUM_LEGS.map(legKey))].sort();
		const expected = LEGS.filter((leg) => leg.engine === 'chromium' && leg.group !== 'alone')
			.map(legKey)
			.sort();
		expect(covered).toEqual(expected);
		expect(legsFor('schedule').filter((leg) => leg.engine === 'webkit')).toEqual([JOURNEYS_WEBKIT]);
	});

	it('run each leg to the end: its projects and shard, or its file filter unsharded', () => {
		const step = legStep(PLAYWRIGHT);
		const env = under(step, 'env');
		expect(value(env, 'E2E_ENGINE')).toBe('${{ matrix.engine }}');
		expect(value(env, 'E2E_GROUP')).toBe('${{ matrix.group }}');
		expect(value(env, 'E2E_SHARD')).toBe('${{ matrix.shard }}/${{ matrix.of }}');
		expect(value(env, 'E2E_ONLY')).toBe('${{ matrix.only }}');
		// A file-filtered leg (the journeys) runs those specs. Any other runs the shard's spec files
		// from scripts/e2e-shards.ts, read before Playwright starts so a planner failure fails the step
		// (bash -e) instead of running the whole leg.
		expect(value(step, 'run')).toBe(
			'if [ -n "$E2E_ONLY" ]; then\n' +
				'pnpm test:e2e "$E2E_ONLY"\n' +
				'else\n' +
				'shard_args=$(node scripts/e2e-shards.ts "$RUNNER_TEMP/e2e-shard-tests.txt")\n' +
				'pnpm test:e2e $shard_args\n' +
				'fi'
		);
		expect(value(step, 'run')).not.toMatch(/--shard/);
		const timing = legStep('Where the minutes went');
		expect(value(timing, 'if')).toBe('${{ !cancelled() }}');
		const timingEnv = under(timing, 'env');
		expect(value(timingEnv, 'E2E_ENGINE')).toBe('${{ matrix.engine }}');
		expect(value(timingEnv, 'E2E_GROUP')).toBe('${{ matrix.group }}');
		expect(value(timingEnv, 'E2E_SHARD')).toBe('${{ matrix.shard }}/${{ matrix.of }}');
		expect(value(timing, 'run')).toMatch(
			/^node scripts\/e2e-timing\.ts test-results\/report\.json /
		);
	});

	it('bound each leg by its Playwright timeout, inside the job with room for the installs', () => {
		const step = legStep(PLAYWRIGHT);
		expect(value(step, 'timeout-minutes')).toBe('${{ matrix.minutes }}');
		const installs = ['Install Playwright system dependencies', 'Install Playwright browsers'].map(
			(name) => Number(value(legStep(name), 'timeout-minutes'))
		);
		expect(installs).toEqual([12, 8]);
		const job = Number(value(legsJob(), 'timeout-minutes'));
		expect(job).toBeGreaterThanOrEqual(Math.ceil(1.5 * CEILING_MINUTES) + 12 + 8);
	});

	it('install the engines’ system packages from a cache keyed by exactly those packages', () => {
		const names = under(legsJob(), 'steps').map((s) => value([s, ...s.children], 'name'));
		const order = [
			'Playwright system packages',
			'Cache Playwright system packages',
			'Install Playwright system dependencies'
		].map((name) => names.indexOf(name));
		expect(order.every((at, i) => at > (order[i - 1] ?? -1))).toBe(true);

		/** Every `${{ … }}` in `template` evaluated for one engine's entries on one runner. */
		const expand = (template: string, engine: string) =>
			template.replace(/\$\{\{(.*?)\}\}/g, (_, inner: string) =>
				String(
					evaluate(inner, {
						'matrix.engine': engine,
						'steps.image.outputs.os': 'ubuntu24',
						'steps.apt.outputs.packages': `${engine}-packages`,
						'steps.apt.outputs.image': '20261101.1'
					})
				)
			);
		const keyStep = legStep('Playwright system packages');
		expect(value(keyStep, 'id')).toBe('apt');
		const keyRun = value(keyStep, 'run')!;
		const install = value(legStep('Install Playwright system dependencies'), 'run')!;
		const cache = under(legStep('Cache Playwright system packages'), 'with');
		expect(value(cache, 'path')).toBe('~/.cache/apt-playwright');
		const key = value(cache, 'key')!;
		const restore = value(cache, 'restore-keys')!;
		const engines = [...new Set(EVERY_LEG.map((leg) => leg.engine))].sort();
		expect(engines).toEqual([...ENGINES].sort());
		for (const engine of engines) {
			// Chromium legs launch only Chromium; WebKit legs also run the Chromium owner setup.
			const browsers = engine === 'webkit' ? 'chromium webkit' : 'chromium';
			// The key hashes the very packages the install installs.
			expect(expand(keyRun, engine), engine).toBe(
				`./scripts/ci-playwright-deps.sh key ${browsers} >> "$GITHUB_OUTPUT"`
			);
			expect(expand(install, engine), engine).toBe(
				`./scripts/ci-playwright-deps.sh install ~/.cache/apt-playwright ${browsers}`
			);
			expect(expand(key, engine), engine).toBe(
				`apt-playwright-v2-ubuntu24-${engine}-packages-20261101.1`
			);
			expect(expand(restore, engine), engine).toBe(
				`apt-playwright-v2-ubuntu24-${engine}-packages-`
			);
			// No engine restores an archive another engine saved (a Chromium one lacks WebKit's).
			for (const other of engines.filter((e) => e !== engine)) {
				expect(expand(key, other).startsWith(expand(restore, engine)), other).toBe(false);
			}
		}

		const direct = under(legsJob(), 'steps').filter((s) =>
			(value([s, ...s.children], 'run') ?? '').includes('playwright install-deps')
		);
		expect(direct, 'no install-deps outside the cached install').toEqual([]);
	});

	it('upload each run’s files under a name of its own, hidden files included', () => {
		const inputs = under(legStep('Upload screenshots and report'), 'with');
		expect(value(inputs, 'include-hidden-files')).toBe('true');
		const template = value(inputs, 'name')!;
		// The names are unique within each run (scripts/ci-legs.ts); two runs may share one.
		for (const legs of RUNS) {
			const names = legs.map((leg) => fill(template, asEntry(leg)));
			expect(new Set(names).size, names.join(', ')).toBe(names.length);
		}
		expect(fill(template, { group: 'main', engine: 'webkit', shard: '2' })).toBe(
			'playwright-42-main-webkit-2'
		);
	});

	it('never installs system packages from a live mirror outside the cached install', () => {
		const direct = under(ci, 'jobs')
			.flatMap((job) => stepsOf(job.children))
			.map((fields) => value(fields, 'run') ?? '')
			.filter((run) => run.includes('playwright install-deps') || run.includes('apt-get'));
		expect(direct).toEqual([]);
	});

	it('report through one check, under its old name, that passes only when every leg did', () => {
		const jobs = under(ci, 'jobs');
		const checks = jobs.filter(
			(job) => value(job.children, 'name') === 'E2E (iPhone viewport · Chromium + WebKit)'
		);
		expect(checks.map((job) => job.text)).toEqual(['e2e:']);
		const aggregate = checks[0]!.children;
		expect(value(aggregate, 'needs')).toBe('[changes, e2e-legs]');
		// A required check that is skipped counts as passed, so on a pull request it must run after a
		// failed leg too. Required checks gate only pull requests, so pushes and manual runs skip it
		// rather than queue a 3-second job behind every pull request's jobs.
		expect(value(aggregate, 'if')).toBe("${{ always() && github.event_name == 'pull_request' }}");
		// The legs run on every full run, so a merge to main still fails on a failed leg.
		expect(value(legsJob(), 'if')).toBe(FULL_ONLY);
		const step = under(aggregate, 'steps')[0]!;
		const fields = [step, ...step.children];
		const env = under(fields, 'env');
		expect(value(env, 'CHANGES')).toBe('${{ needs.changes.result }}');
		expect(value(env, 'SCOPE')).toBe('${{ needs.changes.outputs.scope }}');
		expect(value(env, 'LEGS')).toBe('${{ needs.e2e-legs.result }}');
		const script = value(fields, 'run')!;
		for (const changes of RESULTS) {
			for (const legs of RESULTS) {
				for (const scope of SCOPES) {
					// Passes only when the scope job succeeded and the legs either passed or were
					// skipped by a light run.
					const passed =
						changes === 'success' &&
						(legs === 'success' || (legs === 'skipped' && scope === 'light'));
					expect(
						exitCode(script, { CHANGES: changes, LEGS: legs, SCOPE: scope }),
						`scope job ${changes}, legs ${legs}, run scope '${scope}'`
					).toBe(passed ? 0 : 1);
				}
			}
		}
	});
});

describe('CI client-secret canary', () => {
	it('builds both targets and runs the budgets with a canary ANTHROPIC_API_KEY', () => {
		const job = under(under(ci, 'jobs'), 'build');
		const key = value(under(job, 'env'), 'ANTHROPIC_API_KEY') ?? '';
		// Long enough to be scanned for, and not an sk-ant- key, so the canary check stands alone.
		expect(key.length).toBeGreaterThanOrEqual(MIN_SCANNED_KEY_LENGTH);
		expect(key).not.toMatch(KEY_PATTERN);
		expect(key).not.toMatch(/\$\{\{/);
		// Job-level, so every step below sees it; no step overrides it.
		const steps = under(job, 'steps').map((step) => [step, ...step.children]);
		expect(steps.map((fields) => value(fields, 'run')).filter(Boolean)).toEqual(
			expect.arrayContaining(['pnpm build', 'pnpm build:node', 'pnpm budgets'])
		);
		const overrides = steps.filter((fields) => find(fields, 'env'));
		expect(overrides.flatMap((fields) => flatten(find(fields, 'env')!))).not.toContainEqual(
			expect.stringMatching(/^ANTHROPIC_API_KEY:/)
		);
	});
});

describe('scripts/lighthouse.ts', () => {
	// Lighthouse is not a CI job (the owner's decision), but `pnpm lighthouse` still runs locally.
	it('skips the full-page screenshot, which only the HTML report thumbnails use', () => {
		const script = readFileSync(new URL('./lighthouse.ts', import.meta.url), 'utf8');
		expect(script).toMatch(/^\s*disableFullPageScreenshot: true,$/m);
	});
});

/** A job's steps, each as its own line and the lines under it. */
const stepsOf = (job: Line[]) => under(job, 'steps').map((step) => [step, ...step.children]);

/** Every job that runs db:setup, with its steps. */
function databaseJobs() {
	return under(ci, 'jobs')
		.map((job) => ({ id: job.text.replace(/:$/, ''), steps: stepsOf(job.children) }))
		.filter((job) => job.steps.some((fields) => value(fields, 'run') === 'pnpm db:setup'));
}

// The image's entrypoint pulls before `docker run -d` detaches, so the whole command goes to the
// background: the pull and initdb overlap the installs instead of holding the job at its start.
const START =
	/^nohup sh -c '(docker run -d --name postgres -p 5432:5432 (?:-e POSTGRES_\w+=\w+ )+postgres:18)' > "\$RUNNER_TEMP\/postgres-start\.log" 2>&1 &$/;

describe('CI Postgres', () => {
	it('is started by every job that runs db:setup, in the background, right after checkout', () => {
		const jobs = databaseJobs();
		expect(jobs.map((job) => job.id).sort()).toEqual(['e2e-legs', 'integration']);
		for (const job of jobs) {
			const checkout = job.steps.findIndex((f) =>
				value(f, 'uses')?.startsWith('actions/checkout@')
			);
			const start = job.steps.findIndex((f) => START.test(value(f, 'run') ?? ''));
			expect(start, `${job.id}: a backgrounded postgres:18 start`).toBeGreaterThan(-1);
			expect(start, `${job.id}: right after checkout`).toBe(checkout + 1);
			const command = START.exec(value(job.steps[start]!, 'run')!)![1]!;
			// The same server the service container gave: image, superuser, password and database.
			const env = [...command.matchAll(/-e (POSTGRES_\w+)=(\w+)/g)].map(([, k, v]) => `${k}=${v}`);
			expect(env.sort(), job.id).toEqual([
				'POSTGRES_DB=postgres',
				'POSTGRES_PASSWORD=postgres',
				'POSTGRES_USER=postgres'
			]);
		}
	});

	it('is waited for over TCP, for at least 90 s, immediately before db:setup', () => {
		for (const job of databaseJobs()) {
			const setup = job.steps.findIndex((f) => value(f, 'run') === 'pnpm db:setup');
			const wait = job.steps[setup - 1]!;
			expect(value(wait, 'name'), job.id).toBe('Wait for Postgres');
			const script = value(wait, 'run') ?? '';
			// Over TCP: the image's init server listens on its socket only, so it never counts.
			expect(script, job.id).toContain('pg_isready -h localhost -p 5432 -U postgres');
			// A cold pull plus initdb.
			expect(Number(value(under(wait, 'env'), 'WAIT_SECONDS')), job.id).toBeGreaterThanOrEqual(90);
			expect(script, job.id).toContain('$WAIT_SECONDS');
			// A server that never answers fails the job, with what went wrong in its log.
			expect(script, job.id).toContain('"$RUNNER_TEMP/postgres-start.log"');
			expect(script, job.id).toContain('docker logs postgres');
			expect(script, job.id).toMatch(/\n\s*exit 1$/);
		}
	});

	it('runs in no service container, which would hold every job until it is healthy', () => {
		const withServices = under(ci, 'jobs').filter((job) => find(job.children, 'services'));
		expect(withServices.map((job) => job.text)).toEqual([]);
	});
});

/** Every job's id and the commands its steps run. */
const jobCommands = () =>
	under(ci, 'jobs').map((job) => ({
		id: job.text.replace(/:$/, ''),
		runs: stepsOf(job.children)
			.map((fields) => value(fields, 'run'))
			.filter((run): run is string => run !== undefined)
	}));

/** Runs a gate step's script with `env`, as the runner's shell would, and returns its exit code. */
function exitCode(script: string, env: Record<string, string>): number | null {
	return spawnSync('sh', ['-e', '-c', script], { env: { ...process.env, ...env }, stdio: 'ignore' })
		.status;
}

describe('CI unit and integration tests', () => {
	it('run test:unit, test:integration and db:explain once each, unit tests apart', () => {
		const jobs = jobCommands();
		const runners = (command: string) =>
			jobs.flatMap((job) =>
				job.runs
					.filter((run) => run.split('\n').some((line) => line.trim() === command))
					.map(() => job.id)
			);
		expect(runners('pnpm test:unit')).toEqual(['unit']);
		expect(runners('pnpm test:integration')).toEqual(['integration']);
		expect(runners('pnpm db:explain')).toEqual(['integration']);
		// The integration job migrates the dev database before its tests, as the combined job did.
		const integration = jobs.find((job) => job.id === 'integration')!.runs;
		expect(integration.indexOf('pnpm db:migrate')).toBeGreaterThan(
			integration.indexOf('pnpm db:setup')
		);
		expect(integration.indexOf('pnpm test:integration')).toBeGreaterThan(
			integration.indexOf('pnpm db:migrate')
		);
		// Unit tests never reach a database, so their job starts none.
		const unit = jobs.find((job) => job.id === 'unit')!.runs;
		expect(unit.filter((run) => /postgres|db:/.test(run))).toEqual([]);
		const job = (id: string) => under(under(ci, 'jobs'), id);
		for (const [id, name] of [
			['unit', 'Unit tests'],
			['integration', 'Integration tests & query plans']
		] as const) {
			expect(value(job(id), 'name'), id).toBe(name);
			expect(value(job(id), 'timeout-minutes'), id).toBe('15');
		}
		// Unit tests run on every event, so a merge to main still fails on a failed test.
		expect(value(job('unit'), 'if'), 'unit').toBeUndefined();
		// Integration tests run on a full run only (the scope job, see CI scope).
		expect(value(job('integration'), 'if'), 'integration').toBe(FULL_ONLY);
	});

	it('report through one check, under its old name, that passes only when both jobs did', () => {
		const checks = under(ci, 'jobs').filter(
			(job) => value(job.children, 'name') === 'Unit & integration tests'
		);
		expect(checks.map((job) => job.text)).toEqual(['test:']);
		const gate = checks[0]!.children;
		expect(value(gate, 'needs')).toBe('[changes, unit, integration]');
		// A skipped required check counts as passed, so on a pull request it runs after a failure
		// or a cancellation too (always(), not !cancelled()).
		expect(value(gate, 'if')).toBe("${{ always() && github.event_name == 'pull_request' }}");
		const steps = stepsOf(gate);
		expect(steps).toHaveLength(1);
		const step = steps[0]!;
		const env = under(step, 'env');
		expect(value(env, 'CHANGES')).toBe('${{ needs.changes.result }}');
		expect(value(env, 'SCOPE')).toBe('${{ needs.changes.outputs.scope }}');
		expect(value(env, 'UNIT')).toBe('${{ needs.unit.result }}');
		expect(value(env, 'INTEGRATION')).toBe('${{ needs.integration.result }}');
		const script = value(step, 'run')!;
		for (const changes of RESULTS) {
			for (const unit of RESULTS) {
				for (const integration of RESULTS) {
					for (const scope of SCOPES) {
						// Passes only when the scope job and unit tests succeeded and the integration
						// tests either passed or were skipped by a light run.
						const passed =
							changes === 'success' &&
							unit === 'success' &&
							(integration === 'success' || (integration === 'skipped' && scope === 'light'));
						expect(
							exitCode(script, {
								CHANGES: changes,
								UNIT: unit,
								INTEGRATION: integration,
								SCOPE: scope
							}),
							`scope job ${changes}, unit ${unit}, integration ${integration}, run scope '${scope}'`
						).toBe(passed ? 0 : 1);
					}
				}
			}
		}
	});
});
