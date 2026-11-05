# Testing

Priorities follow PRD §19: end-to-end browser tests first, then integration tests against a real
database, then unit tests for calculations. Never claim a suite passed without running it.

| Suite       | Command                 | Runner                     | Scope                                                           |
| ----------- | ----------------------- | -------------------------- | --------------------------------------------------------------- |
| Unit        | `pnpm test:unit`        | Vitest (`unit` project)    | `src/**/*.test.ts` — pure domain math                           |
| Integration | `pnpm test:integration` | Vitest (`integration`)     | `tests/integration/**` — services/repositories on real Postgres |
| E2E         | `pnpm test:e2e`         | Playwright 1.63.0          | `e2e/**/*.e2e.ts` — production server, iPhone viewport          |
| Budgets     | `pnpm budgets`          | `scripts/check-budgets.ts` | initial JS / CSS / font preloads from the build output          |
| Lighthouse  | `pnpm lighthouse`       | `scripts/lighthouse.ts`    | mobile audit of the local production server                     |

## Unit tests

Deterministic, no I/O. Current coverage: units (exact kg/lb, km/mi, rounding, pace, durations),
RPE table and reps in reserve (including a structural consistency check of the chart), e1RM
(always marked `estimated`), the plate calculator (exact DP incl. limited inventories), and load
metrics (volume load, session-RPE, EWMA ACWR).

## Integration tests

- **Database:** `TEST_DATABASE_URL` (default local `coach_test`). The Vitest global setup
  (`tests/integration/global-setup.ts`) **drops and recreates** the schema and applies every
  committed migration with the same code `pnpm db:migrate` uses. The reset refuses any database
  whose name does not end in `_test`/`_e2e`.
- **Isolation:** `withRollback()` runs each test in a transaction that is always rolled back;
  services accept the transaction as their `db` dependency. Files run serially.
- **Covered:** migrations applied and constraints enforced; health up and down (unreachable
  database); web-vitals ingest, validation, de-duplication and p75 summary; error recording,
  including when the database is down.

## End-to-end tests

`e2e/global-setup.ts`:

1. resets `coach_e2e` and applies migrations,
2. runs `pnpm build:node` (skip with `E2E_SKIP_BUILD=1`),
3. starts `node build/index.js` on `E2E_PORT` (4173) with `ENABLE_TEST_ROUTES=true`, waits for
   `/api/health`, and stops it in teardown. Server output goes to `.e2e-server.log`.

Projects: `iphone-chromium` (`devices['iPhone 15 Pro']` on Chromium) always; `iphone-webkit` in CI
or with `E2E_WEBKIT=1` (needs `pnpm exec playwright install webkit`).

Specs:

- `shell.e2e.ts` — landing → preview; bottom nav pinned to the bottom with ≥ 44 px targets;
  navigation across all five tabs with `aria-current`; no console errors on any screen; plate
  calculator sheet (stepper, unit switch, Close returns focus).
- `platform.e2e.ts` — `/api/health` reports `db: up` (and the Profile screen shows it);
  `Server-Timing`, request id and security headers; ≤ 2 preloaded fonts; manifest + icons;
  service worker activates and precaches the shell; `POST /api/vitals` stores a row (verified in
  Postgres) and rejects invalid metrics; real browser RUM beacons arrive; a server error returns a
  safe message and is recorded with its request id.

Artifacts: failure screenshots + traces in `test-results/`, key-screen screenshots in
`test-results/screens/<project>/`, HTML report in `playwright-report/` (all uploaded by CI).

## The LLM in tests

Milestone 5 adds the coach behind `LlmProvider`. Tests use the deterministic `mock` provider by
default (`LLM_PROVIDER=mock`); real-model integration tests will be opt-in and skipped without a
key. No key exists in CI today.

## CI

`.github/workflows/ci.yml` runs lint, type-check, unit + integration (postgres:16 service), both
builds + budgets, Playwright (Chromium + WebKit) and an asserted Lighthouse run on every PR and
push to `main`.
