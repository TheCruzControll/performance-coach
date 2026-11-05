# `src/lib/server/auth` — authentication (scaffold)

Milestone 2 implements authentication here. Requirements (PRD §13):

- **Passkeys (WebAuthn) as the primary factor**, using an established library
  (e.g. SimpleWebAuthn) — no hand-rolled crypto or protocol code.
- Single owner account, **no public registration**. The first passkey is enrolled with a
  one-time, short-lived setup token provisioned out of band (environment secret).
- Recovery: printed one-time recovery codes (hashed at rest) plus the ability to enrol
  multiple passkeys (phone + laptop + hardware key).
- Sessions: opaque random session id in an `HttpOnly; Secure; SameSite=Lax` cookie, hashed in
  Postgres, sliding expiry, revocable. Checked in `hooks.server.ts` for every request.
- Every route and `/api/*` endpoint is protected by default (allow-list for `/`, the sign-in
  flow, `/api/health` and static assets).

See ADR 0006 in `docs/adr/` for why auth lives in-app instead of a hosted identity provider.
