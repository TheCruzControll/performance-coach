# Deployment

Target: **Vercel** (Node.js 22, Fluid compute) at **coach.nikocruz.com**, DNS at **Cloudflare**
(DNS-only), database **Neon Lakebase Postgres**. Deploys run through the **Vercel Git
integration**; every deployed build migrates its own database first (`scripts/vercel-build.sh`).

> **Status (M2):** production is **on**. Every merge to `main` deploys `coach.nikocruz.com`
> through the Vercel Git integration, migrating the production database first, and a smoke check
> runs against the domain after each deploy. Passkey auth guards every page and endpoint
> (docs/security.md). Until the owner completes the one-time setup below, the domain serves the
> sign-in screen and nobody can sign in. Previews are deployed on demand, not from every pull
> request (see "Preview deployments").

## What exists

| Piece      | Setting                                                                                                                                                                                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel     | Project `performance-coach` (`prj_ofpkwho7FKmRXNr9Bem9phaD2AVN`) in team `thecruzcontrolls-projects`, Hobby plan. Framework SvelteKit, Node.js 22.x, Fluid compute.                                                                                                                                        |
| Region     | Functions in **`pdx1`** (Portland), next to the Neon database in **`aws-us-west-2`** (Oregon), so a query is a same-region round trip.                                                                                                                                                                     |
| Git        | GitHub `TheCruzControll/performance-coach` linked; Git deployments only for `main` (previews on demand).                                                                                                                                                                                                   |
| Protection | Vercel Authentication on every deployment **except custom domains**: previews need a Vercel login; `coach.nikocruz.com` is public and protected by the app's own passkey auth.                                                                                                                             |
| Neon       | Project `red-rain-59499468` ("Performance coach"), Postgres 18, free plan, 6 h history window. Database `neondb`, role `neondb_owner`.                                                                                                                                                                     |
| Branches   | `production` (`br-green-block-bfh38xqf`, default) for Production; `preview` (`br-solitary-bonus-bf58ajx7`) shared by all preview deployments. Never point a preview at production.                                                                                                                         |
| Env vars   | `DATABASE_URL` (pooled, host contains `-pooler`) and `DATABASE_URL_UNPOOLED` (direct) for Production and Preview, each pointing at its own branch; `ANTHROPIC_API_KEY` for Production. All marked sensitive. Plus `OWNER_SETUP_TOKEN_HASH` (Production, only during the owner's setup; see "Owner setup"). |
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

**Exercise catalogue seed.** Every migrate run seeds the exercise library after migrating, under
the same lock: `pnpm db:migrate` (so every deployed build and CI) and the test and e2e resets,
which call the same `runMigrations`. One upsert from `CATALOGUE` in code
(`src/lib/server/db/seed/exercises.ts`) inserts new keys, updates changed entries in place,
retires keys the catalogue no longer has (`retired_at`, never deleted) and restores a retired key
that comes back; `db:migrate` logs the counts
(`db:migrate: exercise catalogue N inserted, N updated, N retired, N restored`). A rerun changes
nothing. Previews, deployed on demand, all share the one `preview` branch, so previews of branches
with different catalogues retire and restore each other's keys in turn. This is expected and
harmless: ids are stable, retired rows stay readable, and the generator reads the catalogue from
code, never from these rows.

## Production deploys

Every merge to `main` builds a production deployment through the Vercel Git integration:
`vercel.json` holds the build command and `git.deploymentEnabled` `{ "main": true, "**": false }`,
and there is no ignored-build step. A branch matching several rules deploys if any of them is
`true`, so `main` needs its own `true` next to the `"**": false` that keeps other branches from
deploying ("Preview deployments" below). The build migrates the production Neon branch, then
builds; once it is ready Vercel assigns `coach.nikocruz.com` to it, and the previous deployment
serves until then.
`scripts/vercel-build.test.ts` (unit suite) checks the committed config (nothing skips a
production build) and the build command's migrate-then-build order.
`vercel.json` also sends the prerendered pages, static files that never run `hooks.server.ts`,
`STATIC_PAGE_HEADERS` (`src/lib/server/security-headers.ts`); `scripts/vercel-headers.test.ts`
fails when a prerendered page has no rule or its headers differ from that constant.

Production deploys only from `main` through Git: no deploy token exists and no workflow deploys.
Do not deploy production by hand from a logged-in Vercel CLI (`vercel deploy --prod`): it skips
review and CI.

### Hosted environment variables (needed before the cutover merges)

Checked against `src/lib/server/env.ts` (validated at start-up: a missing or invalid variable
stops the server, listing every problem) and `scripts/vercel-build.sh` (a deployed build without
the direct URL fails):

| Variable                                                                        | Production                                                 | Preview                                | Why                                                                         |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                  | **required**: `production` branch, pooled (`-pooler` host) | **required**: `preview` branch, pooled | App traffic. Env validation refuses to start without it.                    |
| `DATABASE_URL_UNPOOLED`                                                         | **required**: `production` branch, direct                  | **required**: `preview` branch, direct | Migrations in the build: `vercel-build.sh` fails without it.                |
| `OWNER_SETUP_TOKEN_HASH`                                                        | only during the owner setup (below), sensitive             | optional: only to set a preview up     | Unset: `/setup` is a 404.                                                   |
| `ANTHROPIC_API_KEY`                                                             | exists; not needed until `LLM_PROVIDER=anthropic` (M5)     | not set                                | Required only with `LLM_PROVIDER=anthropic`.                                |
| `ENABLE_TEST_ROUTES`                                                            | **must not exist**                                         | **must not exist**                     | The server refuses to start with it on any Vercel deployment.               |
| `APP_ENV`                                                                       | unset (or `production`)                                    | unset (or `preview`)                   | Any other value on production refuses to start; Vercel's `VERCEL_ENV` wins. |
| `LLM_PROVIDER`, `LOG_LEVEL`, `DB_POOL_MAX`, `DB_QUERY_TIMEOUT_MS`, `SENTRY_DSN` | optional (defaults: `mock`, `info`, `5`, `10000`, off)     | optional                               | Validated when set.                                                         |

Vercel's system variables (`VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_BRANCH_URL`,
`VERCEL_GIT_COMMIT_SHA`) must stay exposed (Settings → Environment Variables → "Automatically
expose System Environment Variables", on by default): `VERCEL_ENV` names the environment (a
preview without it is treated as production and refuses passkeys on its host), and the commit
SHA is the version `/api/health` reports, which the smoke check waits for.

### Post-deploy smoke check (`post-deploy-smoke.yml`)

A GitHub Actions workflow triggered by Vercel's GitHub deployment statuses. When a
**Production** deployment reports **success**, it waits (up to 5 minutes) until
`https://coach.nikocruz.com/api/health` reports that deployment's commit, then checks the domain
from outside, signed out, with no secrets:

| Check                                                                   | Expected                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                                                       | 200 with `ok: true` and `db: "up"` (a real query)                                                                                                                                                                          |
| `GET /`                                                                 | 200: the sign-in screen with passkey sign-in, not the "passkeys aren't available on this address" notice                                                                                                                   |
| Security headers on `/`                                                 | CSP with `frame-ancestors 'none'`, `object-src 'none'` and no inline scripts; `Strict-Transport-Security`; `nosniff`; `X-Frame-Options: DENY`; referrer and permissions policies; COOP; `X-Robots-Tag: noindex`; `private` |
| Security headers on the prerendered pages (`/offline`, `/workout`)      | Exactly `STATIC_PAGE_HEADERS`, sent from `vercel.json`: the hooks' security headers (not `private`: these pages hold no personal data) and a CSP of `frame-ancestors 'none'`                                               |
| `GET /today`                                                            | 303 to `/?next=%2Ftoday`                                                                                                                                                                                                   |
| `POST /api/vitals`, `POST /api/client-errors` (with the app's `Origin`) | 401 `unauthenticated` (without the `Origin` the CSRF check would answer 403 first)                                                                                                                                         |
| `POST /api/test-support/session`                                        | 404: the test-only session route does not exist in production                                                                                                                                                              |

Every check runs and is listed in the run's summary; any failure fails the run (Actions →
**Post-deploy smoke**; the trigger is Vercel's bot, so check there after a merge rather than
waiting for a notification). It never signs in, so it reads no account data, and none of its
requests counts against a rate limit. Run it by hand from Actions → **Post-deploy smoke** → Run
workflow (it then skips the commit wait), for example after a rollback.

### Rollback

- **Code:** Vercel → Deployments → the previous production deployment → ⋯ → **Instant
  Rollback**. The domain switches at once, with no build and no migration; then run the smoke
  check by hand. On the Hobby plan only the immediately previous production deployment can be
  rolled back to; to go further, revert the commit on `main` (a normal deploy). After a rollback
  Vercel no longer assigns the domain to new production deployments: merges still build but do
  not go live (and their smoke check fails waiting for the new commit, as it should) until a
  deployment is promoted (Deployments → ⋯ → **Promote**).
- **Schema:** never rolled back. Migrations are expand → contract, so the previous deployment
  runs on the newer schema; fixes go forward.
- **Data:** Neon point-in-time restore (6 h window on the current plan) into a new branch, or a
  nightly backup (below).

## Owner setup (one time, on the iPhone)

The app has exactly one account, created by first-run setup (docs/security.md). Production starts
with an empty database and no owner, so after the cutover deploy (or an owner reset):

1. On a trusted machine, in the repository: `pnpm auth:setup-token`. It prints a random token,
   its SHA-256 and the link `https://coach.nikocruz.com/setup?token=<token>`. The token is shown
   once and stored nowhere; never paste it into chat, issues or logs.
2. Vercel → Project → Settings → Environment Variables: add `OWNER_SETUP_TOKEN_HASH` (or edit it,
   if it is already there) = the printed hash, environment **Production** only, marked
   **Sensitive**. Until setup completes, whoever holds that token can claim the account, so only
   ever set the hash of a token you alone hold. Redeploy production
   (Deployments → the current production deployment → ⋯ → Redeploy): the variable is read when
   the server starts. Run the smoke check afterwards if it does not start by itself.
3. On the iPhone, in Safari (the link travels to it through a private channel): open
   `https://coach.nikocruz.com/setup?token=<token>`, enter the name and create the passkey
   (Face ID).
4. Store the 10 recovery codes shown next (copy them into the password manager, or download them)
   and confirm. They are never shown again. The app opens on Today.
5. Remove `OWNER_SETUP_TOKEN_HASH` from Vercel. No redeploy is needed: `/setup` already answers
   404 for good, even with the right token, and the next deploy starts without the variable.
   Vercel's request logs keep the setup URL with the token; it is useless once setup has
   completed (a token works for one setup, and stays refused even after an owner reset).
6. Recommended right away: Profile → Security → **Add passkey** on a second device (Mac, or a
   hardware key) so losing the iPhone never needs a recovery code.
7. Run the real-device checklist in docs/testing.md on the iPhone (deferred from M1 to this
   moment) and record device, iOS version, date and screenshots.

If the link answers 404: the running deployment does not have the hash yet (redeploy after
setting it), the link is incomplete, the token was already used, or there were too many setup
attempts from that network in the last 15 minutes (wait, then retry). Every request counts, right
token or wrong: each load of the link, and each passkey options and verify call (10 per 15 minutes
per IP).

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

  It refuses to run unless `DATABASE_URL_UNPOOLED` is set (there is no default: it never falls
  back to `DATABASE_URL` or a local database), `--confirm` is given and it runs in an interactive
  terminal; all three refusals were verified for the cutover and are tested
  (`scripts/auth-reset-owner.test.ts`, `tests/integration/auth/reset-owner-cli.test.ts`). It
  prints the target database (password redacted), the owner and what will be deleted, then asks
  for `<database>@<host>` to be typed back. In one transaction it deletes
  every passkey, recovery code, email sign-in link and pending challenge, revokes every session,
  reopens first-run setup and writes an `owner.reset` audit event. **The owner row and all
  training data are kept.** Then follow "Owner setup" above with a **new** token (the previous
  link stays refused: each token works for one setup); setup re-attaches to the same owner.

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

- Production serves `coach.nikocruz.com` from `main` only (Git integration). Every page and
  endpoint except the sign-in, setup and recovery flow, `/api/health` and static files needs a
  passkey session (docs/security.md), and the post-deploy smoke check verifies that from outside
  after every deploy. Preview deployments sit behind Vercel Authentication.
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
  `robots.txt`, `/offline`, `/workout`) are served by the CDN (Vercel) or `sirv` (adapter-node) without
  running hooks. They contain no personal data. On Vercel the prerendered pages get the same
  headers from `vercel.json`, plus a CSP header of `frame-ancestors 'none'`: their own CSP is a
  `<meta>` tag, which cannot express it. Other static files, and every static file under `sirv`,
  carry none of them. `robots.txt` disallows everything and every page has `noindex` meta.
