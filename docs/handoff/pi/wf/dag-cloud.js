export const meta = {
	name: 'dag-cloud',
	description:
		'Build-graph slices as small stacked PRs: implement + mutation check (Claude Opus 5.5), a sol-review fix loop with a fresh GPT-6.1 Sol reviewer each round, then gates, push and a PR with gh. args.resume continues slices whose first Sol rounds are done',
	phases: [
		{ title: 'Implement', detail: 'each slice once its dependencies have PRs, stacked on their branches; critical path first' },
		{ title: 'Sol', detail: 'sol-review fix loop: a fresh reviewer each round, then the smallest fixes' },
		{ title: 'Publish', detail: 'fold fixups, gates, push, PR with gh pr create' }
	]
};

// ---- Priority limiter: at most args.limit agents at once; the waiting task with the highest
// priority (the longest chain of slices still depending on it) runs next. ----
function makeLimiter(n) {
	let active = 0;
	const q = [];
	const next = () => {
		while (active < n && q.length) {
			q.sort((a, b) => b.prio - a.prio || a.seq - b.seq);
			const { fn, res, rej } = q.shift();
			active++;
			fn()
				.then(res, rej)
				.finally(() => {
					active--;
					next();
				});
		}
	};
	let seq = 0;
	return (prio, fn) =>
		new Promise((res, rej) => {
			q.push({ fn, res, rej, prio, seq: seq++ });
			next();
		});
}
const limit = makeLimiter(args.limit || 2);

if (!args.scratch || !args.repo) throw new Error('args.scratch and args.repo (absolute paths) are required');
const S = args.scratch;
const BIN = `${S}/bin`;
const MAIN = args.repo; // the main checkout (never modified by agents)
const WT = args.worktrees || `${S}/wt`;
const R = 'repos/TheCruzControll/performance-coach';
// Author and reviewer stay different model families. Every commit is written by AUTHOR.
const AUTHOR = { model: 'anthropic/claude-opus-5-5', name: 'Claude Opus 5.5' };
const REVIEWER = { model: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol' };
const TRAILER = `Co-Authored-By: ${AUTHOR.name} <noreply@anthropic.com>`;
// it.effort is the Sol effort: xhigh for auth, security, data loss and concurrency slices, high otherwise.
const authorEffort = (it) => (it.effort === 'xhigh' ? 'high' : 'medium');
const M3PLAN = `${S}/plans/m3-plan.json`;
const M2PLAN = `git -C ${MAIN} show origin/handoff:docs/handoff/briefs/m2-onboarding-plan.json`;
const envf = (slug) => `${S}/env/${slug}.sh`;

const EXTERNAL = args.external; // id -> {merged:true} | {branch, pr}
const ITEMS = args.items; // [{id, kind: m2|m3|task, branch, ui, migration, deps, slug, port, effort, docsOnly?, task?, boost?}]
const byId = Object.fromEntries(ITEMS.map((x) => [x.id, x]));

const dependents = {};
for (const it of ITEMS) for (const d of it.deps) (dependents[d] = dependents[d] || []).push(it.id);
const depthMemo = {};
const depth = (id) => {
	if (depthMemo[id] !== undefined) return depthMemo[id];
	depthMemo[id] = 0;
	const kids = dependents[id] || [];
	depthMemo[id] = kids.length ? 1 + Math.max(...kids.map(depth)) : 0;
	return depthMemo[id];
};
const prio = (it) => depth(it.id) * 10 + (it.kind === 'm2' ? 5 : 0) + (it.boost || 0);

const MACHINE = (slug, port) => `MACHINE RULES (an 8-CPU, 8 GB macOS laptop shared by several agents; memory is the tight resource):
- Work only in your worktree ${WT}/${slug} (never in ${MAIN} or another worktree). Run \`bash ${BIN}/agent-env ${slug} ${port}\` once inside it (safe to re-run), then prefix every node/pnpm command with \`source ${envf(slug)} && \`. Your e2e port is ${port}. Postgres 18 (Homebrew) runs on localhost:5432 (role coach/coach), the same major version CI and production run.
- Heavy commands (svelte-check, vite build, Playwright) go through \`slot\` (at most two machine-wide; expect to wait). If slot gives up waiting it exits non-zero without running the command: run it again through slot later, never without it. Give heavy Bash calls timeout 600000. A git command that fails on a lock (another agent fetching) is retried after a moment.
- WebKit-only traps (CI runs Linux WebKit; this Mac's Playwright WebKit is macOS WebKit and behaves differently, so CI is the WebKit gate): (a) an e2e test that holds, fails or fulfils a request with page.route must run with the service worker blocked (\`test.use({ serviceWorkers: 'block' })\` in a describe, as profile-goals and train-week do), because on WebKit page.route does not see requests from a page the service worker controls; (b) wait on \`document.fonts.status === 'loaded'\`, never \`document.fonts.ready\`, while a request is held (WebKit resolves it only after the load event).
- Run only the e2e specs you touch or add; never the full suite, never --repeat-each above 3, never the 'perf' or 'exclusive' projects. Kill servers and browsers you start. Never \`playwright install\`: Chromium and WebKit are installed. Run e2e on Chromium; leave E2E_WEBKIT unset unless you are chasing a WebKit-only failure, and know that three e2e/shell.e2e.ts tests fail on macOS WebKit only (CI runs Chromium + Linux WebKit + Lighthouse on every PR and is the final gate).
- GitHub: \`gh\` is authenticated as TheCruzControll; read with \`gh api ${R}/...\`. The only GitHub write you ever make is creating your slice's PR with \`gh pr create\` in the publish step. You are a child agent: never subscribe to or watch PRs, never merge, never post PR comments, never edit other PRs, never touch Vercel, Neon or GitHub settings.
- Shared docs belong to the milestone's docs slice: a code slice does NOT edit docs/testing.md, docs/security.md, docs/performance.md or docs/milestones.md at all (one edit there makes every other open PR stale and forces another CI run for each). Put the exact lines that belong there in a "## Docs to add" section of the PR body (target file and section for each); the milestone's docs slice adds them. If your branch already edits those files (an earlier session's work), move those edits into that section and restore the files to the base. Docs-only slices are the exception: they own those files and collect the "## Docs to add" sections from the milestone's merged PRs (\`gh api "${R}/pulls?state=closed&per_page=100"\` bodies). Registries and lists other parallel slices also extend (section registries, route-access tables, design-system rows): add your entry as its own line, never reformat neighbours.`;

const PROJECT = `Project: "Performance Coach" (GitHub TheCruzControll/performance-coach), a private single-user AI training PWA: SvelteKit 3 / Svelte 5 runes, TypeScript strict, Postgres + Drizzle, passkeys, Vercel. Spec: docs/product-requirements.md. Read what you need: docs/architecture.md (layers and import boundaries), docs/testing.md, docs/design-system.md, docs/performance.md (budgets), docs/agent-architecture.md. The owner's rules: each PR is ONE small atomic concern (ideally ≤ 600 non-test lines), green on its own, no drive-by refactors, real tests that prove behaviour (a regression test must fail without its fix), premium UI per docs/design-system.md (dark-first + light, existing primitives, 44 px targets, designed empty/loading/error states, axe-clean). DESKTOP TOO (owner request, PRD §7 and §16): every screen is iPhone-first but must also be laid out for a desktop browser (1440 × 900: navigation rail, content centred at a readable width, no stretched phone layout, hover and keyboard focus states); follow docs/design-system.md's breakpoint rules where they exist, and when a \`desktop-chromium\` Playwright project exists, run your UI specs on it too. Drizzle migrations: \`pnpm db:generate\` only; the journal order is enforced by a unit test. One query at a time per Executor (main since #62, docs/architecture.md): never \`Promise.all\` over one \`db\` handle or one transaction; await each query in turn (separate pool calls may run together). The integration setup fails any test that sends a query to a busy pg client, so merge origin/main before your gates.`;

const specFor = (it) => {
	if (it.kind === 'm3')
		return `YOUR SLICE is M3 plan slice '${it.id}' (branch ${it.branch}). Read it in full: \`jq '.slices[] | select(.id=="${it.id}")' ${M3PLAN}\` (goal, newOrChanged, tests, acceptance, risks, estNonTestLines), and the plan's decisions: \`jq -r '.decisions[]' ${M3PLAN}\` (measured budget facts, layer and naming decisions you must follow). Where the plan's openQuestions (\`jq -r '.openQuestions[]' ${M3PLAN}\`) touch your slice, implement the plan's stated default as a named, documented constant or decision so the owner can change it cheaply. The brief behind it: \`git -C ${MAIN} show origin/handoff:docs/handoff/briefs/m3.json\`. PR title = the slice's title.${it.migration ? ' MIGRATIONS: you add a migration; keep the journal in order after every migration already on main and in the PRs you stack on (regenerate yours if main gained one; ADR 0010 docs/adr describes keeping custom guard SQL through a regenerate).' : ''}`;
	if (it.kind === 'm2')
		return `YOUR SLICE is M2 onboarding-plan slice '${it.id}' (branch ${it.branch}). Read it in full: \`${M2PLAN} | jq '.slices[] | select(.id=="${it.id}")'\` and the plan's \`.wipAssessment\` (budget facts, WIP bugs not to carry over). WIP code it may reuse: commit d8bfded (\`git show d8bfded:<path>\`); take only what the slice lists. Main has moved on since the plan was written: the security fixes it mentions are merged (malformed ids, goal status, section-save locks, onboarding progress validation, the body-weight time zone, step-up re-authentication), the input primitives (NumberField, TextArea, date TextField, ChoiceGroup, DayPicker, Toggle, TagInput) exist, and the JSON save path is in; build on what is on main and in the PRs you stack on, not on the plan's assumptions. PR title = the slice's title.`;
	if (it.kind === 'plan') {
		const P = `${S}/plans/${it.plan}`;
		return `YOUR SLICE is ${it.milestone} plan slice '${it.id}' (branch ${it.branch}). Read it in full: \`jq '.slices[] | select(.id=="${it.id}")' ${P}\` (goal, newOrChanged, tests, acceptance, risks, estNonTestLines), and the plan's decisions: \`jq -r '.decisions[]' ${P}\` (layer, naming, budget and architecture decisions you must follow). Where the plan's openQuestions (\`jq -r '.openQuestions[]' ${P}\`) touch your slice, implement the plan's stated default as a named, documented constant or decision so the owner can change it cheaply, and list the question in the PR body under "## Owner decisions" with the default you chose. The brief behind it: \`git -C ${MAIN} show origin/handoff:docs/handoff/briefs/${it.brief}\`. Slices of earlier milestones it depends on are described in ${S}/plans/m3-plan.json (and the M2 onboarding plan, \`${M2PLAN}\`). PR title = the slice's title.${it.migration ? ' MIGRATIONS: you add a migration; keep the journal in order after every migration already on main and in the PRs you stack on (regenerate yours if main gained one; ADR 0010 docs/adr describes keeping custom guard SQL through a regenerate).' : ''}${it.extra ? `\n${it.extra}` : ''}`;
	}
	return `YOUR ITEM (${it.id}):\n${it.task}`;
};

const COMMITS = `Commits: Conventional Commits; subject, blank line, short plain-prose body (problem, then change); end every message with exactly this trailer line:\n${TRAILER}\nMention no AI model anywhere except that trailer and the PR description lines.`;
const GATES = (slug, ui, migration) =>
	`GATES (each with \`source ${envf(slug)} && \`): pnpm lint; slot pnpm check; pnpm test:unit; pnpm db:reset:test && pnpm test:integration (local Postgres 18, the version CI and production run, so assert what 18 does, e.g. an ON DELETE RESTRICT refusal is 23001; tests/integration/helpers.ts restrictRefusalCode); ${migration ? 'pnpm db:drift; ' : ''}${ui ? 'slot pnpm build:node && pnpm budgets (paste the rows for the routes you touched and /profile/security); slot pnpm build; the e2e specs you touched or added on Chromium (`slot pnpm exec playwright test <specs> --project=setup --project=iphone-chromium --reporter=line`)' : 'e2e only if you touched routes, components or anything the browser loads (Chromium, as above)'}. Report real output excerpts.`;

const OUT = {
	type: 'object',
	properties: {
		id: { type: 'string' },
		branch: { type: 'string' },
		base: { type: 'string', description: 'commit sha whose tree has everything the slice builds on and none of its own changes' },
		head: { type: 'string' },
		prNumber: { type: 'number' },
		prUrl: { type: 'string' },
		gates: { type: 'string' },
		mutation: { type: 'string' },
		summary: { type: 'string' },
		problems: { type: 'string' }
	},
	required: ['id', 'summary']
};
const REVIEW_OUT = {
	type: 'object',
	properties: {
		verdict: { type: 'string', enum: ['APPROVE', 'CHANGES'] },
		findings: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'stable id: S1, S2, … (keep earlier ids)' },
					severity: { type: 'string', enum: ['blocker', 'should', 'nit'] },
					where: { type: 'string', description: 'file:line' },
					claim: { type: 'string' },
					fix: { type: 'string' },
					status: { type: 'string', enum: ['new', 'still open', 'resolved'] },
					reason: { type: 'string' }
				},
				required: ['id', 'severity', 'claim', 'status']
			}
		},
		reviewedHead: { type: 'string', description: 'git rev-parse HEAD of the worktree when you reviewed' },
		text: { type: 'string', description: 'your reply in the VERDICT / S1 format' }
	},
	required: ['verdict', 'findings', 'reviewedHead', 'text']
};
const FIX_OUT = {
	type: 'object',
	properties: {
		ledger: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					severity: { type: 'string' },
					outcome: { type: 'string', enum: ['fixed', 'disagree', 'declined'] },
					evidence: { type: 'string' }
				},
				required: ['id', 'severity', 'outcome', 'evidence']
			}
		},
		behaviorChanged: { type: 'boolean' },
		head: { type: 'string' },
		checks: { type: 'string' },
		shortstat: { type: 'string' }
	},
	required: ['ledger', 'behaviorChanged', 'head', 'checks']
};

const ledgerLines = (ledger) =>
	Object.values(ledger)
		.map((l) => `${l.outcome}: ${l.id} [${l.severity}] ${l.evidence}`)
		.join('\n') || '(empty)';

function reviewBrief(it, impl, r, ledger, prevHead, head) {
	const wt = `${WT}/${it.slug}`;
	const round1 = `Review only. Do not edit, commit, push, comment on PRs, start subagents, or use the sol-review or council skills.
Repo: ${wt} Base: ${impl.base} Head: ${head}
Intent: ${it.id}: the slice below must do exactly what its goal and acceptance say, with tests that prove it.
${specFor(it)}
Out of scope: anything outside this slice's goal (its stacked dependencies are reviewed in their own PRs); prose style.
Checks: ${impl.gates || 'see the implementer report'}
See: git diff ${impl.base} ${head} (run it in the repo above; the worktree is checked out at the head: read files there, or with git show ${head}:<path>).
Read surrounding code. Find bugs, broken callers, mismatch with intent.
Skip style unless it hides a bug. Hold to the smallest change. Flag code,
tests, or guards the intent does not need. Other paths, rare cases, small
perf, extra compat: nits.
blocker = intended case wrong. should = real bug callers will hit, in intent. nit = rest.
VERDICT is APPROVE when no blocker or should remains open (nits alone never make it CHANGES).
Reply:
VERDICT: APPROVE or CHANGES
S1 [blocker|should|nit] <file>:<line> <claim>. Fix: <suggestion> (stable ids)
Return that reply through the structured output: verdict, findings (id, severity, where, claim, fix, status), reviewedHead (\`git -C ${wt} rev-parse HEAD\`), and text (the reply itself).`;
	if (r === 1) return round1;
	return `${round1}

Round ${r}. Ledger from the earlier rounds (the branch owner's answers):
${ledgerLines(ledger)}
Same base diff as before: git diff ${impl.base} ${head}. The change since your last round: git diff ${prevHead} ${head}.
Open ids and changed code only. Mark each old id resolved or still open: <reason> (status "resolved" or "still open", reason in "reason"). New findings get new ids continuing the numbering.`;
}

async function solLoop(it, impl, p, start = 1, ledger0 = {}, prevHead0 = null, head0 = null) {
	const max = it.effort === 'xhigh' ? 5 : 3;
	const ledger = { ...ledger0 };
	const disputed = {};
	for (const l of Object.values(ledger0)) if (l.outcome === 'disagree') disputed[l.id] = 1;
	let prevHead = prevHead0;
	let head = head0 || impl.head || 'HEAD';
	for (let r = start; r <= max; r++) {
		const rev = await limit(p + 2, () =>
			agent(reviewBrief(it, impl, r, ledger, prevHead, head), {
				label: `sol-r${r}:${it.id}`,
				phase: 'Sol',
				model: REVIEWER.model,
				effort: it.effort,
				schema: REVIEW_OUT
			})
		);
		if (!rev) return { approved: false, rounds: r, ledger, disputes: `round ${r}: the reviewer gave no reply` };
		const open = (rev.findings || []).filter((f) => f.status !== 'resolved' && f.severity !== 'nit');
		if (rev.verdict === 'APPROVE' && open.length === 0) return { approved: true, rounds: r, ledger, disputes: '', lastReview: rev.text };
		const stuck = open.filter((f) => (disputed[f.id] || 0) >= 2);
		if (stuck.length)
			return { approved: false, rounds: r, ledger, disputes: `stuck after two replies: ${stuck.map((f) => `${f.id} [${f.severity}] ${f.claim} (Sol: ${f.reason || ''})`).join(' | ')}`, lastReview: rev.text };
		if (r === max)
			return { approved: false, rounds: r, ledger, disputes: `budget ended with open: ${open.map((f) => `${f.id} [${f.severity}] ${f.claim}`).join(' | ')}`, lastReview: rev.text };
		const fix = await limit(p + 2, () =>
			agent(
				`${PROJECT}

${specFor(it)}
${MACHINE(it.slug, it.port)}
You own branch ${it.branch} in ${WT}/${it.slug}: the fix-loop owner in the sol-review skill (its section 3, "Answer findings"). Its own changes start at BASE ${impl.base}. Sol, round ${r}, reviewed ${rev.reviewedHead} and replied:
${rev.text}
Findings: ${JSON.stringify(rev.findings)}
Ledger from earlier rounds:
${ledgerLines(ledger)}
For every finding that is not resolved, check the finding and its severity yourself (another path, rare case or small cost is a nit, whatever label it came with):
- Agree: make the smallest fix (prefer deleting or narrowing over a new lock, cache, helper or option); fix the case that happened; add ONE focused test that fails without the fix when the intent needs it. Commit each fix with \`git commit --fixup=<the slice commit it belongs to>\` (keep the trailer line in the message body).
- Disagree: say why, with evidence (file:line, a test, command output).
- Out of scope or nit: decline in one line (a follow-up).
Do not agree just to end the loop; push back on scope creep with evidence. Re-run the checks that cover what you changed, and \`git diff --shortstat ${impl.base}\`; if review grew the diff, cut first. Do not push. Leave the tree clean.
Report one ledger entry per finding you answered (id, severity as you judge it, outcome fixed|disagree|declined, evidence), behaviorChanged (did any non-test code change?), head (\`git rev-parse HEAD\`), checks (real output excerpts) and shortstat.`,
				{ label: `fix-r${r}:${it.id}`, phase: 'Sol', schema: FIX_OUT, model: AUTHOR.model, effort: authorEffort(it) }
			)
		);
		if (!fix) return { approved: false, rounds: r, ledger, disputes: `round ${r}: the fixer failed`, lastReview: rev.text };
		for (const l of fix.ledger || []) {
			ledger[l.id] = l;
			if (l.outcome === 'disagree') disputed[l.id] = (disputed[l.id] || 0) + 1;
		}
		prevHead = rev.reviewedHead;
		head = fix.head || head;
	}
	return { approved: false, rounds: max, ledger, disputes: 'loop ended' };
}

const solLine = (it, sol) => {
	if (it.docsOnly) return '`sol-review: not applicable (docs only).`';
	if (sol.approved) return `exactly \`Reviewed with sol-review: ${sol.rounds} rounds with ${REVIEWER.name} on ${it.effort}. Sol verdict: approved\``;
	return 'NO sol-review line (Sol did not approve; the main thread decides): instead add a "Sol review" section stating the open disputes in 2-3 lines each';
};

async function doItem(it, deps) {
	const open = deps.filter((d) => !d.merged);
	const depPrs = open.map((d) => d.pr);
	const p = prio(it);
	const fresh = open.length
		? `\`git -C ${MAIN} worktree add ${WT}/${it.slug} -b ${it.branch} origin/${open[0].branch}\`${open
				.slice(1)
				.map((d) => `, then in the worktree \`git merge --no-edit origin/${d.branch}\``)
				.join('')}${open.length > 1 ? " (resolve any conflict between the stacked dependencies carefully, keeping both sides' intent, and run the gates on the merged base)" : ''}. Your slice stacks on the open PR(s) ${depPrs.map((n) => `#${n}`).join(', ')}; they merge first.`
		: `\`git -C ${MAIN} worktree add ${WT}/${it.slug} -b ${it.branch} origin/main\`.`;
	const prep = `\`git -C ${MAIN} fetch -q origin\`. RESUME CHECK FIRST: an earlier session may have started this slice. If ${WT}/${it.slug} exists, or branch ${it.branch} exists locally (\`git -C ${MAIN} branch --list ${it.branch}\`) or on origin, reuse it: if the worktree is gone, \`git -C ${MAIN} worktree add ${WT}/${it.slug} ${it.branch}\` (or \`-b ${it.branch} origin/${it.branch}\`); look at its commits and uncommitted changes and keep what is right; merge origin/main${open.length ? ' and the open dependency branches (' + open.map((d) => 'origin/' + d.branch).join(', ') + ')' : ''} into it (message "Merge main into ${it.branch}"); a last commit titled \`wip(handoff): …\` is unfinished, ungated and unreviewed: finish it and fold it into real Conventional Commits (e.g. \`git reset --soft\` to the commit before it and recommit) before reporting. If a PR already exists for ${it.branch} (\`gh api "${R}/pulls?head=TheCruzControll:${it.branch}&state=all"\`), report its number and stop. Otherwise start fresh: ${fresh}
BASE: record a commit whose tree has everything the slice builds on (origin/main${open.length ? ' and every open dependency branch' : ''}) and none of the slice's own changes, so \`git diff BASE HEAD\` shows exactly the slice. Fresh branch: \`git rev-parse HEAD\` right after the worktree is created and the dependencies are merged, before any change of yours. Resumed branch (after merging as above): build it with \`git commit-tree $(git merge-tree --write-tree origin/main <dependency tip>) -p origin/main -p <dependency tip> -m base\` (chain for more dependencies; with none, BASE = \`git merge-base HEAD origin/main\`), and check \`git diff --stat BASE HEAD\` lists only the slice's files.`;
	const resumed = (args.resume || {})[it.id];
	const impl = resumed ? resumed.impl : await limit(p, () =>
		agent(
			`${PROJECT}

${specFor(it)}
${MACHINE(it.slug, it.port)}
START: ${prep}
Implement it exactly as specified (its tests and acceptance are the definition of done), test-first where it fits.
${GATES(it.slug, it.ui, it.migration)}
${it.docsOnly ? 'Docs only: re-verify every changed claim against the repo and `gh` (no mutation check).' : `MUTATION CHECK: revert only the non-test source changes (\`git stash\` the source files, or \`git checkout <BASE> -- <source files>\` in a scratch copy); the new tests must FAIL for the right reason; restore; they PASS. Strengthen weak tests. Report what failed.`}
${COMMITS} Commit on ${it.branch}; do not push. Leave the tree clean.
Report id="${it.id}", branch, base (the BASE sha), head (\`git rev-parse HEAD\`), prNumber if a PR already existed, a summary with the non-test line count (\`git diff --stat <BASE> HEAD -- . ':!*.test.ts' ':!e2e' ':!tests' ':!drizzle/meta'\`), gates and mutation.`,
			{ label: `impl:${it.id}`, phase: 'Implement', schema: OUT, model: AUTHOR.model, effort: authorEffort(it) }
		)
	);
	if (impl && impl.prNumber) return { id: it.id, branch: it.branch, pr: impl.prNumber, existed: true };
	if (!impl || !impl.base) return { id: it.id, error: 'implementer failed', impl };

	const sol = it.docsOnly ? { approved: false, rounds: 0, ledger: {}, disputes: '' } : await solLoop(it, impl, p, resumed ? resumed.round : 1, resumed ? resumed.ledger : {}, resumed ? resumed.prevHead : null, resumed ? resumed.head : null);
	if (!it.docsOnly) log(`${it.id}: Sol ${sol.approved ? `approved in ${sol.rounds} round(s)` : `not approved (${sol.disputes})`}`);

	let pub = await limit(p + 3, () =>
		agent(
			`${PROJECT}

${specFor(it)}
${MACHINE(it.slug, it.port)}
Branch ${it.branch} in ${WT}/${it.slug} is implemented${it.docsOnly ? '' : ' and reviewed'} and committed, not pushed. Its own changes start at BASE ${impl.base}. Implementer report: ${JSON.stringify(impl)}
Sol ledger: ${ledgerLines(sol.ledger)}
1. Fold fixups: if \`git log --format=%s ${impl.base}..HEAD | grep -c '^fixup!'\` is not 0, run \`GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash --rebase-merges ${impl.base}\`; afterwards no subject may start with fixup! or wip.
2. Conflicts with main: \`git fetch -q origin && git merge-tree --write-tree origin/main HEAD\`; if it reports conflicts, \`git merge origin/main\` (message "Merge main into ${it.branch}"), resolve keeping both sides' intent, and run the gates on the result.
3. ${GATES(it.slug, it.ui, it.migration)} ${COMMITS}
4. Push: \`git push -u origin ${it.branch}\`. If origin already has ${it.branch} with other history (an earlier session's WIP push) and no PR exists for it, use \`git push --force-with-lease -u origin ${it.branch}\`. Retry network errors up to 4 times (2 s, 4 s, 8 s, 16 s).
5. PR (the file-pr skill's rules): first check none is open (\`gh api "${R}/pulls?head=TheCruzControll:${it.branch}&state=open"\`). Title: a concise human-readable Conventional Commit saying why it matters (the plan's title is a good start). Body, written to ${S}/pr-bodies/${it.slug}.md first (mkdir -p the directory): it opens with the problem or need in plain words, then the change (no implementation inventory); a short "## Tests" section (what the tests prove, the gates run, the mutation check); a "## Budgets" section with the rows if you touched the UI; ${depPrs.length ? `then one line per open dependency, exactly: ${depPrs.map((n) => `\`Depends on #${n}.\``).join(' ')}; ` : ''}then ${solLine(it, sol)}; then, last, exactly \`Created with ${AUTHOR.name} in pi.\`
Check the title and body for secrets and private details. Create a NON-draft PR: \`gh pr create --repo TheCruzControll/performance-coach --base main --head ${it.branch} --title "<title>" --body-file ${S}/pr-bodies/${it.slug}.md\` (it prints the PR URL; the number is its last path segment).
6. \`git -C ${MAIN} worktree remove --force ${WT}/${it.slug}\`; kill any server or browser you started.
Report id="${it.id}", branch, PR number and URL, gates, summary, problems.`,
			{ label: `publish:${it.id}`, phase: 'Publish', schema: OUT, model: AUTHOR.model, effort: 'medium' }
		)
	);
	if (!pub || !pub.prNumber) {
		// A publish can stop on a permission refusal (e.g. a force-push) that the main thread then
		// resolves by hand: look the PR up before failing the slice and every slice that waits on it.
		const found = await limit(p + 3, () =>
			agent(
				`Look up the open pull request for branch ${it.branch} of TheCruzControll/performance-coach: \`gh api "${R}/pulls?head=TheCruzControll:${it.branch}&state=open" --jq '.[0] | {number, html_url}'\`. Report prNumber and prUrl (omit both if there is none). Change nothing.`,
				{
					label: `lookup:${it.id}`,
					phase: 'Publish',
					model: AUTHOR.model,
					effort: 'low',
					schema: { type: 'object', properties: { prNumber: { type: 'number' }, prUrl: { type: 'string' } } }
				}
			)
		);
		if (found && found.prNumber) pub = { ...(pub || {}), prNumber: found.prNumber, prUrl: found.prUrl };
	}
	if (!pub || !pub.prNumber) return { id: it.id, branch: it.branch, error: 'publish failed', impl, pub };
	log(`${it.id}: PR #${pub.prNumber}${depPrs.length ? ` (depends on ${depPrs.map((n) => '#' + n).join(', ')})` : ''}, Sol ${sol.approved ? 'approved' : it.docsOnly ? 'n/a' : 'NOT approved'}`);
	return {
		id: it.id,
		branch: it.branch,
		pr: pub.prNumber,
		url: pub.prUrl,
		sol: it.docsOnly ? 'n/a' : sol.approved ? `approved (${sol.rounds})` : 'not approved',
		disputes: sol.disputes || ''
	};
}

const promises = {};
function start(it) {
	if (promises[it.id]) return promises[it.id];
	promises[it.id] = (async () => {
		const deps = await Promise.all(
			it.deps.map((d) =>
				EXTERNAL[d]
					? Promise.resolve(EXTERNAL[d])
					: byId[d]
						? start(byId[d])
						: Promise.resolve({ error: `unknown dependency ${d}` })
			)
		);
		const bad = deps.find((d) => !d || d.error);
		if (bad) {
			log(`${it.id}: skipped (dependency failed: ${bad && bad.error ? bad.error : 'null'})`);
			return { id: it.id, error: 'dependency failed' };
		}
		return doItem(it, deps);
	})();
	return promises[it.id];
}
return await Promise.all(ITEMS.map(start));
