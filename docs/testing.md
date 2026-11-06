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
derivation, the production guards incl. `VERCEL_ENV=production`, test routes refused in a Vercel
build whatever its runtime environment, the API-key requirement), the build-time marker
`vite.config.ts` sets for Vercel builds only (`scripts/vite-config.test.ts`) and the
RUM attribution of each metric to the screen where it happened, client error reports (bounded
fields, non-Error values), and `serializeError` (Drizzle
parameters redacted; Postgres messages withheld for SQLSTATE classes that can quote values, kept
for identifier-only classes such as 23 and 42; DETAIL/HINT never logged).

Auth unit tests (`src/lib/server/auth/*.test.ts`): relying-party derivation per environment
(production is exactly `https://coach.nikocruz.com`, previews never the production RP, localhost
only in dev/test), token generation and hashing with the constant-time comparison, recovery-code
format, normalisation and hashing, cookie name and flags from the origin, the safe return path,
the CSRF Origin check, User-Agent and passkey labels, and the route access map — which also walks
`src/routes` and fails on any page or endpoint without an access decision.

## Integration tests

- **Database:** `TEST_DATABASE_URL` (default local `coach_test`). The Vitest global setup
  (`tests/integration/global-setup.ts`) **drops and recreates** the schema and applies every
  committed migration with the same code `pnpm db:migrate` uses. The reset refuses any database
  whose name does not end in `_test`/`_e2e`.
- **Isolation:** `withRollback()` runs each test in a transaction that is always rolled back;
  services accept the transaction as their `db` dependency. Files run serially. The few tests
  that race real connections commit for real and clean up afterwards: a goal status change
  waiting behind a concurrent edit deletes its owner; the auth races use `withCommitted()`
  (committed rows, truncated afterwards), `holdTransaction()` to keep one step's locks held and
  `lockWaiters()` to wait until the other steps are blocked, so every interleaving is exact
  rather than timed.
- **Covered:** migrations applied and constraints enforced; health up and down (unreachable
  database); web-vitals ingest, validation, de-duplication (across requests and within one
  batch), route attribution and p75 summary; error recording, including when the database is
  down, with SQL parameter values redacted from a real failed query (check violation), and with
  a real `22P02 invalid input syntax` whose driver message quotes the value: neither the
  `app_errors` row nor the JSON log line contains it; browser error reports stored as kind
  `client`, validated (source, absolute path, size caps) and rate-limited.
- **Auth (`tests/integration/auth/`):** a software authenticator
  (`soft-authenticator.ts`, test code only: ES256 keys from `node:crypto`, CBOR from
  SimpleWebAuthn's helper) produces real registration and assertion responses, so every service
  runs through `@simplewebauthn/server`'s genuine verification. Covered: setup once (token hash,
  10 hashed codes, nothing secret stored, setup closed afterwards, refused origin/RP/UV/type,
  single-use challenges, `auth:reset-owner` reopening setup and re-attaching the same owner, a
  token working for one setup only, also across resets);
  sign-in (counter update, rotation, replay, expired challenge, counter regression, unknown
  passkey, production RP and other origins refused, malformed bodies); sessions (sliding refresh
  at most daily, 90-day cap, 30-day idle expiry, last-seen resolution, revoke one / others /
  sign out, a malformed id is not found); recovery (burn, any spelling refused afterwards,
  15-minute restricted session, new passkey upgrades it, regeneration); passkey management (add,
  challenge bound to its session, nothing added or upgraded for a session revoked or expired
  mid-request, including a revocation that commits while the request waits on the session's row
  lock, sign out everywhere else during a recovery upgrade ending the new session, rename
  validation, never the last, removal ends its sessions, a malformed id is not found); rate limits
  on every entry point with `Retry-After`, window reset, a global ceiling on failed recovery codes
  that never refuses a valid one, and a full sign-out bucket that still lets a live session sign
  out. A controllable clock replaces waiting.
- **Logs:** quiet by default (`LOG_LEVEL=silent` via the project's `env`); run
  `LOG_LEVEL=debug pnpm test:integration` to see them.

## End-to-end tests

`e2e/global-setup.ts`:

1. resets `coach_e2e` and applies migrations,
2. runs `pnpm build:node` (skip with `E2E_SKIP_BUILD=1`),
3. starts `node build/index.js` on `E2E_PORT` (4173) with `ENABLE_TEST_ROUTES=true`, waits for
   `/api/health`, and stops it in teardown. Server output goes to `.e2e-server.log`.

Projects (all `devices['iPhone 15 Pro']`):

| Project           | Browser  | Runs                                                                                            |
| ----------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `setup`           | Chromium | `auth.setup.ts`: the owner's real first-run setup; saves the signed-in state                    |
| `iphone-chromium` | Chromium | every functional spec, signed in from `setup`'s state                                           |
| `perf`            | Chromium | `perf.e2e.ts`, alone with one worker, after the functional suite                                |
| `setup-webkit`    | WebKit   | `auth-webkit.setup.ts`: a session from the test-only route (CI or `E2E_WEBKIT=1`)               |
| `iphone-webkit`   | WebKit   | every functional spec on that session (CI or `E2E_WEBKIT=1`; needs `playwright install webkit`) |
| `exclusive`       | Chromium | `*.exclusive.e2e.ts`, last and alone: account-wide actions                                      |

### Authentication

- **Chromium performs real WebAuthn ceremonies** through the DevTools Protocol's virtual
  authenticator (`e2e/webauthn.ts`: CTAP2, internal transport, resident keys, user verification;
  presence answered automatically). No Chromium test uses an auth bypass.
- `global-setup.ts` mints each run's setup token and gives the server only its SHA-256, as in
  production. The `setup` project opens `/setup?token=…`, creates the passkey, checks the
  recovery codes (copy, download, acknowledgement) and saves `e2e/.auth/chromium.json`
  (git-ignored) — the state every Chromium spec starts from.
- Specs that need their own sign-in register **their own passkey** from that state (Security →
  Add passkey, a real registration), forget the shared cookie on their own context and sign in
  with it, so they never revoke the shared session and stay independent.
- **WebKit has no virtual authenticator**: `setup-webkit` mints a session through
  `POST /api/test-support/session` (exists only with `ENABLE_TEST_ROUTES`, which env validation
  refuses on any hosted deployment). Passkey specs skip on WebKit with that reason; passkeys on iOS
  Safari are part of the real-device checklist below.
- Signed-out specs use `test.use({ storageState: signedOut })`.
- Conditional UI: Chromium's virtual authenticator answers a conditional (autofill) request at
  once, so `/` signs in without a tap when the authenticator holds the owner's passkey. One test
  proves that path; the others hide conditional mediation (`isConditionalMediationAvailable →
false`, as in browsers without it) to drive the button.
- State-changing requests from the `request` fixture send the app's `Origin` (`SAME_ORIGIN` in
  `e2e/support.ts`), as browsers do; without it the server refuses them (CSRF).

Specs:

- `auth.setup.ts` — first-run setup with a real passkey: 404 without the token; axe in both themes
  on the setup and recovery-code screens; name required; 10 codes in the expected format;
  download and copy contain them; Continue only after acknowledgement; the authenticator holds a
  discoverable credential; only hashes in Postgres; `/setup` is a 404 afterwards, even with the
  token.
- `auth.e2e.ts` (Chromium) — passkey sign-in from a denied page back to it (`?next=`); the session
  cookie is opaque, HttpOnly, SameSite=Lax and stored only as a hash; conditional UI signs in
  without a tap; a refused passkey (user verification fails) shows a designed, accessible error
  and then works; add, rename and remove a passkey (a removed one no longer signs in); a recovery
  code (wrong code refused; forgiving input) gives a session that reaches only the new-passkey
  screen (pages redirect, `/api` 403), registering a passkey unlocks the app, the code is burned;
  sessions list marks this device and signs out another; sign-out clears the cookie, every cache
  but the versioned shell and every IndexedDB database, sends `Clear-Site-Data: "cache"` and keeps
  the theme preference.
- `access.e2e.ts` — routes enumerated from `src/routes`: every non-public page redirects to
  sign-in with a safe return path (also as a client-side data request), every non-public `/api`
  endpoint answers 401 JSON for every method it exports, the public endpoints are exactly the
  allow-list, telemetry needs a session, unknown URLs are denied, forged cookies are refused and
  cleared; signed in, cross-site JSON, form-action and `text/plain` requests are refused (403)
  and change nothing.
- `sessions.exclusive.e2e.ts` (runs last) — sign out everywhere else ends every other session,
  not this one; the last passkey cannot be removed (button disabled, server answers 409).

- `shell.e2e.ts` — the sign-in screen is the landing page (signed in, `/` goes to Today); bottom nav pinned to the bottom with ≥ 44 px targets and a
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
- `a11y.e2e.ts` — axe-core (`@axe-core/playwright`, WCAG 2.1 A/AA) on every screen (Security
  included; the signed-out sign-in and recovery screens too), the plate-calculator sheet and each
  `/design` component group, in the **dark and light** themes (Lighthouse only audits dark). The
  setup, recovery-codes, new-passkey and sign-in-error states are audited in both themes where
  they occur (`auth.setup.ts`, `auth.e2e.ts`). Zero violations required.
- `perf.e2e.ts` (Chromium, `perf` project) — main-thread budget: real long tasks at 4× CPU while
  each screen loads, median of 5 cold loads; target ≤ 200 ms, fails above 250 ms (docs/performance.md). It runs
  alone, with one worker, after the functional suite, so parallel specs cannot skew it. App
  screens load signed in, `/` signed out. Run it by itself with
  `E2E_PERF_ALONE=1 pnpm test:e2e --project=perf` (owner setup, then the budget).

Artifacts: failure screenshots + traces in `test-results/`, key-screen screenshots in
`test-results/screens/<project>/`, HTML report in `playwright-report/` (all uploaded by CI).

## The LLM in tests

Milestone 5 adds the coach behind `LlmProvider`. Tests use the deterministic `mock` provider by
default (`LLM_PROVIDER=mock`); real-model integration tests will be opt-in and skipped without a
key. No key exists in CI today.

## CI

`.github/workflows/ci.yml` runs lint, type-check, the migration drift check, unit + integration
(postgres:18 service), both builds + budgets, Playwright (Chromium + WebKit) and an asserted
Lighthouse run on every PR and push to `main`.

**Not yet verified:** the workflows have not run on GitHub (nothing has been pushed), and the
WebKit project has never run locally (WebKit is not installed in the build environment), so iOS
Safari behaviour (glass, PWA install, status bar) is unverified. The first CI run, including its
WebKit screenshots, must be attached to the M1 PR as evidence.

Screenshots from the `iphone-chromium` project do **not** show the glass blur: headless Chromium
does not paint `backdrop-filter` under mobile emulation (verified: the same page blurs with
`isMobile` off). Judge glass on WebKit screenshots or a device.

### Real-device checklist (merge gate for UI milestones)

On an iPhone with current iOS, against a preview deployment (Vercel Authentication on):

1. Safari: every tab renders; the bottom nav sits above the home indicator; glass blurs the
   content behind it; nothing scrolls sideways.
2. Share → Add to Home Screen; launch the installed app: standalone (no Safari chrome), status
   bar text readable in dark and light (Profile → Appearance), splash/icon correct.
3. Settings → Display → Automatic appearance, or Control Centre dark-mode toggle while the app is
   open with Appearance = Auto: the theme and status bar follow.
4. Airplane mode: tabs keep the shell, Profile shows the offline state; back online it loads.
5. Plate calculator: one-handed stepper hold-to-repeat, typing with the decimal keypad, swipe the
   sheet down to close.

Record device, iOS version, date and screenshots in the PR.
