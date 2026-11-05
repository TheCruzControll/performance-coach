# Performance

Performance is a first-class requirement (PRD §15): measure, set budgets, enforce them, and record
**real** numbers only. Everything below was measured locally on 2026-11-05 against the production
build of commit `b10bafc` (M1 after review fix round 1; later commits touch only docs, CI and
tests).

## Budgets (enforced)

`pnpm budgets` (`scripts/check-budgets.ts`) reads the SvelteKit build output and fails CI when a
budget is exceeded. "Initial JS" is exactly the set SvelteKit modulepreloads for a route: the app
entry plus every layout and page node of the route and their static imports (gzip level 9).

| Budget                  | Limit            | Why                                                                  |
| ----------------------- | ---------------- | -------------------------------------------------------------------- |
| Initial JS per route    | **≤ 60 KB gzip** | parse/compile/hydrate cost on a mid-range phone; ~35 KB is framework |
| Total CSS (whole build) | **≤ 20 KB gzip** | render-blocking; tokens + all components                             |
| Preloaded font files    | **≤ 2**          | preloads compete with critical requests                              |
| Main-thread blocking    | **≤ 200 ms**     | per screen while loading, 4× CPU (see below)                         |

The same script also guards the CSS output: every built rule that ships a `-webkit-` property must
ship the standard one too (see the glass note in `docs/design-system.md`).

### Measured (`pnpm build:node && pnpm budgets`)

| Route             | Initial JS (gzip) | Route CSS (gzip) | Preloaded fonts |
| ----------------- | ----------------: | ---------------: | --------------: |
| `/design`         |           57.2 KB |           9.3 KB |               2 |
| `/(app)/train`    |           54.0 KB |          10.4 KB |               2 |
| `/(app)/profile`  |           52.3 KB |           7.0 KB |               2 |
| `/(app)/today`    |           51.5 KB |           6.8 KB |               2 |
| `/(app)/progress` |           51.1 KB |           6.3 KB |               2 |
| `/(app)/offline`  |           50.9 KB |           6.1 KB |               2 |
| `/(app)/coach`    |           49.7 KB |           6.0 KB |               2 |
| `/`               |           48.1 KB |           4.7 KB |               2 |

Total CSS: **15.3 KB gzip** (23 files). Service worker: 1.6 KB gzip. Of the initial JS, the
Svelte runtime (~19.7 KB) and the SvelteKit client (~15.9 KB) are shared by every route. The app
shell (connectivity notice, client error hook, RUM navigation tracking) added ~2 KB per app route
in review round 1.
Fonts: Mona Sans latin 39.8 KB + Hubot Sans latin 48.3 KB (woff2, preloaded, cached immutably).

Service-worker install download (precache, measured in Chromium): **74 files, 353 KB** decoded.
Home-screen icons are excluded; the OS fetches them once at install.

### Main-thread budget (`e2e/perf.e2e.ts`, runs in CI with the e2e suite)

Real long tasks (PerformanceObserver) while each screen loads and hydrates, DevTools **4× CPU
throttling**, iPhone 15 Pro viewport, cold context: blocking time = Σ (task − 50 ms) over
load + 1.5 s, **median of 3 loads**, budget **≤ 200 ms**.

| Screen      |        `/` |     `/today` |   `/train` | `/progress` |    `/coach` | `/profile` |
| ----------- | ---------: | -----------: | ---------: | ----------: | ----------: | ---------: |
| Median (ms) |         48 |          119 |         74 |          39 |          47 |         90 |
| Runs (ms)   | 20, 48, 53 | 52, 119, 135 | 67, 74, 86 |  19, 39, 93 | 32, 47, 171 | 79, 90, 93 |

This measures the actual work (navigation commit, parse, first layout, hydration) instead of
Lighthouse's simulated timeline, which is why it is the tight regression guard.

## Lighthouse (mobile)

Command: `pnpm build:node && pnpm lighthouse --runs 5 --routes /,/today,/train,/profile`

- Lighthouse **13.6.0**, Chrome **153.0.8010.12** (Playwright build, `--headless=new`), default
  mobile config: 412×823 @1.75x, simulated throttling (150 ms RTT, 1.6 Mbps, **4× CPU**).
- Target: local production Node server (`node build/index.js`, adapter-node) + local Postgres.
  adapter-node does **not** compress HTML (Vercel does), so transfer sizes here are pessimistic.
- Host: 4-vCPU Linux VM; Lighthouse `benchmarkIndex` varied **1440–2138** between runs.

**Median of 5 runs per route:**

| Route      | Perf | A11y | Best practices |    LCP |    FCP |    TBT |   CLS | Speed Index |
| ---------- | ---: | ---: | -------------: | -----: | -----: | -----: | ----: | ----------: |
| `/`        |   96 |  100 |            100 | 910 ms | 910 ms | 231 ms | 0.000 |      913 ms |
| `/today`   |  100 |  100 |            100 | 908 ms | 908 ms |   6 ms | 0.000 |     1119 ms |
| `/train`   |   89 |  100 |            100 | 907 ms | 907 ms | 458 ms | 0.000 |      980 ms |
| `/profile` |   94 |  100 |            100 | 908 ms | 908 ms | 295 ms | 0.000 |     1144 ms |

**Run-to-run spread (all 5 runs):**

| Route      | Perf scores         | TBT (ms)                | LCP (ms) |
| ---------- | ------------------- | ----------------------- | -------- |
| `/`        | 100,96,93,100,89    | 36, 231, 336, 36, 431   | 907–913  |
| `/today`   | 100,100,100,100,100 | 6, 2, 29, 0, 29         | 902–916  |
| `/train`   | 89,88,91,85,93      | 458, 471, 374, 576, 326 | 906–920  |
| `/profile` | 94,94,92,94,92      | 280, 284, 364, 295, 339 | 904–911  |

Total page weight (incl. fonts): 168–192 KB transfer per route.

Previous baseline (commit `cb0f2a0`, same command): TBT medians `/` 49, `/today` 280,
`/train` 340, `/profile` 301 ms; perf 100 / 94 / 92 / 93.

### Reading these numbers honestly

- **LCP (~0.91 s) and CLS (0.000) are stable and well inside "good"** on every run.
- **Simulated TBT misses its 200 ms target at the median on `/`, `/train` and `/profile`**
  (231–458 ms) and meets it on `/today` (6 ms). It is noisy and bimodal. The extra blocking comes
  from one early task (navigation commit, HTML parse and first style/layout) that Lighthouse
  reports as "Unattributable" and simulates at 450–560 ms. Whether it ends after the simulated
  First Contentful Paint decides whether it counts. The same screens traced with DevTools 4×
  throttling show that task at ~100 ms, and real blocking of 39–119 ms median (table above).
  Compared with the previous baseline, `/today` improved and `/train` got worse at the median.
  Under real 4× throttling `/train` and `/today` cost about the same, so we read this as
  simulation and VM noise rather than as a change in page work. That remains a claim to re-check
  on real hardware.
- **Performance score ≥ 90 is met at the median on 3 of 4 routes; `/train` is 89** (runs 85–93).
  The review's own 3-run medians on the previous build were 88 (`/profile`) and 90 (`/today`).
  The score target is therefore **not reliably met** yet.
- What was already done (measured with CPU profiles and traces during M1): removed `Intl`
  formatter construction from hydration paths (~15–20 ms each), code-split the plate calculator,
  mounted bottom-sheet content only while open.
- Next steps (M8 performance council): reduce the first layout and per-route hydration (fewer
  nodes above the fold, lighter shell), evaluate HTML compression in the local server for
  representative transfer sizes, and confirm on real iPhone hardware + RUM p75 (Lighthouse's 4×
  CPU throttle models a mid-range Android, much slower than a current iPhone).

## Targets

| Metric                    | Target (lab)                  | Target (field, RUM p75) | M1 status                                                                  |
| ------------------------- | ----------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| LCP                       | ≤ 2.5 s (Lighthouse mobile)   | ≤ 2.5 s                 | **met** (0.91 s median, every run)                                         |
| CLS                       | ≤ 0.1                         | ≤ 0.1                   | **met** (0.000)                                                            |
| TBT (Lighthouse, sim.)    | ≤ 200 ms                      | —                       | **not met** on 3/4 routes at median (231–458 ms); `/today` 6 ms            |
| Main-thread blocking      | ≤ 200 ms (4× CPU, real tasks) | —                       | **met** on all 6 screens (median 39–119 ms)                                |
| INP                       | —                             | ≤ 200 ms                | no field data yet                                                          |
| Performance score         | ≥ 90                          | —                       | **not reliably met**: medians 89–100 (`/train` 89), individual runs 85–100 |
| Initial JS / CSS / fonts  | budgets above                 | —                       | **met**                                                                    |
| API latency `/api/health` | ≤ 50 ms server time           | p75 from logs           | local: cold 11.9 ms, warm 1.2–1.9 ms incl. DB round-trip                   |

CI runs the main-thread budget (with the e2e suite) as the **tight regression guard**, plus
`pnpm lighthouse --runs 5 --assert --min-perf 0.85 --max-tbt 600` as a coarser Lighthouse check.
The local medians above clear both thresholds with margin; the previous CI setting (3 runs,
TBT ≤ 800 ms) would have let a hydration regression of several hundred ms through.

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
pnpm build:node
pnpm budgets
E2E_SKIP_BUILD=1 pnpm test:e2e e2e/perf.e2e.ts               # main-thread budget (annotations)
pnpm lighthouse --runs 5 --routes /,/today,/train,/profile   # reports in lighthouse-reports/
```
