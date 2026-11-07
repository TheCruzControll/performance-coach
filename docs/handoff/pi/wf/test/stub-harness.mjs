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

// ---- dag-cloud.js: one docs-only item and one code item with a two-round Sol loop. ----
const dagArgs = {
	scratch: '/Users/franciscruz/playground/pc-scratch',
	repo: '/Users/franciscruz/playground/performance-coach',
	worktrees: '/Users/franciscruz/playground/pc-wt',
	limit: 2,
	external: { 'dep-open': { branch: 'm4/01-dep-open', pr: 200 } },
	items: [
		{ id: 'docs-profile', kind: 'm2', plan: 'm2-onboarding-plan.json', milestone: 'M2', brief: 'm2.json', branch: 'm2/41-docs-profile', ui: false, migration: false, deps: [], slug: 'm2s29', port: 4679, effort: 'high', docsOnly: true },
		{ id: 'sync-thing', kind: 'plan', plan: 'm4-plan.json', milestone: 'M4', brief: 'm4.json', branch: 'm4/50-sync-thing', ui: true, migration: true, deps: ['dep-open'], slug: 'm4s50', port: 4950, effort: 'xhigh', docsOnly: false }
	]
};
let pr = 300;
const dag = await run('dag-cloud.js', dagArgs, (label) => {
	const [kind, id] = label.split(':');
	if (kind === 'impl') return { id, branch: 'b', base: 'base0', head: 'h1', gates: 'green', mutation: 'tests failed without source', summary: 'done' };
	if (kind === 'sol-r1') return { verdict: 'CHANGES', findings: [{ id: 'S1', severity: 'should', where: 'a.ts:1', claim: 'race', fix: 'await', status: 'new' }], reviewedHead: 'h1', text: 'VERDICT: CHANGES\nS1 [should] a.ts:1 race. Fix: await' };
	if (kind === 'fix-r1') return { ledger: [{ id: 'S1', severity: 'should', outcome: 'fixed', evidence: 'new test fails without fix' }], behaviorChanged: true, head: 'h2', checks: 'green' };
	if (kind === 'sol-r2') return { verdict: 'APPROVE', findings: [{ id: 'S1', severity: 'should', claim: 'race', status: 'resolved' }], reviewedHead: 'h2', text: 'VERDICT: APPROVE' };
	if (kind === 'publish') return { id, prNumber: ++pr, prUrl: `https://github.com/TheCruzControll/performance-coach/pull/${pr}`, summary: 'published' };
	throw new Error(`unexpected agent ${label}`);
});
const byLabel = Object.fromEntries(dag.calls.map((c) => [c.label, c]));
assert.deepEqual(dag.calls.map((c) => c.label).sort(), ['fix-r1:sync-thing', 'impl:docs-profile', 'impl:sync-thing', 'publish:docs-profile', 'publish:sync-thing', 'sol-r1:sync-thing', 'sol-r2:sync-thing'].sort());
for (const c of dag.calls) {
	const reviewer = c.label.startsWith('sol-');
	assert.equal(c.model, reviewer ? 'openai/gpt-6.1-sol' : 'anthropic/claude-opus-5-5', `${c.label} model`);
}
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
assert.deepEqual(dag.result.map((r) => [r.id, typeof r.pr, r.sol]), [['docs-profile', 'number', 'n/a'], ['sync-thing', 'number', 'approved (2)']], 'both items published');
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
