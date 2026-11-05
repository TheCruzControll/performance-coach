# 0008 — Testing strategy

- **Status:** Accepted (M1)
- **Context:** PRD §19 prioritises end-to-end browser tests, then integration tests, then
  business-logic unit tests; tests must run against an isolated database and the LLM must be
  mockable.

## Decision

- **Playwright 1.63.0** e2e against the **production Node build** with an iPhone 15 Pro viewport
  (Chromium locally; Chromium + WebKit in CI). Global setup resets a dedicated `coach_e2e`
  database, builds, starts `node build/index.js`, waits for `/api/health`.
- **Vitest** projects: `unit` (pure modules, e.g. `src/lib/domain`) and `integration` (services
  and repositories against a real Postgres `coach_test` database; migrations applied in global
  setup; each test in a rolled-back transaction).
- Performance as tests: budget script + asserted Lighthouse in CI.
- LLM: deterministic mock provider by default (ADR 0009); real-provider tests opt-in.

## Alternatives considered

- **Mocking the database** (pg-mem, in-memory fakes): faster, but misses SQL/constraint/index
  behaviour — exactly what integration tests must catch.
- **Testcontainers**: great isolation; adds Docker as a dev requirement. Local Postgres + CI
  service containers are simpler here.
- **Cypress**: no WebKit; Playwright covers the iOS engine.

## Consequences

- Tests need Postgres locally (`pnpm db:setup`); documented in docs/testing.md.
- WebKit runs only in CI (the local environment ships Chromium only).
