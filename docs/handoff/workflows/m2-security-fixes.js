export const meta = {
	name: 'm2-security-fixes',
	description:
		'Fix every finding of the M2 security review as its own atomic, tested, stacked PR (parallel tracks; implement → adversarial verify → fix → publish)',
	phases: [
		{ title: 'Fix', detail: 'implementer per finding, in its track worktree' },
		{
			title: 'Verify',
			detail:
				'adversarial verifier: mutation-check the regression test, try to break the fix, check atomicity and gates'
		},
		{ title: 'Publish', detail: 'push the branch and open the PR' }
	]
};

const S =
	'/tmp/claude-0/-home-user-performance-coach/a0807610-c911-59e6-8a46-93bf7eec1bed/scratchpad';
const PROBES = `${S}/sec-review`;
const BASE_BRANCH = 'm2/11-profile-services';
const TRAILERS = '<the commit trailer lines your environment asks for>';
const PR_FOOTER =
	'🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n<session link>';

const TRACKS = {
	auth: { wt: `${S}/fx-auth`, db: 'fxauth', port: 4811 },
	setup: { wt: `${S}/fx-setup`, db: 'fxsetup', port: 4812 },
	profile: { wt: `${S}/fx-profile`, db: 'fxprofile', port: 4813 },
	stepup: { wt: `${S}/fx-stepup`, db: 'fxstepup', port: 4814 }
};

const env = (t) =>
	`TEST_DATABASE_URL=postgres://coach:coach@localhost:5432/coach_${t.db}_test E2E_DATABASE_URL=postgres://coach:coach@localhost:5432/coach_${t.db}_e2e E2E_PORT=${t.port}`;

const COMMON = (
	t
) => `Project: "Performance Coach", a private single-user AI training PWA (SvelteKit 3 / Svelte 5 runes, TypeScript strict, Postgres + Drizzle, passkeys via SimpleWebAuthn). It is not yet in production (production goes live after these fixes). An independent security review of the auth + profile code found the issue below; you fix it.

WORKTREE: ${t.wt} — work ONLY there. Other agents work in other worktrees at the same time: never touch /home/user/performance-coach or any other worktree, database or port. Export these in EVERY command that runs tests or servers: ${env(t)}. Local Postgres 16 (\`pg_ctlcluster 16 main start\` if it is down). Playwright 1.63.0 with Chromium AND WebKit preinstalled — never run \`playwright install\`. Only 4 CPUs are shared by several agents: run targeted test files, not whole suites, except where told.

Repo conventions: read CLAUDE.md-equivalent docs as needed — docs/security.md (threat model, auth design), docs/testing.md, docs/architecture.md. Integration tests live in tests/integration (real Postgres via TEST_DATABASE_URL; see tests/integration/global-setup.ts); unit tests next to code (*.test.ts); e2e in e2e/ (Playwright; Chromium does real WebAuthn via the CDP virtual authenticator in e2e/webauthn.ts; WebKit has none). Drizzle migrations: generate with the repo's script (see package.json db:* scripts) so drizzle/meta stays consistent; journal order is enforced by scripts/drizzle-journal.test.ts. Keep docs/security.md accurate when behaviour changes.

The reviewer's scratch probes (evidence, not part of the repo) are in ${PROBES}/ (auth-findings.test.ts, auth-races.test.ts, profile-races.test.ts, env.probe.mts). Turn the relevant probe into a PERMANENT regression test in the repo (integration or unit, whichever fits) that fails before your fix and passes after.

THE OWNER'S HARD RULE — ATOMIC DIFFS: this PR fixes exactly this one concern. No drive-by refactors, no formatting churn, no unrelated changes. Small, reviewable, green on its own.`;

const COMMIT_RULES = `Commit with a Conventional Commit message: a subject line, a blank line, then a short body explaining the problem (the failure scenario) and the fix in plain prose. End the message with exactly these two trailer lines:\n${TRAILERS}\nDo NOT mention any AI model name or id anywhere else (code, comments, commit text). Use one commit (or a few logically separate ones if that genuinely reads better). Never push in this step.`;

const GATES = (t, ui) =>
	`Before committing, run and pass (with the env exported): pnpm check; pnpm lint; pnpm test:unit; pnpm test:integration (full integration suite — it is quick); ${ui ? 'pnpm build:node && pnpm budgets; and the e2e specs your change affects, on BOTH engines: `E2E_WEBKIT=1 pnpm exec playwright test <spec files> --project=setup --project=setup-webkit --project=iphone-chromium --project=iphone-webkit --reporter=line` (add --project=exclusive when you touch e2e/*.exclusive.e2e.ts). Note the e2e global setup rebuilds and starts its own server on E2E_PORT.' : 'no UI changes expected, so e2e is not required unless you touched routes or components (then run the affected specs as above).'} Report real command output excerpts.`;

const RESULT = {
	type: 'object',
	properties: {
		branch: { type: 'string' },
		commits: { type: 'array', items: { type: 'string' }, description: 'sha + subject' },
		filesChanged: { type: 'array', items: { type: 'string' } },
		regressionTests: { type: 'array', items: { type: 'string' } },
		gates: {
			type: 'array',
			items: {
				type: 'object',
				properties: { name: { type: 'string' }, result: { type: 'string' } },
				required: ['name', 'result']
			}
		},
		summary: { type: 'string' },
		openQuestions: { type: 'string' }
	},
	required: ['branch', 'commits', 'filesChanged', 'regressionTests', 'gates', 'summary']
};
const VERDICT = {
	type: 'object',
	properties: {
		pass: { type: 'boolean' },
		mutationCheck: {
			type: 'string',
			description:
				'what you reverted, which test failed without the fix, and that it passes with it'
		},
		issues: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					severity: { type: 'string', enum: ['blocking', 'non-blocking'] },
					description: { type: 'string' },
					evidence: { type: 'string' },
					suggestedFix: { type: 'string' }
				},
				required: ['severity', 'description', 'evidence']
			}
		},
		atomic: { type: 'boolean' },
		gatesRerun: { type: 'string' }
	},
	required: ['pass', 'mutationCheck', 'issues', 'atomic', 'gatesRerun']
};
const PUBLISHED = {
	type: 'object',
	properties: {
		branch: { type: 'string' },
		prNumber: { type: 'number' },
		prUrl: { type: 'string' },
		base: { type: 'string' },
		headSha: { type: 'string' }
	},
	required: ['branch', 'prNumber', 'prUrl', 'base', 'headSha']
};

// Findings, grouped into tracks. Within a track each PR is stacked on the previous one.
const F = {
	recoveryCap: {
		track: 'auth',
		branch: 'fix/m2-recovery-global-cap',
		ui: false,
		title: 'a valid recovery code always works; the global cap counts only failures',
		text: `MAJOR. One anonymous client can block ALL recovery-code sign-ins indefinitely. src/lib/server/auth/recovery.ts:25-26, policy.ts:47: redeemRecoveryCode checks the per-IP bucket (5/15 min) and then the global bucket recovery.global (20/hour) BEFORE looking at the code. One IP staying at its own limit adds 20 hits/hour to the global bucket and fills it alone; every redemption is then 429 — including the real owner's valid code from any network. Probe F1 in auth-findings.test.ts: 20 wrong codes from 203.0.113.66 over four windows, then the owner's valid code from 198.51.100.200 → rate_limited 429, codes stay unused. FIX: look the code up first and charge the global cap only to FAILED attempts, so a valid code always works (keep per-IP limiting of failures, and keep concurrency-safe single use). Update docs/security.md (rate limits section) accordingly.`
	},
	upgradeRevoked: {
		track: 'auth',
		branch: 'fix/m2-recovery-upgrade-revoked',
		ui: false,
		title: 'a recovery session revoked mid-request cannot upgrade',
		text: `src/lib/server/auth/passkeys.ts:210: \`await repo.revokeSession(session.id, 'recovered', now());\` ignores the boolean result, so upgradedSession is issued from the AuthSession validated at the start of the request. If "Sign out everywhere else" lands while the attacker's /api/auth/passkeys/verify is in flight, the revoked recovery session still becomes a 90-day owner session with a new passkey. Probe F3 (auth-findings.test.ts). FIX: inside the transaction, lock the session row (FOR UPDATE), re-check it is live (not revoked, not expired); if revokeSession returns false or the row is not live, throw AuthError('not_found' or 'unauthorized'-equivalent per errors.ts) BEFORE inserting the passkey.`
	},
	signout: {
		track: 'auth',
		branch: 'fix/m2-signout-always-revokes',
		ui: false,
		title: 'sign-out always ends the presented session',
		text: `src/lib/server/auth/sessions.ts:222-223: the signout rate limit runs before revokeToken. Someone on the same NAT/Wi-Fi exhausts the signout bucket (30/min per IP); the owner's sign-out then returns 429, the session is NOT revoked and the cookie is not cleared. Probe F6. FIX: revoke the presented live session and clear the cookie first; apply the rate limit only when no live session was presented (sign-out with a valid session must always work). Check the route/endpoint that calls it clears the cookie on success.`
	},
	setupStatus: {
		track: 'auth',
		branch: 'fix/m2-setup-rate-limit-status',
		ui: true,
		title: 'a rate-limited /setup answers 404 instead of a 500',
		text: `src/lib/server/auth/setup.ts:64 (checkSetupAccess throws AuthError('rate_limited')) is called from src/routes/setup/+page.server.ts:11 without try/catch, so after the setup bucket is exhausted /setup?token=… returns 500 and writes app_errors rows with stacks (live: 12 requests → 404×8 then 500×4). FIX: in the load, catch rate_limited and answer error(404) (same as a bad token / closed setup — reveal nothing), never 500, and do not record it as an app error. Add a test (integration or e2e) proving the status and that no app_errors row is written.`
	},
	ipv6: {
		track: 'auth',
		branch: 'fix/m2-rate-limit-ipv6-prune',
		ui: false,
		title: 'rate limits key IPv6 clients by /64 and stale counters are pruned',
		text: `src/lib/server/auth/rate-limit.ts:17 keys buckets by the full client address, so an IPv6 client rotates through its /64 for fresh buckets; and pruneRateLimits is only called after a successful passkey sign-in (passkeys.ts:122), so each new address adds an auth_rate_limits row that stays indefinitely (and an auth_events row per failure). FIX: normalise IPv6 addresses to their /64 prefix (handle IPv4-mapped IPv6 as IPv4; unit-test the normaliser), and prune stale counters opportunistically on writes (cheap, bounded — e.g. occasionally or when a window rolls) instead of only after sign-in. Keep it simple and documented in docs/security.md.`
	},
	recoveryVisible: {
		track: 'auth',
		branch: 'fix/m2-recovery-sessions-visible',
		ui: true,
		title: 'recovery sessions are listed and revocable; security events stay visible',
		text: `src/lib/server/auth/sessions.ts:152 listSessions drops every recovery session except the current one (.filter(row => row.kind === 'owner' || row.id === session.id)), so the owner cannot see or revoke an attacker's live recovery session. And src/lib/server/auth/activity.ts:42: Recent activity is the latest 8 auth_events of any type; anyone can create signin.failed rows (10/min/IP), pushing "Recovery code used" / "Passkey added" out of the feed. Probe F5. FIX: list recovery sessions too, clearly marked (e.g. "Recovery sign-in"), revocable like others (and covered by sign-out-everywhere-else); make the activity feed keep security-significant events (recovery used, passkey added/removed, codes regenerated, setup, sessions revoked) visible — e.g. collapse repeated failed sign-ins into one summarised row and/or always include the latest significant events. Update the Security screen (src/routes/(app)/profile/security) accordingly with premium, calm copy and design-system components; keep axe clean in both themes; update the affected e2e (auth.e2e.ts sessions tests, a11y).`
	},

	setupToken: {
		track: 'setup',
		branch: 'fix/m2-setup-token-single-use',
		ui: false,
		title: 'a setup token works once, even after an owner reset',
		text: `src/lib/server/auth/setup.ts:34-51 and :90; scripts/auth-setup-token.ts:45; docs/security.md:191; docs/deployment.md:95. setupOpen() depends only on the DB (setup_completed_at IS NULL and no passkeys) and setupTokenValid() only on the env hash. auth:reset-owner sets setup_completed_at = null, so while the old OWNER_SETUP_TOKEN_HASH is still configured, the OLD link works again → anyone holding it (it sits in Vercel request logs) completes setup attached to the existing owner row: all training data, a full session, new recovery codes. The script even prints that removing the hash is optional. Probe F2. FIX: when setup completes, persist the hash of the token used (migration: e.g. a column on owners or a used-setup-tokens table) and refuse any token whose hash was already used; reset-owner must therefore require a NEW token. Correct the script output and both docs. Add the regression test (setup → reset → old token refused; new token works).`
	},
	testRoutes: {
		track: 'setup',
		branch: 'fix/m2-test-routes-build-flag',
		ui: false,
		title: 'test-only routes can never be enabled in a Vercel build',
		text: `Informational finding: the test-route lockout (ENABLE_TEST_ROUTES) relies only on Vercel putting VERCEL/VERCEL_ENV in the runtime environment; env.probe.mts shows "no VERCEL vars, NODE_ENV=production, APP_ENV=test, ENABLE_TEST_ROUTES=true" is accepted (testRoutes=true). FIX (defence in depth): bake a build-time fact — when the app is built with the Vercel adapter (vite.config.ts target 'vercel'), test routes can never be enabled regardless of runtime env (e.g. a define/virtual constant checked by testRoutesEnabled(), or exclude src/routes/api/test-support from the Vercel build if that is cleaner). Unit-test it. Keep local/CI node builds working (e2e uses ADAPTER=node with ENABLE_TEST_ROUTES).`
	},
	previewDocs: {
		track: 'setup',
		branch: 'docs/m2-preview-branch-without-production-data',
		ui: false,
		title: 'never copy production data into the shared preview database',
		text: `Informational finding: docs/deployment.md:46 recommends "Reset from parent" for the shared preview Neon branch. Once production holds the owner's data, that copies personal data and auth rows into the database every PR preview uses. FIX (docs only): document resetting the preview branch as a schema-only branch (Neon supports schema-only branches) or recreating it empty and migrating, never copying production data; explain why. Docs-only PR; run pnpm lint.`
	},
	timezone: {
		track: 'setup',
		branch: 'fix/m2-body-weight-local-day',
		ui: false,
		title: "body weight is dated by the owner's local day",
		text: `src/lib/server/services/profile/shared.ts:84 (isoDay = toISOString().slice(0,10)) and profile.ts:127: a weigh-in at 18:30 in Los Angeles is stored as tomorrow, and "re-saving the same day replaces it" splits at UTC midnight. Probe F11. FIX: store the owner's IANA time zone on the athlete profile (migration; default 'UTC'; validated against Intl supported time zones in the shared zod schema) and derive the local day from it in the services (a small, unit-tested helper: localDay(instant, timeZone)). Do NOT build UI for it here (onboarding will capture it from the browser later) — but expose it in the profile service input/output and schema so it can be set. Regression test: the probe's instant stored with measuredOn 2026-11-05 for America/Los_Angeles.`
	},

	ids: {
		track: 'profile',
		branch: 'fix/m2-malformed-ids-not-found',
		ui: false,
		title: 'malformed ids are "not found", never a 500',
		text: `src/routes/(app)/profile/security/+page.server.ts:80 → revokeSession → auth repository :214 (eq(authSessions.id, id) on a uuid column) throws Postgres 22P02 "invalid input syntax for type uuid", which is not an AuthError so it becomes a 500 in app_errors (probe F4). Likewise src/lib/server/services/profile/goals.ts updateGoal / deleteGoal / setGoalStatus with 'abc' throw the raw 22P02 instead of ProfileNotFoundError (probe F4b) — matters once routes and the coach's tools (M5) pass ids. FIX: validate ids as UUIDs at the service boundary (a shared helper, e.g. z.uuid()) for auth (session/passkey ids) and profile (goal ids and any other id inputs), mapping malformed ids to the existing not-found errors. Regression tests for both.`
	},
	goalStatus: {
		track: 'profile',
		branch: 'fix/m2-goal-status-no-lost-update',
		ui: false,
		title: "changing a goal's status cannot undo a concurrent edit",
		text: `src/lib/server/services/profile/goals.ts:191-193: setGoalStatus reads the goal outside the advisory lock and its own transaction, then calls updateGoal(ownerId, id, { ...toGoal(existing), status }), writing every column back — a concurrent rename (coach in M5, or a second tab) is reverted. Probe F7 (profile-races.test.ts, deterministic). FIX: do the status change in one transaction after lockGoals, re-reading the row there and updating only status, priority and closedAt (keeping ranking invariants 1..n).`
	},
	sectionLock: {
		track: 'profile',
		branch: 'fix/m2-section-saves-serialize',
		ui: false,
		title: 'concurrent saves of a profile section are serialised',
		text: `src/lib/server/services/profile/sections.ts:126-176 (saveBaselines) and src/lib/server/db/repositories/profile.ts:402-426 (replaceExercisePreferences) read current rows then insert, with no per-owner lock; two concurrent saves (a double-tapped Save) both insert and the second hits a unique index (strength_baselines_current_uq / exercise_preferences_owner_exercise_uq) and surfaces as a raw 500 (probe F8: 9 failures in 10 rounds). FIX: take a per-owner, per-section advisory lock (same pattern as lockGoals) at the start of every section save that replaces sets of rows (audit all section saves, not just these two), or upsert with ON CONFLICT where that is cleaner. Regression test: parallel saves all succeed and the final state equals one of the inputs.`
	},
	onboardingValidation: {
		track: 'profile',
		branch: 'fix/m2-onboarding-progress-validation',
		ui: false,
		title: 'onboarding progress accepts only known steps and never skips a required one',
		text: `src/lib/server/services/profile/profile.ts:195-209 and :227: advanceOnboarding validates the step but not the action (anything other than 'complete' is a skip) and never checks STEP_INFO[step].optional; rememberOnboardingStep stores any string. Probe F10 produced {"current":"not-a-step","skipped":["goals","schedule"],…}. These services will be called by the LLM coach too. FIX: validate the action against {complete, skip}, refuse skipping non-optional steps (ProfileInputError), and check isOnboardingStep in rememberOnboardingStep. Regression tests.`
	},

	stepUp: {
		track: 'stepup',
		branch: 'feat/m2-step-up-reauthentication',
		ui: true,
		title: 'step-up re-authentication before changing passkeys, recovery codes or other sessions',
		text: `MINOR but high impact: with only a copied session cookie an attacker can (1) add their own passkey, (2) remove every owner passkey, (3) "Sign out everywhere else", (4) regenerate recovery codes → the owner is permanently locked out (probe F9). docs/security.md lists step-up as an open item. FIX (OWASP ASVS L2 re-authentication for sensitive operations): require a fresh WebAuthn assertion with one of the owner's EXISTING passkeys (user verification required) within the last 5 minutes before: adding a passkey, removing a passkey, renaming? (decide and justify), regenerating recovery codes, revoking a session, and signing out everywhere else. Record it per session (migration: e.g. auth_sessions.reauthenticated_at; a passkey sign-in or setup that just happened counts as fresh). The recovery flow is the exception: a recovery session (no usable passkey) may register exactly its new passkey as today. Server-side enforcement is the security boundary (services/endpoints refuse with a clear AuthError like 'reauth_required'); the Security screen UI runs the assertion transparently when needed (lazy-loaded WebAuthn code, keeping @simplewebauthn/browser out of initial JS — budgets must stay green) and retries the action, with designed copy for cancel/failure. Rate-limit the re-auth ceremony (reuse signin buckets or add one in policy.ts). Update docs/security.md (remove the open item, describe the policy) and the e2e specs (Chromium virtual authenticator answers assertions automatically; add a test that a stale session cannot remove a passkey without re-auth, and that re-auth succeeds; WebKit specs must keep passing — WebKit has no virtual authenticator, so its Security-screen tests may need to assert the re-auth prompt state rather than complete it). Keep the diff focused; this is the largest PR of the set.`
	}
};

const ORDER = {
	auth: ['recoveryCap', 'upgradeRevoked', 'signout', 'setupStatus', 'ipv6', 'recoveryVisible'],
	setup: ['setupToken', 'testRoutes', 'previewDocs', 'timezone'],
	profile: ['ids', 'goalStatus', 'sectionLock', 'onboardingValidation']
};

async function doFinding(key, trackName, wt, baseRef, baseBranchForPr) {
	const f = F[key];
	const t = { ...TRACKS[trackName], wt };
	const label = key;
	const impl = await agent(
		`${COMMON(t)}

YOUR FINDING (${key}):
${f.text}

STEPS:
1. In ${wt}: \`git checkout -B ${f.branch} ${baseRef}\` (this branch is stacked on ${baseRef}).
2. Reproduce first: write the regression test and see it FAIL on the current code (report the failure output).
3. Implement the fix — minimal, clean, idiomatic for this codebase, with a short comment where the reason is not obvious.
4. ${GATES(t, f.ui)}
5. ${COMMIT_RULES} Suggested subject: "${f.branch.startsWith('docs/') ? 'docs' : f.branch.startsWith('feat/') ? 'feat(auth)' : f.track === 'profile' || key === 'timezone' ? 'fix(profile)' : 'fix(auth)'}: ${f.title}".
Leave the worktree clean (git status empty) on branch ${f.branch}.`,
		{ label: `fix:${label}`, phase: 'Fix', schema: RESULT }
	);
	if (!impl) return { key, error: 'implementer failed' };

	let verdict = null;
	for (let round = 1; round <= 3; round++) {
		verdict = await agent(
			`${COMMON(t)}

You are an ADVERSARIAL VERIFIER for this fix (do not trust the implementer's report; check everything yourself). Finding:
${f.text}

The implementer committed on branch ${f.branch} in ${wt} (stacked on ${baseRef}). Their report: ${JSON.stringify(impl)}

Do ALL of:
1. Review \`git diff ${baseRef}..${f.branch}\` line by line: is the fix complete for the scenario AND its variants (think like an attacker: other entry points, races, error paths, other callers)? Any regression? Is it ATOMIC (only this concern; no unrelated edits or churn)? Are docs updated where behaviour changed?
2. MUTATION CHECK: temporarily revert only the non-test source changes (e.g. \`git stash\`/checkout of those files from ${baseRef}), run the new regression test(s) and confirm they FAIL; restore the fix and confirm they PASS. Leave the tree exactly as committed afterwards (git status empty, on ${f.branch}).
3. Re-run the gates yourself: ${GATES(t, f.ui)}
4. If you find blocking problems, do NOT fix them — report them precisely (file:line, evidence, suggested fix).
pass=true only if there are no blocking issues, the mutation check proves the test, the diff is atomic and all gates pass.`,
			{ label: `verify:${label}#${round}`, phase: 'Verify', schema: VERDICT }
		);
		if (!verdict || verdict.pass) break;
		const blocking = (verdict.issues || []).filter((i) => i.severity === 'blocking');
		if (!blocking.length && verdict.atomic) break;
		await agent(
			`${COMMON(t)}

Finding:
${f.text}

An adversarial verifier reviewed your fix on branch ${f.branch} in ${wt} and found problems:
${JSON.stringify(verdict)}

Fix every blocking issue (and atomicity problems) on the same branch. Fold the corrections into the existing commit(s) (e.g. commit --fixup then \`git rebase -i --autosquash\` is NOT available non-interactively — use \`git commit --amend\` when there is a single commit, or \`GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash ${baseRef}\` for fixups) so history stays atomic; the branch is not pushed yet. ${GATES(t, f.ui)} Keep the commit message rules: ${COMMIT_RULES} Leave the tree clean.`,
			{ label: `refix:${label}#${round}`, phase: 'Fix', schema: RESULT }
		);
	}

	const published = await agent(
		`You publish a finished, verified fix. Repository: TheCruzControll/performance-coach (GitHub). Worktree: ${wt}, branch ${f.branch} (stacked on ${baseBranchForPr}).
1. \`cd ${wt} && git status\` must be clean and on ${f.branch}; then \`git push -u origin ${f.branch}\` (retry up to 4 times with 2s/4s/8s/16s backoff on network errors only).
2. Load the GitHub MCP tools with ToolSearch (query "select:mcp__github__create_pull_request") and create a NON-draft pull request: base "${baseBranchForPr}", head "${f.branch}", title = the commit subject (Conventional Commit). Body in this layout (plain, concrete, no hype; never mention AI model names):
## What
One or two sentences: the problem as a concrete failure scenario (from the security review of the M2 stack) and what this PR changes.
## How
Short bullets of the change.
## Tests
The regression test(s) added, that they fail without the fix and pass with it, and which gates were run locally.
Then end the body with exactly:
${PR_FOOTER}
Facts for the body: finding = ${JSON.stringify(f.text)}; implementer report = ${JSON.stringify(impl)}; verifier = ${JSON.stringify(verdict)}.
3. Return the PR number, URL, base and head sha.`,
		{ label: `publish:${label}`, phase: 'Publish', schema: PUBLISHED }
	);
	return { key, branch: f.branch, impl, verdict, published };
}

async function runTrack(trackName, keys, wt, startRef, startBranch) {
	const out = [];
	let baseRef = startRef;
	let baseBranch = startBranch;
	for (const key of keys) {
		const r = await doFinding(key, trackName, wt, baseRef, baseBranch);
		out.push(r);
		if (!r || r.error || !r.published) {
			log(
				`track ${trackName}: stopping after ${key} (${r && r.error ? r.error : 'not published'})`
			);
			break;
		}
		baseRef = F[key].branch;
		baseBranch = F[key].branch;
	}
	return out;
}

phase('Fix');
const [auth, setupAndStepup, profile] = await parallel([
	() => runTrack('auth', ORDER.auth, TRACKS.auth.wt, `origin/${BASE_BRANCH}`, BASE_BRANCH),
	async () => {
		const setup = await runTrack(
			'setup',
			ORDER.setup,
			TRACKS.setup.wt,
			`origin/${BASE_BRANCH}`,
			BASE_BRANCH
		);
		const last = setup.filter((r) => r && r.published).pop();
		if (!last) return { setup, stepup: [] };
		// Step-up adds a migration: stack it after the setup track so migration numbers stay in order.
		const stepup = await runTrack(
			'stepup',
			['stepUp'],
			TRACKS.stepup.wt,
			`origin/${last.branch}`,
			last.branch
		);
		return { setup, stepup };
	},
	() => runTrack('profile', ORDER.profile, TRACKS.profile.wt, `origin/${BASE_BRANCH}`, BASE_BRANCH)
]);
return {
	auth,
	setup: setupAndStepup && setupAndStepup.setup,
	stepup: setupAndStepup && setupAndStepup.stepup,
	profile
};
