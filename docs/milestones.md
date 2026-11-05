# Milestones

Source of scope: [`product-requirements.md`](product-requirements.md) (section numbers in
brackets). Each milestone ships as its own PR to `main` with evidence (PRD §20). "Done" means the
acceptance criteria were verified by running them — compiling is not done.

| #   | Milestone                       | Status                                                                                                               |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| M1  | Foundation & infrastructure     | **Implemented — awaiting independent review** (branch `feat/m1-foundation`)                                          |
| M2  | Auth & profile                  | **In progress** (branch `feat/m2-auth-onboarding`): passkey auth implemented; onboarding and production cutover next |
| M3  | Training data model & programs  | Planned                                                                                                              |
| M4  | Workout application             | Planned                                                                                                              |
| M5  | AI performance coach            | Planned                                                                                                              |
| M6  | Analytics & reviews             | Planned                                                                                                              |
| M7  | Advanced coaching               | Planned                                                                                                              |
| M8  | Performance & design refinement | Planned                                                                                                              |
| M9  | Final QA & production release   | Planned                                                                                                              |

---

## M1 — Foundation & infrastructure [§14–16, §19–21]

Scope: SvelteKit 3 app, Postgres/Drizzle with migrations, env validation, design system
foundations, app shell + PWA, observability, tests (unit/integration/e2e), budgets + Lighthouse,
CI/CD + backups, documentation.

Acceptance criteria:

1. `pnpm install --frozen-lockfile` succeeds from a clean clone; `pnpm check` and `pnpm lint`
   report 0 errors.
2. `pnpm test:unit` and `pnpm test:integration` pass; integration tests run against a real local
   Postgres test database with committed Drizzle migrations applied.
3. `pnpm build` (Vercel adapter) and `pnpm build:node` (Node adapter) succeed.
4. `pnpm test:e2e` passes on an iPhone-sized viewport against the production Node server: shell
   renders with bottom nav, navigation between all tabs works, `/api/health` reports `db: up` via
   a real query, no console errors, the manifest is served and the service worker registers.
5. Design-system foundations exist and are documented: dark-first tokens with light support,
   self-hosted fonts, the listed primitives; screens look premium on an iPhone viewport.
6. Budget script passes; a local Lighthouse mobile run is recorded with real numbers in
   `docs/performance.md`.
7. Observability works: `Server-Timing` on responses, `/api/vitals` stores metrics in Postgres,
   server errors are logged and recorded.
8. CI workflows exist and are valid; the backup workflow skips gracefully without secrets; deployed builds migrate first (`scripts/vercel-build.sh`).
9. Documentation set exists and is accurate.
10. Code is separated into domain / server db / services / agent / auth / client / ui / routes;
    all work committed with Conventional Commits; no secrets or build output.

Evidence: see the PR description and docs/performance.md (local runs of every command above).
Known gaps:

- WebKit e2e runs only in CI (not available locally), so iOS Safari rendering (glass, status
  bar, PWA) is unverified until the first CI run. **Merge gate for the M1 PR:** the first CI
  run's WebKit results are green. The real-device checklist in docs/testing.md moves to the M2
  production cutover, when the owner first opens the app on their iPhone to register a passkey.
- Production stays off until M2 auth is live: the committed `vercel.json` disables Vercel's Git
  deployments of `main` and skips any production build Vercel starts itself
  (docs/deployment.md). Preview deployments build from every PR, migrating the `preview` Neon
  branch first.
- Auth not yet enforced (M2): every page, `POST /api/vitals` (not rate-limited) and
  `POST /api/client-errors` (rate-limited per instance) are unauthenticated, and Profile shows
  version, environment and RUM data. Acceptable only because production is off (above).
- Performance is measured in the lab only (Lighthouse with simulated throttling and a real 4×
  CPU main-thread budget, both met on every screen; docs/performance.md). Real-device and RUM p75
  numbers start when the owner uses the deployed app; Lighthouse has not yet run on GitHub's
  runners.

## M2 — Authentication & profile [§3, §13]

- Passkey (WebAuthn) registration via one-time setup token; sign-in; recovery codes; multiple
  passkeys; session management and sign-out (ADR 0006).
- Every page and `/api/*` endpoint denies unauthenticated access (allow-list: landing, auth flow,
  `/api/health`, static assets); CSRF protections verified.
- Onboarding: event / general / multiple-goal paths; experience per discipline; optional 1RMs
  (measured vs estimated distinguished); equipment, injuries, preferences, schedule; body-weight
  and nutrition phase. Everything editable later.

Acceptance criteria:

1. Playwright: sign in through the supported auth test flow; unauthenticated requests to app
   routes redirect and to `/api/*` return 401.
2. Playwright: complete onboarding leaving every 1RM blank; profile persists across reload.
3. Integration: profile, goals (with priorities) and preferences round-trip through services.
4. Security review of auth code (no hand-rolled crypto; secrets server-side only).
5. Screens designed for empty, loading, error states on an iPhone viewport.
6. Sign-out clears everything the device holds for the account (Cache Storage entries other than
   the versioned app shell, and any IndexedDB data once it exists); `/api/vitals` and
   `/api/client-errors` require a session; then, and only then, the same PR removes the
   production guards in `vercel.json` (docs/deployment.md) and adds a post-deploy smoke check.

Progress (auth, verified locally on the branch — not yet in CI):

- Done: passkey setup via one-time token, sign-in (button and conditional UI), recovery codes
  (forcing a new passkey; regeneration), passkey add/rename/remove (never the last), session
  list/revoke/sign-out-everywhere-else, deny by default with a route-enumerating test, Origin
  check on every state-changing request, DB rate limits, audit log, sign-out device clearing,
  `/api/vitals` and `/api/client-errors` behind a session; docs/security.md with an ASVS
  self-review; ADR 0006 accepted. Evidence: unit, integration (real Postgres, real
  SimpleWebAuthn verification) and Playwright with real WebAuthn ceremonies in Chromium.
- Open in M2: onboarding & training profile; production cutover (removing the `vercel.json`
  guards, post-deploy smoke check); WebKit results from the first CI run; the real-device check.

## M3 — Training data model & program management [§2, §5, §9, §11]

- Discipline-agnostic schema: programs, versioned cycles/blocks, planned workouts, exercises
  (with movement patterns/muscles), set prescriptions, completed workouts, set records, running
  sessions (segments), other sessions with custom metrics, decisions with rationale, reviews.
- Week-1 baseline program generation rules (RPE-based when 1RMs are unknown).

Acceptance criteria:

1. Migrations committed; indexes for history queries; new programming never overwrites history
   (versioned rows + timestamps) — proven by integration tests.
2. Integration: create profile → program → planned week → retrieve; exercise history queries.
3. Concurrent disciplines represented in one week (strength + running + Muay Thai).
4. Query plans checked for the main history queries (`EXPLAIN` evidence in PR).

## M4 — Workout application [§7, §8, §9, §15, §16, §18]

- Workout screen: current exercise, targets, previous performance, rest timer, stopwatch.
- One-handed set logging (weight/reps/RPE), edit/skip/missed reps/extra sets; running and general
  session logging; plate calculator integration; substitutions (situational vs persistent).
- Offline-first: IndexedDB store, outbox with idempotent mutation ids, sync, no duplicates.

Acceptance criteria:

1. Playwright: start workout, log sets/reps/RPE, rest timer, plate calculator, substitute an
   unavailable exercise, **refresh mid-workout and restore**, complete workout, view history.
2. Persistence tests: offline logging, reconnect sync, failed-sync recovery, no duplicate sets.
3. Logging a set is optimistic (< 100 ms to visual confirmation, measured) and never depends on
   the agent.
4. INP p75 ≤ 200 ms on the workout screen in local measurements.

## M5 — AI performance coach [§4, §6, §12]

- `LlmProvider` (mock + Anthropic), tools over services, structured memory, proposals vs
  committed changes, chat UI with streaming and labelled facts/metrics/recommendations.

Acceptance criteria:

1. Deterministic agent integration tests with the mock provider for each tool group.
2. Proposals require owner confirmation; applied proposals create new program versions with
   decision rationale.
3. "I dislike X" persists; "machine unavailable" does not become a preference.
4. Pain reports never produce "push through" advice (tested).
5. No API key reaches the browser (verified in build output).

## M6 — Analytics & reviews [§10, §11]

- Strength/running/general dashboards with context; weekly review; cycle review → next cycle.

Acceptance criteria:

1. Analytics computed by tested domain functions (e1RM trends, volume per muscle, mileage, load).
2. Playwright: weekly review and "generate next week" journeys.
3. Charts accessible (text alternatives) and within budgets.

## M7 — Advanced coaching [§2, §5]

- Concurrent-training interference rules, goal priority conflicts, deloads, taper, hypertrophy
  blocks, marathon blocks; explanations of tradeoffs.

Acceptance criteria:

1. Scenario tests (mock provider + domain rules) for the PRD §5 conflict examples.
2. Multiple concurrent disciplines journey in Playwright.

## M8 — Performance & design refinement [§15–17]

- Independent performance and design councils evaluate real screens and measurements; iterate.

Acceptance criteria:

1. Council reports with scores, evidence and resolved issues (criteria held by the orchestrator).
2. Core Web Vitals "good" at p75 from RUM; budgets still green.

## M9 — Final QA & production release [§13, §19, §22]

- Security review, backup/restore drill, production deploy on coach.nikocruz.com, Performance and
  Design reports.

Acceptance criteria:

1. Full e2e suite green on Chromium + WebKit against a production-like deployment.
2. Restore drill from an encrypted backup into a Neon branch documented with timestamps.
3. Owner sign-off on the deployed app.
