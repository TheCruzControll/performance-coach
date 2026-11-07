# Performance Report

PRD §17's Performance Report: the performance council's scores, the measurements behind them,
the optimisations made, the bottlenecks that remain and the browser and device results. How to
fill it, the cell markers and the privacy rule: [README](./README.md).

| Field                | Value        |
| -------------------- | ------------ |
| Head (SHA)           | pending (S1) |
| App version          | pending (S1) |
| Council rounds run   | pending (S2) |
| Last round (date)    | pending (S2) |
| Report filled (date) | pending      |

## Verdict

pending (S2): two or three paragraphs. The council's final scores in one sentence each, what the
evidence shows about the workout flow on an iPhone-class device, the disagreements between
reviewers and how each was resolved, and the most important bottleneck that remains.

## Method

pending (S2): what was evaluated and how.

- The build evaluated (production build, adapter, database, seeded data) and the head SHA.
- What each reviewer received (the evidence bundle: screens, measurements, raw outputs) and that
  they worked blind and independently, then could run their own measurements.
- The loop per round: capture → evaluate → collect → prioritise by impact → implement → test →
  capture → re-evaluate.
- The hosts the lab numbers come from (CI runners or a local VM, CPU count) and their noise.

## Scores by reviewer and round

Each reviewer's own 0–10 score per round (S2), never averaged. "Final" is the score in the last
round run. "Evidence" names the measurements the reviewer relied on.

| Reviewer                           | Round 1      | Round 2      | Round 3      | Round 4      | Final        | Evidence     |
| ---------------------------------- | ------------ | ------------ | ------------ | ------------ | ------------ | ------------ |
| Frontend Performance Engineer      | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) |
| Backend Performance Engineer       | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) |
| Mobile Performance Specialist      | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) |
| Performance & Reliability Engineer | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) |
| Independent Technical Reviewer     | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) |

Per reviewer, below the table: the verdict of the last round and the issues still open, each with
its severity and evidence (S2).

## Lab measurements per route

One row per page route of the reported head, as `pnpm budgets` names it; add the rows for routes
this skeleton predates. Budgets and targets are those in `docs/performance.md` (mobile; it sets
none for desktop Lighthouse).

| Route                        | Initial JS (gzip) | CSS (gzip)   | Main thread, 4× CPU | Lighthouse mobile: perf · LCP · TBT · CLS | Lighthouse desktop: perf · LCP · TBT · CLS |
| ---------------------------- | ----------------- | ------------ | ------------------- | ----------------------------------------- | ------------------------------------------ |
| Budget or target             | ≤ 60 KB           | ≤ 14 KB      | ≤ 200 ms (median)   | ≥ 90 · ≤ 2.5 s · ≤ 200 ms · ≤ 0.1         | no target set                              |
| `/`                          | pending (S1)      | pending (S1) | pending (S5)        | pending (S3)                              | pending (S4)                               |
| `/(app)/today`               | pending (S1)      | pending (S1) | pending (S5)        | pending (S3)                              | pending (S4)                               |
| `/(app)/train`               | pending (S1)      | pending (S1) | pending (S5)        | pending (S3)                              | pending (S4)                               |
| `/(app)/train/session/[key]` | pending (S1)      | pending (S1) | pending (S5)        | pending (S3)                              | pending (S4)                               |
| `/(app)/progress`            | pending (S1)      | pending (S1) | pending (S5)        | pending (S3)                              | pending (S4)                               |
| `/(app)/coach`               | pending (S1)      | pending (S1) | pending (S5)        | pending (S3)                              | pending (S4)                               |
| `/(app)/profile`             | pending (S1)      | pending (S1) | pending (S5)        | pending (S3)                              | pending (S4)                               |
| `/(app)/profile/[section]`   | pending (S1)      | pending (S1) | pending (S5)        | pending (S3)                              | pending (S4)                               |
| `/(app)/profile/security`    | pending (S1)      | pending (S1) | pending (S5)        | pending (S3)                              | pending (S4)                               |
| `/(app)/offline`             | pending (S1)      | pending (S1) | pending (S5)        | pending (S3)                              | pending (S4)                               |
| `/recover`                   | pending (S1)      | pending (S1) | pending (S5)        | pending (S3)                              | pending (S4)                               |
| `/recover/passkey`           | pending (S1)      | pending (S1) | pending (S5)        | pending (S3)                              | pending (S4)                               |
| `/setup`                     | pending (S1)      | pending (S1) | pending (S5)        | pending (S3)                              | pending (S4)                               |

Below the table: total CSS, the service worker's size and precache download (S1), and the
run-to-run spread of the Lighthouse medians (S3, S4).

## Workout interactions

The interactions PRD §15 requires to feel instantaneous, measured on the workout screen at 4× CPU.

| Interaction                              | Target                    | Median       | p95          | Samples      |
| ---------------------------------------- | ------------------------- | ------------ | ------------ | ------------ |
| Log a set (tap → visual confirmation)    | < 100 ms (M4 criterion 3) | pending (S6) | pending (S6) | pending (S6) |
| Workout screen INP (lab)                 | ≤ 200 ms (M4 criterion 4) | pending (S6) | pending (S6) | pending (S6) |
| Start the rest timer                     | instantaneous (PRD §15)   | pending (S6) | pending (S6) | pending (S6) |
| Switch exercise                          | instantaneous (PRD §15)   | pending (S6) | pending (S6) | pending (S6) |
| Restore an active workout after a reload | no target set             | pending (S6) | pending (S6) | pending (S6) |

## Real-user monitoring

p75 per metric from `web_vitals` on production (S7), aggregates only. State the window (start
and end, UTC) and the sample count of every cell; below the query's minimum the cell reads
`insufficient data (n=…)`.

| Route (`route_id`)                  | LCP p75      | INP p75      | CLS p75      | TTFB p75     | Samples (LCP · INP · CLS · TTFB) |
| ----------------------------------- | ------------ | ------------ | ------------ | ------------ | -------------------------------- |
| Target                              | ≤ 2.5 s      | ≤ 200 ms     | ≤ 0.1        | no target    |                                  |
| All routes                          | pending (S7) | pending (S7) | pending (S7) | pending (S7) | pending (S7)                     |
| `/(app)/today`                      | pending (S7) | pending (S7) | pending (S7) | pending (S7) | pending (S7)                     |
| The workout screen (its `route_id`) | pending (S7) | pending (S7) | pending (S7) | pending (S7) | pending (S7)                     |

Add a row per route that has samples in the window.

## Server timing and query plans

Server time per endpoint from `Server-Timing` (S8) and the query plans from `pnpm db:explain`
(S9), the backup export included.

| Endpoint or query                  | p50          | p95          | Requests or plan                    |
| ---------------------------------- | ------------ | ------------ | ----------------------------------- |
| `GET /api/health`                  | pending (S8) | pending (S8) | pending (S8)                        |
| Signed-in page loads (`total;dur`) | pending (S8) | pending (S8) | pending (S8)                        |
| Set logging and sync               | pending (S8) | pending (S8) | pending (S8)                        |
| Coach turn (time to first token)   | pending (S8) | pending (S8) | pending (S8)                        |
| History and analytics queries      | pending (S9) | pending (S9) | pending (S9): index use, row counts |
| Backup export and seal             | pending (S9) | pending (S9) | pending (S9)                        |

## Optimisations

What changed because of the councils, highest impact first, with before and after on the same
measurement (S10).

| Optimisation | Raised by    | Before       | After        | PR            |
| ------------ | ------------ | ------------ | ------------ | ------------- |
| pending      | pending (S2) | pending (S1) | pending (S1) | pending (S10) |

## Remaining bottlenecks

What is still slow or fragile, by impact, with its evidence and whether it is accepted or
planned.

| Bottleneck | Severity     | Evidence     | Accepted or planned |
| ---------- | ------------ | ------------ | ------------------- |
| pending    | pending (S2) | pending (S2) | pending             |

## Browser and device matrix

| Browser or device               | How it was checked                        | Result        |
| ------------------------------- | ----------------------------------------- | ------------- |
| Chromium, iPhone viewport       | CI e2e suite and perf project             | pending (S11) |
| WebKit, iPhone viewport         | CI e2e suite                              | pending (S11) |
| Chromium, desktop 1440 × 900    | CI desktop specs, Lighthouse desktop      | pending (S11) |
| WebKit, desktop 1440 × 900      | CI desktop specs                          | pending (S11) |
| The owner's iPhone (production) | real-device checklist (`docs/testing.md`) | pending (S12) |

## How to reproduce

The commands the numbers above come from, as run on the reported head. They are today's
commands; replace any that changed by the time the report is filled.

```sh
ORIGIN=http://localhost:4174 pnpm build:node   # the origin is baked into Node builds
pnpm budgets                                   # S1: initial JS, CSS and fonts per route
pnpm lighthouse --runs 5 --assert --min-perf 0.9 --max-tbt 300   # S3: Lighthouse mobile
E2E_PERF_ALONE=1 pnpm test:e2e --project=perf  # S5, S6: main thread and workout interactions
pnpm db:explain                                # S9: query plans on the seeded dataset
```

## Sources

Every `Sn` above, filled with the exact run, file, query or path (see the README).

| Key | What                                                                             | Where (fill in)                                                 |
| --- | -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| S1  | The CI run on the reported head: `pnpm budgets` in its build job                 | pending: run URL, head SHA                                      |
| S2  | The performance council's outputs per reviewer and round: score, verdict, issues | pending: council run label, round numbers and dates             |
| S3  | Lighthouse mobile, median of 5 per route                                         | pending: `lighthouse-<run id>` artifact, report file names      |
| S4  | Lighthouse desktop, median of 5 per route                                        | pending: artifact and report file names                         |
| S5  | Main-thread blocking at 4× CPU, median of 5 loads (`perf` Playwright project)    | pending: `playwright-<run id>` artifact, test annotations       |
| S6  | Workout interactions at 4× CPU (`perf` Playwright project)                       | pending: `playwright-<run id>` artifact, test annotations       |
| S7  | RUM: read-only aggregate query over `web_vitals`, p75 and samples per `route_id` | pending: query or command, window start and end (UTC)           |
| S8  | `Server-Timing` over repeated requests, p50 and p95                              | pending: command, server and head, request count, date          |
| S9  | `pnpm db:explain` plans, the backup export included                              | pending: `explain-<run id>` artifact, `test-results/explain.md` |
| S10 | Pull requests that made each optimisation                                        | pending: `#NNN` per row                                         |
| S11 | The CI e2e legs per engine and viewport                                          | pending: run URL, legs and their results                        |
| S12 | The owner's real-device check                                                    | pending: date, device, iOS version; captures by SHA-256         |
