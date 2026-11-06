# Development guide

## Prerequisites

- **Node.js 22** (≥ 22.19; `.nvmrc`) and **pnpm 10** (`packageManager` in `package.json`;
  `corepack enable` picks the right version).
- **PostgreSQL 16** running locally (`pg_ctlcluster 16 main start` on Debian/Ubuntu).
- For e2e: Playwright browsers. Locally this repo pins `@playwright/test` **1.63.0** to match the
  preinstalled Chromium build; on a fresh machine run `pnpm exec playwright install chromium`.

## First run

```sh
pnpm install            # also runs `svelte-kit sync`
cp .env.example .env    # local defaults work as-is
pnpm db:setup           # creates role `coach` and databases coach_dev / coach_test / coach_e2e (idempotent)
pnpm db:migrate         # applies drizzle/*.sql to coach_dev
pnpm dev                # http://localhost:5173
```

`pnpm db:setup` connects as the local `postgres` superuser via peer auth (or uses
`PGADMIN_URL`/`PG*` variables when set), creates the `coach` login role and the three databases.
Re-running it is safe.

## Signing in locally

Every screen needs a session (deny by default). On a fresh `coach_dev` database:

```sh
pnpm auth:setup-token --origin http://localhost:5173   # prints a token, its hash and the link
# put OWNER_SETUP_TOKEN_HASH=<hash> in .env, restart `pnpm dev`, open the printed /setup link
```

Create the passkey (Touch ID, Windows Hello, a phone via QR, or Chrome DevTools → More tools →
WebAuthn → "Enable virtual authenticator environment"), save the recovery codes, done. Passkeys
work on `http://localhost` (a secure context) but not on `127.0.0.1`. To start over:
`pnpm auth:reset-owner --confirm` (keeps the owner's data, reopens setup), then a new
`pnpm auth:setup-token` (a token works for one setup).

`pnpm start` serves a Node build: build it with the origin it will be served on, e.g.
`ORIGIN=http://localhost:4173 pnpm build:node && PORT=4173 pnpm start` (docs/environment.md).

## Everyday commands

| Command                 | What it does                                                                  |
| ----------------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`              | Vite dev server with HMR                                                      |
| `pnpm check`            | `svelte-kit sync` + `svelte-check` (fails on warnings) + service-worker `tsc` |
| `pnpm lint`             | Prettier check + ESLint (including import boundaries)                         |
| `pnpm format`           | Prettier write                                                                |
| `pnpm test:unit`        | Vitest unit project (`src/**/*.test.ts`)                                      |
| `pnpm test:integration` | Vitest integration project against `coach_test`                               |
| `pnpm test:e2e`         | Playwright against the production Node build                                  |
| `pnpm test`             | all three test suites                                                         |
| `pnpm build`            | production build for Vercel (`.vercel/output`)                                |
| `pnpm build:node`       | production build for Node (`build/`), used by e2e/Lighthouse                  |
| `pnpm start`            | run `build/index.js` with `.env` (set `ORIGIN`/`PORT` as needed)              |
| `pnpm budgets`          | enforce JS/CSS/font budgets on the last build                                 |
| `pnpm lighthouse`       | Lighthouse mobile against a local production server                           |
| `pnpm db:generate`      | generate a SQL migration from schema changes                                  |
| `pnpm db:migrate`       | apply migrations (`DATABASE_URL_UNPOOLED` → `DATABASE_URL` → local dev)       |
| `pnpm db:reset:test`    | drop + re-migrate `coach_test` (guarded: only `_test`/`_e2e` names)           |
| `pnpm db:studio`        | Drizzle Studio                                                                |
| `pnpm icons`            | re-render PNG icons from `static/icons/*.svg`                                 |

## Conventions

- **Imports:** use `#lib/...` subpath imports with explicit extensions
  (`#lib/server/env.ts`, `#lib/client/preferences.svelte.ts`, components by `.svelte` file).
  Inside a layer, relative imports are fine. Respect the layer rules
  (docs/architecture.md#module-boundaries); ESLint enforces them.
- **Routes** stay thin: parse input, call a service, shape the response. Never import
  `#lib/server/db` from a route.
- **Links** use `resolve()` from `$app/paths` with route ids (`resolve('/(app)/today')`) — typed
  and checked by `svelte-check`.
- **TypeScript:** `strict`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly` (scripts run with
  Node's native type stripping: no enums, no parameter properties).
- **Styling:** tokens only (no hard-coded colors outside `tokens.css`, except physical-object
  palettes like plate colours); scoped component styles; touch targets ≥ 44 px.
- **Hydration cost matters:** avoid constructing `Intl` formatters or heavy work during hydration
  on hot routes; load interaction-only UI on intent (see the plate calculator).
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `perf:`,
  `refactor:`, `ci:`), small and logical.

## Database changes

1. Edit the schema in `src/lib/server/db/schema/`.
2. `pnpm db:generate --name <change>` → review the SQL in `drizzle/` (it is what production runs).
3. `pnpm db:migrate` locally; `pnpm test:integration` (recreates `coach_test` from all migrations).
4. Commit schema + SQL + `drizzle/meta`. Keep changes backward compatible with the deployed code
   (expand → migrate data → contract in a later release).

**Guards and triggers** (ADR 0010) go in a custom migration, never in a generated file, which a
regenerate would overwrite: `pnpm drizzle-kit generate --custom --name <guards>` adds an empty
SQL file to the journal; write the SQL there.

**After a rebase onto a newer migration** (another branch merged one first):

1. Copy your custom migrations' SQL somewhere safe.
2. Delete your generated SQL files and their `drizzle/meta/<n>_snapshot.json`, and take the base
   branch's `drizzle/meta/_journal.json` (`git checkout <base> -- drizzle/meta/_journal.json`).
3. Re-run `pnpm db:generate --name <change>`. For each custom migration, in its original order,
   run `pnpm drizzle-kit generate --custom --name <guards>` and re-paste its SQL.
4. `pnpm db:drift`, `pnpm test:unit` (`scripts/drizzle-journal.test.ts` checks the journal is in
   order) and `pnpm test:integration`.

Never hand-edit the journal or a snapshot.

## Troubleshooting

- **`Invalid environment configuration`** at startup: the message lists each bad variable.
- **Integration tests cannot connect**: start Postgres and run `pnpm db:setup`.
- **`something is already serving http://localhost:4173`** in e2e: stop the other server or set
  `E2E_PORT`.
- **"Cross-site request refused" from a local Node build**: it was built without (or with a
  different) `ORIGIN`; rebuild with `ORIGIN=http://localhost:<port> pnpm build:node`.
- **Every page redirects to `/`**: no session. Sign in, or set up the owner (above).
