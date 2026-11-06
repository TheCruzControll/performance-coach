# Deployment

Target: **Vercel** (Node.js 22, Fluid compute) at **coach.nikocruz.com**, DNS at **Cloudflare**
(DNS-only), database **Neon Lakebase Postgres**. Deploys run through the **Vercel Git
integration**; every deployed build migrates its own database first (`scripts/vercel-build.sh`).

> **Status (M2, in progress):** the accounts, project, database branches, environment variables
> and domain below exist and were configured through the Vercel and Neon APIs. Previews are
> deployed on demand, not from every pull request (see "Preview deployments"). Passkey auth is
> merged to `main`
> (docs/security.md); **production stays switched off** (the guards below are still committed)
> until the M2 production cutover removes them. Nothing is served on `coach.nikocruz.com` yet.

## What exists

| Piece      | Setting                                                                                                                                                                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel     | Project `performance-coach` (`prj_ofpkwho7FKmRXNr9Bem9phaD2AVN`) in team `thecruzcontrolls-projects`, Hobby plan. Framework SvelteKit, Node.js 22.x, Fluid compute.                                                                                                                                        |
| Region     | Functions in **`pdx1`** (Portland), next to the Neon database in **`aws-us-west-2`** (Oregon), so a query is a same-region round trip.                                                                                                                                                                     |
| Git        | GitHub `TheCruzControll/performance-coach` linked; Git deployments only for `main` (previews on demand).                                                                                                                                                                                                   |
| Protection | Vercel Authentication on every deployment **except custom domains**: previews need a Vercel login; `coach.nikocruz.com` is public and protected by the app's own passkey auth.                                                                                                                             |
| Neon       | Project `red-rain-59499468` ("Performance coach"), Postgres 18, free plan, 6 h history window. Database `neondb`, role `neondb_owner`.                                                                                                                                                                     |
| Branches   | `production` (`br-green-block-bfh38xqf`, default) for Production; `preview` (`br-solitary-bonus-bf58ajx7`) shared by all preview deployments. Never point a preview at production.                                                                                                                         |
| Env vars   | `DATABASE_URL` (pooled, host contains `-pooler`) and `DATABASE_URL_UNPOOLED` (direct) for Production and Preview, each pointing at its own branch; `ANTHROPIC_API_KEY` for Production. All marked sensitive. M2 adds `OWNER_SETUP_TOKEN_HASH` (Production, only until setup completes; see "Owner setup"). |
| Domain     | `coach.nikocruz.com` attached and verified. Cloudflare: `CNAME coach → e8ec158fe2c98016.vercel-dns-017.com`, **DNS only** (grey cloud), so Vercel terminates TLS.                                                                                                                                          |

`ENABLE_TEST_ROUTES` must never be set on Vercel. See docs/environment.md for every variable.

## How a deployment builds (`vercel.json` → `buildCommand`)

`scripts/vercel-build.sh` runs for every Vercel build:

1. For `VERCEL_ENV=preview` or `production`: `pnpm db:migrate` against that environment's
   `DATABASE_URL_UNPOOLED` (direct connection, advisory-locked, idempotent). A deployed
   environment without that variable fails the build instead of guessing.
2. `pnpm build` (adapter-vercel, `nodejs22.x`).

A deployment only starts serving after its build succeeds, so the schema is migrated before the
code that needs it goes live. **Migration rule:** the previous deployment keeps serving while the
next one builds, so every migration must work with the code that is currently live (expand →
backfill → contract over two releases).

Preview deployments share the `preview` Neon branch. Migrations from an unmerged PR therefore
land there. Drizzle applies only migrations newer than the newest one already recorded, so two
open PRs with migrations can make the older-timestamped one be **skipped silently** on `preview`
(its build logs "0 new migration(s)" and its preview fails at runtime). Recovery, also when a PR's
migration changes before it merges: empty the `preview` database and redeploy, so the build
migrates it from scratch ("Resetting the preview database" below). Never reset it from
production. On `main` the same ordering is enforced by a unit test
(`scripts/drizzle-journal.test.ts`): journal entries must be strictly increasing in time.

**Exercise catalogue seed.** Every `pnpm db:migrate` (so every deployed build, CI, and the test
and e2e resets) seeds the exercise library after migrating, under the same lock: one upsert from
`CATALOGUE` in code (`src/lib/server/db/seed/exercises.ts`). It inserts new keys, updates changed
entries in place, retires keys the catalogue no longer has (`retired_at`, never deleted) and
restores a retired key that comes back, then logs the counts
(`db:migrate: exercise catalogue N inserted, N updated, N retired, N restored`). A rerun changes
nothing. Previews share the one `preview` branch, so previews of PRs with different catalogues
retire and restore each other's keys in turn. This is expected and harmless: ids are stable,
retired rows stay readable, and the generator reads the catalogue from code, never from these
rows.

## Production stays off until auth ships — how that is enforced

In M1 every page and `POST /api/vitals` are unauthenticated, so the app must not be served on
`coach.nikocruz.com` before passkey auth (M2). Hidden URLs are not security (PRD §13).

| Path to production                                                               | Guard                                                                                                                      |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Vercel Git integration: a push to `main`                                         | `vercel.json` → `git.deploymentEnabled.main: false` (committed): Vercel creates no deployment for `main`.                  |
| Any production build Vercel starts itself (dashboard redeploy, branch rename, …) | `vercel.json` → `ignoreCommand` runs `scripts/vercel-ignore-build.sh`, which skips the build when `VERCEL_ENV=production`. |

`scripts/vercel-ignore-build.test.ts` (unit suite) checks the committed config, the ignore step's
exit codes and the build command's migrate-then-build order. No deploy token exists and no
workflow deploys.

**What the committed config cannot stop:** a production deploy made by hand from a logged-in
Vercel CLI, especially `vercel build --prod && vercel deploy --prebuilt --prod` (a prebuilt upload
skips the ignored build step). The custom domain is already attached and is exempt from Vercel
Authentication, so such a deploy would be public. Do not deploy production by hand before M2. As
of M1, the project's only production deployment is the failed placeholder created while
configuring environment variables, so nothing is served on `coach.nikocruz.com`.

**Switching production on is the M2 production cutover pull request:** it removes both
guards, and from then on every merge to `main` builds production through the Git integration,
migrating the production branch first. M2 also adds a post-deploy smoke check
(`GET https://coach.nikocruz.com/api/health` must return 200).

**Rollback:** Vercel → Deployments → promote the previous deployment (instant). Database rollbacks
are forward fixes; for data loss use Neon point-in-time restore (6 h window on the current plan)
or a backup (below).

## Owner setup (first passkey)

The app has exactly one account, created by first-run setup (docs/security.md). On a new
production database, after the first deployment with auth:

1. On a trusted machine: `pnpm auth:setup-token`. It prints a random token, its SHA-256 and the
   link `https://coach.nikocruz.com/setup?token=…`. The token is shown once and stored nowhere.
2. Vercel → Project → Settings → Environment Variables: add `OWNER_SETUP_TOKEN_HASH` = the
   printed hash, **Production** only, marked sensitive. Redeploy production (the variable is read
   at start-up).
3. Send the owner the link through a private channel. On the iPhone, in Safari: open it, enter
   the name, create the passkey (Face ID), then save the 10 recovery codes (copy into the password
   manager or download) and confirm. The app opens on Today.
4. `/setup` now answers 404 for good, even with the right token. Remove `OWNER_SETUP_TOKEN_HASH`
   from Vercel (it can no longer be used, but there is no reason to keep it). Vercel's request
   logs contain the setup URL with the token; it is useless once setup has completed: a token
   works for one setup, and its hash is recorded so it stays refused even after an owner reset.
5. Recommended right away: Profile → Security → **Add passkey** on a second device (Mac, or a
   hardware key) so losing the iPhone never needs a recovery code.

A preview deployment can be set up the same way with
`pnpm auth:setup-token --origin https://<preview-host>` and a **Preview**-scoped hash; previews
use their own host as the passkey domain and their own database, so production passkeys never
work there (and vice versa).

## Lost passkeys

- **Lost one device, another passkey still works:** sign in elsewhere, Profile → Security →
  remove the lost passkey (this also signs out every session that used it) and, if in doubt,
  **Sign out others**.
- **Lost every passkey, recovery codes available:** sign-in screen → "Lost your passkey? Use a
  recovery code" → enter one code → create a new passkey → Security: remove the lost passkeys,
  review signed-in devices, and create new recovery codes if few are left.
- **Lost every passkey and every code:** the tech lead resets the owner's credentials:

  ```sh
  DATABASE_URL_UNPOOLED='<Neon production direct URL>' pnpm auth:reset-owner --confirm
  ```

  It prints the target database, the owner and what will be deleted, and asks for the database
  name to be typed back (it refuses to run non-interactively). In one transaction it deletes
  every passkey, recovery code and pending challenge, revokes every session, reopens first-run
  setup and writes an `owner.reset` audit event. **The owner row and all training data are
  kept.** Then follow "Owner setup" above with a **new** token (the previous link stays refused:
  each token works for one setup); setup re-attaches to the same owner.

## Backups (`backup.yml`)

Neon's scheduled snapshots are not available on this project's plan (the API returns "backup
schedule creation is not enabled for this project"), and its point-in-time window is 6 hours. The
nightly workflow below is the off-site backup. It **skips with a notice** until the owner adds two
repository secrets (GitHub → Settings → Secrets and variables → Actions): `DATABASE_URL_UNPOOLED`
(the Neon production **direct** string) and `BACKUP_PASSPHRASE` (a long random passphrase kept in a
password manager; backups cannot be decrypted without it). Backup and restore are verified end to
end in M9.

- Nightly at 03:23 UTC (and on demand): `pg_dump --format=custom` over the direct URL, piped into
  `gpg --symmetric --cipher-algo AES256` with `BACKUP_PASSPHRASE`, plus a `.sha256`, uploaded as a
  workflow artifact retained **30 days**. The plaintext dump never touches disk.
- This complements Neon's built-in point-in-time restore (history window depends on the plan).
- `PG_CLIENT_VERSION` in the workflow must be ≥ the Neon server's major version.

`main` is the repository's default branch, so GitHub runs the schedule. The skip is verified:
run [42147437996](https://github.com/TheCruzControll/performance-coach/actions/runs/42147437996)
(on demand, on `main`) ended green with the notice "Backup skipped: Missing secrets:
DATABASE_URL_UNPOOLED BACKUP_PASSPHRASE".

### Restore

Backups are written by `pg_dump` 18 (`PG_CLIENT_VERSION` in the workflow), and `pg_restore`
refuses archives newer than itself: restore with **PostgreSQL 18 client tools** (Debian/Ubuntu:
the PGDG `postgresql-client-18` package). `scripts/restore-backup.sh` checks this first.

```sh
# 1. Download the artifact (GitHub → Actions → Backup run → Artifacts) and unzip it.
# 2. Create a target: a new Neon branch (recommended) or a scratch local database.
# 3. Restore (direct connection string for the target):
BACKUP_PASSPHRASE='…' scripts/restore-backup.sh coach-20261105T032300Z.dump.gpg \
  'postgres://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require'
```

The script verifies the checksum, decrypts into a private temp dir, validates the archive and runs
`pg_restore --clean --if-exists --single-transaction` after a typed confirmation. Verified locally
in M1: dump → encrypt → restore into a fresh database reproduced rows and the migrations table; a
wrong passphrase fails without touching the target.

## Preview deployments

Vercel no longer builds a preview for every PR: `git.deploymentEnabled` in `vercel.json` turns
Git deployments off for every branch but `main` (`"**": false`). The Hobby plan caps an account
at 100 deployments a day, and a preview for each push to each PR branch used that up on
2026-11-06 and left production unable to deploy. CI runs the Vercel-adapter build and the
migrations on every PR instead. When a hosted preview is useful, deploy one on demand with the
Vercel CLI (`vercel deploy` from the branch); it builds against the `preview` Neon branch
(migrated by the build). Previews are behind Vercel Authentication. `ANTHROPIC_API_KEY` is production-only; previews use the deterministic mock
coach provider unless a key is added for Preview.

### Resetting the preview database

**Never copy production data into `preview`:** no Neon **Reset from parent** (it replaces
`preview` with production's current schema _and rows_), no **Restore** from `production`, no new
branch from `production` other than schema-only, no backup restored into it. Once production is
live it holds the owner's training history and profile (injuries included) and the auth tables:
the owner, passkey public keys, session and recovery-code hashes, audit events with IP addresses
and user agents. A copy puts all of it in the one database that every PR preview reads and
writes, under code that has not been reviewed or merged, and breaks the assumption that previews
have their own database (docs/security.md). It does not even give a working preview: the copied
owner closes first-run setup there, and production passkeys do not work on a preview host.

To reset it, empty it and let the next preview build migrate it from scratch. The branch and its
connection strings stay, so nothing changes in Vercel:

1. Neon → **SQL Editor**, branch **`preview`**, database `neondb`. Check the branch selector
   first: on `production` these statements delete everything.

   ```sql
   DROP SCHEMA IF EXISTS drizzle CASCADE; -- the migrations journal
   DROP SCHEMA public CASCADE;            -- every app table and its rows
   CREATE SCHEMA public;
   ```

   They are what `pnpm db:reset:test` runs on the test databases (`resetDatabase` in
   `src/lib/server/db/migrate.ts`).

2. Redeploy the PR's preview (Vercel → Deployments → ⋯ → Redeploy). Its build logs
   `db:migrate: N new migration(s) applied, N total`, N being every committed migration plus the
   PR's own; until a preview has rebuilt, running previews fail at runtime. The database now has
   no owner: set a preview up again with its own token to sign in ("Owner setup" above).

If the branch itself has to be recreated, make it a **schema-only** branch (Beta): Neon →
Branches → New branch, parent `production`, **Schema only**, and untick "Automatically delete
branch after" (the console defaults to one day). It copies tables but never rows, and it is a root
branch, so it has no Reset from parent to click by mistake. Run step 1 on it before its first
build anyway: it has production's tables but an empty migrations journal, so `db:migrate` would
replay the first migration and fail with `relation "…" already exists`. Then point Vercel's
Preview `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct) at it and update its branch
ID under "What exists".

## Security notes

- Until the M2 production cutover the app must not be served on the production domain. Enforced by
  committed config: `vercel.json` (no Git deployments of `main`; Vercel-started production builds
  skipped by the ignored build step). Preview deployments sit behind Vercel Authentication.
- **Dynamic responses** (every page and `/api/*`, i.e. everything that runs `hooks.server.ts`)
  carry `x-robots-tag: noindex`, `x-frame-options: DENY`, `nosniff`, `referrer-policy`,
  `permissions-policy`, `cross-origin-opener-policy`, `strict-transport-security` (Vercel also
  adds HSTS on its domains) and a **Content-Security-Policy** generated by SvelteKit
  (`csp` in `vite.config.ts`): `default-src 'self'`, `script-src 'self'` + a per-response nonce +
  the sha256 of the inline theme script (no `unsafe-inline` for scripts), `object-src 'none'`,
  `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`. Styles allow
  `'unsafe-inline'` because Svelte renders `style` attributes. e2e asserts the header and that an
  injected inline script is refused.
- **Static and prerendered files** (`/_app/immutable/*`, icons, `manifest.webmanifest`,
  `robots.txt`, `/offline`) are served by the CDN (Vercel) or `sirv` (adapter-node) without
  running hooks, so they do **not** carry these headers. They contain no personal data; the
  prerendered `/offline` page carries its CSP as a `<meta>` tag (which cannot express
  `frame-ancestors`). `robots.txt` disallows everything and every page has `noindex` meta.
