# Testing

Priorities follow PRD §19: end-to-end browser tests first, then integration tests against a real
database, then unit tests for calculations. Never claim a suite passed without running it.

| Suite       | Command                 | Runner                     | Scope                                                              |
| ----------- | ----------------------- | -------------------------- | ------------------------------------------------------------------ |
| Unit        | `pnpm test:unit`        | Vitest (`unit` project)    | `src/**/*.test.ts` — domain math, env validation, RUM attribution  |
| Integration | `pnpm test:integration` | Vitest (`integration`)     | `tests/integration/**` — services/repositories on real Postgres    |
| E2E         | `pnpm test:e2e`         | Playwright 1.63.0          | `e2e/**/*.e2e.ts` — production server, iPhone viewport             |
| Budgets     | `pnpm budgets`          | `scripts/check-budgets.ts` | initial JS / CSS / font preloads + CSS prefix guard from the build |
| Drift       | `pnpm db:drift`         | drizzle-kit + git          | fails when the schema changed without a committed migration        |
| Lighthouse  | `pnpm lighthouse`       | `scripts/lighthouse.ts`    | mobile audit of the local production server                        |

## Unit tests

Deterministic, no I/O. Current coverage: units (exact kg/lb, km/mi, rounding, pace, durations),
RPE table and reps in reserve (including a structural consistency check of the chart), e1RM
(always marked `estimated`; for fixed weight and reps it rises as RPE falls, a recorded RPE is
never silently dropped, malformed or sub-6 RPEs give no estimate, and sets past the chart are
extrapolated from reps to failure at `low` confidence), the plate calculator (exact DP incl. limited inventories), and load
metrics (volume load, session-RPE, EWMA ACWR). Outside the domain: `parseEnv` (defaults, `appEnv`
derivation, the production guards incl. `VERCEL_ENV=production`, the API-key requirement) and the
RUM attribution of each metric to the screen where it happened, client error reports (bounded
fields, non-Error values), and `serializeError` (Drizzle
parameters redacted; Postgres messages withheld for SQLSTATE classes that can quote values, kept
for identifier-only classes such as 23 and 42; DETAIL/HINT never logged).

## Integration tests

- **Database:** `TEST_DATABASE_URL` (default local `coach_test`). The Vitest global setup
  (`tests/integration/global-setup.ts`) **drops and recreates** the schema and applies every
  committed migration with the same code `pnpm db:migrate` uses. The reset refuses any database
  whose name does not end in `_test`/`_e2e`.
- **Isolation:** `withRollback()` runs each test in a transaction that is always rolled back;
  services accept the transaction as their `db` dependency. Files run serially.
- **Covered:** migrations applied and constraints enforced; health up and down (unreachable
  database); web-vitals ingest, validation, de-duplication (across requests and within one
  batch), route attribution and p75 summary; error recording, including when the database is
  down, with SQL parameter values redacted from a real failed query (check violation), and with
  a real `22P02 invalid input syntax` whose driver message quotes the value: neither the
  `app_errors` row nor the JSON log line contains it; browser error reports stored as kind
  `client`, validated (source, absolute path, size caps) and rate-limited.
- **Logs:** quiet by default (`LOG_LEVEL=silent` via the project's `env`); run
  `LOG_LEVEL=debug pnpm test:integration` to see them.

## End-to-end tests

`e2e/global-setup.ts`:

1. resets `coach_e2e` and applies migrations,
2. runs `pnpm build:node` (skip with `E2E_SKIP_BUILD=1`),
3. starts `node build/index.js` on `E2E_PORT` (4173) with `ENABLE_TEST_ROUTES=true`, waits for
   `/api/health`, and stops it in teardown. Server output goes to `.e2e-server.log`.

Projects: `iphone-chromium` (`devices['iPhone 15 Pro']` on Chromium) always; `iphone-webkit` in CI
or with `E2E_WEBKIT=1` (needs `pnpm exec playwright install webkit`).

Specs:

- `shell.e2e.ts` — landing → preview; bottom nav pinned to the bottom with ≥ 44 px targets and a
  computed `backdrop-filter` blur; navigation across all five tabs with `aria-current`; no console
  errors on any screen; plate calculator sheet (stepper; Escape while typing cancels the edit
  without closing the sheet; a target below the bar is explained and the stepper's minimum is the
  bar; the kg/lb switch stays local to the calculator; Close returns focus); theme applied before
  first paint and persisted (under the CSP), and Auto following an OS appearance change while
  open (theme-color included); no screen scrolls sideways; nothing
  sits under fixed chrome at rest (landing CTAs, Coach composer); compact segmented controls keep
  a 44 px hit area.
- `platform.e2e.ts` — `/api/health` reports `db: up` (and the Profile screen shows it);
  `Server-Timing`, request id and security headers; ≤ 2 preloaded fonts; manifest + icons;
  CSP header contents and enforcement (an injected inline script is refused); service worker
  activates and precaches the shell (not the icons); `POST /api/vitals` stores a row (verified in
  Postgres) and rejects invalid metrics; real browser RUM beacons arrive; vitals are attributed to
  the screen where they happened (client-side navigation, INP on Train); an uncaught exception
  and an unhandled rejection in the browser are reported and stored as `client` rows with their
  route; a server error returns a safe message and is recorded with its request id.
- `offline.e2e.ts` (Chromium) — the first visit is controlled by the service worker without a
  reload; offline, every tab keeps the shell (screens without server data render, Profile shows
  the designed offline state, never a 500), a full reload offline gets the offline screen in the
  shell, and back online the screen loads live data; no dynamic page is ever cached.
- `a11y.e2e.ts` — axe-core (`@axe-core/playwright`, WCAG 2.1 A/AA) on every screen, the
  plate-calculator sheet and each `/design` component group, in the **dark and light** themes
  (Lighthouse only audits dark). Zero violations required.
- `perf.e2e.ts` (Chromium) — main-thread budget: real long tasks at 4× CPU while each screen
  loads, median of 3 cold loads ≤ 200 ms blocking (docs/performance.md).

Artifacts: failure screenshots + traces in `test-results/`, key-screen screenshots in
`test-results/screens/<project>/`, HTML report in `playwright-report/` (all uploaded by CI).

## The LLM in tests

Milestone 5 adds the coach behind `LlmProvider`. Tests use the deterministic `mock` provider by
default (`LLM_PROVIDER=mock`); real-model integration tests will be opt-in and skipped without a
key. No key exists in CI today.

## CI

`.github/workflows/ci.yml` runs lint, type-check, the migration drift check, unit + integration
(postgres:16 service), both builds + budgets, Playwright (Chromium + WebKit) and an asserted
Lighthouse run on every PR and push to `main`.

**Not yet verified:** the workflows have not run on GitHub (nothing has been pushed), and the
WebKit project has never run locally (WebKit is not installed in the build environment), so iOS
Safari behaviour (glass, PWA install, status bar) is unverified. The first CI run, including its
WebKit screenshots, must be attached to the M1 PR as evidence.
