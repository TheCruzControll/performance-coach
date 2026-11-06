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
   `timingSafeEqual` on the two digests) **and** no passkey exists. Wrong tokens are audited and
   rate-limited (10 per 15 min per client).
3. The owner enters a name and creates a passkey. In one transaction (advisory-locked, so two
   concurrent setups cannot both win): the owner and passkey are created, setup is marked
   complete, 10 recovery codes are generated and stored hashed, and a session starts.
4. The 10 codes are returned **once** in that response and shown with copy/download and a
   required acknowledgement. From then on `/setup` is a 404 for good (even with the right token).

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
  revoked) and lands on Security with a prompt to remove the lost passkey.
- Codes can be regenerated from Security (all old codes stop working; new set shown once, with
  acknowledgement). A recovery session cannot regenerate codes.
- Rate limits: 5 attempts per 15 min per client and 20 failed attempts per hour in total; the total
  never refuses a valid code (see Rate limits).
- Lost every passkey **and** every code: the guarded `pnpm auth:reset-owner` (docs/deployment.md).

### Passkey management (Profile → Security)

Add (a real registration bound to the current session: the challenge row stores the session id),
rename (1–64 characters), remove. **The last passkey can never be removed**: the check runs under
a row lock, so two concurrent removals cannot both pass. Removing a passkey also ends every other
session that signed in with it.

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
| Management              | List (current marked), sign out one, sign out everywhere else, sign out                                   |

### Sign-out

`POST /api/auth/signout` revokes the session, deletes the cookie and sends
`Clear-Site-Data: "cache"` (drops HTTP-cached and back/forward-cached pages). The browser then
deletes every Cache Storage entry except the current versioned app shell (`pc-shell-<version>`:
the public build and the offline screen), every IndexedDB database and session storage
(`src/lib/client/signout.ts`), and lands on the sign-in screen. **Device preferences (theme,
units in localStorage) are kept on purpose**: they are not account data. `"storage"` and
`"cookies"` are deliberately not sent: `"storage"` would also wipe those preferences and
unregister the offline app shell, and `"cookies"` applies to the whole registrable domain
(`nikocruz.com`), not just this app. If the server cannot be reached the client says so and
changes nothing (the HttpOnly cookie can only be deleted by the server).

## Deny by default

`hooks.server.ts` runs `guardRequest` (`guard.ts`) for every dynamic request. Every route's
access is declared in `routes.ts` (`ROUTE_ACCESS`, typed against SvelteKit's generated `RouteId`
union, so an unclassified route fails `pnpm check`); an unknown route is `owner`.

| Access        | Routes                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public`      | `/` (sign-in), `/setup`, `/recover`, `/api/auth/signin/{options,verify}`, `/api/auth/setup/{options,verify}`, `/api/auth/signout`, `/api/health`, `/offline` (prerendered), `/api/test-support/session` (404 unless test routes are enabled) |
| `any-session` | `/recover/passkey`, `/api/auth/passkeys/{options,verify}`                                                                                                                                                                                    |
| `owner`       | everything else, including `/api/vitals` and `/api/client-errors`                                                                                                                                                                            |

Without a session, pages answer `303` to `/?next=<path>` (a JSON redirect for client-side data
requests and enhanced form actions) and `/api/*` answers `401 {"error":"unauthenticated"}`. A
stale or forged cookie is cleared. Static and prerendered files (immutable build assets, icons,
manifest, robots.txt, the service worker, `/offline`) never reach the hooks and hold no personal
data. Proven by `src/lib/server/auth/routes.test.ts` and `e2e/access.e2e.ts`, which walk
`src/routes` so new routes are covered automatically.

## CSRF

Three independent layers:

1. **Origin check on every state-changing request** (`csrf.ts`): any method other than
   GET/HEAD/OPTIONS must carry an `Origin` equal to the app's origin (and `Sec-Fetch-Site`, when
   sent, must be `same-origin`). This covers JSON endpoints, which SvelteKit's own check does not.
   Browsers send `Origin` on all such requests; a missing one is refused.
2. **SvelteKit's form check** (`csrf.checkOrigin`, on by default) for form actions.
3. **`SameSite=Lax`** on the session cookie: cross-site subrequests and POSTs carry no session.

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
| `manage`          | 60 / minute     | session  |
| `signout`         | 30 / minute     | client   |

The client address is the platform's (`getClientAddress()`: `x-forwarded-for` as set by Vercel).
Refusals answer `429` with `Retry-After`.

`recovery.global` counts failed codes only, charged after the code is looked up, so it never
refuses a valid one: a client staying within its own limit cannot fill it and lock the owner out
of recovery. It is a tripwire (audited when it trips; further wrong codes answer `429`), not a
bound on distributed guessing, which rests on the per-client limit and the 80-bit codes.

## Audit log

`auth_events` records setup completed/failed, sign-in succeeded/failed (with the reason from
SimpleWebAuthn), passkey added/renamed/removed, recovery used/failed/regenerated, session
revoked / revoked others, sign-out, rate limiting and owner resets, with request id, client
address and a User-Agent summary. Rows are kept if the owner is reset. Security shows the most
recent events.

## Test-only routes

`ENABLE_TEST_ROUTES` enables `/api/test-support/*`, including a route that mints an owner session
without a passkey (WebKit e2e has no virtual authenticator). Env validation refuses to start when
it is set on **any** hosted deployment (`VERCEL`, any `VERCEL_ENV`) or with `appEnv` `preview` or
`production`, and each test route re-checks `testRoutesEnabled()` at runtime. Chromium e2e never
uses it: every Chromium sign-in is a real WebAuthn ceremony.

## Secrets

- Server-only configuration is validated by `src/lib/server/env.ts` and never bundled for the
  browser (SvelteKit refuses `server/` imports in client code). `ANTHROPIC_API_KEY` never reaches
  the browser.
- The setup **token** is never stored anywhere: only its hash is configured. Vercel's own request
  logs record full URLs, so the setup request's token appears there; it is useless once setup has
  completed (and `OWNER_SETUP_TOKEN_HASH` can then be removed). The app's own logs record paths
  without query strings.
- `.env` is git-ignored; nothing secret is committed.

## What is and isn't protected

Protected: every page and endpoint except the allow-list above; sessions against theft via XSS
(HttpOnly, CSP without `unsafe-inline` scripts), fixation (rotation) and CSRF; credentials against
phishing (WebAuthn is origin-bound) and brute force (rate limits, 80+ bit secrets).

Not protected (by design or out of scope): a session cookie copied off an unlocked device is
valid until it expires or is revoked from Security (there is no device binding); the app does not
detect unusual sign-in locations; the audit log is not tamper-proof against someone with database
access; denial of service by exhausting a client's rate limit from the same IP is possible.

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
| V3.7 Defenses against session exploits       | Partial | Re-authentication is not required for sensitive actions (adding/removing passkeys) within a session. |
| V4.1/4.2 Access control                      | Met     | Deny by default with a typed, tested route map; single owner, no IDOR surface.                       |
| V4.2.2 CSRF                                  | Met     | Origin check on all unsafe methods + SvelteKit form check + SameSite (e2e).                          |
| V7 Logging                                   | Met     | Audit log for auth events; no secrets or query strings in app logs.                                  |
| V8.3 Sensitive private data                  | Partial | Pages `private, no-cache`; sign-out clears device data. Server-side encryption at rest is Neon's.    |
| V13 API                                      | Met     | JSON endpoints validate input (zod), cap body size, answer `no-store`.                               |
| V14.4 HTTP security headers                  | Met     | CSP, HSTS, nosniff, frame-ancestors none, referrer policy (e2e).                                     |

Open items: step-up re-authentication before adding or removing a passkey (V3.7) — a single
owner with device-bound biometrics makes this lower risk, but it is the next hardening step;
WebKit runs only on the test-minted session in e2e, so passkey ceremonies on iOS Safari are
verified on a real device (docs/testing.md checklist) rather than in CI.
