# AI coach — agent architecture (plan)

> Design outline for Milestone 5. In M1 only the folder (`src/lib/server/agent/`), its import
> boundaries and the `LLM_PROVIDER` configuration exist.

The coach is **an agent with structured tools over structured training data**, not an LLM fed a
long chat transcript (PRD §4). It reasons over facts it fetches through tools, computes metrics
with deterministic code, and proposes changes that the owner commits.

## Principles

1. **Tools over context.** The model sees a compact system prompt + coaching memory summary and
   fetches everything else through typed tools. Long histories are summarised by code, not pasted.
2. **Deterministic math stays in code.** e1RM, volume, load, ACWR, plate maths live in
   `src/lib/domain` and are exposed as tool results; the model never "calculates" numbers.
3. **Facts · metrics · recommendations are labelled** in every answer (PRD §12). Tool results
   carry provenance so the UI can render them differently.
4. **Proposals, not silent writes.** The agent can only _propose_ program changes; a proposal is
   committed by the owner (or by an explicit, logged auto-accept rule).
5. **Core logging never depends on the agent** (PRD §15). The agent reads the same data through
   services; outages degrade to "coach unavailable", never to "can't log a set".

## Components

```
src/lib/server/agent/
  provider/types.ts     LlmProvider interface: messages, tool schemas, tool calls, usage
  provider/anthropic.ts production provider (server-only API key)
  provider/mock.ts      deterministic scripted provider (tests, keyless dev)
  tools/*.ts            one tool per file: zod input → service call → typed, provenance-tagged output
  memory/               structured coaching memory read/write (via services)
  orchestrator.ts       tool loop with step/token/time budgets, tracing, cancellation
  proposals.ts          proposal lifecycle helpers
```

### Provider interface

```ts
interface LlmProvider {
  name: 'mock' | 'anthropic';
  complete(request: {
    system: string;
    messages: AgentMessage[];
    tools: ToolDefinition[]; // JSON Schema from zod
    maxOutputTokens: number;
    signal?: AbortSignal;
  }): Promise<{ message: AgentMessage; toolCalls: ToolCall[]; usage: Usage; stopReason: string }>;
}
```

Selected by `LLM_PROVIDER` (validated in `env.ts`). Streaming is added for the chat UI.

### Tools (initial set, PRD §4)

| Group       | Tools                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| History     | `get_training_history`, `get_exercise_history`, `get_running_history`, `get_recent_workouts`, `get_personal_records`                                               |
| Programming | `get_current_program`, `get_current_training_week`, `get_training_schedule`, `propose_program_adjustment`, `create_training_program`, `create_next_training_cycle` |
| Workout     | `get_current_workout`, `update_workout` (proposal), `substitute_exercise`, `save_workout_analysis`                                                                 |
| Preferences | `get_training_preferences`, `update_exercise_preferences`, `update_training_goals`                                                                                 |
| Analytics   | `get_weekly_training_summary`, `get_training_load`, `get_performance_trends`                                                                                       |

Each tool: zod input schema (also the JSON Schema shown to the model), authorization (owner
session), a call into `src/lib/server/services/*`, and an output with `kind: 'fact' | 'metric'`
and source ids. Read tools are side-effect free; write tools create proposals or append
structured memory.

### Services behind the programming and history tools (M3)

The M3 services these tools adapt (docs/architecture.md, "Training model (M3)"):

| Tool                                               | Service                                                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_current_program`, `get_current_training_week` | `src/lib/server/services/programs/read.ts`: `getCurrentProgram`, `getTrainingWeek` (and `getTodayPlan`, `getPlannedSession`)                                                 |
| `get_exercise_history`, `get_personal_records`     | `src/lib/server/services/training/history.ts`: `getExerciseHistory`, `getLastPerformances`, `getPersonalRecords`                                                             |
| `create_training_program`                          | `src/lib/server/services/programming/`: `previewProgram` drafts it; accepting the proposal builds it with `buildProgram`, the same path as Today's Build card                |
| `propose_program_adjustment`                       | A `coach_proposals` row against the current version (`base_version_id`); accepting it revises the program with `reviseProgram`, so it becomes a version decided by the coach |

The services take `deps.source: 'coach'`, which a revision records as its decider and an edit of
the training log as its audit actor. Until their M5 slices land, these tool files and the program
appliers (`src/lib/server/services/coach/apply/program.ts`) are stubs.

### Services behind the workout tools (M4)

The workout tools (`src/lib/server/agent/tools/workout.ts`) read and write through M4's
services, owner-scoped by the session's owner:

| Tool                        | Service                                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_current_workout`       | The canonical reads (`services/workouts/canonical.ts`: `listActiveWorkouts`, `getCanonicalWorkout`) for the workout in progress, and `getTodayPlan` for today's sessions                             |
| `get_exercise_alternatives` | The start kit's alternatives (`services/workouts/kit.ts`, `kitForLineage`), ranked by M4's `rankFor`; with a body area, the gentler options (`gentlerFor`)                                           |
| `substitute_exercise`       | A `session_substitution` proposal. Accepted, it is M4's `exercise.substitute` through the sync dispatcher (the proposal's id is the mutation id) in a live workout, or M3's one-off swap without one |
| `update_workout`            | A `workout_update` proposal for today's session before it starts; nothing changes until the owner accepts it                                                                                         |
| `save_workout_analysis`     | `services/coach/notes.ts`: the coach's note on a workout, which memory reads                                                                                                                         |

A situational statement ('the leg press is taken') keeps a swap in its session with no
preference; only an explicit dislike this turn makes it a lasting swap, and that too is a
proposal (`program_adjustment`). Pain reports from the workout screen (`pain_reports`) reach
coaching memory: the last 28 days of them (`services/coach/memory-records.ts`), each with its
area, severity, what the owner chose and its workout, and never as a preference.

## Memory (structured, persistent)

Stored in Postgres (M3/M5 tables), never inferred from chat logs:

- goals and priorities (with which goal wins conflicts), active program and cycles,
- strength estimates (measured vs estimated, method, confidence), performance trends,
- exercise preferences: **explicit** dislikes persist; **situational** substitutions (machine
  unavailable) are recorded against the session only,
- recovery patterns and notes, weekly reviews, previous cycles,
- programming decisions **with rationale** (`decision`, `why`, `evidence ids`, `created_at`).

## Proposals vs committed changes

```
agent tool call ─▶ proposal (status: pending, diff, rationale, evidence)
                      │ owner reviews in UI (accept / edit / reject)
                      ▼
                 service applies diff in a transaction ─▶ new program version (old kept)
                      │
                      └▶ decision log entry (why, who: owner|rule, links)
```

Programs and cycles are versioned; applying a proposal never overwrites history (PRD §9, §11).

## Orchestration & safety

- Budgets per turn: max tool steps, max tokens, wall-clock timeout; graceful partial answers.
- Pain/injury: the coach never advises "push through"; it offers alternatives or stopping and
  no medical diagnoses (PRD §6) — enforced in the system prompt and tested with the mock provider.
- Expensive analyses (weekly/cycle reviews) run as background jobs with stored results.
- Every turn is traced (tool calls, latency, tokens) and linked to request ids.

## Testing

- Unit: tool input/output schemas, proposal diffing.
- Integration: tools against the test database via services; orchestrator with the **mock**
  provider (scripted tool-call sequences) for deterministic behaviour.
- Opt-in real-model tests when a key is configured (skipped otherwise).
