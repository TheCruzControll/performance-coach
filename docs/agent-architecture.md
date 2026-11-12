# AI coach: agent architecture

How the coach works, as built in Milestone 5 and switched on in production by coach-launch, with
what Milestone 6 added: analytics on M6's engine, review write-ups and review proposals (see
[Reviews (M6)](#reviews-m6)). The decisions behind it are ADR
[0009](adr/0009-llm-provider-interface.md) (the provider interface),
[0013](adr/0013-coach-agent-loop.md) (the agent loop) and
[0014](adr/0014-coach-memory-proposals.md) (memory and proposals). The code's map is
[`src/lib/server/agent/README.md`](../src/lib/server/agent/README.md); the tools, with every
input and output schema, are in [coach-tools.md](coach-tools.md), generated from the registry.

The coach is **an agent with structured tools over structured training data**, not a model fed a
long chat transcript (PRD §4). It fetches facts through tools over the same services the screens
use, takes every calculated number from code, labels each part of an answer, and changes nothing
until the owner accepts a proposal.

## Principles

1. **Tools over context.** The model sees a frozen system prompt, a memory snapshot built from
   records, and the turn's facts; it fetches everything else through typed tools.
2. **Deterministic math stays in code.** e1RM, volume, load, ACWR and trends come from analytics
   tools that state their method; the output policy checks each metric against the output it
   cites.
3. **Facts, metrics and recommendations are labelled** in every answer (PRD §12), in a tagged
   grammar the server parses and checks before the phone sees it.
4. **Proposals, not silent writes.** Every change to programming, goals or a workout is a
   `coach_proposals` row the owner accepts by id. The only direct writes are the coach's own
   workout analysis and a preference the owner stated explicitly in this turn.
5. **Core logging never depends on the agent** (PRD §15). No `/workout` route can load a coach
   module (`pnpm budgets` checks), and a coach outage shows a notice, never a failed set.

## Layers

| Layer                         | Coach code                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/domain/coach/`       | The pure contract. Client-safe through `index.ts` (no zod): vocabulary, events, sources, rich text, memory, the tool catalogue, activity wording, pricing and budgets (`scripts/coach-index-imports.test.ts`). Imported by path: safety, statements, intents and sentences (client-safe), and the server-only answer parser, markdown, proposals, rules, diff, grounding, memory format, summary, trends and notes. |
| `src/lib/server/db/`          | Schema (`schema/coach.ts`, `schema/agent-runs.ts`, M3's `schema/coaching.ts`), repositories, and the guards in `drizzle/0024_coach_conversations_guards.sql` and `drizzle/0026_coach_proposals_guards.sql`.                                                                                                                                                                                                         |
| `src/lib/server/services/`    | `coach/*` (threads, runs, proposals, memory, notes, turn facts), `coach/apply/*` (the appliers, one group per file), `analytics` (M6's engine), `reviews` (M6) and `programs/batch.ts`. `coach/shared.ts` holds `CoachDeps` and `toolRuntime(deps)`.                                                                                                                                                                |
| `src/lib/server/agent/`       | The provider, the loop, the tools, the prompt and the output policy; `reviews/narrate.ts`, a review's write-up (M6). It never imports `server/db`, types included (ESLint).                                                                                                                                                                                                                                         |
| `src/lib/client/coach/`, `ui` | The stream client (loaded on demand, never as a modulepreload) and the coach components.                                                                                                                                                                                                                                                                                                                            |
| `src/routes/`                 | `(app)/coach/[[thread]]`, `(app)/coach/proposals/[[id]]`, `api/coach/*`, `api/reviews/narrate` (M6) and `api/test-support/coach`.                                                                                                                                                                                                                                                                                   |

`@anthropic-ai/*` is imported at runtime only by `agent/provider/anthropic.ts`, by a dynamic
import, and by `tests/live` (ESLint and `scripts/anthropic-sdk-imports.test.ts`); everything else
imports its types only.

## The provider

### Interface

`LlmProvider` (`agent/provider/types.ts`) speaks the Claude API's own beta Messages types, so the
content the loop stores is exactly what the API returned:

```ts
interface LlmProvider {
  readonly name: 'mock' | 'anthropic';
  readonly model: string;
  /** A chat call, streamed. */
  stream(request: ModelRequest, signal: AbortSignal): ModelStream;
  /** A draft or a summary: output_config.format from `schema`, no tools. */
  structured<S extends z.ZodMiniType>(
    request: Omit<ModelRequest, 'tools'>,
    schema: S,
    signal: AbortSignal
  ): Promise<StructuredResult<z.output<S>>>;
  countTokens(request: ModelRequest, signal?: AbortSignal): Promise<number>;
}
```

`ModelRequest` is the Messages body without what the provider owns: `max_tokens`, `system`,
`tools`, `messages`, an always-explicit `output_config.effort` and an optional top-level
`cache_control`. It has no field for thinking, `tool_choice` or sampling. Failures are
`CoachProviderError`s with one of `PROVIDER_ERROR_KINDS`: `bad_request`, `auth`, `rate_limited`
(with `retryAfterMs`), `overloaded` (529), `server_error`, `connection`, `aborted`,
`invalid_tool_json` (the SDK's JSON error only) and `invalid_output`.

Two providers implement it:

- **MockProvider** (`provider/mock.ts`): deterministic and offline, used by every test and by
  keyless development. It refuses any request the 2026-10-21 API would refuse
  (`provider/validate.ts`), plays scripts from `provider/mock-scripts/` (one file per tool group,
  plus the adversarial and test ones), and reports a cache read when a request repeats the
  previous one's prefix.
- **AnthropicProvider** (`provider/anthropic.ts`): the pinned SDK, loaded on the first call that
  needs it.

### Selection and the launch switch

`agent/coach.ts` is the composition root: the endpoints call only it. It resolves the provider
once per server with `resolveCoachProvider` (`provider/select.ts`) from `LLM_PROVIDER` (`mock`,
`anthropic` or `off`; no default), `ANTHROPIC_API_KEY` and `COACH_LAUNCHED` (`agent/launch.ts`,
`true` since coach-launch).

| Environment                        | `LLM_PROVIDER`       | Result                                                            |
| ---------------------------------- | -------------------- | ----------------------------------------------------------------- |
| Any                                | `off`                | unavailable: `disabled` (the owner's kill switch, at next deploy) |
| Production, `COACH_LAUNCHED` false | any other            | unavailable: `not_launched`, before any key check                 |
| Production                         | unset or `anthropic` | `anthropic` with a key; unavailable: `no_key` without one         |
| Production                         | `mock`               | unavailable: `mock_in_production`                                 |
| Development, test, preview         | unset or `mock`      | the mock, with a 'Mock coach' badge                               |
| Development, test, preview         | `anthropic`          | `anthropic` with a key; unavailable: `no_key` without one         |

A misconfiguration never stops the server. `disabled` and `not_launched` refuse every turn before
anything is stored. `no_key` and `mock_in_production` log one warning naming the variable, never
its value, and still serve direct answers (`DIRECT_ANSWER_REASONS`), so lookups keep working.
Test overrides (`provider/faults.ts`, set through `POST /api/test-support/coach`) are read only
where test routes are enabled, which a Vercel build never is.

### The request (SDK 1.x, API 2026-10-21)

From the claude-api skill, as `provider/anthropic.ts` and `prompt/layout.ts` build it:

- `@anthropic-ai/sdk` is pinned exactly (1.6.0). It sends `anthropic-version: 2026-10-21` and the
  key as `Authorization: Bearer`; no header is overridden. `MAX_RETRIES` is 2, all under the
  call's one AbortSignal.
- `client.beta.messages.stream` with model `claude-opus-5-5` (`COACH_MODEL`), the exact id.
- `thinking` is omitted (always adaptive on Opus 5.5). `output_config.effort` is always explicit:
  `medium` for chat (`CHAT_EFFORT`), `low` for a quick question that opens its segment
  (`prompt/effort.ts`) and for summaries, `high` for drafts.
- `tool_choice` is omitted (auto). Every tool is `strict: true`, closed and
  `eager_input_streaming: true`; each input is validated with zod before the tool runs.
- No prefill, no sampling parameter, no document block in an assistant message and no cited text
  block in a user message: `validateRequest` refuses such a body before it is sent.
- Refusal fallbacks: beta `server-side-fallback-2026-07-01` with `fallbacks: 'default'`. A
  fallback block resets the visible answer (`answer_reset`), its content is kept verbatim for
  replay, and `usage.iterations` prices each attempt at its own model's rates.
- `stop_reason` is read before any content, `stop_details` only on a refusal. Errors are mapped
  from the SDK's typed classes, most specific first, and never carry the key.

Not used: the SDK's Tool Runner, message threads, server-side compaction and task budgets.

## One turn

`POST /api/coach/turns` answers `text/event-stream` (SSE ids, a comment heartbeat every 15 s,
`SSE_HEARTBEAT_MS`); its `maxDuration` is `COACH_MAX_DURATION_S`. The client reads it with
`fetch`, because `EventSource` cannot POST. `agent/turn.ts` runs the turn, in order:

1. A coach that is `disabled` or `not_launched` refuses before anything is written.
2. The day's facts (`services/coach/turn-facts.ts`): date, time and zone, the active version and
   its week.
3. A segment that is due rolls over (see [Memory](#memory)); a message that opens a segment stores
   the memory preamble ahead of it. A retried send (the same client message id) stores nothing.
4. The run starts in the same transaction; a running run on the thread makes the turn busy (a
   partial unique index allows one). Proposals decided since the thread's last message join the
   turn context by id, kind and status (`listDecidedSince`).
5. A lookup (`domain/coach/intents.ts`: `todays_workout`, `this_week`, `next_session`) is answered
   by `agent/direct.ts` with no model call, recorded as `DIRECT_RUN`. Otherwise a misconfigured
   coach is unavailable, and a day at the cost cap is out of budget, both before any model call.
6. The loop (`agent/orchestrator.ts`) runs over the stored segment.
7. Visible text goes through the answer parser and the output policy to the wire. A completed
   answer is stored with its blocks; one that did not complete is a `display_only` row, shown and
   never replayed, so every stored segment is a valid request.
8. The run finishes with its outcome; `done` is always the last event.
9. When the answer left its segment due to roll over, the summary is made after the answer has
   streamed (the endpoint's `waitUntil`), so the next turn rolls over with no model call first.

The events are a closed set (`domain/coach/events.ts`): `run_started`, `activity`,
`block_started`, `text_delta`, `block_completed`, `block_replaced`, `answer_reset`, `proposal`,
`answer_completed`, `error` and `done`. The browser never parses markdown or model JSON.

Cancellation: `request.signal` stops the run when the client leaves, and Stop also POSTs
`/api/coach/runs/[run]/cancel`, which sets a flag in Postgres that the loop reads between steps.
On a dropped stream the client shows the stored final or interrupted message with Retry.

### The loop

A manual loop over `LlmProvider`, so the MockProvider drives exactly what production runs (ADR
0013). One AbortSignal joins the caller's signal, the turn deadline and the stored cancel flag.
Each call streams, takes the final message, updates the budget, and reads `stop_reason` first:

- `refusal`: no tool runs, even one the message holds.
- `max_tokens`: a truncated `tool_use` never runs; the call is re-sent once with more room, else
  the turn ends `budget_exhausted`.
- `pause_turn`: the same request is sent again.
- `model_context_window_exceeded`: the turn ends `budget_exhausted`.
- `tool_use`: the step's tools run (`tools/execute.ts`), and the assistant message is stored only
  together with all its `tool_result`s, in one user message, with `is_error: true` on failures.
- A streamed tool input that is not JSON is re-sent, at most twice. A cancel during tools answers
  each pending call with an `is_error` 'cancelled' result.

Tools run three at a time on the pool and one at a time on a transaction, which runs one query at
a time (#62, docs/architecture.md). The agent never sees the executor: `toolRuntime(deps)` in
`services/coach/shared.ts` returns `{deps, serialTools}`, and `execute.ts` reads only the boolean.

### Transcript

`coach_messages.content` is Postgres `json`, which keeps exact bytes and key order: the SDK's
content blocks verbatim, with thinking blocks (empty progress blocks included), their signatures
and fallback blocks, because Opus 5.5 ties thinking to the history that produced it. The screen
reads a separate display column. The turn's context message is stored with its first completed
step and never deleted. Messages, model calls, tool calls and notes are insert-only; a thread
changes only its title, archive state and forward segment; a run changes only while running;
DELETE is refused everywhere (`drizzle/0024_coach_conversations_guards.sql`).

## Prompt and caching

Render order is tools, then system, then messages (`agent/prompt/layout.ts`):

| Part            | What it holds                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tools           | The registry's definitions, sorted by name and frozen.                                                                                                             |
| system          | `SYSTEM_PROMPT` (`prompt/system.ts`), one block with an explicit breakpoint: its contract clauses, and no date, id, name or environment value.                     |
| preamble        | A user message opening the segment: the memory snapshot labelled as data, and the previous segment's summary (≤ `SUMMARY_MAX` characters). Frozen for the segment. |
| transcript      | The stored segment, verbatim.                                                                                                                                      |
| turn context    | After each owner message, a mid-conversation `{role: 'system'}` message of server-computed facts (`prompt/context.ts`).                                            |
| `cache_control` | Top-level automatic caching: a second breakpoint on the last block. Never more than 4 breakpoints.                                                                 |

The turn context holds only dates, numbers, flags and checked tokens: date, weekday, local time
and zone; today's planned sessions; the current week (week _n_ of _m_, the remaining sessions with
date and title, the active version number, and whether it changed since the segment began); the
entry kind and ref; pain mode; and the id, kind and status of each proposal decided since the
thread's last message. Stored titles travel as `untrusted_text`; a rejection's note never appears
here, and the model reads it with `get_coach_proposals`. The week is fresh every turn, and the
system prompt tells the model to trust it over the snapshot's program section.

Because the transcript only grows and the context message is stored unchanged, request _n_+1 is
byte-equal to request _n_ up to its last block, even across a program version bump
(`prompt/layout.test.ts`). `PROMPT_VERSION` hashes the system prompt, the tool definitions and the
model; a change starts a new segment. Tools plus system must reach the 512 tokens Opus 5.5 needs
to cache a prefix (`MIN_CACHEABLE_TOKENS`).

## Answers and the output gate

The model writes a tagged grammar (`domain/coach/answer.ts`): a lead, then blocks opened by
`[fact]`, `[metric method=…]`, `[recommendation]`, `[safety]` or `[note]`, with inline refs
`[[type:id|label]]`. Unlabelled text is a note. The server parses it incrementally, with the same
blocks however it was chunked, and parses a small markdown subset into a rich-text tree
(`domain/coach/markdown.ts`); a link survives only when it is a path `sourceAction` builds.

`agent/policy.ts` sits between the parser and the wire, and never sends text it has not scanned:

- **Grounding** (`domain/coach/grounding.ts`): each fact's and metric's refs must be ids this
  turn's tools or the memory returned, and its numbers with units must appear in the cited
  outputs. A failing block becomes a note marked 'Not checked against your data'. A direct answer
  is not checked: the server wrote it from the records it read.
- **Pain** (`domain/coach/safety.ts`): `ALWAYS_BANNED` (push or work through the pain, diagnosis
  phrasings) and `PAIN_CONTEXT_PHRASES` (banned with a pain context), each at most
  `MAX_PATTERN_CHARS` (80) long. A clean block is released at sentence ends, or past `HOLD_CAP`
  (240) held characters at the last clause boundary that keeps 80 held for a rescan. A block with
  a pain word or a context phrase is held to the end of the answer and checked with it. In pain
  mode (the owner's words or a pain entry) context phrases are banned outright, every block is
  held to its end, and the answer must carry a safety block: stop, a gentler option (this turn's
  `get_exercise_alternatives`, or a generic one) and a professional.
- A failing block is replaced (`block_replaced`) before any of it is sent. Every intervention is a
  `_policy` row in `agent_tool_calls`, with codes and counts only.

## Tools

24 tools in five groups, named once in `src/lib/domain/coach/tools.ts` (`TOOL_CATALOGUE`): the
brief's 21 plus `get_program_history`, `get_exercise_alternatives` and `get_coach_proposals`.
Each is `defineTool({name, description, input, output, run})` (`agent/tools/define.ts`), where
`input` and `output` are zod/mini schemas:

- The input becomes strict JSON Schema (`tools/schema.ts`): closed objects with their required
  keys, and every bound strict mode lacks (lengths, ranges, patterns) moved into the description
  as `{key: value}`; zod still enforces it. Recursion, records, tuples, untyped values and any
  property naming an owner are refused, so no input can say whose data a tool reads.
- `run` calls the M2–M4 services the screens use, owner-scoped by the session's owner. A foreign
  or unknown id is `NOT_FOUND`, and every write and propose tool is tested to write nothing for a
  random owner.
- Outputs are canonical JSON (`tools/output.ts`): facts and metrics with `SourceRef`s, a metric
  with its method, pages of at most 20 items with a cursor, capped at 8 KB (`truncated`), and
  stored free text as `untrusted_text`. Every tools slice validates real outputs against the
  output schema.
- Failures are `is_error` results: `UNKNOWN_TOOL`, `INVALID_INPUT` (the tool never runs),
  `TIMEOUT`, `CANCELLED`, `NOT_FOUND`, `CONFLICT`, `TOO_LARGE`, and a logged, generic `INTERNAL`.

`agent/tools/registry.ts` builds `COACH_TOOLS` from one file per group (programming in two),
sorted by name; a tool outside the catalogue or its group's file throws, and
`registry-complete.test.ts` proves all 24 are registered. Three tools draft their payload with a
structured-output call (`agent/proposals/draft.ts`, effort high, `DRAFTER_PROMPT`), so their
deadline adds the draft time.

The catalogue below is generated by `pnpm docs:coach-tools` (`scripts/coach-tools-doc.ts`) and
checked for drift by `scripts/coach-tools-doc.test.ts`. Each tool's description, input schema and
output schema are in [coach-tools.md](coach-tools.md).

<!-- coach-tools:begin (generated by `pnpm docs:coach-tools`) -->

| Tool                                                                        | Group       | Effect  | Drafts |
| --------------------------------------------------------------------------- | ----------- | ------- | ------ |
| [`create_next_training_cycle`](coach-tools.md#create_next_training_cycle)   | Programming | propose | yes    |
| [`create_training_program`](coach-tools.md#create_training_program)         | Programming | propose | no     |
| [`get_coach_proposals`](coach-tools.md#get_coach_proposals)                 | Programming | read    | no     |
| [`get_current_program`](coach-tools.md#get_current_program)                 | Programming | read    | no     |
| [`get_current_training_week`](coach-tools.md#get_current_training_week)     | Programming | read    | no     |
| [`get_current_workout`](coach-tools.md#get_current_workout)                 | Workout     | read    | no     |
| [`get_exercise_alternatives`](coach-tools.md#get_exercise_alternatives)     | Workout     | read    | no     |
| [`get_exercise_history`](coach-tools.md#get_exercise_history)               | History     | read    | no     |
| [`get_performance_trends`](coach-tools.md#get_performance_trends)           | Analytics   | read    | no     |
| [`get_personal_records`](coach-tools.md#get_personal_records)               | History     | read    | no     |
| [`get_program_history`](coach-tools.md#get_program_history)                 | Programming | read    | no     |
| [`get_recent_workouts`](coach-tools.md#get_recent_workouts)                 | History     | read    | no     |
| [`get_running_history`](coach-tools.md#get_running_history)                 | History     | read    | no     |
| [`get_training_history`](coach-tools.md#get_training_history)               | History     | read    | no     |
| [`get_training_load`](coach-tools.md#get_training_load)                     | Analytics   | read    | no     |
| [`get_training_preferences`](coach-tools.md#get_training_preferences)       | Preferences | read    | no     |
| [`get_training_schedule`](coach-tools.md#get_training_schedule)             | Programming | read    | no     |
| [`get_weekly_training_summary`](coach-tools.md#get_weekly_training_summary) | Analytics   | read    | no     |
| [`propose_program_adjustment`](coach-tools.md#propose_program_adjustment)   | Programming | propose | yes    |
| [`save_workout_analysis`](coach-tools.md#save_workout_analysis)             | Workout     | write   | no     |
| [`substitute_exercise`](coach-tools.md#substitute_exercise)                 | Workout     | propose | no     |
| [`update_exercise_preferences`](coach-tools.md#update_exercise_preferences) | Preferences | write   | no     |
| [`update_training_goals`](coach-tools.md#update_training_goals)             | Preferences | propose | no     |
| [`update_workout`](coach-tools.md#update_workout)                           | Workout     | propose | yes    |

<!-- coach-tools:end -->

### Services behind the programming and history tools (M3)

| Tool                                               | Service                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_current_program`, `get_current_training_week` | `src/lib/server/services/programs/read.ts`: `getCurrentProgram`, `getTrainingWeek` (and `getTodayPlan`, `getPlannedSession`)                                             |
| `get_exercise_history`, `get_personal_records`     | M4's `getExerciseHistory` for the sets; the records, PRs and e1RM trend are M6's (below)                                                                                 |
| `create_training_program`                          | `src/lib/server/services/programming/`: `previewProgram` drafts it; accepting the proposal builds it with `buildProgram`, the same path as Today's Build card            |
| `propose_program_adjustment`                       | A `coach_proposals` row against the current version (`base_version_id`); accepting it applies its ops as one version (`applyProgramEdits`, `services/programs/batch.ts`) |

The services take `deps.source: 'coach'`, which a revision records as its decider and an edit of
the training log as its audit actor.

### Services behind the analytics and records tools (M6)

Every figure is the one Progress shows, from the same engine (docs/architecture.md, "Analytics
(M6)"), so an answer and a screen never disagree:

| Tool                                                                         | Service                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_weekly_training_summary`, `get_training_load`, `get_performance_trends` | `src/lib/server/services/analytics/index.ts`, which reads the General, Running and Strength dashboards and cites the counted facts behind each figure. Each result names its `dashboard`; each figure carries `about` (metric id, kind, definition, caveat); each trend its `verdict`, the `window` it read and the `classifier` (`TREND_METHOD`). A week's summary names the week's live review as a source. |
| `get_personal_records`                                                       | `src/lib/server/services/analytics/records.ts` (`getStrengthRecords`): the best e1RM, rep maxes and the PR timeline, as `prs` and `prCount`, judged as the strength dashboard judges them                                                                                                                                                                                                                     |
| `get_exercise_history`                                                       | M4's `getExerciseHistory` for the sets, a page at a time, plus `getExerciseAnalytics` (`services/analytics/exercise.ts`) for the records and the `e1rmTrend` over the `period` asked for, as exercise detail shows it                                                                                                                                                                                         |

Only completed, undeleted workouts count for every one of these, so a set in an abandoned workout
is never a record. Too little data is a result (`insufficient_data`, saying what is missing), never
a zero.

### Services behind the workout tools (M4)

| Tool                        | Service                                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_current_workout`       | The canonical reads (`services/workouts/canonical.ts`: `listActiveWorkouts`, `getCanonicalWorkout`) for the workout in progress, and `getTodayPlan` for today's sessions                             |
| `get_exercise_alternatives` | The start kit's alternatives (`services/workouts/kit.ts`, `kitForLineage`), ranked by M4's `rankFor`; with a body area, the gentler options (`gentlerFor`)                                           |
| `substitute_exercise`       | A `session_substitution` proposal. Accepted, it is M4's `exercise.substitute` through the sync dispatcher (the proposal's id is the mutation id) in a live workout, or M3's one-off swap without one |
| `update_workout`            | A `workout_update` proposal for today's session before it starts; nothing changes until the owner accepts it                                                                                         |
| `save_workout_analysis`     | `services/coach/notes.ts`: the coach's note on a workout, which memory reads                                                                                                                         |

A situational statement ('the leg press is taken') keeps a swap in its session with no
preference. `update_exercise_preferences` writes only when this turn's stored owner message holds
an explicit statement about that exercise (`classifyExerciseStatement`, with M3's `matchExercise`
injected): through `recordExercisePreference` with source 'coach', plus a `coach_decision` note
quoting the owner. A situational statement makes it return `is_error`, pointing to
`substitute_exercise`; with no explicit statement it proposes a `preference_update` instead.

## Memory

`getCoachingMemory` (`services/coach/memory.ts`) builds one deterministic `MemorySnapshot`
(`domain/coach/memory.ts`) from structured records, never from replayed chat, one query at a
time, in at most `MEMORY_QUERIES` (18) queries:

- **Profile** (≤ 9, `MEMORY_PROFILE_QUERIES`): goals by rank; the active program, version, week
  and phase; the last 14 days planned against done (`RECENT_DAYS`); strength baselines, measured
  or estimated; simple trends; exercise preferences with source and reason; equipment; active
  injuries and the movements to avoid.
- **Records** (≤ 9, `MEMORY_RECORDS_QUERIES`, `services/coach/memory-records.ts`): pain reports
  from the last 28 days (area, severity, what the owner chose, the workout; never a preference);
  recovery notes; recent decisions with their why; pending proposals and recently decided ones
  with the owner's reasons; weekly and cycle reviews; other threads' summaries and workout
  analyses.

Every item carries its `SourceRef`, and every stored string is wrapped as `untrusted_text` (at
most `MEMORY_TEXT_MAX` characters). `domain/coach/memory-format.ts` serialises the snapshot
canonically within `MEMORY_MAX_BYTES` (6 KB), cutting from the end of `MEMORY_SECTION_PRIORITY`
(goals, program, injuries and pain reports are kept longest), and counts what each section lost.
The snapshot opens every segment and fills 'What the coach knows' (`GET /api/coach/memory`).

**Segments and summaries** (`agent/rollover.ts`). A long thread is never edited. A segment rolls
over, before the turn's owner message is stored, when the prompt version changed, when the last
chat call sent `SEGMENT.inputTokens` (60K, cache reads and writes included) or more, or when it
holds `SEGMENT.messages` (40) owner and coach messages. The summary is one structured-output call
at effort low (`prompt/summary.ts`, 8K output tokens, within `SUMMARY_TIMEOUT_MS`, which is
`draftMs`) in its own `summary` run, stored as a `thread_summary` note. It is made after the
answer that fills the segment when it can (`summariseAhead`), otherwise at the next turn, before
its transaction. A failed summary still rolls over (`ROLL_WITHOUT_SUMMARY`); a spent cap or a
client leaving keeps the segment. The next segment opens with a fresh snapshot, that summary, and
the active program version (`coach_threads.segment_program_version_id`).

## Proposals

Every change the agent makes is a `coach_proposals` row, created by `createProposal`
(`services/coach/proposals.ts`): kind, payload with `PAYLOAD_VERSION` and hash, title, summary
(the first summary line, ≤ 200 characters), rationale, diff rows and impact, `base_version_id`
(with `program_id` whenever it is set), and the thread, run and tool call. An identical open
proposal on the same base is returned instead of a second row.

| Kind                   | Payload from          | Applied on accept by (`services/coach/apply/`)                                 |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------ |
| `program_adjustment`   | a draft, effort high  | `program.ts`: its ops as one version (`applyProgramEdits`)                     |
| `workout_update`       | a draft, effort high  | `program.ts`: the same, refused once the workout has started                   |
| `session_substitution` | the strict tool input | `session.ts`: M4's dispatcher in a live workout, else M3's one-off swap        |
| `new_program`          | M3's `previewProgram` | `program-create.ts`: `buildProgram` (proposed only while no program is active) |
| `next_cycle`           | a draft, effort high  | `next-cycle.ts`: M6's paths, below ([Reviews (M6)](#reviews-m6))               |
| `goal_update`          | the strict tool input | `profile.ts`: M2's goal services, source 'coach'                               |
| `preference_update`    | the strict tool input | `profile.ts`: `recordExercisePreference`, source 'coach'                       |

`acceptProposal` takes only the id (`POST /api/coach/proposals/[id]`; any payload a client sends
is dropped). It locks the row, re-parses the stored payload, supersedes it as `program_changed` if
its program moved on, checks it again against today, and runs its kind's applier in the same
transaction. A proposal already decided returns as stored. `rejectProposal` keeps an optional
note, which `get_coach_proposals` and memory return as `untrusted_text`. 'Ask for changes' creates
a revision that supersedes the original (`revised`).

Postgres guards the lifecycle (`drizzle/0026_coach_proposals_guards.sql`): inserts are `proposed`
only; content never changes; status moves forward only (proposed → accepted, rejected, applied or
superseded; accepted → applied or superseded); decided rows are frozen; DELETE is refused. The
CHECKs (`drizzle/0025_coach_proposals.sql`): `coach_proposals_applied_ck` (applied exactly when
`applied_version_id` or `applied_ref` is set), `coach_proposals_superseded_ck`,
`coach_proposals_closed_ck`, `coach_proposals_decision_ck`, and M3's `coach_proposals_program_ck`.

## Reviews (M6)

The weekly and cycle reviews are computed, stored and proposed by code alone
(docs/architecture.md, "Reviews and replanning (M6)"). The coach adds a write-up afterwards, and
never makes a review's proposal.

### Write-ups: a read-only coach turn behind its own endpoint

`narrateReview` (`src/lib/server/agent/reviews/narrate.ts`) is called only from
`POST /api/reviews/narrate` `{kind, id}` (owner-only, Origin-checked, at most 1 KB, never cached;
404 for a review that is not the owner's, 409 for one a refresh superseded). It runs one coach turn
through `agent/coach.ts` like any other: the launch gate, the `coach.turn` rate limit and the daily
cost cap.

- **Hidden threads.** The turn runs in the review's own thread, opened with the entry
  `weekly_review_writeup` or `cycle_review_writeup` and titled 'Week of 2 Nov: review'. The
  owner's conversation lists, thread summaries and memory's other-threads section leave such
  threads out (`REVIEW_ENTRIES`, `src/lib/domain/coach/review-entries.ts`). Its owner message has a
  client message id derived from the review's id and revision (`narrationMessageId`), so every
  call for one revision finds the same thread and a retry stores nothing new.
- **Read-only.** `NARRATION_TOOL_EFFECTS` is `['read']`: the turn sees only read tools, so it
  can never propose or write. The rules' proposal is already stored.
- **Data-only input.** The owner message is code's own words ('Review my week of 2 Nov'). The turn
  context adds the entry, the review's ref, and the review proposal's id, kind and decision (read
  from the head of its revision chain), each a checked token (`prompt/context.ts`). The findings
  reach the model as memory's review section and through the read tools, never as free text in
  the prompt.
- **Grounding.** The answer goes through the same parser and output policy as every turn: a fact
  or metric that does not cite what this turn's tools or memory returned becomes a note marked
  'Not checked against your data'.
- **Released text.** What is stored, once, in the review's `narrative` (with its run, thread and
  time) is `releasedText`: each display block's label and words as the owner saw them, the
  policy's replacements included, never the model's raw output. The screen draws the run's display
  blocks with M5's `AnswerBlocks` over that text (`narrationBlocks`).
- **A lifetime of its own.** The run is never given `request.signal`, and the endpoint's
  `maxDuration` is `COACH_MAX_DURATION_S`, as a turn's: a client that leaves never cancels it, and
  the result is stored for the next visit. `GET /api/reviews/narrate?kind&id` answers the stored
  write-up, the run still writing it, or neither (`narrationState`).
- **Polling.** The page requests the write-up once, on idle, for a review that has none
  (`WRITE_UP_ON_OPEN`, the owner's default for the plan's open question). Another tab or an earlier
  visit running it answers `busy`, and the page polls the GET at 2, 4 and 8 s, then every 8 s up to
  `COACH_MAX_DURATION_S` (`write-up-client.ts`, `POLL_STEPS_MS`).
- **Degradation.** Every way the coach cannot answer is an outcome, never an error the review
  shows: `unavailable` (not launched, switched off, misconfigured, the daily budget, the rate limit
  with its wait, or busy) or `failed`. The review's figures and proposal stand; the write-up's box
  says why, with Retry where asking again can help. A superseded revision is never written up.

'Discuss with your coach' is a separate, visible conversation: `/coach` with `from` set to
`weekly_review` or `cycle_review` and `ref` to `review:<key>`, an entry the Coach screen keeps only
when the review is the owner's.

### Review origins in memory and `get_coach_proposals`

A review's proposal stores the review as `evidence.source` (`RulesProvenance`: the kind, review
id and revision, and `modifiedBy: 'owner'` or `trimmed: n` on the owner's revision of it).

- Memory's record half (`services/coach/memory-records.ts`) lists each proposal with who proposed
  it, the coach or a review's rules, with the review as a source; and the newest live weekly
  reviews and the newest live cycle review (never a superseded revision): the summary, the
  verdicts and the decision, read from the head of its proposal's chain.
- `get_coach_proposals` returns each proposal's `origin` (`coach`, `weekly_review` or
  `cycle_review`) and the review as a source, and tells the model never to present a review's
  proposal as its own.
- M5's card and inbox label a review's proposals ('From your weekly review · Week of 2 Nov') and
  M6's superseded reasons: `review_refreshed`, `folded_into_review`, `sessions_passed` and
  `cycle_planned` (`SUPERSEDED_REASON_LABEL`).

### `next_cycle`, applied by M6

`create_next_training_cycle` drafts a `next_cycle` brief; accepting it plans nothing by itself,
because a next block needs a start choice and a fresh preview, which only the cycle review has
(`services/coach/apply/next-cycle.ts`):

- The review's own proposal, or the owner's revision of it, is refused on accept with 'Choose when
  it starts in your cycle review' (`choose_start`) and the review's link.
- A coach `next_cycle` for a block with no live review is accepted and waits for it
  (`NEXT_CYCLE_AWAITS`); creating the review folds its fields in as overrides, held to the
  directives' bounds, and supersedes it as `folded_into_review`.
- One for a block whose review is undecided becomes an owner revision of the review's head and is
  superseded as `folded_into_review`; one for a decided review is superseded as `cycle_planned`
  once the next block is planned, else as `folded_into_review`. Either way the outcome carries the
  review's link.
- 'Start next block' in the review plans the block as the program's next version
  (`applyNextCycle`, `planBlock`) and supersedes every other open `next_cycle` for that block as
  `cycle_planned`.

Weekly reviews propose a `program_adjustment` whose ops M5's applier applies as one version, with
a `review_applied` decision. Accepted from the inbox after some of its sessions have passed, it is
superseded as `sessions_passed` and links to the review, which applies the rest.

## Cost and latency

Every limit derives from one constant in `src/lib/domain/coach/budgets.ts`:

| Limit                       | Value at `COACH_MAX_DURATION_S` = 180                              |
| --------------------------- | ------------------------------------------------------------------ |
| Turn (`turnMs`)             | 150 s: the constant − 30 s, so the turn can store its last step    |
| Draft (`draftMs`)           | 75 s: min(75 s, turn ÷ 2)                                          |
| Tool (`toolMs`)             | 10 s; a drafting tool 85 s (`toolDeadlineMs`), never past the turn |
| Stale run (`staleRunMs`)    | 210 s: the constant + 30 s                                         |
| Calls per turn              | ≤ 8 chat calls, ≤ 2 drafts                                         |
| `max_tokens`                | 16K chat, 32K draft, 8K summary                                    |
| Tokens per turn             | ≤ 40K output, ≤ 300K input (cache reads and writes included)       |
| Tool concurrency and output | 3 at a time (1 on a transaction); 8 KB per result                  |

180 s needs Fluid compute; `turnLimits(60)` proves the 60 s fallback still works (30 s turn, 15 s
draft, 25 s drafting tool).

Pricing (`domain/coach/pricing.ts`, exact micro-dollars): `claude-opus-5-5` at $4 input and $20
output per million tokens, cache reads $0.20 and 5-minute cache writes $5, plus the fallback
targets' rates. Each call stores two prices: `cost_micros` (null for a model missing from
`PRICING`) and `cap_cost_micros`, NOT NULL, which prices an unknown model at the highest known
rate and rounds up. The daily cap, `DAILY_COST_CAP_USD` ($5 in the owner's day), sums
`cap_cost_micros` over every run, summaries and drafts included. Rate limits: `coach.turn` 30 per
10 minutes and `coach.action` 60 per minute (`auth/policy.ts`). Every call stores its tokens,
served model, stop reason, refusal category, time to first token, latency and both costs, which
the usage view shows.

## Security

- Coach endpoints are owner routes, Origin-checked, rate-limited and cost-capped.
- No tool schema can name an owner; `ToolContext` takes the owner from the session.
- Stored free text reaches the model only as `untrusted_text`; no tool commits a program change;
  a direct preference write needs the owner's own words this turn.
- `pnpm budgets` fails if SDK code, an `sk-ant-` key or CI's canary key is in any client output.
- Logs carry ids and counts, never message text.

## Testing

- Every acceptance test uses the MockProvider, which refuses what the real API would refuse.
  Named adversarial scripts (`pain-unsafe`, `ungrounded`, `run-on`, `refusal`, `slow`,
  `long-answer`, `thinking-pause`) prove the policy and the designed states.
- Each tool group has an integration test through `runTurn` on real Postgres
  (`tests/integration/coach/`), with output-schema validation and a foreign-owner case.
- The `e2e/*.serial.e2e.ts` journeys run on iPhone and desktop, with faults injected through
  `POST /api/test-support/coach`.
- The tools catalogue in these docs is checked against the registry by
  `scripts/coach-tools-doc.test.ts`.

### The live suite

`tests/live/coach.live.test.ts` runs six named conversations against `claude-opus-5-5`: grounding
and caching, a proposal and its rejection, preferences, pain, refusal handling and prompt
injection. `tests/live/first-words.live.test.ts` records how soon the first words come. They
assert properties, never wording, fail past `LIVE_COST_CAP_MICROS` ($1), and never run in CI
(`scripts/vite-config.test.ts`). To run them:

1. Start Postgres (the version CI and production run). The suite uses `TEST_DATABASE_URL`
   (default `coach_test`), which it drops and re-migrates; it refuses a name not ending in
   `_test`.
2. Run `pnpm db:setup` once.
3. Run `LIVE_LLM=1 ANTHROPIC_API_KEY=<a key of your own> pnpm test:live`.

`LIVE_LLM_DRY=1 pnpm test:live` plays the same conversations on the MockProvider. With neither
flag every test is skipped and no database is touched (`tests/live/gate.ts`).
