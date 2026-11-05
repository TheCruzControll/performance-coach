# 0006 — In-app passkey (WebAuthn) authentication

- **Status:** Accepted (implemented in M2)
- **Context:** Strictly private, single owner, passkeys as the primary factor, secure recovery,
  no public registration, established libraries only (PRD §13).

## Decision

Authentication lives inside the app (`src/lib/server/auth/`), with **SimpleWebAuthn**
(`@simplewebauthn/server` and `@simplewebauthn/browser`, v14) doing all WebAuthn work. The app's
own code only generates random values, hashes them with SHA-256 and compares digests with
`timingSafeEqual` (`node:crypto`). What was built (details in docs/security.md):

- **One owner** (a singleton row). The first passkey is enrolled through `/setup?token=…`; the
  server knows only `OWNER_SETUP_TOKEN_HASH`, and setup closes for good once a passkey exists.
- **Passkeys**: discoverable credentials, user verification required, no attestation;
  conditional UI (autofill) plus a button on the sign-in screen; add, rename and remove from
  Profile → Security, never the last one.
- **Recovery**: 10 single-use 80-bit codes stored as SHA-256; a code grants a 15-minute recovery
  session that can only register a new passkey; codes can be regenerated. Lost everything: the
  guarded `pnpm auth:reset-owner`, which keeps the owner and their data.
- **Sessions**: opaque 256-bit tokens in an HttpOnly, Secure, SameSite=Lax `__Host-session`
  cookie, SHA-256 at rest, 30-day sliding / 90-day absolute expiry, rotated on every sign-in,
  revocable one by one or all at once.
- **Deny by default** in `hooks.server.ts` with a route map typed against SvelteKit's `RouteId`;
  an `Origin` check on every state-changing request; DB-backed rate limits on every auth
  endpoint; an audit log.
- **Relying party** derived in one tested module: production is exactly
  `https://coach.nikocruz.com`; previews use their own host; development and tests `localhost`.
- **Short-lived WebAuthn challenges** in Postgres, single use, bound to their purpose, RP ID and
  (for adding a passkey) the session.

## Alternatives considered

- **Neon Auth (managed Better Auth)**: capable, but adds a service to the stack for one user and
  couples identity to the database vendor; passkey-first single-owner flows are simple enough
  in-app. Revisit if requirements grow (multiple users, OAuth).
- **Clerk/Auth0**: third-party data processor and cost for one user; passkey support varies.
- **Cloudflare Access / Vercel password protection**: good extra perimeter (may still be added),
  but not a substitute for application-level sessions and per-endpoint authorization.
- **Signed (stateless) session cookies / JWTs**: cannot be revoked immediately without a
  denylist; one indexed lookup per request is cheap for one user, so sessions are stateful.
- **A slow password hash for recovery codes**: unnecessary at 80 bits of entropy with rate
  limits; SHA-256 keeps verification a single indexed lookup.

## Consequences

- `neon.ts` leaves `auth` disabled.
- Every dynamic request does one indexed session lookup (`Server-Timing: auth`).
- WebKit has no WebAuthn virtual authenticator: Chromium e2e performs real ceremonies through
  the CDP virtual authenticator; WebKit e2e uses a test-only session route that env validation
  forbids on every hosted deployment. Passkeys on iOS Safari are checked on a real device.
- Node builds served over plain HTTP must know their origin at build time (`ORIGIN`, see
  docs/environment.md): the WebAuthn origin, CSRF checks and cookie flags depend on it.
- Open hardening item: step-up re-authentication before passkey changes (docs/security.md).
