# Security

Performance Coach is **strictly private**: one owner (Niko Cruz), no public registration, every
endpoint protected, passkeys as the only everyday way in (PRD §13, ADR 0006). This document is
the reference for how authentication works, what it protects, and what it does not.

Code: `src/lib/server/auth/` (server), `src/lib/client/passkeys.ts` and
`src/lib/client/signout.ts` (browser), `src/hooks.server.ts` (the guard). WebAuthn is done
entirely by **SimpleWebAuthn** (`@simplewebauthn/server` 14, `@simplewebauthn/browser` 14). The
app's own code uses `node:crypto` only for randomness, SHA-256 and `timingSafeEqual`.

## Threat model

| Asset                                   | Threats considered                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Training history, profile, coach memory | Anyone on the internet reaching an endpoint; a stolen or lost device; a malicious site the owner visits (CSRF); XSS |
| The owner account                       | Phishing; credential stuffing; brute force of recovery codes or the setup token; session theft or fixation          |
| Deployments                             | A preview deployment used to obtain or replay production credentials; test-only routes reaching a hosted build      |
| Secrets (DB URLs, LLM key)              | Leaking to the browser or the repository                                                                            |

Out of scope (accepted): compromise of the owner's unlocked device or password manager account
(iCloud Keychain), of Vercel/Neon/GitHub accounts, or of the platform's TLS. A malicious browser
extension on the owner's browser can act as the owner.

- **A session lost elsewhere.** When the device's next sync request gets a 401 (signed out
  elsewhere, revoked from Security, or expired), it deletes the server's copies it holds (saved
  kits, canonical rows, the cached library, the owner's units and finished workouts). It keeps
  only the unsynced outbox entries and the unfinished workout's device state until a sign-in
  ([ADR 0012](adr/0012-offline-workout-sync.md), "Losing the session"). The workout pages then
  show no workout details, only how many changes wait.

## Accounts and credentials

- **One owner.** `owners` has a `singleton` column that is always true and unique: a second owner
  row cannot exist. There is no sign-up route; the only way an owner comes to exist is first-run
  setup.
- **Passkeys (WebAuthn).** Discoverable credentials (resident keys) with **user verification
  required** (Face ID / Touch ID / device PIN), attestation `none`. Stored: credential id, public
  key (`bytea`), signature counter, transports, device type, backed-up flag, AAGUID, nickname,
  created and last-used times. Never a private key or any secret.
- **Signature counters** only move forward: a non-zero counter that does not increase is rejected
  by SimpleWebAuthn, and the update itself is conditional (`counter < new`), so two concurrent
  sign-ins cannot roll it back (cloned-authenticator signal). Synced passkeys report 0, which is
  accepted as the spec allows.
- **Relying party** (`relying-party.ts`, unit-tested): production is exactly
  `https://coach.nikocruz.com`, RP ID `coach.nikocruz.com`, whatever host a request arrives on
  (other hosts are refused). Previews use their own `*.vercel.app` host as RP ID and origin and
  refuse anything under `nikocruz.com`, so a preview can neither request nor accept an assertion
  for the production RP; previews also have their own database. Development and tests: `localhost`.
  The challenge row records the RP ID it was issued for, and verification uses the same.

## Flows

### First-run setup (once)

1. The tech lead runs `pnpm auth:setup-token`: a 256-bit random token and its SHA-256. Only the
   hash is configured (`OWNER_SETUP_TOKEN_HASH`); the token travels to the owner in the link
   `https://coach.nikocruz.com/setup?token=…`.
2. `/setup` answers **404** unless the token's SHA-256 equals the configured hash (compared with
   `timingSafeEqual` on the two digests), that token has never completed a setup, **and** no
   passkey exists. Wrong tokens are audited and rate-limited (10 per 15 min per client); past the
   limit the page is a 404 as well, even with the right token, and not recorded as a server error.
3. The owner enters a name and creates a passkey. In one transaction (advisory-locked, so two
   concurrent setups cannot both win): the owner and passkey are created, setup is marked
   complete, the token's hash is recorded as used (`used_setup_tokens`), 10 recovery codes are
   generated and stored hashed, and a session starts.
4. The 10 codes are returned **once** in that response and shown with copy/download and a
   required acknowledgement. From then on `/setup` is a 404 for good (even with the right token).
   A token works for **one** setup: `pnpm auth:reset-owner` reopens setup but keeps the used
   hashes, so the old link (audited as `token_used` if tried) stays refused even while its hash is
   still configured, and the reset needs a new token.

### Sign-in

The sign-in screen (`/`) offers the passkey two ways: **conditional UI** (Safari and Chrome offer
the saved passkey in the autofill of the account field) and a **Sign in with passkey** button
(modal). Options carry a fresh single-use challenge (5-minute lifetime, purpose `authenticate`);
the browser's assertion is verified by SimpleWebAuthn against the challenge, origin, RP ID, the
stored public key and counter, with user verification required. The user handle in the assertion
must be the owner's. Success **rotates** the session: the cookie the device presented (if any)
is revoked and a new token is issued. The return path (`?next=`) is accepted only as a same-origin
app path (`return-path.ts`).

### Recovery

- 10 codes, 80 random bits each (`XXXX-XXXX-XXXX-XXXX`, Crockford base32: no I/L/O/U), stored as
  SHA-256 of the normalised code. Input ignores case, spaces and dashes and maps look-alikes.
- `/recover` burns a code atomically (`UPDATE … WHERE used_at IS NULL RETURNING`), rotates the
  session and grants a **recovery session**: 15 minutes, no sliding expiry, and the guard lets it
  reach only `/recover/passkey`, the add-passkey endpoints and sign-out. Pages redirect there;
  `/api/*` answers `403 passkey_required`.
- Registering a passkey from that session rotates it into a full session (the recovery session is
  revoked) and lands on Security with a prompt to remove the lost passkey. A recovery session
  revoked or expired while that request is in flight (e.g. by Sign out everywhere else) adds no
  passkey and gets no full session (see Passkey management). Sign out everywhere else that
  arrives while the new passkey is being stored waits for it and then ends the full session too.
  That registration is the one change a recovery session may make without step-up (below), and
  the new session counts as freshly authenticated: it has just verified its new passkey.
- Codes can be regenerated from Security (all old codes stop working; new set shown once, with
  acknowledgement). A recovery session cannot regenerate codes.
- Rate limits: 5 attempts per 15 min per client and 20 failed attempts per hour in total; the total
  never refuses a valid code (see Rate limits).
- Lost every passkey **and** every code: the guarded `pnpm auth:reset-owner` (docs/deployment.md).

### Passkey management (Profile → Security)

Add (a real registration bound to the current session: the challenge row stores the session id),
rename (1–64 characters), remove. **The last passkey can never be removed**: the check runs under
a row lock, so two concurrent removals cannot both pass. Removing a passkey also ends every other
session that signed in with it. A new passkey is stored only if the session adding it is still
live, re-checked under a row lock: a session revoked after the guard let the request in adds
nothing. The passkey and session ids these actions receive are checked by shape before any query
(base64url, UUID): a malformed id is answered like an unknown one (`404`, `not_found`), never
with a database error. Adding and removing need step-up (below); renaming does not.

### Step-up re-authentication (ASVS V3.7)

A session cookie alone must not be enough to take the account over (add a passkey, remove the
owner's, sign the owner out, mint new recovery codes). So these actions need a **user-verified
assertion with one of the owner's existing passkeys on this session within the last 5 minutes**
(`reauth.ts`, `SESSION.reauthMs`):

| Action                                | Step-up | Why                                                                   |
| ------------------------------------- | ------- | --------------------------------------------------------------------- |
| Add a passkey                         | yes     | a new way in                                                          |
| Remove a passkey                      | yes     | locks the owner out of a device                                       |
| Create new recovery codes             | yes     | a new way in (and voids the owner's codes)                            |
| Sign out one device / everywhere else | yes     | signs the owner out; "everywhere else" would keep only the thief's    |
| Rename a passkey                      | no      | changes no credential, session or secret; audited; removal still asks |
| Sign out (this device), view anything | no      | harmless to the owner                                                 |

- `auth_sessions.reauthenticated_at` records the last passkey assertion on the session. A
  passkey sign-in, first-run setup and the passkey that finishes a recovery set it (each is a
  user-verified ceremony that just happened); test-minted and recovery sessions start without it.
- The server is the boundary: the use-cases throw `reauth_required` (403) when it is missing or
  older than 5 minutes; form actions pass the code to the screen. Registration is checked when
  its ceremony starts (its challenge is bound to the session and lives 5 minutes): refusing at
  the end would leave a passkey on the device that the server never stored.
- The ceremony: `POST /api/auth/reauth/options` (owner sessions only) issues a challenge with
  purpose `reauthenticate`, bound to the session, with `allowCredentials` set to the owner's
  passkeys and user verification required; `POST /api/auth/reauth/verify` verifies it with
  SimpleWebAuthn (challenge, origin, RP ID, the owner's public key, counter, UV), advances the
  counter and stamps the session (only if it is still live). Rate-limited per session; success
  and failure are audited.
- The Security screen asks only when the server refuses: a **Confirm it's you** sheet (over the
  sheet that was refused, or on its own), then the action is retried. Cancelled or failed
  checks say "Nothing was changed". Its code is in the lazily loaded sheets and passkey helpers.
- Exception: a recovery session (no usable passkey) may register its new passkey; it cannot
  start a step-up, regenerate codes or reach anything else.
- Existing sessions have no timestamp when this ships: their first sensitive action asks once.

### Sessions

| Property                | Value                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Token                   | 32 random bytes, base64url, in the cookie only. Postgres stores its SHA-256 (`auth_sessions.token_hash`). |
| Cookie (HTTPS)          | `__Host-session`; `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`                                   |
| Cookie (HTTP localhost) | `session`, same flags without `Secure` (browsers refuse `Secure`/`__Host-` there)                         |
| Idle expiry             | 30 days, slid forward at most once a day (the cookie is re-sent then)                                     |
| Absolute expiry         | 90 days after sign-in, however active                                                                     |
| Revocation              | Checked on every request (no cache): revoked or expired sessions are rejected immediately                 |
| Rotation                | New token on every passkey sign-in, setup and recovery; the presented one is revoked                      |
| Step-up                 | Passkey assertion on the session within 5 minutes for sensitive Security actions (see above)              |
| Management              | List (current marked, recovery sign-ins flagged), sign out one, sign out everywhere else, sign out        |

### Sign-out

Unsynced workout changes are never deleted without the owner's choice (ADR 0012, 'Losing the
session'). Before signing out, the screen flushes the workout outbox for at most 5 s
(`src/lib/client/workout/shutdown.ts`) and, if changes are still unsynced, asks before signing
out deletes them; "Stay signed in" keeps every change.

`POST /api/auth/signout` revokes the session, deletes the cookie and sends
`Clear-Site-Data: "cache"` (drops HTTP-cached and back/forward-cached pages). The browser then
tells its other tabs to close the workout store, deletes every Cache Storage entry except the
current versioned app shell (`pc-shell-<version>`: the public build and the offline screen),
every IndexedDB database and session storage (`src/lib/client/signout.ts`), leaves a one-shot
marker in session storage, and lands on the sign-in screen, which consumes the marker and clears
again. A signed-out URL without the marker (typed, from history, or a sign-out without
JavaScript) keeps only unsynced workout changes until the owner deletes them or signs in: what
the server already holds is deleted, as after a 401, and the sign-in screen offers to delete the
rest. It also deletes /workout's prepainted card from localStorage (`pc:workout-prepaint:v1`:
the current exercise's name, prescription and sets, the only account data kept there). A lost
session (a 401's purge) blocks that card until the server answers as the owner again. **Device
preferences (theme, units in localStorage) are kept on purpose**: they are not account data. The
workout settings (`pc:workout:v1`: rest per exercise type, auto-start rest, sound, vibration,
keep-awake), the plate inventory (`pc:plates:v1`, one per unit) and Train's rest timer
(`pc:rest:v1`) are device preferences too, and sign-out keeps them. `"storage"` and `"cookies"`
are deliberately not sent: `"storage"` would also wipe those preferences and unregister the
offline app shell, and `"cookies"` applies to the whole registrable domain (`nikocruz.com`), not
just this app. If the server cannot be reached the client says so and changes nothing (the
HttpOnly cookie can only be deleted by the server).

## Deny by default

`hooks.server.ts` runs `guardRequest` (`guard.ts`) for every dynamic request. Every route's
access is declared in `routes.ts` (`ROUTE_ACCESS`, typed against SvelteKit's generated `RouteId`
union, so an unclassified route fails `pnpm check`); an unknown route is `owner`.

| Access        | Routes                                                                                                                                                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public`      | `/` (sign-in), `/setup`, `/recover`, `/api/auth/signin/{options,verify}`, `/api/auth/setup/{options,verify}`, `/api/auth/signout`, `/api/health`, `/offline` (prerendered), `/workout`, `/workout/run`, `/workout/session` (prerendered, data-free), `/api/test-support/session` (404 unless test routes are enabled) |
| `any-session` | `/recover/passkey`, `/api/auth/passkeys/{options,verify}`                                                                                                                                                                                                                                                             |
| `owner`       | everything else, including `/api/auth/reauth/{options,verify}`, `/api/vitals` and `/api/client-errors`                                                                                                                                                                                                                |

Without a session, pages answer `303` to `/?next=<path>` (a JSON redirect for client-side data
requests and enhanced form actions) and `/api/*` answers `401 {"error":"unauthenticated"}`. A
stale or forged cookie is cleared. Static and prerendered files (immutable build assets, icons,
manifest, robots.txt, the service worker, `/offline` and the three workout pages) never reach the
hooks and hold no personal data. A workout page's data comes only from IndexedDB, from
`/workout`'s prepainted card in localStorage (`pc:workout-prepaint:v1`, #410) and from owner-only
endpoints; sign-out deletes the first two. Prerendered pages still get the dynamic responses'
security headers: `vercel.json` sends them `STATIC_PAGE_HEADERS`
(`src/lib/server/security-headers.ts`), which adds `frame-ancestors 'none'` because their own CSP
is a `<meta>` tag that cannot carry it. `scripts/vercel-headers.test.ts` keeps `vercel.json`
equal to that constant for every prerendered page, and the post-deploy smoke check asserts it in
production. Proven by `src/lib/server/auth/routes.test.ts` and `e2e/access.e2e.ts`, which walk
`src/routes` so new routes are covered automatically.

## CSRF

Three independent layers:

1. **Origin check on every state-changing request** (`csrf.ts`): any method other than
   GET/HEAD/OPTIONS must carry an `Origin` equal to the app's origin (and `Sec-Fetch-Site`, when
   sent, must be `same-origin`). This covers JSON endpoints, which SvelteKit's own check does not.
   Browsers send `Origin` on all such requests; a missing one is refused.
2. **SvelteKit's form check** (`csrf.checkOrigin`, on by default) for form actions.
3. **`SameSite=Lax`** on the session cookie: cross-site subrequests and POSTs carry no session.

`POST /api/workouts/sync` is owner-only and Origin-checked by the guard, takes JSON capped at
64 KB (413 above), and validates every mutation on its own before it touches the database
(`src/lib/server/services/workouts/sync.ts`). A recovery session's request answers 403 and the
device keeps everything.

## Rate limits (Postgres, no Redis)

One row per bucket in `auth_rate_limits`, updated by a single atomic upsert (fixed windows), so
every server instance shares the counters. The first refusal of a window is audited.

| Bucket            | Limit           | Keyed on |
| ----------------- | --------------- | -------- |
| `signin.options`  | 30 / minute     | client   |
| `signin.verify`   | 10 / minute     | client   |
| `setup`           | 10 / 15 minutes | client   |
| `recovery`        | 5 / 15 minutes  | client   |
| `recovery.global` | 20 / hour       | all      |
| `register`        | 20 / 15 minutes | session  |
| `reauth`          | 20 / 15 minutes | session  |
| `manage`          | 60 / minute     | session  |
| `signout`         | 30 / minute     | client   |
| `coach.turn`      | 30 / 10 minutes | all      |
| `coach.action`    | 60 / minute     | all      |

The client address is the platform's (`getClientAddress()`: `x-forwarded-for` as set by Vercel).
A client bucket keys on the whole address for IPv4 and on the /64 for IPv6 (`client-network.ts`):
one host or LAN normally holds a whole /64 (SLAAC, privacy addresses) and could otherwise rotate
through fresh buckets. IPv4-mapped IPv6 (`::ffff:203.0.113.7`) counts as its IPv4 address. A
network routed a larger prefix (a /56 or /48) still spans many /64s, just as an attacker may hold
many IPv4 addresses: per-client limits slow abuse rather than bound it. The audit log keeps the
full address. Refusals answer `429` with `Retry-After`, except the `/setup` page, which answers
`404` like any other refused setup link.

Coach endpoints (`/api/coach/*`) are owner routes, Origin-checked by the guard, rate-limited
across all the owner's devices (`coach.turn` for turns, `coach.action` for everything else) and
cost-capped at $5 a day (`DAILY_COST_CAP_USD`); a refusal answers `429` with `Retry-After`.

Stale counters are pruned on writes: the first hit of each window also deletes up to 100 counters
whose window started over two days ago (longer than any window; `RATE_LIMIT_PRUNE` in `policy.ts`),
skipping rows another request holds. One-off clients cannot grow `auth_rate_limits` without bound,
and no request pays for more than one small indexed delete.

`recovery.global` counts failed codes only, charged after the code is looked up, so it never
refuses a valid one: a client staying within its own limit cannot fill it and lock the owner out
of recovery. It is a tripwire (audited when it trips; further wrong codes answer `429`), not a
bound on distributed guessing, which rests on the per-client limit and the 80-bit codes.

`signout` counts only requests that end no session. A sign-out that presents a live session is
never refused (the session is revoked, the cookie deleted), so someone sharing the owner's
address (the same NAT or Wi-Fi) cannot fill the bucket and keep the owner signed in. A token ends
its session only once, so this cannot be used to flood.

## Audit log

`auth_events` records setup completed/failed, sign-in succeeded/failed (with the reason from
SimpleWebAuthn), passkey added/renamed/removed, recovery used/failed/regenerated, session
revoked / revoked others, step-up succeeded/failed, sign-out, rate limiting and owner resets,
with request id, client address and a User-Agent summary. Rows are kept if the owner is reset.
Security shows the most recent events, folding each run of refused attempts (anyone can cause
those) into one row such as "25 failed sign-in attempts", and always keeps the latest security
changes (setup, passkeys added or removed, recovery codes used or replaced, sessions ended, owner
resets) in view, so a flood of failures cannot push them out.

## Training history

Postgres keeps the training history, not the app ([ADR 0010](adr/0010-program-versioning.md),
docs/architecture.md "Training model (M3)"):

- **DELETE is always refused** on program, prescription and training-log tables, with no session
  flag to turn it off (`drizzle/0009_program_history_guards.sql`,
  `drizzle/0012_prescription_history_guards.sql`, `drizzle/0014_training_log_guards.sql`).
  Program rows also refuse UPDATE, except the `programs` head, whose `program_head_guard` allows
  `status`, `archived_at` and a forward `current_version_id`; logged rows accept the owner's edits, each audited, and are
  deleted softly.
- **TRUNCATE, a disabled trigger and `session_replication_role` bypass the guards**, because
  they skip row triggers. Server code may use none of them; only test and reset code uses
  TRUNCATE: the integration cleanup (`tests/integration/helpers.ts`) and the e2e program reset
  (`e2e/program-support.ts`). `scripts/history-guards.test.ts` fails if server code contains
  `truncate`, `session_replication_role` or `disable trigger`.
- **`training_audit` is owner-scoped and immutable**: each row carries its `owner_id` (a foreign
  key to `owners`), the row before and after, and the actor; it refuses UPDATE and DELETE.
- **Deleting the owner is refused**: its cascade reaches guarded tables. `pnpm auth:reset-owner`
  keeps the owner row and all training data, so a reset never needs a delete. Erasing training
  history is a deliberate maintenance step outside the app.
- **Pain reports** (`pain_reports`, M4) are health data: where it hurt, severity, what the owner
  chose and a free-text note (1 to 500 characters). Owner-scoped, audited in `training_audit`,
  never hard-deleted, and never stored as an exercise preference.
- **The sync ledger** (`sync_mutations`, M4) holds mutation ids, types, row ids and times, no
  training values. It is never pruned in M4, so an outbox replayed months later is still applied
  at most once; its rows refuse UPDATE and DELETE like the history tables.

## Test-only routes

`ENABLE_TEST_ROUTES` enables `/api/test-support/*`, including a route that mints an owner session
without a passkey (WebKit e2e has no virtual authenticator). Env validation refuses to start when
it is set on **any** hosted deployment (`VERCEL`, any `VERCEL_ENV`) or with `appEnv` `preview` or
`production`, and each test route re-checks `testRoutesEnabled()` at runtime. Chromium e2e never
uses it: every Chromium sign-in is a real WebAuthn ceremony.

`VERCEL` and `VERCEL_ENV` are runtime variables only, so the build carries the same fact: a server
built for Vercel (`pnpm build`; `__VERCEL_BUILD__`, defined in `vite.config.ts`) refuses test
routes whatever its runtime environment says. Only Node builds (`pnpm build:node`, used by e2e and
Lighthouse) can enable them.

## Secrets

- Server-only configuration is validated by `src/lib/server/env.ts` and never bundled for the
  browser (SvelteKit refuses `server/` imports in client code). `ANTHROPIC_API_KEY` never reaches
  the browser.
- `@anthropic-ai/*` is imported at runtime only by `src/lib/server/agent/provider/anthropic.ts`
  (ESLint, and `scripts/anthropic-sdk-imports.test.ts`, which also catches dynamic imports). A
  missing `ANTHROPIC_API_KEY` never stops the server: the coach reports `no_key`, and the one
  startup warning names the variable, never its value. The provider's errors carry only kind,
  status, type and request id, with the key redacted, and never keep the SDK error as a cause.
- The setup **token** is never stored anywhere: only its hash is configured (and, once used,
  recorded in `used_setup_tokens`). Vercel's own request logs record full URLs, so the setup
  request's token appears there; it is useless once setup has completed, also after an owner
  reset (a used token is refused for good). Remove `OWNER_SETUP_TOKEN_HASH` after setup. The app's
  own logs record paths without query strings.
- `.env` is git-ignored; nothing secret is committed.

## What is and isn't protected

Protected: every page and endpoint except the allow-list above; sessions against theft via XSS
(HttpOnly, CSP without `unsafe-inline` scripts), fixation (rotation) and CSRF; credentials against
phishing (WebAuthn is origin-bound) and brute force (rate limits, 80+ bit secrets).

Not protected (by design or out of scope): a session cookie copied off an unlocked device is
valid until it expires or is revoked from Security (there is no device binding) — it can read
everything, but cannot change passkeys, recovery codes or devices without one of the owner's
passkeys, except within 5 minutes of the owner's own passkey use on that session; the app does not
detect unusual sign-in locations; the audit log is not tamper-proof against someone with database
access; denial of service by exhausting a client's rate limit from the same IP is possible.

## Coach (M5) review

The coach's attack surface as merged at the end of M5, reviewed against the code. The design is in
docs/agent-architecture.md; this section records what protects each part and what is left.

**Prompt injection.** Anything stored that the owner or a model once wrote (thread titles, notes,
summaries, rejection reasons, proposal text) reaches the model only as `untrusted_text`, labelled
as data (`src/lib/server/agent/prompt/context.ts`). The turn-context system message carries only
facts the server computed: dates, counts, ids and statuses, never a decided proposal's note.
Memory sits in a user-role preamble, never in a system message. No tool commits a program, goal or
workout change: each is a proposal the owner accepts. The one direct write,
`update_exercise_preferences`, needs an explicit statement about that exercise in this turn's
stored owner message (`classifyExerciseStatement`); a dislike that reached the coach through a
stored note becomes a proposal (`tests/integration/coach/tools-preferences.test.ts`).

**Tool authorisation.** `ToolContext` takes the owner from the session, and `toStrictJsonSchema`
refuses any tool input property named `owner`, `ownerId` or `owner_id`, so no model input can
choose whose data a tool reads. Every id is looked up owner-scoped. Each tool group's integration
test runs a `ToolContext` with a random owner id against the seeded owner's ids: reads give
`NOT_FOUND`, and writes and proposals give `is_error` with zero rows written
(`tests/integration/coach/tools-*.test.ts`, `tests/integration/coach/proposals.test.ts`). Every
input is validated with zod before its tool runs. An unexpected tool error reaches the model only
as a generic `INTERNAL` result.

**Proposal tampering.** Accept and reject take only the proposal id; the server re-parses the
stored payload and re-checks it against today's data. Postgres refuses the rest: rows are inserted
`proposed` only, their content (payload with its version and hash, diff, impact, base version,
thread, run, tool call, revision) never changes, status moves forward only (proposed → accepted,
rejected, applied or superseded; accepted → applied or superseded), decided rows are frozen and
DELETE is refused (`drizzle/0026_coach_proposals_guards.sql`). Transcripts, model calls, tool calls
and coach notes are insert-only; a thread changes only its title, archive state and forward
segment, a run only while running (`drizzle/0024_coach_conversations_guards.sql`). A second accept
writes nothing, and a tampered request is ignored (`e2e/coach-proposals.serial.e2e.ts`).

**Key handling.** `@anthropic-ai/sdk` is pinned to 1.6.0, which sends `Authorization: Bearer` and
API version 2026-10-21; the app sends no header override. The key is set in Vercel's Production
environment only, and `vercel.json` disables Git preview deployments. `pnpm budgets` fails if the
SDK (literals only its pinned release ships), an `sk-ant-` key or the build-time
`ANTHROPIC_API_KEY` is in any client file of either build; CI builds with a canary key
(`.github/workflows/ci.yml`) and a positive control requires the SDK's literals in the server
output (`scripts/client-secret-scan.ts`).

**The launch switch and the kill switch.** `COACH_LAUNCHED` (`src/lib/server/agent/launch.ts`)
kept production at `not_launched` until coach-launch (#449) flipped it. `LLM_PROVIDER=off` is the
owner's kill switch in any environment, effective at the next deploy: `disabled` refuses every
turn before anything is stored, as `not_launched` does. Test overrides of the provider, faults and
scripts are read only where test routes are enabled, which a Vercel build never is.

**Rate limits and cap pricing.** `coach.turn` (30 per 10 minutes) and `coach.action` (60 a
minute) are shared by every device. The $5 daily cap sums `cap_cost_micros`, a NOT NULL column
that prices a model missing from `PRICING` at the highest known rate of each token type, rounded
up, so a fallback or unknown model never under-counts. A day at the cap is refused before any
model call; within a turn, the loop stops at 8 chat calls, 2 drafts, 40K output or 300K input
tokens (`src/lib/domain/coach/budgets.ts`).

**The SSE endpoint.** `POST /api/coach/turns` is an owner route: Origin-checked, rate-limited,
body capped at 64 KB and parsed strictly; it answers `text/event-stream` with `no-store`. Answers
never carry HTML: the server parses a small markdown subset into a tree
(`src/lib/domain/coach/markdown.ts`), a link survives only as an app path that `sourceAction`
builds, and the browser renders text nodes only (`RichText.svelte`, never `{@html}`).

**The output gate.** `src/lib/server/agent/policy.ts` scans every answer block before release:
clean text goes at sentence ends, or at a clause boundary that keeps 80 characters held to be
rescanned; a block that names pain or holds a context phrase is held to the answer's end, and in
pain mode every block is. A failing block is replaced by safe guidance before any of it is sent,
and ungrounded facts and metrics become 'Not checked against your data'. Each intervention is a
`_policy` row in `agent_tool_calls`.

**Logs.** Coach logs carry ids, counts, token usage and timings, never message text. Failures are
logged as `err` through `serializeError`.

**Residual risks.**

- The model can still be talked into a poor recommendation by the owner's own words; proposals
  and the owner's confirmation are the control, not the prompt.
- A logged error message may quote what a service refused (for example an exercise name). It
  never holds the key, but it is not scrubbed of the owner's words.
- The live suite, including its prompt-injection and refusal conversations, has not been run
  against the real model (the owner's go-ahead of 2026-11-10 replaced it; #449).
- The kill switch takes a redeploy; there is no runtime toggle.

## Self-review (OWASP ASVS 4.0, level 2, the relevant chapters)

| ASVS                                         | Status  | Evidence                                                                                             |
| -------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| V2.1 Password security                       | N/A     | No passwords exist.                                                                                  |
| V2.2 General authenticator (anti-automation) | Met     | DB rate limits on every auth endpoint (`rate-limit.test.ts`); failures audited.                      |
| V2.5 Credential recovery                     | Met     | Single-use 80-bit codes, hashed, burned atomically; recovery forces a new passkey; regeneration.     |
| V2.6 Look-up secrets                         | Met     | Codes random (CSPRNG), single use, stored hashed (SHA-256 is adequate at 80 bits of entropy).        |
| V2.7/2.8 Out-of-band / OTP                   | N/A     | Not used.                                                                                            |
| V2.9 Cryptographic authenticators            | Met     | WebAuthn via SimpleWebAuthn; UV required; counters enforced; origin and RP ID verified.              |
| V3.1/3.2 Session binding & generation        | Met     | 256-bit CSPRNG tokens; new token on authentication; hash at rest.                                    |
| V3.3 Session termination                     | Met     | Sign-out, revoke one / all others; idle 30 d + absolute 90 d; revocation immediate (tests).          |
| V3.4 Cookie-based sessions                   | Met     | `__Host-` prefix, Secure, HttpOnly, SameSite=Lax, Path=/ (unit + e2e).                               |
| V3.5 Token-based sessions                    | N/A     | Cookie sessions only.                                                                                |
| V3.7 Defenses against session exploits       | Met     | Step-up: a recent passkey assertion (5 min) before passkey, recovery-code or device changes (tests). |
| V4.1/4.2 Access control                      | Met     | Deny by default with a typed, tested route map; single owner, no IDOR surface.                       |
| V4.2.2 CSRF                                  | Met     | Origin check on all unsafe methods + SvelteKit form check + SameSite (e2e).                          |
| V7 Logging                                   | Met     | Audit log for auth events; no secrets or query strings in app logs.                                  |
| V8.3 Sensitive private data                  | Partial | Pages `private, no-cache`; sign-out clears device data, unsynced sets if agreed. Neon encrypts DB.   |
| V13 API                                      | Met     | JSON endpoints validate input (zod), cap body size, answer `no-store`.                               |
| V14.4 HTTP security headers                  | Met     | CSP, HSTS, nosniff, frame-ancestors none, referrer policy (e2e).                                     |

Open items: WebKit runs only on the test-minted session in e2e, so passkey ceremonies on iOS
Safari (sign-in, setup, step-up) are verified on a real device (docs/testing.md checklist) rather
than in CI.

## Production cutover review (OWASP ASVS 4.0.3, level 2: V2 and V3)

Done for the M2 production cutover, requirement by requirement, against the code on `main`
(`src/lib/server/auth/`, `hooks.server.ts`, the auth routes and `scripts/auth-*.ts`). Step-up
re-authentication, recovery, the rate limits and single-use setup tokens were reviewed and fixed
in earlier M2 pull requests; this pass re-checks them in context. Where this section and the
summary table above differ (V2.2.1, V2.6.2, V3.3.2), this section is current.

**Met**: the requirement holds. **Partial**: part holds, the gap is stated. **Deviation**: a
deliberate, documented choice. **N/A**: the mechanism does not exist here.

### V2 Authentication

| ASVS          | Requirement (short)                                                 | Status    | Evidence, or the gap                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1.x, 2.4.x  | Passwords and their storage                                         | N/A       | No passwords exist.                                                                                                                                                                                                                                                                                                                                                                |
| 2.2.1         | Anti-automation; at most 100 failures an hour per account           | Deviation | Postgres rate limits on every auth endpoint, per client (IPv4 address or IPv6 /64) and per session, refusals audited (`rate-limit.test.ts`). No account-wide cap (`recovery.global` is a tripwire, not a cap), on purpose: it would let anyone lock the single owner out, and nothing is guessable online (passkeys need the private key; codes are 80 bits, the setup token 256). |
| 2.2.2         | Weak authenticators (SMS, email)                                    | N/A       | None.                                                                                                                                                                                                                                                                                                                                                                              |
| 2.2.3, 2.5.5  | The user is notified when authentication details change             | Partial   | In-app only: Security lists passkeys added or removed, recovery codes used or replaced, sessions ended and owner resets, and keeps them in view against floods of failures. No out-of-band notice (no email or push exists). Follow-up 3.                                                                                                                                          |
| 2.3.1         | System-generated activation secrets are random and expire soon      | Partial   | The setup token is 256 random bits and works for one setup (`used_setup_tokens`). It has no built-in expiry: it is valid while its hash is configured, so the procedure sets the hash right before setup and removes it after (docs/deployment.md). Follow-up 2.                                                                                                                   |
| 2.3.2         | User-provided authenticators (FIDO) supported                       | Met       | Several passkeys per owner, any authenticator with user verification (platform or hardware key).                                                                                                                                                                                                                                                                                   |
| 2.5.1         | Recovery secrets never sent in clear text                           | Met       | Codes are shown once over HTTPS with `no-store` and cannot be retrieved again; the setup link travels through a private channel.                                                                                                                                                                                                                                                   |
| 2.5.2, 2.5.3  | No hints or knowledge-based answers; recovery reveals no credential | Met       | None exist.                                                                                                                                                                                                                                                                                                                                                                        |
| 2.5.4         | No shared or default accounts                                       | Met       | One owner row (singleton), created only by setup. The placeholder "Test Owner" exists only where test routes do, never on a hosted build.                                                                                                                                                                                                                                          |
| 2.5.6         | Recovery uses a secure offline mechanism                            | Met       | Single-use recovery codes that grant only a 15-minute session forced to register a new passkey.                                                                                                                                                                                                                                                                                    |
| 2.5.7         | Lost factors need identity proofing at enrolment level              | Met       | Without passkeys and codes only the tech lead can reset, with direct access to the production database (`pnpm auth:reset-owner`), followed by a new single-use setup link.                                                                                                                                                                                                         |
| 2.6.1, 2.6.3  | Look-up secrets are single use and unpredictable                    | Met       | CSPRNG codes, burned atomically (`UPDATE … WHERE used_at IS NULL`).                                                                                                                                                                                                                                                                                                                |
| 2.6.2         | Look-up secrets have 112 bits, or a unique 32-bit salt and a hash   | Partial   | 80 bits, SHA-256 with a fixed prefix, no per-code salt. Online guessing is pointless (rate limits against 2^80); the gap is offline: whoever holds a copy of `recovery_codes` (a leaked backup, say) could in principle brute-force one. Follow-up 1.                                                                                                                              |
| 2.7.x, 2.8.x  | Out-of-band and one-time-password verifiers                         | N/A       | Not used.                                                                                                                                                                                                                                                                                                                                                                          |
| 2.9.1         | Verifier keys protected                                             | Met       | Only passkey public keys are stored.                                                                                                                                                                                                                                                                                                                                               |
| 2.9.2         | Challenges of at least 64 bits, unique                              | Met       | SimpleWebAuthn's 32-byte random challenges, single use, 5 minutes, bound to purpose and RP ID (and to the session for registration and step-up).                                                                                                                                                                                                                                   |
| 2.9.3         | Approved algorithms                                                 | Met       | SimpleWebAuthn's defaults (EdDSA, ES256, RS256); attestation `none`.                                                                                                                                                                                                                                                                                                               |
| 2.10.1–2.10.2 | Service credentials: not static, not a default privileged account   | Partial   | The app connects as Neon's default owner role `neondb_owner` (which also runs migrations) with a static password kept as a sensitive Vercel variable. Follow-up 4.                                                                                                                                                                                                                 |
| 2.10.3–2.10.4 | Service secrets protected and kept out of source                    | Met       | Vercel sensitive variables and GitHub secrets; `.env` is git-ignored; nothing secret is committed.                                                                                                                                                                                                                                                                                 |

### V3 Session management

| ASVS        | Requirement (short)                                                         | Status    | Evidence, or the gap                                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1.1       | Session tokens never in URLs                                                | Met       | Cookie only. The setup token is in the setup link by design (one use, useless afterwards); the app logs paths without query strings, Vercel's request log keeps it.                                                                                                        |
| 3.2.1       | A new token on authentication                                               | Met       | Rotation on passkey sign-in, setup, recovery and the recovery-to-full upgrade; the presented token is revoked (`sessions.test.ts`, `signin.test.ts`).                                                                                                                      |
| 3.2.2–3.2.3 | At least 64 bits; stored only in secure cookies                             | Met       | 256-bit CSPRNG tokens in an HttpOnly cookie; only their SHA-256 in Postgres; nothing in local or session storage.                                                                                                                                                          |
| 3.3.1       | Logout and expiry invalidate the session                                    | Met       | Revocation is checked on every request; sign-out deletes the cookie, sends `Clear-Site-Data: "cache"` and clears the device's account data, unsynced workout changes only once the owner agrees (e2e on Chromium, `auth.e2e.ts`, and WebKit, `signout.e2e.ts`).            |
| 3.3.2       | Re-authentication after 12 hours, or 30 minutes idle (level 2)              | Deviation | 30 days idle, 90 days absolute (ADR 0006: level 1's value). The app lives on the owner's own phone behind Face ID; compensating controls: step-up within 5 minutes for every credential or device change, sessions listed and revocable, revocation effective immediately. |
| 3.3.3       | After a credential change or recovery, an option to end every other session | Met       | A recovery lands on Security already step-up fresh; removing the lost passkey ends its sessions; Sign out everywhere else.                                                                                                                                                 |
| 3.3.4       | Active sessions visible; signing them out needs the credential again        | Met       | Session list; signing out one or all others needs step-up (`reauth.test.ts`, `reauth.e2e.ts`).                                                                                                                                                                             |
| 3.4.1–3.4.5 | Cookie attributes                                                           | Met       | `__Host-session`: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain (`cookies.test.ts`, e2e).                                                                                                                                                                              |
| 3.5.x, 3.6  | Token-based and federated sessions                                          | N/A       | Cookie sessions only; no federation.                                                                                                                                                                                                                                       |
| 3.7.1       | A full session or re-authentication before sensitive changes                | Met       | Step-up for adding or removing passkeys, new recovery codes and signing devices out; a recovery session may only register its new passkey.                                                                                                                                 |

### Fixed in the cutover pull request

- **`pnpm auth:reset-owner` could reset the wrong database.** Without `DATABASE_URL_UNPOOLED` it
  fell back to `DATABASE_URL`, then to the local development database, and the package script
  read `.env`, which sets it to that database. It now refuses before connecting unless
  `DATABASE_URL_UNPOOLED` names the target on the command line, and still refuses without
  `--confirm` or outside an interactive terminal. The real command is tested for all three
  refusals (`scripts/auth-reset-owner.test.ts`, `tests/integration/auth/reset-owner-cli.test.ts`).
- **The deny-by-default walks missed layout-reset pages.** `routes.test.ts` and the e2e
  enumerator (`e2e/support.ts`) did not recognise `+page@.svelte` / `+page@(group).svelte`, so
  such a page escaped both (only the typed map in `pnpm check` saw it). Verified by adding an
  unclassified endpoint and an unclassified `+page@.svelte` page: before the fix the unit suite
  reported only the endpoint, after it both. The route-file forms are now pinned by a unit test,
  as is the list of routes a recovery session may reach, and `access.e2e.ts` fails on a route
  missing from `ROUTE_ACCESS` (at runtime it would fall back to `owner` and pass every HTTP check)
  and on an endpoint whose handlers it cannot exercise.
- **Sign-out clearing was proven on Chromium only.** `e2e/signout.e2e.ts` proves it on WebKit,
  the iPhone's engine: cookie, account caches, IndexedDB and session storage gone, app shell and
  preferences kept.
- **Production is checked from outside after every deploy** (`post-deploy-smoke.yml`,
  docs/deployment.md), including that the test-only session route answers 404 there.

### Follow-ups

1. **Recovery codes to ASVS 2.6.2:** a per-code random salt (verification compares the at most
   10 unused rows; a nullable salt column, expand then contract) or codes of at least 112 bits
   (six groups of four instead of four). The owner then creates new codes once from Security.
2. **Setup token expiry (2.3.1):** carry an expiry inside the token itself
   (`<expires>.<random>`; the configured hash covers it, so it cannot be changed), refused by
   `/setup` once past; `pnpm auth:setup-token` defaults to 24 hours.
3. **Out-of-band notice (2.2.3, 2.5.5)** when a passkey is added, a recovery code is used or the
   owner is reset: Web Push to the owner's devices, or an email.
4. **Least-privilege database role (2.10.1, 2.10.2):** a runtime role with data access to the
   app's tables only for `DATABASE_URL`; migrations and backups keep the owner role on
   `DATABASE_URL_UNPOOLED`. A hosted change in Neon and Vercel, for the tech lead.
5. Passkey ceremonies on iOS Safari (setup, sign-in, step-up) are verified on the owner's iPhone
   at setup (docs/testing.md, real-device checklist), not in CI.
