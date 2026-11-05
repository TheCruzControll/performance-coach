# Deployment

Target: **Vercel** (Node.js 22, Fluid compute) at **coach.nikocruz.com**, DNS at **Cloudflare**
(DNS-only), database **Neon Lakebase Postgres**. Deploys and backups run from GitHub Actions.

> **Status (M1):** nothing has been deployed. The workflows are in place and **skip with a notice**
> until the secrets below exist, and production deploys stay **switched off** until the owner sets
> `PRODUCTION_DEPLOY_ENABLED=true` (only after passkey auth ships in M2). Network access to
> Vercel/Neon/Cloudflare was not available while building M1, so none of the steps on this page
> have been executed against real accounts.

## Production stays off until auth ships — how that is enforced

In M1 every page and `POST /api/vitals` are unauthenticated, so the app must not be served on
`coach.nikocruz.com` before passkey auth (M2). Hidden URLs are not security (PRD §13). There is
exactly **one** path to production, and it is closed by default:

| Path to production                                                                  | Guard                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel Git integration: a push to `main`                                            | **`vercel.json` → `git.deploymentEnabled.main: false`** (committed): Vercel creates no deployment for `main`.                                                                                                                                                                |
| Any production build Vercel starts itself (first build after import, redeploy, …)   | **`vercel.json` → `ignoreCommand`** runs `scripts/vercel-ignore-build.sh`, which skips the build whenever `VERCEL_ENV=production` (whatever the production branch is). Preview builds proceed.                                                                               |
| GitHub Actions `deploy.yml` (migrate → `vercel build` → `vercel deploy --prebuilt`) | **`PRODUCTION_DEPLOY_ENABLED`** repository variable must be exactly `true` (section 5). The build runs on the runner and is uploaded prebuilt, so Vercel's ignored build step does not apply to it. This stays the only production path after M2, because it migrates first. |

`scripts/vercel-ignore-build.test.ts` (unit suite) checks the committed config and the script's
exit codes. Both `vercel.json` settings are documented Vercel project configuration, but they
have **not** been exercised against a real Vercel account (no network access in M1): after
creating the project, confirm under Deployments that no production deployment exists.
The domain is attached only when production is switched on (section 5), so even a stray
production deployment would not be served on `coach.nikocruz.com`.

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

Do these in order. The committed `vercel.json` guards (above) are already in force for every
Git-triggered build, so creating the project cannot put the app into production.

1. **Create the project without deploying**, from a checkout of `main`: `vercel link` (answer
   "no" to linking an existing project, so it creates one) and then `vercel git connect` to
   attach the GitHub repository. `vercel link` writes `orgId`/`projectId` to
   `.vercel/project.json` (git-ignored; do not commit it). If you use the dashboard's
   **Import** instead, it starts a production build of the default branch right away; the
   ignored build step should skip it, which is not yet verified, so check **Deployments** and
   delete any production deployment you find.
2. Settings → General: framework preset **SvelteKit** (build command `pnpm build`, install
   `pnpm install --frozen-lockfile`), Node.js **22.x**.
3. Set **Function Region** to match Neon (e.g. Neon `aws-us-east-1` → `iad1`).
4. Environment variables (Production, and Preview with a Neon branch URL):
   `DATABASE_URL`, `DATABASE_URL_UNPOOLED`. Leave `ENABLE_TEST_ROUTES` unset.
5. Settings → Deployment Protection: keep **Vercel Authentication** on for preview deployments
   (previews still build from Git and serve the unauthenticated app until M2).
6. Create a token (Account → Tokens) for `deploy.yml`.

Do **not** add the domain yet: that is part of switching production on (section 5).

### 3. Domain (Cloudflare DNS → Vercel) — only when switching production on

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

### 5. Switching production on (after M2 only)

`deploy.yml` does nothing until the **repository variable** (Settings → Secrets and variables →
Actions → Variables) `PRODUCTION_DEPLOY_ENABLED` is exactly `true`. Leave it unset until passkey
auth (M2) is live and docs/milestones.md M2 criterion 6 is met. Then, in this order:

1. set `PRODUCTION_DEPLOY_ENABLED=true` and run **Deploy** (or merge to `main`);
2. attach the domain (section 3) once the deployment's `/api/health` is green.

Unsetting the variable (or setting anything else) switches production deploys off again without
touching the workflow. `vercel.json` is not changed when switching on: `deploy.yml` remains the
only production path because it applies migrations before the new code goes live.

## How a production deploy works (`deploy.yml`)

Triggered when **CI** completes successfully for a push to `main` (or manually):

1. Checks the `PRODUCTION_DEPLOY_ENABLED` switch, then the secrets; if the switch is off or a
   secret is missing, emits a notice and exits successfully (both the automatic and the manual
   trigger are gated).
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

- Until M2 ships passkey auth the app must not be served on the production domain. What is
  enforced by code: `vercel.json` (no Git deployments of `main`; Vercel-started production
  builds skipped by the ignored build step) and `deploy.yml` (off unless
  `PRODUCTION_DEPLOY_ENABLED` is `true`). What is process: the domain is attached only when
  production is switched on, and preview deployments rely on Vercel's deployment protection.
  None of this has been exercised against a real Vercel account yet (see the top of this page).
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
