export const meta = {
	name: 'profile-chain-finish',
	description: 'Finish the restacked Profile chain: merge current main into the first link and carry it down the chain with gates, push every link in order with updated PR descriptions, then audit',
	phases: [
		{ title: 'Cascade', detail: 'main into #73, then each link merges the previous; lint + check per link, full gates at the end' },
		{ title: 'Push', detail: 'push in order, update PR descriptions' },
		{ title: 'Audit', detail: 'independent check of the pushed chain' }
	]
};

const S = '<scratch>';
const MAIN = '/home/user/performance-coach';
const R = 'repos/TheCruzControll/performance-coach';
const TRAILERS = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01BpPosSc4jpv9ky7GSNsgpd';
const E = args.entries;

const env = (e) => `MACHINE RULES: a 4-CPU Linux cloud container shared with other agents. Worktrees: ${E.map((x) => `${S}/wt/${x.slug} (branch ${x.branch})`).join(', ')}. They exist: reuse them as they are, never reset or re-create them; they hold unpushed merges. Run \`bash ${S}/bin/agent-env <slug> <port>\` in a worktree only if ${S}/env/<slug>.sh is missing, and prefix node/pnpm commands with \`source ${S}/env/<slug>.sh && \`. Heavy commands (svelte-check, vite build, Playwright, the integration suite) go through \`slot\` (${S}/bin/slot); heavy Bash calls get timeout 600000. Local Postgres 16 on 5432 is shared (touch only coach_<slug>_* databases); if it is down, \`pg_ctlcluster 16 main start\`. Only Chromium runs locally (never \`playwright install\`, never E2E_WEBKIT=1). GitHub reads with \`gh api ${R}/...\`. Never merge, comment on, or subscribe to PRs; never touch hosted settings. Never rewrite history (no rebase, amend or force-push): only add commits. Commit messages end with exactly:\n${TRAILERS}`;

const CONTEXT = `CONTEXT: Profile section editors live at /profile/[section]. The held Profile PRs each add one section (or extend goals) and all touch the same registries: src/lib/server/forms/sections.ts (SECTIONS), src/lib/ui/profile/editors.ts (EDITORS), src/lib/ui/profile/sections.ts (Profile's list), e2e/a11y.e2e.ts (SCREENS), sometimes SectionScreen.svelte, docs rows and budgets tables. They were restacked earlier today as one chain on main + #86 (#86 has since merged): ${E.map((x) => `#${x.pr} ${x.branch}`).join(' → ')}; each link was reviewed by a fresh reviewer (all APPROVE) and passed full gates; fixes on #74 and #84 were already carried down the whole chain by local merges. Since then main moved on by about 30 merges (M3 Train week/session/plan, M4 workout domain and on-device store, M5 coach contracts, the mail layer, the page-leaving fix #122, analytics) that do not touch the Profile registries. The m2/33-profile-body worktree (ch76) also already has one extra local commit "Merge main into m2/33-profile-body" (d4ea9c7).
Rules that must survive every merge: sectionContext in src/lib/server/forms/sections.ts awaits its reads one at a time (one query at a time per Executor); vite.config.ts has ONE build.modulePreload.resolveDependencies rule and no importWithoutModulepreload plugin; SectionScreen.svelte keeps the SSR guard \`import.meta.env.SSR ? Promise.reject(new Error('client only')) : EDITORS[key]()\`; no Promise.all over one db handle or transaction; every registry keeps every section exactly once.`;

phase('Cascade');
const cascade = await agent(
	`${env(E[0])}

${CONTEXT}

Bring current main into the whole chain, in order:
1. In ${S}/wt/${E[0].slug} (branch ${E[0].branch}): \`git -C ${MAIN} fetch -q origin\`, then \`git merge --no-edit origin/main -m "Merge main into ${E[0].branch}"\`. Resolve any conflict keeping both sides.
2. Then for each next link, in its OWN worktree: ${E.slice(1).map((x, i) => `${x.slug}: \`git merge --no-edit ${E[i].branch} -m "Merge ${E[i].branch} into ${x.branch}"\``).join('; ')}. (Local branches are shared across worktrees, so the previous link's branch name is its local head.) Resolve keeping both sides; keep every registry entry exactly once.
3. After each link's merge: \`pnpm lint\` and \`slot pnpm check\` in that worktree. Fix any real breakage with a small commit in that link (and let it flow down with the next merge).
4. At the LAST link (${E[E.length - 1].slug}), run the full gates: \`pnpm test:unit\`; \`pnpm db:reset:test && slot pnpm test:integration\`; \`slot pnpm build:node && pnpm budgets\` (paste the /(app)/profile/[section], /(app)/profile and /(app)/profile/security rows); and on Chromium \`E2E_SERIAL_ALONE=1 slot pnpm exec playwright test e2e/profile-*.serial.e2e.ts --project=serial-chromium --reporter=line --trace off\` plus \`slot pnpm exec playwright test e2e/a11y.e2e.ts --project=setup --project=iphone-chromium --reporter=line --trace off\`. A failure is yours to root-cause and fix with a small commit in the link that owns it, then merge that link down again; never skip, loosen or quarantine a test. If a failure is not the chain's (it fails on origin/main too), say so with the evidence and do not fix it here.
5. Do not push. Leave every tree clean.
Report, per branch, the new head (\`git rev-parse HEAD\` in its worktree), any fix commits, and the gates with real output excerpts.`,
	{ label: 'cascade-main', phase: 'Cascade', effort: 'high', schema: { type: 'object', properties: { heads: { type: 'object', additionalProperties: { type: 'string' } }, fixes: { type: 'string' }, gates: { type: 'string' }, blocked: { type: 'boolean' }, problems: { type: 'string' } }, required: ['heads', 'gates', 'blocked'] } }
);
if (!cascade || cascade.blocked) return { cascade, stopped: 'cascade blocked or failed' };

phase('Push');
const pushed = await agent(
	`${env(E[0])}

Push these local branches to origin, IN THIS ORDER, each a fast-forward of origin (never force): ${E.map((x) => `${x.branch} (#${x.pr}) at ${cascade.heads[x.branch] || '(its worktree HEAD)'}`).join(', ')}. For each: \`git -C ${MAIN} push origin <branch>:<branch>\` (retry network errors up to 4 times, 2/4/8/16 s). If a push is rejected as non-fast-forward, stop and report; do not force.
Then update each PR's description with mcp__github__update_pull_request (load it with ToolSearch). For each PR: read the body (\`gh api ${R}/pulls/<n> --jq .body\`); remove any line starting "Merge hold:"; make sure it has a line "Depends on #<previous link>." (${E.map((x) => `#${x.pr} → Depends on #${x.prevPr}`).join('; ')}), next to any existing "Depends on" lines (keep those, but drop a "Depends on #86" line since #86 has merged); add or replace a short "## Refreshed onto main" section just before the "Reviewed with sol-review" line saying: main merged in, stacked on #<previous link> because the Profile PRs add entries to the same registries, the conflicts resolved (one line), the resolution reviewed by a fresh reviewer, and the gates that passed (one line). Per-PR facts: ${E.map((x) => `#${x.pr}: conflicts: ${x.conflicts}; review: ${x.review}; fixes: ${x.fixes}; gates: ${x.gates}`).join(' || ')}. Final gates on the last link after main came in: ${(cascade.gates || '').slice(0, 600).replace(/`/g, "'")}. Keep every other line, including the Sol line and the final attribution lines. Never comment on, merge or subscribe to PRs.
Report each pushed sha and that each body was updated (re-read it to confirm).`,
	{ label: 'push', phase: 'Push', effort: 'medium' }
);

phase('Audit');
const audit = await agent(
	`Audit only. Do not edit, commit, push, or comment. ${CONTEXT}
The chain was pushed: ${E.map((x) => `origin/${x.branch} (#${x.pr})`).join(' → ')}. In ${MAIN}: \`git fetch -q origin\`. Check:
1. Each branch contains origin/main and the previous link (\`git merge-base --is-ancestor\`).
2. For each link, \`git diff origin/<previous link> origin/<branch> --stat\` (for #73, against origin/main) touches only that PR's own files; compare with \`gh api ${R}/pulls/<n>/files --paginate --jq '.[].filename'\` and flag anything foreign.
3. At the last link, every registry holds every section exactly once: SECTIONS keys, EDITORS keys, src/lib/ui/profile/sections.ts entries, e2e/a11y.e2e.ts SCREENS; list them (goals, experience, equipment, strength from main, plus basics, specifics, body, injuries, exercises, schedule from the chain). Check the CONTEXT rules on the last link.
4. \`gh api ${R}/pulls/<n> --jq '{mergeable_state, body}'\` for each: no "Merge hold:" line, a "Depends on" line naming the previous link.
Report findings (empty list if all good).`,
	{ label: 'audit', phase: 'Audit', model: 'opus', effort: 'high', schema: { type: 'object', properties: { ok: { type: 'boolean' }, findings: { type: 'array', items: { type: 'string' } }, registries: { type: 'string' } }, required: ['ok', 'findings'] } }
);

return { cascade, pushed: typeof pushed === 'string' ? pushed.slice(0, 2000) : pushed, audit };