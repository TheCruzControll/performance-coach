# Eval surfaces

An explorer's report on the code the eval PRs touch, recorded at `9719a3f5`. It read the source and ran the dry live suite once.

The existing live suite is a starting point for repeated coaching-quality evals. It drives real turns, but recorded-tool replay needs explicit matching and isolation rules.

## Live suite

- `turn()` calls `runTurn` with an injected provider, database, and clock, then collects events and run ids (`tests/live/coach.live.test.ts:128`).
- `seedLiveOwner()` creates equipment, a program, workout history, pain, preferences, and a goal (`tests/live/seed.ts:51`).
- Assertions inspect completed blocks, database state, and recorded calls, never exact wording (`coach.live.test.ts:192`, `:232`, `:300`, `:358`).
- `spent()` sums the owner's `agent_runs.cap_cost_micros` (`:166`). The $1 check runs before and after turns, so one turn can exceed the cap before the suite stops.
- An eval runner can reuse these helpers and fixtures, but it must isolate each sample's state and add up cost across all cases and samples.

## Vitest and the test database

- The `live` project has its own glob, a conditional global setup, serial files, and a 600-second test timeout (`vite.config.ts:239`).
- Setup resets and migrates `TEST_DATABASE_URL` only when enabled (`tests/live/setup.ts:1`, `tests/integration/global-setup.ts:7`). The default is `coach_test`. `pnpm db:setup` prepares local databases (`.env.example:11`).
- CI runs only the unit and integration projects. A config test checks that workflows never run `live` or unrestricted vitest (`scripts/vite-config.test.ts:71`). An `eval` project can follow the same pattern, with matching CI exclusion checks.

## Provider injection and tool replay

- Call `runTurn` directly with `provider` and optional `tools` (`src/lib/server/agent/turn.ts:110`). `runCoachTurn` resolves the environment-selected provider instead (`src/lib/server/agent/coach.ts:66`). Fault overrides target only the test mock (`src/lib/server/agent/provider/faults.ts:13`).
- Replay is feasible by keeping the tool definitions and replacing their `run` functions. `toolRuntime` supplies database dependencies and serial execution, not a service stub (`src/lib/server/services/coach/shared.ts:44`).
- The executor validates inputs and attaches each result to the new model's tool-use id (`src/lib/server/agent/tools/execute.ts:116`, `:194`).
- A replay must match calls by tool name and input, handle calls that differ or arrive in another order, and skip `_policy` rows.
- Stored failures keep an error code but not the original message, and outputs may be truncated (`src/lib/server/db/schema/agent-runs.ts:168`).
- Recorded owner-specific ids can conflict with a new owner's database, proposal state, and later calls. The turn context depends on the owner's date, zone, and program. Read-only replay does not reproduce stateful tool effects by itself.

## Structured output

`LlmProvider.structured()` accepts a Zod Mini schema and returns validated data, or null on an early stop (`src/lib/server/agent/provider/types.ts:72`). The Anthropic provider sends JSON-schema output and validates the JSON (`provider/anthropic.ts:109`). Drafts and summaries use it (`src/lib/server/agent/proposals/draft.ts:172`, `src/lib/server/agent/rollover.ts:152`). An LLM judge can reuse it but must handle null, errors, and its own cost. The provider fixes the model to `COACH_MODEL`.

## Deterministic checks

- `parseAnswer` returns labelled blocks and references (`src/lib/domain/coach/answer.ts:70`).
- `scanAdvice` detects banned phrases and diagnosis patterns. `detectPain` classifies the owner's report (`src/lib/domain/coach/safety.ts:262`, `:369`).
- `collectEvidence` and `checkGrounding` check citations and quantities for facts and metrics, not semantic truth (`src/lib/domain/coach/grounding.ts:95`, `:147`).
- `classifyExerciseStatement` tells a preference from a situation in the owner's message. It does not grade an answer (`src/lib/domain/coach/statements.ts:218`).
- The policy runs on the server (`src/lib/server/agent/policy.ts:164`). It replaces unsafe or ungrounded blocks and appends safety guidance in pain mode (`:357`). An eval can check the final safety block and record policy interventions separately.

## Dates and time

`loadTurnFacts` calls the injected `now()` and derives the local day from the owner's profile time zone (`src/lib/server/services/coach/turn-facts.ts:53`). The live suite fixes and advances that clock (`coach.live.test.ts:108`). Reproducible evals also need fixed profile and program data. Tool deadlines still use wall-clock time (`tools/execute.ts:121`).

## CI

`.github/workflows/ci.yml:76` and `:115` run unit and integration tests. Its `ANTHROPIC_API_KEY` is a literal canary for the bundle scan, not a secret reference (`:156`). The backup workflow runs nightly (`.github/workflows/backup.yml:8`). No scheduled eval workflow exists. `vercel.json` has one cron, `/api/cron/backup` daily.

## Dry run of the live suite

Postgres accepted a connection to `coach_test`. With Node 22 and both vitest caches disabled, `LIVE_LLM_DRY=1 pnpm test:live` passed 7 tests and skipped 1 live-only test in 15.55 s. The suite reset the disposable test database. No live model calls were made, so coaching quality and replay behaviour stay unverified.
