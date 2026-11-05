export const meta = {
	name: 'm2-stack-review',
	description:
		'Independent verification + adversarial security/correctness review of the M2 auth and profile PR stack',
	phases: [
		{ title: 'Review', detail: 'verifier (full gate) and security-focused critic in parallel' }
	]
};

const WT =
	'/tmp/claude-0/-home-user-performance-coach/a0807610-c911-59e6-8a46-93bf7eec1bed/scratchpad/review-wt';
const SCRATCH =
	'/tmp/claude-0/-home-user-performance-coach/a0807610-c911-59e6-8a46-93bf7eec1bed/scratchpad/m2-review';
const COMMON = `You are reviewing "Performance Coach", a private single-user AI training PWA (SvelteKit, Postgres/Drizzle, passkeys via SimpleWebAuthn), going to production at coach.nikocruz.com. Work ONLY in the git worktree ${WT} (detached at the tip of the stacked branches m2/01…m2/11). Do NOT modify tracked files, commit, push or switch branches; scratch files go in ${SCRATCH}/ (create it). Another agent is developing in /home/user/performance-coach at the same time: never touch that directory, its databases (coach_test, coach_e2e) or port 4173. Use ONLY these isolated settings for anything you run: TEST_DATABASE_URL=postgres://coach:coach@localhost:5432/coach_rv_test E2E_DATABASE_URL=postgres://coach:coach@localhost:5432/coach_rv_e2e E2E_PORT=4273 (the databases exist; local Postgres 16 — start with \`pg_ctlcluster 16 main start\` if down). Playwright 1.63.0 Chromium is preinstalled (never run \`playwright install\`; WebKit is unavailable locally). CPU is shared with the other agent, so performance-guard timings may be noisy — report them but treat CI as authoritative for perf. Read docs/product-requirements.md §3 and §13, docs/security.md and ADR 0006 first. Report only what you observed.`;

const ISSUES = {
	type: 'object',
	properties: {
		issues: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
					file: { type: 'string' },
					line: { type: 'number' },
					description: { type: 'string' },
					failureScenario: { type: 'string' },
					evidence: { type: 'string' },
					suggestedFix: { type: 'string' }
				},
				required: ['severity', 'file', 'description', 'failureScenario', 'evidence', 'suggestedFix']
			}
		},
		summary: { type: 'string' }
	},
	required: ['issues', 'summary']
};
const VERIFY = {
	type: 'object',
	properties: {
		checks: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					status: { type: 'string', enum: ['pass', 'fail', 'not_verified'] },
					evidence: { type: 'string' }
				},
				required: ['name', 'status', 'evidence']
			}
		},
		problems: { type: 'array', items: { type: 'string' } }
	},
	required: ['checks', 'problems']
};

phase('Review');
const [critic, verifier] = await parallel([
	() =>
		agent(
			`${COMMON}

You are an adversarial security and correctness reviewer. Review \`git diff origin/main..HEAD\` in the worktree (passkey auth: setup token, WebAuthn ceremonies, recovery codes, sessions, rate limits, deny-by-default hooks, CSRF/origin checks, return paths, cookies, sign-out clearing, test-only routes, owner-reset script; plus the training-profile domain/db/services). Think like an attacker against the production deployment and like a QA engineer:
- Can anything be reached without a session (enumerate src/routes and hooks logic; form actions; +server endpoints; __data.json; prerendered pages)? Open redirect via return paths? CSRF on any state-changing path (including GET with side effects)?
- Setup-token flow: replay after first passkey, timing, enumeration, missing token hash in production (fail closed?), race of two concurrent setups.
- WebAuthn: challenge binding/expiry/single use, expected origin/RP ID per environment (production must be exactly https://coach.nikocruz.com / coach.nikocruz.com; previews isolated), counter handling, user verification requirement, credential ownership on removal.
- Sessions: token entropy, hashing, rotation on sign-in/recovery, sliding/absolute expiry, revocation, cookie flags in production (__Host-, Secure, HttpOnly, SameSite), behaviour behind Vercel's proxy (x-forwarded-proto/host trust, ORIGIN), session fixation.
- Recovery codes: single use under concurrency, restricted recovery session scope, regeneration invalidates old codes.
- Rate limits: bypass via IP spoofing headers on Vercel, DB contention, lockout of the owner.
- Test-only routes: provably impossible in production/preview (env validation), and not shipped as callable endpoints when disabled.
- Secrets/logging: no tokens, codes or credential material in logs, app_errors or audit rows; error messages don't leak.
- Profile services: validation completeness, authorization (single owner), transactions, priority reordering races.
You may run targeted tests and small scripts in the worktree with the isolated settings, but NOT the full Playwright suite (the verifier runs it). Only report issues you can substantiate; critical/major only for real exploitable or correctness-breaking problems.`,
			{ label: 'critic:security', phase: 'Review', schema: ISSUES }
		),
	() =>
		agent(
			`${COMMON}

You are the verifier. In the worktree, with the isolated settings exported in every command, run and report with real output excerpts: pnpm check; pnpm lint; pnpm test:unit; pnpm test:integration; pnpm build; pnpm build:node; pnpm budgets; pnpm test:e2e (full, default config). Then exercise the real app as a user in Chromium at an iPhone viewport against your own production Node server on port 4273 (the e2e global setup shows how to start it; use a CDP virtual authenticator): first-run setup via /setup?token=… (generate a token/hash with pnpm auth:setup-token and pass OWNER_SETUP_TOKEN_HASH to the server), recovery codes shown once, sign-in, add/rename/remove passkey, sessions list/revoke, sign out (check cookies, Cache Storage and IndexedDB cleared), signed-out access to /today (redirect) and /api/vitals (401). Take screenshots of each screen into ${SCRATCH}/screens/ and look at them; judge whether they look premium and intentional on an iPhone. Also verify each stacked branch boundary is coherent: for each of m2/01-auth-schema … m2/11-profile-services, run \`git worktree\`-free checks by \`git stash\`-less means — simply run \`git diff --stat origin/main <branch>\` and confirm the branches form a linear stack (each is an ancestor of the next) — do not check them out. Do not fix anything.`,
			{ label: 'verifier', phase: 'Review', schema: VERIFY }
		)
]);
return { critic, verifier };
