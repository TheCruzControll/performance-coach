# Why the coach agent is built this way

A synthesis from git history, PR bodies, ADRs 0004, 0009, 0013, and 0014, `docs/agent-architecture.md`, and the PRD. Each finding carries a confidence label. Direct means the record states it. Inferred means it follows from the record but is not written down.

## Findings

- **A hand-written loop.** Direct. The SDK's Tool Runner was rejected because "it runs on the SDK client, so the mock could not drive the same loop". Per-step storage, the stored cancel flag, transaction-aware concurrency, and the output gate would also have sat in hooks around a beta helper (`docs/adr/0013-coach-agent-loop.md:51`). Managed Agents was rejected because the loop must run beside Postgres, owner-scoped, in the app's own function (ADR 0013:52).
- **Tools, not pasted history.** Direct. The coach is "not an LLM fed a long chat history" (`docs/product-requirements.md:70`, `docs/agent-architecture.md:6`). Replaying chat as memory was rejected as "costly, drifts from the records, and replays any injected instruction" (`docs/adr/0014-coach-memory-proposals.md:49`). Math lives in `src/lib/domain`, and the model never calculates numbers (`docs/agent-architecture.md:12-15`). Tool results stay compact and cite their records so answers can be grounded (commit `5d68daa6`).
- **A frozen prompt and a cache-stable layout.** Direct. Before commit `8034793b`, nothing kept the cached prefix byte-stable across turns or kept the date, program week, and stored free text out of the system channel. Tool definitions are sorted and frozen so the tools prefix stays byte-stable (commit `be76fdfc`). Prompt-cache stability is the main driver, and keeping untrusted stored text out of the system prompt is a second reason.
- **A mock that rejects bad requests, and a type-only SDK.** Direct. No API key exists in development or CI (ADR 0009:5). The validator exists because "a bad replay would only fail against the real API" (commit `b841ff52`, PR #123). The SDK is pinned for the 2026-10-21 API, and a test fails on any runtime SDK import outside `provider/anthropic.ts` (commit `a7296b40`), so an SDK change touches one file.
- **Proposals, not writes, and services only.** Direct. ADR 0014 says every change is a proposal and rejects auto-applying low-risk changes and accepting payloads the client sends back. ESLint boundaries exist because convention alone "erodes under deadline pressure" (ADR 0004). PRD section 15 requires that core workout logging never depends on the agent.
- **Stop-reason handling.** Direct for two rules. `pause_turn` resends the same request because a resumed message would end in text, which Opus 5.5 refuses as a prefill (`orchestrator.ts` comment). `DISCONNECT_GRACE_MS = 0` is an owner decision on "cancel on disconnect", and a grace period is implemented and tested (PRs #171, #200).
- **One decision, not two.** Inferred. The mock-first design and the hand-written loop look like one decision. Testing without a key was the central constraint, and the loop shape follows from it.
- **Retry counts and budgets.** Inferred. `MAX_TOKENS_REISSUE_FACTOR = 2`, two invalid-JSON retries, 8 chat calls, 2 drafts, and the 40,000 and 300,000 token caps have no written reason. Code cites an "m5 plan" that is not in the repo.

## Conflicts and gaps

- The docs disagree on auto-accept. `docs/agent-architecture.md:19` allows "an explicit, logged auto-accept rule". ADR 0014:52 rejects auto-applying low-risk changes. Both are still marked plan or Proposed. Only the owner can settle it.
- ADRs 0013 and 0014 are still Proposed and `COACH_LAUNCHED` is false, so the rationale has not been confirmed in production use.
- Review comments on PRs #123, #131, #162, #171, #193, #200, #205, #226, and #232 were empty.
- Every commit and ADR was written by Claude and merged by the owner. The reasons above are the agent's framing, approved by the merge.

## Sources not searched

Issue tracker, long-form docs, team chat, and error tracking had no matching tool in the environment. Vercel and Neon observability were skipped because the coach has never served traffic.
