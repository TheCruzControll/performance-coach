# 0013 — Coach agent loop: a manual loop over LlmProvider, streamed as labelled blocks

- **Status:** Accepted (M5, 2026-11-11). Implemented as decided below and switched on in
  production by coach-launch (#449); docs/agent-architecture.md describes the code. Measured: the
  limits at 180 s are a 150 s turn, 75 s drafts, 10 s tools and 85 s drafting tools
  (`src/lib/domain/coach/budgets.ts`), and `/(app)/coach/[[thread]]` loads 58.0 KB of initial JS
  against the 60 KB gate (CI run 42939723798, docs/performance.md). The launch went ahead on the
  owner's written go-ahead (2026-11-10) without a live run, so live latency, cache reads and label
  compliance are not yet measured; structured output on chat turns stays the unused fallback until
  a live run (`pnpm test:live`) shows it is needed.
- **Context:** The coach answers with the owner's real data through tools over the same services
  the screens use (PRD §4, §12), on a Vercel function with Fluid compute. Every path must run
  offline and deterministically with the mock provider (ADR 0009). Each step must be stored byte
  for byte, because Claude Opus 5.5 ties thinking blocks to the conversation that produced them
  and invalidates them when earlier history changes. A Stop button and a dropped connection must
  end a turn between steps. No answer text may reach the phone before the output policy has
  checked it for unsafe pain advice and ungrounded facts. A transaction runs one query at a time
  (#62), so tools that share one must run serially.

## Decision

- **A manual loop.** `src/lib/server/agent/orchestrator.ts` drives `LlmProvider.stream()`, and
  the MockProvider drives the identical loop. Each step streams, takes the final message, and
  reads `stop_reason` before any content: `refusal` runs no tool; `max_tokens` never runs a
  truncated `tool_use` (it is re-issued once with more room); `pause_turn` continues. The step's
  `tool_use` blocks run with per-tool deadlines, three at a time on the pool or one at a time on
  a transaction, and all their `tool_result`s go back in one user message, with `is_error` on
  failures. An assistant `tool_use` is stored only together with all of its results.
- **The request**, from the claude-api skill (SDK 1.x, API version 2026-10-21): model
  `claude-opus-5-5`; `thinking` omitted, since it is always adaptive; `output_config.effort` always
  explicit (medium for chat, high for drafts, low for summaries); `tool_choice` omitted (auto),
  with the prompt steering; every tool closed and `eager_input_streaming`, and each parsed input
  validated with zod before it runs; `strict` on the tools that propose or write (amended
  2026-11-13: all 24 strict broke the API's per-request strict-schema caps, so every turn was a
  400; reads and `update_training_goals` are not strict); no prefill and no sampling parameter; and
  server-side refusal fallbacks (`fallbacks: 'default'`), where a fallback block resets the visible
  answer and `usage.iterations` prices each attempt at its own model's rates.
- **Limits from one constant.** `COACH_MAX_DURATION_S` sets the endpoint's maxDuration, and the
  turn, draft, tool and stale-run times derive from it. A turn makes at most 8 chat calls and 2
  drafts, within token ceilings, under one AbortSignal that joins the request's signal, the turn
  deadline and the cancel flag stored in Postgres. A daily cost cap counts every call.
- **A closed stream.** The model writes a tagged grammar: a lead, then `[fact]`,
  `[metric method=…]`, `[recommendation]`, `[safety]` or `[note]` blocks with inline refs
  `[[type:id|label]]` (`src/lib/domain/coach/answer.ts`). The server parses it incrementally, with
  output that does not depend on chunking, checks each block, and sends the closed `CoachEvent`
  set over SSE (`src/lib/domain/coach/events.ts`). The browser never parses markdown or model
  JSON; it renders a rich-text tree as elements, and a source opens only an app path.
- **A cache-stable prompt.** Tools sorted by name, then one frozen system prompt with
  `cache_control`, then a segment preamble holding the memory snapshot as data, the stored
  transcript, and after each owner message a mid-conversation system message of server-computed
  facts (date, today's sessions, the current week). Never more than 4 breakpoints.

## Alternatives considered

| Option                               | Why not                                                                                                                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The SDK's Tool Runner                | It runs on the SDK client, so the mock could not drive the same loop. Atomic per-step storage, the stored cancel flag, transaction-aware concurrency and the output gate would all sit in hooks around a beta helper, interleaved with streaming. |
| Managed Agents                       | Anthropic would run the loop and host the tools; ours must run beside Postgres, owner-scoped, in our function.                                                                                                                                    |
| Structured output on every chat turn | Kept as the fallback if the live suite shows poor label compliance; the grammar streams text sooner.                                                                                                                                              |
| Message threads, server compaction   | The stored transcript is replayed as is; long threads become structured summaries at segment boundaries, never edited history.                                                                                                                    |
| Markdown rendered in the browser     | A parser in client JavaScript, and an HTML path for injected markup.                                                                                                                                                                              |

## Consequences

- We own stop-reason handling, `pause_turn`, the re-issue of invalid tool JSON (at most twice)
  and the budgets; the mock rejects any request the 2026-10-21 API would reject, so tests prove
  them offline.
- The SDK is imported at runtime only by the Anthropic provider, so an SDK change touches one
  file, and `pnpm budgets` keeps it out of client output.
- The grammar and the events only grow: new optional fields and new event types, which the
  decoder skips until a client renders them.
