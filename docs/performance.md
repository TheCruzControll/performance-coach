# Performance

Performance is a first-class requirement (PRD §15): measure, set budgets, enforce them, and record
**real** numbers only. Everything below was measured locally on 2026-11-05 at commit `cb0f2a0`
(app code identical to the final M1 commit; later commits only touched docs/CI).

## Budgets (enforced)

`pnpm budgets` (`scripts/check-budgets.ts`) reads the SvelteKit build output and fails CI when a
budget is exceeded. "Initial JS" is exactly the set SvelteKit modulepreloads for a route: app entry

- every layout and page node + their static imports (gzip level 9).

| Budget                  | Limit            | Why                                                                  |
| ----------------------- | ---------------- | -------------------------------------------------------------------- |
| Initial JS per route    | **≤ 60 KB gzip** | parse/compile/hydrate cost on a mid-range phone; ~35 KB is framework |
| Total CSS (whole build) | **≤ 20 KB gzip** | render-blocking; tokens + all components                             |
| Preloaded font files    | **≤ 2**          | preloads compete with critical requests                              |

### Measured (`pnpm build:node && pnpm budgets`)

| Route             | Initial JS (gzip) | Route CSS (gzip) | Preloaded fonts |
| ----------------- | ----------------: | ---------------: | --------------: |
| `/design`         |           55.9 KB |           9.2 KB |               2 |
| `/(app)/train`    |           52.0 KB |          10.2 KB |               2 |
| `/(app)/profile`  |           50.3 KB |           6.8 KB |               2 |
| `/(app)/today`    |           49.5 KB |           6.7 KB |               2 |
| `/(app)/progress` |           49.0 KB |           6.2 KB |               2 |
| `/(app)/coach`    |           47.7 KB |           5.9 KB |               2 |
| `/`               |           46.8 KB |           4.7 KB |               2 |
| `/offline`        |           46.3 KB |           4.7 KB |               2 |

Total CSS: **15.3 KB gzip** (24 files). Service worker: 1.6 KB gzip. Of the initial JS, the
Svelte runtime (~19.7 KB) and the SvelteKit client (~15.9 KB) are shared by every route.
Fonts: Mona Sans latin 39.8 KB + Hubot Sans latin 48.3 KB (woff2, preloaded, cached immutably).

## Lighthouse baseline (mobile)

Command: `pnpm build:node && pnpm lighthouse --runs 5 --routes /,/today,/train,/profile`

- Lighthouse **13.6.0**, Chrome **153.0.8010.12** (Playwright build, `--headless=new`), default
  mobile config: 412×823 @1.75x, simulated throttling (150 ms RTT, 1.6 Mbps, **4× CPU**).
- Target: local production Node server (`node build/index.js`, adapter-node) + local Postgres.
  adapter-node does **not** compress HTML (Vercel does), so transfer sizes here are pessimistic.
- Host: 4-vCPU Linux VM; Lighthouse `benchmarkIndex` varied **1289–2169** between runs.

**Median of 5 runs per route:**

| Route      | Perf | A11y | Best practices |    LCP |    FCP |    TBT |   CLS | Speed Index |
| ---------- | ---: | ---: | -------------: | -----: | -----: | -----: | ----: | ----------: |
| `/`        |  100 |  100 |            100 | 909 ms | 909 ms |  49 ms | 0.000 |      915 ms |
| `/today`   |   94 |  100 |            100 | 910 ms | 910 ms | 280 ms | 0.000 |     1138 ms |
| `/train`   |   92 |  100 |            100 | 908 ms | 908 ms | 340 ms | 0.000 |      909 ms |
| `/profile` |   93 |  100 |            100 | 906 ms | 906 ms | 301 ms | 0.000 |     1183 ms |

**Run-to-run spread (all 5 runs):**

| Route      | Perf scores       | TBT (ms)               | LCP (ms) |
| ---------- | ----------------- | ---------------------- | -------- |
| `/`        | 100,100,92,100,84 | 49, 7, 342, 7, 656     | 905–915  |
| `/today`   | 100,87,84,94,100  | 19, 502, 656, 280, 0   | 905–914  |
| `/train`   | 100,89,92,99,92   | 67, 461, 340, 142, 344 | 907–912  |
| `/profile` | 89,100,100,92,93  | 450, 49, 3, 356, 301   | 905–915  |

Total page weight (incl. fonts): 164–190 KB transfer per route.

### Reading these numbers honestly

- **LCP (~0.91 s) and CLS (0.000) are stable and well inside "good"** on every run.
- **TBT is bimodal (0–656 ms) and is the one metric that misses its 200 ms target at the median
  on `/today`, `/train` and `/profile`.** Traces show the dominant long task is client hydration
  (~40–55 ms unthrottled on this VM → ×4 under simulation). Whether it lands before or after
  First Contentful Paint (TBT only counts after FCP) flips run to run; the static landing page shows
  the same spikes, so part of the spread is VM noise rather than page work.
- What was already done (measured with CPU profiles and traces during M1): removed `Intl`
  formatter construction from hydration paths (~15–20 ms each), code-split the plate calculator
  (Train initial JS 55.1 → 52.0 KB), mounted bottom-sheet content only while open.
- Next steps (M8 performance council): reduce per-route hydration (fewer components hydrated
  above the fold, lighter root layout), evaluate HTML compression in the local server for
  representative transfer sizes, and confirm on real iPhone hardware + RUM p75 (Lighthouse's 4×
  CPU throttle models a mid-range Android, much slower than a current iPhone).

## Targets

| Metric                    | Target (lab, Lighthouse mobile) | Target (field, RUM p75) | M1 status (lab median)                                                |
| ------------------------- | ------------------------------- | ----------------------- | --------------------------------------------------------------------- |
| LCP                       | ≤ 2.5 s                         | ≤ 2.5 s                 | **met** (0.91 s)                                                      |
| CLS                       | ≤ 0.1                           | ≤ 0.1                   | **met** (0.000)                                                       |
| TBT                       | ≤ 200 ms                        | —                       | **not met** on 3/4 routes (280–340 ms); landing 49 ms                 |
| INP                       | —                               | ≤ 200 ms                | no field data yet                                                     |
| Performance score         | ≥ 90                            | —                       | **met** (92–100)                                                      |
| Initial JS / CSS / fonts  | budgets above                   | —                       | **met**                                                               |
| API latency `/api/health` | ≤ 50 ms server time             | p75 from logs           | local: cold 31 ms (pool connect), warm 1.2–1.8 ms incl. DB round-trip |

CI runs `pnpm lighthouse --runs 3 --assert --min-perf 0.8 --max-tbt 800` as a **regression
guard** (shared runners are noisier than this VM); the targets above are what M8 must reach.

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
`db` time, and a streamed failure is logged and recorded in `app_errors` (`kind: streamed`). Measured against the local production server (8 sequential requests):

```
GET /api/health  #1  server-timing: db;dur=24.6;desc="1 op", total;dur=31.0   (cold: pool connects)
GET /api/health  #2–8  db 0.9–1.3 ms, total 1.2–1.8 ms
GET /today       #1  total;dur=18.6   (first SSR of the route)
GET /today       #2–3  total 2.8–3.0 ms
```

## How to reproduce

```sh
pnpm build:node
pnpm budgets
pnpm lighthouse --runs 5 --routes /,/today,/train,/profile   # reports in lighthouse-reports/
```
