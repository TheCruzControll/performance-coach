export const meta = {
	name: 'pr-ci-fix',
	description: 'Root-cause and fix red CI on open PRs this session owns: investigate the failing CI run (logs, screenshots, traces), smallest fix, gates, a Sol review of the fix diff, push',
	phases: [
		{ title: 'Fix', detail: 'one agent per PR: investigate, fix, gates, commit' },
		{ title: 'Sol', detail: 'fresh reviewer on the fix diff, up to 2 rounds' },
		{ title: 'Push', detail: 'push and update the PR description' }
	]
};

const S = '<scratch>';
const MAIN = '/home/user/performance-coach';
const R = 'repos/TheCruzControll/performance-coach';
const TRAILERS = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01BpPosSc4jpv9ky7GSNsgpd';

const FIX_OUT = {
	type: 'object',
	properties: {
		base: { type: 'string', description: 'the PR head sha before your fix' },
		head: { type: 'string' },
		rootCause: { type: 'string' },
		fix: { type: 'string' },
		gates: { type: 'string' },
		problems: { type: 'string' }
	},
	required: ['base', 'head', 'rootCause', 'fix', 'gates']
};
const REVIEW_OUT = {
	type: 'object',
	properties: {
		verdict: { type: 'string', enum: ['APPROVE', 'CHANGES'] },
		text: { type: 'string' },
		openFindings: { type: 'array', items: { type: 'string' } }
	},
	required: ['verdict', 'text']
};

const machine = (it) => `MACHINE RULES: a 4-CPU Linux cloud container shared with other agents. Work only in ${S}/wt/${it.slug} (create it with \`git -C ${MAIN} fetch -q origin && git -C ${MAIN} worktree add ${S}/wt/${it.slug} ${it.branch}\`, or reuse it; then \`git merge --ff-only origin/${it.branch}\`), run \`bash ${S}/bin/agent-env ${it.slug} ${it.port}\` once, and prefix node/pnpm commands with \`source ${S}/env/${it.slug}.sh && \`. Heavy commands (svelte-check, vite build, Playwright) go through \`slot\`; heavy Bash calls get timeout 600000. Only Chromium runs locally (WebKit is not installed and must not be: never \`playwright install\`, never E2E_WEBKIT=1); CI runs WebKit. GitHub reads with \`gh api ${R}/...\` (REST); CI artifacts download with \`gh api ${R}/actions/artifacts/<id>/zip > file.zip\` (unzip into a new empty directory under ${S}/ci-artifacts/). Never merge, comment on, or subscribe to PRs; never touch hosted settings. Commits: Conventional Commits, a plain-prose body, ending with exactly:\n${TRAILERS}`;

async function fixOne(it) {
	let fix = await agent(
		`${machine(it)}

PR #${it.pr} (branch ${it.branch}) of the Performance Coach app (SvelteKit 3 / Svelte 5, Postgres, Playwright on Chromium + WebKit iPhone projects) is red in CI. Failing check: ${it.check} in CI run ${it.runId}. Excerpt:
${it.failure}
This is a real failure on WebKit (Chromium passes): root-cause it, do not paper over it. Steps:
1. Read the PR's diff (\`git diff origin/main...${it.branch}\`), the failing spec and the code it exercises.
2. Download the run's artifacts (\`gh api "${R}/actions/runs/${it.runId}/artifacts" --jq '.artifacts[] | {id,name}'\`), look at the WebKit failure screenshots with the Read tool and the trace/error-context files, and read the job log around the failure (\`gh api ${R}/actions/jobs/<job id>/logs\`).
3. Work out what WebKit (Safari's engine) does differently. Likely suspects: how a failed dynamic import() is cached and retried, view transitions, timing of hydration, route interception in Playwright's WebKit.
4. Make the smallest fix that makes the intended behaviour work on both engines. Fix the product when the product is wrong on Safari; fix the test only when the test is wrong (never skip, loosen or quarantine a test to get green; never delete an assertion that checks real behaviour).
5. Gates: pnpm lint; slot pnpm check; pnpm test:unit; the touched e2e specs on Chromium (\`slot pnpm exec playwright test <specs> --project=setup --project=iphone-chromium --reporter=line\`, plus any serial project the spec belongs to); slot pnpm build:node && pnpm budgets if browser code changed. Commit the fix on ${it.branch}. Do not push.
Report base (the PR head before your fix: \`git rev-parse origin/${it.branch}\`), head, rootCause, fix, gates (real output excerpts), problems.`,
		{ label: `fix:#${it.pr}`, phase: 'Fix', schema: FIX_OUT }
	);
	if (!fix) return { pr: it.pr, error: 'fixer failed' };
	let approved = false, rounds = 0, lastText = '';
	for (let r = 1; r <= 2; r++) {
		rounds = r;
		const rev = await agent(
			`Review only. Do not edit, commit, push, comment on PRs, start subagents, or use the sol-review or council skills.
Repo: ${S}/wt/${it.slug} Base: ${fix.base} Head: ${fix.head}
Intent: fix PR #${it.pr}'s WebKit-only CI failure (${it.check}) at its root cause. Fixer's diagnosis: ${fix.rootCause}. Fix: ${fix.fix}
Out of scope: the rest of PR #${it.pr} (already reviewed); prose style.
Checks: ${fix.gates}
See: git diff ${fix.base} ${fix.head} (the worktree is checked out at the head).
Read surrounding code. Find bugs, broken callers, mismatch with intent. Check that the fix works on Safari/WebKit and Chromium, does not loosen a test, and is the smallest fix. Skip style unless it hides a bug. Hold to the smallest change.
blocker = intended case wrong. should = real bug callers will hit, in intent. nit = rest. VERDICT is APPROVE when no blocker or should remains open.${r > 1 ? `\nRound ${r}: your previous reply was:\n${lastText}\nThe fixer answered with new commits; review the change since then: git diff ${fix.prevHead || fix.base} ${fix.head}. Mark old findings resolved or still open.` : ''}
Reply:
VERDICT: APPROVE or CHANGES
S1 [blocker|should|nit] <file>:<line> <claim>. Fix: <suggestion>`,
			{ label: `sol-r${r}:#${it.pr}`, phase: 'Sol', model: 'opus', effort: it.effort, schema: REVIEW_OUT }
		);
		if (!rev) break;
		lastText = rev.text;
		if (rev.verdict === 'APPROVE') { approved = true; break; }
		if (r === 2) break;
		const prev = fix.head;
		const again = await agent(
			`${machine(it)}

You own the fix for PR #${it.pr}'s WebKit failure on ${it.branch} (fix commits from ${fix.base} to ${fix.head}). A reviewer replied:
${rev.text}
Check each finding yourself; make the smallest fix for real ones (commit), disagree with evidence otherwise. Re-run the covering checks. Do not push. Report base ${fix.base}, head, rootCause, fix (what changed now), gates, problems.`,
			{ label: `fix-r${r}:#${it.pr}`, phase: 'Sol', schema: FIX_OUT }
		);
		if (!again) break;
		fix = { ...again, base: fix.base, prevHead: prev };
	}
	const pushed = await agent(
		`${machine(it)}

Push the fix on ${it.branch} (worktree ${S}/wt/${it.slug}): \`git push origin ${it.branch}\` (a fast-forward; retry network errors). Then update PR #${it.pr}'s description with the GitHub MCP tool mcp__github__update_pull_request (load it with ToolSearch): read the current body (\`gh api ${R}/pulls/${it.pr} --jq .body\`), add a short "## CI fix" section before the "Reviewed with sol-review" line saying what failed on WebKit, the root cause (${fix.rootCause}) and the fix, ${approved ? `and replace the "Reviewed with sol-review: …" line with "Reviewed with sol-review: ${it.priorRounds + rounds} rounds with Claude Opus 5.5 on ${it.effort}. Sol verdict: approved"` : 'and REMOVE the "Reviewed with sol-review" line (the fix was not approved), adding a line "Sol review of the CI fix: not approved" instead'}; keep every other line, including the final attribution lines. Then \`git -C ${MAIN} worktree remove --force ${S}/wt/${it.slug}\`. Report what you pushed (sha) and the PR update.`,
		{ label: `push:#${it.pr}`, phase: 'Push', effort: 'medium' }
	);
	return { pr: it.pr, approved, rounds, rootCause: fix.rootCause, fix: fix.fix, pushed: typeof pushed === 'string' ? pushed.slice(0, 600) : pushed };
}

return await parallel(args.map((it) => () => fixOne(it)));