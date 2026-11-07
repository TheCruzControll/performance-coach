export const meta = {
	name: 'm1-audit',
	description:
		'Independent audit of Milestone 1 against current main: execute every acceptance criterion, adversarially verify findings, per-criterion verdict',
	phases: [
		{
			title: 'Audit',
			detail: '4 auditors: gates+e2e, runtime+ops+hygiene, docs accuracy, design+performance'
		},
		{
			title: 'Verify',
			detail: 'one adversarial verifier per auditor: refute findings, challenge weak "met" claims'
		},
		{ title: 'Verdict', detail: 'per-criterion verdict and fix list' }
	]
};

const S = '<SCRATCH>'; // set to your scratchpad (it holds bin/, env/, wt/, plans/, pr-bodies/)
const BIN = `${S}/bin`;
const SHA = args.sha;
const RUN = args.ciRun;
const A = `${S}/m1audit`;

const CRITERIA = `MILESTONE 1 — Foundation & infrastructure (docs/milestones.md; PRD §14–16, §19–21). Acceptance criteria:
1. \`pnpm install --frozen-lockfile\` succeeds from a clean clone; \`pnpm check\` and \`pnpm lint\` report 0 errors.
2. \`pnpm test:unit\` and \`pnpm test:integration\` pass; integration tests run against a real local Postgres test database with committed Drizzle migrations applied.
3. \`pnpm build\` (Vercel adapter) and \`pnpm build:node\` (Node adapter) succeed.
4. \`pnpm test:e2e\` passes on an iPhone-sized viewport against the production Node server: shell renders with bottom nav, navigation between all tabs works, \`/api/health\` reports \`db: up\` via a real query, no console errors, the manifest is served and the service worker registers.
5. Design-system foundations exist and are documented: dark-first tokens with light support, self-hosted fonts, the listed primitives; screens look premium on an iPhone viewport.
6. Budget script passes; a local Lighthouse mobile run is recorded with real numbers in docs/performance.md.
7. Observability works: Server-Timing on responses, /api/vitals stores metrics in Postgres, server errors are logged and recorded.
8. CI workflows exist and are valid; the backup workflow skips gracefully without secrets; deployed builds migrate first (scripts/vercel-build.sh).
9. Documentation set exists and is accurate.
10. Code is separated into domain / server db / services / agent / auth / client / ui / routes; all work committed with Conventional Commits; no secrets or build output.
M1's own "known gaps" (deferred on purpose): real-device iPhone checklist → M2 production cutover; production off until M2 auth; RUM p75 → later; Lighthouse on GitHub runners was not yet run at the time.`;

const RULES = `You are an INDEPENDENT AUDITOR of the "Performance Coach" repo (GitHub TheCruzControll/performance-coach; SvelteKit 3 / Svelte 5, TypeScript, Postgres + Drizzle, Vercel). Audit commit ${SHA} (current main; M2 auth/profile work is already merged on top of M1, so judge M1's criteria as they hold TODAY). Do not trust any checklist or doc claim: verify by executing commands and reading code. Evidence = real command output, file:line, measured numbers.
Machine rules (an 8 GB Mac shared with other agents): never touch <REPO> or other agents' worktrees; work only under ${A}/<your dir>. Wrap heavy commands (svelte-check, vite build, Playwright) in \`${BIN}/slot\` (a machine-wide limiter) and give heavy Bash calls timeout 600000. Never \`playwright install\`. Local WebKit is macOS WebKit, which differs from CI's Linux WebKit (on main, e2e/shell.e2e.ts "plate calculator sheet", "a late animation frame…" and "the theme preference applies before first paint" fail locally only); for Linux WebKit use CI evidence: run ${RUN} on main (\`gh run view ${RUN}\`, \`gh run view --job <id> --log\`, \`gh run download ${RUN} -D <dir>\`). Do not modify the repository, push, or open PRs. You only report.
${CRITERIA}`;

const FINDINGS = {
	type: 'object',
	properties: {
		criteria: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					criterion: { type: 'number' },
					status: { type: 'string', enum: ['met', 'partially-met', 'not-met'] },
					evidence: { type: 'string' }
				},
				required: ['criterion', 'status', 'evidence']
			}
		},
		findings: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					criterion: { type: 'number' },
					severity: { type: 'string', enum: ['major', 'minor', 'info'] },
					title: { type: 'string' },
					evidence: { type: 'string' },
					suggestedFix: { type: 'string' }
				},
				required: ['id', 'criterion', 'severity', 'title', 'evidence']
			}
		}
	},
	required: ['criteria', 'findings']
};
const VERIFIED = {
	type: 'object',
	properties: {
		criteria: FINDINGS.properties.criteria,
		findings: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					verdict: { type: 'string', enum: ['confirmed', 'refuted', 'downgraded'] },
					severity: { type: 'string', enum: ['major', 'minor', 'info'] },
					criterion: { type: 'number' },
					title: { type: 'string' },
					reason: { type: 'string' },
					suggestedFix: { type: 'string' }
				},
				required: ['id', 'verdict', 'severity', 'criterion', 'title', 'reason']
			}
		},
		newFindings: FINDINGS.properties.findings
	},
	required: ['criteria', 'findings']
};

const AUDITORS = [
	{
		key: 'gates',
		text: `YOUR SCOPE: criteria 1, 2, 3, 4 and the budget half of 6.
1. Fresh clone: \`mkdir -p ${A}/gates && cd ${A}/gates && git clone -q https://github.com/TheCruzControll/performance-coach.git clone && cd clone && git checkout -q ${SHA}\`.
2. In the clone: \`bash ${BIN}/agent-env m1gates 4490\` (does \`pnpm install --frozen-lockfile\`, creates databases coach_m1gates_{dev,test,e2e}, migrates dev, writes ${S}/env/m1gates.sh). Prefix every later command with \`source ${S}/env/m1gates.sh && \`.
3. Run and record: pnpm lint; slot pnpm check; pnpm test:unit; pnpm test:integration (confirm in tests/integration/global-setup.ts that it applies the committed migrations to the real test DB); pnpm db:drift; slot pnpm build; slot pnpm build:node; pnpm budgets (paste the table).
4. E2E on Chromium (iPhone viewport, production Node server): \`slot pnpm exec playwright test --project=setup --project=iphone-chromium --reporter=line\` (the full functional suite; split into spec groups if one call would exceed ~9 minutes). Then read e2e/shell.e2e.ts, e2e/platform.e2e.ts, e2e/offline.e2e.ts and confirm each sub-point of criterion 4 is actually asserted (bottom nav, every tab, /api/health db up via a real query, console errors fail the test, manifest served, service worker registers). Check CI run ${RUN}'s E2E job for the Linux WebKit and perf results (pass/fail counts).
Report each criterion's status with evidence, and every defect you find.`
	},
	{
		key: 'ops',
		text: `YOUR SCOPE: criteria 7, 8, 10, plus PWA/security headers.
1. \`mkdir -p ${A}/ops && cd ${A}/ops && git clone -q https://github.com/TheCruzControll/performance-coach.git clone && cd clone && git checkout -q ${SHA} && bash ${BIN}/agent-env m1ops 4491\`; prefix commands with \`source ${S}/env/m1ops.sh && \`.
2. Observability: read the code (hooks, src/lib/server/observability or similar, /api/vitals, /api/client-errors) and the integration tests that cover them (run them). Build and run the production server: \`ORIGIN=http://localhost:4491 slot pnpm build:node\`, then \`PORT=4491 ORIGIN=http://localhost:4491 node build/index.js > ${A}/ops/server.log 2>&1 &\` (kill it when done). With curl: Server-Timing on page and API responses, security headers (CSP, HSTS policy, frame, referrer, permissions), /api/health, /manifest.webmanifest (or whatever the app serves), the service worker script, that /api/vitals and /api/client-errors refuse without a session (401) and that a forced server error is logged and recorded in the app_errors table (check how the tests trigger one).
3. CI/CD: validate .github/workflows/*.yml (download the official actionlint release binary for darwin into ${A}/ops/tools from https://github.com/rhysd/actionlint/releases and run it; if that fails, review the YAML by hand). Read backup.yml and prove it skips gracefully without secrets (logic, plus \`gh run list --workflow backup.yml\` history). Read scripts/vercel-build.sh and its tests: deployed builds migrate first?
4. Hygiene: layer separation is ENFORCED (eslint boundaries config; try a forbidden import in a scratch copy and show lint fails, then revert); no secrets in the tree or history (\`git log -p --all | grep -nE\` for key-like patterns: API keys, private keys, DSNs, passwords other than the documented local coach:coach); no build output or generated files tracked that should not be (\`git ls-files\` against .gitignore); commit subjects on main follow Conventional Commits (\`git log --no-merges --format=%s origin/main\` against the regex; list violators).
Report each criterion's status with evidence, and every defect.`
	},
	{
		key: 'docs',
		text: `YOUR SCOPE: criterion 9 (documentation exists and is ACCURATE), plus README. Read-only: use \`git -C <REPO> show ${SHA}:<path>\`, \`git -C <REPO> ls-tree -r --name-only ${SHA}\` and \`git -C <REPO> grep <pattern> ${SHA}\` (read-only git commands on that checkout are fine). For EVERY doc (README.md, docs/*.md, docs/adr/*.md): check every command exists in package.json, every path and file exists, every env var matches src/lib/server/env.ts and .env.example, architecture/layers match the code, deployment steps match vercel.json and scripts/, testing docs match playwright.config.ts and vitest config, performance numbers and budgets match scripts/check-budgets.ts, the milestone status table is current (M1 merged in PR #1; M2 auth + profile services merged), and nothing describes behaviour the code does not have. PRD §20 lists the required documents: confirm each exists. Report each inaccuracy as a finding with doc file:line and the code that contradicts it.`
	},
	{
		key: 'design-perf',
		text: `YOUR SCOPE: criterion 5 (design-system foundations; premium iPhone screens) and the Lighthouse half of criterion 6.
1. Read docs/design-system.md and the code (git -C <REPO> show ${SHA}:<path>, read-only): tokens are dark-first with a light theme, all colours/spacing/type via tokens (grep components for hard-coded colours), fonts self-hosted (files in static/, @font-face, no third-party font hosts, preloads), every primitive the docs list exists and is used.
2. Screens: \`mkdir -p ${A}/design && gh run download ${RUN} -D ${A}/design/artifacts\` (Playwright screenshots and report from CI on Linux Chromium and WebKit). Open the screenshots of the M1 screens (shell, tabs, plate calculator, /design, offline, sign-in) with the Read tool, dark and light. Judge as a senior product designer: premium and cohesive, not a generic template? Typography, spacing rhythm, hierarchy, contrast, touch targets, safe areas, empty/loading/error states. Cite the screenshot file for every point.
3. Performance: compare docs/performance.md's recorded Lighthouse numbers and budget table with reality: the Lighthouse job log of CI run ${RUN} (\`gh run view ${RUN} --json jobs\`, then \`gh run view --job <id> --log\`) and the build job's budget output. Are the documented numbers real, current and within the stated targets?
Report each criterion's status with evidence, and every defect.`
	}
];

const results = await pipeline(
	AUDITORS,
	(a) =>
		agent(`${RULES}\n\n${a.text}`, { label: `audit:${a.key}`, phase: 'Audit', schema: FINDINGS }),
	(found, a) =>
		agent(
			`${RULES}

You are the ADVERSARIAL VERIFIER for the '${a.key}' auditor. Their scope: ${a.text}

Their report: ${JSON.stringify(found)}

For EACH finding: try to REFUTE it (re-run the command, read the code yourself; check it is not an artefact of the local machine, e.g. macOS WebKit or a busy CPU). Mark it confirmed, refuted, or downgraded (with the right severity), with your reason. For EACH criterion they marked "met": challenge it. Is the evidence real and sufficient, or did they take a doc's word for it? Correct the status if needed. Add newFindings only for real defects they missed in their scope. Work read-only; you may reuse their directories under ${A}/ but do not delete them.`,
			{ label: `verify:${a.key}`, phase: 'Verify', schema: VERIFIED }
		).then((v) => ({ auditor: a.key, raw: found, verified: v }))
);

phase('Verdict');
const verdict = await agent(
	`${CRITERIA}

Independent auditors and adversarial verifiers produced these results for commit ${SHA}: ${JSON.stringify(results)}

You are the SYNTHESIZER. For each criterion 1–10 give the final status (met / partially-met / not-met) from the VERIFIED evidence, resolving any disagreement between auditors explicitly (say whose evidence wins and why). List the confirmed defects (drop refuted ones), deduplicated, ranked by severity, each with criterion, evidence, and a concrete fix sized as one small atomic PR. Then state plainly: is Milestone 1 completely finished today, and if not, exactly what remains. Also write the whole result as pretty JSON to ${S}/plans/m1-audit.json with the Write tool.`,
	{
		label: 'verdict:M1',
		phase: 'Verdict',
		schema: {
			type: 'object',
			properties: {
				finished: { type: 'boolean' },
				summary: { type: 'string' },
				criteria: FINDINGS.properties.criteria,
				defects: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							severity: { type: 'string' },
							criterion: { type: 'number' },
							title: { type: 'string' },
							evidence: { type: 'string' },
							fix: { type: 'string' }
						},
						required: ['severity', 'criterion', 'title', 'evidence', 'fix']
					}
				},
				remaining: { type: 'array', items: { type: 'string' } }
			},
			required: ['finished', 'summary', 'criteria', 'defects', 'remaining']
		}
	}
);
return verdict;
