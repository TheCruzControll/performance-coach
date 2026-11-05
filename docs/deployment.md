# Deployment

Target: **Vercel** (Node.js 22, Fluid compute) at **coach.nikocruz.com**, DNS at **Cloudflare**
(DNS-only), database **Neon Lakebase Postgres**. Deploys run through the **Vercel Git
integration**; every deployed build migrates its own database first (`scripts/vercel-build.sh`).

> **Status (M1):** the accounts, project, database branches, environment variables and domain
> below exist and were configured through the Vercel and Neon APIs. Preview deployments build
> from every pull request. **Production is switched off** until passkey auth ships (M2): nothing
> is served on `coach.nikocruz.com` yet.

## What exists

| Piece      | Setting                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vercel     | Project `performance-coach` (`prj_ofpkwho7FKmRXNr9Bem9phaD2AVN`) in team `thecruzcontrolls-projects`, Hobby plan. Framework SvelteKit, Node.js 22.x, Fluid compute.                                          |
| Region     | Functions in **`pdx1`** (Portland), next to the Neon database in **`aws-us-west-2`** (Oregon), so a query is a same-region round trip.                                                                       |
| Git        | GitHub `TheCruzControll/performance-coach` linked; Vercel builds every PR as a preview.                                                                                                                      |
| Protection | Vercel Authentication on every deployment **except custom domains**: previews need a Vercel login; `coach.nikocruz.com` is public and protected by the app's own passkey auth.                               |
| Neon       | Project `red-rain-59499468` ("Performance coach"), Postgres 18, free plan, 6 h history window. Database `neondb`, role `neondb_owner`.                                                                       |
| Branches   | `production` (`br-green-block-bfh38xqf`, default) for Production; `preview` (`br-solitary-bonus-bf58ajx7`) shared by all preview deployments. Never point a preview at production.                           |
| Env vars   | `DATABASE_URL` (pooled, host contains `-pooler`) and `DATABASE_URL_UNPOOLED` (direct) for Production and Preview, each pointing at its own branch; `ANTHROPIC_API_KEY` for Production. All marked sensitive. |
| Domain     | `coach.nikocruz.com` attached and verified. Cloudflare: `CNAME coach → e8ec158fe2c98016.vercel-dns-017.com`, **DNS only** (grey cloud), so Vercel terminates TLS.                                            |

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
land there; if a PR's migration changes before it merges, reset the branch from production
(Neon → Branches → `preview` → Reset from parent) and redeploy.

## Production stays off until auth ships — how that is enforced

In M1 every page and `POST /api/vitals` are unauthenticated, so the app must not be served on
`coach.nikocruz.com` before passkey auth (M2). Hidden URLs are not security (PRD §13).

| Path to production                                                               | Guard                                                                                                                      |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Vercel Git integration: a push to `main`                                         | `vercel.json` → `git.deploymentEnabled.main: false` (committed): Vercel creates no deployment for `main`.                  |
| Any production build Vercel starts itself (dashboard redeploy, branch rename, …) | `vercel.json` → `ignoreCommand` runs `scripts/vercel-ignore-build.sh`, which skips the build when `VERCEL_ENV=production`. |

`scripts/vercel-ignore-build.test.ts` (unit suite) checks the committed config, the ignore step's
exit codes and the build command's migrate-then-build order. There is no other path: no deploy
token exists and no workflow deploys.

**Switching production on is part of the M2 pull request that ships auth:** it removes both
guards, and from then on every merge to `main` builds production through the Git integration,
migrating the production branch first. M2 also adds a post-deploy smoke check
(`GET https://coach.nikocruz.com/api/health` must return 200).

**Rollback:** Vercel → Deployments → promote the previous deployment (instant). Database rollbacks
are forward fixes; for data loss use Neon point-in-time restore (6 h window on the current plan)
or a backup (below).

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

Vercel builds every PR against the `preview` Neon branch (migrated by the build). They are behind
Vercel Authentication. `ANTHROPIC_API_KEY` is production-only; previews use the deterministic mock
coach provider unless a key is added for Preview.

## Security notes

- Until M2 ships passkey auth the app must not be served on the production domain. Enforced by
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
