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

| Variable                | Required             | Default | Purpose                                                                                         |
| ----------------------- | -------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | **yes**              | —       | Pooled Postgres URL for app traffic. Neon: the `-pooler` host. Must start `postgres(ql)://`.    |
| `DATABASE_URL_UNPOOLED` | migrations / backups | —       | Direct (non-pooled) URL. Used by `pnpm db:migrate`, deploy migrations and `pg_dump`.            |
| `APP_ENV`               | no                   | derived | `development` · `test` · `preview` · `production`. Falls back to `VERCEL_ENV`, then `NODE_ENV`. |
| `DB_POOL_MAX`           | no                   | `5`     | Max pg clients per server instance (1–50). Keep small behind Neon's pooler.                     |
| `DB_QUERY_TIMEOUT_MS`   | no                   | `10000` | Client-side per-query timeout (pooler-safe; no session `SET`).                                  |
| `LOG_LEVEL`             | no                   | `info`  | `debug` · `info` · `warn` · `error` · `silent` (tests default to `warn`).                       |
| `ENABLE_TEST_ROUTES`    | no                   | `false` | Enables `/api/test-support/*` for automated tests. **Rejected when `APP_ENV=production`.**      |
| `LLM_PROVIDER`          | no                   | `mock`  | Coach model provider (M5): `mock` (deterministic, no key) or `anthropic`.                       |
| `ANTHROPIC_API_KEY`     | if `anthropic`       | —       | Server-side only. Required when `LLM_PROVIDER=anthropic`.                                       |
| `SENTRY_DSN`            | no                   | —       | Optional error reporting; empty means disabled. No account is required.                         |
| `ORIGIN`                | adapter-node only    | —       | Public origin for the local production server (CSRF checks), e.g. `http://localhost:4173`.      |
| `PORT`                  | adapter-node only    | `3000`  | Port of `node build/index.js`.                                                                  |

Test tooling (not read by the app):

| Variable            | Default                                            | Used by                                  |
| ------------------- | -------------------------------------------------- | ---------------------------------------- |
| `TEST_DATABASE_URL` | `postgres://coach:coach@localhost:5432/coach_test` | `pnpm test:integration`, `db:reset:test` |
| `E2E_DATABASE_URL`  | `postgres://coach:coach@localhost:5432/coach_e2e`  | `pnpm test:e2e`, `pnpm lighthouse`       |
| `E2E_PORT`          | `4173`                                             | Playwright production server port        |
| `E2E_SKIP_BUILD`    | unset                                              | `1` reuses an existing `build/`          |
| `E2E_WEBKIT`        | unset                                              | `1` adds the WebKit project locally      |
| `ADAPTER`           | `vercel`                                           | `node` builds with adapter-node          |
| `PGADMIN_URL`       | unset                                              | `pnpm db:setup` admin connection (CI)    |

Vercel sets `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_REGION` and `VERCEL_GIT_COMMIT_SHA`
automatically; the app uses `VERCEL_ENV` for `appEnv` and the commit SHA for the version string
(`0.1.0+<sha7>`, also returned by `/api/health`).

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
  (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, later `ANTHROPIC_API_KEY`, auth secrets).
- **GitHub Actions:** repository/environment secrets for deploy and backup
  (`DATABASE_URL_UNPOOLED`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`,
  `BACKUP_PASSPHRASE`) — see docs/deployment.md.
