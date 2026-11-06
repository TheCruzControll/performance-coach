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
- **Main-thread budget** (`E2E_PERF_ALONE=1 pnpm test:e2e --project=perf`, median of 5 loads at 4×
  CPU; app screens signed in, `/` signed out): `/` 57 ms, `/today` 81, `/train` 72, `/progress`
  67, `/coach` 40, `/profile` 87, `/profile/security` 60 — every screen meets the 200 ms target.
- **Lighthouse, one run per screen** (signed in via a session the script mints; `/` signed out):
  perf 98–100, accessibility 100, best practices 100, CLS 0.000 everywhere; `/profile/security`
  LCP 1.07 s, TBT 103–153 ms. A single run is not a median: the 5-run CI assertion is the gate.
- **Server:** every dynamic request now does one indexed session lookup, reported as
  `Server-Timing: auth;dur=…`.

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

The same script also guards the CSS output: every built rule that ships a `-webkit-` property must
ship the standard one too (see the glass note in `docs/design-system.md`).

### Measured (`pnpm build:node && pnpm budgets`)

| Route             | Initial JS (gzip) | Route CSS (gzip) | Preloaded fonts |
| ----------------- | ----------------: | ---------------: | --------------: |
| `/(app)/train`    |           55.5 KB |          10.4 KB |               2 |
| `/(app)/profile`  |           54.5 KB |           7.8 KB |               2 |
| `/(app)/today`    |           53.6 KB |           7.4 KB |               2 |
| `/design`         |           53.5 KB |          11.6 KB |               2 |
| `/(app)/progress` |           52.6 KB |           6.7 KB |               2 |
| `/(app)/offline`  |           51.8 KB |           6.1 KB |               2 |
| `/(app)/coach`    |           50.6 KB |           6.0 KB |               2 |
| `/`               |           49.0 KB |           4.7 KB |               2 |

Total CSS: **16.6 KB gzip** (30 files). Service worker: 1.8 KB gzip. Of the initial JS, the
Svelte runtime (~19.7 KB) and the SvelteKit client (~15.9 KB) are shared by every route.
Review round 2 added ~0.7 KB per route (browser error reporting, in every page) and ~0.8–1.4 KB
on the app screens (the shared `Stat`/`Badge`/`Chip`/`ListRow`/`Section` primitives). `/design`
went down from 57.2 KB: its Inputs, Data and Feedback groups now load when their tab opens.
Fonts: Mona Sans latin 39.8 KB + Hubot Sans latin 48.3 KB (woff2, preloaded, cached immutably).

Service-worker install download (precache, measured in Chromium in review round 1): **74 files,
353 KB** decoded. Home-screen icons are excluded; the OS fetches them once at install.

### Headroom and the M4 workout-screen plan

The tightest route is `/train` at 55.5 KB of 60 KB (4.5 KB headroom); the M4 workout screen will
be the heaviest screen in the app. Plan, agreed before any M4 code lands:

- The workout route gets the same **60 KB** initial-JS budget. Only the logging path (current
  exercise, set rows, the stepper, the optimistic log action) ships up front.
- Everything opened on demand is code-split behind intent, as the plate calculator already is:
  plate calculator, substitution sheet, rest-timer settings, history, notes.
- IndexedDB/outbox code (M4 offline store) loads after first render (`requestIdleCallback`), not
  in the hydration path.
- Guards: `pnpm budgets` (size), `e2e/perf.e2e.ts` gains the workout screen (main-thread
  ≤ 200 ms at 4× CPU), M4 criterion 3 (< 100 ms to visual confirmation of a logged set) and INP
  p75 ≤ 200 ms on that `route_id` from RUM.
- If the shell itself must grow, raise the budget only with a measured reason in this file.

### Main-thread budget (`e2e/perf.e2e.ts`, runs in CI with the e2e suite)

It is its own Playwright project (`perf`, one worker) that starts only after the functional
Chromium suite has finished, so no other spec competes for CPU while it measures. On a busy
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
```
