# Milestones

Source of scope: [`product-requirements.md`](product-requirements.md) (section numbers in
brackets). Each milestone ships as its own PR to `main` with evidence (PRD §20). "Done" means the
acceptance criteria were verified by running them — compiling is not done.

| #   | Milestone                       | Status                                                                                                                                     |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| M1  | Foundation & infrastructure     | **Done** (PR #1, merged 2026-11-05); deferred items carried below                                                                          |
| M2  | Auth & profile                  | **Done**: auth, production (#50), onboarding, Profile, Today (#60–#181), desktop (#85–#265); email link dropped by the owner on 2026-11-07 |
| M3  | Training data model & programs  | **Done**: 49 slice PRs, #41 to #233; evidence per criterion below                                                                          |
| M4  | Workout application             | **In progress**: the workout app merged, #87 to #410; the owner's screenshot review pending                                                |
| M5  | AI performance coach            | **In progress**: every slice built, #101 to #463; the launch (#449) waits on the owner's screenshot review                                 |
| M6  | Analytics & reviews             | Planned                                                                                                                                    |
| M7  | Advanced coaching               | Planned                                                                                                                                    |
| M8  | Performance & design refinement | Planned                                                                                                                                    |
| M9  | Final QA & production release   | Planned                                                                                                                                    |

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

Evidence: PR #1 (its CI run, Chromium + WebKit e2e and Lighthouse included, was green) and
docs/performance.md (local runs of every command above).
Deferred from M1 (carried forward):

- The real-device checklist in docs/testing.md moves to the M2 production cutover, when the owner
  first opens the app on their iPhone to register a passkey. WebKit e2e runs in CI on every PR
  (locally with `E2E_WEBKIT=1`), but neither browser paints `backdrop-filter` in CI's headless
  iPhone projects (text behind the nav stays crisp in their screenshots), so glass is judged
  only on a device.
- Production stayed off until M2's production cutover, which removed the committed
  `vercel.json` guards (Git deployments of `main` disabled, Vercel-started production builds
  skipped); since then every merge to `main` deploys production (docs/deployment.md). Previews
  are deployed on demand, not from every PR, migrating the `preview` Neon branch first.
- Performance is measured in the lab only (Lighthouse with simulated throttling and a real 4×
  CPU main-thread budget, both met on every screen; docs/performance.md). Lighthouse also runs
  in CI on GitHub's runners. Real-device and RUM p75 numbers come later, once the owner uses the
  deployed app.

M1's other known gap, unauthenticated pages and endpoints, closed in M2 (PR #7): deny by default
guards every page and `/api/*` endpoint, `/api/vitals` and `/api/client-errors` included, except
the sign-in, setup and recovery flow, `/api/health` and the prerendered offline screen.

## M2 — Authentication & profile [§3, §13]

- Passkey (WebAuthn) registration via one-time setup token; sign-in; recovery codes; multiple
  passkeys; session management and sign-out (ADR 0006).
- Every page and `/api/*` endpoint denies unauthenticated access (allow-list: landing, auth flow,
  `/api/health`, static assets); CSRF protections verified.
- Onboarding: event / general / multiple-goal paths; experience per discipline; optional 1RMs
  (measured vs estimated distinguished); equipment, injuries, preferences, schedule; body-weight
  and nutrition phase. Everything editable later.
- Added by the owner on 2026-11-06: an emailed one-time sign-in link, only ever to the owner's
  address (PRD §13), and a desktop browser view of the shell and every M2 screen (PRD §7, §16).

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
7. Email sign-in link: Playwright requests a link from the sign-in screen, reads it from the test
   mail adapter, taps to sign in and lands on Today; integration tests on real Postgres refuse a
   used, expired, concurrently used or merely prefetched link; the request never carries an
   address and only `OWNER_EMAIL` is ever mailed; requests are rate-limited; adding a passkey after
   a link sign-in still asks for a passkey; without `RESEND_API_KEY` or `OWNER_EMAIL` the option is
   hidden and the endpoint answers 404.
8. Desktop: at 1440 × 900 the shell (a navigation rail) and every M2 screen are laid out for the
   width, with Playwright desktop specs and screenshots in CI on Chromium and WebKit; the iPhone
   viewport and its specs are unchanged; no route's initial JS grows past its budget.

Progress (merged to `main` as slice PRs #2–#12 plus follow-up fixes, each green in CI):

- Done: passkey setup via one-time token, sign-in (button and conditional UI), recovery codes
  (forcing a new passkey; regeneration), passkey add/rename/remove (never the last), session
  list/revoke/sign-out-everywhere-else, deny by default with a route-enumerating test, Origin
  check on every state-changing request, DB rate limits, audit log, sign-out device clearing,
  `/api/vitals` and `/api/client-errors` behind a session; docs/security.md with an ASVS
  self-review; ADR 0006 accepted. Evidence: unit, integration (real Postgres, real
  SimpleWebAuthn verification) and Playwright with real WebAuthn ceremonies in Chromium.
- Done: the training profile below the screens: domain model and validation, schema
  (`drizzle/0004_training_profile.sql`) and services for the profile, ranked goals with history,
  baselines, preferences, schedule and onboarding progress, with integration tests on real
  Postgres; and the security and correctness fixes from reviewing the merged slices.
- Done: production cutover (criterion 6), PR #50, merged 2026-11-06 as `b708ab3`. It removes the
  `vercel.json` guards, so every merge to `main` deploys `coach.nikocruz.com`, and adds the
  post-deploy smoke check (`.github/workflows/post-deploy-smoke.yml`). The first production deploy
  was ready at 07:13 UTC: `curl -sI https://coach.nikocruz.com` answered `HTTP/2 200`,
  `/api/health` reported `db: up` on `0.1.0+b708ab3`, and smoke run 42179469627 passed all 15
  checks. Verified before merging: sign-out clears the device's
  account data on Chromium (`auth.e2e.ts`) and WebKit (`signout.e2e.ts`), and `/api/vitals` and
  `/api/client-errors` answer 401 without a session (route map unit test, `access.e2e.ts`, and
  the smoke check against production). It also records the ASVS level 2 review of the auth and
  session code (docs/security.md, "Production cutover review") and its fixes.
- Done: onboarding, Profile editing and Today (criteria 2, 3 and 5), merged as slice PRs #60
  to #181 (the last, onboarding resume in #178, on 2026-11-07). Every training-profile section is
  editable from Profile at `/profile/[section]`: goals (event and general, ranked by arrows or a
  drag, paused, achieved, dropped or deleted), experience, strength baselines (measured or
  estimated, or "I don't know my 1RMs"), running and Muay Thai, equipment, injuries, exercise
  preferences, schedule, body and nutrition, name and units. Onboarding (`/onboarding`) walks
  the same sections with progress, Skip on optional steps only, Back and Finish later that save,
  resume at the furthest step and a review before Start coaching. Today shows a "finish setting
  up" card until then, and the goals by priority and the shape of the week after. Evidence:
  `e2e/onboarding.serial.e2e.ts` completes onboarding with every 1RM blank and finds the profile
  in Postgres and after a reload; one serial spec per Profile section and
  `e2e/today.serial.e2e.ts`; integration round trips in `tests/integration/profile/`; axe in both
  themes on every Profile and onboarding screen (`e2e/a11y.e2e.ts`). The data model and the save
  path are in docs/architecture.md ("Training profile (M2)").
- Done: the desktop view (criterion 8), the owner's 2026-11-06 request, merged as #85 to #265
  (the last, desktop Lighthouse, on 2026-11-09): the layout rules and their guard (#96), the
  navigation rail and centred column in CSS only (#113), the auth screens (#132), sheets as
  centred dialogs and hover and focus states (#138), Coach, Progress, Security, /design and the
  error states (#166), Profile and its sections (#245), onboarding (#260), Train (#244), Today
  (#261), session detail and History (#263), and Security's headroom (#85). Evidence: the
  `desktop-chromium` Playwright project (#179) runs every `*.desktop.e2e.ts` spec at 1440 × 900
  with axe and screenshots of every main screen (`screens.desktop.e2e.ts`), and the serial specs
  run their desktop cases on Chromium and WebKit; the iPhone projects and their specs are
  unchanged. Desktop WebKit ran as its own project until the owner dropped it on 2026-11-07
  (#190), because their desktop browser is Chrome. On main `e93d417` CI run 42737223258 passed
  every e2e leg, `pnpm budgets` (every route under 60 KB; the shell cost +2 B in #113) and desktop
  Lighthouse (perf 100 on every screen); docs/performance.md, "M2X (desktop)" and "Lighthouse
  (desktop)". The desktop real-device pass is item 7 of docs/testing.md's checklist.
- Done: the owner's one-time setup (docs/deployment.md, "Owner setup") and the real-device
  check, on 2026-11-06 at 10:43 UTC on the owner's iPhone 16 Pro Max, iOS 27.0.1, in Chrome for
  iOS (the browser they use; WebKit engine). The passkey and recovery codes are stored,
  `OWNER_SETUP_TOKEN_HASH` is emptied in Vercel, and the real-device checklist in
  docs/testing.md passed in Chrome.
- Dropped by the owner on 2026-11-07: the email sign-in link (criterion 7). Its configuration,
  mailer, link storage and service stay merged and switched off (#108, #124, #161, #180); the
  sign-in screen's option and its routes will not be built, and ADR 0011 keeps the design.

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

Status: **done**. The M3 plan's 49 slices merged to `main` as numbered PRs, #41 (m3/01) to #233
(m3/49), each green in CI; like M2, they went to `main` rather than to one
`feat/m3-training-model` branch, the plan's default for the brief's branch question. The model is
in docs/architecture.md ("Training model (M3)") and ADR 0010, the tests in docs/testing.md
("Training (M3)"), and the numbers, measured by CI on the M3 head, in docs/performance.md ("M3
screens", "M3 query plans"). Evidence per criterion:

- Criterion 1: migrations `drizzle/0008_program_versions.sql` to
  `drizzle/0016_history_plan_indexes.sql` add programs with immutable versions (#43), the
  exercise library of 191 exercises seeded by every migrate run (#45, #54, #58), prescriptions
  (#64), the append-only, audited training log with its history indexes (#72) and coaching memory
  (#79). Postgres refuses UPDATE on planned rows and DELETE on every history and logged table;
  an edit copies the affected week into a new version (#95) and never touches the old one. Proven
  on real Postgres by `program-schema`, `prescriptions-schema`, `log-schema` and
  `program-versioning` in `tests/integration/training/`.
- Criterion 2: profile → program → planned week → retrieve, through the M2 services (#78, and
  with the real generator #156), read back by date, week and lineage (#82); exercise history,
  last performances, PRs, weekly volume and mileage (#94); an idempotent set-record insert under
  a two-connection race (#106).
- Criterion 3: strength, an interval run and a Muay Thai class in one stored week (#78); the
  hybrid scenario places them by the interference rules (#71, #88, #100, #109), and the journey
  sees all three in week 1 on Train (#233).
- Criterion 4: `pnpm db:explain` (#111) explains every history and program query on a two-year
  dataset; CI fails a Seq Scan of a large relation or an unused declared index. 38 plans pass,
  with timings in docs/performance.md ("M3 query plans"); the index fixes it found are there too.

The brief's further criteria:

- Deterministic, rule-based week-1 generation, no LLM: inputs and defaults (#65), eligibility
  (#70), the first block and day rule (#69), strength (#80), commitments and running (#88),
  loads (#92), volume (#97), placement (#100), and the seven scenarios, beginner with blank
  1RMs, powerlifter with measured ones, hybrid, injured shoulder and dumbbells only among them
  (#109); previewed and built from the profile (#156). Every significant choice writes a
  decision with its why.
- Playwright: `e2e/program-journey.serial.e2e.ts` (#233) onboards with every 1RM blank, builds
  from Today, finds strength, running and Muay Thai in week 1, opens an RPE-based baseline
  session, moves a session and swaps an exercise, sees both in History with their why, and
  reloads; a second journey checks measured-1RM percentages.
- A one-off swap stores no preference and 'never prescribe this again' stores a dislike: in the
  service (#159) and in the UI (#177).
- Screens: Build my program (#216), the Train week (#117), plan overview (#128), session detail
  (#125), move (#140), swap (#177), adjust and skip (#212), History (#169) and Today's panels
  and sessions (#211, #224), each with designed empty, rest-day, loading and error states, axe
  clean in dark and light, and laid out for a 1440 × 900 desktop window. Every route is within
  60 KB of initial JS and the main-thread guard covers the program screens (#231).
- Domain functions for e1RM, best e1RM, weekly hard sets per muscle group, session load and
  weekly distance reuse M1's maths (#57) and are documented in `src/lib/domain/README.md`.
- Gates: CI runs check, lint, unit, integration, `db:explain`, both builds, budgets, every e2e
  project (perf included) and Lighthouse on every PR; by the owner's rule the heavy suites run
  there rather than on a laptop.

## M4 — Workout application [§7, §8, §9, §15, §16, §18]

- Workout screen: current exercise, targets, previous performance, rest timer, stopwatch.
- One-handed set logging (weight/reps/RPE), edit/skip/missed reps/extra sets; running and general
  session logging; plate calculator integration; substitutions (situational vs persistent).
- Offline-first: IndexedDB store, outbox with idempotent mutation ids, sync, no duplicates.

Acceptance criteria:

1. Playwright: start workout, log sets/reps/RPE, rest timer, plate calculator, substitute an
   unavailable exercise, **refresh mid-workout and restore**, complete workout, view history
   (iPhone viewport; the same screens laid out for desktop too).
2. Persistence tests: offline logging, reconnect sync, failed-sync recovery, no duplicate sets.
3. Logging a set is optimistic (< 100 ms to visual confirmation, measured) and never depends on
   the agent.
4. INP p75 ≤ 200 ms on the workout screen in local measurements.

Status: **in progress**. M4's slices merged to `main` as numbered PRs, like M2's and M3's (the
plan's default for the brief's branch question), dark-launched until the entry points (#366).
The design is in docs/architecture.md ("Offline workouts (M4)") and ADR 0012, the tests in
docs/testing.md ("Workouts (M4)"), and the numbers, measured by CI on the merged code, in
docs/performance.md ("M4 (workout)"). Evidence per criterion:

- Criterion 1: `e2e/journey-strength.serial.e2e.ts` (#373) starts from Today, logs the top set
  and back-offs with weight, reps and RPE, runs the rest timer and the plate calculator, swaps an
  unavailable machine, refreshes mid-workout and finds every set and the rest restored, finishes
  and opens History, at the iPhone viewport and again at 1440 × 900. Each screen has its own spec
  as well (docs/testing.md, "Workout screen"), from the shell (#192) to custom exercises (#355).
- Criterion 2: `e2e/journey-offline.serial.e2e.ts` (#371) logs, edits and deletes offline,
  reloads, reconnects and counts the rows in Postgres; replays and two tabs add no duplicate; a
  500, a lost answer and a refused change recover. Underneath: the ledger (#151), the sync
  endpoint (#175), the store (#120), the engine (#127) and reconcile (#154), on real Postgres and
  fake IndexedDB.
- Criterion 3: a logged set shows as done in a median of 36.5 ms, p95 42.4 ms, over 20 sets at
  4× CPU (`e2e/perf-workout.e2e.ts`, gated at p95 < 100 ms since #235; final form #370). Logging
  touches only IndexedDB and `/api/workouts/sync`: the strength journey aborts every coach
  request and still finishes.
- Criterion 4: INP p75 on `/workout` is 88 ms from Event Timing and from web-vitals (#370).
- Criteria 3 and 4 come from one green run, #370's 42939723798. #370 asks for two; the second is
  still to record. An earlier run, 42802588785 (median 22.9 ms, p95 32.5 ms, INP 56 ms), came
  before #370's fixes and failed.
- The brief's run and Muay Thai journey: `e2e/journey-run-muay-thai.serial.e2e.ts` (#368).
- Sign-out with unsynced workout changes flushes first (at most 5 s), then asks before deleting
  them; "Stay signed in" keeps every change (#367, `e2e/signout-pending.e2e.ts`).
- Lighthouse mobile on `/workout · active`: LCP 903 ms, Performance 100 in #370's run
  42933643722, after the shorter boot path (#394) and the prepaint (#410).

Still open:

- The owner's review of journey-strength's screenshot set (`strength-*`, mobile and desktop):
  not yet recorded.
- The real-device checklist's workout item (docs/testing.md, item 8) has not been run.

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

Status: **in progress**. Every M5 slice is built: 60 slice PRs from #101 to #463 (this docs PR is
the 61st), merged to `main` as numbered PRs like M3's and M4's, dark-launched behind `COACH_LAUNCHED` until
coach-launch (#449) turns the real coach on in production. The design is in
docs/agent-architecture.md (ADR 0009, 0013, 0014), the security review in docs/security.md
("Coach (M5) review"), the tests in docs/testing.md ("Coach (M5)") and the numbers, measured by CI,
in docs/performance.md ("M5 (coach)"). Evidence per criterion:

- Criterion 1: one integration test per tool group, through `runTurn` on real Postgres with the
  MockProvider: history (#287), programming reads (#219), analytics (#232), workout (#295),
  preferences (#303) and programming proposals (#313), each with output-schema checks and a
  foreign owner id that reads and writes nothing.
- Criterion 2: every change is a `coach_proposals` row that Postgres keeps `proposed`, immutable
  and forward-only (#203); Accept goes by id and applies in one transaction, a program kind as one
  new version with a coach decision per op (#280, #282, #207); goals and preferences through
  Profile's services (#210); a session swap through M4's ledger (#286). The cards (#381), decisions
  (#385) and the inbox (#390) need the owner's tap, and the journeys show Accept → version N in
  Train (#405).
- Criterion 3: 'I hate Bulgarian split squats' records a coach-sourced dislike with a decision
  note; a taken machine is situational and stores no preference
  (`tests/integration/coach/tools-preferences.test.ts`, #303; statements, #153); the dislike
  reaches a new conversation through memory (`e2e/coach-memory-panel.serial.e2e.ts`, #383).
- Criterion 4: banned phrasings are bounded patterns (#153); the output gate holds pain-context
  blocks to the end and replaces a failing one before any of it is sent (#226); a pain turn names
  stopping, a gentler option and a professional (#295). The live suite's pain conversation has not
  been run against the real model.
- Criterion 5: `pnpm budgets` scans every client file of both builds for the SDK, `sk-ant-` keys
  and CI's canary key (#201), and only the Anthropic provider imports the SDK at runtime (#123,
  #193).
- Core logging works with the coach failing, unavailable or not launched, with no coach request
  (`e2e/coach-degrade.serial.e2e.ts`, #396).
- The launch (#449): the owner's go-ahead of 2026-11-10 in place of a live run; the owner confirmed
  `ANTHROPIC_API_KEY` in Production, Fluid compute, `LLM_PROVIDER` unset and the $5 daily cap. The
  kill switch is `LLM_PROVIDER=off` and a redeploy (docs/environment.md, "The coach (M5)").

Still open:

- The owner's review of the coach screenshot set (#405), the merge gate of #449: not yet recorded.
- The live suite (`pnpm test:live`) has never run against the real model, so prompt caching, real
  TTFT and label compliance are not yet measured.
- Lighthouse has no inbox audit (docs/performance.md, "M5 (coach)"). The coach screen, 60.3 KB
  and over the 60 KB gate in the M5 run, is 57.5 KB since the shared JS trim (#473).
- The real-device checklist has no coach item yet.

## M6 — Analytics & reviews [§10, §11]

- Strength/running/general dashboards with context; weekly review; cycle review → next cycle.

Acceptance criteria:

1. Analytics computed by tested domain functions (e1RM trends, volume per muscle, mileage, load).
2. Playwright: weekly review and "generate next week" journeys (iPhone and desktop viewports).
3. Charts accessible (text alternatives) and within budgets.

## M7 — Advanced coaching [§2, §5]

- Concurrent-training interference rules, goal priority conflicts, deloads, taper, hypertrophy
  blocks, marathon blocks; explanations of tradeoffs.

Acceptance criteria:

1. Scenario tests (mock provider + domain rules) for the PRD §5 conflict examples.
2. Multiple concurrent disciplines journey in Playwright.

## M8 — Performance & design refinement [§15–17]

- Independent performance and design councils evaluate real screens (iPhone and desktop) and
  measurements; iterate.

Acceptance criteria:

1. Council reports with scores, evidence and resolved issues (criteria held by the orchestrator).
2. Core Web Vitals "good" at p75 from RUM; budgets still green.

## M9 — Final QA & production release [§13, §19, §22]

- Security review, backup/restore drill, production deploy on coach.nikocruz.com, Performance and
  Design reports.

Acceptance criteria:

1. Full e2e suite green on Chromium + WebKit, iPhone and desktop viewports, against a
   production-like deployment.
2. Restore drill from an encrypted backup into a Neon branch documented with timestamps.
3. Owner sign-off on the deployed app.
