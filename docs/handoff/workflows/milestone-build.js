export const meta = {
	name: 'milestone-build',
	description:
		'Implement a milestone, then independently verify + adversarially critique, fix until clean',
	whenToUse:
		'One run per product milestone; args carry the milestone brief and acceptance criteria',
	phases: [
		{ title: 'Implement', detail: 'sequential implementation agents on the milestone branch' },
		{ title: 'Verify', detail: 'independent acceptance verifier + adversarial critic' },
		{ title: 'Fix', detail: 'address failing criteria and critical/major issues' }
	]
};

const A = args;
const REPO = '/home/user/performance-coach';
const SCRATCH =
	'/tmp/claude-0/-home-user-performance-coach/a0807610-c911-59e6-8a46-93bf7eec1bed/scratchpad';

const PREAMBLE = `You are a senior engineer on a team building "Performance Coach", a private single-user AI performance coaching platform (owner: Niko Cruz, domain coach.nikocruz.com).
Repository: ${REPO} (git). Current branch: ${A.branch}. Milestone: ${A.id} — ${A.title}.

READ FIRST: ${REPO}/docs/product-requirements.md (full scope; section numbers referenced below). Once they exist, also read README.md, docs/architecture.md, docs/milestones.md and any docs relevant to your task before changing code. Follow the established conventions in the codebase.

Ground rules:
- Product priorities are equal: intelligent adaptive coaching, exceptional performance, exceptional premium design (dark-first, iPhone-first). Do not ship generic/boilerplate UI.
- Work ONLY inside ${REPO} on branch ${A.branch}. Never push, never create PRs, never switch branches, never rewrite history. Do not modify .claude/skills or skills-lock.json.
- Commit in ATOMIC, PR-SIZED commits with Conventional Commit messages (feat:, fix:, docs:, test:, chore:, perf:, refactor:, ci:). Every commit becomes (part of) its own small pull request, so: keep each commit to one coherent change of roughly ≤ 600 lines of non-test code (tests ship in the same commit as the code they cover; generated files such as drizzle/meta snapshots and the lockfile don't count); order commits so the tree is green at EVERY commit (pnpm check, lint, unit, integration and e2e would pass if the branch stopped there) — e.g. add inert building blocks first, then wire them in, then the e2e updates together with the behaviour change that needs them; never leave a broken intermediate commit to be fixed later. Every commit message must end with exactly these two trailer lines:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01BpPosRQF4PacWibcoaEuvm
  Never put any AI model identifier anywhere else (code, comments, docs, commit subjects). Never commit secrets, .env files, node_modules, build output, or large binaries.
- Environment facts: Linux, 4 CPUs, Node 22, pnpm 10. npm registry reachable. Network to neon.tech / vercel.com / cloudflare.com is BLOCKED from this machine. api.anthropic.com is reachable but there is NO API key here — the LLM must stay behind the provider interface with a deterministic mock provider for tests/dev; never fabricate a key.
- Hosted infrastructure ALREADY EXISTS and is managed only by the tech lead (read docs/deployment.md): Vercel project with Git integration (every PR gets a preview; scripts/vercel-build.sh migrates that environment's Neon branch, then builds), Neon branches \`production\` and \`preview\`, env vars DATABASE_URL / DATABASE_URL_UNPOOLED / ANTHROPIC_API_KEY on Vercel. Do NOT call any Vercel, Neon, Cloudflare or GitHub tools/APIs, and do not change hosted settings. If your work needs a new hosted env var or setting, list it in your summary under "Infra the tech lead must set" (name, environments, purpose) instead.
- Local PostgreSQL 16 is installed. Start it if needed: \`pg_ctlcluster 16 main start\`. Use the repo's db scripts (pnpm db:setup, db:migrate, db:generate, db:reset:test). Every schema change is a committed drizzle migration generated with pnpm db:generate (never hand-edit drizzle/meta); keep journal timestamps increasing.
- Playwright: Chromium for Playwright 1.63.0 is preinstalled at /opt/pw-browsers. @playwright/test is pinned to exactly 1.63.0. NEVER run \`playwright install\`. WebKit is NOT available locally; it runs only in CI (iphone-webkit project), so avoid Chromium-only APIs in app code and keep tests engine-neutral (or explicitly skip with a reason, e.g. CDP-only features). For Lighthouse use executablePath /opt/pw-browsers/chromium-1243/chrome-linux64/chrome with --headless --no-sandbox.
- Run the e2e suite with the repo's own command (pnpm test:e2e); never run two Playwright suites at once on this machine (the perf project measures CPU time).
- Use ${SCRATCH} for throwaway files. Kill any servers you start before finishing.
- Honesty is mandatory: never claim a test, build, or measurement passed unless you actually ran it and saw it pass. Report failures and gaps plainly.
- Consult installed skills when relevant: ${REPO}/.claude/skills/neon-postgres/SKILL.md (DB driver/pooling: node-postgres + attachDatabasePool on Vercel Fluid compute), ${REPO}/.claude/skills/neon/SKILL.md.`;

const VERIFY_SCHEMA = {
	type: 'object',
	properties: {
		passed: {
			type: 'boolean',
			description: 'true only if EVERY acceptance criterion is pass with evidence'
		},
		criteria: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					criterion: { type: 'string' },
					status: { type: 'string', enum: ['pass', 'fail', 'not_verified'] },
					evidence: { type: 'string' }
				},
				required: ['criterion', 'status', 'evidence']
			}
		},
		commandsRun: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					cmd: { type: 'string' },
					exitCode: { type: 'number' },
					summary: { type: 'string' }
				},
				required: ['cmd', 'exitCode', 'summary']
			}
		},
		issues: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
					description: { type: 'string' },
					location: { type: 'string' },
					suggestedFix: { type: 'string' }
				},
				required: ['severity', 'description']
			}
		}
	},
	required: ['passed', 'criteria', 'commandsRun', 'issues']
};

const CRITIC_SCHEMA = {
	type: 'object',
	properties: {
		issues: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
					category: { type: 'string' },
					description: { type: 'string' },
					location: { type: 'string' },
					evidence: { type: 'string' },
					suggestedFix: { type: 'string' }
				},
				required: ['severity', 'category', 'description', 'evidence']
			}
		},
		summary: { type: 'string' }
	},
	required: ['issues', 'summary']
};

const acceptanceText = A.acceptance.map((c, i) => `${i + 1}. ${c}`).join('\n');

phase('Implement');
const implSummaries = [];
for (let i = 0; i < A.steps.length; i++) {
	const r = await agent(
		`${PREAMBLE}

=== YOUR TASK (implementation step ${i + 1} of ${A.steps.length}) ===
${A.steps[i]}

Milestone acceptance criteria (the whole milestone will be verified against these by an independent reviewer):
${acceptanceText}

Previous steps' summaries (may be empty):
${implSummaries.map((s, j) => `--- step ${j + 1} ---\n${s}`).join('\n')}

When done: make sure everything you built type-checks, its tests pass, and it is committed. Return a concise summary (<= 400 words): what you built, key files, decisions made, commands you ran with results, and anything left incomplete.`,
		{ label: `impl:${A.id}:step${i + 1}`, phase: 'Implement' }
	);
	implSummaries.push(r || '(agent returned nothing)');
}

const verifyPrompt = (round) => `${PREAMBLE}

=== YOUR ROLE: INDEPENDENT ACCEPTANCE VERIFIER (round ${round}) ===
You did not build this milestone. Your job is to prove or disprove, with real evidence, that milestone ${A.id} meets EVERY acceptance criterion below. Be skeptical: compiling is not working. Actually run the commands (install, typecheck, lint, unit/integration tests against real Postgres, production build, Playwright end-to-end in an iPhone-sized viewport, any perf/budget scripts). Exercise the real app in a real browser like a user would; take screenshots (save PNGs under ${SCRATCH}/evidence/${A.id}/ and look at them with the Read tool) and judge what you see.
Do NOT modify application code or commit. (You may create throwaway scripts under ${SCRATCH}.)

Acceptance criteria:
${acceptanceText}

For each criterion return pass / fail / not_verified with concrete evidence (command + observed output, screenshot path + what it shows). Also list any other defects you found (severity critical/major/minor) with location and suggested fix. passed=true only if every criterion passes.`;

const criticPrompt = (round) => `${PREAMBLE}

=== YOUR ROLE: ADVERSARIAL CRITIC (round ${round}) ===
You did not build this milestone. Hunt for real problems in milestone ${A.id} (${A.title}) by reading the code and running it. Lenses: (1) requirements traceability against docs/product-requirements.md for this milestone's scope — anything required but missing, stubbed, faked, or hard-coded; (2) correctness bugs and edge cases; (3) security (auth bypass, secrets exposure, injection, unprotected endpoints, unsafe defaults); (4) performance (bundle bloat, N+1 queries, missing indexes, blocking UI, needless requests); (5) design/UX quality on an iPhone viewport (generic or inconsistent UI, poor states, touch targets) where UI exists; (6) maintainability and docs accuracy (docs claiming things that are not true).
Milestone scope and acceptance criteria:
${acceptanceText}
Report only issues you can back with evidence (file:line, command output, screenshot under ${SCRATCH}/evidence/${A.id}/). Severity: critical = broken/insecure/requirement missing; major = significant quality gap; minor = polish. Do NOT modify code or commit.`;

phase('Verify');
let round = 1;
let verify = null;
let critic = null;
const history = [];
const MAX = A.maxRounds || 3;
while (true) {
	const [v, c] = await parallel([
		() =>
			agent(verifyPrompt(round), {
				label: `verify:${A.id}:r${round}`,
				phase: 'Verify',
				schema: VERIFY_SCHEMA
			}),
		() =>
			agent(criticPrompt(round), {
				label: `critic:${A.id}:r${round}`,
				phase: 'Verify',
				schema: CRITIC_SCHEMA
			})
	]);
	verify = v;
	critic = c;
	const failing = v
		? v.criteria.filter((x) => x.status !== 'pass')
		: [{ criterion: 'verifier failed to run', status: 'fail', evidence: '' }];
	const blocking = [...(v ? v.issues : []), ...(c ? c.issues : [])].filter(
		(x) => x.severity === 'critical' || x.severity === 'major'
	);
	history.push({
		round,
		passed: !!(v && v.passed),
		failing: failing.length,
		blocking: blocking.length
	});
	log(
		`Round ${round}: ${failing.length} failing/unverified criteria, ${blocking.length} critical/major issues`
	);
	if ((v && v.passed && failing.length === 0 && blocking.length === 0) || round >= MAX) break;
	phase('Fix');
	await agent(
		`${PREAMBLE}

=== YOUR TASK: FIX ROUND ${round} ===
Independent reviewers checked milestone ${A.id}. Fix every failing criterion and every critical/major issue below (and cheap minor ones). For each, find the root cause, fix it properly (no test skipping, no faking, no weakening assertions), re-run the relevant checks to confirm, and commit.
If a reviewer claim is wrong, do not change code for it — note why in your summary.

Acceptance criteria:
${acceptanceText}

FAILING / UNVERIFIED CRITERIA:
${JSON.stringify(failing, null, 1)}

CRITICAL/MAJOR ISSUES:
${JSON.stringify(blocking, null, 1)}

MINOR ISSUES (fix if cheap):
${JSON.stringify(
	[...(v ? v.issues : []), ...(c ? c.issues : [])].filter((x) => x.severity === 'minor'),
	null,
	1
)}

Return a concise summary of what you fixed (with the commands that prove it) and anything you disagree with.`,
		{ label: `fix:${A.id}:r${round}`, phase: 'Fix' }
	);
	round++;
	phase('Verify');
}

return { id: A.id, rounds: history, implSummaries, verify, critic };
