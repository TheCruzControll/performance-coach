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
pnpm db:setup           # creates role `coach` and databases coach_dev / coach_test / coach_e2e / coach_explain (idempotent)
pnpm db:migrate         # applies drizzle/*.sql to coach_dev
pnpm dev                # http://localhost:5173
```

`pnpm db:setup` connects as the local `postgres` superuser via peer auth (or uses
`PGADMIN_URL`/`PG*` variables when set), creates the `coach` login role and the four databases.
Re-running it is safe.

## Signing in locally

Every screen needs a session (deny by default). On a fresh `coach_dev` database:

```sh
pnpm auth:setup-token --origin http://localhost:5173   # prints a token, its hash and the link
# put OWNER_SETUP_TOKEN_HASH=<hash> in .env, restart `pnpm dev`, open the printed /setup link
```

Create the passkey (Touch ID, Windows Hello, a phone via QR, or Chrome DevTools → More tools →
WebAuthn → "Enable virtual authenticator environment"), save the recovery codes, done. Passkeys
work on `http://localhost` (a secure context) but not on `127.0.0.1`. To start over, name the
database (there is no default, and `.env` is not read):
`DATABASE_URL_UNPOOLED=postgres://coach:coach@localhost:5432/coach_dev pnpm auth:reset-owner --confirm`
(keeps the owner's data, reopens setup), then a new `pnpm auth:setup-token` (a token works for
one setup).

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
| `pnpm test:live`        | the live coach suite (opt-in, billed, never in CI): see below                 |
| `pnpm build`            | production build for Vercel (`.vercel/output`)                                |
| `pnpm build:node`       | production build for Node (`build/`), used by e2e/Lighthouse                  |
| `pnpm start`            | run `build/index.js` with `.env` (set `ORIGIN`/`PORT` as needed)              |
| `pnpm budgets`          | enforce JS/CSS/font budgets on the last build                                 |
| `pnpm lighthouse`       | Lighthouse mobile against a local production server                           |
| `pnpm db:generate`      | generate a SQL migration from schema changes                                  |
| `pnpm db:migrate`       | apply migrations (`DATABASE_URL_UNPOOLED` → `DATABASE_URL` → local dev)       |
| `pnpm db:reset:test`    | drop + re-migrate `coach_test` (guarded: only `_test`/`_e2e` names)           |
| `pnpm db:studio`        | Drizzle Studio                                                                |
| `pnpm db:explain`       | query plans on a two-year dataset in `coach_explain`, gated (see below)       |
| `pnpm icons`            | re-render PNG icons from `static/icons/*.svg`                                 |
| `pnpm icons:sprite`     | regenerate the icon sprite and names from `src/lib/ui/icons/icons.ts`         |

### The live coach suite (`pnpm test:live`)

Six conversations against the real model (`tests/live/`), asserting properties, never wording;
it fails past `LIVE_COST_CAP_MICROS` ($1). It never runs in CI. Prerequisites:

1. A running local Postgres, and `pnpm db:setup` run once.
2. It uses `TEST_DATABASE_URL` (default `coach_test`), which it drops and re-migrates; a name not
   ending in `_test` is refused.
3. A key of your own, never the production key:

```sh
LIVE_LLM=1 ANTHROPIC_API_KEY=<key> pnpm test:live
LIVE_LLM_DRY=1 pnpm test:live   # the same conversations on the mock, free
```

With neither flag every test is skipped and no database is touched.

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

## Query plans (`pnpm db:explain`)

`pnpm db:explain` (the Vitest project `explain`, `scripts/explain/`) proves the history and
program queries use their indexes on realistic data. CI runs it after the integration tests. It:

1. drops and re-migrates `EXPLAIN_DATABASE_URL` (default local `coach_explain`; the reset refuses
   a name that does not end in `_test`, `_e2e` or `_explain`, so it would wipe a test database
   too: give it its own), which seeds the exercise catalogue;
2. loads one owner's deterministic two-year dataset (`dataset.ts`, from a fixed seed): ~620
   strength workouts with ~16k sets over 40 exercises, ~400 runs with ~6k segments, Muay Thai and
   mobility, recovery notes, and eight 13-week programs with 4–26 copy-on-write versions each,
   plus the owner's audited edits and soft deletes; then `ANALYZE`;
3. runs `EXPLAIN (ANALYZE, BUFFERS)` on every builder in `src/lib/server/db/queries/` with the
   parameters its service passes, prints each plan and writes `test-results/explain.md` (CI keeps
   it as the `explain-<run>` artifact).

**Reading it.** A relation is _large_ when `pg_class` says it has ≥ 5,000 rows or ≥ 50 pages
(`LARGE_TUPLES`, `LARGE_PAGES` in `plan-check.ts`), _small_ otherwise. On a large relation a plan
fails if it has a `Seq Scan` anywhere (under joins, in an InitPlan) or does not use each index the
builder declares (`HISTORY_INDEXES` in `queries/history.ts`; the program builders' lists in
`history.explain.ts`). Small relations' plans are recorded, never gated: at one owner's scale a
sequential scan of `workouts` or `exercises` is the right plan. The report's first table gives each
relation's rows, pages and class, the second each query's scans (large relations in bold), rows,
execution and planning time, shared buffers (hit/read) and the gate's verdict; then every plan
follows, node by node, with its actual rows, loops, time and buffers. Timings are recorded, never
asserted: they vary by machine, and CI's Postgres may cost the same plan differently from Neon's.

**When it fails**, the message names the scan or the missing index. Fix the builder or add an
index (a migration, newest in the journal), and record the plan before and after in the PR.

## Troubleshooting

- **`Invalid environment configuration`** at startup: the message lists each bad variable.
- **Integration tests cannot connect**: start Postgres and run `pnpm db:setup`.
- **`something is already serving http://localhost:4173`** in e2e: stop the other server or set
  `E2E_PORT`.
- **"Cross-site request refused" from a local Node build**: it was built without (or with a
  different) `ORIGIN`; rebuild with `ORIGIN=http://localhost:<port> pnpm build:node`.
- **Every page redirects to `/`**: no session. Sign in, or set up the owner (above).
