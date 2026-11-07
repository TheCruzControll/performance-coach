// Loads the pi workflow scripts with stubbed hooks and runs them end to end without spawning agents.
//   node test/stub-harness.mjs        (from wf/)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const WF = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = ['mcp__', 'ToolSearch', '/home/user', '<scratch>', '<repo>', 'Claude Code', 'claude.ai', 'pg18', 'Date.now', 'Math.random'];
const OPTION_KEYS = new Set(['label', 'phase', 'model', 'agentType', 'isolation', 'gate', 'resume', 'effort', 'schema']);
const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const family = (model) => model.split('/')[0];

function load(file) {
	const src = readFileSync(join(WF, file), 'utf8');
	for (const s of FORBIDDEN) assert(!src.includes(s), `${file} contains forbidden string ${s}`);
	const m = src.match(/^export const meta = (\{[\s\S]*?\n\});\n/);
	assert(m, `${file} starts with export const meta`);
	const meta = vm.runInNewContext(`(${m[1]})`, Object.create(null));
	assert(meta.name && meta.description && !('whenToUse' in meta), `${file} meta has name, description, no whenToUse`);
	return { src, meta, body: src.slice(m[0].length) };
}

async function run(file, args, answer) {
	const { body, meta, src } = load(file);
	const calls = [];
	let pending = 0;
	const agent = async (prompt, opts = {}) => {
		for (const k of Object.keys(opts)) assert(OPTION_KEYS.has(k), `${file}: agent() option ${k} is not recognised`);
		assert(opts.model, `${file}: ${opts.label} names a model`);
		assert(EFFORTS.has(opts.effort), `${file}: ${opts.label} effort ${opts.effort}`);
		calls.push({ label: opts.label, model: opts.model, effort: opts.effort, prompt });
		pending++;
		await new Promise((r) => setImmediate(r));
		pending--;
		return answer(opts.label, prompt);
	};
	const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));
	const pipeline = (items, ...stages) =>
		Promise.all(items.map(async (it, i) => { let v = it; for (const s of stages) v = await s(v, it, i); return v; }));
	const logs = [];
	const ctx = vm.createContext({
		agent, parallel, pipeline, args, budget: { total: null, spent: () => 0, remaining: () => Infinity },
		phase: (t) => logs.push(`phase ${t}`), log: (m) => logs.push(m), workflow: () => { throw new Error('unused'); },
		console, Promise, JSON, Object, Array, Number, String, Error, setImmediate
	});
	vm.runInContext(
		`Date.now = () => { throw new Error('Date.now breaks resume'); }; Math.random = () => { throw new Error('Math.random breaks resume'); };`,
		ctx
	);
	const result = await vm.runInContext(`(async () => {\n${body}\n})()`, ctx);
	assert.equal(pending, 0, `${file}: every agent() was awaited`);
	console.log(`\n== ${meta.name} (${src.length} bytes) ==`);
	for (const c of calls) console.log(`${c.label.padEnd(44)} ${c.model.padEnd(28)} ${c.effort}`);
	for (const l of logs) console.log(`  log: ${l}`);
	return { calls, result };
}

// ---- dag-cloud.js: a docs-only item; a UI code item with a two-round Sol loop, a red CI round
// and a failed click-through before it passes; a non-UI code item that skips the click-through. ----
const dagArgs = {
	scratch: '/Users/franciscruz/playground/pc-scratch',
	repo: '/Users/franciscruz/playground/performance-coach',
	worktrees: '/Users/franciscruz/playground/pc-wt',
	limit: 2,
	external: { 'dep-open': { branch: 'm4/01-dep-open', pr: 200 } },
	items: [
		{ id: 'docs-profile', kind: 'm2', plan: 'm2-onboarding-plan.json', milestone: 'M2', brief: 'm2.json', branch: 'm2/41-docs-profile', ui: false, migration: false, deps: [], slug: 'm2s29', port: 4679, effort: 'high', docsOnly: true },
		{ id: 'sync-thing', kind: 'plan', plan: 'm4-plan.json', milestone: 'M4', brief: 'm4.json', branch: 'm4/50-sync-thing', ui: true, migration: true, deps: ['dep-open'], slug: 'm4s50', port: 4950, effort: 'xhigh', docsOnly: false, clickThrough: true },
		{ id: 'plain-thing', kind: 'plan', plan: 'm9-plan.json', milestone: 'M9', brief: 'm9.json', branch: 'm9/20-plain-thing', ui: false, migration: false, deps: [], slug: 'm9s20', port: 5920, effort: 'high', docsOnly: false, clickThrough: false }
	]
};
let pr = 300;
const SHOT = '/Users/franciscruz/playground/pc-scratch/shots/m4s50/01-save-iphone.png';
const approve = (head) => ({ verdict: 'APPROVE', findings: [{ id: 'S1', severity: 'should', claim: 'race', status: 'resolved' }], reviewedHead: head, text: 'VERDICT: APPROVE' });
const green = { state: 'green', failing: [], output: 'green (pass 5)' };
const dag = await run('dag-cloud.js', dagArgs, (label) => {
	const [kind, id] = label.split(':');
	const sync = id === 'sync-thing';
	if (kind === 'impl') return { id, branch: 'b', base: 'base0', head: 'h1', gates: 'green', mutation: 'tests failed without source', summary: 'done' };
	if (kind === 'sol-r1' && sync) return { verdict: 'CHANGES', findings: [{ id: 'S1', severity: 'should', where: 'a.ts:1', claim: 'race', fix: 'await', status: 'new' }], reviewedHead: 'h1', text: 'VERDICT: CHANGES\nS1 [should] a.ts:1 race. Fix: await' };
	if (kind === 'sol-r1') return { verdict: 'APPROVE', findings: [], reviewedHead: 'h1', text: 'VERDICT: APPROVE' };
	if (kind === 'fix-r1') return { ledger: [{ id: 'S1', severity: 'should', outcome: 'fixed', evidence: 'new test fails without fix' }], behaviorChanged: true, head: 'h2', checks: 'green' };
	if (kind === 'sol-r2') return approve('h2');
	if (kind === 'publish') return { id, head: sync ? 'h2' : 'h1', prNumber: ++pr, prUrl: `https://github.com/TheCruzControll/performance-coach/pull/${pr}`, summary: 'published' };
	if (kind === 'ci1' && sync) return { state: 'red', failing: [{ name: 'E2E (iPhone viewport)', link: 'https://github.com/TheCruzControll/performance-coach/actions/runs/777/job/888' }], output: 'red' };
	if (kind.startsWith('ci')) return green;
	if (kind === 'fix-ci1') return { ledger: [{ id: 'CI1', severity: 'blocker', outcome: 'fixed', evidence: 'selector raced the toast' }], behaviorChanged: true, head: 'h3', checks: 'green' };
	if (kind === 'sol-r3') return approve('h3');
	if (kind === 'click1') return { verdict: 'fail', items: [{ acceptance: 'Saving shows the saved toast', result: 'fail', did: 'tapped Save', saw: 'no toast', screenshots: [SHOT] }, { acceptance: 'All gates are green.', result: 'not on screen', did: 'n/a', saw: 'CI green' }], stopped: 'killed pid 1', summary: 'one fail' };
	if (kind === 'fix-click1') return { ledger: [{ id: 'CLICK1', severity: 'blocker', outcome: 'fixed', evidence: 'toast was never mounted' }], behaviorChanged: true, head: 'h4', checks: 'green' };
	if (kind === 'sol-r4') return approve('h4');
	if (kind === 'click2') return { verdict: 'pass', items: [{ acceptance: 'Saving shows the saved toast', result: 'pass', did: 'tapped Save', saw: 'toast', screenshots: [SHOT] }], stopped: 'killed pid 2', summary: 'all pass' };
	throw new Error(`unexpected agent ${label}`);
});
const byLabel = Object.fromEntries(dag.calls.map((c) => [c.label, c]));
assert.deepEqual(
	dag.calls.map((c) => c.label).sort(),
	[
		'impl:docs-profile', 'publish:docs-profile', 'ci1:docs-profile',
		'impl:sync-thing', 'sol-r1:sync-thing', 'fix-r1:sync-thing', 'sol-r2:sync-thing', 'publish:sync-thing',
		'ci1:sync-thing', 'fix-ci1:sync-thing', 'sol-r3:sync-thing', 'ci2:sync-thing', 'click1:sync-thing',
		'fix-click1:sync-thing', 'sol-r4:sync-thing', 'ci3:sync-thing', 'click2:sync-thing',
		'impl:plain-thing', 'sol-r1:plain-thing', 'publish:plain-thing', 'ci1:plain-thing'
	].sort()
);
const order = dag.calls.map((c) => c.label).filter((l) => l.endsWith(':sync-thing'));
assert.deepEqual(order.slice(order.indexOf('publish:sync-thing')), ['publish:sync-thing', 'ci1:sync-thing', 'fix-ci1:sync-thing', 'sol-r3:sync-thing', 'ci2:sync-thing', 'click1:sync-thing', 'fix-click1:sync-thing', 'sol-r4:sync-thing', 'ci3:sync-thing', 'click2:sync-thing'], 'CI, then click-through, each failure through a fixer and Sol');
for (const c of dag.calls) {
	const reviewer = c.label.startsWith('sol-');
	assert.equal(c.model, reviewer ? 'openai/gpt-6.1-sol' : 'anthropic/claude-opus-5-5', `${c.label} model`);
}

// Local gates: lint, check, unit, and integration only for migrations or db-layer diffs. No e2e, build or budgets.
const gatesOf = (prompt) => {
	const m = prompt.match(/LOCAL GATES[\s\S]*?Nothing else locally/);
	assert(m, 'prompt carries the local gates');
	return m[0];
};
for (const c of dag.calls.filter((c) => /^(impl|publish|fix-)/.test(c.label))) {
	const g = gatesOf(c.prompt);
	assert(!/playwright|e2e|build|budget|lighthouse/i.test(g), `${c.label}: local gates name no e2e, build or budgets: ${g}`);
	assert(g.includes('pnpm lint') && g.includes('slot pnpm check') && g.includes('pnpm test:unit'), `${c.label}: lint, check, unit`);
	assert(!/playwright test|slot pnpm build|pnpm budgets &&/.test(c.prompt), `${c.label}: no local e2e or build command`);
}
assert(gatesOf(byLabel['impl:sync-thing'].prompt).includes('pnpm test:integration (') && gatesOf(byLabel['impl:sync-thing'].prompt).includes('pnpm db:drift'), 'migration slice runs integration and drift');
assert(gatesOf(byLabel['impl:plain-thing'].prompt).includes('only if the slice\'s diff touches src/lib/server/db'), 'non-migration slice runs integration only for db diffs');
assert(byLabel['impl:sync-thing'].prompt.includes('MUTATION CHECK'), 'mutation check kept');

// CI red: the fixer gets the failing job's log, a fresh Sol round reviews the fix diff, CI runs again.
const ci1 = byLabel['ci1:sync-thing'].prompt;
assert(/wait-ci\.sh \d+ h2`/.test(ci1) && ci1.includes('every 3 minutes for up to 60 minutes') && ci1.includes('Leave the worktree alone'), 'CI watcher');
assert.equal(byLabel['ci1:sync-thing'].effort, 'low');
const fixCi = byLabel['fix-ci1:sync-thing'].prompt;
assert(fixCi.includes('actions/runs/777/job/888') && fixCi.includes('--log-failed'), 'CI fixer reads the failing log');
assert(fixCi.includes('no --fixup, amend, rebase or force-push') && fixCi.includes('git push origin m4/50-sync-thing') && fixCi.includes('Sol review pending'), 'CI fixer pushes new commits and marks Sol pending');
assert(byLabel['sol-r3:sync-thing'].prompt.includes('git diff h2 h3'), 'Sol round reviews the CI fix diff');
assert(byLabel['ci2:sync-thing'].prompt.includes('Reviewed with sol-review: 3 rounds with GPT-6.1 Sol on xhigh. Sol verdict: approved'), 'CI watcher restores the Sol line');

// Click-through: fresh Opus verifier on the production build; a fail goes to a fixer and Sol, then CI and click-through again.
const click = byLabel['click1:sync-thing'];
assert.equal(click.model, 'anthropic/claude-opus-5-5');
assert.equal(click.effort, 'medium');
for (const s of ['slot pnpm build:node', 'headless: false', "devices['iPhone 15 Pro']", '1440 × 900', 'ENABLE_TEST_ROUTES=true', 'OWNER_SETUP_TOKEN_HASH', 'never', 'source /Users/franciscruz/playground/pc-scratch/env/m4s50.sh', '/Users/franciscruz/playground/pc-scratch/shots/m4s50', '## Click-through', 'lsof -ti tcp:4950', 'PORT=4950', '/Users/franciscruz/playground/pc-wt/m4s50/node_modules/@playwright/test/index.mjs'])
	assert(click.prompt.includes(s), `click-through brief has ${s}`);
assert(/Never read, print or use the real owner setup token/.test(click.prompt), 'never the real setup token');
const fixClick = byLabel['fix-click1:sync-thing'].prompt;
assert(fixClick.includes('Saving shows the saved toast') && fixClick.includes(SHOT) && !fixClick.includes('All gates are green.. Did'), 'click fixer gets only the failed items');
assert(byLabel['sol-r4:sync-thing'].prompt.includes('git diff h3 h4'), 'Sol round reviews the click fix diff');
assert(byLabel['click2:sync-thing'].prompt.includes('head h4') && byLabel['click2:sync-thing'].prompt.includes('round 2'), 'click-through rechecks the new head');
assert(byLabel['ci3:sync-thing'].prompt.includes('Sol review pending') && byLabel['ci3:sync-thing'].prompt.includes('4 rounds'), 'CI watcher restores the Sol line after the click fix');
// Non-UI and docs slices skip the click-through and the green CI watcher removes their worktree.
assert(byLabel['ci1:plain-thing'].prompt.includes('worktree remove --force /Users/franciscruz/playground/pc-wt/m9s20'), 'non-UI watcher cleans up');
assert(byLabel['ci1:docs-profile'].prompt.includes('worktree remove --force /Users/franciscruz/playground/pc-wt/m2s29'), 'docs watcher cleans up');
assert(!byLabel['publish:sync-thing'].prompt.includes('worktree remove'), 'publish keeps the worktree');
assert.notEqual(family(byLabel['sol-r1:sync-thing'].model), family(byLabel['impl:sync-thing'].model), 'author and reviewer differ in family');
assert.equal(byLabel['impl:docs-profile'].effort, 'medium');
assert.equal(byLabel['impl:sync-thing'].effort, 'high');
assert.equal(byLabel['fix-r1:sync-thing'].effort, 'high');
assert.equal(byLabel['sol-r1:sync-thing'].effort, 'xhigh');
const pubCode = byLabel['publish:sync-thing'].prompt;
const pubDocs = byLabel['publish:docs-profile'].prompt;
assert(pubCode.includes('Reviewed with sol-review: 2 rounds with GPT-6.1 Sol on xhigh. Sol verdict: approved'), 'Sol line');
assert(pubCode.includes('`Depends on #200.`'), 'dependency line');
assert(pubDocs.includes('sol-review: not applicable (docs only).'), 'docs-only line');
for (const p of [pubCode, pubDocs]) {
	assert(p.includes('Created with Claude Opus 5.5 in pi.'), 'PR body footer');
	assert(p.includes('gh pr create --repo TheCruzControll/performance-coach --base main --head '), 'gh pr create');
	assert(p.includes('Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>') && !p.includes('Claude-Session'), 'trailer');
}
const impl = byLabel['impl:sync-thing'].prompt;
assert(impl.includes("test.use({ serviceWorkers: 'block' })") && impl.includes("document.fonts.status === 'loaded'"), 'WebKit rules kept');
assert(impl.includes('/Users/franciscruz/playground/pc-wt/m4s50') && impl.includes('localhost:5432') && !impl.includes('5433'), 'Mac paths and one Postgres');
assert.deepEqual(
	dag.result.map((r) => [r.id, typeof r.pr, r.sol, r.ci, r.clickThrough, r.ready]),
	[
		['docs-profile', 'number', 'n/a', 'green', 'n/a', true],
		['sync-thing', 'number', 'approved (4)', 'green', 'pass', true],
		['plain-thing', 'number', 'approved (1)', 'green', 'n/a', true]
	],
	'every item published, CI green, click-through passed or n/a'
);
assert(dag.result.every((r) => !('checks' in r)), 'no promise leaks into the result');

// Not ready: CI red three times, and a click-through that fails three times.
const stuck = await run('dag-cloud.js', { ...dagArgs, external: {}, items: [{ ...dagArgs.items[2], deps: [] }, { ...dagArgs.items[1], id: 'ui-stuck', deps: [], effort: 'high' }] }, (label) => {
	const [kind, id] = label.split(':');
	if (kind === 'impl') return { id, branch: 'b', base: 'base0', head: 'h1', gates: 'green', mutation: 'ok', summary: 'done' };
	if (kind.startsWith('sol-')) return approve('hx');
	if (kind === 'publish') return { id, head: 'h1', prNumber: ++pr, prUrl: 'u', summary: 'published' };
	if (kind.startsWith('ci')) return id === 'plain-thing' ? { state: 'red', failing: [{ name: 'Unit', link: 'https://x/runs/1/job/2' }] } : green;
	if (kind.startsWith('fix-')) return { ledger: [], behaviorChanged: true, head: `h-${kind}`, checks: 'green' };
	if (kind.startsWith('click')) return { verdict: 'fail', items: [{ acceptance: 'x', result: 'fail', did: 'd', saw: 's' }], stopped: 'ok', summary: 'fail' };
	throw new Error(`unexpected agent ${label}`);
});
assert.deepEqual(stuck.result.map((r) => [r.id, r.ci, r.clickThrough, r.ready]), [['plain-thing', 'red', 'not run', false], ['ui-stuck', 'green', 'fail', false]], 'never ready while CI is red or the click-through fails');
assert.equal(stuck.calls.filter((c) => c.label.startsWith('ci') && c.label.endsWith(':plain-thing')).length, 3, 'at most 3 CI rounds');
assert.equal(stuck.calls.filter((c) => c.label.startsWith('click') && c.label.endsWith(':ui-stuck')).length, 3, 'at most 3 click-throughs');
console.log('result:', JSON.stringify(dag.result));

// ---- councils.js: round 1 below the bar (chair + improve), round 2 at the bar. ----
const BAR = 8.7;
let round = 0;
const councils = await run('councils.js', { scratch: dagArgs.scratch, repo: dagArgs.repo, branch: 'council-test', label: 'test', scope: 'all', maxRounds: 2, bar: BAR }, (label, prompt) => {
	assert(!prompt.includes(String(BAR)), 'the bar never reaches a prompt');
	if (label.startsWith('capture')) return (round++, 'bundle ready');
	if (label.startsWith('review')) return { role: 'x', score: round === 1 ? 7 : 9, verdict: 'ok', strengths: [], issues: [] };
	if (label.startsWith('chair')) return { disagreements: [], workItems: [{ title: 'a', council: 'design', impact: 'high', problem: 'p', change: 'c', verification: 'v' }, { title: 'b', council: 'performance', impact: 'low', problem: 'p', change: 'c', verification: 'v' }], rejected: [] };
	if (label.startsWith('improve')) {
		assert(prompt.includes('Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>') && !prompt.includes('Claude-Session'), 'council trailer');
		return 'done';
	}
	throw new Error(`unexpected agent ${label}`);
});
const judges = councils.calls.filter((c) => c.label.startsWith('review:'));
assert.equal(judges.filter((c) => c.model === 'openai/gpt-6.1-sol').length, 10, 'half of 20 judge calls are Sol');
assert.equal(judges.filter((c) => c.model === 'anthropic/claude-opus-5-5').length, 10, 'half of 20 judge calls are Opus');
assert.equal(councils.result.satisfied, true);
console.log('\nall assertions passed');
