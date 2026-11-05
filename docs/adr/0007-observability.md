# 0007 — Built-in observability: Server-Timing, JSON logs, errors table, RUM

- **Status:** Accepted (M1)
- **Context:** Performance claims must be backed by measurements (PRD §15); errors must be
  visible; no paid accounts can be assumed.

## Decision

- `hooks.server.ts` adds `Server-Timing` (`db`, `total`) and `x-request-id` to every dynamic
  response and logs one structured JSON line per request.
- Per-request timings and the request id travel in `AsyncLocalStorage`; services wrap database
  work in `measure('db', …)`.
- `handleError` logs unexpected errors (with request id) and inserts them into `app_errors`; it
  never throws, even if the database is down. Errors are serialized log-safe first
  (`serializeError`): query parameter values are redacted, and a Postgres error keeps its
  SQLSTATE, routine and identifier fields but not a message that can quote a value (class 22
  data exceptions and any class not known to be identifier-only); DETAIL/HINT are never kept.
- Client RUM: `web-vitals` (lazy-loaded) beacons LCP/INP/CLS/TTFB/FCP to `POST /api/vitals`
  (validated, de-duplicated by metric id) → `web_vitals`; p75 shown on the Profile screen.
- Sentry is optional later (`SENTRY_DSN`), never required.

## Alternatives considered

- **Sentry/Datadog from day one**: excellent tooling, but needs accounts and adds client JS.
- **OpenTelemetry tracing** (SvelteKit `tracing.server`): heavier setup and a collector; revisit
  when there are background jobs and agent traces worth correlating (M5).
- **Vercel Speed Insights/Analytics**: vendor-specific, sampled; our own table keeps raw data
  queryable next to training data.

## Consequences

- Zero external dependencies for core observability; data stays in our Postgres.
- Log retention depends on Vercel's plan; `app_errors` provides durable incident history.
