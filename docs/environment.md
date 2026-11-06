# Environment variables

All server configuration comes from environment variables, validated at startup by
[`src/lib/server/env.ts`](../src/lib/server/env.ts) (zod). A misconfigured deployment fails fast:
the `init` hook throws one error listing **every** invalid variable. Nothing here is ever sent to
the browser (the module lives under `src/lib/server/`, which SvelteKit refuses to bundle for the
client).

Copy the template for local development:

```sh
cp .env.example .env
```

## Variables

| Variable                 | Required                     | Default | Purpose                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`           | **yes**                      | —       | Pooled Postgres URL for app traffic. Neon: the `-pooler` host. Must start `postgres(ql)://`.                                                                                                                                                                                                                                                                                                              |
| `DATABASE_URL_UNPOOLED`  | migrations / backups         | —       | Direct (non-pooled) URL. Used by `pnpm db:migrate`, deploy migrations and `pg_dump`.                                                                                                                                                                                                                                                                                                                      |
| `APP_ENV`                | no                           | derived | `development` · `test` · `preview` · `production`. Falls back to `VERCEL_ENV`, then `NODE_ENV`; must be `production` (or unset) when `VERCEL_ENV=production`.                                                                                                                                                                                                                                             |
| `DB_POOL_MAX`            | no                           | `5`     | Max pg clients per server instance (1–50). Keep small behind Neon's pooler.                                                                                                                                                                                                                                                                                                                               |
| `DB_QUERY_TIMEOUT_MS`    | no                           | `10000` | Client-side per-query timeout (pooler-safe; no session `SET`).                                                                                                                                                                                                                                                                                                                                            |
| `LOG_LEVEL`              | no                           | `info`  | `debug` · `info` · `warn` · `error` · `silent`. Integration tests default to `silent`.                                                                                                                                                                                                                                                                                                                    |
| `ENABLE_TEST_ROUTES`     | no                           | `false` | Enables `/api/test-support/*` for automated tests (one mints an owner session without a passkey, for WebKit e2e). **Rejected on any hosted deployment** (`VERCEL` or any `VERCEL_ENV` set), in any build for Vercel, and when `appEnv` is `preview` or `production`; the routes re-check at runtime.                                                                                                      |
| `OWNER_SETUP_TOKEN_HASH` | first-run setup              | —       | Hex SHA-256 of the one-time owner setup token (`pnpm auth:setup-token`). Unset: `/setup` is a 404. Only the hash is configured, never the token. Useless once setup has completed (setup closes for good); remove it afterwards. See docs/deployment.md.                                                                                                                                                  |
| `LLM_PROVIDER`           | no                           | `mock`  | Coach model provider (M5): `mock` (deterministic, no key) or `anthropic`.                                                                                                                                                                                                                                                                                                                                 |
| `ANTHROPIC_API_KEY`      | if `anthropic`               | —       | Server-side only. Required when `LLM_PROVIDER=anthropic`.                                                                                                                                                                                                                                                                                                                                                 |
| `SENTRY_DSN`             | no                           | —       | Optional error reporting; empty means disabled. No account is required.                                                                                                                                                                                                                                                                                                                                   |
| `ORIGIN`                 | Node builds served over HTTP | —       | **Build time, not run time**: the public origin baked into an adapter-node build (`paths.origin` in `vite.config.ts`), e.g. `ORIGIN=http://localhost:4173 pnpm build:node`. Without it SvelteKit 3's adapter-node treats every request as `https://<host>`, which breaks the WebAuthn origin, CSRF checks and cookie flags on plain HTTP. Vercel builds ignore it (the platform reports the real origin). |
| `PORT`                   | adapter-node only            | `3000`  | Port of `node build/index.js`.                                                                                                                                                                                                                                                                                                                                                                            |

Test tooling (not read by the app):

| Variable             | Default                                            | Used by                                           |
| -------------------- | -------------------------------------------------- | ------------------------------------------------- |
| `TEST_DATABASE_URL`  | `postgres://coach:coach@localhost:5432/coach_test` | `pnpm test:integration`, `db:reset:test`          |
| `E2E_DATABASE_URL`   | `postgres://coach:coach@localhost:5432/coach_e2e`  | `pnpm test:e2e`, `pnpm lighthouse`                |
| `E2E_PORT`           | `4173`                                             | Playwright production server port                 |
| `E2E_SKIP_BUILD`     | unset                                              | `1` reuses an existing `build/`                   |
| `E2E_WEBKIT`         | unset                                              | `1` adds the WebKit project locally               |
| `E2E_PERF_ALONE`     | unset                                              | `1`: `--project=perf` runs only owner setup first |
| `E2E_SETUP_TOKEN`    | set by e2e global setup                            | this run's owner setup token (setup project)      |
| `LIGHTHOUSE_SESSION` | unset                                              | session cookie value for `pnpm lighthouse --url`  |
| `ADAPTER`            | `vercel`                                           | `node` builds with adapter-node                   |
| `PGADMIN_URL`        | unset                                              | `pnpm db:setup` admin connection (CI)             |

`EXPLAIN_DATABASE_URL` (default `postgres://coach:coach@localhost:5432/coach_explain`) is the
scratch database `pnpm db:explain` drops, migrates and fills with a two-year dataset on every run;
the reset refuses any name that does not end in `_test`, `_e2e` or `_explain`, so never point it
at the test or e2e database either. Local and CI only: never set it on Vercel, and never point it
at a database whose data matters (docs/development.md).

Vercel sets `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_REGION` and
`VERCEL_GIT_COMMIT_SHA` automatically; the app uses `VERCEL_ENV` for `appEnv`, `VERCEL_URL` /
`VERCEL_BRANCH_URL` to recognise a preview's own host as its WebAuthn relying party
(`src/lib/server/auth/relying-party.ts`), and the commit SHA for the version string
(`0.1.0+<sha7>`, also returned by `/api/health`). Production's relying party is fixed in code:
`https://coach.nikocruz.com`, RP ID `coach.nikocruz.com`.

## Per environment

| Environment   | Where it runs              | Database                              | Notes                                                            |
| ------------- | -------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `development` | `pnpm dev` (Vite)          | local `coach_dev`                     | `.env` is loaded into `process.env` by `vite.config.ts` in dev.  |
| `test`        | Vitest, Playwright, CI     | local/CI `coach_test`, `coach_e2e`    | Databases are dropped and re-migrated by the test setups.        |
| `preview`     | Vercel preview deployments | Neon branch per preview (recommended) | Same variables, preview-scoped in Vercel; never production data. |
| `production`  | Vercel production          | Neon main branch                      | `ENABLE_TEST_ROUTES` must be unset.                              |

## Where secrets live

- **Local:** `.env` (git-ignored). Never commit it.
- **Vercel:** Project → Settings → Environment Variables, scoped per environment
  (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `ANTHROPIC_API_KEY`, and `OWNER_SETUP_TOKEN_HASH`
  while first-run setup is pending). Exactly what Production and Preview need, and what must
  never be set there: docs/deployment.md → "Hosted environment variables". Auth needs no other secret: sessions and recovery codes
  are random values stored only as hashes in Postgres.
- **GitHub Actions:** only the nightly backup needs secrets (`DATABASE_URL_UNPOOLED`,
  `BACKUP_PASSPHRASE`); it skips until they exist. Deploys need none: they run through the Vercel
  Git integration (docs/deployment.md).
