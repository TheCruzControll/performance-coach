# Performance

Performance is a first-class requirement (PRD §15): measure, set budgets, enforce them, and record
**real** numbers only. Everything below was measured locally on 2026-11-05 against the production
build of commit `6586cf6` (M1 after review fix round 2; the commits after it touch only the
Lighthouse runner, CI and docs).

## M2 (authentication) — measured 2026-11-05

Measured on the M2 branch after passkey auth landed (local 4-vCPU VM, same tools as below). The
sizes were measured again with the accounting described under "Budgets (enforced)" once the
training-profile services landed (`pnpm build:node && pnpm budgets`; no route awaits a dynamic
import in its `load`, and no chunk is missing from SvelteKit's modulepreload list).

| Route                     | Initial JS (gzip) | Route CSS (gzip) |
| ------------------------- | ----------------: | ---------------: |
| `/(app)/profile/security` |           59.6 KB |          10.2 KB |
| `/(app)/train`            |           58.2 KB |          10.5 KB |
| `/(app)/profile`          |           57.8 KB |           8.3 KB |
| `/setup`                  |           56.7 KB |           6.4 KB |
| `/(app)/today`            |           56.2 KB |           7.5 KB |
| `/design`                 |           55.8 KB |          11.7 KB |
| `/` (sign-in)             |           55.0 KB |           5.4 KB |
| `/(app)/progress`         |           54.9 KB |           6.7 KB |
| `/(app)/offline`          |           54.9 KB |           6.1 KB |
| `/recover/passkey`        |           54.6 KB |           5.0 KB |
| `/recover`                |           53.6 KB |           5.2 KB |
| `/(app)/coach`            |           52.9 KB |           6.0 KB |

Whole-build CSS is 19.6 KB in 39 files (tracked, no longer a budget); the heaviest route CSS is
`/design` at 11.7 KB of 14 KB. All budgets pass, but headroom is now thin: the Security screen is
at 59.6 KB (its sheets, the passkey helpers and sign-out code load on intent; without that it was
65 KB), so `/(app)/profile/security` has **0.4 KB of headroom**. Against the M1 table every
existing route grew by 2.3–3.3 KB; part of that is the shared icon set (the whole set ships with
every screen; nine security icons were added), the rest is not yet attributed and should be
before M3 adds screens. Anything new must be code-split or paid for elsewhere — record the
trade-off here.

Whatever every route ships spends that 0.4 KB: each new route node (the app entry lists every
node of the app), each param matcher, each icon added to the shared set and any growth of a
shared component costs every route, Security included.

- **Step-up re-authentication** (docs/security.md) costs `/(app)/profile/security` 0.1 KB
  (59.7 → 59.8 KB: retrying an action the server refused). The "Confirm it's you" sheet and the
  ceremony load on demand with the other sheets and passkey helpers; `/` and
  `/recover/passkey` gain 0.1 KB (one error mapping in those helpers).

- **Train renders without the plate calculator's CSS** (`/(app)/train` route CSS 14.3 → 11.0 KB).
  The toasts' styles moved into every route's CSS (0.3 KB) when the toasts joined the initial JS,
  which put Train over its 14 KB. Its `PlateSheet` loaded on intent, but the server build could
  reach that import, so SvelteKit linked its stylesheets (sheet, stepper, segmented control) into
  Train. The server build now leaves it out (`import.meta.env.SSR`), as it does the plan sheet,
  and those stylesheets arrive with the sheet (#245).

- **`/design` renders with the CSS of its Buttons group only** (13.8 → 6.7 KB). Its Inputs, Data
  and Feedback groups loaded their JS with their tab, but SvelteKit still linked their CSS into
  the page as render-blocking stylesheets, because the server build could reach their imports.
  The server only renders Buttons, so those imports are now left out of its build
  (`import.meta.env.SSR`) and each group's CSS loads with its tab; `/design` JS gains 23 B.

- **Train's plate-calculator sheet loads with the calculator** (`/(app)/train` 58.2 → 56.5 KB).
  Train imported `BottomSheet` statically although only the plate calculator opens in it; the
  route-local `PlateSheet` (sheet and calculator) now loads on intent, as the calculator alone
  did, and the first tap fetches 5.7 KB instead of 3.9 KB. Its failed-chunk state (a `Notice`
  with Retry under the row; the notice's chunk is 0.5 KB) and a CSS-only pending spinner stay in
  Train, whose route CSS grows 10.5 → 11.1 KB. Chromium keeps a failed module fetch for the
  page's lifetime, so a retry that fails again online reloads Train with `?tool=plates`. Every
  other route is 33 B lighter: the app entry lists fewer of Train's static imports.
  The sheet's JavaScript has no `<link rel=modulepreload>`, as no code loaded on demand has (the
  one `build.modulePreload` rule in `vite.config.ts`, below): WebKit keeps a modulepreload that
  failed and fails every later import of that URL without a request, reloads included (WebKit
  bug 270357), so Retry could never recover on Safari. Before the service worker holds the build,
  a first tap fetches the sheet's chunks in import order after its stylesheets (three round
  trips) where the modulepreload tags fetched them alongside.

- **`@simplewebauthn/browser` (≈5 KB gzip) is never in initial JS.** It is imported on demand by
  `src/lib/client/passkeys.ts`; `pnpm budgets` fails if it appears in any route's initial JS or
  is reachable (static or dynamic imports) from any route other than `/`, `/setup`,
  `/recover/passkey` and `/(app)/profile/security`.
- **Validation (zod and the profile schemas: one 12.5 KB gzip chunk) is never in initial JS.**
  `src/lib/client/profile-form.ts` imports `src/lib/domain/profile/schemas.ts` on demand (on
  idle, once a form is on screen); `pnpm budgets` fails if zod or the schemas are in any route's
  initial JS, including what its `load` awaits. The save path itself is not free: a scratch route
  that imported `profile-form.ts` and `section-form.svelte.ts` statically grew by 2.5 KB (with
  `$app/forms`), so it belongs in what an editor loads on demand.
- **Profile sections (`/profile/[section]`, 55.2 KB)** cost every other route 54 B: the app entry
  lists one more node (`/(app)/profile/security` 61296 → 61350 B of 61440; `/design` 41 B more, its
  Inputs panel now sharing the input primitives with the editor). The editor, the save path and the
  discard sheet load after the screen. A Svelte runtime helper that any code uses, even code
  loaded on demand, joins the runtime chunk every route loads: `$state.snapshot` in `SectionForm`
  cost 228 B (now a JSON copy) and a `{#key}` block 80 B (a keyed each of one). Importing a shared
  component on demand cost `/train` 181 B (a module namespace in a chunk it loads up front), so the
  sheet is its own small component.
- **Code loaded on demand carries no `<link rel="modulepreload">` hints** (`build.modulePreload`
  in `vite.config.ts`: one rule for every lazy import, Train's plate sheet and each profile
  editor included, so new lazy code needs no list; only SvelteKit's router, in its entry chunks,
  keeps them). Its JavaScript arrives through the module graph and its CSS still loads with it.
  WebKit keeps a failed modulepreload in its memory cache until the page that made it is
  garbage-collected and serves that failure to the next page too (WebKit bug 270357), so a Retry
  that reloads could never load the editor again on Safari. Measured with it:
  `/(app)/profile/security` 61350 → 61231 B of 61440 and `/design` 57327 → 57143 B (their
  on-demand code lost its hints); with main's Train sheet merged, `/(app)/profile/security` is
  61194 B. The (app) layout's guard against rendering a navigation that a later one has overtaken
  costs every app screen 33 B, on top of 43 B every route pays for the app entry (its list of
  route files, reordered).
- **Main-thread budget** (`E2E_PERF_ALONE=1 pnpm test:e2e --project=perf`, median of 5 loads at 4×
  CPU; app screens signed in, `/` signed out): `/` 57 ms, `/today` 81, `/train` 72, `/progress`
  67, `/coach` 40, `/profile` 87, `/profile/security` 60 — every screen meets the 200 ms target.
- **Lighthouse, one run per screen** (signed in via a session the script mints; `/` signed out):
  perf 98–100, accessibility 100, best practices 100, CLS 0.000 everywhere; `/profile/security`
  LCP 1.07 s, TBT 103–153 ms. A single run is not a median: the 5-run CI assertion is the gate.
- **Server:** every dynamic request now does one indexed session lookup, reported as
  `Server-Timing: auth;dur=…`.

## M3 screens — measured 2026-11-08

M3 baseline, measured at `94e3cff`: CI run
[42443924197](https://github.com/TheCruzControll/performance-coach/actions/runs/42443924197)
built PR #231's merge commit `94e3cff` (main `1927b89` with m3/46 and m3/47). These numbers
describe that commit only; later changes to the build configuration, budget script and app code
are not covered by them. GitHub's 4-vCPU Linux runners ran
`pnpm build:node && pnpm budgets`, the `perf` project and the Lighthouse command, each as its
section below describes.

**Initial JS and route CSS (gzip), every route.** All pass: initial JS ≤ 60 KB, route CSS ≤ 14 KB,
two preloaded fonts each.

| Route                              | Initial JS | Route CSS |
| ---------------------------------- | ---------: | --------: |
| `/workout` (M4)                    |    59.4 KB |    7.6 KB |
| `/(app)/train`                     |    57.3 KB |   13.5 KB |
| `/(app)/train/session/[key]`       |    56.9 KB |    9.8 KB |
| `/(app)/today`                     |    56.9 KB |   12.5 KB |
| `/(app)/profile/security`          |    55.9 KB |   11.0 KB |
| `/(app)/profile`                   |    55.7 KB |    8.6 KB |
| `/(app)/train/history/[[version]]` |    54.6 KB |    9.7 KB |
| `/setup`                           |    53.1 KB |    7.3 KB |
| `/onboarding/[[step]]`             |    52.8 KB |    6.1 KB |
| `/(app)/profile/[section]`         |    52.7 KB |    6.9 KB |
| `/design`                          |    52.4 KB |    7.4 KB |
| `/(app)/progress`                  |    52.1 KB |    7.4 KB |
| `/`                                |    51.4 KB |    6.1 KB |
| `/(app)/offline`                   |    51.3 KB |    6.7 KB |
| `/recover/passkey`                 |    51.0 KB |    5.8 KB |
| `/recover`                         |    50.0 KB |    6.1 KB |
| `/(app)/coach`                     |    49.3 KB |    6.6 KB |

The whole build's CSS is 47.1 KB in 86 files (tracked, not a budget); the service worker is
3.5 KB.

**Against the M3 plan's ceilings** (initial JS; the plan's cumulative ceilings, each slice held to
its own):

| Route                                    | Ceiling                                         | Measured | Headroom under 60 KB |
| ---------------------------------------- | ----------------------------------------------- | -------: | -------------------: |
| `/(app)/train`                           | 59.3 KB after m3/45, the last of its ceilings   |  57.3 KB |               2.7 KB |
| `/(app)/today`                           | 59.0 KB after m3/46                             |  56.9 KB |               3.1 KB |
| `/(app)/train/session/[key]` (new)       | 57 KB, raised to 58.0 KB for Move (m3/41, #140) |  56.9 KB |               3.1 KB |
| `/(app)/train/history/[[version]]` (new) | 57 KB                                           |  54.6 KB |               5.4 KB |
| `/(app)/profile/security`                | 59.8 KB throughout                              |  55.9 KB |               4.1 KB |

- `/(app)/train` ends M3 2.0 KB under its last ceiling, more than the 0.6 KB margin the plan asked
  for. `/(app)/profile/security`, the route the plan feared for, has 4.1 KB left: the icon sprite
  (#90, about 1.8 KB off every route) and the slimmer shared entry ("Measured" under "Budgets
  (enforced)", 2.0–2.7 KB) took far more off every route than M3's two route nodes added, so the
  plan's contingency (icons as per-icon exports) is not needed.
- The tightest budget M3 leaves is CSS, not JS: Train's route CSS is 13.5 KB of 14 KB (0.5 KB
  left) and Today's 12.5 KB. The heaviest initial JS is M4's `/workout` (59.4 KB).
- What keeps the screens inside: every word on Train, the session screen and Today is composed
  in the server load, so no training vocabulary or describe code ships; the plan overview, every
  edit sheet (through one lazy `EditSheetHost`), the plate sheet and each Today state's panel
  load on intent or on demand (`PANELS`), each with a failed-chunk Retry; zod and the edit schemas
  load with their sheet; the catalogue and the generator are server-only (`pnpm budgets` fails
  on `CATALOGUE_HEADER` in a client chunk). SvelteKit's modulepreload list misses seven small
  chunks (0.3–1.0 KB) of Today's initial JS, so they are fetched after the chunk that imports
  them; the budget report lists them and counts them.

**Main-thread budget** (`e2e/perf.e2e.ts`, median of 5 cold loads at 4× CPU, ms; target ≤ 200,
fails above 250). The program screens are seeded through the fixture route (docs/testing.md) and
none shifted (worst unexplained layout-shift sum 0.0000 on every load, `MAX_SHIFT` 0.01):

| Screen                      | Median | Loads                   |
| --------------------------- | -----: | ----------------------- |
| `/today` (Build card)       |    123 | 99, 104, 123, 143, 150  |
| `/today` (program)          |    100 | 59, 76, 100, 145, 177   |
| `/train` (hybrid week)      |     94 | 76, 92, 94, 101, 120    |
| `/train/session/<strength>` |     94 | 77, 88, 94, 96, 108     |
| `/train/history`            |     48 | 38, 48, 48, 50, 58      |
| `/`                         |     35 | 21, 25, 35, 56, 74      |
| `/today`                    |     88 | 71, 85, 88, 95, 133     |
| `/progress`                 |     56 | 24, 52, 56, 57, 73      |
| `/coach`                    |     44 | 35, 43, 44, 44, 45      |
| `/profile`                  |    143 | 126, 135, 143, 181, 181 |
| `/profile/security`         |    107 | 84, 85, 107, 122, 131   |
| `/profile/equipment`        |     94 | 69, 91, 94, 97, 118     |
| `/profile/schedule`         |    112 | 89, 104, 112, 123, 124  |
| `/onboarding`               |     66 | 57, 57, 66, 86, 129     |

**Lighthouse** (mobile, simulated throttling, median of 5 runs, Lighthouse 13.6.0, Chrome
153.0.8010.12; `lighthouse: all thresholds met`). With `--seed` (on in CI) the runner seeds a
demo profile, audits Today's Build card, then builds through `?/preview` and `?/build` and audits
Today's program state, Train, the longest session and History:

| Route                  | Perf | A11y | Best practices |     LCP |     FCP |   TBT |   CLS | Speed Index |
| ---------------------- | ---: | ---: | -------------: | ------: | ------: | ----: | ----: | ----------: |
| `/today` · Build card  |  100 |  100 |            100 | 1204 ms | 1204 ms |  7 ms | 0.000 |     1204 ms |
| `/today` · program     |  100 |  100 |            100 | 1204 ms | 1204 ms | 13 ms | 0.000 |     1204 ms |
| `/train` · program     |  100 |  100 |            100 | 1205 ms | 1205 ms | 39 ms | 0.000 |     1205 ms |
| `/train/session/[key]` |  100 |  100 |            100 | 1205 ms | 1205 ms | 51 ms | 0.000 |     1205 ms |
| `/train/history`       |  100 |  100 |            100 | 1055 ms | 1055 ms | 17 ms | 0.000 |     1055 ms |
| `/train` (no program)  |  100 |  100 |            100 | 1055 ms | 1055 ms | 17 ms | 0.000 |     1055 ms |
| `/`                    |  100 |  100 |            100 |  907 ms |  907 ms | 10 ms | 0.000 |      907 ms |
| `/progress`            |  100 |  100 |            100 |  905 ms |  905 ms | 21 ms | 0.000 |      905 ms |
| `/coach`               |  100 |  100 |            100 |  906 ms |  906 ms |  0 ms | 0.000 |      906 ms |
| `/profile`             |  100 |  100 |            100 | 1054 ms | 1054 ms |  2 ms | 0.000 |     1054 ms |
| `/profile/security`    |  100 |  100 |            100 |  904 ms |  904 ms | 11 ms | 0.000 |      904 ms |

The history queries behind these screens are in
[M3 query plans](#m3-query-plans--measured-2026-11-08) below.

## M3 query plans — measured 2026-11-08

`pnpm db:explain` (docs/development.md, "Query plans") in the same CI run, on merge commit
`94e3cff`, with **Postgres 18.6** (CI's `postgres:18` service, the major version of the Neon
production branch) on an AMD EPYC 9V74 × 4 runner. It loads one owner's deterministic two-year
dataset (`scripts/explain/dataset.ts`: 742 days, the rows below), runs `ANALYZE`, then
`EXPLAIN (ANALYZE, BUFFERS)` on every builder in `db/queries/{history,programs}.ts` with the
parameters its service passes. All 38 plans pass the gate (37 of them M3's; `activeWorkouts` is
M4's), and `scripts/explain/history.explain.ts` runs in 1.8 s. Times are one warm run's execution
times: they are recorded, never asserted. The report is `test-results/explain.md`, kept by CI as
the `explain-<run id>` artifact with every plan node by node; to reproduce,
`pnpm db:setup && pnpm db:explain`.

### Relation sizes

After `ANALYZE`. A relation is large from 5,000 rows or 50 pages (`LARGE_TUPLES`, `LARGE_PAGES` in
`scripts/explain/plan-check.ts`): there a plan must use each index its builder declares and never
Seq Scan. `training_audit` is large by pages (wide audit rows), but no builder reads it.

| Relation                |  Rows | Pages | Size  |
| ----------------------- | ----: | ----: | ----- |
| exercises               |   191 |    11 | small |
| other_session_records   |   150 |     3 | small |
| owners                  |     1 |     1 | small |
| planned_exercises       |  5868 |    79 | large |
| planned_run_segments    |   652 |     8 | small |
| planned_session_details |   247 |     3 | small |
| planned_sessions        |  1877 |    37 | small |
| program_blocks          |    24 |     1 | small |
| program_version_blocks  |   201 |     2 | small |
| program_version_weeks   |   871 |     7 | small |
| program_versions        |    67 |     2 | small |
| program_weeks           |   163 |     3 | small |
| programming_decisions   |   139 |     5 | small |
| programs                |     8 |     1 | small |
| recovery_notes          |   440 |     7 | small |
| run_record_segments     |  6324 |   118 | large |
| run_records             |   402 |     6 | small |
| set_prescriptions       |  5868 |    79 | large |
| set_records             | 16226 |   422 | large |
| training_audit          |   552 |   137 | large |
| workouts                |  1163 |    33 | small |

### Each query

Buffers are the plan's shared blocks, hit/read.

| Query                                       | Declared index                                                              | Scans of large relations                                                                                                                                                                  | Rows | Execution | Buffers hit/read |
| ------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | --------: | ---------------: |
| exerciseHistory, first page                 | `set_records_exercise_history_idx`                                          | Index Scan set_records_exercise_history_idx                                                                                                                                               |   20 |  0.039 ms |              7/0 |
| exerciseHistory, page 6                     | `set_records_exercise_history_idx`                                          | Index Scan set_records_pkey, Index Scan set_records_exercise_history_idx                                                                                                                  |   20 |  0.081 ms |             12/0 |
| lastPerformances, last 3                    | `set_records_exercise_history_idx`                                          | Bitmap Heap Scan set_records, Bitmap Index Scan set_records_exercise_history_idx, Index Scan set_records_workout_order_idx                                                                |   12 |  0.486 ms |            126/0 |
| bestE1rms, one exercise                     | `set_records_exercise_e1rm_idx`                                             | Index Scan set_records_exercise_e1rm_idx                                                                                                                                                  |    1 |  0.057 ms |              7/0 |
| bestE1rms, every exercise                   | `set_records_exercise_e1rm_idx`                                             | Index Scan set_records_exercise_e1rm_idx                                                                                                                                                  |   40 |  1.421 ms |            707/0 |
| repMaxes, one exercise                      | `set_records_exercise_rep_max_idx`                                          | Index Scan set_records_exercise_rep_max_idx                                                                                                                                               |    3 |  0.178 ms |             53/0 |
| repMaxes, every exercise                    | `set_records_exercise_rep_max_idx`                                          | Index Scan set_records_exercise_rep_max_idx                                                                                                                                               |  150 |  8.481 ms |           6958/0 |
| setsInRange, 12 weeks (muscle volume)       | `set_records_owner_performed_idx`                                           | Bitmap Heap Scan set_records, Bitmap Index Scan set_records_owner_performed_idx                                                                                                           | 1800 |  2.307 ms |             77/0 |
| runsInRange, 12 weeks (mileage)             | `workouts_owner_kind_started_idx`                                           | — (small relations only)                                                                                                                                                                  |   46 |  0.237 ms |             13/0 |
| activeWorkouts (continue on another device) | `workouts_owner_started_idx`                                                | — (small relations only)                                                                                                                                                                  |    0 |  0.262 ms |             33/0 |
| sessionsInRange, 4 weeks: planned           | `program_version_weeks_pk`, `planned_sessions_week_day_idx`                 | — (small relations only)                                                                                                                                                                  |   46 |  0.284 ms |             40/0 |
| sessionsInRange, 4 weeks: logged            | `workouts_owner_started_idx`                                                | — (small relations only)                                                                                                                                                                  |   42 |  0.069 ms |              4/0 |
| currentProgram                              | `programs_owner_active_uq`, `program_versions_pkey`                         | — (small relations only)                                                                                                                                                                  |    1 |  0.050 ms |              3/0 |
| currentProgram, version 5                   | `programs_owner_active_uq`, `program_versions_program_number_uq`            | — (small relations only)                                                                                                                                                                  |    1 |  0.040 ms |              3/0 |
| versionTree: blocks                         | `program_version_blocks_pk`, `program_blocks_pkey`                          | — (small relations only)                                                                                                                                                                  |    3 |  0.060 ms |              3/0 |
| versionTree: weeks                          | `program_version_weeks_pk`, `program_weeks_pkey`                            | — (small relations only)                                                                                                                                                                  |   13 |  0.081 ms |              6/0 |
| versionTree: sessions                       | `program_version_weeks_pk`, `planned_sessions_week_day_idx`                 | — (small relations only)                                                                                                                                                                  |  149 |  0.585 ms |             40/0 |
| versionTree: exercises                      | `planned_sessions_week_day_idx`, `planned_exercises_session_position_uq`    | Bitmap Heap Scan planned_exercises, Bitmap Index Scan planned_exercises_session_position_uq                                                                                               |  468 |  1.572 ms |            147/0 |
| versionTree: sets                           | `planned_sessions_week_day_idx`, `set_prescriptions_exercise_position_uq`   | Bitmap Heap Scan planned_exercises, Bitmap Index Scan planned_exercises_session_position_uq, Bitmap Heap Scan set_prescriptions, Bitmap Index Scan set_prescriptions_exercise_position_uq |  468 |  1.469 ms |            214/0 |
| versionTree: segments                       | `planned_sessions_week_day_idx`, `planned_run_segments_session_position_uq` | — (small relations only)                                                                                                                                                                  |   52 |  0.589 ms |             53/0 |
| versionTree: details                        | `planned_sessions_week_day_idx`, `planned_session_details_pkey`             | — (small relations only)                                                                                                                                                                  |   19 |  0.528 ms |             43/0 |
| sessionsWithChildren, this week: sessions   | `planned_sessions_week_day_idx`                                             | — (small relations only)                                                                                                                                                                  |   11 |  0.035 ms |              4/0 |
| sessionsWithChildren, this week: exercises  | `planned_sessions_week_day_idx`, `planned_exercises_session_position_uq`    | Bitmap Heap Scan planned_exercises, Bitmap Index Scan planned_exercises_session_position_uq                                                                                               |   36 |  0.274 ms |             46/0 |
| sessionsWithChildren, this week: sets       | `planned_sessions_week_day_idx`, `set_prescriptions_exercise_position_uq`   | Bitmap Heap Scan planned_exercises, Bitmap Index Scan planned_exercises_session_position_uq, Bitmap Heap Scan set_prescriptions, Bitmap Index Scan set_prescriptions_exercise_position_uq |   36 |  0.119 ms |             74/0 |
| sessionsWithChildren, this week: segments   | `planned_sessions_week_day_idx`, `planned_run_segments_session_position_uq` | — (small relations only)                                                                                                                                                                  |    4 |  0.048 ms |             15/0 |
| sessionsWithChildren, this week: details    | `planned_sessions_week_day_idx`, `planned_session_details_pkey`             | — (small relations only)                                                                                                                                                                  |    1 |  0.048 ms |              6/0 |
| plannedSessionsInRange, today               | `program_version_weeks_pk`, `planned_sessions_week_day_idx`                 | — (small relations only)                                                                                                                                                                  |    1 |  0.155 ms |             40/0 |
| upcomingSessions, next 3                    | `program_version_weeks_pk`, `planned_sessions_week_day_idx`                 | — (small relations only)                                                                                                                                                                  |    3 |  0.212 ms |             40/0 |
| sessionByLineage                            | `planned_sessions_lineage_idx`                                              | — (small relations only)                                                                                                                                                                  |    1 |  0.109 ms |             17/0 |
| sessionChildren: exercises                  | `planned_sessions_pkey`, `planned_exercises_session_position_uq`            | Bitmap Heap Scan planned_exercises, Bitmap Index Scan planned_exercises_session_position_uq                                                                                               |    6 |  0.148 ms |             28/0 |
| sessionChildren: sets                       | `planned_sessions_pkey`, `set_prescriptions_exercise_position_uq`           | Bitmap Heap Scan planned_exercises, Bitmap Index Scan planned_exercises_session_position_uq, Bitmap Heap Scan set_prescriptions, Bitmap Index Scan set_prescriptions_exercise_position_uq |    6 |  0.053 ms |             19/0 |
| sessionChildren: segments                   | `planned_sessions_pkey`, `planned_run_segments_session_position_uq`         | — (small relations only)                                                                                                                                                                  |    0 |  0.028 ms |              5/0 |
| sessionChildren: details                    | `planned_sessions_pkey`, `planned_session_details_pkey`                     | — (small relations only)                                                                                                                                                                  |    0 |  0.028 ms |              4/0 |
| completedLineages, this week                | `workouts_planned_lineage_idx`                                              | — (small relations only)                                                                                                                                                                  |   10 |  0.076 ms |              9/0 |
| versionHistory, newest page                 | `program_versions_program_number_uq`, `programming_decisions_version_idx`   | — (small relations only)                                                                                                                                                                  |   20 |  0.122 ms |              9/0 |
| versionHistory, older page                  | `program_versions_program_number_uq`, `programming_decisions_version_idx`   | — (small relations only)                                                                                                                                                                  |   15 |  0.097 ms |              9/0 |
| affectedNodes: sessions                     | `planned_sessions_lineage_idx`                                              | — (small relations only)                                                                                                                                                                  |  360 |  0.279 ms |             33/0 |
| affectedNodes: exercises                    | `planned_exercises_lineage_idx`                                             | Bitmap Heap Scan planned_exercises, Bitmap Index Scan planned_exercises_lineage_idx                                                                                                       |  600 |  0.828 ms |            475/0 |

**Small tables are read whole by design.** At one owner's scale `exercises` (191 rows, 11 pages),
`planned_sessions` (1,877 rows, 37 pages), `workouts` (1,163 rows, 33 pages), `run_records` and
the program tables fit in a few pages, so the planner scans or hashes them rather than probe an
index, and the Seq Scans of `exercises`, `planned_sessions` and `workouts` in these plans are the
right plan; the size rule is why the gate accepts them.

### Index fixes in m3/33 (#111): before and after

When `db:explain` first ran (m3/33, measured on 2026-11-06 at commit `0ef33bd` with Postgres 18.6
on a local 4-vCPU VM) three plans failed the gate, all on `planned_exercises` (5,868 rows, 79
pages). "Before" is that run with m3/33's query and index commit reverted.

1. **One week's exercises and sets** (`childrenOf` in `queries/programs.ts`, behind
   `sessionsWithChildren`, `versionTree` and `sessionChildren`). Joined to the picked sessions,
   the planner hashed them and read `planned_exercises` whole: the random uuids hide that a
   session's rows sit together. Fixed in the query, with no migration: each child table is probed
   through its parent's index with the parents' ids gathered once (`= any(array(...))`).
2. **History's affected exercises** (`affectedNodes`): no index led with `lineage_id`, so every
   copy of the decisions' exercises was found by a Seq Scan. Migration
   `0016_history_plan_indexes` adds `planned_exercises_lineage_idx`, probed the same way.

| Query                                      | Before (m3/33's base)                                                                                           | After (m3/33)                                                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| sessionsWithChildren, this week: exercises | Seq Scan `planned_exercises` (5,868 rows read for 36), 1.859 ms, 155 buffers                                    | Bitmap Index Scan `planned_exercises_session_position_uq` (36 rows), 0.223 ms, 46 buffers                                  |
| sessionsWithChildren, this week: sets      | Seq Scan `planned_exercises`, then 36 probes of `set_prescriptions_exercise_position_uq`, 1.510 ms, 191 buffers | Bitmap Index Scans `planned_exercises_session_position_uq`, `set_prescriptions_exercise_position_uq`, 0.152 ms, 74 buffers |
| affectedNodes: exercises                   | Seq Scan `planned_exercises` hashed against 48 lineages (5,868 rows read for 96), 2.399 ms, 414 buffers         | Bitmap Index Scan `planned_exercises_lineage_idx` (96 rows), 0.908 ms, 475 buffers                                         |

`affectedNodes: exercises` reads more buffers after (475, of which 372 are 96 probes of the small
`program_version_weeks`) but ran 2.6 times faster, and it reads only the named lineages' copies
rather than the whole table. PR #111 has both plans of each query node by node.

## M2X (desktop) — measured 2026-11-10

The desktop view (PRD §7, §16), measured by CI on main `e93d417` after the last desktop slice
(#265): run
[42737223258](https://github.com/TheCruzControll/performance-coach/actions/runs/42737223258) ran
`pnpm build:node && pnpm budgets` and both Lighthouse commands on GitHub's 4-vCPU Linux runners. Main also carries M3 and the first M4 and M5 screens by then, so these numbers are the
whole app's; each desktop PR records its own before and after.

- **The shell is CSS only.** The rail, the brand mark and the centred column add no JavaScript:
  moving the nav before `<main>` cost +2 B of initial JS on app routes (#113, at most 10 B
  allowed), and every screen's desktop layout is CSS and container queries.
- **The shell's stylesheet stays inlined** into every app page: AppShell is 3,660 of SvelteKit's
  4,096-character `inlineStyleThreshold`, and `pnpm budgets` fails if it is ever linked instead.
  Page-agnostic shell rules go in `src/lib/ui/styles/layout.css`.
- **Security's headroom**: the tightest route when the desktop work was planned (61,295 of
  61,440 B on 2026-11-06) is now 56.8 KB, 3.2 KB under the 60 KB gate, after #85 moved its labels
  and times to the server and the slimmer shared entry. The tightest route is `/(app)/coach/[[thread]]` at 58.5 KB.

Initial JS and route CSS (gzip), every route; all pass, two preloaded fonts each:

| Route                              | Initial JS | Route CSS |
| ---------------------------------- | ---------: | --------: |
| `/(app)/coach/[[thread]]`          |    58.5 KB |   10.4 KB |
| `/(app)/train`                     |    58.2 KB |   11.0 KB |
| `/(app)/train/session/[key]`       |    57.9 KB |   10.6 KB |
| `/(app)/today`                     |    57.9 KB |   13.3 KB |
| `/(app)/progress/workouts/[[id]]`  |    57.7 KB |   10.5 KB |
| `/(app)/profile`                   |    57.0 KB |    9.1 KB |
| `/(app)/profile/security`          |    56.8 KB |   11.3 KB |
| `/(app)/train/history/[[version]]` |    55.8 KB |   10.2 KB |
| `/(app)/profile/[section]`         |    55.3 KB |    7.9 KB |
| `/setup`                           |    54.0 KB |    7.6 KB |
| `/(app)/progress`                  |    53.9 KB |    8.3 KB |
| `/onboarding/[[step]]`             |    53.9 KB |    6.7 KB |
| `/design`                          |    53.6 KB |    7.7 KB |
| `/workout`                         |    53.4 KB |    8.4 KB |
| `/workout/session`                 |    53.4 KB |    8.2 KB |
| `/workout/run`                     |    53.4 KB |    8.2 KB |
| `/(app)/offline`                   |    52.5 KB |    7.0 KB |
| `/`                                |    52.3 KB |    6.5 KB |
| `/recover/passkey`                 |    51.9 KB |    6.1 KB |
| `/recover`                         |    50.9 KB |    6.4 KB |

Lighthouse on the same run, mobile and desktop: see "Lighthouse (desktop)" below.

## M4 (workout) — measured 2026-11-10

Measured by CI on GitHub's 4-vCPU Linux runners. Sizes, the main-thread table, set logging and
INP below are from #370's last run,
[42939723798](https://github.com/TheCruzControll/performance-coach/actions/runs/42939723798)
(`3150095`, green). Its `src/` and `vite.config.ts` are the same as `main` with M4 merged,
including the shorter boot path (#394), the prepaint (#410) and sign-out's flush (#367). The
first M4 measurements, before those changes, came from runs
[42806982845](https://github.com/TheCruzControll/performance-coach/actions/runs/42806982845)
(`pnpm budgets`) and
[42802588785](https://github.com/TheCruzControll/performance-coach/actions/runs/42802588785)
(`perf` and Lighthouse); they are quoted below where they differ.

Initial JS and route CSS (gzip), every route; all pass, one preloaded font each (two before
#394):

| Route                              | Initial JS | Route CSS |
| ---------------------------------- | ---------: | --------: |
| `/(app)/coach/[[thread]]`          |    58.0 KB |   10.1 KB |
| `/(app)/train`                     |    57.3 KB |   11.0 KB |
| `/(app)/train/session/[key]`       |    57.0 KB |   10.7 KB |
| `/(app)/progress`                  |    57.0 KB |   13.9 KB |
| `/(app)/today`                     |    56.9 KB |   13.3 KB |
| `/(app)/progress/workouts/[[id]]`  |    56.8 KB |   10.5 KB |
| `/(app)/progress/reviews/[[key]]`  |    56.6 KB |   10.0 KB |
| `/(app)/profile/security`          |    55.9 KB |   11.4 KB |
| `/(app)/profile`                   |    55.8 KB |    9.1 KB |
| `/(app)/train/history/[[version]]` |    54.6 KB |   10.2 KB |
| `/(app)/progress/exercises/[id]`   |    54.3 KB |   12.9 KB |
| `/(app)/profile/[section]`         |    54.1 KB |    8.0 KB |
| `/workout`                         |    52.7 KB |    7.9 KB |
| `/workout/run`                     |    52.5 KB |    6.3 KB |
| `/workout/session`                 |    52.5 KB |    6.3 KB |
| `/onboarding/[[step]]`             |    52.4 KB |    6.7 KB |
| `/design`                          |    52.4 KB |    7.5 KB |
| `/setup`                           |    52.2 KB |    7.6 KB |
| `/(app)/offline`                   |    51.7 KB |    7.0 KB |
| `/`                                |    50.3 KB |    6.5 KB |
| `/recover/passkey`                 |    50.1 KB |    7.7 KB |
| `/recover`                         |    49.3 KB |    6.4 KB |

Of `/(app)/progress`'s initial JS, 3.8 KB is a chunk its `load` awaits; of
`/(app)/progress/reviews/[[key]]`'s, 2.7 KB.

- **Runways.** The plan's runways held for the workout pages: `/workout` 52.7 KB (runway
  58.9), `/workout/run` and `/workout/session` 52.5 KB (58.0 and 57.5), their CSS 6.3–7.9 KB
  (10). `/(app)/profile/security` is 55.9 KB (58.8). History,
  `/(app)/progress/workouts/[[id]]`, is 56.8 KB, over its 56.0 KB runway but under the 60 KB
  gate. The tightest route is now M5's `/(app)/coach/[[thread]]` at 58.0 KB. In run
  42806982845, before #394, `/workout` was 53.8 KB and `/(app)/progress` the tightest at
  59.7 KB.
- **Icons draw from one SVG sprite** (`<use href="sprite#name">`; `src/lib/ui/icons/sprite.svg`,
  7.3 KB, 1.96 KB gzip, hashed, immutable, precached at install, #90): every route's initial JS
  dropped 1,799–1,805 B (`/design` 1,647 B, which ships the name list). A new icon costs no
  JavaScript, and `pnpm budgets` fails if icon path data reaches a client chunk.
- **One prerendered route per workout kind.** Each page imports only its own view, so each
  kind's whole path is a budgeted row. Two more route nodes cost about 60 B on every route; the
  rejected alternative, a lazy view per kind on one route, measured about 1.0 KB more on the
  strength path in the plan's prototype, because the shared store modules and the view gzip as
  separate chunks.
- **What loads after first render.** `/workout` went from 59.3 KB to 51.4 KB when the
  projection, the route's reducer table, the strength view and the header stopwatch moved into
  chunks fetched while the Shell restores (#249). The store's write path and the sync engine load
  on idle (`online.ts`); the outbox order (`order.ts`, about 0.25 KB) stays out of
  `mutations.ts`; the logger and the prefill rules load right after first render; the set
  editor, every sheet, `CustomExerciseSheet` and each Fix module load on intent. New workout UI that
  is not on the restoring skeleton belongs in a lazy chunk too. The resume bar is one idle import
  from AppShell (at most 0.15 KB on every app route).
- **Prepaint.** /workout paints the current exercise before the app starts, from the card it
  keeps in localStorage (`src/lib/client/workout/prepaint.ts`, `pc:workout-prepaint:v1`, #410).
  The inline script is allowed by its CSP hash and is 1.34 KB gzipped (a unit test caps it at
  1.5 KB). The store drops the copy on every change; a 401 blocks it; sign-out deletes it.
- **Svelte runtime rules.** A runtime feature the app does not already use joins the runtime
  chunk every route loads, so none goes onto a workout page without a measured reason (one
  `$state.snapshot` measured 230 B). In a component that calls `$state()`, a prop named `state`
  compiles `$state` to a store subscription: +0.2 KB on every route in the prototype.
- **Set logging** (`e2e/perf-workout.e2e.ts`, `perf` project, 4× CPU, 20 sets of the shared kit
  fixture with real taps over five fresh loads of `/workout`, with swipes, sheets and the rest
  timer between them): a set shows as done in a median of **36.5 ms, p95 42.4 ms** (gate: p95
  under 100 ms), with no layout shift while logging. Run 42802588785, before #370's fixes,
  measured a median of 22.9 ms and p95 32.5 ms.
- **INP p75** on `/workout`: **88 ms** from Event Timing (loads 80, 88, 96, 88, 56) and 88 ms
  from web-vitals, the library RUM beacons with `route_id` `/workout` (gate: 200 ms or less);
  `/workout/run` 80 ms and `/workout/session` 56 ms. Run 42802588785 measured 56 ms on
  `/workout`. There is no production p75 yet: the pages had no entry point until
  start-entry-points.
- **One green run so far.** These are the numbers of one green run (42939723798). #370 asks for
  two; the second is still to record. Run 42802588785 failed: the final set-logging test on a
  layout shift of 0.00045 while logging, and `/workout/run`'s INP test before measuring. #370
  fixed both.

Main-thread blocking while loading (median of 5 loads, 4× CPU; guard 250 ms, target 200 ms),
from `e2e/perf-workout-load.e2e.ts` with `e2e/load-budget.ts`. Medians in run 42802588785 were
6, 2, 5, 0, 0 and 0 ms:

| Screen                                      | Median | Loads (ms)          |
| ------------------------------------------- | -----: | ------------------- |
| `/workout` (a workout in progress)          |     90 | 76, 82, 90, 98, 220 |
| `/workout/run` (a run in progress)          |     87 | 14, 27, 87, 97, 100 |
| `/workout/session` (a session in progress)  |     12 | 8, 10, 12, 13, 54   |
| `/workout`, a service-worker reload         |      0 | 0, 0, 0, 0, 35      |
| `/progress/workouts` (20 finished workouts) |      9 | 7, 7, 9, 9, 10      |
| `/progress/workouts/<newest>`               |     25 | 21, 23, 25, 25, 27  |

Lighthouse on run 42802588785, with workout data seeded (`--seed`); medians, mobile and desktop:

| Screen                    | Mobile perf | Mobile LCP | Mobile TBT | Desktop perf | Desktop LCP |
| ------------------------- | ----------: | ---------: | ---------: | -----------: | ----------: |
| `/progress/workouts`      |        1.00 |   1,209 ms |      28 ms |         1.00 |      325 ms |
| `/progress/workouts/[id]` |        1.00 |   1,207 ms |      60 ms |         1.00 |      323 ms |
| `/workout · active`       |        0.90 |   3,348 ms |     179 ms |         0.99 |      843 ms |

Accessibility and best practices scored 1.00 on all three. `/workout · active`'s mobile LCP was
over the 2,500 ms gate while its FCP was 756 ms. The page is prerendered with no data, so the
card could only paint once the whole app had started.

Two changes closed the gap: a shorter boot path on every route (#394, below) and the prepaint
(#410, above). Lighthouse on #370's run
[42933643722](https://github.com/TheCruzControll/performance-coach/actions/runs/42933643722)
(`229ab35`, with #410 merged), medians, mobile and desktop:

| Screen                    | Mobile perf | Mobile LCP | Mobile TBT | Desktop perf | Desktop LCP |
| ------------------------- | ----------: | ---------: | ---------: | -----------: | ----------: |
| `/progress/workouts`      |         100 |   1,205 ms |       0 ms |          100 |      468 ms |
| `/progress/workouts/[id]` |         100 |   1,204 ms |      23 ms |          100 |      331 ms |
| `/workout · active`       |         100 |     903 ms |      25 ms |          100 |      244 ms |

`/workout · active` now meets the gate: **LCP 903 ms, Performance 100**, CLS 0.000. Accessibility
and best practices scored 100 on all three. #370's final run (42939723798) measured 905 ms and
Performance 99 on the same screen.

## Budgets (enforced)

`pnpm budgets` (`scripts/check-budgets.ts`) reads the SvelteKit build output and fails CI when a
budget is exceeded. "Initial JS" (gzip level 9) is everything the browser must load before the
route is interactive:

- the **complete static import graph** of the app entry and the route's layout and page nodes,
  read from Vite's manifest. SvelteKit's own modulepreload list can miss a chunk that is also
  reachable through a dynamic import (its `find_deps` marks it seen on the dynamic path first);
  the browser then fetches it late, after the chunk that imports it. The report lists such
  chunks, and they count towards the budget either way;
- plus the **largest dynamic import a universal `load` (`+page.ts` / `+layout.ts`) awaits**: the
  page cannot hydrate before it arrives, so lazy-loading a screen's body this way does not take
  it out of the budget (column "of which awaited by `load`"). The script finds these imports
  with a regular expression over the load file's own source, so it sees only a string-literal
  relative path that names the real file (`import('./Body.svelte')`); an aliased (`#lib/…`),
  computed or extension-less specifier, or an import made in a module the load calls, is not
  counted. Write load-awaited imports in that form.

| Budget               | Limit            | Why                                                                  |
| -------------------- | ---------------- | -------------------------------------------------------------------- |
| Initial JS per route | **≤ 60 KB gzip** | parse/compile/hydrate cost on a mid-range phone; ~37 KB is framework |
| CSS per route        | **≤ 14 KB gzip** | render-blocking: the stylesheets the route renders with              |
| Preloaded font files | **≤ 2**          | preloads compete with critical requests                              |
| Main-thread blocking | **≤ 200 ms**     | target per screen while loading, 4× CPU; CI fails above 250 ms       |

The CSS budget was a whole-build total (≤ 20 KB) until M2's onboarding. A total counts every
screen's and every on-demand sheet's styles at once, although no route loads them together;
it grew with each screen (19.6 KB of 20 after passkey auth) and would have forced styles out of
components for no gain to any single page load. The render-blocking cost is per route, so that
is what is budgeted now: 14 KB is ~2 KB above the heaviest route when the change was made
(`/design`, 11.7 KB). The report still prints the whole-build total for tracking.

The desktop shell (rail, brand mark, centred column) is CSS only: moving the nav before `<main>`
costs at most 10 B of initial JS on app routes (measured +2 B), and AppShell's stylesheet stays
inlined into every app page (3,660 of 4,096 characters; `pnpm budgets` fails if it is ever linked
instead).

The same script also guards the CSS output: every built rule that ships a `-webkit-` property must
ship the standard one too (see the glass note in `docs/design-system.md`). It also checks:

- the **root error page** (`src/routes/+error.svelte`), which SvelteKit imports before every
  hydration, may add only its own chunk: no script or stylesheet a route does not already load
  (its content loads on demand: `src/routes/error-page.ts`, #394). The start entry must import
  exactly one chunk, `payload`, which imports nothing.

### Measured (`pnpm build && pnpm budgets`)

Before and after the slimmer shared entry (2026-11-07). Before is main at that date.

| Route                              | Initial JS before | Initial JS after | Route CSS after | Preloaded fonts |
| ---------------------------------- | ----------------: | ---------------: | --------------: | --------------: |
| `/(app)/today`                     |           59.6 KB |          57.6 KB |         10.1 KB |               2 |
| `/(app)/train`                     |           59.2 KB |          57.2 KB |         13.5 KB |               2 |
| `/(app)/train/session/[key]`       |           58.8 KB |          56.1 KB |          9.6 KB |               2 |
| `/workout`                         |           58.7 KB |          56.7 KB |          6.5 KB |               2 |
| `/(app)/profile/security`          |           58.5 KB |          55.8 KB |         11.0 KB |               2 |
| `/(app)/profile`                   |           57.6 KB |          55.6 KB |          8.6 KB |               2 |
| `/(app)/train/history/[[version]]` |           57.1 KB |          54.4 KB |          9.7 KB |               2 |
| `/setup`                           |           55.7 KB |          53.0 KB |          7.3 KB |               2 |
| `/onboarding/[[step]]`             |           55.4 KB |          52.7 KB |          6.1 KB |               2 |
| `/(app)/profile/[section]`         |           55.3 KB |          52.6 KB |          6.9 KB |               2 |
| `/design`                          |           55.0 KB |          52.2 KB |          7.3 KB |               2 |
| `/`                                |           54.0 KB |          51.3 KB |          6.1 KB |               2 |
| `/(app)/progress`                  |           53.9 KB |          51.9 KB |          7.4 KB |               2 |
| `/(app)/offline`                   |           53.9 KB |          51.2 KB |          6.7 KB |               2 |
| `/recover/passkey`                 |           53.6 KB |          50.9 KB |          5.8 KB |               2 |
| `/recover`                         |           52.6 KB |          49.9 KB |          6.1 KB |               2 |
| `/(app)/coach`                     |           51.9 KB |          49.2 KB |          6.6 KB |               2 |

The JS every route loads (the app entry, the root layout and what they import) went from
47.7 KB to 44.5 KB. Of what is left, the Svelte runtime (18.9 KB), the SvelteKit client
(16.9 KB) and its router (entry, route table and routing, 4.3 KB) are framework. The app's own
share is error reporting (0.7 KB, needed before anything else runs), the toasts (`Toaster`) and
the record of screens shown for RUM. The toasts stay in the initial JS so that none waits on the
network: loaded on demand (0.8 KB), a toast shown offline had no code, and a module fetch that
fails stays failed for the page's life. Keeping a plain-text stand-in and retrying online cost
every route 0.1 KB more than the toasts themselves. They slide with CSS animations, not
`svelte/transition`: its runtime sat in the Svelte chunk of every route for this one component
(1.1 KB). These moved out of the initial JS:

- **RUM** (`vitals.ts`), now imported when it starts on idle. The root layout keeps only
  `visits.ts`, which records each screen for attribution.
- **Preferences** (`preferences.svelte.ts`). The theme is applied by `src/app.html` before
  paint, so the root layout loads the module after mount (`preferences-start.ts`) and only the
  screens that show a unit have it up front, and load the saved units on mount themselves: this
  step costs those four routes nothing.

Deleting all of the root layout's and the client hooks' own code takes 5.5 KB off the shared JS
and 3.6 KB off `/(app)/today` (measured, not shipped): that is the ceiling for the app's code.
The rest is framework, and the router's modulepreload hints (vite.config.ts) stay.
Fonts: only Mona Sans latin (39.8 KB) is preloaded (`src/lib/ui/fonts.ts`); Hubot Sans latin
(48.3 KB) loads when a heading uses it. One preloaded font per route (#394). Both are woff2 and
cached immutably.

Start-up chunks: three Rolldown groups in `vite.config.ts` (#394). `payload` comes first
(SvelteKit's `client/payload.js` and the preload helper), then `framework` (Svelte, SvelteKit's
client without `$app/forms` or its entries, devalue, clsx), then `boot` (errors, leaving, visits,
service-worker, toast, Icon, error-page). They merge code that (nearly) every page loads and cut
about 10 requests from every route's start-up (/workout: 25 to 14 boot scripts); the budgets
bound any helper that rides along.

Service-worker install download (precache, measured in Chromium in review round 1): **74 files,
353 KB** decoded. Home-screen icons are excluded; the OS fetches them once at install.

### Headroom and the M4 workout-screen plan

The tightest route was `/train` at 55.5 KB of 60 KB (4.5 KB headroom) when this plan was made;
it is now `/(app)/today` at 57.6 KB (table above). The M4 workout screen will be the heaviest
screen in the app. Plan, agreed before any M4 code lands:

- The workout route gets the same **60 KB** initial-JS budget. Only the logging path (current
  exercise, set rows, the stepper, the optimistic log action) ships up front.
- Everything opened on demand is code-split behind intent, as the plate calculator already is:
  plate calculator, substitution sheet, rest-timer settings, history, notes.
- IndexedDB/outbox code (M4 offline store) loads after first render (`requestIdleCallback`), not
  in the hydration path.
- Guards: `pnpm budgets` (size), `e2e/perf-workout-load.e2e.ts` for the workout screens (main-thread
  ≤ 200 ms at 4× CPU), M4 criterion 3 (< 100 ms to visual confirmation of a logged set) and INP
  p75 ≤ 200 ms on that `route_id` from RUM.
- If the shell itself must grow, raise the budget only with a measured reason in this file.
- `/workout` measured 58.7 KB after the workout shell, against 53.8 KB planned. The slimmer
  shared entry (table above) took it to 56.7 KB, so the later workout slices have 3.3 KB, not
  1.3 KB, under the 60 KB gate.
- Outcome: `/workout` ended M4 at 52.7 KB with its screens merged, the boot path and the
  prepaint (see "M4 (workout)" above).

### Main-thread budget (`e2e/load-budget.ts`, runs in CI on its own leg)

`e2e/load-budget.ts` holds the page-load budget. `e2e/perf.e2e.ts` applies it to the app's
screens and `e2e/perf-workout-load.e2e.ts` to the workout screens. Both run in their own
Playwright project (`perf`, one worker) that starts only after the functional Chromium suite has
finished, so no other spec competes for CPU while it measures. In CI the project is its own leg,
alone·chromium, split in 2 shards, each on a runner of its own; `exclusive` runs in parallel on
a leg of its own (only a local run starts it after `perf`). On a busy
host (other builds, browsers or agents running) local numbers can still be noisy; re-run before
chasing a regression.

Real long tasks (PerformanceObserver) while each screen loads and hydrates, DevTools **4× CPU
throttling**, iPhone 15 Pro viewport, cold context: blocking time = Σ (task − 50 ms) over
load + 1.5 s, **median of 5 loads**. Two thresholds:

- **Target ≤ 200 ms** (Lighthouse's "good" TBT): every run reports each screen's median against
  it in the test annotations.
- **Guard ≤ 250 ms** fails the build. It is a regression guard, set above today's medians so
  scheduler noise on a shared CI VM cannot fail it. Lower it as screens get cheaper; raise it
  only with a measured reason recorded here.

Measured after the perf project was isolated (two consecutive `--project=perf` runs, 4-vCPU VM):

| Screen       |                 `/` |               `/today` |              `/train` |           `/progress` |             `/coach` |             `/profile` |
| ------------ | ------------------: | ---------------------: | --------------------: | --------------------: | -------------------: | ---------------------: |
| Run 1 median |                  60 |                    111 |                   113 |                   110 |                   68 |                    120 |
| Run 1 loads  | 20, 30, 60, 86, 130 | 67, 105, 111, 159, 161 | 88, 91, 113, 114, 163 | 51, 95, 110, 124, 125 | 48, 65, 68, 118, 136 | 75, 101, 120, 184, 240 |
| Run 2 median |                  76 |                    135 |                    71 |                    81 |                   43 |                    107 |
| Run 2 loads  | 61, 75, 76, 80, 114 | 80, 132, 135, 148, 194 |   53, 69, 71, 86, 138 |  56, 58, 81, 101, 189 |   13, 38, 43, 47, 56 |  82, 83, 107, 113, 119 |

This measures the actual work (navigation commit, parse, first layout, hydration) instead of
Lighthouse's simulated timeline. Single loads vary a lot on a shared VM (a separate 10-load
sample of `/profile` ranged 126–256 ms, median 174 ms, while other processes were busy), which is
why the guard uses a median of five and sits above the target. With a median of three and the
guard at 200 ms, `/profile` failed about one run in six on noise alone.

## Lighthouse (mobile)

Command (exactly what CI runs): `pnpm build:node && pnpm lighthouse --runs 5 --assert --min-perf
0.9 --max-tbt 300` — every app screen, median of 5, a **fresh browser per run**.

- Lighthouse **13.6.0**, Chrome **153.0.8010.12** (Playwright build, `--headless=new`), default
  mobile config: 412×823 @1.75x, simulated throttling (150 ms RTT, 1.6 Mbps, **4× CPU**).
- Target: local production Node server (`node build/index.js`, adapter-node) + local Postgres.
  adapter-node does **not** compress HTML (Vercel does), so transfer sizes here are pessimistic.
- Host: 4-vCPU Linux VM; Lighthouse `benchmarkIndex` varied **1246–2248** between runs.
- Result: `lighthouse: all thresholds met` (exit 0).

**Median of 5 runs per route:**

| Route       | Perf | A11y | Best practices |    LCP |    FCP |    TBT |   CLS | Speed Index |
| ----------- | ---: | ---: | -------------: | -----: | -----: | -----: | ----: | ----------: |
| `/`         |   99 |  100 |            100 | 905 ms | 905 ms | 103 ms | 0.000 |      905 ms |
| `/today`    |  100 |  100 |            100 | 906 ms | 906 ms |  47 ms | 0.000 |      966 ms |
| `/train`    |   99 |  100 |            100 | 904 ms | 904 ms |  92 ms | 0.000 |      904 ms |
| `/progress` |   99 |  100 |            100 | 908 ms | 908 ms |  97 ms | 0.000 |      908 ms |
| `/coach`    |  100 |  100 |            100 | 907 ms | 907 ms |  80 ms | 0.000 |      907 ms |
| `/profile`  |   99 |  100 |            100 | 905 ms | 905 ms |  98 ms | 0.000 |     1020 ms |

**Run-to-run spread (all 5 runs):**

| Route       | Perf scores         | TBT (ms)              | LCP (ms) |
| ----------- | ------------------- | --------------------- | -------- |
| `/`         | 99,100,99,100,99    | 146, 40, 115, 63, 103 | 901–909  |
| `/today`    | 100,100,100,100,100 | 60, 45, 29, 88, 47    | 903–918  |
| `/train`    | 100,99,99,99,100    | 24, 92, 100, 93, 70   | 902–906  |
| `/progress` | 99,98,99,100,100    | 140, 173, 97, 89, 74  | 902–912  |
| `/coach`    | 100,100,99,100,99   | 80, 62, 94, 16, 92    | 902–907  |
| `/profile`  | 99,100,100,96,99    | 98, 78, 32, 216, 98   | 901–906  |

Total page weight (incl. fonts): 169–196 KB transfer per route. A second 5-run batch of the same
build just before this one gave medians of perf 99–100 and TBT 44–118 ms, with one `/progress`
run at LCP 2558 ms (median 906 ms).

### The bimodal "Unattributable" task (investigated in review round 2)

Review round 1 measured simulated TBT of 230–560 ms at the median on most screens, from one
early task that Lighthouse reports as "Unattributable" and that was either ~60–70 ms or
~450–750 ms (simulated) from run to run. With the old runner (one browser reused for every run)
this build reproduced it: per-run TBT up to 635 ms, perf 84–100. Findings:

- **It is not app work.** In 12 traced Lighthouse runs (`/today`, `/train`, one reused browser;
  renderer main thread of the audited page), the longest task usually ran **before our HTML was
  parsed**: 26–60 ms observed (Lighthouse multiplies observed CPU time by 4) containing almost
  no traced events beyond V8 teardown (`V8.DeoptimizeCode`, GC sweeping) and
  `DocumentLoader::~DocumentLoader`, i.e. the previous run's page being torn down on the same
  renderer thread; it tended to grow as runs accumulated. The inline CSS and the `BrandMark` SVG
  are not in it (they run later, in `ParseHTML`/`UpdateLayoutTree`/`Layout`: 16–45 ms observed
  in total). None of those 12 runs hit the worst case (450–750 ms simulated), so that extreme
  was not traced directly; it disappeared with the fix below.
- A script-free control page served by `python -m http.server` showed the same "other" work
  (90–327 ms simulated) under the same runner, but no TBT because its FCP came first.
- **Fix (measurement, not the app):** `scripts/lighthouse.ts` now launches a fresh browser for
  every run, as Lighthouse CI does, which is also what a real first visit looks like. A run that
  Lighthouse itself reports as broken (`NO_NAVSTART`, seen twice in the first 30 fresh-browser
  runs, none in the 30 above) is repeated instead of being counted as a score of 0. With this, every one of
  the 30 runs above has perf ≥ 96 and TBT ≤ 216 ms.

### Reading these numbers honestly

- **LCP (~0.9 s) and CLS (0.000) are stable and well inside "good"** on every run.
- **Simulated TBT now meets its 200 ms target at the median on every screen (47–103 ms)**; one
  individual run of 30 exceeded it (`/profile`, 216 ms). It is still a ×4 simulation of observed
  task time on a shared VM, so individual runs vary by ±100 ms.
- **Performance score ≥ 90 is met on every run** (96–100).
- The first-round numbers (TBT medians up to 458 ms, `/train` perf 89) were dominated by the
  runner artifact above; the app changed little in between (hydration work was already cut in
  round 1). We therefore do not claim a large real-world speed-up, only a trustworthy
  measurement.
- Lighthouse's 4× CPU throttle models a mid-range Android phone, much slower than a current
  iPhone. What counts in the end is RUM p75 from the owner's device (below), which starts when
  the app is deployed.

## Lighthouse (desktop)

Command (what CI runs after the mobile run, as a step that never fails the job):
`pnpm build:node && pnpm lighthouse --desktop --seed --runs 3 --assert`. It audits the mobile
run's screens with Lighthouse's desktop preset (desktop throttling, no CPU slowdown) at
1440 × 900 and 1x (`scripts/lib/lighthouse-config.ts`), applies the same `--assert` thresholds and
writes to `lighthouse-reports/desktop`. Measured by CI on main `e93d417` (run 42737223258,
Lighthouse 13.6.0, Chrome 153.0.8010.12), beside that run's mobile numbers (the command under
"Lighthouse (mobile)"). Both stop a route early once its runs decide every threshold, here after
2 to 4 runs; every threshold was met. Accessibility and best practices scored 100 on every screen
in both runs.

| Screen                 | Desktop perf |    LCP |  TBT |   CLS | Mobile perf |     LCP |   TBT |
| ---------------------- | -----------: | -----: | ---: | ----: | ----------: | ------: | ----: |
| `/`                    |          100 | 251 ms | 0 ms | 0.000 |         100 |  907 ms | 22 ms |
| `/today · build card`  |          100 | 325 ms | 0 ms | 0.000 |         100 | 1205 ms |  0 ms |
| `/train`               |          100 | 286 ms | 0 ms | 0.000 |         100 | 1055 ms |  1 ms |
| `/progress`            |          100 | 246 ms | 0 ms | 0.000 |         100 |  903 ms |  6 ms |
| `/coach`               |          100 | 246 ms | 0 ms | 0.000 |         100 |  905 ms |  3 ms |
| `/profile`             |          100 | 284 ms | 0 ms | 0.000 |         100 | 1055 ms |  5 ms |
| `/profile/security`    |          100 | 245 ms | 0 ms | 0.000 |         100 |  904 ms |  8 ms |
| `/today · program`     |          100 | 324 ms | 0 ms | 0.000 |         100 | 1205 ms |  0 ms |
| `/train · program`     |          100 | 285 ms | 0 ms | 0.000 |         100 | 1054 ms | 28 ms |
| `/train/session/[key]` |          100 | 324 ms | 0 ms | 0.000 |         100 | 1203 ms | 29 ms |
| `/train/history`       |          100 | 454 ms | 0 ms | 0.000 |         100 | 1054 ms |  0 ms |

Desktop LCP is 245–454 ms with no blocking time; mobile LCP is 903–1205 ms with TBT at most 29 ms.

## Targets

| Metric                    | Target (lab)                  | Target (field, RUM p75) | M1 status                                                               |
| ------------------------- | ----------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| LCP                       | ≤ 2.5 s (Lighthouse mobile)   | ≤ 2.5 s                 | **met** (0.9 s median; 1 outlier run of 60 at 2.56 s)                   |
| CLS                       | ≤ 0.1                         | ≤ 0.1                   | **met** (0.000)                                                         |
| TBT (Lighthouse, sim.)    | ≤ 200 ms                      | —                       | **met** at the median on all 6 screens (47–103 ms); 1 of 30 runs 216 ms |
| Main-thread blocking      | ≤ 200 ms (4× CPU, real tasks) | —                       | **met** on all 6 screens (median 43–135 ms, 5 loads)                    |
| INP                       | —                             | ≤ 200 ms                | no field data yet                                                       |
| Performance score         | ≥ 90                          | —                       | **met** on every run (96–100; medians 99–100)                           |
| Initial JS / CSS / fonts  | budgets above                 | —                       | **met** (tightest: `/train` 55.5 / 60 KB)                               |
| API latency `/api/health` | ≤ 50 ms server time           | p75 from logs           | local: cold 11.9 ms, warm 1.2–1.9 ms incl. DB round-trip (round 1)      |

CI runs the main-thread budget (with the e2e suite) as the **tight regression guard**, plus
`pnpm lighthouse --runs 5 --assert --min-perf 0.9 --max-tbt 300` on **every app screen**
(including the streamed, DB-backed `/profile`) as the Lighthouse check: the score target itself,
and TBT with 50% headroom for shared-runner noise. On GitHub's runners (CI run
[42148399101](https://github.com/TheCruzControll/performance-coach/actions/runs/42148399101),
`main` at `47ec0cd`) the 5-run medians on all 7 routes were perf, accessibility and best practices
100, LCP 0.91 s, TBT 8–35 ms and CLS 0.000; if their noise changes, adjust with numbers, not by
dropping routes.

## Real-user monitoring

- `web-vitals` 6 is lazy-loaded after hydration (`requestIdleCallback`) and reports LCP, INP, CLS,
  TTFB and FCP via `navigator.sendBeacon` when the page is hidden → `POST /api/vitals` →
  `web_vitals` (100% sampled; one user).
- **Attribution:** each row stores the `path` and SvelteKit `route_id` of the screen where the
  metric happened. The root layout records every client-side navigation; INP goes to the screen
  showing when its interaction started, CLS to the screen of its largest shift, and the load
  metrics (TTFB, FCP, LCP) to the landing page. Per-screen p75 (e.g. the M4 workout screen's INP)
  therefore groups by `route_id` (indexed). Covered by unit tests and an e2e test that navigates
  client-side and checks where INP lands.
- The Profile screen shows p75 per metric for the last 7 days. Field data begins when the owner
  starts using the deployed app.

## Server timing

Every dynamic response carries `Server-Timing` (`db;dur=…;desc="n ops"`, `total;dur=…`) and an
`x-request-id`. Both the header and the access log's `durationMs` are measured when the response
**starts**. Work a load streams afterwards (Profile's health check and p75 summary) is not in
them; it gets its own `streamed work settled` log line with the request's full duration and its
`db` time, and a streamed failure is logged and recorded in `app_errors` (`kind: streamed`).

Measured against the local production server just after start (sequential requests):

```
GET /api/health  #1    server-timing: db;dur=10.8;desc="1 op", total;dur=11.9   (pool connects)
GET /api/health  #2–8  db 0.9–1.5 ms, total 1.2–1.9 ms
GET /today       #1–3  total 1.4–1.9 ms
GET /profile           total ≈ 38 ms at first byte; streamed work settled ≈ 67 ms (db 2 ops)
```

## How to reproduce

```sh
ORIGIN=http://localhost:4174 pnpm build:node   # the origin is baked into Node builds
pnpm budgets
E2E_PERF_ALONE=1 pnpm test:e2e --project=perf  # owner setup, then the main-thread budget alone
pnpm lighthouse --runs 5 --assert --min-perf 0.9 --max-tbt 300  # every screen (CI command)
pnpm lighthouse --desktop --seed --runs 3 --assert  # the same screens at 1440 × 900 (CI, not gating)
```
