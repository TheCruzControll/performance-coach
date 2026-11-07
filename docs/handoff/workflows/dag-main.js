export const meta = {
	name: 'dag-main',
	description:
		'The remaining M1 fixes, M2 Profile editing and onboarding, and all of M3, as one prioritised dependency graph of stacked PRs (≤ args.limit agents): implement → Sol fix loop → file-pr',
	phases: [
		{
			title: 'Implement',
			detail:
				'each slice once its dependencies have PRs, stacked on their branches; critical path first'
		},
		{ title: 'Sol + publish', detail: 'mutation check, sol-review fix loop, gates, push, file-pr' }
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
const limit = makeLimiter(args.limit || 7);

const S = '<SCRATCH>'; // set to your scratchpad (it holds bin/, env/, wt/, plans/, pr-bodies/)
const BIN = `${S}/bin`;
const MAIN = '<REPO>'; // the main checkout (never modified by agents)
const R = 'repos/TheCruzControll/performance-coach';
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const M3PLAN = `${S}/plans/m3-plan.json`;
const M2PLAN = 'git show origin/handoff:docs/handoff/briefs/m2-onboarding-plan.json';
const envf = (slug) => `${S}/env/${slug}.sh`;

const EXTERNAL = args.external; // id -> {merged:true} | {branch, pr}
const ITEMS = args.items; // [{id, kind: m2|m3|task, branch, ui, migration, deps, slug, port, effort, docsOnly?, task?}]
const byId = Object.fromEntries(ITEMS.map((x) => [x.id, x]));

// Priority = length of the longest chain of slices in this run that depend on the item.
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

const MACHINE = (slug, port) => `MACHINE RULES (an 8 GB Mac shared by up to 8 agents):
- Work only in your worktree ${S}/wt/${slug} (never in ${MAIN} or another worktree). Run \`bash ${BIN}/agent-env ${slug} ${port}\` once inside it (safe to re-run), then prefix every node/pnpm command with \`source ${envf(slug)} && \`. Your e2e port is ${port}.
- Heavy commands (svelte-check, vite build, Playwright) go through \`slot\` (at most two machine-wide; expect to wait). Heavy Bash calls get timeout 600000.
- Run only the e2e specs you touch or add; never the full suite, never --repeat-each above 3, never the 'perf' or 'exclusive' projects. Kill servers and browsers you start. Never \`playwright install\`.
- Local WebKit is macOS WebKit (on main, e2e/shell.e2e.ts "plate calculator sheet", "a late animation frame…" and "the theme preference applies before first paint" fail locally only). CI's Linux Chromium + WebKit + Lighthouse is the final gate.
- Use REST (\`gh api ${R}/...\`), never \`gh pr create/edit/merge\`. You are a child agent: never call watch_pull_request, never merge, never post PR comments.
- Shared docs hotspots: do not rewrite docs/testing.md, docs/security.md or docs/performance.md paragraphs (every open PR touches them and each edit forces the others to re-run CI). If a fact truly belongs there, add ONE new line or bullet; prefer the docs the slice owns. Registries and lists other parallel slices also extend (section registries, route-access tables, design-system rows): add your entry as its own line, never reformat neighbours.`;

const PROJECT = `Project: "Performance Coach" (GitHub TheCruzControll/performance-coach), a private single-user AI training PWA: SvelteKit 3 / Svelte 5 runes, TypeScript strict, Postgres + Drizzle, passkeys, Vercel. Spec: docs/product-requirements.md. Read what you need: docs/architecture.md (layers and import boundaries), docs/testing.md, docs/design-system.md, docs/performance.md (budgets), docs/agent-architecture.md. The owner's rules: each PR is ONE small atomic concern (ideally ≤ 600 non-test lines), green on its own, no drive-by refactors, real tests that prove behaviour, premium UI per docs/design-system.md (dark-first + light, existing primitives, 44 px targets, designed empty/loading/error states, axe-clean). Drizzle migrations: \`pnpm db:generate\` only; the journal order is enforced by a unit test.`;

const specFor = (it) => {
	if (it.kind === 'm3')
		return `YOUR SLICE is M3 plan slice '${it.id}' (branch ${it.branch}). Read it in full: \`jq '.slices[] | select(.id=="${it.id}")' ${M3PLAN}\` (goal, newOrChanged, tests, acceptance, risks, estNonTestLines), and the plan's decisions: \`jq -r '.decisions[]' ${M3PLAN}\` (measured budget facts, layer and naming decisions you must follow). Where the plan's openQuestions (\`jq -r '.openQuestions[]' ${M3PLAN}\`) touch your slice, implement the plan's stated default as a named, documented constant or decision so the owner can change it cheaply. The brief behind it: \`git show origin/handoff:docs/handoff/briefs/m3.json\`. PR title = the slice's title.${it.migration ? ' MIGRATIONS: you add a migration; keep the journal in order after every migration already on main and in the PRs you stack on (regenerate yours if main gained one).' : ''}`;
	if (it.kind === 'm2')
		return `YOUR SLICE is M2 onboarding-plan slice '${it.id}' (branch ${it.branch}). Read it in full: \`${M2PLAN} | jq '.slices[] | select(.id=="${it.id}")'\` and the plan's \`.wipAssessment\` (budget facts, WIP bugs not to carry over). WIP code it may reuse: commit d8bfded (\`git show d8bfded:<path>\`); take only what the slice lists. Main has moved on since the plan was written: the security fixes it mentions are merged (malformed ids, goal status, section-save locks, onboarding progress validation, the body-weight time zone, step-up re-authentication), the input primitives (NumberField, TextArea, date TextField, ChoiceGroup, DayPicker, Toggle, TagInput) exist, and the JSON save path is in; build on what is on main and in the PRs you stack on, not on the plan's assumptions. PR title = the slice's title.`;
	return `YOUR ITEM (${it.id}):\n${it.task}`;
};

const COMMITS = `Commits: Conventional Commits; subject, blank line, short plain-prose body (problem, then change); end every message with exactly the line \`${TRAILER}\`. Mention no AI model anywhere except the PR description lines.`;
const GATES = (slug, ui, migration) =>
	`GATES (each with \`source ${envf(slug)} && \`): pnpm lint; slot pnpm check; pnpm test:unit; pnpm test:integration; ${migration ? 'pnpm db:drift; ' : ''}${ui ? 'slot pnpm build:node && pnpm budgets (paste the rows for the routes you touched and /profile/security); slot pnpm build; the e2e specs you touched or added on Chromium (`slot pnpm exec playwright test <specs> --project=setup --project=iphone-chromium --reporter=line`) and WebKit (`E2E_WEBKIT=1 slot pnpm exec playwright test <specs> --project=setup --project=setup-webkit --project=iphone-webkit --reporter=line`)' : 'e2e only if you touched routes, components or anything the browser loads'}. Report real output excerpts.`;
const SOL = (effort, intent) =>
	`SOL REVIEW: load the sol-review skill (Skill tool, skill "sol-review") and follow it as the FIX-LOOP owner of this branch (the user authored it). Intent: ${intent}. Scope: \`git diff <BASE> HEAD\` where BASE is the commit the implementer recorded (stacked dependencies are reviewed in their own PRs; review only this slice's diff). T3's delegate_task does not work from workflow agents (it fails with parent_not_active), so use the skill's Codex CLI route directly: model gpt-6.1-sol (or the newest Sol from \`codex debug models\`), \`-c model_reasoning_effort="${effort}"\`, \`-s read-only -C <your worktree> --ephemeral -o ${S}/wt/<your slug>-sol-round-<N>.md\`, the brief on stdin from a file next to it; run it in the background (Bash run_in_background, timeout 7200000) and wait for it to exit; one fresh run per round; take model, effort and token use from its log. Repo in the brief = your worktree's absolute path. Up to ${effort === 'xhigh' ? 5 : 3} rounds. Smallest fixes; push back on scope creep with evidence.`;
const DESCRIPTION = (depPrs, docsOnly) =>
	`PR DESCRIPTION per the file-pr skill (Skill tool, skill "file-pr"): title = concise human-readable Conventional Commit saying why it matters (the plan's title is a good start); body opens with the problem/need in plain words, then the change, no implementation inventory; a short "Tests" section (what the tests prove, gates run); a "Budgets" section with rows if you touched the UI; ${depPrs.length ? `then one line per dependency, exactly: ${depPrs.map((n) => `\`Depends on #${n}.\``).join(' ')}; ` : ''}then ${docsOnly ? 'the line `sol-review: not applicable (docs only).`' : 'ONLY if Sol approved the current behaviour diff with no blocker or should open, exactly `Reviewed with sol-review: <N> rounds with <model> on <effort>. Sol verdict: approved` (if Sol is stuck, omit it and report the disputes)'}; last line \`Created with Claude Opus 5.5 in Claude Code.\` Body file in ${S}/pr-bodies/.`;

const OUT = {
	type: 'object',
	properties: {
		id: { type: 'string' },
		branch: { type: 'string' },
		base: {
			type: 'string',
			description: 'commit sha the slice starts from (after merging its dependencies)'
		},
		prNumber: { type: 'number' },
		prUrl: { type: 'string' },
		solVerdict: { type: 'string' },
		solRounds: { type: 'number' },
		ledger: { type: 'array', items: { type: 'string' } },
		disputes: { type: 'string' },
		gates: { type: 'string' },
		summary: { type: 'string' },
		problems: { type: 'string' }
	},
	required: ['id', 'summary']
};

async function doItem(it, deps) {
	const open = deps.filter((d) => !d.merged);
	const depPrs = open.map((d) => d.pr);
	const fresh = open.length
		? `\`git -C ${MAIN} worktree add ${S}/wt/${it.slug} -b ${it.branch} origin/${open[0].branch}\`${open
				.slice(1)
				.map((d) => `, then in the worktree \`git merge --no-edit origin/${d.branch}\``)
				.join(
					''
				)}${open.length > 1 ? " (resolve any conflict between the stacked dependencies carefully, keeping both sides' intent, and run the gates on the merged base)" : ''}. Your slice stacks on the open PR(s) ${depPrs.map((n) => `#${n}`).join(', ')}; they merge first.`
		: `\`git -C ${MAIN} worktree add ${S}/wt/${it.slug} -b ${it.branch} origin/main\`.`;
	const prep = `\`git -C ${MAIN} fetch -q origin\`. RESUME CHECK FIRST: an earlier run may have started this slice and been stopped. If ${S}/wt/${it.slug} exists, or branch ${it.branch} exists locally (\`git -C ${MAIN} branch --list ${it.branch}\`) or on origin, reuse it: look at its commits and uncommitted changes, keep what is right, and finish the slice (if the worktree is gone but the branch exists: \`git -C ${MAIN} worktree add ${S}/wt/${it.slug} ${it.branch}\`; merge any newly merged or updated dependency branches into it). Record BASE as the merge base of your branch with its dependency branches (or origin/main). If a PR already exists for ${it.branch} (\`gh api "${R}/pulls?head=TheCruzControll:${it.branch}&state=all"\`), report its number and stop. Otherwise start fresh: ${fresh}`;
	const impl = await limit(prio(it), () =>
		agent(
			`${PROJECT}

${specFor(it)}
${MACHINE(it.slug, it.port)}
START: ${prep} Then record BASE = \`git rev-parse HEAD\` before any change of yours (unless resuming, see above).
Implement it exactly as specified (its tests and acceptance are the definition of done), test-first where it fits.
${GATES(it.slug, it.ui, it.migration)}
${COMMITS} Commit on ${it.branch}; do not push. Leave the tree clean.
Report id="${it.id}", branch, base (the BASE sha), prNumber if a PR already existed, a summary with the non-test line count (\`git diff --stat <BASE>..${it.branch} -- . ':!*.test.ts' ':!e2e' ':!tests' ':!drizzle/meta'\`) and gates.`,
			{ label: `impl:${it.id}`, phase: 'Implement', schema: OUT }
		)
	);
	if (impl && impl.prNumber)
		return { id: it.id, branch: it.branch, pr: impl.prNumber, existed: true };
	if (!impl || !impl.base) return { id: it.id, error: 'implementer failed', impl };
	const pub = await limit(prio(it) + 1, () =>
		agent(
			`${PROJECT}

${specFor(it)}
${MACHINE(it.slug, it.port)}
Branch ${it.branch} in ${S}/wt/${it.slug} is implemented and committed, not pushed. Its own changes start at BASE ${impl.base}. Implementer report: ${JSON.stringify(impl)}
1. ${it.docsOnly ? 'Docs only: re-verify every changed claim against the repo and `gh` (no mutation check).' : `MUTATION CHECK: revert only the non-test source changes (\`git checkout ${impl.base} -- <source files>\`); the new tests must FAIL for the right reason; restore (\`git checkout ${it.branch} -- .\`), they PASS. Strengthen weak tests.`}
2. ${it.docsOnly ? 'sol-review does not apply to docs-only changes: skip it.' : SOL(it.effort, `${it.id}: see the slice's goal and acceptance`)} Fold fixes into the commits (\`git commit --fixup\` + \`GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash ${impl.base}\`).
3. ${GATES(it.slug, it.ui, it.migration)} ${COMMITS}
4. \`git push -u origin ${it.branch}\` (retry network errors with backoff).
5. ${DESCRIPTION(depPrs, it.docsOnly)} Create a NON-draft PR: \`gh api ${R}/pulls -f title="<title>" -f head=${it.branch} -f base=main -F body=@<file>\` (first check none exists: \`gh api "${R}/pulls?head=TheCruzControll:${it.branch}&state=open"\`).
6. \`git -C ${MAIN} worktree remove --force ${S}/wt/${it.slug}\`.
Report id="${it.id}", branch, PR number and URL, Sol verdict, rounds, ledger, disputes, gates.`,
			{ label: `sol+pr:${it.id}`, phase: 'Sol + publish', schema: OUT }
		)
	);
	if (!pub || !pub.prNumber)
		return { id: it.id, branch: it.branch, error: 'publish failed', impl, pub };
	log(
		`${it.id}: PR #${pub.prNumber}${depPrs.length ? ` (depends on ${depPrs.map((n) => '#' + n).join(', ')})` : ''}, Sol ${pub.solVerdict}`
	);
	return {
		id: it.id,
		branch: it.branch,
		pr: pub.prNumber,
		url: pub.prUrl,
		sol: pub.solVerdict,
		disputes: pub.disputes || ''
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
