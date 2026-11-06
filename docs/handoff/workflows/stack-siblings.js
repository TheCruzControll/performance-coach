export const meta = {
	name: 'profile-stack',
	description: 'Stack the profile PRs that were built on an older #60 onto main in merge order (each = main + earlier siblings + itself), resolve registry conflicts, gates, review the resolution, push',
	phases: [
		{ title: 'Stack', detail: 'per PR, in order: merge main and the previous sibling, resolve, gates' },
		{ title: 'Review', detail: 'a fresh reviewer reads the merge resolution (remerge-diff)' },
		{ title: 'Push', detail: 'push and update the PR description' }
	]
};

const S = '<scratch>';
const MAIN = '/home/user/performance-coach';
const R = 'repos/TheCruzControll/performance-coach';
const TRAILERS = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01BpPosSc4jpv9ky7GSNsgpd';
const PRS = args.prs; // [{pr, branch, slug, port}] in merge order
const firstPrev = args.prev || null; // {pr, branch} already stacked, or null

const STACK_OUT = {
	type: 'object',
	properties: {
		base: { type: 'string', description: 'origin/<branch> before your merges' },
		head: { type: 'string' },
		merges: { type: 'string', description: 'merge commits made, with their parents' },
		conflicts: { type: 'string', description: 'every conflicted file and how it was resolved' },
		gates: { type: 'string' },
		problems: { type: 'string' }
	},
	required: ['base', 'head', 'merges', 'conflicts', 'gates']
};
const REVIEW_OUT = {
	type: 'object',
	properties: { verdict: { type: 'string', enum: ['APPROVE', 'CHANGES'] }, text: { type: 'string' } },
	required: ['verdict', 'text']
};

const machine = (it) => `MACHINE RULES: a 4-CPU Linux cloud container shared with ~10 other agents. Work only in ${S}/wt/${it.slug} (create it with \`git -C ${MAIN} fetch -q origin && git -C ${MAIN} worktree add ${S}/wt/${it.slug} ${it.branch}\` (or \`-B ${it.branch} origin/${it.branch}\` if the local branch is behind or missing), or reuse it; make sure it is at origin/${it.branch}: \`git fetch -q origin && git merge --ff-only origin/${it.branch}\`), run \`bash ${S}/bin/agent-env ${it.slug} ${it.port}\` once, and prefix node/pnpm commands with \`source ${S}/env/${it.slug}.sh && \`. Heavy commands (svelte-check, vite build, Playwright, the full integration suite) go through \`slot\` (${S}/bin/slot); heavy Bash calls get timeout 600000. Local Postgres 16 on port 5432 is shared (touch only coach_${it.slug}_* databases); \`bash ${S}/bin/pg18 coach_${it.slug}_test\` gives a Postgres 18 database on port 5433 (CI and production run 18). Only Chromium runs locally (never \`playwright install\`, never E2E_WEBKIT=1). GitHub reads with \`gh api ${R}/...\` (REST). Never merge, comment on, or subscribe to PRs; never touch hosted settings. Never rewrite history on these branches (no rebase, amend or force-push): only add merge commits. Commit messages end with exactly:\n${TRAILERS}`;

const results = [];
let prev = firstPrev;
for (const it of PRS) {
	let st = await agent(
		`${machine(it)}

PR #${it.pr} (branch ${it.branch}) is one of several Profile-section PRs that were built on an older head of #60 (Profile → Equipment and the section editor route). #60 has since merged to main with fixes (one modulepreload rule in vite.config.ts; sectionContext in src/lib/server/forms/sections.ts awaiting its two reads in turn), and GitHub now refuses to update the branch ("merge conflict between base and head": criss-cross history). Sibling PRs all add entries to the same registries, so they also conflict with each other. We are STACKING them in merge order: each branch = main + the earlier siblings + itself, so each one's CI tests exactly what main will hold after it merges.

Your PR: #${it.pr}. ${prev ? `The sibling before it in the stack: #${prev.pr} (branch ${prev.branch}), already refreshed and pushed.` : 'It is the first in the stack.'}

1. Record base = \`git rev-parse origin/${it.branch}\`. Read the PR's own change first: \`git diff $(git merge-base origin/main origin/${it.branch})...origin/${it.branch} --stat\` and the PR description (\`gh api ${R}/pulls/${it.pr} --jq .body\`).
2. \`git merge --no-edit origin/main\` (message "Merge main into ${it.branch}").${prev ? ` Then \`git merge --no-edit origin/${prev.branch}\` (message "Merge ${prev.branch} into ${it.branch}", stacking on #${prev.pr}).` : ''}
3. Resolve every conflict keeping BOTH sides' intent: in registries and lists (section registries, editors maps, section lists, route-access tables, Playwright project lists, a11y spec lists, design-system rows, budgets tables) keep every entry, earlier siblings' first, then this PR's, never reformatting neighbours; in code, keep main's fixes (sequential reads, the one modulepreload rule) and this PR's behaviour; if this PR's own code has a Promise.all that puts two queries on one Executor (main's rule, docs/architecture.md, enforced by tests/integration/one-query-per-client.ts), fix it the same way in its own small commit and say so. If a conflict needs a real design choice, stop and report it in problems.
4. Gates on the result: \`pnpm lint\`; \`slot pnpm check\`; \`pnpm test:unit\`; \`pnpm db:reset:test && slot pnpm test:integration\` and the full integration suite on Postgres 18 (\`bash ${S}/bin/pg18 coach_${it.slug}_test\` then \`TEST_DATABASE_URL=postgres://coach:coach@localhost:5433/coach_${it.slug}_test slot pnpm test:integration\`); \`slot pnpm build:node && pnpm budgets\` (paste the /profile/[section], /profile and /profile/security rows); on Chromium the e2e specs this PR adds or changes plus e2e/profile-equipment.serial.e2e.ts (find the serial project names in playwright.config.ts; include --project=setup; use E2E_SERIAL_ALONE=1 if the config supports it).
5. Do not push. Leave the tree clean.
Report base, head, merges, conflicts (each file and how), gates (real output excerpts), problems.`,
		{ label: `stack:#${it.pr}`, phase: 'Stack', schema: STACK_OUT }
	);
	if (!st) { results.push({ pr: it.pr, error: 'stack agent failed' }); break; }
	if (st.problems && /stop|design choice|cannot|could not|fail/i.test(st.problems) && !/none/i.test(st.problems)) {
		log(`#${it.pr}: problems reported: ${st.problems.slice(0, 200)}`);
	}
	const rev = await agent(
		`Review only. Do not edit, commit, push, comment on PRs, start subagents, or use the sol-review or council skills.
Repo: ${S}/wt/${it.slug} (branch ${it.branch}), from ${st.base} to ${st.head}: merge commits bringing main${prev ? ` and the sibling #${prev.pr} (${prev.branch})` : ''} into PR #${it.pr}. Merges reported: ${st.merges}. Conflicts and resolutions reported: ${st.conflicts}
Read the resolutions with \`git log --oneline ${st.base}..${st.head}\` and \`git show --remerge-diff <each merge commit>\` (shows exactly how conflicts were resolved), plus any non-merge commit in the range (\`git show <sha>\`).
Check: every registry/list keeps all entries from both sides; main's fixes survived (src/lib/server/forms/sections.ts sectionContext awaits its reads in turn; vite.config.ts has ONE build.modulePreload.resolveDependencies rule and no importWithoutModulepreload plugin); this PR's own behaviour survived; no Promise.all over one Executor in this PR's code; nothing unrelated changed. Gates reported: ${st.gates}
blocker = a lost entry, a lost fix, broken behaviour. should = real bug. nit = rest. VERDICT is APPROVE when no blocker or should is open.
Reply:
VERDICT: APPROVE or CHANGES
S1 [blocker|should|nit] <file>:<line> <claim>. Fix: <suggestion>`,
		{ label: `review:#${it.pr}`, phase: 'Review', model: 'opus', effort: 'high', schema: REVIEW_OUT }
	);
	if (rev && rev.verdict !== 'APPROVE') {
		const fx = await agent(
			`${machine(it)}

You stacked PR #${it.pr} (${it.branch}) from ${st.base} to ${st.head}. A reviewer read the merge resolutions and replied:
${rev.text}
Check each finding; fix real ones with a small new commit (never amend a merge), disagree with evidence otherwise; re-run the covering gates. Do not push. Report base ${st.base}, head, merges, conflicts, gates, problems.`,
			{ label: `fix:#${it.pr}`, phase: 'Review', schema: STACK_OUT }
		);
		if (fx) st = { ...fx, base: st.base };
	}
	const pushed = await agent(
		`${machine(it)}

Push ${it.branch} from ${S}/wt/${it.slug}: \`git push origin ${it.branch}\` (a fast-forward from ${st.base}; retry network errors up to 4 times, 2/4/8/16 s). Then update PR #${it.pr}'s description with mcp__github__update_pull_request (load it with ToolSearch): read the body (\`gh api ${R}/pulls/${it.pr} --jq .body\`);${prev ? ` add the line "Depends on #${prev.pr}." next to the existing "Depends on" line (keep "Depends on #60.");` : ''} add a short "## Refreshed onto main" section before the "Reviewed with sol-review" line: main merged in after #60's fixes${prev ? `, stacked on #${prev.pr} because sibling profile PRs add entries to the same registries` : ''}; the conflicts resolved (${st.conflicts.slice(0, 400).replace(/`/g, "'")}); resolution reviewed${rev && rev.verdict === 'APPROVE' ? ' and approved' : ''}. Keep every other line, including the Sol line and the final attribution lines. Do not remove the worktree. Report the pushed sha.`,
		{ label: `push:#${it.pr}`, phase: 'Push', effort: 'medium' }
	);
	results.push({ pr: it.pr, head: st.head, conflicts: st.conflicts, review: rev ? rev.verdict : 'none', pushed: typeof pushed === 'string' ? pushed.slice(0, 300) : pushed });
	prev = { pr: it.pr, branch: it.branch };
}
return results;