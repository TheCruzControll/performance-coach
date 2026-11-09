export const meta = {
	name: 'dag-claude',
	description:
		"Build-graph slices as small stacked PRs: implement + mutation check under light local gates, a sol-review fix loop with a fresh reviewer each round, push and a PR with gh; the main thread watches CI and merges",
	phases: [
		{ title: 'Implement', detail: 'each slice once its dependencies have PRs, stacked on their branches; critical path first' },
		{ title: 'Sol', detail: 'sol-review fix loop: a fresh reviewer each round, then the smallest fixes' },
		{ title: 'Publish', detail: 'fold fixups, local gates, push, PR with gh pr create' },
		{ title: 'CI', detail: "wait for the PR's required checks; a red one goes to a fresh fixer and Sol round" },
		{ title: 'Click-through', detail: 'UI slices: a fresh verifier builds the Node server and clicks through every acceptance item in headed Chromium' }
	]
};

// ---- Priority limiter: at most args.limit agents at once; the waiting task with the highest
// priority (the longest chain of slices still depending on it) runs next. ----
function makeLimiter(n) {
	let active = 0;
	const q = [];
	let open = false; // dispatch waits until every ready item has queued, so priority decides the first slots
	const next = () => {
		while (open && active < n && q.length) {
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
	const run = (prio, fn) =>
		new Promise((res, rej) => {
			q.push({ fn, res, rej, prio, seq: seq++ });
			next();
		});
	run.start = () => {
		open = true;
		next();
	};
	return run;
}
const ARGS = typeof args === 'string' ? JSON.parse(args) : args;
const limit = makeLimiter(ARGS.limit || 2);

if (!ARGS.scratch || !ARGS.repo) throw new Error('ARGS.scratch and ARGS.repo (absolute paths) are required');
const S = ARGS.scratch;
const BIN = `${S}/bin`;
const MAIN = ARGS.repo; // the main checkout (never modified by agents)
const WT = ARGS.worktrees || `${S}/wt`;
const R = 'repos/TheCruzControll/performance-coach';
// Author and reviewer stay different model families. Every commit is written by AUTHOR.
const AUTHOR = { model: undefined, name: 'Claude Opus 5.5' };
const REVIEWER = { model: 'opus', name: 'Claude Opus 5.5' };
const TRAILER = `Co-Authored-By: ${AUTHOR.name} <noreply@anthropic.com>`;
// it.effort is the Sol effort: xhigh for auth, security, data loss and concurrency slices, high otherwise.
const authorEffort = (it) => (it.effort === 'xhigh' ? 'high' : 'medium');
const M3PLAN = `${S}/plans/m3-plan.json`;
const M2PLAN = `git -C ${MAIN} show origin/handoff:docs/handoff/briefs/m2-onboarding-plan.json`;
const envf = (slug) => `${S}/env/${slug}.sh`;

const EXTERNAL = ARGS.external; // id -> {merged:true} | {branch, pr}
const ITEMS = ARGS.items; // [{id, kind: m2|m3|task, branch, ui, migration, deps, slug, port, effort, docsOnly?, task?, boost?}]
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

const MACHINE = (slug, port) => `MACHINE RULES (a 10-CPU, 32 GB macOS laptop shared by about six agents):
- Work only in your worktree ${WT}/${slug} (never in ${MAIN} or another worktree). Run \`bash ${BIN}/agent-env ${slug} ${port}\` once inside it (safe to re-run), then prefix every node/pnpm command with \`source ${envf(slug)} && \`. Your e2e port is ${port}. Postgres 18 (Homebrew) runs on localhost:5432 (role coach/coach), the same major version CI and production run. If a Bash command that talks to Postgres or the network fails with a sandbox or permission error (not an app error), rerun that same command with the Bash tool's sandbox disabled.
- Heavy commands (svelte-check, eslint and \`pnpm lint\`, full \`pnpm test:unit\` runs, vite build, Playwright) go through \`slot\` (at most three machine-wide; expect to wait). If slot gives up waiting it exits non-zero without running the command: run it again through slot later, never without it. Give heavy Bash calls timeout 600000. A git command that fails on a lock (another agent fetching) is retried after a moment.
- WebKit-only traps (CI runs Linux WebKit; this Mac's Playwright WebKit is macOS WebKit and behaves differently, so CI is the WebKit gate): (a) an e2e test that holds, fails or fulfils a request with page.route must run with the service worker blocked (\`test.use({ serviceWorkers: 'block' })\` in a describe, as profile-goals and train-week do), because on WebKit page.route does not see requests from a page the service worker controls; (b) wait on \`document.fonts.status === 'loaded'\`, never \`document.fonts.ready\`, while a request is held (WebKit resolves it only after the load event).
- Heavy tests run in CI, not here (the owner's rule: CI's machines are better). Never run Playwright e2e specs, Lighthouse, \`pnpm build\`, \`pnpm build:node\` or \`pnpm budgets\` locally: CI runs them on every PR (Chromium, Linux WebKit, desktop, Lighthouse, budgets) and a later step waits for it. Write and update the e2e specs the slice needs; CI proves them. Never \`playwright install\`. Browsers cannot launch inside this session's sandbox; the one agent that may drive a browser (the click-through verifier) connects to the owner's Playwright browser server at ws://127.0.0.1:3333/ (\`chromium.connect\`, or PW_TEST_CONNECT_WS_ENDPOINT for playwright test). Kill any server or browser you start.
- GitHub: \`gh\` is authenticated as TheCruzControll; read with \`gh api ${R}/...\`. The only GitHub writes you ever make are the ones your brief names: pushing your slice's branch, creating its PR with \`gh pr create\`, and editing its body with \`gh pr edit --body-file\`. You are a child agent: never subscribe to or watch PRs, never merge, never post PR comments, never rerun CI, never edit other PRs, never touch Vercel, Neon or GitHub settings.
- Shared docs belong to the milestone's docs slice: a code slice does NOT edit docs/testing.md, docs/security.md, docs/performance.md or docs/milestones.md at all (one edit there makes every other open PR stale and forces another CI run for each). Put the exact lines that belong there in a "## Docs to add" section of the PR body (target file and section for each); the milestone's docs slice adds them. If your branch already edits those files (an earlier session's work), move those edits into that section and restore the files to the base. Docs-only slices are the exception: they own those files and collect the "## Docs to add" sections from the milestone's merged PRs (\`gh api "${R}/pulls?state=closed&per_page=100"\` bodies). Registries and lists other parallel slices also extend (section registries, route-access tables, design-system rows): add your entry as its own line, never reformat neighbours.`;

const PROJECT = `Project: "Performance Coach" (GitHub TheCruzControll/performance-coach), a private single-user AI training PWA: SvelteKit 3 / Svelte 5 runes, TypeScript strict, Postgres + Drizzle, passkeys, Vercel. Spec: docs/product-requirements.md. Read what you need: docs/architecture.md (layers and import boundaries), docs/testing.md, docs/design-system.md, docs/performance.md (budgets), docs/agent-architecture.md. The owner's rules: each PR is ONE small atomic concern (ideally ≤ 600 non-test lines), green on its own, no drive-by refactors, real tests that prove behaviour (a regression test must fail without its fix), premium UI per docs/design-system.md (dark-first + light, existing primitives, 44 px targets, designed empty/loading/error states, axe-clean). DESKTOP TOO (owner request, PRD §7 and §16): every screen is iPhone-first but must also be laid out for a desktop browser (1440 × 900: navigation rail, content centred at a readable width, no stretched phone layout, hover and keyboard focus states); follow docs/design-system.md's breakpoint rules where they exist, and when a \`desktop-chromium\` Playwright project exists, make sure CI runs your UI specs on it too. Drizzle migrations: \`pnpm db:generate\` only; the journal order is enforced by a unit test. One query at a time per Executor (main since #62, docs/architecture.md): never \`Promise.all\` over one \`db\` handle or one transaction; await each query in turn (separate pool calls may run together). The integration setup fails any test that sends a query to a busy pg client, so merge origin/main before your gates. Wall-clock budgets asserted in unit or integration tests run on CI's 4-vCPU runners alongside other test files, which are 2-3x slower than this laptop: make the measured work fit in well under half its budget locally (the week scheduler's 100 ms test sat at 85-101 ms on CI and turned main red).`;

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
const INTEGRATION =
	'pnpm db:reset:test && pnpm test:integration (local Postgres 18, the version CI and production run, so assert what 18 does, e.g. an ON DELETE RESTRICT refusal is 23001; tests/integration/helpers.ts restrictRefusalCode)';
// Integration runs locally only where a migration or the db layer must be proven before CI.
const GATES = (it) =>
	`LOCAL GATES (each with \`source ${envf(it.slug)} && \`): pnpm lint; slot pnpm check; pnpm test:unit; ${it.migration ? `${INTEGRATION}; pnpm db:drift` : `and ${INTEGRATION} only if the slice's diff touches src/lib/server/db (\`git diff --name-only <BASE> HEAD -- src/lib/server/db\` is not empty)`}. Nothing else locally: CI runs the e2e specs, Lighthouse, the builds and the budgets on the PR. Report real output excerpts.`;
const PUSHED = (it, pr) =>
	`The branch is pushed as PR #${pr} and other slices may stack on it: commit each fix as a new commit (no --fixup, amend, rebase or force-push), then \`git push origin ${it.branch}\` (fast-forward; retry network errors up to 4 times). Leave the tree clean.`;

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
const AFTER_PUSH_FIX_OUT = {
	...FIX_OUT,
	properties: { ...FIX_OUT.properties, notOurs: { type: 'string', description: 'only when the failure is not caused by this slice: the evidence' } }
};
const CI_OUT = {
	type: 'object',
	properties: {
		state: { type: 'string', enum: ['green', 'red', 'timeout'] },
		failing: {
			type: 'array',
			items: { type: 'object', properties: { name: { type: 'string' }, link: { type: 'string' } }, required: ['name', 'link'] }
		},
		output: { type: 'string' }
	},
	required: ['state']
};
const CLICK_OUT = {
	type: 'object',
	properties: {
		verdict: { type: 'string', enum: ['pass', 'fail'] },
		items: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					acceptance: { type: 'string' },
					result: { type: 'string', enum: ['pass', 'fail', 'not on screen'] },
					did: { type: 'string' },
					saw: { type: 'string' },
					screenshots: { type: 'array', items: { type: 'string' } }
				},
				required: ['acceptance', 'result', 'did', 'saw']
			}
		},
		stopped: { type: 'string', description: 'how the server, the browser and every other process you started were stopped' },
		summary: { type: 'string' }
	},
	required: ['verdict', 'items', 'stopped', 'summary']
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

const solBudget = (it) => (it.effort === 'xhigh' ? 5 : 3);
// pr set: the branch is already pushed, so fixes are new commits pushed fast-forward.
async function solLoop(it, impl, p, start = 1, ledger0 = {}, prevHead0 = null, head0 = null, max = solBudget(it), pr = null) {
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
		if (!rev) return { approved: false, rounds: r, ledger, head, disputes: `round ${r}: the reviewer gave no reply` };
		const open = (rev.findings || []).filter((f) => f.status !== 'resolved' && f.severity !== 'nit');
		if (rev.verdict === 'APPROVE' && open.length === 0) return { approved: true, rounds: r, ledger, head, disputes: '', lastReview: rev.text };
		const stuck = open.filter((f) => (disputed[f.id] || 0) >= 2);
		if (stuck.length)
			return { approved: false, rounds: r, ledger, head, disputes: `stuck after two replies: ${stuck.map((f) => `${f.id} [${f.severity}] ${f.claim} (Sol: ${f.reason || ''})`).join(' | ')}`, lastReview: rev.text };
		if (r === max)
			return { approved: false, rounds: r, ledger, head, disputes: `budget ended with open: ${open.map((f) => `${f.id} [${f.severity}] ${f.claim}`).join(' | ')}`, lastReview: rev.text };
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
- Agree: make the smallest fix (prefer deleting or narrowing over a new lock, cache, helper or option); fix the case that happened; add ONE focused test that fails without the fix when the intent needs it. ${pr ? 'Commit each fix as a new commit (see below).' : 'Commit each fix with `git commit --fixup=<the slice commit it belongs to>` (keep the trailer line in the message body).'}
- Disagree: say why, with evidence (file:line, a test, command output).
- Out of scope or nit: decline in one line (a follow-up).
Do not agree just to end the loop; push back on scope creep with evidence. Re-run the ones that cover what you changed of these ${GATES(it)}
Then \`git diff --shortstat ${impl.base}\`; if review grew the diff, cut first. ${pr ? `${PUSHED(it, pr)} ${COMMITS}` : 'Do not push. Leave the tree clean.'}
Report one ledger entry per finding you answered (id, severity as you judge it, outcome fixed|disagree|declined, evidence), behaviorChanged (did any non-test code change?), head (\`git rev-parse HEAD\`), checks (real output excerpts) and shortstat.`,
				{ label: `fix-r${r}:${it.id}`, phase: 'Sol', schema: FIX_OUT, model: AUTHOR.model, effort: authorEffort(it) }
			)
		);
		if (!fix) return { approved: false, rounds: r, ledger, head, disputes: `round ${r}: the fixer failed`, lastReview: rev.text };
		for (const l of fix.ledger || []) {
			ledger[l.id] = l;
			if (l.outcome === 'disagree') disputed[l.id] = (disputed[l.id] || 0) + 1;
		}
		prevHead = rev.reviewedHead;
		head = fix.head || head;
	}
	return { approved: false, rounds: max, ledger, head, disputes: 'loop ended' };
}

const solText = (it, rounds) => `\`Reviewed with sol-review: ${rounds} rounds with ${REVIEWER.name} on ${it.effort}. Sol verdict: approved\``;
const solLine = (it, sol) => {
	if (it.docsOnly) return '`sol-review: not applicable (docs only).`';
	if (sol.approved) return `exactly ${solText(it, sol.rounds)}`;
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
	const resumed = (ARGS.resume || {})[it.id];
	const impl = resumed ? resumed.impl : await limit(p, () =>
		agent(
			`${PROJECT}

${specFor(it)}
${MACHINE(it.slug, it.port)}
START: ${prep}
Implement it exactly as specified (its tests and acceptance are the definition of done), test-first where it fits.
${GATES(it)}
${it.docsOnly ? 'Docs only: re-verify every changed claim against the repo and `gh` (no mutation check).' : `MUTATION CHECK (on the unit and integration tests the slice adds; CI proves its e2e specs): revert only the non-test source changes (\`git stash\` the source files, or \`git checkout <BASE> -- <source files>\` in a scratch copy); the new tests must FAIL for the right reason; restore; they PASS. Strengthen weak tests. Report what failed.`}
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
3. ${GATES(it)} ${COMMITS}
4. Push: \`git push -u origin ${it.branch}\`. If origin already has ${it.branch} with other history (an earlier session's WIP push) and no PR exists for it, use \`git push --force-with-lease -u origin ${it.branch}\`. Retry network errors up to 4 times (2 s, 4 s, 8 s, 16 s).
5. PR (the file-pr skill's rules): first check none is open (\`gh api "${R}/pulls?head=TheCruzControll:${it.branch}&state=open"\`). Title: a concise human-readable Conventional Commit saying why it matters (the plan's title is a good start). Body, written to ${S}/pr-bodies/${it.slug}.md first (mkdir -p the directory): it opens with the problem or need in plain words, then the change (no implementation inventory); a short "## Tests" section (what the tests prove, the local gates run, the mutation check; CI runs the e2e specs, Lighthouse and the budgets); ${depPrs.length ? `then one line per open dependency, exactly: ${depPrs.map((n) => `\`Depends on #${n}.\``).join(' ')}; ` : ''}then ${solLine(it, sol)}; then, last, exactly \`Created with ${AUTHOR.name} in Claude Code.\`
Check the title and body for secrets and private details. Create a NON-draft PR: \`gh pr create --repo TheCruzControll/performance-coach --base main --head ${it.branch} --title "<title>" --body-file ${S}/pr-bodies/${it.slug}.md\` (it prints the PR URL; the number is its last path segment).
6. Keep the worktree (CI and the click-through check use it next); kill any server or browser you started.
Report id="${it.id}", branch, head (the pushed \`git rev-parse HEAD\`), PR number and URL, gates, summary, problems.`,
			{ label: `publish:${it.id}`, phase: 'Publish', schema: OUT, model: AUTHOR.model, effort: 'low' }
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
					model: 'haiku',
					effort: 'low',
					schema: { type: 'object', properties: { prNumber: { type: 'number' }, prUrl: { type: 'string' } } }
				}
			)
		);
		if (found && found.prNumber) pub = { ...(pub || {}), prNumber: found.prNumber, prUrl: found.prUrl };
	}
	if (!pub || !pub.prNumber) return { id: it.id, branch: it.branch, error: 'publish failed', impl, pub };
	log(`${it.id}: PR #${pub.prNumber}${depPrs.length ? ` (depends on ${depPrs.map((n) => '#' + n).join(', ')})` : ''}, Sol ${sol.approved ? 'approved' : it.docsOnly ? 'n/a' : 'NOT approved'}`);
	const result = {
		id: it.id,
		branch: it.branch,
		pr: pub.prNumber,
		url: pub.prUrl,
		sol: it.docsOnly ? 'n/a' : sol.approved ? `approved (${sol.rounds})` : 'not approved',
		disputes: sol.disputes || ''
	};
	if (!it.docsOnly && !sol.approved) return { ...result, ci: 'not run', clickThrough: 'not run', ready: false, needs: 'Sol did not approve' };
	// Dependants stack on the PR as soon as it exists; only this slice's result waits for its checks.
	return { ...result, checks: checkLoop(it, impl, p, pub, sol) };
}

function ciBrief(it, pr, head, bodyLine, cleanup) {
	const body = `${S}/pr-bodies/${it.slug}.md`;
	return `Wait for CI on PR #${pr} (branch ${it.branch}) of TheCruzControll/performance-coach. Change no code, push nothing, comment nowhere, rerun nothing.
${bodyLine ? `First, in the PR body replace the line that starts \`Sol review pending\` with exactly ${bodyLine} (\`gh pr view ${pr} -R TheCruzControll/performance-coach --json body -q .body > ${body}\`, edit that file, \`gh pr edit ${pr} -R TheCruzControll/performance-coach --body-file ${body}\`).\n` : ''}Run \`bash ${BIN}/wait-ci.sh ${pr}${head ? ` ${head}` : ''}\` in ONE Bash call with a timeout of at least 3700 seconds. It polls the PR's required checks every 3 minutes for up to 60 minutes and exits 0 when all passed, 1 as soon as one failed or was cancelled, 2 when some were still pending at the deadline; its last line is the checks as JSON.
${cleanup ? `Only if it exited 0: \`git -C ${MAIN} worktree remove --force ${WT}/${it.slug}\`.` : 'Leave the worktree alone.'}
Report state (green for exit 0, red for 1, timeout for 2), failing (name and link of every check whose bucket is fail or cancel) and output (its last 15 lines).`;
}

const ciFailure = (it, run) =>
	`CI on the PR failed. Failing required checks: ${(run.failing || []).map((f) => `${f.name} (${f.link})`).join('; ') || run.output}.
Read each failing job's log with \`gh run view <run id> --job <job id> --log-failed -R TheCruzControll/performance-coach\` (both ids are in the link: .../runs/<run id>/job/<job id>), filtered (\`| tail -n 400\`, or grep for the first error) rather than whole. If the log is not enough, download only that job's report artifact (\`gh api ${R}/actions/runs/<run id>/artifacts\` lists them; \`gh run download <run id> -n <name> -D ${S}/ci/${it.slug} -R TheCruzControll/performance-coach\`) and delete it when done.`;

const clickFailure = (ct) =>
	`The click-through verifier drove the production build and these acceptance items FAILED:
${ct.items
		.filter((i) => i.result === 'fail')
		.map((i) => `- ${i.acceptance}. Did: ${i.did}. Saw: ${i.saw}. Screenshots: ${(i.screenshots || []).join(', ') || 'none'}`)
		.join('\n')}
Look at the screenshots (the read tool shows images). Fix the code so a person doing the same sees what the item says; extend the e2e spec that should have caught it (CI runs it).`;

function clickBrief(it, pr, head, n) {
	const wt = `${WT}/${it.slug}`;
	const shots = `${S}/shots/${it.slug}`;
	const body = `${S}/pr-bodies/${it.slug}.md`;
	const origin = `http://localhost:${it.port}`;
	return `${PROJECT}

${specFor(it)}
${MACHINE(it.slug, it.port)}
You are the CLICK-THROUGH VERIFIER for PR #${pr} (branch ${it.branch}, worktree ${wt}, head ${head || 'the pushed head'}), round ${n}. Someone else wrote this code and its CI is green. Check on the actual production build that the slice does what its acceptance says, the way the owner would use it. Change no source file, commit nothing, push nothing. You are the one agent allowed to build and drive a browser on this machine: the no-local-build rule above does not apply to you, every other machine rule does.
1. In ${wt}, \`git status --short\` is empty${head ? ` and \`git rev-parse HEAD\` is ${head}` : ''}. Prefix every command below with \`source ${envf(it.slug)} && \`. \`mkdir -p ${shots}\`; files from an earlier round may be there, overwrite them.
2. Build the production Node server as e2e/global-setup.ts does: \`ORIGIN=${origin} slot pnpm build:node\`.
3. Database and server exactly as e2e/global-setup.ts prepares them (read it first, and e2e/auth.setup.ts for how the owner is created and signed in). \`pnpm db:reset:e2e\` resets this slice's own e2e database (E2E_DATABASE_URL). Mint a throwaway setup token yourself (32 random bytes, base64url) and give the server only its sha256 hex as OWNER_SETUP_TOKEN_HASH. Start \`node build/index.js\` in the background from ${wt} with NODE_ENV=production APP_ENV=test PORT=${it.port} ORIGIN=${origin}, DATABASE_URL and DATABASE_URL_UNPOOLED set to $E2E_DATABASE_URL, and ENABLE_TEST_ROUTES=true, output to ${shots}/server.log; record its PID and wait until ${origin}/api/health answers 200. Never read, print or use the real owner setup token or any OWNER_SETUP_TOKEN value from an env file or the shell.
4. Drive a real Chromium with Playwright's library, not the test runner: write ${shots}/drive.mjs importing \`{ chromium, devices }\` from '${wt}/node_modules/@playwright/test/index.mjs', connect with \`chromium.connect('ws://127.0.0.1:3333/', { headers: { 'x-playwright-launch-options': JSON.stringify({ headless: false }) } })\` (browsers cannot launch inside this sandbox; the owner runs that server), and run it with \`slot node ${shots}/drive.mjs\`. Become the owner the way e2e/auth.setup.ts does: open /setup?token=<your throwaway token> and register a passkey through a CDP WebAuthn virtual authenticator. Create the data the acceptance needs through the app's own screens, or through the test-only routes the e2e specs use.
5. For every acceptance item of the slice (read them from the plan as shown above), in an iPhone context (\`devices['iPhone 15 Pro']\`) and in a 1440 × 900 desktop window: do what a person would do (tap, type, navigate, reload, go offline when the item says so), wait for the result and look at it. Save a screenshot of each outcome to ${shots}/<nn>-<short item>-<iphone|desktop>.png and look at it yourself. An item about something no screen shows (gates green, a database invariant, a budget) is "not on screen": name the CI job or test that covers it; it neither passes nor fails. An item passes only when what you saw matches it on both viewports.
6. PR body (gh cannot upload images, so list the local screenshot paths): \`gh pr view ${pr} -R TheCruzControll/performance-coach --json body -q .body > ${body}\`; replace its "## Click-through" section, or add one just before the sol-review line, with one line per acceptance item: \`- <pass|fail|not on screen>: <item>. Did: <what you did>. Saw: <what you saw>. Screenshots: <paths>\`; then \`gh pr edit ${pr} -R TheCruzControll/performance-coach --body-file ${body}\`.
7. Always, also after a failure or an error: close the browser, kill the server PID, then make sure nothing you started is left (\`lsof -ti tcp:${it.port}\` prints nothing; kill what remains and any other process you started). If no item failed, remove the worktree with \`git -C ${MAIN} worktree remove --force ${wt}\`; otherwise keep it, a fixer works there next.
Report verdict (pass only when no item failed), items (acceptance, result, did, saw, screenshots), stopped (how the server, the browser and the other processes were stopped) and summary.`;
}

// A failed check after the push: a fresh fixer pushes a fix, then fresh Sol rounds review it.
async function fixAfterPush(it, impl, p, pr, tag, failure, st) {
	const body = `${S}/pr-bodies/${it.slug}.md`;
	const fix = await limit(p + 2, () =>
		agent(
			`${PROJECT}

${specFor(it)}
${MACHINE(it.slug, it.port)}
You own branch ${it.branch} in ${WT}/${it.slug}, pushed as PR #${pr}${st.head ? ` (head ${st.head})` : ''}. Its own changes start at BASE ${impl.base}.${it.docsOnly ? '' : ' Sol approved it,'} then a check failed:
${failure}
Find the root cause and make the smallest fix in this slice's code or tests. Never skip, weaken or quarantine a test, and never raise a timeout or budget to get green. If the cause is not this slice's change (code from a PR it stacks on, or a failure main has too), change nothing and report notOurs with the evidence. When the fix changes behaviour, add or extend ONE test that fails without it (a unit or integration test you prove fails without the fix; an e2e spec CI proves).
${GATES(it)}
${it.docsOnly ? '' : `Before you push, in the PR body replace the line that starts \`Reviewed with sol-review\` with \`Sol review pending: a fix for a failed check is under review.\` (\`gh pr view ${pr} -R TheCruzControll/performance-coach --json body -q .body > ${body}\`, edit that file, \`gh pr edit ${pr} -R TheCruzControll/performance-coach --body-file ${body}\`). `}${PUSHED(it, pr)} ${COMMITS}
Report one ledger entry (id ${tag.toUpperCase()}, severity blocker, outcome fixed, evidence: the cause and the fix), behaviorChanged, head (\`git rev-parse HEAD\` after the push), checks (real output excerpts) and shortstat; or notOurs.`,
			{ label: `fix-${tag}:${it.id}`, phase: tag.startsWith('ci') ? 'CI' : 'Click-through', schema: AFTER_PUSH_FIX_OUT, model: AUTHOR.model, effort: authorEffort(it) }
		)
	);
	if (!fix || (!fix.notOurs && !fix.head)) return { ...st, needs: `${tag}: the fixer failed` };
	if (fix.notOurs) return { ...st, needs: `${tag}: not caused by this slice: ${fix.notOurs}` };
	const ledger = { ...st.ledger };
	for (const l of fix.ledger || []) ledger[l.id] = l;
	if (it.docsOnly) return { ...st, ledger, head: fix.head, bodyLine: null };
	const sol = await solLoop(it, impl, p, st.rounds + 1, ledger, st.head, fix.head, st.rounds + solBudget(it), pr);
	if (!sol.approved) return { ...st, ledger: sol.ledger, rounds: sol.rounds, head: sol.head, solApproved: false, needs: `${tag}: Sol did not approve the fix (${sol.disputes})` };
	return { ledger: sol.ledger, rounds: sol.rounds, head: sol.head, bodyLine: solText(it, sol.rounds) };
}

// CI runs that may come back red, and click-throughs that may fail, before the main thread takes over.
const CHECK_ROUNDS = 3;
async function checkLoop(it, impl, p, pub, sol) {
	const pr = pub.prNumber;
	const click = !it.docsOnly && (it.clickThrough ?? it.ui);
	let st = { ledger: { ...sol.ledger }, rounds: sol.rounds, head: pub.head, bodyLine: null };
	let runs = 0;
	let red = 0;
	let clicks = 0;
	const end = (ci, clickThrough, needs) => ({ ci, clickThrough, ready: !needs, needs: needs || '', rounds: st.rounds, solApproved: st.solApproved !== false, head: st.head });
	// Owner, 2026-11-07: the main thread's wait-ready.sh watches CI and starts fixers on red; UI slices get one click-through per screen chain.
	if (!ARGS.waitCi) return end('watched by the main thread', click ? 'batched per chain' : 'n/a', 'CI watched by the main thread');
	for (;;) {
		runs++;
		// Outside the limiter: the watcher only sleeps on gh, and holding a slot for an hour would stall the wave.
		const run = await agent(ciBrief(it, pr, st.head, st.bodyLine, !click), { label: `ci${runs}:${it.id}`, phase: 'CI', model: AUTHOR.model, effort: 'low', schema: CI_OUT });
		st = { ...st, bodyLine: null };
		if (!run || run.state !== 'green') {
			red++;
			const state = run ? run.state : 'no reply';
			if (state !== 'red' || red >= CHECK_ROUNDS) return end(state, 'not run', `CI ${state} (round ${runs}, ${red} red)`);
			st = await fixAfterPush(it, impl, p, pr, `ci${red}`, ciFailure(it, run), st);
			if (st.needs) return end('red', 'not run', st.needs);
			continue;
		}
		if (!click) return end('green', 'n/a');
		clicks++;
		const ct = await limit(p + 4, () =>
			agent(clickBrief(it, pr, st.head, clicks), { label: `click${clicks}:${it.id}`, phase: 'Click-through', model: AUTHOR.model, effort: 'medium', schema: CLICK_OUT })
		);
		if (ct && ct.verdict === 'pass' && !(ct.items || []).some((i) => i.result === 'fail')) return end('green', 'pass');
		if (!ct || clicks >= CHECK_ROUNDS) return end('green', 'fail', ct ? `click-through failed ${clicks} times` : 'the click-through verifier gave no reply');
		st = await fixAfterPush(it, impl, p, pr, `click${clicks}`, clickFailure(ct), st);
		if (st.needs) return end('not run', 'fail', st.needs);
	}
}

// Slices that edit the same screens run one at a time (owner: screen chains at limit 1).
const groupTail = {};
function inGroup(name, fn) {
	if (!name) return fn();
	const prev = groupTail[name] || Promise.resolve();
	const run = prev.then(fn, fn);
	groupTail[name] = run.then(() => {}, () => {});
	return run;
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
		return inGroup(it.group, () => doItem(it, deps));
	})();
	return promises[it.id];
}
const all = Promise.all(
	ITEMS.map(async (it) => {
		const { checks, ...r } = await start(it);
		if (!checks) return r;
		const c = await checks;
		const sol = it.docsOnly ? 'n/a' : `${c.solApproved ? 'approved' : 'not approved'} (${c.rounds})`;
		log(`${it.id}: PR #${r.pr} CI ${c.ci}, click-through ${c.clickThrough}${c.ready ? ', ready' : `, needs the main thread: ${c.needs}`}`);
		return { ...r, sol, ci: c.ci, clickThrough: c.clickThrough, ready: c.ready, needs: c.needs };
	})
);
// Let every item with external dependencies reach the limiter before any starts.
for (let i = 0; i < 200; i++) await null;
limit.start();
return await all;
