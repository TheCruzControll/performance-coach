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

| Variable                                                                        | Production                                                                 | Preview                                | Why                                                                         |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                  | **required**: `production` branch, pooled (`-pooler` host)                 | **required**: `preview` branch, pooled | App traffic. Env validation refuses to start without it.                    |
| `DATABASE_URL_UNPOOLED`                                                         | **required**: `production` branch, direct                                  | **required**: `preview` branch, direct | Migrations in the build: `vercel-build.sh` fails without it.                |
| `OWNER_SETUP_TOKEN_HASH`                                                        | only during the owner setup (below), sensitive                             | optional: only to set a preview up     | Unset: `/setup` is a 404.                                                   |
| `ANTHROPIC_API_KEY`                                                             | exists; used once the coach launches (M5)                                  | not set                                | Missing: the coach is unavailable; the app is unaffected.                   |
| `ENABLE_TEST_ROUTES`                                                            | **must not exist**                                                         | **must not exist**                     | The server refuses to start with it on any Vercel deployment.               |
| `APP_ENV`                                                                       | unset (or `production`)                                                    | unset (or `preview`)                   | Any other value on production refuses to start; Vercel's `VERCEL_ENV` wins. |
| `LLM_PROVIDER`, `LOG_LEVEL`, `DB_POOL_MAX`, `DB_QUERY_TIMEOUT_MS`, `SENTRY_DSN` | optional (defaults: unset, `info`, `5`, `10000`, off)                      | optional                               | Validated when set.                                                         |
| `CRON_SECRET`                                                                   | for backups: `openssl rand -hex 32`, Sensitive                             | not set                                | Unset: the backup cron's route is a 404. "Set up backups" below.            |
| `BACKUP_ENCRYPTION_KEY`                                                         | for backups: `pnpm backup:keygen`, Sensitive, also in the password manager | not set                                | Unset or invalid: backups are off (the cron answers 503).                   |
| `BLOB_READ_WRITE_TOKEN`                                                         | for backups: injected by connecting the private store                      | not set                                | Unset: backups are off. Previews never reach the store.                     |
| `BACKUP_DIR`                                                                    | **must not exist**                                                         | **must not exist**                     | A local folder store for development; refused on Vercel.                    |

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
- **Data:** Neon point-in-time restore (6 h window on the current plan) into a new branch, or the
  daily backup ("Restore drill" below).

## Owner setup (one time, on the iPhone)

Done for production on 2026-11-06 (10:43 UTC) on the owner's iPhone 16 Pro Max, iOS 27.0.1, in
Chrome for iOS: passkey and recovery codes stored, `OWNER_SETUP_TOKEN_HASH` emptied in Vercel,
real-device checklist passed. Still to do: the owner deletes the emptied
`OWNER_SETUP_TOKEN_HASH` variable at a desk (step 5). The steps below stay for an owner reset.

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
3. On the iPhone, in the browser you use (Chrome for iOS or Safari; the link travels to it through a private channel): open
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

## Backups

Neon's scheduled snapshots are not available on this project's plan (the API returns "backup
schedule creation is not enabled for this project"), and its point-in-time window is 6 hours.
Backups therefore come in three layers:

| Layer                                   | Runs                                       | Kept                          | State                                                                                                                            |
| --------------------------------------- | ------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1. Daily app-level backup (Vercel Cron) | every day, 10:00–10:59 UTC                 | 30 daily + 12 monthly         | built, **off** until `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET` and a valid `BACKUP_ENCRYPTION_KEY` are set ("Set up backups" below) |
| 2. `pg_dump` workflow (`backup.yml`)    | nightly at 03:23 UTC, if its secrets exist | 30 days, as Actions artifacts | **optional, off** while the repository is public                                                                                 |
| 3. Neon point-in-time restore           | continuous                                 | the last 6 hours              | always on                                                                                                                        |

Every backup holds the owner's data: treat a backup file, a decrypted copy and anything pasted
from one as private ("Evidence stays private" under "Restore drill" below).

### 1. The daily app-level backup (`/api/cron/backup`)

`vercel.json` declares one cron, `41 10 * * *` (UTC). On the Hobby plan Vercel runs crons on the
production deployment only, at most once a day, **anywhere within the scheduled hour** (so between
10:00 and 10:59 UTC) and never retries a failed run. Vercel calls the route with `GET` and
`Authorization: Bearer <CRON_SECRET>`; nothing else opens it (`src/lib/server/auth/cron.ts`). The
route allows itself 60 s (`maxDuration`), valid with or without Fluid compute.

One run (`src/lib/server/services/backups/run.ts`):

1. **Export:** every table in one `REPEATABLE READ READ ONLY` transaction on its own connection
   to `DATABASE_URL`, under a transaction-scoped lock that lets only one export go at a time,
   gzipped and sealed in memory. The transaction commits, releasing the lock, before anything is
   uploaded, so a slow upload never holds a snapshot or a pooled connection open; upload, read-back
   and prune are not serialized.
2. **Upload** to the private Vercel Blob store `performance-coach-backups`.
3. **Read back:** the object is downloaded and fully verified (same bytes, GCM tag, every
   section, counts and digests). A file that fails is deleted on a best-effort basis: if the
   delete fails too (logged as `backup discard failed`), the unverified object stays in the store
   and `pnpm backup:list` shows it.
4. **Prune** by retention, only after 1–3 succeeded and only after a complete listing.

| Property  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format    | `.pcbk`: a `PCBK` header with the key id, then AES-256-GCM (`BACKUP_ENCRYPTION_KEY`) over gzipped JSON lines: a header (format version, time, app version, schema tag, pinned settings, columns, excluded tables), each table's rows as Postgres's own row text in primary-key order, the sequences, and a trailer with per-table counts and SHA-256 digests and a digest of the whole file. The encrypted-backups ADR in `docs/adr/` explains the choice. |
| Path      | `backups/YYYY/MM/DD/coach-YYYYMMDDTHHMMSSZ.pcbk` (UTC, to the second; `src/lib/domain/backup/pathnames.ts`)                                                                                                                                                                                                                                                                                                                                                |
| Retention | The newest backup of each of the last **30** UTC days and the **earliest** of each of the last **12** UTC months: normally at most 42 files (`RETENTION` in `src/lib/domain/backup/retention.ts`), not a hard ceiling. The new file, any file dated after the run's clock and any name that is not a backup's are never deleted, and a failed prune is recorded and leaves the extras until the next run.                                                  |
| Contents  | Every table in `public` except `auth_sessions`, `webauthn_challenges`, `auth_rate_limits`, `email_sign_in_links` and `backup_runs`, each with its reason in `EXCLUDED_TABLES` (`src/lib/server/db/backup/tables.ts`). The owner, passkeys, recovery-code hashes, the audit trail and telemetry are included; sessions are not, so after a restore every device signs in again.                                                                             |
| Size      | 2.48 MB sealed for the two-year `db:explain` dataset (41,434 rows in 53 tables; CI run [42447028500](https://github.com/TheCruzControll/performance-coach/actions/runs/42447028500)), exported in 1.1 s and read back in 0.1 s, against budgets of 30 s and 10 s (`scripts/explain/backup.explain.ts`).                                                                                                                                                    |

**The Hobby arithmetic** (Vercel's published Blob allowance, checked 2026-11-08: 1 GB storage,
2,000 advanced and 10,000 simple operations, 10 GB data transfer a month, shared by the whole
account; over a limit Blob is **blocked** until the 30-day window resets, never billed):

- Storage: at most 42 files × about 2.5 MB ≈ 105 MB, about 11 % of 1 GB. `pnpm backup:list`
  prints the real total against the allowance.
- Operations: a run is one upload and one listing (advanced; an upload over 8 MB goes multipart and
  counts one per part plus two), one read-back download, and one delete per pruned file (deletes
  are free): about 60 advanced operations a month, 3 % of the allowance. Browsing the store in the
  Vercel dashboard also counts as advanced operations; `pnpm backup:list` costs one listing, the
  probe about 5 operations.
- Transfer: the daily read-back downloads one file, about 75 MB a month.

**What the route answers** (for a manual call, or in the runtime logs):

| Status | Body                                                                    | Meaning                                                                                                                                  |
| ------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | `status`, `pathname`, `bytes`, `sha256`, `tables`, `rows`, `durationMs` | A backup was made, read back and verified, then old ones pruned (a failed prune is logged; the backup stands).                           |
| 401    | `unauthorized`                                                          | No bearer, or the wrong one: the caller is not Vercel Cron.                                                                              |
| 404    | `not_found`                                                             | `CRON_SECRET` is unset on the running deployment, or shorter than 32 characters: the route does not exist.                               |
| 405    | `method_not_allowed`                                                    | Not a `GET` (`HEAD` included).                                                                                                           |
| 409    | `already_running`                                                       | Another run holds the lock (a doubled cron, or a manual run at the same moment). Nothing is recorded; that run makes the backup.         |
| 503    | `backup_not_configured`, with `missing` and `invalid`                   | The key or the store is missing or invalid; the variables are named, never their values. Recorded in `app_errors`.                       |
| 500    | an error code and `requestId`                                           | The run failed (export, upload, read-back); the failure is in `app_errors` with kind `cron` and that request id. Nothing old was pruned. |

**Is it fresh?** `pnpm backup:list` (on a trusted machine, with the store's token: "Set up
backups" step 1) prints every backup newest first, with its age, size and retention bucket, and
exits 1 when the newest is older than 36 hours (`FRESHNESS_LIMIT_HOURS` in
`scripts/backup-list.ts`) or the store is empty. Vercel → Project → Settings → **Cron Jobs** lists
the job; its **View Logs** opens the runtime logs filtered to `requestPath:/api/cron/backup`.
`pnpm backup:list --probe` also proves the store is private and working end to end.

**Manual runs:** `vercel crons run /api/cron/backup`, from a linked, logged-in Vercel CLI (the
command is in beta), triggers the cron deployed to production the way the schedule does. From a
trusted machine, `pnpm backup:run --blob` makes the same verified run into the store (it asks for
`<database>@<host>` to be typed back), and `pnpm backup:run --out <file>` writes one to a local
file instead. Pass every secret through the environment, never as an argument:

```sh
read -rs DATABASE_URL_UNPOOLED && export DATABASE_URL_UNPOOLED      # production, direct
read -rs BACKUP_ENCRYPTION_KEY && export BACKUP_ENCRYPTION_KEY      # password manager
read -rs BLOB_READ_WRITE_TOKEN && export BLOB_READ_WRITE_TOKEN      # the store's page
pnpm backup:run --blob
unset DATABASE_URL_UNPOOLED BACKUP_ENCRYPTION_KEY BLOB_READ_WRITE_TOKEN
```

### 2. The `pg_dump` workflow (`backup.yml`): optional, off

The workflow dumps the whole database nightly at 03:23 UTC (and on demand):
`pg_dump --format=custom` over the direct URL, piped into
`gpg --symmetric --cipher-algo AES256` with `BACKUP_PASSPHRASE`, plus a `.sha256`, uploaded as a
workflow artifact retained **30 days**. The plaintext dump never touches disk.
`PG_CLIENT_VERSION` in the workflow must be ≥ the Neon server's major version.

It **skips with a notice** until two repository secrets exist (GitHub → Settings → Secrets and
variables → Actions): `DATABASE_URL_UNPOOLED` (the Neon production **direct** string) and
`BACKUP_PASSPHRASE`. **Leave them unset while the repository is public:** a public repository's
workflow artifacts can be downloaded by any signed-in GitHub user, so the passphrase would be the
only thing between the internet and every row. Turn the layer on only if the repository goes
private, or with a passphrase of at least 128 random bits (`openssl rand -base64 24`), saved in
the password manager first.

The skip is verified: run
[42147437996](https://github.com/TheCruzControll/performance-coach/actions/runs/42147437996)
(on demand, on `main`) ended green with the notice "Backup skipped: Missing secrets:
DATABASE_URL_UNPOOLED BACKUP_PASSPHRASE".

#### Restore a `pg_dump` backup

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

The script verifies the checksum when the `.sha256` file sits beside the backup (without it, it
continues unchecked), decrypts into a private temp dir, validates the archive and runs
`pg_restore --clean --if-exists --single-transaction` after a typed confirmation. Verified locally
in M1: dump → encrypt → restore into a fresh database reproduced rows and the migrations table; a
wrong passphrase fails without touching the target.

### 3. Neon point-in-time restore

Neon keeps 6 hours of history on the free plan. For a mistake noticed within that window, Neon →
Branches → `production` → **Restore** (or a new branch from a past point in time) loses less than
a daily backup would. Beyond 6 hours, restore the daily backup ("Restore drill" below).

## Set up backups (tech lead, once)

Nothing here costs money. Do the steps in order; every secret goes from the generating command
straight into Vercel and the password manager, never into a file in the repository, a chat, an
issue or shell history.

1. **The store.** Create a **private** Blob store connected to **Production only** (Vercel →
   Storage → Create → Blob, access **Private**, environment Production; or from the linked CLI):

   ```sh
   vercel blob create-store performance-coach-backups --access private --region pdx1 --environment production --yes
   ```

   Connecting it injects `BLOB_READ_WRITE_TOKEN` into Production. Production variables are
   Sensitive and cannot be pulled, so the CLI's copy comes from the store's page (Vercel → Storage
   → `performance-coach-backups`), entered with `read -rs` as above. Then, once:
   `pnpm backup:list --probe` must end "Probe: the store is private, and writes, reads, lists and
   deletes." (and "No backups in the store.", exit 1, until the first run).

2. **The key.** On a trusted machine, `pnpm backup:keygen` prints a fresh key and its key id once.
   At the same moment, save both in the owner's password manager (entry "Performance Coach backup
   key <id>") and add `BACKUP_ENCRYPTION_KEY` in Vercel: Production only, **Sensitive**. Clear the
   terminal. Without this key no backup can be read, by anyone.
   **Rotation:** yearly, or at once on any suspicion: generate a new key and replace the Vercel
   value (then redeploy). Keep every old key in the password manager, labelled with its id, for
   13 months, as long as monthly backups sealed with it exist; a backup names its key id, and a
   restore with the wrong key refuses before writing (`wrong_key`).
3. **The cron's secret.** `openssl rand -hex 32`, added as `CRON_SECRET` in Vercel: Production
   only, Sensitive. It needs no other copy: a lost one is simply replaced.
4. **Redeploy** production (Deployments → the current production deployment → ⋯ → Redeploy):
   the variables are read when the server starts. Then run it once by hand
   (`vercel crons run /api/cron/backup`): its runtime log shows 200, and
   `pnpm backup:list` shows the file. The post-deploy smoke check keeps checking that the route
   refuses a caller without the bearer.
5. **Confirm the first scheduled run.** The next day after 11:00 UTC, the runtime logs (Settings
   → Cron Jobs → **View Logs**, filtered to `requestPath:/api/cron/backup`) show an invocation
   between 10:00 and 10:59 UTC answered 200, and `pnpm backup:list` shows that day's file. This proves the scheduled call reaches the
   function although the deployment URLs sit behind Deployment Protection (Vercel Authentication
   on everything except custom domains, "What exists" above).
6. **If no scheduled invocation appears,** or it is refused before reaching the function (a 401 or
   a Vercel Authentication page instead of the route's JSON): the tech lead runs
   `pnpm backup:run --blob` once a day until the owner chooses between a scheduled GitHub workflow
   that calls `https://coach.nikocruz.com/api/cron/backup` with `CRON_SECRET` as a repository
   secret, and a change to Deployment Protection.

## Restore drill (into a Neon branch)

The drill proves that a backup restores, with the key from the password manager, into a database
the app can run on, and measures how long it takes. Run it on a trusted machine with this
repository checked out at `main` and PostgreSQL 18's `psql`. Record each step's UTC times in the
table below as you go.

1. **Pick the backup.** `pnpm backup:list` (with the store's token) prints the store's host and
   every backup, newest first. Usually the newest: note its pathname. Its URL is
   `https://<the printed host>/<pathname>`.
2. **Create the target.** Neon → Branches → **New branch** `restore-drill-YYYYMMDD` from
   `production` (current data). On that branch, Databases → **New database** `restore_drill`,
   owner `neondb_owner`: it is empty. Copy the branch's **direct** connection string for
   `restore_drill` (Connect → database `restore_drill`, connection pooling off).
3. **Get the key from the password manager**, never from Vercel: the drill proves that the copy
   held outside Vercel opens the backups.
4. **Restore** (it prints the backup's summary and the target's state, then asks for
   `restore_drill@<host>` to be typed back):

   ```sh
   read -rs BACKUP_ENCRYPTION_KEY && export BACKUP_ENCRYPTION_KEY      # password manager
   read -rs BLOB_READ_WRITE_TOKEN && export BLOB_READ_WRITE_TOKEN      # the store's page
   read -rs TARGET && export TARGET                                    # the branch's direct URL
   pnpm backup:restore 'https://<host>/backups/YYYY/MM/DD/coach-….pcbk' --target "$TARGET" --label 'drill YYYY-MM-DD'
   ```

   Before its first write it verifies the key id, the GCM tag, every section, the counts and
   digests, and that the backup's migrations are a prefix of this checkout's. It refuses a target
   that holds rows. It migrates the target to the backup's schema; then, in one transaction, it
   inserts every row with its original id, sets the sequences, recomputes every table's digest and
   rolls back on any difference; finally it migrates forward to this checkout. It ends with a table
   of each phase's UTC start and end, for the record. A rerun of the same backup writes no row
   (`Already restored`), still migrates forward and seeds the exercise catalogue, and exits 0.

5. **Verify** with counts, digests, ids and timestamps only. The restore has already compared
   every table's digest. The forward migration and catalogue seeding can then add or change rows
   and timestamps (the exercise catalogue, and any table a newer migration touches); outside those,
   confirm on the branch that the per-table counts add up to the `Rows:` line it printed and that
   the newest timestamps are not later than its `Taken:` line:

   ```sh
   psql "$TARGET" -X -A -F ' | ' <<'SQL'
   set timezone = 'UTC';
   select t.table_name,
     (xpath('//n/text()', query_to_xml(format('select count(*) as n from public.%I', t.table_name), false, false, '')))[1]::text::bigint as rows,
     case when c.has_created then (xpath('//m/text()', query_to_xml(format('select max(created_at) as m from public.%I', t.table_name), false, false, '')))[1]::text end as newest_created_at,
     case when c.has_created and c.has_id then (xpath('//i/text()', query_to_xml(format('select id::text as i from public.%I order by created_at desc, id::text desc limit 1', t.table_name), false, false, '')))[1]::text end as newest_id
   from information_schema.tables t
   cross join lateral (
     select bool_or(column_name = 'created_at') as has_created, bool_or(column_name = 'id') as has_id
     from information_schema.columns k where k.table_schema = 'public' and k.table_name = t.table_name
   ) c
   where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
   order by t.table_name;
   SQL
   ```

   Run the same query on `production` (read-only) right after: outside the excluded tables and
   rows changed by migrations or seeding, a count may differ only where production gained rows
   after the backup (newest timestamp later than `Taken:`, the data a restore would lose) or lost
   rows to deletions since it, which timestamps do not show. The excluded tables (sessions among
   them) are empty on the branch and are not compared.

6. **Record RPO and RTO, then delete the branch.** RPO is the backup's age when the drill started
   (`Taken:` to step 1's start; at most about 25 hours with a daily cron). RTO is step 2's start to
   step 5's finish. Then Neon → Branches → `restore-drill-YYYYMMDD` → **Delete**, the same day,
   and `unset BACKUP_ENCRYPTION_KEY BLOB_READ_WRITE_TOKEN TARGET`.

**Evidence stays private.** This repository is public, so the record below (and any PR body,
report or CI artifact) holds only UTC times, durations, counts, digests and digest matches, row
ids, key ids, schema tags, versions, SHAs and pass/fail. Never row content, names, goals, notes,
injuries, thread titles, coach text or screenshots: the owner keeps those privately and cites them
by date and SHA-256.

| Step                             | Started (UTC) | Finished (UTC) | Result | Evidence |
| -------------------------------- | ------------- | -------------- | ------ | -------- |
| 1. Pick the backup               |               |                |        |          |
| 2. Create the target             |               |                |        |          |
| 3. Key from the password manager |               |                |        |          |
| 4. Restore                       |               |                |        |          |
| 5. Verify                        |               |                |        |          |
| 6. RPO, RTO, branch deleted      |               |                |        |          |

**Disaster restore:** the same command against a new, empty database on a new branch. Create a
branch from `production` (or Neon's **Restore** first, if the loss is within the 6-hour window:
layer 3), add an empty database, restore into it as in steps 3–5, then make that branch the
default (Neon → Branches → ⋯ → **Set as default**), point Production's `DATABASE_URL` (pooled) and
`DATABASE_URL_UNPOOLED` (direct) at its new database and redeploy. Every device signs in again,
because sessions are never backed up. Keep the old branch until the owner has checked the app.

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
