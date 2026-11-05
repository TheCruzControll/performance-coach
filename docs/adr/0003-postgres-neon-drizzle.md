# 0003 — PostgreSQL on Neon, Drizzle ORM, node-postgres pool

- **Status:** Accepted (M1)
- **Context:** Training data is relational and historical (programs, cycles, workouts, sets,
  decisions with rationale), needs migrations, indexes, backups and point-in-time recovery.

## Decision

- **PostgreSQL** (16+). Production: **Neon Lakebase Postgres** (branching for previews, PITR,
  scale-to-zero). Development/test: **local Postgres 16+**; CI: a **Postgres 18** service container, matching Neon production.
- **Drizzle ORM** for a typed schema and queries; **drizzle-kit** generates SQL migrations that
  are **reviewed and committed** (`drizzle/`); `scripts/db-migrate.ts` applies them under a
  Postgres advisory lock over the **direct** (`DATABASE_URL_UNPOOLED`) connection.
- Driver: **node-postgres `Pool`** with a small `max` (default 5), `attachDatabasePool()` from
  `@vercel/functions` on Vercel, pooled `DATABASE_URL` (Neon PgBouncer) for app traffic.
  Per-query timeouts are client-side (`query_timeout`) because session `SET`s are unsafe through
  a transaction-mode pooler.
- `neon.ts` (`@neon/config`) declares Postgres only and a cheap policy for new dev/preview
  branches, so `neon deploy` can manage it once the owner links the project.

## Alternatives considered

| Option                            | Why not                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| SQLite / Turso / D1               | Fine for one user, but weaker for analytics (window functions, percentiles) and PITR. |
| Supabase                          | Bundles auth/storage/realtime we don't need; Neon branching fits preview deploys.     |
| Prisma                            | Heavier runtime/engine, slower cold starts; Drizzle is SQL-first and lighter.         |
| Kysely / raw SQL                  | Good, but Drizzle adds schema-as-code + migration generation in one tool.             |
| `@neondatabase/serverless` (HTTP) | Best for edge runtimes; on Node/Fluid compute a reused TCP pool has lower latency.    |

## Consequences

- One SQL dialect across environments; integration tests hit a real database.
- Migrations must be backward compatible with the running version (expand → migrate → contract)
  because they are applied before the new code is live.
- Neon-specific features (branch per PR, PITR) are optional conveniences, not dependencies.
