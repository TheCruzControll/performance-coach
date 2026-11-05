# `src/lib/server/auth` — passkey authentication

Single-owner passkey (WebAuthn) authentication on SimpleWebAuthn. How it works and why:
[docs/security.md](../../../../docs/security.md) and ADR 0006. Routes import from `index.ts`.

| Module                                               | Responsibility                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `relying-party.ts`                                   | RP ID and expected origin per environment (production is exactly the domain)   |
| `webauthn.ts`                                        | SimpleWebAuthn calls with this app's policy; response shape checks             |
| `challenges.ts`                                      | Single-use, purpose-bound challenges in Postgres                               |
| `setup.ts`                                           | First-run setup (token hash, owner, first passkey, recovery codes)             |
| `passkeys.ts`                                        | Sign in, add / rename / remove passkeys                                        |
| `recovery.ts`, `recovery-codes.ts`                   | Recovery-code sign-in, regeneration; code format and hashing                   |
| `sessions.ts`                                        | Issue, validate (sliding + absolute expiry), list, revoke, sign out            |
| `guard.ts`, `routes.ts`, `csrf.ts`, `return-path.ts` | Deny by default for every request (used by `hooks.server.ts`)                  |
| `cookies.ts`, `http.ts`                              | Cookie name and flags from the origin; SvelteKit glue for routes               |
| `rate-limit.ts`, `policy.ts`                         | DB-backed rate limits; every timing and limit in one place                     |
| `audit.ts`, `activity.ts`                            | `auth_events` audit log and the Security screen's recent activity              |
| `tokens.ts`                                          | Random tokens, SHA-256, constant-time digest comparison (`node:crypto` only)   |
| `test-support.ts`                                    | Test-only session minting (refused unless test routes are enabled and allowed) |

Pure modules have unit tests next to them; the use-cases are covered by
`tests/integration/auth/` (real Postgres, real SimpleWebAuthn verification) and the flows by
`e2e/auth*.ts` (real WebAuthn ceremonies in Chromium).
