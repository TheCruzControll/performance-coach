# Deployment

Target: **Vercel** (Node.js 22, Fluid compute) at **coach.nikocruz.com**, DNS at **Cloudflare**
(DNS-only), database **Neon Lakebase Postgres**. Deploys and backups run from GitHub Actions.

> **Status (M1):** nothing has been deployed. The workflows are in place and **skip with a notice**
> until the secrets below exist. Network access to Vercel/Neon/Cloudflare was not available while
> building M1, so none of the steps on this page have been executed against real accounts.

## What the owner must do (one-time)

### 1. Neon (database)

1. Create a Neon project (pick a region close to you, e.g. `aws-us-east-1`) with Postgres 17
   (or 16).
2. Note both connection strings for the default (production) branch:
   - **pooled** (host contains `-pooler`) → `DATABASE_URL`
   - **direct** → `DATABASE_URL_UNPOOLED`
3. Optional: `neon link` in this repo, then `neon deploy` applies `neon.ts` (Postgres only, plus
   a 7-day TTL / scale-to-zero policy for new dev/preview branches).
4. Optional: enable Neon's Vercel integration to create a database branch per preview deployment.

### 2. Vercel (hosting)

1. Create a project from the GitHub repository. Framework preset: **SvelteKit** (build command
   `pnpm build`, install `pnpm install --frozen-lockfile`). Node.js **22.x**.
2. Set **Function Region** to match Neon (e.g. Neon `aws-us-east-1` → `iad1`).
3. Environment variables (Production, and Preview with a Neon branch URL):
   `DATABASE_URL`, `DATABASE_URL_UNPOOLED`. Leave `ENABLE_TEST_ROUTES` unset.
4. Disable Vercel's automatic Git deployments for `main` if you want GitHub Actions
   (`deploy.yml`) to be the only production path (recommended: it migrates first).
5. Create a token (Account → Tokens) and read `orgId`/`projectId` (`vercel link` writes them to
   `.vercel/project.json`; do not commit it).

### 3. Domain (Cloudflare DNS → Vercel)

1. Vercel → Project → Domains → add `coach.nikocruz.com`.
2. Cloudflare → DNS for `nikocruz.com` → add `CNAME coach → cname.vercel-dns.com`,
   **Proxy status: DNS only** (grey cloud). Vercel issues the TLS certificate.
3. Wait for Vercel to show the domain as valid.

### 4. GitHub secrets

Repository (or `production` environment) secrets:

| Secret                  | Used by                  | Value                                                                                         |
| ----------------------- | ------------------------ | --------------------------------------------------------------------------------------------- |
| `DATABASE_URL_UNPOOLED` | deploy (migrate), backup | Neon **direct** connection string                                                             |
| `VERCEL_TOKEN`          | deploy                   | Vercel access token                                                                           |
| `VERCEL_ORG_ID`         | deploy                   | Vercel team/user id                                                                           |
| `VERCEL_PROJECT_ID`     | deploy                   | Vercel project id                                                                             |
| `BACKUP_PASSPHRASE`     | backup                   | Long random passphrase; store it in a password manager — backups are unrecoverable without it |

## How a production deploy works (`deploy.yml`)

Triggered when **CI** completes successfully for a push to `main` (or manually):

1. Checks secrets; if any is missing, emits a notice and exits successfully.
2. `pnpm install --frozen-lockfile`
3. `pnpm db:migrate` against `DATABASE_URL_UNPOOLED` (advisory-locked, idempotent).
4. `vercel pull --environment=production`, `vercel build --prod`, `vercel deploy --prebuilt --prod`
   (CLI pinned in the workflow).
5. Smoke test: `GET https://coach.nikocruz.com/api/health` must return 200.

**Migration rule:** because migrations run before the new code is live, every migration must be
compatible with the currently deployed code (expand → backfill → contract over two releases).

**Rollback:** Vercel → Deployments → promote the previous deployment (instant). Database rollbacks
are forward fixes; for data loss use Neon point-in-time restore or a backup (below).

## Backups (`backup.yml`)

- Nightly at 03:23 UTC (and on demand): `pg_dump --format=custom` over the direct URL, piped into
  `gpg --symmetric --cipher-algo AES256` with `BACKUP_PASSPHRASE`, plus a `.sha256`, uploaded as a
  workflow artifact retained **30 days**. The plaintext dump never touches disk.
- This complements Neon's built-in point-in-time restore (history window depends on the plan).
- `PG_CLIENT_VERSION` in the workflow must be ≥ the Neon server's major version.

### Restore

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

Vercel builds every PR. Point preview `DATABASE_URL`s at a Neon branch (integration or
`neon checkout`), never at production. `neon.ts` gives new branches a 7-day TTL and a 0.25–1 CU
scale-to-zero compute.

## Security notes

- Until M2 ships passkey auth, the deployed app contains no personal data, but should not be
  promoted to the custom domain before auth is live (or protect it with Vercel deployment
  protection).
- Every response carries `x-robots-tag: noindex`, `x-frame-options: DENY`, `nosniff`,
  `referrer-policy` and `permissions-policy`. HSTS is provided by Vercel on the custom domain.
