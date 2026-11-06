export const meta = {
	name: 'm2-cutover',
	description:
		'M2 production cutover PR (remove vercel.json guards, post-deploy smoke workflow, route re-audit, ASVS self-review, docs) → Sol fix loop → file-pr, held until the owner sets OWNER_SETUP_TOKEN_HASH',
	phases: [
		{ title: 'Implement', detail: 'brief m2.json step 3' },
		{
			title: 'Sol + publish',
			detail: 'sol-review fix loop, gates, push, file-pr with a merge hold'
		}
	]
};

const S = '<SCRATCH>'; // set to your scratchpad (it holds bin/, env/, wt/, plans/, pr-bodies/)
const BIN = `${S}/bin`;
const MAIN = '<REPO>'; // the main checkout (never modified by agents)
const R = 'repos/TheCruzControll/performance-coach';
const TRAILER = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const slug = 'cutover';
const port = 4790;
const branch = 'feat/m2-production-cutover';
const envf = `${S}/env/${slug}.sh`;

const MACHINE = `MACHINE RULES (an 8 GB Mac shared by up to 8 agents): work only in your worktree ${S}/wt/${slug} (never in ${MAIN} or another worktree). Run \`bash ${BIN}/agent-env ${slug} ${port}\` once inside it, then prefix every node/pnpm command with \`source ${envf} && \`. Heavy commands (svelte-check, vite build, Playwright) go through \`slot\` (at most two machine-wide); heavy Bash calls get timeout 600000. Run only the e2e specs you touch or add (never the whole suite, the 'perf' or 'exclusive' projects, or --repeat-each above 3). Kill servers and browsers you start. Local WebKit is macOS WebKit; CI's Linux Chromium + WebKit + Lighthouse is the final gate. Use REST (\`gh api ${R}/...\`), never \`gh pr create/edit/merge\`. You are a child agent: never watch, merge or comment on PRs. Do not touch Vercel, Neon or GitHub settings: hosted settings belong to the owner and the main thread. Avoid rewriting docs/testing.md and docs/security.md paragraphs other PRs also edit: add new lines or sections instead.`;

const TASK = `Project: "Performance Coach" (GitHub TheCruzControll/performance-coach), a private single-user AI training PWA (SvelteKit 3 / Svelte 5, TypeScript strict, Postgres + Drizzle, passkeys, Vercel + Neon; domain coach.nikocruz.com). Every M2 security fix is merged on main (the last one, IPv6 rate limits, is PR #35, still in CI). Your PR TURNS PRODUCTION ON. Read the brief: \`git show origin/handoff:docs/handoff/briefs/m2.json | jq -r '.steps[2]'\` and do every bullet in the repo only:
- Remove the production guards: vercel.json \`git.deploymentEnabled.main: false\` and the production skip in scripts/vercel-ignore-build.sh (keep the ignore step only if it still has a purpose; otherwise remove it and update scripts/vercel-ignore-build.test.ts; the build-command tests must stay).
- Add .github/workflows/post-deploy-smoke.yml on \`deployment_status\` (state success, environment Production) that checks https://coach.nikocruz.com: GET /api/health → 200 with db up; GET / → 200 sign-in page; GET /today unauthenticated → redirect to sign-in; POST /api/vitals unauthenticated → 401; the security headers present. No secrets. Validate the YAML (fetch the actionlint release binary into your worktree dir if you can).
- Re-audit the deny-by-default guard against every route in src/routes: confirm a unit/e2e check fails when a new route is not classified public or protected (add it if missing).
- Self-review the auth code like a security reviewer against OWASP ASVS L2 authentication and session sections (as a checklist; step-up re-auth, recovery, rate limits, setup token single-use are already merged). Record findings and fixes in a NEW section of docs/security.md; fix anything real and small in this PR, and list anything bigger as follow-ups.
- docs/deployment.md: production is on; the owner's one-time setup (run \`pnpm auth:setup-token\` locally, set OWNER_SETUP_TOKEN_HASH in Vercel → Production as a sensitive variable and redeploy, open https://coach.nikocruz.com/setup?token=<token> on the iPhone, register the passkey, store the recovery codes, then remove the hash); rollback; a lost passkey (recovery codes; last resort \`pnpm auth:reset-owner\`, which already exists and refuses without explicit confirmation and DATABASE_URL_UNPOOLED: verify that and say so).
- Update docs/milestones.md (M2: production cutover in this PR) and README.
- M2 acceptance 6 must hold: sign-out clears everything the device holds for the account (Cache Storage entries other than the versioned app shell, any IndexedDB data); /api/vitals and /api/client-errors require a session. Verify both with the existing tests; add what is missing.
- In your report and the PR body, list exactly which hosted env vars must exist in Production and in Preview before merge (check src/lib/server/env.ts and scripts/vercel-build.sh).`;

const COMMITS = `Commits: Conventional Commits; subject, blank line, short plain-prose body; end every message with exactly the line \`${TRAILER}\`. Mention no AI model anywhere except the PR description lines.`;
const GATES = `GATES (each with \`source ${envf} && \`): pnpm lint; slot pnpm check; pnpm test:unit; pnpm test:integration; slot pnpm build:node && pnpm budgets; slot pnpm build; the e2e specs you touched (access.e2e.ts and auth specs at least) on Chromium (\`slot pnpm exec playwright test <specs> --project=setup --project=iphone-chromium --reporter=line\`) and WebKit (\`E2E_WEBKIT=1 slot pnpm exec playwright test <specs> --project=setup --project=setup-webkit --project=iphone-webkit --reporter=line\`). Report real output excerpts.`;

const OUT = {
	type: 'object',
	properties: {
		branch: { type: 'string' },
		base: { type: 'string' },
		prNumber: { type: 'number' },
		prUrl: { type: 'string' },
		envVars: { type: 'string', description: 'hosted env vars required in Production and Preview' },
		asvsFindings: { type: 'array', items: { type: 'string' } },
		followUps: { type: 'array', items: { type: 'string' } },
		solVerdict: { type: 'string' },
		solRounds: { type: 'number' },
		ledger: { type: 'array', items: { type: 'string' } },
		gates: { type: 'string' },
		summary: { type: 'string' },
		problems: { type: 'string' }
	},
	required: ['summary']
};

const impl = await agent(
	`${TASK}
${MACHINE}
START: \`git -C ${MAIN} fetch -q origin && git -C ${MAIN} worktree add ${S}/wt/${slug} -b ${branch} origin/main\`; record BASE = \`git rev-parse HEAD\`.
${GATES}
${COMMITS} Small logical commits are fine (guards, smoke workflow, route audit, ASVS review, docs). Commit on ${branch}; do not push. Leave the tree clean.
Report branch, base, env vars, ASVS findings, follow-ups, a summary and gates.`,
	{ label: 'impl:cutover', phase: 'Implement', schema: OUT }
);
if (!impl || !impl.base) return { error: 'implementer failed', impl };

const pub = await agent(
	`${TASK}
${MACHINE}
Branch ${branch} in ${S}/wt/${slug} is implemented and committed (from BASE ${impl.base}), not pushed. Implementer report: ${JSON.stringify(impl)}
1. SOL REVIEW: load the sol-review skill (Skill tool, skill "sol-review") and follow it as the FIX-LOOP owner (the user authored this branch). Intent: turn production on safely: no unauthenticated access, a smoke check after every production deploy, accurate setup/rollback/lost-passkey docs. Load T3 tools with ToolSearch \`select:mcp__t3-code__orchestrator_capabilities,mcp__t3-code__delegate_task,mcp__t3-code__task_cancel,mcp__t3-code__task_status\`, call orchestrator_capabilities, use the latest Sol on the codex provider (currently gpt-6.1-sol) with reasoningEffort "xhigh" (security). You get no async notices: delegate_task with \`mode: "wait"\`, \`timeoutMs: 3600000\`, role "review", isolation "shared", a new clientRequestId each round; if a wait times out call task_status once; never a second reviewer for a round. Repo in the brief = your worktree's absolute path. Up to 5 rounds. Smallest fixes. Fold fixes into the commits (\`git commit --fixup\` + \`GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash ${impl.base}\`).
2. ${GATES} ${COMMITS}
3. \`git push -u origin ${branch}\`.
4. PR per the file-pr skill (Skill tool, skill "file-pr"): title a concise human-readable Conventional Commit (e.g. "feat(deploy): turn on coach.nikocruz.com, with a smoke check after every production deploy"); body opens with the plain problem (the app is built but production is off until passkey auth and the security fixes are in; they are), then the change; a "Before merge" section with the exact hosted env vars per environment and the owner's setup steps; a "Security review" section summarising the ASVS findings and follow-ups; "Tests"; then these lines exactly, each on its own line: \`Depends on #35.\` and \`Merge hold: OWNER_SETUP_TOKEN_HASH must be set in Vercel Production first (the owner generates it with pnpm auth:setup-token).\`; then, only if Sol approved with no blocker or should open, exactly \`Reviewed with sol-review: <N> rounds with <model> on <effort>. Sol verdict: approved\`; last line \`Created with Claude Opus 5.5 in Claude Code.\` Body file in ${S}/pr-bodies/. Create a NON-draft PR: \`gh api ${R}/pulls -f title="<title>" -f head=${branch} -f base=main -F body=@<file>\` (check none exists first).
5. \`git -C ${MAIN} worktree remove --force ${S}/wt/${slug}\`.
Report PR number and URL, env vars, ASVS findings, follow-ups, Sol verdict, rounds, ledger, gates.`,
	{ label: 'sol+pr:cutover', phase: 'Sol + publish', schema: OUT }
);
return pub || { error: 'publish failed', impl };
