# Testing

Priorities follow PRD §19: end-to-end browser tests first, then integration tests against a real
database, then unit tests for calculations. Never claim a suite passed without running it.

| Suite       | Command                 | Runner                     | Scope                                                              |
| ----------- | ----------------------- | -------------------------- | ------------------------------------------------------------------ |
| Unit        | `pnpm test:unit`        | Vitest (`unit` project)    | `src/**/*.test.ts` — domain math, env validation, RUM attribution  |
| Integration | `pnpm test:integration` | Vitest (`integration`)     | `tests/integration/**` — services/repositories on real Postgres    |
| E2E         | `pnpm test:e2e`         | Playwright 1.63.0          | `e2e/**/*.e2e.ts` — production server, iPhone and desktop windows  |
| Budgets     | `pnpm budgets`          | `scripts/check-budgets.ts` | initial JS / CSS / font preloads + CSS prefix guard from the build |
| Drift       | `pnpm db:drift`         | drizzle-kit + git          | fails when the schema changed without a committed migration        |
| Lighthouse  | `pnpm lighthouse`       | `scripts/lighthouse.ts`    | mobile and desktop audits of the local production server           |
| Live coach  | `pnpm test:live`        | Vitest (`live`)            | `tests/live/**` — the real model, opt-in, never in CI              |

## Unit tests

Deterministic, no I/O. Current coverage: units (exact kg/lb, km/mi, rounding, pace, durations),
RPE table and reps in reserve (including a structural consistency check of the chart), e1RM
(always marked `estimated`; for fixed weight and reps it rises as RPE falls, a recorded RPE is
never silently dropped, malformed or sub-6 RPEs give no estimate, and sets past the chart are
extrapolated from reps to failure at `low` confidence), the plate calculator (exact DP incl. limited inventories), the owner's local
calendar day (a weigh-in at 18:30 in Los Angeles is not tomorrow; daylight saving; only IANA zones), and load
metrics (volume load, session-RPE, EWMA ACWR). Outside the domain: `parseEnv` (defaults, `appEnv`
derivation, the production guards incl. `VERCEL_ENV=production`, test routes refused in a Vercel
build whatever its runtime environment, the API-key requirement), the build-time marker
`vite.config.ts` sets for Vercel builds only (`scripts/vite-config.test.ts`) and the
RUM attribution of each metric to the screen where it happened, client error reports (bounded
fields, non-Error values), and `serializeError` (Drizzle
parameters redacted; Postgres messages withheld for SQLSTATE classes that can quote values, kept
for identifier-only classes such as 23 and 42; DETAIL/HINT never logged). The backup status's
states and words (`src/lib/domain/backup/status.ts`) are unit-tested at a fixed clock.

Layout rules (`scripts/layout-rules.test.ts`, docs/design-system.md, Responsive layout): every
`<style>` block and .css file under `src`, parsed with svelte/compiler's `parseCss`, uses only the
five rem breakpoints, keeps `:hover` inside `(hover: hover) and (pointer: fine)` and reads
`--nav-height` only in `tokens.css` and `AppNav.svelte`, markup included (a style attribute or a
`style:` directive). The browser code (`src/lib/ui`, `src/lib/client`, `src/routes`,
`src/app.html`) never reads the viewport's size or listens for `resize`, and `matchMedia`,
`matchMedia?.()` and Svelte's `new MediaQuery()` ask only for `prefers-reduced-motion`,
`prefers-color-scheme` or `display-mode`. Each breach names its file, line, fix and design-system
subsection. Fixtures show that every rule fires, and that preferences, display mode, forced
colours, print, `@container`, the CSS `resize` property and comments are allowed.

Auth unit tests (`src/lib/server/auth/*.test.ts`): relying-party derivation per environment
(production is exactly `https://coach.nikocruz.com`, previews never the production RP, localhost
only in dev/test), token generation and hashing with the constant-time comparison, recovery-code
format, normalisation and hashing, cookie name and flags from the origin, the safe return path,
the CSRF Origin check, User-Agent and passkey labels, the rate-limit client network (IPv6 per
/64, IPv4-mapped IPv6 as IPv4), and the route access map — which also walks
`src/routes` and fails on any page or endpoint without an access decision.

## Integration tests

- **Database:** `TEST_DATABASE_URL` (default local `coach_test`). The Vitest global setup
  (`tests/integration/global-setup.ts`) **drops and recreates** the schema and applies every
  committed migration with the same code `pnpm db:migrate` uses. The reset refuses any database
  whose name does not end in `_test`/`_e2e`.
- **Isolation:** `withRollback()` runs each test in a transaction that is always rolled back;
  services accept the transaction as their `db` dependency. Files run serially. The few tests
  that race real connections commit for real and clean up afterwards: a goal status change
  waiting behind a concurrent edit and two saves of one profile section queued behind a third
  delete their owner; the auth races use `withCommitted()` (committed rows, truncated
  afterwards), `holdTransaction()` to keep one step's locks held and `lockWaiters()` to wait
  until the other steps are blocked, so every interleaving is exact rather than timed.
- **Covered:** migrations applied and constraints enforced; health up and down (unreachable
  database); web-vitals ingest, validation, de-duplication (across requests and within one
  batch), route attribution and p75 summary; error recording, including when the database is
  down, with SQL parameter values redacted from a real failed query (check violation), and with
  a real `22P02 invalid input syntax` whose driver message quotes the value: neither the
  `app_errors` row nor the JSON log line contains it; browser error reports stored as kind
  `client`, validated (source, absolute path, size caps) and rate-limited. The backup run log as the
  run writes it (succeeded with what it stored, failed with its code, skipped, abandoned runs
  expired, nothing for `--out` or with backups off, a finish never before its start when the
  run's clock is ahead) and Profile's status read (each state, and 57014 after 1,500 ms behind a
  held lock).
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
  validation, never the last, removal ends its sessions, a malformed id is not found); step-up
  (`reauth.test.ts`: 5 minutes after its last passkey use a session can no longer add or remove
  passkeys, create codes or sign devices out, but can rename; sign-in, setup and the recovery
  passkey start fresh, test and recovery sessions do not; re-authentication with an owner passkey
  unlocks them again and refuses missing UV, a stranger's passkey, another session's or a sign-in
  challenge and replay; owner sessions only, rate-limited); rate limits on every entry point with
  `Retry-After`, window reset, IPv6 counted per /64, stale counters pruned on writes in bounded
  batches, a global ceiling on failed recovery codes that never refuses a valid one, and a full
  sign-out bucket that still lets a live session sign out. A controllable clock replaces waiting.
- **Logs:** quiet by default (`LOG_LEVEL=silent` via the project's `env`); run
  `LOG_LEVEL=debug pnpm test:integration` to see them.

## End-to-end tests

`e2e/global-setup.ts`:

1. resets `coach_e2e` and applies migrations,
2. runs `pnpm build:node` (skip with `E2E_SKIP_BUILD=1`),
3. starts `node build/index.js` on `E2E_PORT` (4173) with `ENABLE_TEST_ROUTES=true`, waits for
   `/api/health`, and stops it in teardown. Server output goes to `.e2e-server.log`.

Projects (all `devices['iPhone 15 Pro']` except `desktop-chromium`):

| Project           | Browser  | Runs                                                                                                            |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `setup`           | Chromium | `auth.setup.ts`: the owner's real first-run setup; saves the signed-in state                                    |
| `iphone-chromium` | Chromium | every functional spec, signed in from `setup`'s state                                                           |
| `perf`            | Chromium | `perf.e2e.ts` and `perf-*.e2e.ts`, alone with one worker, after the functional suite                            |
| `setup-webkit`    | WebKit   | `auth-webkit.setup.ts`: a session from the test-only route (CI or `E2E_WEBKIT=1`)                               |
| `iphone-webkit`   | WebKit   | every functional spec on that session (CI or `E2E_WEBKIT=1`; needs `playwright install webkit`)                 |
| `serial-chromium` | Chromium | `*.serial.e2e.ts` one at a time (per owner world), after the functional specs: they change the training profile |
| `serial-webkit`   | WebKit   | the same specs after `serial-chromium` (CI or `E2E_WEBKIT=1`)                                                   |
| `exclusive`       | Chromium | `*.exclusive.e2e.ts`, last and alone: account-wide actions                                                      |

`desktop-chromium` opens `devices['Desktop Chrome']` resized to `DESKTOP` (`e2e/desktop.ts`:
1440 × 900, a mouse and no touch, scale 1) from `setup`'s signed-in state and runs whole files:
every `*.desktop.e2e.ts`, which the iPhone projects skip, plus `shell.e2e.ts`, `offline.e2e.ts`
and `a11y.e2e.ts`. It shares the setup session, so a desktop case that changes the training
profile goes in a `*.serial.e2e.ts` spec with `test.use(DESKTOP)`, which `serial-chromium` and
`serial-webkit` then run at 1440 × 900. There is no desktop WebKit project: the owner's desktop
browser is Chrome, and the owner dropped it on 2026-11-07 (#190). Screenshots of every main screen
land in `test-results/screens/desktop-chromium/`.

Every UI slice is verified at the iPhone viewport (393 × 659) and at 1440 × 900, with
`test.use(DESKTOP)` from `e2e/desktop.ts` or a `*.desktop.e2e.ts` spec, and its PR attaches both
screenshots (docs/design-system.md, Responsive layout → Verification).

Workers: 2 locally and in CI's main legs (whole files side by side); in its serial legs, one per
owner world (below): 2 on Chromium and 1 on WebKit (`e2e/serial-workers.ts`, the one place they
are set); 1 in its other legs.

Why per engine: two workers share the CI runner's 4 vCPUs. With 2, a serial·chromium spec file took
1.15× its 1-worker time, which halves the leg for little; a serial·webkit one took 1.39×, and its
heaviest tests (`workout-run.serial.e2e.ts`, the axe test of `adjust-skip.serial.e2e.ts`) went
past their 30 s timeout, attempt and retry, where they take ~13 s alone. So serial·webkit runs 1
worker and takes more shards instead.

**Owner worlds (CI's serial·chromium legs).** The app has one owner, and the serial specs reset and
change that owner's training profile, so two of them never share a database and a server. A serial
leg (`E2E_GROUP=serial` in CI) with more than one worker therefore runs each in an owner world of
its own (`e2e/worlds.ts`): world 0 is the usual `E2E_PORT` and `coach_e2e`; world 1 serves on
`E2E_PORT + 1` from `coach_w1_e2e` (`<name>_w<n>_e2e`, created with `PGADMIN_URL` when missing).
Global setup resets every world's database and starts one production server per world, each from
a copy of the one build made for its origin (`build-w<n>/`: adapter-node bakes its origin in), with
its own log (`.e2e-server-w<n>.log`) and backups folder. Each worker serves the world of its
`TEST_PARALLEL_INDEX` (`routeWorker`, from `playwright.config.ts`, points `E2E_PORT` and
`E2E_DATABASE_URL` at it). The owner setups run once, in one world, and the `setup-worlds` project
(`e2e/worlds.setup.ts`) then copies that world's database (owner, passkeys, sessions) into the
others and checks every server signs both engines' states in. Within a world the serial specs
still run one at a time. Every other run, serial·webkit and local runs included, keeps one world.

CI runs the suite as separate legs, one per group and engine (`e2e/projects.ts`,
`scripts/ci-legs.ts`), in a scheduled or manual run. The `perf` project is the `alone` group, which
no CI leg runs (performance is not tested in CI). Locally it runs with `E2E_GROUP=alone`, alone on
the machine. `exclusive` is a leg of its own in CI, Chromium only, and runs without `perf`.

### Authentication

- **Chromium performs real WebAuthn ceremonies** through the DevTools Protocol's virtual
  authenticator (`e2e/webauthn.ts`: CTAP2, internal transport, resident keys, user verification;
  presence answered automatically). No Chromium test uses an auth bypass.
- `global-setup.ts` mints each run's setup token and gives the server only its SHA-256, as in
  production. The `setup` project opens `/setup?token=…`, creates the passkey, checks the
  recovery codes (copy, download, acknowledgement) and saves `e2e/.auth/chromium.json`
  (git-ignored) — the state every Chromium spec starts from.
- That shared session is fresh only for 5 minutes after setup (step-up, docs/security.md), so
  specs that change passkeys, codes or devices sign in for themselves: right after setup the
  `setup` project registers **one owner passkey per worker** and exports it from the virtual
  authenticator (`e2e/.auth/owner-passkeys.json`, git-ignored). `signInAsOwner` (e2e/webauthn.ts)
  imports the worker's passkey (its counter picked up from Postgres; one per worker, so no two
  tests use one at once), clears the context's cookies (never rotating the shared session) and
  signs in from the sign-in screen: a real ceremony and a fresh session.
- **WebKit has no virtual authenticator**: `setup-webkit` mints a session through
  `POST /api/test-support/session` (exists only with `ENABLE_TEST_ROUTES`, which env validation
  refuses on any hosted deployment). Passkey specs skip on WebKit with that reason; passkeys on iOS
  (Chrome for iOS, WebKit engine) are part of the real-device checklist below.
- Signed-out specs use `test.use({ storageState: signedOut })`.
- Conditional UI: Chromium's virtual authenticator answers a conditional (autofill) request at
  once, so `/` signs in without a tap when the authenticator holds the owner's passkey. One test
  proves that path; the others hide conditional mediation (`isConditionalMediationAvailable →
false`, as in browsers without it) to drive the button.
- State-changing requests from the `request` fixture send the app's `Origin` (`SAME_ORIGIN` in
  `e2e/support.ts`), as browsers do; without it the server refuses them (CSRF).

Specs:

- `auth.setup.ts` — first-run setup with a real passkey: 404 without the token, and still a 404
  (even with the token, no `app_errors` row) once the setup rate limit is spent; axe in both themes
  on the setup and recovery-code screens; name required; 10 codes in the expected format;
  download and copy contain them; Continue only after acknowledgement; the authenticator holds a
  discoverable credential; only hashes in Postgres; `/setup` is a 404 afterwards, even with the
  token; then the per-worker owner passkeys are added.
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
  and change nothing. Every `/api/test-support/*` handler starts with the `testRoutesEnabled()`
  404 guard; the program fixture route needs an owner session and refuses a cross-site POST. A
  cross-site POST to a session's `?/move` is a 403 and changes nothing, while the same request
  from the app runs and returns its field error (400).
- `reauth.e2e.ts` — step-up: a session whose last passkey use is over 5 minutes old cannot
  remove a passkey (the form action answers 403); on the screen a **Confirm it's you** sheet
  opens over the remove sheet (axe in both themes), a failed Face ID check says nothing was
  changed, and a passing one (Chromium's virtual authenticator) removes it without another tap
  and refreshes the session. WebKit has no virtual authenticator: there, signing out a device
  from the test-minted session shows the prompt, and cancelling changes nothing and says so.
- `sessions.exclusive.e2e.ts` (runs last) — sign out everywhere else ends every other session,
  not this one; the last passkey cannot be removed (button disabled, server answers 409).
- `signout.e2e.ts` (WebKit) — M2 acceptance 6 on the iPhone's engine, on a session minted for
  this test alone: sign-out clears the cookie, every cache but the versioned shell, every
  IndexedDB database and session storage, sends `Clear-Site-Data: "cache"` and keeps the theme
  preference.
- `signout-pending.e2e.ts` (WebKit) — sign-out with unsynced workout changes, from Security and
  from the recovery screen's Cancel: it flushes first, then asks with the count; "Stay signed in"
  keeps every change. A signed-out URL without the one-shot marker keeps only unsynced changes
  and offers to delete them.

- `shell.e2e.ts` — the sign-in screen is the landing page (signed in, `/` goes to Today); bottom nav pinned to the bottom with ≥ 44 px targets, each tab
  64 px wide; a canvas bar with no blur; four tabs, current in text colour and 600; no console
  errors on any screen; plate calculator sheet (stepper; Escape while typing cancels the edit
  without closing the sheet; a target below the bar is explained and the stepper's minimum is the
  bar; the kg/lb switch stays local to the calculator; Close returns focus); Profile is one list
  (You, Training, Security) with each row's answer, 60 px rows, About this app with Backups first,
  no account card; phone and desktop; theme applied before first paint and persisted (under the
  CSP), and Auto following an OS appearance change while
  open (theme-color included); no screen scrolls sideways; nothing
  sits under fixed chrome at rest (landing CTAs, Coach composer); compact segmented controls keep
  a 44 px hit area. The root error page, loaded on demand: a server-rendered 404 hydrates
  without the view rendering again, an error offline right after hydration shows the designed
  offline state, a held chunk shows the error once it arrives, and an aborted chunk shows the
  fallback with a 44 px "Try again" link.
- `plate-calculator.e2e.ts` — Train's lazy plate-calculator sheet (no service worker, chunks
  routed): its code is not in Train's load and arrives on the first tap, through the import
  alone (no modulepreload tag, whose failure WebKit would keep: `build.modulePreload` in
  `vite.config.ts` gives no lazy import one), which opens the sheet once it does (the row busy
  meanwhile); a failed fetch on hover says nothing, a failed tap shows
  a Retry notice under the row (44 px target, axe in both themes) that a later failed prefetch
  leaves in place; Retry back online opens the sheet, offline the notice stays, a tap that fails
  again online reloads Train with `?tool=plates`, and leaving Train mid-retry stays left (WebKit).
  Every spec in the file ends by unrouting (`page.unrouteAll({ behavior: 'ignoreErrors' })`), so
  a script still loading at its end cannot fail it with `Response has been disposed`.
- `platform.e2e.ts` — `/api/health` reports `db: up` (and the Profile screen shows it);
  `Server-Timing`, request id and security headers; exactly one preloaded font (Mona Sans
  latin); manifest + icons;
  CSP header contents and enforcement (an injected inline script is refused); service worker
  activates and precaches the shell (not the icons); `POST /api/vitals` stores a row (verified in
  Postgres) and rejects invalid metrics; real browser RUM beacons arrive; vitals are attributed to
  the screen where they happened (client-side navigation, INP on Train); an uncaught exception
  and an unhandled rejection in the browser are reported and stored as `client` rows with their
  route; a server error returns a safe message and is recorded with its request id.
- `offline.e2e.ts` (Chromium) — the first visit is controlled by the service worker without a
  reload; offline, every tab keeps the shell (screens without server data render; Train and
  Profile need server data, so each shows the designed offline state, never a 500), a full reload offline gets the offline screen in the
  shell, and back online the screen loads live data; no dynamic page is ever cached.
- `design-inputs.e2e.ts` — the input primitives on `/design` → Inputs. NumberField opens
  the decimal (or, for whole numbers, numeric) keypad with an `enterkeyhint`, keeps digits and
  one decimal point as typed ("8a2,5" → 82.5), drops the point for whole numbers and stays
  blank, never 0, when cleared; its name is the label and its description the unit plus the
  message on screen. TextArea: label, Optional marker, `maxlength` (growth with `field-sizing` is
  asserted on Chromium only). The date TextField takes `fill('2027-03-14')` and stays 56 px tall
  blank or filled. Errors set `aria-invalid`, are announced (`role=alert`) and replace the hint,
  and every id in `aria-describedby` exists. ChoiceGroup: the legend names the group, a single
  choice is one tab stop that arrow keys move, Space toggles each of several, the value keeps the
  options' order whatever order they were tapped in, an optional choice's "Any" stores `null`, a
  selected pill shows its tick and a selected card its filled mark, every option is ≥ 44 px, and
  an error is announced with `aria-invalid` on every input. DayPicker: seven checkboxes named
  Monday…Sunday in order, a picked day shows its tick, a Monday-first value (Sunday then Monday
  ticked), and at 393 px inside a padded card every hit area is ≥ 44 × 44 px, owns its edges and
  never overlaps a neighbour; its error is announced and also shown as a danger border on the
  days still open. Toggle: a `switch` named by its title alone and described by its
  description, ≥ 44 px, the title, description and track all its hit area, flipped by a tap on
  the title and by Space. TagInput: Return and Add add the trimmed text and clear the field
  (Add stays disabled while it is blank), a repeat in any case is refused and the text kept,
  remove buttons are named "Remove …" with a 44 × 44 px hit area, a suggestion adds in one tap
  and leaves the list, `maxlength` and `max` hold and are announced, keyboard focus survives a
  removed button, and the status region says "Added …", "Removed …" and every refusal, even
  the same words twice (a recorded live region shows them cleared and set again).
- `profile-equipment.serial.e2e.ts` (serial: `resetTrainingProfile()` before each test;
  `E2E_SERIAL_ALONE=1` runs it right after setup) — Profile lists Equipment, which opens
  `/profile/[section]`; a save survives a reload and is in Postgres, and keyboard focus stays on
  Save; offline, Save says so and keeps the edit; a failed editor chunk (never a modulepreload,
  which WebKit would keep failing across the reload) shows Retry, which loads it; the editor
  replaces its skeleton without moving anything; unsaved changes ask before leaving (link, tab
  bar, Back); Back before the next screen has rendered (every browser made to start its view
  transition 1.5 s late, as WebKit can) comes back to the saved section, never covered by the
  overtaken screen; an unknown section is a 404. `a11y-suite.ts` audits the screen and its discard
  prompt in both themes.
- `a11y-dark.e2e.ts` and `a11y-light.e2e.ts` (one theme each, the same tests from
  `a11y-suite.ts`) — axe-core (`@axe-core/playwright`, WCAG 2.1 A/AA) on every screen (Security
  included; the signed-out sign-in and recovery screens too), the plate-calculator sheet and each
  `/design` component group, in the **dark and light** themes (Lighthouse only audits dark). The
  setup, recovery-codes, new-passkey and sign-in-error states are audited in both themes where
  they occur (`auth.setup.ts`, `auth.e2e.ts`). Zero violations required.
- `perf.e2e.ts` (Chromium, `perf` project) — the page-load budget on the app's screens. The
  budget lives in `e2e/load-budget.ts`: real long tasks at 4× CPU while each screen loads, median
  of 5 cold loads; target ≤ 200 ms, fails above 250 ms (docs/performance.md).
  `perf-workout-load.e2e.ts` holds the workout screens to the same budget (docs/testing.md,
  "Workouts (M4)" → Performance). The `perf` project runs alone, with one worker, after the
  functional suite, so parallel specs cannot skew it; CI does not run it (performance is not tested
  in CI). App
  screens load signed in, `/` signed out. The program screens are seeded through the fixture
  route: Train, the week's longest strength session and History on the hybrid program this week,
  Today in its Build-card state (onboarding complete, no program) and its program state (the
  `'today'` fixture). Each of those is also held to an unexplained layout-shift sum ≤ 0.01 on
  every load (`MAX_SHIFT`). Run it by itself with
  `E2E_PERF_ALONE=1 pnpm test:e2e --project=perf` (owner setup, then the budget).

Artifacts: failure screenshots + traces in `test-results/`, key-screen screenshots in
`test-results/screens/<project>/`, HTML report in `playwright-report/` (all uploaded by CI).

### Desktop

The helpers in `e2e/desktop.ts` (docs/design-system.md, Responsive layout → Verification) are
proven by `desktop-helpers.desktop.e2e.ts` on `page.setContent` fixtures with no server state:

- `DESKTOP` is a 1440 × 900 window with a mouse and no touch, at scale 1.
- Every width in `DESKTOP_WIDTHS` (1024–1920) is a desktop page that does not scroll sideways;
  `BELOW_DESKTOP_WIDTH` (1023) is not, and there `expectNoSideScroll` fails on content 1100 px
  wide.
- `layoutShiftDuring` measures an inserted block, and throws where no layout-shift entries are
  reported. WebKit reports none, and the serial specs run their desktop cases on WebKit too, so
  a swap is checked with `expectNoShift`: it needs the boxes the layout reserves and catches a
  shift the boxes miss, and without layout-shift entries it checks the boxes alone
  (`expectStableBoxes` fails on a 10 px move or growth) and adds an annotation saying so.
- `tokenPx` and `expectMainCentred` check `<main>` against the rail at its token's width;
  `expectCentredOver` fails a bar that is 20 px off or too wide; `expectInColumn` fails a fixed bar
  that spans both columns; `pixelAt` reads the colour of the pixel it is given.

The desktop specs (most also run axe and take screenshots in both themes):

- `shell.desktop.e2e.ts`: from 1024 px the Primary navigation is a full-height rail on the canvas
  with a hairline at its right and no brand mark (`--rail-width`, no blur, nothing fixed to the
  bottom edge, the avatar at its foot and current on Profile) with the four tabs and Profile's avatar
  in order, one `aria-current`, tabs at least 44 × 44 px, a hover that lifts the text, and the
  32 px avatar with a hit area 5 px past its edge. The document order is skip link
  → rail → content; Tab follows it with a ring of at least 2 px on every stop, and the skip link
  lands in `<main>`. The rail requests nothing a phone does not. `<main>` is the readable column
  beside the rail (at 1440 px 616 px wide, 172 px from the rail, its title at 288 px), and
  `data-layout` wide or split widens it to `--content-wide`. Coach's composer and Security's offline sign-out toast are centred over it,
  and /design's toast in the window. No tab scrolls sideways at 1024–1920 px, the bar is
  back at 1023 px, every tab gets the readable column at 800 px, and Coach reloads offline from
  the precache with a working rail.
- `screens.desktop.e2e.ts`: the sweep that misses no main screen. Each loads without moving,
  scrolls nothing sideways, sits beside the rail (or centred outside the shell) and logs no
  console error.
- `auth-screens.desktop.e2e.ts`: every state of `AuthScreen` in the right-hand card: signed out;
  a refused passkey and a wrong recovery code (the spec then deletes the `recovery:ip:` counter);
  no passkey support; an address passkeys cannot use (the refusal `relyingPartyFor` gives
  127.0.0.1, passed as route data because the e2e server pins ORIGIN, with the service worker
  blocked); and a recovery session minted through the test route and switched to `recovery` in
  SQL, so no code is burned. `auth.setup.ts` checks setup and its recovery codes at that size by
  resizing the same page, then asserts the iPhone viewport is back.
- `primitives.desktop.e2e.ts`: `BottomSheet` as a centred dialog from 1024 px (Escape, backdrop,
  focus return, no mouse drag, 1024 × 700); a `desktop="panel"` sheet as a 496 px full-height
  right panel over a clear backdrop, closed by Escape or a click beside it, focus returned; Tab
  order and a ring of at least 2 px in dark, light
  and forced colours; hover on every primitive; no hover and 44 px targets on a 1180 × 820 touch
  screen; a phone swipe; and Security's stacked step-up over Remove passkey.
- `main-screens.desktop.e2e.ts`: Progress wide, its view nav and period picker in one row over
  the view (whose own layout `progress.serial.e2e.ts` checks); Coach's suggestions in two columns under a composer centred over the readable
  column (one column at 1023 px); Security in the readable column beside the rail, its four
  sections and Sign out read and Tab in order; /design up to `--content-wide` with Color beside
  Type (one column at 1023 px); a 404 inside the shell, a 404 outside it and /offline centred.
- `profile-desktop.serial.e2e.ts` (`resetTrainingProfile()` before each test): Profile in two
  columns; each section's editor beside `ProfileList` (the open section `aria-current`), Save as
  column chrome, the discard prompt from the list, the centred goal sheet, Tab list → editor →
  Save; the skeleton (`expectNoShift`), a chunk error with Retry, an offline save and the 404; on
  an iPhone, the 28rem skeleton and the fixed Save bar.
- `onboarding-desktop.serial.e2e.ts`: every step a card centred in the window, walked welcome →
  review with the keyboard alone; Back, Skip and Continue in view under the form; no shift between
  steps (card and action row); the offline and no-goal notices in the card above the actions,
  taking focus; the review in two columns, its Edit returning to it.
- `train-desktop.serial.e2e.ts`: Train readable. The top line, the week's lines, its one line
  and More share the column's left edge, nothing right of it; a line's hover and focus ring, Tab
  from the arrows through each session to the week's line and More; the plan as a centred dialog.
  Every designed state at the column's top: a week loading (`expectNoShift`), a failed load and
  Try again, offline, no program, rest day, not started, beyond the plan, block complete, and both
  lazy chunks failing with Retry under their rows in More.
- `train-detail-desktop.serial.e2e.ts`: the session detail (wide: the side column beside the main
  one, centred edit sheets) and History (split: the list beside the version in the URL), with
  every designed state.
- `today-desktop.serial.e2e.ts`: Today in every state (setup, ready, the program's session day,
  rest day, starts Monday and block complete, a failed read, offline, a panel's chunk failing) and
  Build my program's pending, generator-failure, profile, library, new-day and offline states;
  Start week 1 as column chrome; no shift as the plan replaces its skeleton.

## Training (M3)

One subsection per M3 track. Each slice adds to its own subsection only.

### Foundation & catalogue

Unit tests (`src/lib/domain/training/`, `src/lib/domain/exercises/`, `src/lib/domain/calendar.ts`):

- **Vocabulary:** every list has unique snake_case keys, each with a label, and a new list fails
  the test until it is listed there; every muscle is in exactly one hard-set group and no group
  is empty; `skillForExperience` and `fromCommitmentIntensity` cover every M2 value, in order;
  every session type has an M2 discipline tone; no list shadows or copies an M2 catalogue list
  (load bases are M2's baseline kinds themselves); every M3 decision kind and M4 substitution
  reason is listed; a closed list changes only together with the migration that CHECKs it.
- **Calendar dates:** month, year and leap boundaries (century rules included); Monday-first
  weeks; ISO week 53 and week-numbering years; `daysBetween` across year ends; the same answers
  in any process time zone, across daylight saving.
- **Catalogue format:** a valid table parses (unilateral and time-measured entries, padded
  cells); each of these throws, naming the file, the line and the entry: an unknown pattern,
  muscle, equipment, skill, tag, discipline, lift, measure or load type; reps that run high to
  low, are zero or are not numbers; reps or seconds on the wrong measure; a time measure without
  seconds; `uni` other than `y` or `-`; a duplicate key; a wrong column count; a missing header.
- **Catalogue data and matcher** (`integrity.test.ts`, `match.test.ts`): keys unique across
  parts; names and aliases distinct after the matcher's normalising, each matching its own entry;
  only M2 equipment keys; each group defined in one part, with an intent and ≥ 2 members sharing
  its pattern (and, in part 1, its measure); default seconds exactly on time-measured entries;
  each M2 lift linked from at most one entry. Part 1 has ≥ 75 entries, flags split squats,
  lunges and single-leg work unilateral, tags barbell squats, hinges and Olympic lifts
  `spinal_loading`, gives squat, hinge and single-leg work ≥ 2 dumbbell-only and ≥ 1 bodyweight
  options, links its six M2 lifts and matches M2's lower-body and conditioning suggestions. The matcher ignores case, accents, punctuation, spacing and plurals, and gives
  null, never a guess, for unknown text, part of a name or a name two exercises share.
- **Whole catalogue and part 2** (`integrity.test.ts`, `match.test.ts`): ≥ 150 entries, ≥ 3 per
  movement pattern, and the brief's categories (barbell, dumbbell and bodyweight ≥ 15, machine,
  cable, plyometric and conditioning ≥ 8, kettlebell and Olympic ≥ 6, mobility ≥ 10);
  conditioning and mobility never counted in reps; Olympic lifts intermediate or above; every M2
  lift but `custom` linked; every M2 suggestion matched or on `NOT_EXERCISES`, which the matcher
  never matches whatever the library holds ('Running intervals': running is run segments).
  Part 2 has ≥ 75 entries and one measure per group, flags single-arm rows and presses, offset
  carries and rotation work unilateral, tags the standing barbell presses and the barbell row
  `spinal_loading`, tags every overhead press `overhead` and no horizontal push, keeps the
  landmine press's group `shoulder_friendly` and off `overhead`, gives horizontal and
  vertical push and pull ≥ 2 dumbbell-only options (a bench allowed), links bench press,
  overhead press and weighted pull-up, and matches 'Bench press', 'Overhead press', 'Pull-ups'
  and 'Dips'.
- **Plain Node** (`scripts/catalogue-node.test.ts`): Node with type stripping alone, as the seed
  runs, loads `src/lib/domain/exercises/index.ts` and sees the catalogue Vite sees; an
  extensionless import fails there, which is why the package uses `.ts` specifiers.
- **Program-plan contract** (`training/schemas.test.ts`, `validation.test.ts`,
  `scripts/training-index-imports.test.ts`): a minimal hybrid plan (intervals, a Muay Thai class,
  a strength session, an outline block) passes `programPlanSchema` unchanged and each part passes
  its own schema; every rule (load-kind coherence, one measure per set, RPE in half steps, rep,
  pace and repeat groups, metrics, commitment refs, block and week dates, sessions in their week,
  decision refs) fails at its dotted path; each schema's type equals its contract type (checked by
  `pnpm check`); `validate()` is the function the profile schemas re-export; and the runtime
  imports reachable from `domain/training/index.ts` include no schemas, edits or zod, with the
  walk shown to catch a re-export, a zod import and an inline `type` import.
- **Plans in words** (`training/describe.test.ts`, on fixtures the contract's schemas accept):
  sets × reps or a range, a held time or metres, @ RPE when set; only an RPE-based top or ramp
  set reads 'Work up to a set of 5 @ RPE 7' with the recording instruction; every load kind in kg
  and lb, each computed load exactly M1's `roundToIncrement` to `DEFAULT_LOAD_INCREMENT`, none
  when it cannot be computed (RPE-based, from_e1rm before an estimate), percent_1rm from its own
  snapshot, and an estimated 1RM never called measured; rests through `formatDuration`; segments
  in km and mi (paces by `convertPace` or implied by `paceSecondsPer`, HR-zone or RPE targets,
  repeat groups as one step); session lines for strength, timed and distance runs and every
  other-session kind, with M2's time of day but never 'varies'. `describe.ts` imports only
  domain modules and no package (`scripts/training-index-imports.test.ts`).
- **Training metrics** (`training/metrics.test.ts`): a set's e1RM is M1's `estimateOneRepMax` in kg
  (with and without an RPE, pounds converted exactly) and none for warm-ups, skipped sets and RPE
  under 6; the best e1RM is always an estimate; best e1RM and rep records give a tie to the latest
  set in any order, and rep records ignore warm-ups; bench is 1 hard set for chest and 0.5 for
  triceps and front delts, RPE-6 and warm-up sets never count, a group is credited once per set and
  weeks split on the owner's Monday; planned and logged hard sets agree on the same sets, and runs
  and classes (a strength class included) credit none; session load is M1's `sessionLoad` for logged
  and planned sessions; weekly distance mixes km and mi exactly, free of floating-point noise, and
  keeps a Sunday-evening run in its week.

### Schema

Migrations, the CHECKs on closed vocabularies and the history guards on real Postgres.

- **Programs** (`tests/integration/training/program-schema.test.ts`, ADR 0010): UPDATE and DELETE
  are refused on every program table, in or outside a transaction, so deleting the owner is
  refused too; a program head moves only forward to its own version and changes nothing else;
  one active program per owner; a week is exactly 7 days; status, plan status and `decided_by`
  are CHECKed while phase and decision kind stay open; deleting an M2 goal leaves programs
  intact; `truncate programs cascade` and `withCommitted` purge a whole program. The unit test
  `scripts/history-guards.test.ts` keeps `truncate`, `session_replication_role` and
  `disable trigger` out of server code.
- **Exercise library** (`tests/integration/training/exercise-seed.test.ts`): after the global
  setup's migrate run every catalogue entry is stored exactly as defined (unilateral and default
  seconds included); a rerun reports no change and leaves `updated_at` alone; a new key is inserted
  and a changed entry updated in place, keeping its id; a removed key is retired, readable by id,
  and restored with the same id; custom rows are never touched, cannot take a key and are unique per
  owner by lower-cased name; measure, skill level, load type, reps, seconds and primary muscles are
  CHECKed while pattern stays open; the catalogue survives `withCommitted` (custom rows have no
  owner FK, so they survive it too and the test removes its own). `scripts/catalogue-node.test.ts`
  also loads `migrate.ts` under plain Node, as `db:migrate` does, and checks that the seed and both
  catalogue parts load with it.
- **Prescriptions** (`tests/integration/training/prescriptions-schema.test.ts`, ADR 0010): a planned
  week's strength exercises and set prescriptions (every measure and load kind, a superset, a swap,
  a custom exercise), an interval run (warm-up, 6 × (400 m + 90 s), cool-down) and a Muay Thai class
  with metrics round-trip in order, and a computed fraction (0.863 × 0.9) is stored exactly. One
  shared table of values, grouped by CHECK, is refused alike by the CHECKs and the contract's zod
  schemas, and its edge values (every `PRESCRIPTION_LIMITS` bound, and the caps only zod holds) are
  accepted by both. Every CHECK on the four tables is in that table, positions aside. Positions are
  unique from 1, with one details row per session. UPDATE and DELETE are refused on every
  prescription table. `truncate programs cascade` purges them and keeps the exercises. An exercise a
  plan prescribes or swapped out cannot be deleted.
- **Training log** (`tests/integration/training/log-schema.test.ts`, ADR 0010): a device id
  (`client_id`, `client_mutation_id`) is stored once in every table that takes one, and a run or
  other-session record once per workout, so a replay is a conflict (`ON CONFLICT DO NOTHING` keeps
  the stored row). 225 lb keeps its value and unit beside an exact `weight_kg` of 102.05828325, and
  runs and segments get their pace. An UPDATE that changes a row writes one audit row (before,
  after, owner, actor from `app.actor`, 'owner' by default) and moves `updated_at` to the
  statement's time, whatever the statement sets. An UPDATE that changes nothing (a value written
  again, a generated column worked out again, `updated_at` alone) writes no audit row and keeps
  `updated_at`. An unknown actor is refused. A soft delete and a restore are audited once, and a
  replayed delete writes nothing. DELETE is refused on every logged table, so deleting the owner is
  refused too. `training_audit` refuses UPDATE and DELETE. One shared table of values per CHECK is
  refused, its edge and open-list values are accepted, and it covers every CHECK on the log. Logged
  sets and substitutions keep their exercises (ON DELETE RESTRICT). Every history index has its
  exact definition. Every logged table has its touch, audit and refuse-delete triggers, and none
  fires on TRUNCATE. `withCommitted` clears committed workouts, sets and audit rows.
- **Coaching memory** (`tests/integration/training/coaching-schema.test.ts`): preference links and
  sources (including replaying the committed migration on an M2 row), the
  one-preference-per-exercise index, the proposal lifecycle CHECKs, weekly and cycle review
  uniqueness, and owner FKs on every coaching table.

### Programs

The program store, program reads, versioning and owner edits, on real Postgres.

- **Exercise library service** (`tests/integration/training/exercises.test.ts`):
  - Lists hold every live catalogue row exactly as defined, plus the owner's own exercises and never
    another owner's (who may reuse a name). They come by name whatever plan Postgres picks, and
    filter by pattern or substitution group; a custom exercise joins its group.
  - A retired row (a catalogue key another preview's seed retired, or a custom exercise the owner
    retired) leaves the lists but stays readable by id. `resolveKeys` still resolves a retired key.
  - Retiring twice keeps the first retirement. Creating a retired exercise's name again brings it
    back with the new definition and the same id.
  - Creation writes nothing and gives field errors for bad input (a timed exercise without seconds
    included), for a name or alias the catalogue or the owner already uses (any case, any plural),
    and for a substitution group that does not exist or whose pattern or measure differs. Input
    never sets a key, an owner, a lift or a retirement.
  - A malformed, catalogue or stranger's id is not found, never a database error. A double-tapped
    create waits on the owner's lock and gets field errors, never a unique violation.
  - Free text resolves by name or alias, the owner's own included, and gives null for unknown text,
    part of a name, another owner's exercise or a retired one.
  - `src/lib/server/services/training/shared.test.ts` (unit): `parseWith` throws a
    `TrainingInputError` keyed by dotted path; every conflict is a `ConflictError` with its reason;
    deps act for the owner unless told otherwise.
- **Program store** (`tests/integration/training/program-store.test.ts`, the fixtures in
  `src/lib/server/test-support/program-fixtures.ts`): the brief chain (owner, goal and Muay Thai
  commitment through the M2 services → `createProgramFromPlan` → program, version 1, blocks and
  weeks) reads back deep-equal to the plan, ids and lineages aside. Strength (ordered exercises and
  set prescriptions), an interval run (repeat groups) and a Muay Thai class (metrics, evening,
  second in its day) coexist in one week, each in its own table. Decisions store the lineages their
  plan paths name. An invalid plan (RPE 11; a session outside its week) is a `TrainingInputError` at
  its dotted path and writes nothing; so is an unknown key, another owner's exercise or a catalogue
  row's id sent as a customId. A retired key and the owner's own exercises, swaps included, resolve.
  Another owner, a malformed id or an unknown version number is not found. A second active program
  is refused, except a repeat of the same fingerprint before any revision; a plan without a
  fingerprint never repeats; an archived program no longer counts. Two builds racing on separate
  connections give one program. A 5-week plan (126 rows) and a 1-week plan (36 rows) each take the
  same 18 statements, at most 20. Every fixture passes `programPlanSchema` unchanged and stores as
  it is.
- **Program reads** (`tests/integration/training/program-reads.test.ts`): the current program's
  blocks, planned weeks (outline blocks count none), last planned day, and where an explicit today
  falls (week n of N, baseline, not started, block complete); a week by date and by block and week
  (weeks counting on from the block's start), Monday to Sunday, each session's line equal to
  describe.ts in the owner's distance unit; a date before the start gives week 1 with the first
  planned day; a week past the planned weeks is `planned: false` with the outline phase there, or
  none; malformed dates and indexes are input errors, and an unknown block, version or lineage is
  not found; a session by lineage with its exercise names and sets, segments or details; today's
  plan on a training day, a rest day, a Sunday (up next from next week), before the start, and after
  the one-week fixture's week (block complete, nothing up next), the same whatever the system clock
  says; 'completed' only from a completed, undeleted workout, with the planned row unchanged and the
  status carried into a hand-made version 2; version 1 still readable after version 2, saying
  whether the current version keeps each session; another owner, and an archived program, read
  nothing.
- **The owner's today** (`tests/integration/training/local-date.test.ts`): `ownerToday` is the day
  in the profile's time zone, not the server's or UTC's. It turns over at midnight in London in GMT
  (2026-03-28T23:30Z → 2026-03-28) and BST (2026-06-30T23:30Z → 2026-07-01), in Auckland in NZDT
  (2026-11-05T10:59Z → 2026-11-05, 11:00Z → 2026-11-06), in UTC for a profile that never recorded a
  zone, and follows a zone the profile changes.
- **Versioning** (`tests/integration/training/program-versioning.test.ts`, ADR 0010): every row
  version 1 reaches is snapshotted as JSON and is identical after three revisions, and
  `getVersionWeek(1)` still reads the original week; a revision adds exactly one week's subtree (one
  count per table) and shares every other week by id, with lineages carried; its changes land in
  every child table of the copy; a stale base is a `ProgramConflictError` before the edit runs, and
  a failing edit or a change outside the copied weeks writes nothing; a completed session stays
  completed in the new version; each revision writes one decision with its version and lineages;
  History lists v3, v2, v1 with their decisions resolved to titles and dates, and 25 versions page
  as 20 + 5 with no gaps; two concurrent revisions on separate connections (`withCommitted`,
  `holdTransaction` + `lockWaiters`) leave exactly one version 2; a `pg_constraint` check fails when
  a table added under a week, session or planned exercise is not part of the copy.
- **Move and skip** (`tests/integration/training/edit-move-skip.test.ts`, through `reviseProgram`):
  Mon → Wed as version 2 (moved, `moved_from` Monday, version 1 unchanged row for row, week 2
  shared, decision 'Moved Lower A from Mon to Wed' with the reason); the no-reason why naming who
  decided (owner and coach); `moved_from` kept from the first move, order on the new day by time of
  day, and planned again back on its day; heavy lower body moved to the day before sparring, with
  `heavy_lower_before_hard` and `hard_days_apart` returned, recorded in the why and given first by
  `checkMove` (a pair already in the base version is not reported); `BLOCKS_EDIT` turning 'avoid'
  into a refusal; field errors for a destination outside the week or before today, a session before
  today, a completed or skipped session, and a full day; a stale version as a conflict, for
  `checkMove` too; `getMoveTargets` for a Sunday session (empty on Sunday, Wed–Sat on Wednesday);
  and a long why fitted to 1000 characters. The edit schemas are unit-tested in
  `src/lib/domain/training/edits.test.ts`.
- **Exercise preferences** (`tests/integration/training/preferences.test.ts`): a Profile save links
  the owner's words to the library (catalogue names and aliases; unknown text stays unlinked) with
  its source; two names for one exercise ('RDL', 'Romanian deadlift') are a field error at `items`
  and write nothing, counting a kept row's stored link; a swap dislike keeps its source, link and
  reason through Profile saves that keep it and is deleted when removed; `recordExercisePreference`
  upserts by link or name; a swap dislike and a Profile save on two connections serialise on the
  preferences lock (`withCommitted` + `holdTransaction` + `lockWaiters`), in both orders.
  `e2e/preferences-link.serial.e2e.ts`: liking RDL and Romanian deadlift in Profile → Exercises
  shows the duplicate notice, and a reload shows nothing saved.
- **Swap and adjust** (`tests/integration/training/edit-swap-adjust.test.ts`): alternatives by
  equipment and dislikes, with an explained empty list; a one-off swap saves no preference, while
  'never again' saves one dislike and swaps from today; strength, run and other-session adjustments
  are validated, versioned and get their minutes and load worked out again.

### History

Logged training, the history queries and `pnpm db:explain`.

- **History queries** (`tests/integration/training/history.test.ts`, fixtures in
  `tests/integration/training/fixtures/history.ts`):
  - An exercise's history pages newest first with no duplicate or gap at any page size, including
    two sets in the same millisecond and two at the same instant. Warm-ups and skipped sets are
    flagged; deleted sets are left out.
  - The last N performances are the last N workouts with a working set, each with all its working
    sets in order.
  - PRs and best e1RM, for one exercise and for all, ignore warm-up, skipped and deleted sets and
    equal the domain's `bestE1rm` and `personalRecords` on the same rows. Retired catalogue and
    custom exercises are included; exercises with no qualifying set drop out.
  - Weekly hard sets equal `hardSets`. Weekly mileage mixes km and mi runs and equals
    `weeklyDistance`. Both split Monday to Sunday on the owner's local dates, so a Los Angeles
    Sunday evening stays in its week.
  - Sessions in a range list the current version's strength, run and Muay Thai sessions (completed
    from logged workouts) and the workouts logged on those days, dated by the owner's calendar.
  - Another owner sees nothing, even given the owner's ids. Bad input is a field error, and a
    malformed exercise id is not found.
  - Every index that `HISTORY_INDEXES` names exists.
- **Logging workouts and sets** (`tests/integration/training/log-sets.test.ts`): the training log's
  write path and replay contract: creates are idempotent on device ids (duplicate and matches, the
  stored row wins, one row under a two-connection race in `withCommitted`), absolute edits leave no
  trace on replay, deletes are soft and idempotent, the e1RM is recomputed on edit, audit rows are
  checked by row_id, and a substitution writes no exercise preference.
- **Runs, other sessions and recovery notes** (`tests/integration/training/log-runs-other.test.ts`),
  under the same replay contract: a run with a warm-up, 6 × interval/recovery and a cool-down stored
  in position order with generated paces; 5 mi stored as exactly 8046.72 m; a replayed run gives one
  run and one set of segments (also under a two-connection race in `withCommitted`), and a differing
  run or segment returns `matches: false` and changes nothing; Muay Thai sparring with its rounds
  metric round-trips, and a bad metrics shape is a field error before the database's CHECK; one
  recovery note per mutation id; edits to runs and notes are audited once by row_id, and replayed
  identical edits write nothing.
- **Query plans** (`pnpm db:explain`, `scripts/explain/history.explain.ts`; CI runs it after the
  integration tests): every builder of `db/queries/{history,programs}.ts` is explained (ANALYZE,
  BUFFERS) on the two-year dataset; on a large relation (≥ 5,000 rows or ≥ 50 pages) the builder's
  declared index must be used and no Seq Scan appear, and small relations are recorded only
  (docs/performance.md, "M3 query plans"). Unit tests: `scripts/explain/plan-check.test.ts` on
  canned EXPLAIN JSON (a Seq Scan of a large relation nested under joins or in an InitPlan fails,
  the same plan on a small relation passes, an unused or nonexistent declared index fails, a Bitmap
  Index Scan counts as using its index) and `scripts/explain/dataset.test.ts` (the same seed gives
  the same counts and first rows; ≥ 600 workouts with ≥ 15k sets over about 40 exercises, ≥ 400 runs
  with ≥ 6k segments, ≥ 730 days, about 100 planned weeks in versioned programs, copy-on-write
  weeks).

### Generator

The deterministic week-1 generator: its rules, stages and scenarios. Unit tests in
`src/lib/domain/programming/`, on the seven profiles in `scenarios.ts` (beginner, powerlifter,
hybrid, injured shoulder, dumbbells only, the journey, the minimal onboarding profile), dated from
`SCENARIO_START`:

- **Input** (`input.test.ts`): a minimal profile (one goal and daysPerWeek) normalises and lists
  every default it applied (any day, no time of day, 60-minute sessions, the commercial-gym preset,
  and new to each discipline trained); a full profile lists only its commitments' missing duration
  and intensity (60 min, 90 for Muay Thai, and moderate); 'varies' is never a distinct time;
  achieved and dropped goals and inactive injuries drop out, paused goals are kept apart, all-paused
  gives maintenance, and disciplines follow goal priority; equipment is the gym-type preset ∪ ticked
  ∪ home kit; a linked preference and the same text unlinked give one key, and a key both liked and
  disliked is only disliked; 1RMs are in kg, estimated stays estimated and blank stays blank; empty
  specifics count as none; the profile with its rows and keys reversed gives the same input.
- **Fingerprint** (`input.test.ts`): unchanged by key order, timestamps, row ids, start dates and
  the time zone ('UTC' vs 'Pacific/Auckland'); changed by each of 17 meaningful edits, by one
  catalogue entry, by one custom exercise, and by a new `GENERATOR_ID`.
- **Hashes and tie-breaks** (`random.test.ts`): FNV-1a 64 gives the published vectors and matches a
  BigInt reference on UTF-8 text; canonical JSON sorts keys and refuses non-plain data; the
  catalogue digest ignores list order and row-only fields; `seededRandom` matches the published
  mulberry32, with outputs, picks and shuffles pinned.
- **Decisions** (`decisions.test.ts`): every `DECISION_KINDS` entry has a template in exactly one
  area file; every rendered decision has no placeholder left and passes `decisionPlanSchema`; a
  missing fact fails at compile time (`@ts-expect-error`) and at run time; the log lists decisions
  by kind, then in the order made; every default renders as a `default_assumed` decision that names
  its Profile section. `DecisionLog.retarget` is covered there too.
- **Eligibility and alternatives** (`avoidance.test.ts`, `eligibility.test.ts`,
  `alternatives.test.ts`):
  - Tables: every injury row and avoid phrase leaves out some of the catalogue but never half of it.
    Rows run mildest first, and no phrase is worded twice.
  - Injuries: an injury rules out its area's rows up to its severity, with one reason per injury,
    except for the catalogue's friendly tags. A resolved injury rules out nothing.
  - Avoid text: 'overhead pressing' leaves out the strict press, push press, jerks and handstand
    push-ups, and keeps pullovers, carries, the landmine press and horizontal pressing. A whole
    phrase reads as a kind of movement before it reads as a name ('Squats' vs 'Front squats').
    Phrases and exercise names inside longer text are read left to right ('Burpees and box jumps').
    The owner's own exercises match by name. Words that cannot be read come back unmatched, once
    each.
  - Eligibility: with dumbbells only, exactly the dumbbell and bodyweight work is eligible, and
    barbell, machine and cable work says 'Needs …'. A knee injury plus 'jumping' leaves out every
    plyometric. A disliked exercise is never eligible, even when liked or the only option, and the
    empty slot says why.
  - Ranking: likes come first and skill within experience next, for every seed tried. One seed
    always gives one order.
  - Alternatives: the group comes first, then exercises of the same or a related pattern with the
    same measure and a shared primary muscle, ranked by unilateral flag, load type and skill. The
    original is never offered. The back squat with dumbbells only gives the dumbbell squats, then
    split squats. The power clean with bodyweight only gives none, and blocked explains the
    equipment.
- **Day rule** (`demand.test.ts`): training days are `daysPerWeek` capped by the available days ∪
  commitment days; free days never go below 0, and commitments on 4 days with 3 a week give a
  `days.commitments_fill` decision; a running club counts toward runs and a strength class toward
  strength days; free days fill each goal's fewest by priority, then spare days go by turns up to
  each goal's most, then to mobility; a second session sits on a commitment day only at a second
  time (two distinct preferred times, or, with no time set, the other end of the day from a class
  with a set time) and sessions ≤ 90 min, otherwise the lowest-priority
  session is dropped (`session_dropped`) and a goal ranked between others gets a
  `priority_tradeoff`; empty availability means any day.
- **First block** (`blocks.test.ts`): no event gives baseline + 3 accumulation + deload, week 1 at
  RPE ≤ 7 and a deload with less volume; a fight in 5 weeks gives baseline, build and a taper; a
  marathon in 20 weeks gives a marathon base and an outline (build, peak, taper) ending on race day,
  two weeks each for a half; a meet in 16 weeks gives build, peak and a week's taper. Two events:
  the fight first shapes the block and the marathon's outline follows; the marathon first gives a
  marathon base whose last week tapers for the fight. A taper is the week holding most of the seven
  days before the event, never week 1; an event beyond the block is noted on its outline block; a
  past event shapes nothing; assumptions become `default_assumed` and paused goals `goal_excluded`
  (none when all are paused, which plans maintenance).
- **Strength splits** (`splits.test.ts`): general strength takes full body for 1–3 days, upper/lower
  for 4, push/pull/legs and upper/lower for 5 and push/pull/legs for 6, lettered when a day repeats.
  Powerlifting gets SBD at every count, weightlifting its two lifts, and athletic a power slot.
  Hypertrophy opens its main slots to the best fit. It is maintenance when a goal of another kind
  ranks first or every goal is paused. From two days, every layout trains squat, hinge, push and
  pull, and pulls at least as often as it pushes.
- **Exercise selection** (`selection.test.ts`): an injured shoulder gets no overhead work, and its
  overhead press gives way to a landmine press with an `exercise_substituted` decision naming the
  injury. A lift the equipment rules out gets a stand-in from its substitution group every day it
  comes up. Lift slots take compound work and accessory slots accessories whenever one is eligible.
  A like wins among equals, and a liked custom exercise fills its slot by key. A dislike never
  appears and gets `exercise_excluded`. An unfillable slot gets `slot_empty` with the reason, and an
  unread movement to avoid gets `unmapped_avoidance`. Each exercise appears once a day, and the same
  input gives the same week. Sets: the top set at the week's cap, back-offs a point under, other
  work at RPE 7 or the cap; reps clamped into the exercise's range; holds in seconds, carries in
  metres.
- **Time fit** (`timefit.test.ts`): `estimateMinutes` is the warm-up plus each set's work and rest,
  with a one-sided set done per side. A 59-minute session fits 45 by losing its accessories and one
  back-off set, never a top set. Shorter limits take every back-off before any other exercise, and a
  session too short for its top sets keeps them. Long runs and commitments are untouched; other
  sessions and runs are shortened. Sessions trimmed alike share one `time_trimmed` decision, split
  at 50 references, and its account stays short enough for the plan contract.
- **Strength stage** (`stages/strength.test.ts`): the brief's dumbbells-only, injured-shoulder and
  powerlifter scenarios. As many strength sessions as the day rule gives, and fewer when strength
  classes take days. Naive spacing over free days, then commitment days, and none before the first
  planned day. The same exercises every week at each week's RPE cap. Every scenario's strength
  sessions fit sessionMinutes after timefit.
- **Loads and progression** (`loads.test.ts`, `progression.test.ts`): blank 1RMs work up to 5 @ RPE
  7 with the recording instruction and from_e1rm back-offs at 90 % of the top set; a measured 1RM
  starts at 72.5 % × 5, under M1's `percentOfOneRepMax(5, 7)`; an estimated one starts a 2.5 % step
  lower and is never called measured; nothing in week 1 is above RPE 7.5; known-1RM loads rise +2.5
  % a building week under M1's table, and blank ones resolve through `loadForTarget`; the third
  accumulation week's extra back-off set still fits 60 minutes after timefit; the deload keeps 60 %
  of the sets at RPE ≤ 6; the rules stored as `BlockPlan.progression` round-trip as JSON and rebuild
  the same weeks; the beginner and powerlifter scenarios (deterministic, percentages ≤ 75 % in week
  1, decisions citing the maxes).
- **Volume** (`volume.test.ts`): every case runs through `generateProgram` and is compared with the
  same plan made without the volume stage (`STAGES` minus `volume`), so it checks only what the
  stage changed: weekly hard sets per major group in full-volume weeks (counted with
  `plannedHardSets`, a week above full volume against its ceiling × volume factor), pull ≥ push by
  movement pattern, the cut and bulk adjustments with their decisions, the `priority_tradeoff` when
  the session length keeps the range out, and the dumbbells-only and injured-shoulder rules for the
  work it adds. The hypertrophy cases plan without a season (`m3Plan`), where M3's band still
  applies; M7's own week ranges are tested in `generate-phasing.test.ts`.
- **Scenarios** (`scenarios.test.ts`, through `programming/index.ts`): the brief's five scenarios,
  the journey and the minimal profile, with assertions pinned to rules, never to exercise names.
  Beginner: 3 full-body sessions on non-consecutive days, RPE-based main lifts with the recording
  instruction. Powerlifter: squat, bench and deadlift at ≤ 72.5 % of the measured 1RM in week 1.
  Hybrid: classes on Tue/Thu, a weekend long run, no heavy lower body the day before hard Muay Thai
  or the long run, and the priority decisions. Injured shoulder: no `overhead` tag, with its
  decision. Dumbbells only: only the profile's equipment. Journey: rule-clean, both events named.
  Minimal profile: a 3-day plan on any days, the commercial-gym preset, 60-minute sessions and one
  `default_assumed` per assumption. For every scenario: each generated session except the long run
  fits `sessionMinutes` in every week after volume and progression; a longer long run carries its
  `running.long_run_length` decision; commitments keep their duration; nothing in week 1 goes above
  the RPE its purpose names except a commitment the purpose sets aside. Also: deep-equal plans for
  the same input and for reordered profile rows, with no clock or randomness; a Thursday start plans
  Thursday to Sunday only; no avoid finding a generated week keeps, judged by `evaluateWeek` with
  the real week before, without a clash-keeping decision citing it (one whose rule is in
  `CLASH_KEPT_RULES`, from `src/lib/domain/programming/decisions.ts`); every decision's kind is in
  `DECISION_KINDS` and has a rationale; the `program_purpose` words. The same holds for the
  scenarios planned from other Mondays (`generate-schedule.test.ts`). The schedule stage run again
  on its own plan changes no session and records only clash-keeping decisions, for every scenario.
- **Composition** (`generate.test.ts`, `index.test.ts`): the stages run once each in the documented
  order; every scenario composes into a plan `programPlanSchema` accepts, parsed before it is
  returned, and the same input gives byte-identical JSON; week 1 starts on a Monday and the first
  planned day falls in it; a stage that plans before a 'This week' start's first day or outside its
  week throws `GeneratedPlanError` with every dotted path. The public entry point exports exactly
  the generator, its input, the fingerprint and the checks.
- **Phasing and week bands** (`src/lib/domain/programming/generate-phasing.test.ts`): the phasing stage and the dose's RPE 8
  cap. A plan with no season comes back as it was, a dose that does not bite rewrites nothing,
  back-offs never go below RPE 5, the meet week is singles at RPE 7, and hypertrophyBlock's main
  lifts reach their top RPE. meetPrep's main lifts take each phase's reps and top RPE (accumulation, intensification,
  realization, taper), with measured, estimated and blank 1RMs loaded distinctly; realization and
  taper weeks halve the accessories. hypertrophyBlock's building weeks sit in their own setsPerGroup,
  rising until the deload, keeping the week before's exercises, with one decision per group naming
  the ramp. runnerLifter's strength as a secondary goal stays within the lower half of its band, with
  words that name the band on a cut and a bulk, and `heldBand` gives each mode doseBand's band.
  runnerLifter's strength at maintenance in a marathon peak stays
  within 4–10 on the maintenance split. Timefit still fits, plans are deterministic, and longSeason
  stays within PLAN_BUDGET.
- **Preview and build** (`tests/integration/training/programming.test.ts`): the brief chain through
  the M2 services (hybrid and minimal profiles), preview determinism, reproduction from the stored
  snapshot, dislikes and dumbbells-only equipment, the profile, library and start_date conflicts
  writing nothing, an idempotent double build across a time-zone change, and the refusal before
  onboarding is complete.

### Concurrent training

Commitments, running, interference rules and placement across disciplines. Unit tests in
`src/lib/domain/programming/`:

- **Interference rules** (`interference.test.ts`, on sessions the contract's schema accepts):
  `demandOf` reads heavy squats in a hard session, a compound lift at RPE 8 or 80 % of a 1RM at any
  session intensity, and 10 of `isHardSet`'s hard sets of leg work at any load as heavy lower body,
  but never mobility, an exercise without traits, warm-up or ramp sets, sets below RPE 7, or a leg
  accessory on a hard upper day; Muay Thai as hard combat when hard and sparring at any intensity, a
  light technical class as easy; a long run by type or from 90 minutes; intervals by type, an
  interval segment or a hard running club; and a hard commitment of every discipline by its
  discipline (a hard strength, athletic or custom class is very demanding). `checkWeek`: heavy
  squats on Monday before Tuesday sparring is 'avoid' and before a light technical class is not;
  heavy lower body the day before a long run is 'avoid'; intervals the day after a long run, a hard
  strength class or a day of two hard sessions are 'avoid', two days after or the day before are
  not, across a week boundary too; back-to-back hard days are 'prefer' only when the movable hard
  days could sit apart (five hard days, or days outside the open dates, leave them alone), and two
  fixed hard days in a row are taken as given while the others are still kept apart; on a shared day
  the time of day orders sessions when both have one ('varies' is none), an easy run before heavy
  lower body is fine, and heavy lower body before hard Muay Thai or a long run, or a very demanding
  session before intervals, is 'prefer'; messages name the days and sessions; the caller's own
  session objects come back; all 5,040 orders of a hybrid week give the same result, and so do
  sessions sharing a date, slot and title; every rule has a severity and a reason; and no rule
  blocks an owner's edit by default.
- **Commitments** (`commitments.test.ts`): Tue/Thu Muay Thai classes become evening sessions of
  their own discipline on those dates in every planned week, with the class's RPE, load and
  commitment ref, and one `commitment_placed` decision citing every session; nothing is placed
  before the first planned day, and a day's commitments go in time order; a 60-minute Wednesday
  running club is a run of one timed segment, with one generated run fewer; a strength class is a
  `strength_class` session counted as a strength day with no hard sets credited; a commitment no
  goal trains adds to the week; a null duration and intensity get 90 min (Muay Thai) and moderate,
  with `default_assumed` decisions and a `commitment_placed` why that says so.
- **Zone 2 bike** (`cross-training.test.ts`): with a bike and runs serving a goal that trains more
  than running, half of each week's generated easy runs (rounded up, the latest first) become a
  `conditioning` session titled Zone 2 bike, with the run's day, time, minutes and RPE and zone 2
  notes (60–70 % of max heart rate), and an `exercise_substituted` decision (`running.zone2_bike`)
  citing each; every week keeps at least one run (a running commitment counts); long and quality
  runs never move; a goal about running alone, or one with a race ahead, keeps its easy runs; with no
  bike nothing changes. The owner's week (Muay Thai five days, a Saturday club run) moves its Monday
  morning easy run to the bike and leaves the lifts and Muay Thai exactly as they were.
- **Running** (`running.test.ts`): no runs without a running discipline (a running commitment stays
  the only run); a new runner gets easy runs only, timed, each at RPE 4.5 and HR zone 2; no running
  specifics gives the time-based week 1 (30-minute easy runs and a 45-minute long run) with a
  `run_volume` decision; an intermediate runner with a half marathon gets one tempo run a week, none
  in the deload, ordered easy, tempo, easy, long; 25 km a week plans about 25 km in week 1, each
  week held to 10 % over the most a week before it ran (a quality session included), and the deload
  drops; a three-run week and the hybrid scenario's running, long run too, grow every building week;
  a week too small for each run to reach 2 km plans fewer runs and says so; the long run stays
  within 30 % of the week and 10 % over the longest run before it, and may outrun the session length
  with a `priority_tradeoff` decision while every other run keeps to it; interval paces come from a
  10K's, or a 5K's, VDOT as ranges, else RPE and HR zone, with a `run_pace_source` decision;
  with both told, every pace comes from the race; there is no
  quality session when a hard club run is one already, the week has fewer than 3 runs, or no week
  has room for one; a run stays off a running-club day while another day has none; a partial week 1
  drops easy runs first and says so, counting club runs before the first planned day; a marathon 20
  weeks out leads through build, peak and taper outline phases ending on race day, each block
  carrying its phase's hooks (`hooksFor`: `MARATHON_HOOKS`, or `HALF_HOOKS` for a half).
- **Running paces** (`src/lib/domain/programming/generate-running.test.ts`): hybrid's paces from its
  told easy pace's VDOT; runnerLifter's every pace, warm-up included, from its 10K's VDOT ahead of
  the told pace; the best recent race over the latest; only undated races give race paces worded as
  a rough guide; a race 26–52 weeks old is a rough guide and an older one gives effort paces; an
  added run takes the same paces; a marathon build's long runs close with a steady segment at M
  pace, its share rising from 20 % to 40 %, 40 % in peak, 20 % in the taper and none in the race
  week; a first program has no marathon-pace work.
- **Running race plans** (`src/lib/domain/programming/generate-running.test.ts`): a race plan's long
  run takes its target and rises at most 1.5 km a week, in a marathon build and a half's base; the
  race week has no long run; a marathon build week holds a threshold run beside the marathon-pace
  long run, and a marathon taper week only the long run; a half's build weeks, the cutback too, hold
  a threshold run and 10K-pace intervals, and its peak names the intervals first; a half's outline
  phases store `HALF_HOOKS`; a cutback week holds at most 80 % of the biggest week before it;
  multiGoal's secondary marathon holds its dose; journey's time-based secondary marathon keeps M3's
  week.
- **Fight camps** (`src/lib/domain/programming/generate-combat.test.ts`): journey's and multiGoal's
  camps hold hard sparring, classes counted, to the week's target and at most 2, none in the last 7
  days; conditioning comes in 3-minute rounds only in the weeks that ask for rounds, or a
  `generator.camp_left_out` decision cites the week; the fight week is technique and light pads, or
  a decision says it had no room for them; classes stay as told; the evaluator finds no
  `sparring_cap` or `event_protection`; the camp takes only strength held at maintenance, keeping
  its dose, its weekly sets (every major group at the week's `setsPerGroup` minimum in each full
  week) and every long run; journey and multiGoal keep both strength sessions and say which camp
  sessions, journey's sparring among them, they left out; a held goal with a third lift to spare
  (a synthetic week, since no scenario has one) gives the camp that lift with a `generator.camp_room`
  decision and keeps every major group at its minimum; the camp spars as the season does, so an
  owner who said 0 gets no sparring in the targets or the plan; a Muay Thai goal that does not lead
  gets no sparring; longSeason stays within `PLAN_BUDGET`.
- **Other sessions** (`other.test.ts`): a custom-discipline goal gets sessions titled with its name
  at RPE 6 for the session length, with a `default_assumed` decision citing them; Muay Thai is
  technique at RPE 6 with no class or profile, alternates technique and pad work when the profile is
  told, and spars only in building weeks and only when its goal leads, under each week's RPE cap; free days no goal asks for get
  30-minute mobility sessions within the session length; every scenario's run segments and metrics
  pass `runSegmentsSchema`, `customMetricsSchema` and `otherDetailsSchema`, and the mixed scenarios
  are required to have some.
- **Placement** (`placement.test.ts`): the hybrid scenario places Muay Thai Tue/Thu evenings first
  and breaks no 'avoid' rule within or across weeks; the long run is on Saturday with no heavy lower
  body on Friday, and strength is on the class mornings before the class in every week, the light
  ones included; it gives the "Marathon over Stay strong" priority decision and the "kept clear of"
  decisions; a morning easy run and an evening class share a day in that order; each scenario keeps
  its days per week and available days; no intervals the day after a hard strength class; an
  over-constrained week drops the lower-priority session, or keeps it with a priority decision when
  its goal ranks first; a part week 1 drops what it has no room for; decision refs follow the
  re-sorted sessions; every scenario re-runs byte-identical, valid and free of 'avoid' violations.

### Train screens

The Train week, the plan overview, session detail and the edit sheets.

- **Seeding programs** (`e2e/program-support.ts`): program specs are serial (`*.serial.e2e.ts`) and
  pin the browser to the owner's zone with `test.use({ timezoneId: PROGRAM_TZ })` (`Europe/London`,
  a zone with daylight saving). `seedProgram(request, { fixture, start })` resets programs, then
  POSTs `/api/test-support/program` (404 unless test routes are enabled; owner only; cross-site
  refused), which records `PROGRAM_TZ` on the profile, takes today from it with `ownerToday`, stores
  the fixture through `createProgramFromPlan` with week 1 on last, this or next week's Monday, and
  returns `{ programId, version, today, weekStart, sessions: [{ ref, lineage, date, title }] }`. It
  refuses with 409 while a program is active and never deletes anything.
  - Seeding rules: specs that edit seed `next_week` (every session is ahead, on any weekday); Today
    specs use the `'today'` and `'today-rest'` fixtures on `this_week`; the block-complete states
    use `'one-week'` on `last_week`. Use the dates `seedProgram` returns: never compute a date in
    the browser or the spec.
  - Reset: `resetPrograms()` truncates `RESET_ROOTS` (the list in `e2e/program-support.ts` is
    the source of truth) with CASCADE and deletes the
    owner's custom exercises; the catalogue and every M1 and M2 row stay. TRUNCATE stays in e2e code
    (`scripts/history-guards.test.ts` keeps it out of `src/`). `resetTrainingProfile()` also calls
    it, so every serial spec starts with no program.
  - `e2e/program-support.serial.e2e.ts`: each fixture's dates against the server's today
    (`next_week`: version 1, 25 sessions all after today; `'today'`: two sessions on today;
    `'today-rest'`: none today; `'one-week'` on `last_week`: every session before today), seeding
    takes under a second, the route's refusals (a second program, bad fixture, start or zone, a
    fixture that does not fit `start`) change no program, every table after M2 (outside
    `M1_M2_TABLES`, except `exercises`) is empty after a reset and reachable by foreign key from a
    root in `RESET_ROOTS` (so a later table the reset misses fails even with no rows), and the
    exercise catalogue is intact.
- **Server-only code** (`scripts/server-only-imports.test.ts`, ESLint's lintText on the real
  config): a runtime import of domain/exercises or domain/programming is an error in UI components
  and modules, client code, route components (#lib, $lib and relative paths), universal page and
  layout loads and the rest of the domain, and the domain index cannot re-export them. `import type`
  is clean there; `import { type X }` is an error, because verbatimModuleSyntax keeps it. Server
  services, server loads, endpoints, hooks, scripts, integration tests, e2e and the packages' own
  files may import them. The layer rules on the same files (UI → server, domain → node:fs, client →
  UI, universal load → db) still fire. `pnpm budgets` also fails if the catalogue's header
  (`CATALOGUE_HEADER`) is in any client chunk.
- **Program components** (`src/lib/ui/program/words.test.ts`, unit): day names from the calendar
  string (today only from the server's date; session, done and skipped counts); the card line (type
  · minutes · intensity · time of day, with 'varies' and unknown left out, and a custom session's
  own discipline); status words ("Moved from Mon" from the date). `e2e/design-program.e2e.ts`
  (/design → Plan): seven days named Monday first, with the server's today marked and dots hidden,
  coloured by discipline (a skipped one is a ring); selection by tap and by arrow keys, Home and
  End, wrapping, with one tab stop; cards named by their words and the pending one aria-busy;
  prescription lines in describe.ts's words, with no load that cannot be computed; every target ≥ 44
  × 44 px; nothing scrolls sideways at 393 px; at 1440 × 900: a readable width, three-letter day
  names, hover and focus states. The Move fixtures list the days left with what is planned; the
  no-day-left fixture says 'No other day left this week' and offers Skip (coming soon,
  aria-disabled); both pass axe in dark and light. `e2e/a11y-suite.ts` audits the Plan tab in both
  themes.
- **Train week** (`e2e/train-week.serial.e2e.ts`, Chromium + WebKit, `PROGRAM_TZ`, hybrid and
  one-week fixtures): one line per session on its day, Rest lines, week 1's brief behind the
  week's one line, the tools behind More, week navigation with ?week and focus kept (arrows, Back
  to this week and the state's link), the pending week (aria-busy, dimmed, no layout shift), the shell's error view when a week's data answers 500, offline, ?week=99 and ?week=abc,
  not started, first block complete, no program, 1440 × 900 (the readable column, 60 px lines,
  More under a hairline), axe dark and light.
  `tests/integration/training/train-load.test.ts`: `loadTrainWeek`'s current and asked weeks,
  malformed ?week, not planned, block complete, no program with an incomplete and a complete
  profile, the week's words composed on the server (its place, title, status and lines), the fail-soft error payload recorded as a server
  error, and the whole plan for the plan overview (each block's weeks, this week whatever `?week`
  shows, the outline weeks, and only the served goal's event).
  `tests/integration/training/form-actions.test.ts`: forms/program.ts answers 400 with dotted paths,
  409 with its reason, 404, 400 for malformed JSON and 401 without a session.
- **Plan overview** (`e2e/train-plan.serial.e2e.ts`, Chromium + WebKit, `PROGRAM_TZ`, hybrid and
  one-week fixtures): See the whole plan, in Train's More, opens a sheet that lists every block
  with its phase, dates and weeks, with this week marked (`aria-current="date"`, 'This week'). With
  the one-week fixture, the outline's phases reach the event date: each outline week says 'Not
  planned yet' and none is a link, and the dated goal sits in its week as an Event. A tapped week
  closes the sheet and shows on Train through the week change's pending state. Close and Escape give
  the focus back to its row in More. The sheet's chunk is not in Train's load, and a tap made
  before it arrives opens it. With the chunk aborted, 'Couldn't open your plan' offers Retry
  (≥ 44 px) under its row; back online, Retry opens the sheet, in place or by reloading Train with
  `?tool=plan` (Chromium). At 1440 × 900: the row's hover and focus states, and the timeline at a readable width with no
  sideways scroll. axe in dark and light with the sheet open. `src/lib/ui/program/timeline.test.ts`
  (unit): `timelineView` lists every block with its dates and length, and its weeks numbered from
  week 1 (Train's `?week`); it names the phase only where the block's name does not already say it,
  and marks the week and the block that hold today, in planned and outline weeks; a goal the plan
  serves has its event in the week it falls in, and another goal's, a dropped goal's
  (`EVENTS_LEFT_OUT`) and one outside the plan are left out.
- **Session detail** (`e2e/session-detail.serial.e2e.ts`, hybrid fixture seeded `next_week`,
  `PROGRAM_TZ`): a week-1 strength session's 'Work up to a set of 5 @ RPE 7', its back-offs and the
  recording instruction, and accessories with sets × reps @ RPE, rest and tempo; a run's warm-up,
  grouped repeats and cool-down in miles (`distance_unit` set by SQL); the Muay Thai class's
  evening, duration, target RPE and metrics; the tapped Train card held busy while its `__data.json`
  is delayed, the others not, and Back (the browser's and the screen's) returning to the same week
  and day; 404 for a random uuid, `sample`, `?v=abc` and `?v=9`; `?v=1` read-only after a skip; a
  500 from `__data.json` showing the shell's error view with Try again, and offline showing the
  designed offline state; axe in dark and light per discipline, no layout shift, and the desktop
  column centred beside the rail. The load's words, 404s and fail-soft error are covered on real
  Postgres in `tests/integration/training/session-load.test.ts`;
  `src/lib/ui/program/session-words.test.ts` covers the composed words, the zones in bpm included
  (`effortWords`, `stepsInZones`); `src/lib/domain/programming/hr-zones.test.ts` covers the plan's
  `hr_zones_set` decision and pins that plans without heart rate do not change.
- **Move** (`e2e/move-session.serial.e2e.ts`, the hybrid fixture seeded `next_week`, so every day is
  ahead):
  - Move opens a code-split sheet that lists the days left in the week as radio cards, each with
    what is planned that day, never the session's own day.
  - Moving Monday's session to Wednesday with a reason saves version 2 ('Moved to Wednesday ·
    version 2'). Focus returns to Move, Train shows the session there with a Moved badge, and a
    reload keeps it. In Postgres, version 1's rows are unchanged and one owner decision keeps the
    reason.
  - Moving heavy lower body to the day before hard Muay Thai warns before saving, and the decision
    keeps the warning.
  - A page left on an older version says 'Your plan changed' and moves nothing; Reload lets the
    owner move again. Close and Escape return focus to Move. axe passes in dark and light with a
    warning showing.
  - With the service worker blocked (page.route): Save is busy while the move posts, and a second
    tap posts nothing; offline, the sheet stays open with the error; two warnings in the same words
    are both listed; an aborted MoveSheet chunk (never a modulepreload) shows Retry, which loads it;
    an aborted EditSheetHost chunk is a toast with Retry, which opens the sheet.
  - On a desktop window, Move has hover and focus states, and the sheet scrolls nothing sideways.
  - `tests/integration/training/session-edits.test.ts`: the load offers Move on the current version
    (every later day of the week, with what is planned there) and says why a session stays as it is
    (passed, skipped or logged); an older version has no edits; today comes from the owner's time
    zone; move saves the next version with the reason, and `checkMove` writes nothing and gives the
    warning that move then records; refused: an edit on an older version (409), an unreachable day
    at its field (400), a page with no version (404), and a session whose day has passed by the
    owner's clock.
- **Swap** (`e2e/swap-exercise.serial.e2e.ts`): this-session-only and never-again swaps with
  database checks, the empty state, the busy state while the swap posts, focus return to Swap, axe
  in dark and light, and a desktop window. `tests/integration/training/session-swap.test.ts` covers
  the session's swap load and actions on real Postgres.
- **Adjust and skip** (`e2e/adjust-skip.serial.e2e.ts`, serial, Chromium + WebKit + a desktop
  describe, `PROGRAM_TZ`, hybrid seeded `next_week`): adjust a strength set (sets and RPE), an
  interval's repeats and a Muay Thai class's length, and skip with a reason. Each is a new version
  with its decision in the database and survives a reload. RPE 11 is shown on its stepper,
  announced, and nothing is posted (service worker blocked). Save is busy and posts once; Close and
  Escape return focus to the trigger. Adjust left open while another tab skips the session closes
  onto the skipped state. axe in dark and light on every sheet variant and on the skipped state.
  `tests/integration/training/session-adjust.test.ts`: the session load's `adjust` values (none when
  locked or on an older version), and the `adjust`, `adjustSegment`, `adjustDetails` and `skip`
  actions on real Postgres; each saves the next version with its decision; a 400 is a field error,
  and a 409 is a page on an older version.

### Program history

Versions and their decisions with the why; older versions stay viewable.

- `tests/integration/training/history-load.test.ts` covers the History load on real Postgres:
  newest-first order, dates in the owner's zone, who made each version and each decision's why,
  `HISTORY_PAGE_SIZE` paging with `?before`, 'no changes yet' only for version 1, the no-program,
  404 and recorded soft-error states, and a version's read-only week opening on the week its change
  touched.
- `e2e/program-history.serial.e2e.ts` (hybrid fixture, versions made through the session's move
  action) covers Train's History action, the list and paging, the inline Retry after a soft failure,
  older versions read-only with their sessions as they were then, busy states while `__data.json` is
  held, the move toast's History link, 404s, the shell error and offline cards, axe dark and light,
  no layout shift, and the desktop column with hover and focus.

### Today screens

Build my program, today's sessions and what is next this week. Seed programs as **Train screens**
says (`e2e/program-support.ts`): the `'today'` and `'today-rest'` fixtures on `this_week`, at the
dates the route returns.

- **Lazy panels** (`e2e/today-panels.serial.e2e.ts`): a Today panel's late code moves nothing (first
  load and client navigation, phone and desktop); a failed panel chunk shows a Retry notice that
  recovers (WebKit in place, Chromium by reload).
- **Build my program** (`e2e/build-program.serial.e2e.ts`): builds a program from Today's Build card
  on phone and desktop. `tests/integration/training/build-actions.test.ts` and
  `tests/integration/training/today-program.test.ts` cover the build actions' time-zone handling and
  Today's program state.
- **Today's plan** (`e2e/today-plan.serial.e2e.ts`): today's sessions, each opening its detail, and
  Up next in date order across weeks; a session skipped from its detail comes back Skipped, Up next
  unchanged; a client navigation whose data fails shows the designed error, whose Try again
  recovers, and offline shows the designed offline state; a desktop window (the readable column,
  hover and focus on a session card); a rest day naming the next session; a program that starts next
  week, with week 1's first session; a finished first block ('Nothing planned yet', an empty Up next
  and the way to Train). `tests/integration/training/today-load.test.ts` covers the same states on
  real Postgres and fails soft, recording the failure, when the database cannot be reached.
- **Demo profiles** (`tests/integration/training/demo-profiles.test.ts`):
  `scripts/lib/demo-profiles.ts` commits through its own pg client, so it runs inside
  `withCommitted`; the demo profiles read back complete and `previewProgram` accepts them.
- **The M3 journeys** (`e2e/program-journey.serial.e2e.ts`), end to end with no fixture: blank-1RM
  onboarding → Build from Today (Next Monday) → Train week 1 (strength, running, Muay Thai Tue/Thu;
  `weekViolations()` finds no 'avoid') → baseline session → move + one-off swap → History, then
  reloads and SQL. A second journey checks measured-1RM percentage loads in kg. A desktop case
  checks the built screens beside the rail. `weekViolations(weekStart)` in `e2e/program-support.ts`
  runs domain `checkWeek` over the stored week through the repository and the row mapping.

### Screenshots

Every M3 screen is captured (`captureScreen`) into `test-results/screens/<project>/` on each project
it runs in, and CI uploads them:

- `/design` → Plan: `design-program-week`, `design-program-cards`, `design-program-lines`,
  `design-program-move`, `design-program-desktop`.
- Train: `train-week`, `train-pending`, `train-rest-day`, `train-empty`, `train-block-complete`,
  `train-week-desktop`; the plan overview: `train-plan`, `train-plan-outline`, `train-plan-pending`,
  `train-plan-retry`, `train-plan-desktop`.
- Session: `session-strength`, `session-run`, `session-muay-thai`, `session-error`,
  `session-strength-desktop`; edits: `session-move`, `session-move-warning`, `session-move-desktop`,
  `session-swap`, `session-swap-empty`, `session-swap-desktop`, `session-adjust`,
  `session-adjust-run`, `session-adjust-desktop`, `session-skipped`.
- History: `train-history`, `train-history-empty`, `train-history-v1`, `train-history-desktop`,
  `train-history-v1-desktop`.
- Today: `today-build`, `today-build-preview`, `today-build-conflict`, `today-build-desktop`,
  `today-build-preview-desktop`, `today-session`, `today-rest`, `today-starts`,
  `today-block-complete`, `today-session-desktop`, `today-panel-error`, `today-panel-error-desktop`.
- The journeys: `journey-onboarding-goals`, `journey-onboarding-strength`,
  `journey-onboarding-schedule`, `journey-onboarding-review`, `journey-today-build`,
  `journey-build-preview`, `journey-train-week-1`, `journey-session-baseline`, `journey-move`,
  `journey-swap`, `journey-history`; the measured-1RM journey's `journey-today-build-measured`,
  `journey-build-preview-measured` and `journey-session-measured`; and the desktop ones
  (`journey-today-build-desktop`, `journey-build-preview-desktop`, `journey-train-week-1-desktop`,
  `journey-session-measured-desktop`, `journey-history-desktop`).

## Workouts (M4)

One subsection per M4 track. A slice adds a line to its own track's subsection only.

### Domain

Unit tests (`src/lib/domain/workout/`) run on the shared kit fixture
`tests/fixtures/workout-day.ts`: the start kits of M3's 'workout-day' program (back squat with last
session's sets and bests, leg press, Romanian deadlift, an A1/A2 pull-up and plank superset; an
interval run of 14 segments; a
90-minute Muay Thai class), typed as `StartKit`s. `tests/integration/workouts/kit.test.ts` proves
the server builds exactly those kits, so change both together.

- **Contract** (`mutations.test.ts`): the 16 v1 types with their kinds, entity keys and
  dependency rules; a create's id is its entity id and an edit's never is; every mutation depends
  on its workout's start, a set edit on its own set's log, a mutation naming a custom exercise
  still in the outbox on its `exercise.create`. `pnpm check` proves local actions are never
  mutation types and the fixture is a valid `StartKit`.
- **Convergence** (`project.test.ts`): `tests/fixtures/workout-sequences.ts` gives 500 seeded
  strength sequences (`strengthSequence`, `serverSplit`, `acrossRows`); folding any server/outbox
  split gives the same view. `acrossRows` reorders only across rows, keeping every mutation after
  the ones it depends on. `canonical.test.ts` replays the same seeds against Postgres.
- **Timers** (`timers.test.ts`): remaining, done and overtime on absolute timestamps; a rest that
  ended while the tab was closed; pause, +30 s and skip; a clock moved backwards; a timer restored
  through JSON; the rest order (prescription, then the device default, then 2:00).
- **Logging rules** (`logging.test.ts`): every measure × load type pair, its fields and refusals
  at their own `payload.` paths; what counts toward e1RM, volume and PRs (assisted: none; weighted
  bodyweight: volume only; unweighted: 'most reps'; warm-up and skipped sets: nothing).
- **Flow** (`flow.test.ts`): on the fixture's superset, no rest inside a round and the round's
  rest after its last member; uneven sets continuing straight; a skipped set advancing like a
  logged one; going to an exercise by hand never breaking the alternation; labels A1, A2, B1… and
  AA after Z; Up next naming the partner.
- **Substitution rules and copy** (`substitution.test.ts`, `copy.test.ts`): only a confirmed
  dislike writes a preference; machine unavailable ranks alternatives needing none of the slot's
  equipment first; This hurts offers Stop first and End the workout when severe (in a run or a class, End alone); `lighterKinds` offers a Muay Thai class only its lighter formats; every string in
  `copy.ts` is scanned for push-through phrases and diagnosis words.
- **Run and class actions** (`src/routes/workout/session-actions.test.ts`,
  `src/routes/workout/run/run-log.test.ts`): `swapOptions` offers a run its zone 2 bike and a class
  its lighter format; `runEnd` finishes a run that ran anything and abandons one that did not;
  `bikeStart` pins the bike to the run's planned session, or to none when the run was unplanned;
  `minutesToRun` gives the bike the unlogged segments' minutes. `src/lib/domain/programming/swap-parity.test.ts`
  holds the swap's copies of ZONE2_BIKE and MUAY_THAI to the generator's.
- **Schemas** (`schemas.test.ts`): `DB_CHECKED_BAD_VALUES` (also refused by Postgres CHECKs,
  replayed through the repositories by `sync.test.ts`) and `SCHEMA_ONLY_BAD_VALUES` (open
  vocabularies) are each refused at their path.
- Prefill, run and other rules, the summary, mutation words and ad-hoc kits have their own
  `*.test.ts` beside them.

### Client

Store logic is plain `.ts` (`src/lib/client/workout/`), tested in Vitest's unit project with
fake-indexeddb, a fresh `IDBFactory` per test through `vi.stubGlobal('indexedDB', …)`, because the
unit project excludes `*.svelte.test.ts`. Tab-channel tests open
`openTabChannel('pc-workout-test-N')` per test and close it in `afterEach`.

- **Outbox rules** (`outbox-rules.test.ts`): FIFO batches within the 25-mutation, 64 KB and 48 KB
  keepalive caps in UTF-8 bytes; a parked, waiting or oversized change holding only its
  dependants; Discard with its dependants; full-jitter backoff bounds; 'Needs attention' after 50
  counted failures or 24 hours, offline time excluded; the sync status for every state.
- **Store, sync, reconcile** (`store.test.ts`, `sync.test.ts`, `reconcile.test.ts`,
  `restore.test.ts`): one transaction per action, 'Not saved on this device' on a quota error,
  one flusher per device, the 401 purge and the 403 that keeps everything, a pending edit of a
  deleted set parked, the 404 rule.
- **Device settings** (`settings.test.ts`, `src/lib/client/plates.test.ts`, `feedback.test.ts`):
  defaults, corrupt storage falling back field by field, inventories per unit, and vibration, the
  tone and the wake lock as no-ops where the browser lacks them.

### Schema

- `tests/integration/workouts/sync-ledger.test.ts`: an id is applied at most once; a claim rolled
  back with its transaction leaves nothing; rows refuse UPDATE and DELETE.
- `tests/integration/workouts/pain-schema.test.ts`: `pain_reports`' CHECKs, M3's logged-table
  guards, and clearing by `withCommitted` and by `resetPrograms`' cascade.
- `resetPrograms` (`e2e/program-support.ts`) also clears `sync_mutations` (one of its
  `RESET_ROOTS`), so a spec that syncs leaves nothing for the completeness check.

### Sync API

`tests/integration/workouts/sync.test.ts` drives `applySyncBatch` with a test transaction (a
second owner needs the singleton rule lifted inside it: `secondOwner`); `structure.test.ts`,
`pain.test.ts`, `runs-other.test.ts` and `custom-exercises.test.ts` cover each handler family:
applied once, duplicate on replay, deferred until its target arrives, refused at its path, and a
situational swap that writes no preference or version. `pain.test.ts` also takes a run's and a
class's report, which names no exercise, and refuses a strength report without one.
`swap.test.ts` is the contract guard for Swap in a run: the run's end and its zone 2 bike, sent in
two batches, pinned to one planned run; the week's summary counts the run's distance once and both
workouts, and replaying both batches applies nothing twice.

### Workout reads

`canonical.test.ts`, `kit.test.ts`, `kit-alternatives.test.ts`, `library.test.ts`, `history.test.ts`
and `history-load.test.ts` in `tests/integration/workouts/`. 'workout-day'
(`src/lib/server/test-support/program-fixtures.ts`) is the program behind the shared kit fixture.

### Platform

`scripts/vercel-headers.test.ts` keeps `vercel.json` equal to `STATIC_PAGE_HEADERS` for every
prerendered page; `scripts/icon-sprite.test.ts` keeps the sprite equal to a fresh
`pnpm icons:sprite`; `e2e/icons.e2e.ts` checks every icon draws from it, offline too.
`src/lib/server/security-headers.test.ts` pins `SECURITY_HEADERS`, the default cache-control
rule and the failed-guard response.

### Workout screen

`e2e/workout-support.ts` seeds the shared kit fixture into `pc-offline` as the app stores it and
reads the outbox back. `gotoWorkout(kind, { sync })` waits for `data-ready`. Sync `'hold'` (the
default) leaves `/api/workouts/*` unanswered, so no spec writes Postgres; `'stub'` answers every
mutation 'applied'; `'real'` uses the server. `startFromKit` (`e2e/workout-start-support.ts`)
starts from the server's own kit for specs that need alternatives, gentler options or a planned
slot; serial specs only.

- A spec that holds or stubs uses `serviceWorkers: 'block'`; the offline service-worker checks
  run on Chromium only.
- A spec that opens `/workout` with a query to test the Shell uses one other than `?start` and
  `?new`, which start a workout.
- Logging specs assert the outbox and read rows in the next animation frame; a quota error is
  faked by stubbing `IDBObjectStore.prototype.put`.
- `workout-sync-wiring.e2e.ts` records keepalive fetch and `sendBeacon` calls in
  `sessionStorage`, because Chromium does not show pagehide keepalive traffic to Playwright.
- A spec whose route handler reads `route.fetch()` responses for requests it does not own ends
  by unrouting with `{ behavior: 'ignoreErrors' }`: closing the context disposes those responses.
- Rest specs pause Playwright's clock once the store is open; a paused clock stays paused across
  a reload, idle callbacks included, so the spec runs 2 s of it to open the store.

Specs, each with a `*.desktop.e2e.ts` twin or a `test.use(DESKTOP)` case at 1440 × 900:

| Spec                                                    | What it proves                                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `workout-shell`                                         | Restored from IndexedDB alone; empty, no-storage and 'App updated' states               |
| `workout-strength`, `workout-log`                       | The current exercise mid-set; a set prefilled, logged in one tap, done in the frame     |
| `workout-sets`                                          | Edit, delete, skip, missed reps and extra sets, the outbox in order                     |
| `workout-navigation`                                    | Swipe, Previous and Next, the side list by keyboard, Up next                            |
| `workout-rest`, `workout-plates`, `workout-settings`    | The rest timer after a reload, the plate calculator from a set, settings, Train's timer |
| `workout-sync-wiring`, `workout-sync`                   | One engine to Postgres; Fix, Try again and Discard; a 401 and a recovery session        |
| `workout-start`, `workout-entry`, `workout-resume`      | Start by URL, offline from a saved kit, from Today and Train; Resume and Continue here  |
| `workout-run`, `workout-other`                          | A run segment by segment and a Muay Thai class, corrections after sync, audited once    |
| `workout-substitute`, `workout-pain`                    | Situational swaps, a confirmed dislike, This hurts with Stop first                      |
| `workout-add-exercise`, `workout-custom-exercise`       | Add from the cached library offline; the owner's own exercise under the device's id     |
| `workout-finish`, `workout-history`, `exercise-history` | The summary and its PRs; History newest first; an exercise's sheet, offline too         |
| `workout-prepaint`                                      | Painted before scripts, replaced in place; never if discarded, finished or `?new=`      |
| `design-workout`                                        | Every `src/lib/ui/workout` component and state on `/design`, 44 px, 200 % text          |

The serial ones (`*.serial.e2e.ts`) write Postgres and assert only their own workout's rows by
client id.

### Performance

`e2e/perf-workout.e2e.ts` runs in the `perf` project (which also runs `perf-*.e2e.ts`; the
functional projects ignore them): 20 sets over five fresh loads at 4× CPU, set-done p95 under
100 ms, INP p75 of 200 ms or less from Event Timing and web-vitals, no layout shift while
logging, INP on `/workout/run` and `/workout/session`, and the main thread on a service-worker
reload. `e2e/perf-workout-load.e2e.ts` holds the active workout pages and History to the
page-load budget in `e2e/load-budget.ts`, as `e2e/perf.e2e.ts` does the other screens. CI does not
run the `perf` project (performance is not tested in CI). `pnpm lighthouse --seed` audits History
and the active workout. Numbers: docs/performance.md, "M4 (workout)".

### Journeys

- `journey-strength.serial.e2e.ts`: from Today, a whole strength workout (top set, back-offs,
  rest, plates, a machine-unavailable swap, the superset, a refresh that restores every set and
  the rest, minimise and resume, finish, History), the pain and dislike journey, and a generated
  week 1 from a blank-1RM profile, with SQL at each step and no coach request.
- `journey-offline.serial.e2e.ts`: offline logging, edits and deletes surviving a reload; one
  sync on reconnect with exact Postgres counts; replays creating no duplicates; two tabs; a 500
  then a pass, an answer lost after the commit, and a refused change discarded.
- `journey-run-muay-thai.serial.e2e.ts`: a 14-segment run and a Muay Thai class from Today,
  synced and in History.

### Screenshots

Captured into `test-results/screens/<project>/`, the desktop ones under `desktop-chromium/`:

- Workout screen: `workout-empty`, `workout-no-storage`, `workout-app-updated`, `workout-active`,
  `workout-baseline`, `workout-exercise`, `workout-logging` (with `-hover`, `-focus`),
  `workout-superset`, `workout-not-saved`, `workout-set-edit`, `workout-set-skipped`,
  `workout-between-exercises`, `workout-rest`, `workout-rest-paused`, `workout-rest-over`,
  `workout-plates`, `workout-plates-inventory`, `workout-settings`, `train-rest-timer`.
- Sync and start: `workout-sync-error`, `workout-sync-stuck`, `workout-offline`,
  `workout-signed-out`, `workout-start-loading`, `workout-start-offline`,
  `workout-start-signed-out`, `workout-start-conflict`, `today-start`, `session-start`,
  `today-resume`, `today-continue-here`, `offline-resume`.
- Actions and finish: `workout-substitute`, `workout-substitute-empty`, `workout-dislike-confirm`,
  `workout-pain`, `workout-add-exercise`, `workout-add-exercise-no-library`,
  `workout-custom-exercise`, `workout-custom-exercise-fix`, `workout-finish`, `workout-summary`,
  `workout-completed-offline`, `workout-discard`, `workout-run`, `workout-muay-thai`.
- History: `history-list`, `history-detail`, `history-empty`, `exercise-history`,
  `exercise-history-error`.
- Desktop: `desktop-today-start`, `desktop-today-resume`, `desktop-workout-start-conflict`,
  `workout-sync-error-desktop`, `workout-substitute-desktop`, `workout-pain-desktop`,
  `workout-add-exercise-desktop`, `workout-custom-exercise-desktop`, `desktop-workout-summary`,
  `desktop-workout-summary-hover`, `desktop-workout-run`, `desktop-workout-muay-thai`,
  `desktop-history-detail`, `desktop-exercise-history`.
- The journeys: `strength-*` (top set to History, the pain and dislike journey, the generated
  week), `journey-run-*`, `journey-thai-*` and `journey-history-*`, with desktop copies.

## Advanced coaching (M7)

This is the M7 test inventory, by layer, so each claim in milestones.md can be traced to a file.
Counts are test files. The PRD's examples are the scenarios S1 to S12 in
`src/lib/domain/programming/periodisation/coverage.ts` (`PRD_EXAMPLES`), each a profile and a
training history in `periodisation/scenarios.ts` and `histories.ts`. Performance is not in CI (see
"CI"), so M7 has no performance test on `main`; the numbers in docs/performance.md come from the
runs it names. Since the re-slice (`plan/m7-reslice.md`), the owner's rule allows no e2e spec
beyond the PRD journeys, so M7's only new spec is m7/04's `train-findings`; its screens are covered
by integration tests and the three e2e specs below.

### Domain and components (unit)

- `src/lib/domain/programming/periodisation/*.test.ts` (13 files): the season planner and the plan
  budget, the season windows (paused goals too), each block kind (strength phases, hypertrophy
  blocks, marathon and half blocks, fight camps, the maintenance block), deloads with their
  triggers (the declining history, S7), tapers (one short strength session a week in an endurance
  taper, none within 4 days of the race), the re-plan engine (regenerate for new priorities, S8; a
  deload in place; a taper spliced in), and `M7_SCENARIOS`, whose coverage test names S1 to S12
  with their PRD sentences.
- `src/lib/domain/programming/evaluate/*.test.ts` (2 files): `evaluateWeek` on the PRD §5
  conflicts, each finding with its why and resolution (an owner's move, a commitment, a priority
  kept, no room), its score and grade, and the concurrent rules: hard Muay Thai adds fatigue (S10),
  high running volume against leg recovery (S9), hard-day spacing, event protection and the
  sparring cap.
- `src/lib/domain/programming/schedule/*.test.ts` (2 files): `repairWeek` clears the PRD §5
  conflicts, keeps the owner's moves, never moves a commitment or a past session, never raises the
  cost, and is idempotent.
- `src/lib/domain/programming/load/*.test.ts` (3 files) and `priority/*.test.ts` (2 files): the
  five-system load split, which sums by day as M6's `dailyLoads` does; the fatigue model on the
  PRD histories; which goal leads, by rank and event proximity (S1 in fight camp: the fight leads,
  the marathon is secondary, the rest are held); and the maintenance doses through `doseBand`.
- `src/lib/domain/programming/rules/registry/*.test.ts` (11 files): every rule key is unique and
  dotted, each area's constants are registered live, a superseded rule names its replacement, and
  M3's, M4's and M6's rules are registered too. `scripts/rule-keys.test.ts` finds every rule key
  the code cites, and `scripts/programming-rules-doc.test.ts` keeps
  `docs/programming-rules.md` equal to a fresh render of the registry (`pnpm docs:rules` rewrites
  it), with every export of `src/lib/domain/programming/rules/` a registered rule or a listed
  non-rule and every cited key an active rule.
- `src/lib/domain/programming/generate-{season,schedule,phasing,running,combat}.test.ts` (5 files):
  the season-aware generator. multiGoal (S1) leads its blocks to each event; every avoid finding a
  generated week keeps is explained by a priority trade-off or a kept schedule; hypertrophy volume
  rises week on week until the deload (S6); runs are paced from current fitness; and a fight camp
  caps its sparring.
- `hr-zones.test.ts`, `planned-targets.test.ts` and `next-block/periodised.test.ts` in
  `src/lib/domain/programming/`: heart-rate zones in the plan (threshold, then heart-rate reserve,
  then max), each M7 week judged by the targets its plan set, and the next block from the season.
  `interference.test.ts` keeps M3's four §5 rules, and `scenarios.test.ts` M3's scenarios, under
  the M7 rules.
- `src/lib/domain/training/replan.test.ts` and `src/lib/domain/programming/replan/changes.test.ts`:
  the four directives and the week-by-week description of a re-plan's change.
- `src/lib/server/services/periodisation/*.test.ts` (4 files): the deload's target week, a deload
  assessed over a weekly review (S7), the road serialised within 1.5 KB, and its read fault.
- The coach: `src/lib/server/agent/tools/periodisation.test.ts` (a what-if move),
  `src/lib/server/agent/prompt/layout.test.ts` (the week block: its findings as untrusted text, and
  the next deload and taper), and `src/lib/domain/coach/cards.test.ts`, `diff.test.ts`,
  `proposal-rules.test.ts` and `proposals.test.ts` (the replan payload, its rules and its card).
- The screens: `src/lib/ui/program/season.test.ts` and `block-timeline.test.ts` (the season over the
  timeline), `src/lib/ui/profile/ReplanNotice.test.ts`, `replan-notice.test.ts` and
  `GoalsEditor.test.ts` (the notice by state), `src/lib/ui/profile/specifics.test.ts` and
  `src/lib/domain/profile/schemas.test.ts` (heart rate), `src/lib/ui/program/session-words.test.ts`
  (run efforts in heart-rate zones), `src/lib/ui/coach/ProposalCard.propose-again.test.ts` and
  `src/routes/(app)/progress/reviews/[[key]]/next-week.test.ts` (a stale re-plan, and the deload
  card). Train's findings, 'Why Monday?' and the week kinds have no component test; the integration
  and e2e tests below cover them.

### Integration (real Postgres)

- `tests/integration/periodisation/` (11 files): the week's evaluation and Train's notes
  (`evaluate`), why each session sits on its day (`explain`), the light weeks' line and countdown
  (`week-line`), the evaluation context with logged and planned load and a stalled read under the
  one-query guard (`context`), the re-plan preview, a priority swap on the hybrid among them (S8,
  `preview`), a change of priorities on Profile → Goals (`priority-replan`), the reactive deload
  (S7, `reactive-deload`), the road (`road-view`, `train-road`), Train's re-plan line
  (`train-replan-note`) and Train's page data (`train-page-data`, docs/performance.md, "M7
  (advanced coaching)").
- `tests/integration/coach/tools-periodisation.test.ts`: `evaluate_week_interference`,
  `explain_schedule_tradeoffs`, `propose_program_adjustment` with ops, and `plan_block`,
  `schedule_deload` and `plan_taper`, on the periodisation-week fixture, where the owner moved
  Lower A to the day before Tuesday's hard Muay Thai (S2). Its scripted turns run `runTurn` with the
  MockProvider: the week-repair script proposes the engine's repair exactly as computed; 'Does next
  week clash?' and 'Why is my week shaped like this?' are answered with grounded metrics and facts.
  `replan-proposals.test.ts`, `propose-again.test.ts` and `propose-again-action.test.ts`: the replan
  proposal's lifecycle, staleness at accept and Propose again. `turn.test.ts` ("the week block")
  carries the week's block into every turn.
- `tests/integration/reviews/weekly-conflicts.test.ts` (hard sparring logged Monday, then heavy
  squats Tuesday, listed as residual fatigue with its why) and `deload-propose-again.test.ts`.
  `cycle.test.ts`, `weekly.test.ts` and `next-cycle.test.ts` judge M7 hypertrophy and maintenance
  weeks and plan the next block from the season.
- `tests/integration/programs/replan-store.test.ts`: a re-plan stored as a new version, by
  regenerating, splicing or in place, with history untouched. `batch.test.ts` and
  `tests/integration/training/edit-move-skip.test.ts`: a move judged with M7's rules.
- `tests/integration/profile/running-hr.test.ts` (heart rate on the running profile and in
  onboarding) and `replan-action.test.ts` (Profile → Goals' re-plan action and its Try again).
  `tests/integration/analytics/targets.test.ts`: the muscle-group targets of M7 weeks.

### End to end (Playwright, serial)

- `e2e/train-findings.serial.e2e.ts`: the periodisation week on Train. The heads-up on the moved
  session and on Tuesday's, listed once behind the week's one line, matches the evaluation computed
  in SQL (`e2e/periodisation-support.ts`, `weekEvaluation`), 'No clashes this week' shows when there
  are none, and it works without JavaScript. It runs on the iPhone, and one test in a desktop window (`DESKTOP`).
- `e2e/design-program.e2e.ts`: the week finding and 'Why Saturday?' on `/design` → Plan.
- `e2e/reviews-sections.serial.e2e.ts`: the hard sparring's conflict in a weekly review shows its
  why, judged by M7's evaluator.
- No e2e covers the season timeline, the re-plan notice or proposal, the deload card or the
  heart-rate fields, and no journey runs the multi-discipline chain from onboarding to an accepted
  re-plan (milestones.md, M7). These specs are not journeys, so pull requests and pushes do not run
  them; only a scheduled or manual run does ("CI").

### Query plans and budgets

- `scripts/explain/periodisation.cases.ts`, run by `pnpm db:explain`: Train's load with M7's reads
  on and off, printed and not gated (`TRAIN_TARGET_MS`, 10 ms).
- `tests/integration/periodisation/train-page-data.test.ts`, against
  `scripts/explain/baselines/train-m7.json`: Train's page data grows only by the allowances of the
  M7 slices that are on, within 64 B.
- `pnpm budgets` checks each M7 route's initial JS and route CSS (docs/performance.md, "Budgets").

## The LLM in tests

## Coach (M5)

Every coach test but the live suite uses the deterministic MockProvider
(`src/lib/server/agent/provider/mock.ts`). It refuses every request the 2026-10-21 Messages API
would refuse (`provider/validate.ts`), plays scripts from `provider/mock-scripts/` (one file per
tool group, plus `general.ts`, `reviews.ts`, `summaries.ts`, the pain and grounding scripts in
`safety.ts` and the coach's states in the browser ('slow' and 'perf-stream' among them) in
`test.ts`) and never calls the real API. No key exists in CI but the bundle-scan canary.

### Domain and agent (unit)

- **Contract** (`src/lib/domain/coach/*.test.ts`, `scripts/coach-index-imports.test.ts`): the
  answer grammar and SSE events give identical results split at every character and byte and in
  1-, 7- and 64-byte chunks; unlabelled text is a note; a frame over 64 KB is refused, even while
  it is arriving. Every source type maps to an app link, the exercise-history sheet or nothing,
  never an absolute, protocol-relative or traversing URL. `domain/coach/index.ts` reaches no
  package and no server-only module.
- **Catalogue, activity, pricing, budgets**: 24 sorted tools in five groups with exactly three
  drafting tools; chip words never show an id or key; prices exact in micro-dollars, a missing
  model's cap price never below its cost; turn limits proved at 180 s and at the 60 s fallback.
- **Safety** (`safety.test.ts`, `copy-scan.test.ts`, `statements.test.ts`): every banned pattern's
  longest match is ≤ `MAX_PATTERN_CHARS` (80); M4's workout copy is scanned in a pain context;
  statements use a fixture matcher.
- **Markdown** (`markdown.test.ts`): every construct of the subset; HTML, `javascript:`, `data:`
  and external links stay literal; 200 seeded hostile texts stay within the bounds.
- **Tool framework** (`src/lib/server/agent/tools/*.test.ts`): strict JSON Schema from zod with
  owner-named properties refused; canonical outputs capped at 8 KB; every call answered in order
  in one message; three tools at a time on the pool, one on a transaction; reading tools stop at
  10 s, drafting tools at 85 s (25 s at 60 s), never past the turn. `registry-complete.test.ts`:
  all 31 tools registered once, in their group's file, with an output schema.
- **Prompt** (`src/lib/server/agent/prompt/*.test.ts`): a pinned prompt hash; the prefix is
  append-only across turns, tool steps and a version bump (a mock cache read on turn 2); planted
  instructions reach the model only as `untrusted_text`.
- **Providers**: `provider/anthropic.test.ts` runs the real SDK on a fake fetch over hand-written
  SSE and error fixtures (`tests/fixtures/anthropic/`); `select.test.ts` covers every row of
  docs/environment.md's resolution table; `proposals/draft.test.ts` covers the drafter.
- **Browser** (`src/lib/client/coach/*.test.ts`): the stream reader and the turn state.
- **Docs**: `scripts/coach-tools-doc.test.ts` keeps docs/coach-tools.md equal to the registry;
  `scripts/client-secret-scan.test.ts` and `scripts/anthropic-sdk-imports.test.ts` prove the key
  and SDK guards on planted input.

### Integration (`tests/integration/coach/`, real Postgres)

- **Schema**: `conversations-schema.test.ts` and `proposals-schema.test.ts` pin every CHECK and
  guard by SQLSTATE and name (insert-only transcripts, run lifecycle, one running run per thread,
  forward-only proposals, DELETE refused).
- **Services**: `threads.test.ts` (messages stored once per client id, also under a race; gapless
  seq), `runs.test.ts` (roll-ups, stale expiry, the cancel flag, the day's spend in the owner's
  zone, unpriced-model cap pricing), `proposals.test.ts` (every kind, de-duplication, revision,
  accept by id, a second accept writes nothing, foreign owner `not_found`),
  `apply-program.test.ts`, `apply-profile.test.ts`, `apply-session.test.ts` and
  `tests/integration/programs/batch.test.ts` (one version per proposal, one decision per op).
- **Memory and summaries**: `memory-profile.test.ts` (≤ 9 queries), `memory-records.test.ts`,
  `review-memory.test.ts`, `summaries.test.ts` (a segment rolls at its message or token limit or
  on a new prompt version, and the next request replays nothing of it).
- **One test per tool group, through `runTurn`**: `tools-history.test.ts`,
  `tools-programming-reads.test.ts`, `tools-analytics.test.ts`, `tools-workout.test.ts`,
  `tools-preferences.test.ts` and `tools-programming-proposals.test.ts`. Each validates real outputs
  against the output schemas and runs a random owner id against the seeded owner's ids: nothing
  read, nothing written.
- **The turn**: `turn.test.ts`, `turn-endpoint.test.ts`, `policy.test.ts` (the output gate),
  `direct.test.ts` (lookups without a model call), `first-words.test.ts`, and the endpoints
  (`threads-endpoint`, `runs-endpoint`, `memory-endpoint`, `proposal-actions`), the screen loads
  (`screen-load`, `screen-proposals`, `inbox-load`) and `test-support.test.ts`.
- **The week block** (`turn.test.ts`, 'the week block'; `prompt/layout.test.ts`): a failed road or
  evaluation read, and a stalled one cancelled by Postgres at 250 ms, leave the block out and record
  an app_errors row while the turn answers; committed data builds the block and its label reaches the memory.
- `tests/integration/analytics/analytics.test.ts` and
  `tests/integration/coach/analytics-parity.test.ts`: the coach's weekly summary, load and trends
  equal the screens' numbers.

### End to end

Coach specs use `e2e/coach-support.ts`: `resetCoach(request)` before each test; `seedCoach(request,
fixture)` seeds bench-month, split-squat-week, run-weeks, long-thread, knee-pain,
archived-threads or unpriced-run at the server's dates; `setCoachFault(request, fault, options)`
sets a fault or a script. The route answers 404 unless test routes are enabled. The serial specs run on
Chromium and Linux WebKit at the iPhone viewport; each screen's spec repeats its states in a
1440 × 900 window and runs axe in both themes (`e2e/coach-a11y.ts`).

- `design-coach.e2e.ts`, `design-coach.desktop.e2e.ts`: every answer state on /design → Coach.
- `coach-screen.serial.e2e.ts`: suggestions, Recent conversations, the empty state, each
  unavailable notice, the 404, loading and load-failed states.
- `coach-stream.serial.e2e.ts`: 'Thinking…', activity chips, streamed blocks, Stop, a dropped
  stream, leaving mid-answer; the stream client loads on demand.
- `coach-states.serial.e2e.ts`: every failed-turn state (provider, rate-limit countdown, budget,
  unavailable with a direct answer, refused, timeout, busy, offline), Retry leaving one owner
  message; the stream client failing once and twice.
- `coach-proposals.serial.e2e.ts` and `coach-proposal-decisions.serial.e2e.ts`: cards inline,
  Accept → version N in Train, a double tap → one version, a tampered request ignored, an owner
  edit → superseded; reject with a reason, Ask for changes, 500 then Retry, offline, chunk
  failures.
- `coach-inbox.serial.e2e.ts`: the Proposals inbox (order, decisions, filters, empty and failed
  states, the desktop split).
- `coach-threads.serial.e2e.ts`: rename, archive with Undo, Archived conversations, read-only
  archived threads, Unarchive.
- `coach-memory-panel.serial.e2e.ts`: 'What the coach knows'; a dislike persists into a new
  conversation through structured memory, not chat.
- `coach-usage.serial.e2e.ts`, `coach-exercise-sheet.serial.e2e.ts`, `coach-entry.serial.e2e.ts`
  (Ask the coach from a workout, a history sheet and Today), `coach-support.serial.e2e.ts`.
- `coach-degrade.serial.e2e.ts`: with the coach failing, unavailable and not launched, a whole
  workout runs and no workout page, Today, Train or History sends a coach request.
- `coach-journey.serial.e2e.ts`: the eight M5 journeys and the screenshot set. After a CI run,
  `node scripts/coach-screens-index.ts <merged screens artifact dir>` writes `coach-index.html`, the
  owner's contact sheet, and exits 1 if any screen in `e2e/coach-screens.ts` is missing.
- Performance (`perf` project): `perf-coach.e2e.ts` (a 60-message conversation and a streamed
  3,000-token answer) and `perf-coach-load.e2e.ts` (the long conversation and the inbox). Seeding
  a coach fixture blanks the training profile, which each test puts back after its loads.

### Live (`pnpm test:live`, opt-in, never in CI)

`tests/live/coach.live.test.ts` runs six named conversations against the real model and
`first-words.live.test.ts` records how soon the first words come. Start Postgres, run
`pnpm db:setup` once, then `LIVE_LLM=1 ANTHROPIC_API_KEY=<key> pnpm test:live`. It drops and
re-migrates `TEST_DATABASE_URL` (default `coach_test`) and fails past `LIVE_COST_CAP_MICROS` ($1);
`LIVE_LLM_DRY=1 pnpm test:live` plays the same conversations on the mock. Known flake risks:
conversation 2 assumes the model drafts a proposal rather than calling `substitute_exercise`, and
conversation 1 that the answer quotes the month's top bench set. Not yet run against the real
model.

## Analytics and reviews (M6)

This is the M6 test inventory, by layer, so each claim in milestones.md can be traced to a file.
Counts are test files. Performance is not in CI (see "CI"), so the M6 screens have no performance
test on `main`; the numbers in docs/performance.md come from the runs it names.

### Domain and components (unit)

- `src/lib/domain/analytics/*.test.ts` (13 files): the periods and windows, the metric catalogue,
  the strength, running, adherence, workload, prescribed-versus-actual and weight figures, the
  weight goal, the strength-week rollups, and the trend classifier. Trend verdicts are tested on
  synthetic 12-week series over 200 seeds: a flat series around 100 with uniform ±3 % noise is
  called normal variation, and a series rising 1 % a week with normal noise of SD 1 % is found to
  be a real trend, up and good, in at least 95 % of the seeds.
- `scripts/analytics-client-imports.test.ts`: only the client-safe modules of the analytics domain
  reach the browser. It walks the runtime imports with `scripts/import-graph.ts`.
- `scripts/chart-body-imports.test.ts`: a chart body is imported only by the SSR-guarded registry
  (`src/lib/ui/charts/bodies.ts`), and only through `import()`.
- `src/lib/ui/charts/*.test.ts` (6 files): the chart geometry, scales, palette, line and bar models,
  and the focus ring.
- `src/lib/domain/programming/review/*.test.ts` (6 files), `next-block/*.test.ts` (4 files),
  `progression.test.ts`, `periodisation/deload.test.ts` and `periodisation/replan.test.ts`: the
  review snapshot, the weekly and cycle reviews, the next-week and cycle directives, the
  progression steps, and the next block's input, dates and generator.
- `src/lib/server/services/analytics/format.test.ts` and
  `src/lib/server/services/reviews/store.test.ts`.
- `src/routes/api/reviews/narrate/config.test.ts`: the write-up endpoint may run as long as a coach
  turn, and a turn stops before that limit.

### Integration (real Postgres)

- `tests/integration/analytics/` (11 files): the fact queries (completed, undeleted workouts only),
  the muscle-group targets read from each block's stored input, the strength-week rollups, the
  strength, running and general dashboards, the overview, the exercise analytics, and the fixtures.
- `tests/integration/reviews/` (16 files): the review schema and store, weekly and cycle reviews,
  superseded revisions, the deload that is proposed again, the weekly conflicts, the next-week and
  next-cycle proposals, the cycle review's screen, the write-up (`narrate.test.ts`) and the write-up
  load.
- `tests/integration/coach/analytics-parity.test.ts`: the coach's records and analytics tools return
  the same figures as the screens, because they call the same functions.

### End to end (Playwright, serial)

- The journeys, `e2e/journey-weekly-review.serial.e2e.ts` and `e2e/journey-cycle-review.serial.e2e.ts`,
  each on an iPhone and in a desktop window (`e2e/desktop.ts`, `DESKTOP`). The weekly one runs a
  logged week to Today's review, the decision on next week, Train's notice and History. The cycle
  one runs the end of a block to its cycle review, the next block, Train's week 1, History and the
  coach inbox.
- The Progress views: `progress.serial`, `progress-strength`, `progress-running`,
  `progress-general`, `progress-exercise` and `exercise-trends-link`. The figures are checked
  against the SQL oracles in `e2e/oracles/`, and axe is clean in both themes on each
  view. `offline.e2e.ts` checks Progress's designed offline state.
- The reviews: `reviews`, `reviews-sections`, `review-entry`, `review-next-week`,
  `review-narrative`, `review-proposal-origin`, `cycle-review`, `next-cycle` and
  `train-review-notice`.
- The seeding route: `e2e/analytics-support.ts` posts to `/api/test-support/analytics`, and
  `e2e/analytics-support.selftest.serial.e2e.ts` checks that seeding. `e2e/review-support.ts` seeds
  a review scenario through that route, at dates the server works out from the owner's today.

### Query plans and budgets

- `pnpm db:explain` (`scripts/explain/analytics.cases.ts`, `analytics-dataset.ts` and `page-load.ts`)
  explains the M6 fact and review queries on two years of data, and times the page loads with
  serialisation. A median over 300 ms or page data over 32 KB gzip fails the run. Its unit tests are
  `scripts/explain/analytics-dataset.test.ts` and `scripts/explain/page-load.test.ts`.
- `pnpm budgets` checks each M6 route's initial JS and route CSS (docs/performance.md, "Budgets").

## CI

`.github/workflows/ci.yml` runs on every pull request and every push to `main`: lint, type-check, the
migration drift check, unit tests, the integration tests (postgres:18 service), both builds with the
budgets, and one e2e job that runs the PRD journeys on Chromium. A scheduled or manual run
(`workflow_dispatch`) also runs every Chromium e2e leg (main, serial and exclusive, as shards) and the
journeys on WebKit, the only WebKit run in CI. Each event's legs are listed in `scripts/ci-legs.ts`.
Performance is not tested in CI, by the owner's decision, to keep CI simple and cheap: Lighthouse and
the `perf` project run locally only (`pnpm lighthouse`, `E2E_GROUP=alone pnpm test:e2e`).

The run's first job, `Scope of the run`, runs `scripts/ci-scope.ts`. A change that touches only
`docs/`, `plan/`, agent tooling (`.claude/`, `.agents/`, `.codex/`, `.pi/`), root Markdown or
`.env.example`, and a merge to `main`, onto the previous tip, whose tree its pull request already
tested, is a light run: it skips the integration tests and the e2e legs. Lint, type-check, unit tests
(which include the docs guards) and the build always run. A nightly scheduled run tests `main`'s
full set, since most runs on `main` are light.

`.github/workflows/post-deploy-smoke.yml` checks production from outside after every production
deploy (health with the database up, the sign-in screen, deny by default, security headers on
`/` and on the prerendered pages, no test-only routes; docs/deployment.md). It needs no secrets and
runs by hand too.

**Not yet verified:** the workflows have not run on GitHub (nothing has been pushed), and the
WebKit project has never run locally (WebKit is not installed in the build environment), so iOS
Safari behaviour (glass, PWA install, status bar) is unverified. (Since then: the real-device
checklist below passed in Chrome for iOS on 2026-11-06.) The first CI run, including its
WebKit screenshots, must be attached to the M1 PR as evidence.

Do not judge the glass from e2e screenshots, where text behind the 92% glass can show through:
headless Chromium's `blur(32px)` only dims the text behind the tab labels (checked on Linux, as in
CI), and Playwright's WebKit painted no `backdrop-filter` into screenshots on macOS (`invert(1)` on
the nav left them untouched; unchecked on CI's Linux WebKit). Judge glass on a device.

### Real-device checklist (merge gate for UI milestones)

On an iPhone with current iOS, in Chrome for iOS (the owner's browser; WebKit engine), against
a preview deployment (Vercel Authentication on):

1. Chrome: every tab renders; the bottom nav sits above the home indicator; glass blurs the
   content behind it; nothing scrolls sideways.
2. Optional (Add to Home Screen is a Safari share-sheet feature): in Safari, Share → Add to Home
   Screen; launch the installed app: standalone (no Safari chrome), status bar text readable in
   dark and light (Profile → Appearance), splash/icon correct.
3. Settings → Display → Automatic appearance, or Control Centre dark-mode toggle while the app is
   open with Appearance = Auto: the theme and status bar follow.
4. Airplane mode: tabs keep the shell, Profile shows the offline state; back online it loads.
5. Plate calculator: one-handed stepper hold-to-repeat, typing with the decimal keypad, swipe the
   sheet down to close.
6. Step-up (Profile → Security, more than 5 minutes after signing in): removing a passkey and
   signing out a device each ask "Confirm it's you" once; Face ID passes and the action
   completes; cancelling Face ID says nothing was changed. Add passkey after the check opens the
   passkey prompt (if the browser wants a fresh tap for that second prompt, the next tap works).
7. Desktop, in Chrome on the owner's Mac against the same deployment: every tab beside the rail at
   full window width and at about 1024 px; hover and Tab focus visible on the rail, rows and
   buttons; the new-goal sheet (Profile → Goals) opens as a centred dialog and Escape closes it;
   nothing scrolls sideways.
8. Workout (M4), on the iPhone: log a whole session one-handed (steppers, RPE chips, Complete
   set); lock the phone during a rest and reopen: the timer reads the right time, or 'Rest over'
   with how long ago; airplane mode in the middle of a session: sets keep logging, a reload
   restores the workout, and back online the sync pill reads Saved; installed to the home
   screen (Safari), the workout header sits under the status bar and the logger and the rest
   pill above the home indicator.
9. Coach (M5), a streamed answer and Stop, on the iPhone: on the Coach tab, ask a question about
   your training. The question appears at once with 'Thinking…'; activity chips name the tools as
   they run, and the words arrive block by block while the page follows them down until you scroll
   up. Tap Stop (the square that replaces Send while an answer runs): the answer ends with the words
   already shown, marked 'Stopped' with Try again, and a reload keeps that mark. Then lock the phone
   during a streamed answer for about 30 seconds and unlock: the answer has either finished, or it
   reads 'Interrupted' with Try again. Either way the answer is not drawn twice.
10. Coach (M5), the keyboard and the safe areas: installed to the home screen as in item 2, open the
    Coach tab and tap the message box. The keyboard rises, the box stays above it, and the thread
    scrolls above the box, not under it. On the phone Return adds a new line and does not send; Send
    sends. With the keyboard down, the box sits above the home indicator and clear of the bottom bar,
    and scrolling to the last message stops above it, so nothing hides under the box.
11. Coach (M5), Accept on a proposal: ask the coach for a change to next week's plan. A proposal card
    follows its answer, with what changes, why, and the impact on each week, and with Accept, Reject
    and Ask for changes. Nothing changes until Accept. Tap Accept: the card reads 'Applied as version
    N' with 'View in Train', and that link opens the version in Train. Reject opens a sheet with an
    optional reason, for a proposal you do not want.
12. Coach (M5), the offline notice: turn on airplane mode and ask the coach a question. The turn ends
    in the notice 'You’re offline' with 'The coach needs a connection. Try again once you’re back
    online.' and Try again. With a proposal card on screen, Accept, Reject and Ask for changes are
    disabled, and the card says 'You’re offline. Decide once you’re back online.' Turn airplane mode
    off and tap Try again: the answer streams.
13. Coach (M5), a logged weigh-in and Undo: ask "I weighed 82.4 kg this morning". The answer says it
    logged the weight, and a card after it reads 'Logged 82.4 kg for today' with an Undo button. Tap
    Undo: the button is busy, then the card reads 'Undone'. After a reload the card is gone, because
    the write has been taken back.
14. Progress (M6), the charts on the iPhone and with VoiceOver: on Progress, open Overview, Strength,
    Running and General in turn. Each chart shows its title, a context line (period · comparison ·
    estimated or measured · trend window) and one sentence of summary, and it draws in its box
    without the page jumping. Drag a finger across a line chart: a crosshair snaps to the nearest week,
    and one tooltip lists every series, kept inside the plot. Tap 'Show as table' under a chart: the
    table scrolls sideways in its own region, its headers carry the units, and the week in progress
    is marked 'so far'. With VoiceOver on, swipe through a chart and its table: the title and summary
    are read, and the table gives the same numbers as the plot. Note what VoiceOver says for a line
    chart's group, since its label mentions the arrow keys, which a phone does not have.
15. Progress (M6), offline on the iPhone: on Overview, turn on airplane mode, tap Strength, then
    'Last 26 weeks' in the period picker. Both switches are cancelled, the numbers on screen stay,
    and 'You’re offline — showing 12 weeks' appears above the views. Turn airplane mode off: the
    notice clears and the switch works.
16. Progress (M6), a weekly review on the iPhone: open Progress, then Reviews, then a reviewed week
    under 'Weekly reviews' (newest first). Its hero shows the week, the one-sentence summary and the
    adherence meter, and planned against completed reads in words. The next-week card offers its
    action for that week, 'Generate next week' or 'Keep next week as planned' (which opens a sheet
    with an optional reason). The coach's write-up, or why there is none, sits under 'Your coach’s
    write-up', with 'Discuss with your coach'. Tap 'Create review' on a week with no review; a week
    not yet reviewable says when it will be. On the phone 'All reviews' returns to the list. In
    airplane mode, Create is disabled and says you are offline, and the next-week card says 'You’re
    offline. Decide once you’re back online.'
17. Progress (M6), a cycle review on the iPhone: open Progress, then Reviews, then a finished block
    under 'Cycle reviews'. The hero shows the block, its dates, the summary, the adherence meter, and
    the planned, completed, skipped and missed sessions in one line. Below it come goal progress,
    strength and endurance lines labelled estimated, accumulated fatigue, volume and intensity,
    exercise effectiveness (Keep or Rotate), and adherence with the deload need. On the phone each
    section shows its verdict line until you open it. If a next block is planned, its card shows its
    title and words before its code loads: tap Not now to leave it, and Start next block only to
    start it. In airplane mode, Start next block says 'You’re offline. Start it once you’re back
    online.'

18. Train (M7), the week's findings and 'Why Monday?' on the iPhone: on Train, open a week with a
    clash. The line under the position counts it ('1 heads-up this week'). Tap the line under the
    session card: its why opens, and a second tap closes it. Tap 'Why Monday?' (the card's day) under
    a card: the decisions that put the session there open as a list, the owner's moves first; tap
    again to close. Nothing opens by itself, and the page does not jump.
19. Train (M7), the season at 320 px in both themes: on the phone at its zoomed width (Settings → Display &
    Brightness → Display Zoom), and at 320 px in desktop Chrome's device toolbar, which is not a
    device check, tap Plan on Train while the season is still loading, then
    once it has loaded, in dark and in light (Profile → Appearance). Each block from this one on
    lists its goals' roles, the leader first; deload, taper and recovery weeks carry their word
    after the number; nothing scrolls sideways, and the list does not shift when the season lands.
20. Profile (M7), a priority change and its re-plan: on Profile → Goals, drag a goal (or use its
    arrows) to change the order. The list moves at once, and a calm line under it then says what
    happened, for example that a re-plan is ready, with a link. Train shows 'A re-plan for your new
    priorities is ready · Review'. Open it: the proposal says 'From your goal change' and lists what
    changes week by week. Accept it: it applies as a new version, which Train then shows.
21. Progress (M7), a deload card on Monday and mid-week: open a weekly review that proposes a
    deload. On a Monday its headline reads 'This week becomes a deload week from today' or 'Next week
    becomes a deload week'; mid-week, only the sessions still ahead are listed under 'What changes'.
    'Why' lists the signals. Tap 'Accept the deload' or 'Keep the plan' and check Train's week.
22. Onboarding and Profile (M7), heart rate: in onboarding's 'Running & Muay Thai' step, and in
    Profile → Running & Muay Thai, enter max, resting and threshold heart rate on the numeric
    keypad; an out-of-range or out-of-order value shows its error at the field. Save, build or
    regenerate a plan, and open a run session: its segments read 'Zone 2 · 134–148 bpm' style
    ranges.

Record device, iOS version, date and screenshots in the PR.

Last pass: 2026-11-06, the owner's iPhone 16 Pro Max, iOS 27.0.1, Chrome for iOS, right
after the owner setup (docs/deployment.md, "Owner setup"); recorded in M2's docs PR. Items 8 to
22 have not been run on a device yet.
