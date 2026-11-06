export const meta = {
	name: 'profile-chain',
	description: 'Restack the held Profile PRs onto main + #86 as one chain (each = previous sibling + itself), review each merge resolution and run gates while the next one stacks, cascade fixes, push in order, final chain audit',
	phases: [
		{ title: 'Stack', detail: 'sequential: merge main and the previous sibling, resolve registry conflicts, lint + check + unit' },
		{ title: 'Verify', detail: 'per PR, pipelined: fresh reviewer on the remerge-diff, then full gates and fixes' },
		{ title: 'Cascade', detail: 'carry any fix commit down the rest of the chain' },
		{ title: 'Push', detail: 'push every branch in order, update PR descriptions' },
		{ title: 'Audit', detail: 'independent check that the chain lost no entry and each PR adds only its own change' }
	]
};

const S = '/tmp/claude-0/-home-user-performance-coach/7dfac99c-7ffa-543a-b71b-13de33c61bd5/scratchpad';
const MAIN = '/home/user/performance-coach';
const R = 'repos/TheCruzControll/performance-coach';
const TRAILERS = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01BpPosSc4jpv9ky7GSNsgpd';
const PRS = args.prs;
const FIRST = args.prev;

const STACK_OUT = {
	type: 'object',
	properties: {
		base: { type: 'string', description: 'origin/<branch> sha before your merges' },
		head: { type: 'string' },
		prevHead: { type: 'string', description: 'the sha of the previous sibling you merged' },
		merges: { type: 'string' },
		conflicts: { type: 'string', description: 'every conflicted file and how it was resolved' },
		gates: { type: 'string' },
		blocked: { type: 'boolean', description: 'true only if a conflict needs a real design choice you could not make' },
		problems: { type: 'string' }
	},
	required: ['base', 'head', 'prevHead', 'merges', 'conflicts', 'gates', 'blocked']
};
const REVIEW_OUT = {
	type: 'object',
	properties: { verdict: { type: 'string', enum: ['APPROVE', 'CHANGES'] }, text: { type: 'string' } },
	required: ['verdict', 'text']
};
const VERIFY_OUT = {
	type: 'object',
	properties: {
		head: { type: 'string', description: 'branch head after any fix commits' },
		fixed: { type: 'boolean', description: 'true if you added any commit' },
		fixes: { type: 'string' },
		gates: { type: 'string', description: 'real output excerpts, including the budgets rows' },
		problems: { type: 'string' }
	},
	required: ['head', 'fixed', 'gates']
};

const env = (it) => `MACHINE RULES: a 4-CPU Linux cloud container shared with ~10 other agents. Work only in ${S}/wt/${it.slug} (create it with \`git -C ${MAIN} fetch -q origin && git -C ${MAIN} worktree add -B ${it.branch} ${S}/wt/${it.slug} origin/${it.branch}\` if missing; if it exists, reuse it as it is: never reset it, it may hold your own unpushed merges), run \`bash ${S}/bin/agent-env ${it.slug} ${it.port}\` once, and prefix node/pnpm commands with \`source ${S}/env/${it.slug}.sh && \`. Heavy commands (svelte-check, vite build, Playwright, the full integration suite) go through \`slot\` (${S}/bin/slot); heavy Bash calls get timeout 600000. Local Postgres 16 on port 5432 is shared (touch only coach_${it.slug}_* databases). Only Chromium runs locally (never \`playwright install\`, never E2E_WEBKIT=1). GitHub reads with \`gh api ${R}/...\` (REST). Never merge, comment on, or subscribe to PRs; never touch hosted settings. Never rewrite history on these branches (no rebase, amend or force-push): only add commits. Commit messages end with exactly:\n${TRAILERS}`;

const CONTEXT = `CONTEXT: Profile → section editors live at /profile/[section]. Several Profile PRs each add one section (or extend the goals section) and all touch the same registries: src/lib/server/forms/sections.ts (SECTIONS), src/lib/ui/profile/editors.ts (EDITORS), src/lib/ui/profile/sections.ts (Profile's list), e2e/a11y.e2e.ts (SCREENS and per-section tests), sometimes src/routes/(app)/profile/[section]/SectionScreen.svelte, docs rows and budgets tables. They were built on older heads, so GitHub shows them as conflicting. Main now has #66 strength, #67 experience and #68 goals merged; #86 (branch fix/m2-profile-section-css) keeps every editor's CSS out of the server build (SectionScreen loads editors with \`import.meta.env.SSR ? Promise.reject(new Error('client only')) : EDITORS[key]()\`) and adds a budgets guard; it is green and merges next. The chain is: #86 → ${PRS.map((p) => '#' + p.pr).join(' → ')}. Goals chain inside it: #68 (merged) → #77 general goals → #84 goal status → #93 goal order; those branches already contain older copies of their goals predecessors.
Rules that must survive every merge: sectionContext in src/lib/server/forms/sections.ts awaits its reads one at a time (one query at a time per Executor, tests/integration/one-query-per-client.ts); vite.config.ts has ONE build.modulePreload.resolveDependencies rule and no importWithoutModulepreload plugin; #86's SSR guard line in SectionScreen.svelte; no Promise.all over one db handle or transaction.`;

const stackPrompt = (it, prev) => `${env(it)}

${CONTEXT}

YOUR PR: #${it.pr} (branch ${it.branch}). The previous link in the chain: #${prev.pr} (branch ${prev.branch}). ${prev.pr === FIRST.pr ? `Use origin/${prev.branch} (fetch it first).` : `Use the LOCAL branch ${prev.branch} (just stacked by the previous step in ${S}/wt/${prev.slug}, not pushed yet; local branches are shared across worktrees): \`git rev-parse ${prev.branch}\`.`}
1. Record base = \`git rev-parse origin/${it.branch}\` and prevHead = the sha of ${prev.pr === FIRST.pr ? 'origin/' : ''}${prev.branch}. Read this PR's own change first: \`git diff $(git merge-base origin/main origin/${it.branch})...origin/${it.branch} --stat\` and its description (\`gh api ${R}/pulls/${it.pr} --jq .body\`).
2. \`git merge --no-edit origin/main\` (message "Merge main into ${it.branch}"), then \`git merge --no-edit ${prev.pr === FIRST.pr ? 'origin/' : ''}${prev.branch}\` (message "Merge ${prev.branch} into ${it.branch}", stacking on #${prev.pr}).
3. Resolve every conflict keeping BOTH sides' intent: in registries and lists keep every entry, earlier links' entries first (in the order they already have on the previous branch), then this PR's, never reformatting neighbours; in shared code keep both behaviours (for example an interface field one PR added and a parameter another added). Keep the rules above. If this PR's own code puts two queries on one Executor with Promise.all, fix it in its own small commit. If a conflict needs a real design choice you cannot make from the code and the PR descriptions, set blocked=true and explain.
4. Quick gates on the result: \`pnpm lint\`; \`slot pnpm check\`; \`pnpm test:unit\`. Paste real output excerpts.
5. Check the result: \`git diff ${prev.pr === FIRST.pr ? 'origin/' : ''}${prev.branch} HEAD --stat\` must show only this PR's own files and changes (list any other file and why). Do not push. Leave the tree clean.
Report base, head, prevHead, merges, conflicts, gates, blocked, problems.`;

const reviewPrompt = (it, prev, st) => `Review only. Do not edit, commit, push, comment on PRs, start subagents, or use the sol-review or council skills.

${CONTEXT}

Repo: ${S}/wt/${it.slug} (branch ${it.branch}). From ${st.base} (the old PR head) to ${st.head}: merge commits bringing main and the previous chain link #${prev.pr} (${prev.branch} at ${st.prevHead}) into PR #${it.pr}. Reported merges: ${st.merges}. Reported conflicts and resolutions: ${st.conflicts}
Read: \`git -C ${S}/wt/${it.slug} log --oneline ${st.base}..${st.head}\`, \`git show --remerge-diff <each merge commit>\` (exactly how conflicts were resolved), any non-merge commit in the range, and \`git diff ${st.prevHead} ${st.head}\` (what this PR adds on top of the previous link: it must be this PR's own change and nothing else). Compare with the PR's original change: \`git diff $(git merge-base origin/main ${st.base})...${st.base}\`.
Check: every registry/list keeps every entry from both sides in a sensible order; the rules in CONTEXT survived; this PR's own behaviour survived (its e2e spec, its server action, its editor, its docs rows); nothing unrelated changed; no duplicated entries or code; types line up (interfaces both sides extended). Reported quick gates: ${st.gates.slice(0, 1500)}
blocker = a lost entry, lost fix or broken behaviour. should = a real bug. nit = rest. VERDICT is APPROVE when no blocker or should is open.
Reply with text:
VERDICT: APPROVE or CHANGES
S1 [blocker|should|nit] <file>:<line> <claim>. Fix: <suggestion>`;

const verifyPrompt = (it, st, rev) => `${env(it)}

${CONTEXT}

You are verifying PR #${it.pr} (branch ${it.branch}) after it was restacked locally to ${st.head} (not pushed). ${rev ? `A fresh reviewer read the merge resolutions and replied (verdict ${rev.verdict}):\n${rev.text}\nCheck every blocker and should finding against the code; fix the real ones with small new commits (never amend a merge); for findings you disagree with, give the evidence in problems.` : 'The review step failed, so read the merge resolutions yourself (`git show --remerge-diff`) before the gates.'}
Then run the full gates on the branch head: \`pnpm lint\`; \`slot pnpm check\`; \`pnpm test:unit\`; \`pnpm db:reset:test && slot pnpm test:integration\`; \`slot pnpm build:node && pnpm budgets\` (paste the /(app)/profile/[section], /(app)/profile and /(app)/profile/security rows); on Chromium the e2e specs this PR adds or changes (see \`git diff --stat $(git merge-base origin/main ${st.base})...${st.base} -- e2e\`) plus e2e/a11y.e2e.ts and e2e/profile-equipment.serial.e2e.ts (find serial project names in playwright.config.ts; include --project=setup; \`slot pnpm exec playwright test <specs> --project=setup --project=iphone-chromium [--project=<serial project>] --reporter=line\`). A failure is yours to root-cause and fix with a small commit (a lost registry entry, a merged test that now needs both sides' setup, and so on); never skip, loosen or quarantine a test. Do not push. Leave the tree clean.
Report head (\`git rev-parse HEAD\`), fixed (true if you added any commit), fixes, gates (real output excerpts), problems.`;

phase('Stack');
const entries = [];
let prev = FIRST;
let verifyChain = Promise.resolve();
const verified = {};
let stoppedAt = null;

async function verifyOne(e) {
	const rev = await agent(reviewPrompt(e.it, e.prev, e.st), { label: `review:#${e.it.pr}`, phase: 'Verify', model: 'opus', effort: 'high', schema: REVIEW_OUT });
	const v = await agent(verifyPrompt(e.it, e.st, rev), { label: `verify:#${e.it.pr}`, phase: 'Verify', schema: VERIFY_OUT });
	verified[e.it.pr] = { review: rev, verify: v };
}

for (const it of PRS) {
	const st = await agent(stackPrompt(it, prev), { label: `stack:#${it.pr}`, phase: 'Stack', schema: STACK_OUT });
	if (!st || st.blocked) {
		stoppedAt = { pr: it.pr, why: st ? st.problems : 'stack agent failed' };
		log(`stopped at #${it.pr}: ${stoppedAt.why}`);
		break;
	}
	const e = { it, st, prev };
	entries.push(e);
	verifyChain = verifyChain.then(() => verifyOne(e));
	prev = { pr: it.pr, branch: it.branch, slug: it.slug };
}
await verifyChain;

// Cascade: if any link got a fix commit, every later link must merge its final head.
phase('Cascade');
const firstFixed = entries.findIndex((e) => verified[e.it.pr]?.verify?.fixed);
let cascade = null;
if (firstFixed >= 0 && firstFixed < entries.length - 1) {
	const rest = entries.slice(firstFixed + 1);
	cascade = await agent(
		`${env(rest[0].it)}

${CONTEXT}

A chain of local, unpushed branches: ${entries.map((e) => `${e.it.branch} (#${e.it.pr}, worktree ${S}/wt/${e.it.slug})`).join(' → ')}. Fix commits were added to some links after the later links had stacked on them: ${entries.filter((e) => verified[e.it.pr]?.verify?.fixed).map((e) => `#${e.it.pr}: ${verified[e.it.pr].verify.fixes}`).join('; ')}.
Carry the fixes down, in order, starting at ${rest[0].it.branch}: for each of ${rest.map((e) => e.it.branch).join(', ')}, in its OWN worktree (${rest.map((e) => `${S}/wt/${e.it.slug}`).join(', ')}), \`git merge --no-edit <the previous link's local branch>\` (message "Merge <prev branch> into <branch>"), resolve keeping both sides, then \`pnpm lint\` and \`slot pnpm check\` there (source that worktree's env file ${S}/env/<slug>.sh; run \`bash ${S}/bin/agent-env <slug> <port>\` if missing). If a fix itself needs adapting in a later link (it touched an entry that later link changed), adapt it there with a small commit. Do not push.
Report, per branch, the new head and gates.`,
		{ label: 'cascade', phase: 'Cascade', schema: { type: 'object', properties: { heads: { type: 'object', additionalProperties: { type: 'string' } }, report: { type: 'string' } }, required: ['heads', 'report'] } }
	);
}

phase('Push');
const pushed = await agent(
	`${env(entries[0]?.it || PRS[0])}

Push these local branches to origin, IN THIS ORDER, each a fast-forward of origin (never force): ${entries.map((e) => `${e.it.branch} (#${e.it.pr})`).join(', ')}. For each: \`git -C ${MAIN} push origin ${'${branch}'}:${'${branch}'}\` (local branches are shared across worktrees; retry network errors up to 4 times, 2/4/8/16 s). If a push is rejected as non-fast-forward, stop and report; do not force.
Then update each PR's description with mcp__github__update_pull_request (load it with ToolSearch). For each PR: read the body (\`gh api ${R}/pulls/<n> --jq .body\`); remove any line starting "Merge hold:"; make sure it has a line "Depends on #<previous link>." (previous links: ${entries.map((e) => `#${e.it.pr} → Depends on #${e.prev.pr}`).join('; ')}), next to any existing "Depends on" lines (keep those); add or replace a short "## Refreshed onto main" section just before the "Reviewed with sol-review" line saying: main merged in (after #66, #67 and #68), stacked on #<previous link> because the Profile PRs add entries to the same registries, the conflicts resolved (one line), the resolution reviewed by a fresh reviewer, and the gates that passed (one line). Per-PR facts: ${entries.map((e) => `#${e.it.pr}: conflicts: ${(e.st.conflicts || '').slice(0, 300).replace(/`/g, "'")}; review: ${verified[e.it.pr]?.review?.verdict || 'none'}; fixes: ${(verified[e.it.pr]?.verify?.fixes || 'none').slice(0, 200).replace(/`/g, "'")}; gates: ${(verified[e.it.pr]?.verify?.gates || '').slice(0, 300).replace(/`/g, "'")}`).join(' || ')}. Keep every other line, including the Sol line and the final attribution lines. Never comment on, merge or subscribe to PRs.
Report each pushed sha and that each body was updated (re-read it to confirm).`,
	{ label: 'push', phase: 'Push', effort: 'medium' }
);

phase('Audit');
const audit = await agent(
	`Audit only. Do not edit, commit, push, or comment. ${CONTEXT}
The chain was pushed: origin/fix/m2-profile-section-css (#86) → ${entries.map((e) => `origin/${e.it.branch} (#${e.it.pr})`).join(' → ')}. In ${MAIN}: \`git fetch -q origin\`. Check:
1. Each branch contains origin/main and the previous link (\`git merge-base --is-ancestor\`).
2. For each link, \`git diff origin/<previous link> origin/<branch> --stat\` touches only that PR's own files; compare with the PR's original change (\`gh api ${R}/pulls/<n>/files --paginate --jq '.[].filename'\` lists the PR's files as GitHub sees them now) and flag anything foreign.
3. At the last link, every registry holds every section exactly once: src/lib/server/forms/sections.ts SECTIONS keys, src/lib/ui/profile/editors.ts EDITORS keys, src/lib/ui/profile/sections.ts entries, e2e/a11y.e2e.ts SCREENS; list them and compare with the sections the chain's PRs add (goals, experience, equipment, strength on main, plus basics, specifics, body, injuries, exercises, schedule from the chain). Also check the rules in CONTEXT on the last link.
4. \`gh api ${R}/pulls/<n> --jq '{mergeable_state, body}'\` for each: no "Merge hold:" line, a "Depends on" line naming the previous link.
Report findings (empty list if all good).`,
	{ label: 'audit', phase: 'Audit', model: 'opus', effort: 'high', schema: { type: 'object', properties: { ok: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } }, registries: { type: 'string' } }, required: ['ok', 'findings'] } }
);

return {
	stoppedAt,
	links: entries.map((e) => ({ pr: e.it.pr, branch: e.it.branch, base: e.st.base, stackedHead: e.st.head, conflicts: e.st.conflicts, review: verified[e.it.pr]?.review?.verdict, verifyHead: verified[e.it.pr]?.verify?.head, fixed: verified[e.it.pr]?.verify?.fixed, fixes: verified[e.it.pr]?.verify?.fixes, problems: [e.st.problems, verified[e.it.pr]?.verify?.problems].filter(Boolean).join(' | ') })),
	cascade,
	pushed: typeof pushed === 'string' ? pushed.slice(0, 2000) : pushed,
	audit
};