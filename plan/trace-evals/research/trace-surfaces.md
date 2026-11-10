# Trace surfaces

An explorer's report on the code the `trace` and `feedback` PRs touch, recorded at `9719a3f5`. It read the source and ran nothing.

The owner-only run trace can reuse existing records, but those records do not capture every model request or response in full.

## Run messages

- `segment_preamble` and `owner_message` are inserted before the run starts, without `run_id` (`src/lib/server/services/coach/threads.ts:194`, `:204`; `src/lib/server/agent/turn.ts:378`, `:416`).
- Completed steps write `context` once, then `assistant` and optional `tool_results`, all with the run id. Incomplete visible answers use `display_only` with the run id (`threads.ts:285-340`, `:351-367`; `turn.ts:657`). A failure before the first completed step can leave no context row.
- To build a trace, fetch the owner-scoped run, join its `trigger_message_id` for the owner message, and fetch its run-id messages ordered by thread `seq`. Retries are separate runs on the same owner message (`src/lib/server/db/schema/agent-runs.ts:94-97`). Existing transcript queries are segment-scoped, not run-scoped (`src/lib/server/db/queries/coach-threads.ts:107-119`). No index on `coach_messages.run_id` exists (`src/lib/server/db/schema/coach.ts:152-159`).

## Thinking and trace completeness

- The Anthropic request sets no thinking display option. Its request type carries only effort in `output_config` (`src/lib/server/agent/provider/anthropic.ts:11-16`, `:84-102`; `provider/types.ts:40`).
- The test SSE fixtures are hand-written, and their thinking blocks are empty with signatures (`tests/fixtures/anthropic/tool-use.sse:5-8`; `provider/anthropic.test.ts:3`, `:208-213`). The mock also emits empty thinking and signatures (`provider/mock.ts:380-384`, `:461-464`). These fixtures do not prove every live response is empty.
- Model-call rows hold metadata and usage, not full requests or responses (`schema/agent-runs.ts:140-164`).
- Tool input and output can be replaced by truncation markers (`src/lib/server/services/coach/runs.ts:189-228`).
- The policy can replace stored final content (`turn.ts:488-518`).
- Summary runs and draft calls have separate handling (`rollover.ts:14-20`; `turn.ts:613-615`).
- A complete historical replay is therefore not guaranteed.

## Repository and endpoint conventions

- `src/lib/server/db/repositories/agent-runs.ts:34-63` wraps query builders. The service builds it with an injected executor (`services/coach/runs.ts:133-146`). Queries scope runs by owner (`src/lib/server/db/queries/agent-runs.ts:35-43`).
- `CoachDeps` injects the database and clock. `CoachInputError` maps to 400 and `CoachNotFoundError` to 404 (`src/lib/server/services/coach/shared.ts:5-24`, `:53-70`).
- The runs endpoint applies `authRequest`, the `coach.action` rate limit, and `no-store`, and takes the owner id from the session (`src/routes/api/coach/runs/+server.ts:9`, `:39-59`).

## UI conventions

- The optional thread route loads owner data on the server (`src/routes/(app)/coach/[[thread]]/+page.server.ts:10-22`).
- `UsageButton.svelte:17-45` lazy-loads the sheet. `UsageSheet.svelte:35-82` fetches on each open and handles loading, failure, and pagination.
- Reusable components under `src/lib/ui` include `BottomSheet`, `Button`, `EmptyState`, `Notice`, `Section`, `Stat`, `ListRow`, `Badge`, and `LoadingRows`.
- Coach uses a readable conversation column, with two-column suggestions at desktop widths (`docs/design-system.md:406-408`).

## Tests and services

- The coach harness runs scripted mock turns against Postgres and reads ordered rows (`tests/integration/coach/harness.ts:1-8`, `:66-105`, `:110-125`).
- `runs.test.ts:138-541` covers persistence and scoping. `runs-endpoint.test.ts:172-325` covers the response, pagination, isolation, and rate limits.
- `e2e/coach-usage.serial.e2e.ts:95-127` drives scripted turns and checks usage. `e2e/coach-support.ts:33-73` controls fixtures and faults.
- Single-file commands, from `package.json:32-35`.

```sh
pnpm test:unit src/lib/server/agent/provider/anthropic.test.ts
pnpm test:integration tests/integration/coach/runs.test.ts
E2E_SERIAL_ALONE=1 pnpm test:e2e e2e/coach-usage.serial.e2e.ts --project=serial-chromium
```

- Playwright project dependencies are in `playwright.config.ts:75-150`.
- Integration setup resets the disposable `TEST_DATABASE_URL`, default local `coach_test`, and needs reachable Postgres (`tests/integration/global-setup.ts:1-15`).
- Local e2e resets `coach_e2e`, builds, and starts the production Node server with test routes, not the dev server (`e2e/global-setup.ts:1-10`, `:100-133`). Test mode defaults to the mock (`provider/select.ts:13-15`).

## Feedback

No answer thumbs, rating, or report field exists in the coach UI or schema. Retry exists for failed or interrupted answers only (`src/routes/(app)/coach/[[thread]]/words.ts:125-126`; `Thread.svelte:77-84`, `:165-166`). Pain reports concern workouts, not answer ratings (`src/lib/server/db/schema/feedback.ts:2-7`).

## Browser control

No browser-control or web UI verification skill exists in the repo's skill folders. `.pi/skills/verify-workout-sync/SKILL.md` model-checks workout sync and does not drive a browser.
