# `src/lib/server/agent` — AI performance coach

Milestone 5 builds the coach here, one slice at a time. The design is in
[`docs/agent-architecture.md`](../../../../docs/agent-architecture.md) and two ADRs, "the coach
agent loop" (0013) and "the coach memory and proposals" (0014).

## Boundaries (enforced by ESLint)

- The agent **calls application services** (`src/lib/server/services`) — the same use-cases
  the UI routes call. It never imports the database layer directly, not even its types; it learns
  whether tools must run one at a time from `ToolContext.serialTools`.
- Services never import the agent. Core workout logging never depends on the agent (PRD §15).
- No UI or browser code here; LLM credentials never leave the server. `@anthropic-ai/*` is imported
  at runtime only by `provider/anthropic.ts`, by a dynamic import.

## The contract it shares

The coach's pure contract lives in `src/lib/domain/coach/`. Its client-safe parts (vocabulary,
stream events and the SSE codec, source refs, the rich-text tree, the memory snapshot, the tool
catalogue, activity wording, pricing and budgets) are exported by `index.ts`; the answer parser
and the other server-only modules are imported by path.

## Layout

The planned layout; each M5 slice adds its own files.

```
agent/
  coach.ts           composition root: resolves the provider, coachStatus(), runCoachTurn()
  launch.ts          COACH_LAUNCHED: false until coach-launch flips it
  turn.ts            one turn: owner message in, CoachEvents out, every step persisted
  orchestrator.ts    the manual loop: stop reasons, budgets, deadlines, cancellation
  hooks.ts           TurnHooks: what the loop tells the turn (text, chips, calls, steps), no-op defaults
  policy.ts          the output gate: unsafe pain advice and ungrounded facts never reach the wire
  direct.ts          unambiguous lookups answered without a model call
  rollover.ts        a segment becomes a summary note; the next opens with a new snapshot
  memory/load.ts     the memory snapshot that opens each segment
  prompt/            system.ts (frozen), context.ts (turn facts), layout.ts (cache-stable order)
  provider/          types.ts (LlmProvider), validate.ts (the API's rules), mock.ts and
                     mock-scripts/, faults.ts, select.ts, anthropic.ts (the only SDK import)
  tools/             schema.ts, define.ts, context.ts, output.ts, execute.ts, registry.ts and
                     one file per tool group
  proposals/         draft.ts: structured-output drafts for program, workout and cycle proposals
```

The provider is selected by `LLM_PROVIDER` (`mock` by default; `anthropic` requires
`ANTHROPIC_API_KEY`), validated in `src/lib/server/env.ts`.
