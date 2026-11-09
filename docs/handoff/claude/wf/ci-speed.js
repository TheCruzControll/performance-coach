export const meta = {
	name: 'ci-speed',
	description: 'Measure where CI wall time goes, design small PRs that cut it without weakening what CI proves, adversarially check each proposal',
	phases: [
		{ title: 'Measure', detail: 'four analysts, each a different angle on real run data' },
		{ title: 'Design', detail: 'a ranked plan of small atomic CI PRs with expected savings' },
		{ title: 'Challenge', detail: 'two skeptics per proposal try to refute its saving or its safety' }
	]
};

const REPO = '/Users/nikocruz/dev/performance-coach';
const RP = 'TheCruzControll/performance-coach';
const CTX = `Repo ${REPO} (GitHub ${RP}, PUBLIC repo on the free plan: free Actions minutes, standard runners ubuntu-latest = 4 vCPU / 16 GB, at most 20 concurrent jobs across the account). CI is .github/workflows/ci.yml (read it in full, and playwright.config.ts, package.json scripts, scripts/ used by CI, docs/testing.md). Read-only: change no file, push nothing, rerun nothing. Use gh (authenticated) for data: \`gh run list -R ${RP} --workflow CI --limit 40 --json databaseId,event,headBranch,createdAt,updatedAt,conclusion\`, \`gh run view <id> -R ${RP} --json createdAt,jobs\` (jobs carry startedAt/completedAt and steps with their own timings), \`gh api repos/${RP}/actions/runs/<id>/jobs?per_page=50\`, job logs with \`gh run view <id> --job <job id> --log -R ${RP} | grep ...\` (never dump whole logs), artifacts (Playwright reports/JSON) via \`gh run download\` into /tmp/pc-scratch/ci-speed/ (delete when done).
Known so far: a main run took ~26 min wall clock: every job started ~10 min after the run was created (queued for runners), then jobs ran ~16 min; the longest legs are E2E serial · webkit (11-13 min), E2E main (7-10 min), Lighthouse (~8 min), unit+integration (4-6 min). Six PRs plus main pushes can be running at once (each run ~16 jobs; every merge to main runs full CI by the owner's design).
Constraints any proposal must keep: CI proves the same things (no test skipped, weakened, quarantined; both engines Chromium + Linux WebKit for the iPhone projects; desktop Chromium; every required check name stays or the branch protection's 5 required checks are updated in the same change: "Lint & type-check", "Unit & integration tests", "Build (Vercel + Node) & budgets", "E2E (iPhone viewport · Chromium + WebKit)", "Lighthouse (mobile)"; budgets not loosened; every merge to main still tested). Paid/larger runners are out unless flagged as "owner decision: costs money".`;

const FINDINGS = {
	type: 'object',
	properties: {
		measurements: { type: 'string', description: 'the numbers you measured, with run ids' },
		bottlenecks: {
			type: 'array',
			items: {
				type: 'object',
				properties: { what: { type: 'string' }, evidence: { type: 'string' }, minutesAtStake: { type: 'number' } },
				required: ['what', 'evidence', 'minutesAtStake']
			}
		},
		ideas: { type: 'array', items: { type: 'string' } }
	},
	required: ['measurements', 'bottlenecks', 'ideas']
};

const ANGLES = [
	{ key: 'queue', p: 'Queueing and concurrency: across the last ~40 CI runs (PR and main), measure the gap between run creation and each job start, how many runs and jobs overlapped in time, and how much of each run\'s wall clock is queueing vs execution. Model what fewer jobs per run, fewer concurrent runs (e.g. cancel superseded runs, path filters for docs-only PRs, a merge-queue style), or a different leg layout would do to queueing under the 20-job cap.' },
	{ key: 'setup', p: 'Per-job setup overhead: from step timings of recent successful runs, for EVERY job tally the time in checkout, pnpm/node setup and install, Playwright browser install or cache restore, apt installs, Postgres service start, db setup/migrate, and the app build, versus time actually running tests/audits. Find duplicated work across legs (e.g. each E2E leg building the app) and caching gaps (pnpm store, Playwright browsers, vite/svelte-kit outputs, apt).' },
	{ key: 'tests', p: 'Test-level hotspots and sharding: download the Playwright JSON/HTML report or blob artifacts (or parse leg logs) for a recent green main run; find the slowest spec files and tests per project, how the main/serial/alone/sweeps groups are split and why (read playwright.config.ts and any sharding script), the balance between shards, workers per leg (fullyParallel? workers?), retries, and fixed waits/timeouts. Estimate what rebalancing, more workers on a 4-vCPU runner, or moving tests between serial and parallel groups would save, without changing what they prove.' },
	{ key: 'other', p: 'Everything outside E2E: Lighthouse (how many URLs and runs, serial or parallel, build reuse), unit+integration (vitest projects, pool, sharding, integration DB setup), lint+type-check (svelte-check time, eslint cache), the build+budgets job, and the post-merge/main-only work. Also look at what a docs-only or test-only PR runs and whether any job could be skipped safely by path filters while still producing the required check (e.g. a no-op success).' }
];

phase('Measure');
const found = await parallel(
	ANGLES.map((a) => () => agent(`${CTX}\n\nYOUR ANGLE (${a.key}): ${a.p}\nReturn measurements (numbers with run ids), bottlenecks (what, evidence, minutes at stake per typical PR run), and ideas.`, { label: `measure:${a.key}`, phase: 'Measure', schema: FINDINGS, effort: 'high' }))
);
const ok = found.filter(Boolean);
log(`measured from ${ok.length} angles`);

phase('Design');
const PLAN = {
	type: 'object',
	properties: {
		baseline: { type: 'string' },
		proposals: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					id: { type: 'string' },
					title: { type: 'string', description: 'Conventional Commit PR title' },
					change: { type: 'string', description: 'exactly what changes, which files' },
					expectedSavingMin: { type: 'number', description: 'minutes off a typical PR run wall clock' },
					evidence: { type: 'string' },
					keepsProof: { type: 'string', description: 'why CI still proves the same things' },
					risk: { type: 'string' },
					dependsOn: { type: 'array', items: { type: 'string' } },
					ownerDecision: { type: 'string', description: 'only if it costs money or changes branch protection' }
				},
				required: ['id', 'title', 'change', 'expectedSavingMin', 'evidence', 'keepsProof', 'risk']
			}
		},
		projectedWallClock: { type: 'string' }
	},
	required: ['baseline', 'proposals', 'projectedWallClock']
};
const plan = await agent(
	`${CTX}\n\nFour analysts measured CI:\n${JSON.stringify(ok, null, 1)}\n\nDesign the plan: a ranked list of small atomic PRs (one concern each, each green on its own) that together bring a typical PR's CI wall clock as low as possible (goal: under 10 minutes) while keeping every constraint. Verify each claim you rely on against ci.yml and the configs yourself. Give each proposal its expected saving with the arithmetic, why CI still proves the same things, risks, and dependencies between proposals. Include the projected wall clock after all of them.`,
	{ label: 'design', phase: 'Design', schema: PLAN, effort: 'xhigh' }
);
if (!plan) return { error: 'design failed', found: ok };

phase('Challenge');
const VERDICT = {
	type: 'object',
	properties: { refuted: { type: 'boolean' }, savingRealistic: { type: 'number' }, safetyProblem: { type: 'string' }, reason: { type: 'string' } },
	required: ['refuted', 'savingRealistic', 'reason']
};
const judged = await parallel(
	plan.proposals.map((p) => () =>
		parallel(
			['saving', 'safety'].map((lens) => () =>
				agent(
					`${CTX}\n\nA CI-speed proposal:\n${JSON.stringify(p, null, 1)}\n\nTry to REFUTE it through the ${lens === 'saving' ? 'SAVING lens: is the expected saving real? Check the measurements yourself against run data and ci.yml; does it just move time elsewhere or worsen queueing?' : 'SAFETY lens: would CI after this change prove less (a test skipped, an engine dropped, a required check gone or green without running, a budget loosened, a merge to main untested), or become flaky?'} Default to refuted=true if the evidence is weak. Return refuted, savingRealistic (minutes), safetyProblem (if any), reason.`,
					{ label: `${lens}:${p.id}`, phase: 'Challenge', schema: VERDICT, effort: 'high' }
				)
			)
		).then((vs) => ({ ...p, verdicts: vs.filter(Boolean) }))
	)
);
const survivors = judged.filter((p) => p.verdicts.length === 2 && p.verdicts.every((v) => !v.refuted));
const disputed = judged.filter((p) => !survivors.includes(p));
return { baseline: plan.baseline, projectedWallClock: plan.projectedWallClock, survivors, disputed, measurements: ok.map((f) => f.measurements) };
