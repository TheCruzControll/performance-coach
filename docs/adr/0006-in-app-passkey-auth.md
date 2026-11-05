# 0006 — In-app passkey (WebAuthn) authentication

- **Status:** Proposed (implemented in M2)
- **Context:** Strictly private, single owner, passkeys as the primary factor, secure recovery,
  no public registration, established libraries only (PRD §13).

## Decision (proposed)

Implement auth inside the app (`src/lib/server/auth/`) with a maintained WebAuthn library
(SimpleWebAuthn): one owner account, first passkey enrolled with a one-time setup token from an
environment secret, hashed recovery codes, opaque session ids in `HttpOnly; Secure; SameSite=Lax`
cookies (hashed at rest, revocable), and a deny-by-default route guard in `hooks.server.ts`.

## Alternatives considered

- **Neon Auth (managed Better Auth)**: capable, but adds a service to the stack for one user and
  couples identity to the database vendor; passkey-first single-owner flows are simple enough
  in-app. Revisit if requirements grow (multiple users, OAuth).
- **Clerk/Auth0**: third-party data processor and cost for one user; passkey support varies.
- **Cloudflare Access / Vercel password protection**: good extra perimeter (may still be added),
  but not a substitute for application-level sessions and per-endpoint authorization.

## Consequences

- `neon.ts` leaves `auth` disabled.
- M2 must include e2e coverage of the auth test flow (PRD §19) and protect every endpoint.
