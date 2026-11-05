# `src/lib/server/agent` — AI performance coach (scaffold)

Milestone 5 builds the coach here. M1 only reserves the folder and its boundaries; the full
design is in [`docs/agent-architecture.md`](../../../../docs/agent-architecture.md).

## Boundaries (enforced by ESLint)

- The agent **calls application services** (`src/lib/server/services`) — the same use-cases
  the UI routes call. It never imports the database layer directly.
- Services never import the agent. Core workout logging never depends on the agent (PRD §15).
- No UI or browser code here; LLM credentials never leave the server.

## Planned layout

```
agent/
  provider/          LlmProvider interface + implementations
    types.ts         messages, tool calls, structured output contracts
    anthropic.ts     production provider (server-side API key)
    mock.ts          deterministic provider for tests and keyless development
  tools/             one file per tool: zod input schema → service call → typed result
  memory/            structured coaching memory (goals, decisions + rationale, preferences)
  orchestrator.ts    tool loop, budgets (steps/tokens/time), tracing
  proposals.ts       recommendations are proposals until the owner commits them
```

The provider is selected by `LLM_PROVIDER` (`mock` by default; `anthropic` requires
`ANTHROPIC_API_KEY`), validated in `src/lib/server/env.ts`.
