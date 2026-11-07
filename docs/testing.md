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
extrapolated from reps to failure at `low` confidence), the plate calculator (exact DP incl. limited inventories), the owner's local
calendar day (a weigh-in at 18:30 in Los Angeles is not tomorrow; daylight saving; only IANA zones), and load
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

Projects (all `devices['iPhone 15 Pro']`):

| Project           | Browser  | Runs                                                                                            |
| ----------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `setup`           | Chromium | `auth.setup.ts`: the owner's real first-run setup; saves the signed-in state                    |
| `iphone-chromium` | Chromium | every functional spec, signed in from `setup`'s state                                           |
| `perf`            | Chromium | `perf.e2e.ts`, alone with one worker, after the functional suite                                |
| `setup-webkit`    | WebKit   | `auth-webkit.setup.ts`: a session from the test-only route (CI or `E2E_WEBKIT=1`)               |
| `iphone-webkit`   | WebKit   | every functional spec on that session (CI or `E2E_WEBKIT=1`; needs `playwright install webkit`) |
| `serial-chromium` | Chromium | `*.serial.e2e.ts` one at a time, after the functional specs: they change the training profile   |
| `serial-webkit`   | WebKit   | the same specs after `serial-chromium` (CI or `E2E_WEBKIT=1`)                                   |
| `exclusive`       | Chromium | `*.exclusive.e2e.ts`, last and alone: account-wide actions                                      |

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
  and change nothing.
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

- `shell.e2e.ts` — the sign-in screen is the landing page (signed in, `/` goes to Today); bottom nav pinned to the bottom with ≥ 44 px targets and a
  computed `backdrop-filter` blur; navigation across all five tabs with `aria-current`; no console
  errors on any screen; plate calculator sheet (stepper; Escape while typing cancels the edit
  without closing the sheet; a target below the bar is explained and the stepper's minimum is the
  bar; the kg/lb switch stays local to the calculator; Close returns focus); theme applied before
  first paint and persisted (under the CSP), and Auto following an OS appearance change while
  open (theme-color included); no screen scrolls sideways; nothing
  sits under fixed chrome at rest (landing CTAs, Coach composer); compact segmented controls keep
  a 44 px hit area.
- `plate-calculator.e2e.ts` — Train's lazy plate-calculator sheet (no service worker, chunks
  routed): its code is not in Train's load and arrives on the first tap, through the import
  alone (no modulepreload tag, whose failure WebKit would keep: `build.modulePreload` in
  `vite.config.ts` gives no lazy import one), which opens the sheet once it does (the row busy
  meanwhile); a failed fetch on hover says nothing, a failed tap shows
  a Retry notice under the row (44 px target, axe in both themes) that a later failed prefetch
  leaves in place; Retry back online opens the sheet, offline the notice stays, a tap that fails
  again online reloads Train with `?tool=plates`, and leaving Train mid-retry stays left (WebKit).
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
  overtaken screen; an unknown section is a 404. `a11y.e2e.ts` audits the screen and its discard
  prompt in both themes.
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

### Programs

The program store, program reads, versioning and owner edits, on real Postgres. No tests yet.

### History

Logged training, the history queries and `pnpm db:explain`. No tests yet.

### Generator

The deterministic week-1 generator: its rules, stages and scenarios. No tests yet.

### Concurrent training

Commitments, running, interference rules and placement across disciplines. No tests yet.

### Train screens

The Train week, the plan overview, session detail and the edit sheets. No tests yet.

### Program history

Versions and their decisions with the why; older versions stay viewable. No tests yet.

### Today screens

Build my program, today's sessions and what is next this week. No tests yet.

## The LLM in tests

Milestone 5 adds the coach behind `LlmProvider`. Tests use the deterministic `mock` provider by
default (`LLM_PROVIDER=mock`); real-model integration tests will be opt-in and skipped without a
key. No key exists in CI today.

## CI

`.github/workflows/ci.yml` runs lint, type-check, the migration drift check, unit + integration
(postgres:18 service), both builds + budgets, Playwright (Chromium + WebKit) and an asserted
Lighthouse run on every PR and push to `main`.

`.github/workflows/post-deploy-smoke.yml` checks production from outside after every production
deploy (health with the database up, the sign-in screen, deny by default, security headers, no
test-only routes; docs/deployment.md). It needs no secrets and runs by hand too.

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

Record device, iOS version, date and screenshots in the PR.

Last pass: 2026-11-06, the owner's iPhone 16 Pro Max, iOS 27.0.1, Chrome for iOS, right
after the owner setup (docs/deployment.md, "Owner setup"); recorded in M2's docs PR.
