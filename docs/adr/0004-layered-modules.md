# 0004 — Layered modules with lint-enforced import boundaries

- **Status:** Accepted (M1)
- **Context:** PRD §4/§20 require clear separation of frontend, backend, database and agent
  logic, and that core workout logging never depends on the agent (§15).

## Decision

Organise `src/lib` by layer — `domain/` (pure math), `server/db/`, `server/services/`,
`server/agent/`, `server/auth/`, `client/`, `ui/` — and enforce allowed dependencies with ESLint
`no-restricted-imports` patterns per folder (see the table in docs/architecture.md). Patterns match
both `#lib/...` and relative paths, so a boundary cannot be bypassed with `../../`.

## Alternatives considered

- **Separate packages in a monorepo** (pnpm workspaces): strongest isolation, but more build
  config, versioning and slower iteration for a single app.
- **eslint-plugin-boundaries**: richer element typing; heavier config and another dependency.
  Built-in `no-restricted-imports` is enough for nine folders.
- **Convention only**: erodes under deadline pressure; violations would surface late.

## Consequences

- `pnpm lint` fails fast on a layering violation with a message that names the right layer.
- The agent's tools are adapters over services, never raw SQL.
- The domain layer stays isomorphic, so the same math runs offline in the browser (M4) and in
  agent tools (M5).
