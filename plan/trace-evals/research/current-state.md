# What exists on main for the coach

Recorded at `9719a3f5`. Re-check every pointer against current `main` before building.

## The agent is built but not launched

- `src/lib/server/agent/launch.ts` sets `COACH_LAUNCHED = false`, so production reports the coach unavailable. Development, tests, and previews ignore the switch.
- `provider/select.ts` picks the provider from `LLM_PROVIDER` (`mock`, `anthropic`, or `off`) and `ANTHROPIC_API_KEY`. Production uses `anthropic` once launched. Elsewhere the default is `mock`.
- `provider/anthropic.ts` is the only runtime import of `@anthropic-ai/sdk`, loaded by a dynamic import. The model is `claude-opus-5-5`.
- `coach.ts` is the composition root. `POST /api/coach/turns` and the coach screen call only `coach.ts`.

## One turn, in order

From the header comment of `src/lib/server/agent/turn.ts`.

1. A coach that is off or not launched refuses the turn before anything is written.
2. The day's facts load from `services/coach/turn-facts.ts`: date, time zone, active program version, and week.
3. If the prompt version changed or the segment grew past `SEGMENT` (60,000 input tokens or 40 messages), `rollover.ts` summarises the old segment into a note and a new segment starts with a fresh memory snapshot.
4. An `agent_runs` row starts. A second live run on the same thread makes the turn busy.
5. A plain lookup such as "what's today's workout" is answered by `direct.ts` with no model call.
6. Otherwise `runLoop` in `orchestrator.ts` runs model calls and tool steps. Each model call and each step is stored as it ends.
7. Answer text goes through the answer parser and `policy.ts`, the output gate, before it reaches the phone as server-sent events.
8. The run gets its final status. `done` is always the last event.

## Budgets

From `src/lib/domain/coach/budgets.ts`. `COACH_MAX_DURATION_S` is 180. A turn gets about 150 s, 8 chat calls, 2 drafts, 300,000 input tokens, and 40,000 output tokens. Tools run 3 at a time, or 1 at a time inside a transaction, and each tool output is capped at 8 KB. `DAILY_COST_CAP_USD` is 5.

## Where the coach gets data

- The memory snapshot, built from records and never from replayed chat, opens each segment (`services/coach/memory.ts`, `memory-records.ts`). It holds goals, the active program, the last 14 days of training (`RECENT_DAYS`), strength baselines, preferences, equipment, active injuries, the last 28 days of pain reports, recovery notes, and decided proposals (`MEMORY_RECORD_DAYS`), the 8 newest decisions, the 3 newest thread summaries, and 3 workout analyses (`MEMORY_RECORD_LIMITS`).
- The turn context adds the date, today's sessions, the program week, and pain mode on every turn.
- 24 tools read everything else through the same services the screens use. `get_training_history` takes any start date but covers at most 28 days per call (`TRAINING_HISTORY_DAYS`). `get_running_history` covers at most 12 weeks. `get_recent_workouts` and `get_exercise_history` page backwards. `get_personal_records` returns the full PR timeline.
- No tool searches past conversations. Chat survives only as a summary note or as a record it created, such as a stated dislike, a goal, or an accepted proposal.
- The model's lifting knowledge comes from Anthropic's pretraining. The repo has no knowledge base, retrieval, or fine-tuning. Numbers come from `src/lib/domain` through analytics tools, and the system prompt forbids the model from calculating a metric itself.

## Tracing today

- `src/lib/server/db/schema/agent-runs.ts` defines `agent_runs` (one per turn), `agent_model_calls` (one per call, with request id, stop reason, tokens, cost, time to first token, latency, and error), and `agent_tool_calls` (one per tool call, with input, output capped at 16 KB, status, error code, truncated flag, proposal id, and duration). Policy interventions are stored in `agent_tool_calls` with the name `_policy`. These rows are insert-only, and the database refuses deletes.
- `coach_messages` in `schema/coach.ts` stores each message exactly as sent to or returned by the model, with `run_id` on the rows a run writes.
- `GET /api/coach/runs` and `UsageSheet.svelte` list runs with totals. Nothing opens one run into its steps. That gap is the `trace` PR.
- `orchestrator.ts` logs one `coach model call` line per call with ids and counts, never text.
- No outside platform is installed. `package.json` has no OpenTelemetry, Sentry, or Langfuse. ADR 0007 kept observability in Postgres and deferred OpenTelemetry to the coach milestone.

## Tests and evals today

- `tests/live/coach.live.test.ts` is the only real-model eval. It runs six conversations on a seeded owner: grounding and caching, proposal and rejection, preferences, pain, refusal, and prompt injection. It checks properties, not wording. It is opt-in with `LIVE_LLM=1 ANTHROPIC_API_KEY=... pnpm test:live`, never runs in CI, and fails over $1 (`LIVE_COST_CAP_MICROS` in `tests/live/gate.ts`). `LIVE_LLM_DRY=1` plays the same conversations on the mock. No record shows it ever ran against the real model.
- `tests/integration/coach/` has 28 test files on the mock against a real test database: turns, the turns endpoint, each tool group, policy, memory, summaries, proposals, and runs.
- Unit tests cover the loop, prompt layout, request validation, the mock, and `src/lib/domain/coach/*.test.ts`.
- 11 Playwright files under `e2e/` drive the coach screen on the mock.
- Nothing grades coaching quality, nothing runs a case more than once, and nothing tracks results per `PROMPT_VERSION`.
- No answer rating exists in the UI or the schema. Retry exists only for failed or interrupted answers.
