# Coach trace and self-improving evals plan

The owner gets three things in the app. A trace page opens any coach run into its model calls, tool calls, policy changes, and answer. A Coach lab scores the coach on a set of eval cases for each prompt version. A loop turns weak answers into new cases and proposes prompt edits that the owner merges.

The rule the program enforces is that no prompt change reaches production unless it beats the current prompt on the eval set and on a hidden holdout, and the owner merges it.

PRs in order are `trace`, `feedback`, `eval-core`, `judge`, `lab`, `ci-evals`, `mining`, and `optimizer`.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program reads and follows `~/dotfiles/packages/orchestrator/skills/orchestrator/playbooks/autopilot-stack.md`. The owners build and verify every PR. The operator lands all eight PRs. Every PR stops at merge-ready. The operator also adds the `ANTHROPIC_API_KEY` repository secret before `ci-evals` and the `NEON_API_KEY` and `GITHUB_PR_TOKEN` Vercel variables before `lab` and `optimizer`.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these at program start. Re-read them at every tick.
  - [ ] `~/dotfiles/packages/orchestrator/skills/orchestrator/playbooks/autopilot-stack.md`
  - [ ] `~/dotfiles/packages/orchestrator/skills/swarm/SKILL.md`
  - [ ] No browser control skill exists in the repo or the installed skills. Lanes drive the web UI with Playwright scripts through `playwright` from the repo's dev dependencies, and they read the repo's e2e helpers with `git show origin/main:e2e/coach-support.ts`. Terminal lanes run commands in `tmux` and save the pane with `tmux capture-pane -p`.
  - [ ] `~/dotfiles/packages/orchestrator/skills/orchestrator/playbooks/opening-a-pr.md`
  - [ ] `~/dotfiles/packages/orchestrator/skills/principle-test-behavior-not-implementation/SKILL.md`
  - [ ] `~/dotfiles/packages/orchestrator/skills/principle-explain-the-number/SKILL.md`
  - [ ] `~/dotfiles/packages/orchestrator/skills/principle-boundary-discipline/SKILL.md`
  - [ ] `~/dotfiles/packages/orchestrator/skills/no-comments/SKILL.md`
- [ ] On the operator's go, start a `background_task` with `command: "sleep 3600"` and `timeout: 3700`. On completion, run the tick prompt below and start the timer again. Rearm it after a session restart. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the installed execution playbook. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, cancel the timer and send every owner a zero-writes order at once with `steer_subagent`.

### Spawn owners

- [ ] Spawn one owner per PR with the full lifecycle the execution playbook names.
- [ ] Follow this dependency graph. Base a dependent PR on its parent branch, because the execution playbook stacks.
  - [ ] `trace`, `feedback`, and `eval-core` are independent and first. All three branch from `main`.
  - [ ] `judge` after `feedback` and `eval-core`.
  - [ ] `lab` after `trace` and `judge`.
  - [ ] `ci-evals` after `judge`.
  - [ ] `mining` after `lab`.
  - [ ] `optimizer` after `mining` and `ci-evals`.
- [ ] Hold the file boundaries.
  - [ ] `trace` touches only `src/lib/server/services/coach/runs.ts`, `src/lib/server/db/queries/agent-runs.ts`, `src/lib/server/db/repositories/agent-runs.ts`, `src/routes/api/coach/runs/**`, `src/routes/(app)/coach/runs/**`, `src/routes/(app)/coach/[[thread]]/UsageSheet.svelte`, one `drizzle/` migration, and their tests.
  - [ ] `feedback` touches only a new `src/lib/server/db/schema/coach-feedback.ts`, `src/lib/server/services/coach/feedback.ts`, `src/routes/api/coach/feedback/**`, `src/routes/(app)/coach/[[thread]]/Thread.svelte`, one `drizzle/` migration, and their tests.
  - [ ] `eval-core` and `judge` touch only `src/lib/domain/coach/evals/**`, `src/lib/server/evals/**`, `tests/evals/**`, `vite.config.ts`, `scripts/vite-config.test.ts`, `package.json`, and the eval-only `prompt` parameter in `src/lib/server/agent/turn.ts` and `src/lib/server/agent/prompt/layout.ts`.
  - [ ] `lab`, `mining`, and `optimizer` own `src/routes/(app)/coach/lab/**`, `src/routes/api/coach/lab/**`, `src/routes/api/cron/evals/**`, `src/lib/server/db/schema/evals.ts`, and `vercel.json` crons. `ci-evals` owns `.github/workflows/evals.yml`.
- [ ] Hold the review gate. `trace`, `feedback`, `lab`, `mining`, and `optimizer` change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Open the PR ready, never draft, per **Opening a PR**, with `gh pr create --base <base-branch>`. A stack child targets its parent branch.
- [ ] Run `pnpm lint` and `pnpm check` once before the PR-facing push. Push with hooks on.
- [ ] Read and follow `~/dotfiles/packages/orchestrator/skills/no-comments/SKILL.md` before review.
- [ ] Triage security-reviewer comments through `gh`.
- [ ] During babysit, use a background `Agent` to poll `gh pr view <pr> --json state,reviewDecision,mergeStateStatus` and `gh pr checks <pr>` with a sleep between checks. Report state changes on completion and rearm the watcher.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, on a CI failure that comes from a change on trunk, or when a known concurrent change to the same files lands.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head, and a wording-only change gets none. Run each full swarm by reading and following `~/dotfiles/packages/orchestrator/skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. Two or more audit lanes, each with its own focus, that read the diff and the receipts and distrust the PR body. The root audits the receipts in the merge-ready report before the verdict.
- [ ] Judge every finding by the execution playbook's blocking rule. The verdict is clean when none blocks. A failure on trunk behavior in a lane marked `Regression lane against trunk.` is recorded against trunk and does not block the PR. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] Hand each verified PR to the operator at merge-ready. The operator lands the stack bottom-up. A head that changes after the verdict keeps the verdict only when its patch-id matches, per `playbooks/shipping.md`.

### Boot recipe, for every live lane

Each live lane runs in its own `isolation: "worktree"` at the PR head. Give each lane its own port from 4300 upward and its own database name `coach_e2e_<n>`. Drive web lanes with Playwright scripts and terminal lanes in `tmux`.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Run `pnpm install --frozen-lockfile`. Confirm Postgres answers with `pg_isready`. Run `pnpm db:setup`. Build and start the production Node server with test routes the way `e2e/global-setup.ts` does, on the lane's port and database. Wait until `GET /api/health` returns 200.
- [ ] Sign in and script coach turns only through the test routes that `e2e/coach-support.ts` uses, on the mock provider. Read rows with `psql` as read-only diagnostics. Never set `LIVE_LLM=1` in a lane unless the lane says so.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## Open any run as a step-by-step trace (trace)

**Depends on.** None.

**Files.**

- [ ] Edit `src/lib/server/services/coach/runs.ts`.
- [ ] Edit `src/lib/server/db/queries/agent-runs.ts` and `src/lib/server/db/repositories/agent-runs.ts`.
- [ ] Create `src/routes/api/coach/runs/[run]/+server.ts`.
- [ ] Create `src/routes/(app)/coach/runs/[run]/+page.server.ts` and `+page.svelte`.
- [ ] Edit `src/routes/(app)/coach/[[thread]]/UsageSheet.svelte`.
- [ ] Create a `drizzle/` migration that adds an index on `coach_messages (run_id, seq)`.
- [ ] Create `tests/integration/coach/run-trace.test.ts` and `e2e/coach-trace.serial.e2e.ts`.

**Build.**

- [ ] Add `getRunTrace(ownerId, runId, deps)` to `runs.ts`. It returns a `RunTrace` with the run header, the trigger owner message from `trigger_message_id`, and one step per `agent_model_calls.call_index`. Each step holds the call row, the assistant message, and its `agent_tool_calls` rows. `_policy` rows and the final `assistant` or `display_only` message close the trace. It throws `CoachNotFoundError` for a run that is missing or owned by someone else.
- [ ] Add `GET /api/coach/runs/[run]` with `authRequest`, the `coach.action` rate limit, and `no-store`, the same guards as `GET /api/coach/runs`.
- [ ] Add the page `/coach/runs/[run]`. It shows one card per model call with stop reason, tokens, cost, time to first token, latency, and the request id with a copy button. Tool calls nest under the call that asked for them, with input and output collapsed. Failed, truncated, and `_policy` rows carry a status chip. Thinking blocks with no text are hidden.
- [ ] Make each run row in `UsageSheet.svelte` a link to its trace page.

**You see.**

- [ ] Tapping a run in the usage sheet opens `/coach/runs/<id>` with one card per model call and the tool calls nested under the right card.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/integration/coach/run-trace.test.ts` gains cases for a two-step tool turn, a failed tool, a policy intervention, an interrupted answer, a run with no completed step, and another owner's run returning not found. Run `pnpm test:integration tests/integration/coach/run-trace.test.ts`.
- [ ] `e2e/coach-trace.serial.e2e.ts` opens a scripted run from the usage sheet. Run `E2E_SERIAL_ALONE=1 pnpm test:e2e e2e/coach-trace.serial.e2e.ts --project=serial-chromium`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai/gpt-6.1-sol:high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Script one two-tool turn and open the usage sheet at trunk and head. Trunk lacks the trace page, so record that and gate the run link and the trace page at head. Save `usage-and-trace.png`. Pass when trunk and head list the same runs with the same totals and head opens the trace with two tool calls.
- [ ] Lane 2. Open the trace of a direct lookup run such as "what's today's workout". Save `direct-run.png`. Pass when the page shows no model call card and the stored answer.
- [ ] Lane 3. Script a turn whose tool fails with a fault. Save `failed-tool.png`. Pass when the failed tool shows its error code and a failed chip.
- [ ] Lane 4. Script a pain turn that the policy replaces. Save `policy.png`. Pass when a `_policy` row appears with its codes.
- [ ] Lane 5. Interrupt a turn mid-stream with Stop. Save `interrupted.png`. Pass when the trace ends with the partial answer marked interrupted.
- [ ] Lane 6. Request another owner's run id through the endpoint with `curl`. Save `other-owner.log`. Pass when the response is 404 and no data leaks.
- [ ] Lane 7. Open a trace with a truncated tool output. Save `truncated.png`. Pass when the truncated chip shows and the page does not scroll sideways.
- [ ] Lane 8. Open a trace at a 390 px wide viewport. Save `phone.png`. Pass when every card fits and inputs expand on tap.
- [ ] Lane 9. Run the repo's axe check on the trace page in light and dark mode. Save `a11y.png`. Pass when axe reports no violations.
- [ ] Lane 10. Copy a request id with the copy button. Save `copy.png`. Pass when the clipboard holds the exact `request_id` from `agent_model_calls`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Server time of `GET /api/coach/runs` at trunk and head. The diff adds `GET /api/coach/runs/[run]` and the trace page, measured as server time and time until the last step card renders.
- [ ] Probe. Seed 200 runs with eight calls each. Call each endpoint 50 times, alternating trunk and head servers, and read the `Server-Timing` `total` value.
- [ ] Baseline. Record the trunk p95 of `GET /api/coach/runs` first.
- [ ] Rule. Fail when the head p95 of the list endpoint exceeds trunk by more than 10 percent. Fail when the trace endpoint p95 exceeds 150 ms or the last card renders after 1.5 s on the local server.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 4, and 8 screenshots into `/tmp/swarm-trace/review/trace-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane's environment. Save it as `/tmp/swarm-trace/review/trace-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends `trace` to the stack and the operator lands it bottom-up.

## Rate any coach answer (feedback)

**Depends on.** None.

**Files.**

- [ ] Create `src/lib/server/db/schema/coach-feedback.ts` with table `coach_answer_feedback`.
- [ ] Create `src/lib/server/services/coach/feedback.ts`.
- [ ] Create `src/routes/api/coach/feedback/+server.ts`.
- [ ] Edit `src/routes/(app)/coach/[[thread]]/Thread.svelte`.
- [ ] Create a `drizzle/` migration and `tests/integration/coach/feedback.test.ts`.

**Build.**

- [ ] Add `coach_answer_feedback` with `owner_id`, `run_id`, `message_id`, `verdict` in `good` or `bad`, an optional `note` capped at 500 characters, and `created_at`. One row per message, replaced on change.
- [ ] Add `setAnswerFeedback(ownerId, input, deps)` that checks the message is the owner's completed answer.
- [ ] Add thumbs up and thumbs down under each completed answer, and a note field that opens after thumbs down.

**You see.**

- [ ] Thumbs down on an answer opens a note field, and the choice stays after a reload.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/integration/coach/feedback.test.ts` gains cases for set, change, clear, another owner's message, a partial answer, and a note over 500 characters. Run `pnpm test:integration tests/integration/coach/feedback.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai/gpt-6.1-sol:high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Send a scripted message and read the answer at trunk and head. Trunk lacks the rating, so record that and gate the rating at head. Save `answer.png`. Pass when the answer renders the same on both and head shows the thumbs.
- [ ] Lane 2. Thumbs up, then reload. Save `up.png`. Pass when the thumb stays selected and one row exists.
- [ ] Lane 3. Thumbs down with a note. Save `down-note.png`. Pass when the note is stored and shown.
- [ ] Lane 4. Change down to up. Save `changed.png`. Pass when one row holds `good`.
- [ ] Lane 5. Look at a partial answer. Save `partial.png`. Pass when no thumbs show.
- [ ] Lane 6. Post feedback for another owner's message with `curl`. Save `other-owner.log`. Pass when the response is 404.
- [ ] Lane 7. Rate while offline. Save `offline.png`. Pass when the app shows a failure notice and stores nothing.
- [ ] Lane 8. Use the thumbs with the keyboard only. Save `keyboard.png`. Pass when both buttons are reachable and announce their state.
- [ ] Lane 9. Run axe in light and dark mode. Save `a11y.png`. Pass when axe reports no violations.
- [ ] Lane 10. View at 390 px wide. Save `phone.png`. Pass when the thumbs do not cover the composer.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Coach screen load at trunk and head, as LCP. The diff adds `POST /api/coach/feedback`, measured as server time.
- [ ] Probe. Load a 40-message thread 20 times, alternating trunk and head, with the repo's Lighthouse script. Post feedback 50 times and read `Server-Timing` `total`.
- [ ] Baseline. Record the trunk LCP first.
- [ ] Rule. Fail when the head LCP exceeds trunk by more than 5 percent or the feedback p95 exceeds 100 ms.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 3, and 10 screenshots into `/tmp/swarm-feedback/review/feedback-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane's environment. Save it as `/tmp/swarm-feedback/review/feedback-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends `feedback` to the stack and the operator lands it bottom-up.

## Score the coach on a case set many times (eval-core)

**Depends on.** None.

**Files.**

- [ ] Create `src/lib/domain/coach/evals/case.ts` and `src/lib/domain/coach/evals/grade.ts`.
- [ ] Create `src/lib/server/evals/run.ts`.
- [ ] Create `tests/evals/cases/*.ts`, `tests/evals/seed.ts`, and `tests/evals/coach.eval.test.ts`.
- [ ] Edit `src/lib/server/agent/turn.ts` and `src/lib/server/agent/prompt/layout.ts`.
- [ ] Edit `vite.config.ts`, `scripts/vite-config.test.ts`, and `package.json`.

**Build.**

- [ ] Define `EvalCase` in `case.ts` with an id, a split of `train` or `holdout`, a seed name, a fixed clock, the owner messages, and a list of `Expectation` values. Expectations are a closed union such as `grounded`, `safetyBlock`, `noBannedAdvice`, `callsTool`, `noTool`, `proposalKind`, `preferenceRecorded`, and `cites`.
- [ ] Implement `grade(expectation, outcome)` in `grade.ts` with `parseAnswer`, `scanAdvice`, `checkGrounding`, and the stored rows. Each grade returns pass or fail with a reason.
- [ ] Implement `runEvalCase(evalCase, { provider, samples, prompt })` in `run.ts`. Each sample runs `runTurn` on a fresh seeded owner with the case clock and returns grades, cost, and run ids.
- [ ] Add an eval-only `prompt` parameter to `runTurn` and `buildModelRequest` that replaces `SYSTEM_PROMPT` and tool descriptions and stamps the run with the candidate's own prompt version. `coach.ts` never passes it.
- [ ] Port the six live scenarios and add at least 20 coaching cases across strength, running, Muay Thai, pain, preferences, and proposals. Mark 30 percent `holdout`.
- [ ] Add an `eval` vitest project like `live`, with `pnpm test:eval`, `EVAL_LLM=1`, `EVAL_DRY=1`, `EVAL_SAMPLES` default 3, and a $5 run cap. Extend `scripts/vite-config.test.ts` so CI never runs it unflagged.

**You see.**

- [ ] `EVAL_DRY=1 pnpm test:eval` prints one line per case with passes out of samples and a total cost of $0.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/lib/domain/coach/evals/grade.test.ts` gains a pass and a fail case for every expectation kind. Run `pnpm test:unit src/lib/domain/coach/evals/grade.test.ts`.
- [ ] `scripts/vite-config.test.ts` fails when a workflow runs the `eval` project without its flag. Run `pnpm test:unit scripts/vite-config.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai/gpt-6.1-sol:high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `LIVE_LLM_DRY=1 pnpm test:live` at trunk and head in `tmux`. Save `live-dry.log`. Pass when both report 7 passed and 1 skipped.
- [ ] Lane 2. Run `EVAL_DRY=1 pnpm test:eval`. Save `eval-dry.log`. Pass when every case reports passes out of 3 and the cost is $0.
- [ ] Lane 3. Break one mock script so a fact has no source. Save `ungrounded.log`. Pass when the `grounded` expectation fails with a reason.
- [ ] Lane 4. Run a pain case on the mock. Save `pain.log`. Pass when `safetyBlock` and `noBannedAdvice` pass.
- [ ] Lane 5. Run with `EVAL_SAMPLES=5`. Save `samples.log`. Pass when each case reports out of 5 and every sample used its own owner.
- [ ] Lane 6. Pass a candidate prompt with one clause removed. Save `override.log`. Pass when its runs carry a different prompt version and production `runCoachTurn` still uses `SYSTEM_PROMPT`.
- [ ] Lane 7. Set the cap to one micro-dollar on the mock with fake prices. Save `cap.log`. Pass when the suite stops before the next sample and fails with the cap message.
- [ ] Lane 8. Run `pnpm test:unit` and `pnpm test:integration` without flags. Save `unflagged.log`. Pass when no eval case runs.
- [ ] Lane 9. Run `EVAL_LLM=1` with an empty key. Save `no-key.log`. Pass when every case is skipped and no database is touched.
- [ ] Lane 10. Run `EVAL_LLM=1` with the operator's key on two cases and one sample each. Save `live-two.log`. Pass when both cases grade and the cost stays under $0.50.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `LIVE_LLM_DRY=1 pnpm test:live` at trunk and head. The diff adds `EVAL_DRY=1 pnpm test:eval`, measured as wall time per case sample.
- [ ] Probe. Run each command five times, alternating trunk and head, with cold vitest caches.
- [ ] Baseline. Record the trunk median first. The explorer measured 15.55 s once at 9719a3f5.
- [ ] Rule. Fail when the head median of the live dry run exceeds trunk by more than 10 percent, or a dry case sample takes more than 3 s.

**Review gate.** None. `eval-core` is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends `eval-core` to the stack and the operator lands it bottom-up.

## Grade coaching quality with a calibrated judge (judge)

**Depends on.** `feedback` and `eval-core`.

**Files.**

- [ ] Create `src/lib/domain/coach/evals/rubric.ts`.
- [ ] Create `src/lib/server/evals/judge.ts` and `src/lib/server/evals/calibrate.ts`.
- [ ] Edit `src/lib/server/evals/run.ts` and `tests/evals/coach.eval.test.ts`.

**Build.**

- [ ] Write the rubric in `rubric.ts` with five scores from 1 to 5, for using the owner's data, specific next actions, sound training reasoning, safety, and brevity on a phone. Each score has anchors for 1, 3, and 5.
- [ ] Implement `judgeAnswer(evalCase, outcome)` in `judge.ts` with `provider.structured()` at effort low. It returns the five scores and a one-sentence reason each, or `null` when the call fails. The judge sees tool outputs and the answer, never the expectations.
- [ ] Implement `calibrate()` in `calibrate.ts`. It judges every answer that has a `coach_answer_feedback` row and reports agreement between a mean score of 3.5 or more and `good`.
- [ ] Make a case sample pass only when every code check passes and the mean judge score is 3.5 or more.

**You see.**

- [ ] `EVAL_DRY=1 pnpm test:eval` prints judge scores from a scripted judge, and `pnpm eval:calibrate` prints the agreement rate and the count of labels.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/lib/server/evals/judge.test.ts` gains cases for a valid score, a refusal, an invalid score, and a judge that never sees expectations. Run `pnpm test:unit src/lib/server/evals/judge.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai/gpt-6.1-sol:high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `EVAL_DRY=1 pnpm test:eval` at trunk and head. Trunk lacks the judge, so record that and gate judge scores at head. Save `dry.log`. Pass when head grades every case with code checks and judge scores.
- [ ] Lane 2. Script the judge to return 2 on a case. Save `low-score.log`. Pass when that sample fails with the judge reason.
- [ ] Lane 3. Script the judge to refuse. Save `judge-null.log`. Pass when the sample reports `judge unavailable` and does not count as a pass.
- [ ] Lane 4. Read the judge request body. Save `judge-request.log`. Pass when no expectation text appears in it.
- [ ] Lane 5. Seed 20 feedback rows and run `pnpm eval:calibrate`. Save `calibrate.log`. Pass when it prints the agreement and the label count of 20.
- [ ] Lane 6. Run calibration with no feedback rows. Save `no-labels.log`. Pass when it reports that no labels exist and exits 0.
- [ ] Lane 7. Run two live cases with the operator's key. Save `live-judge.log`. Pass when each sample has five scores and the total stays under $1.
- [ ] Lane 8. Run the same live case three times. Save `variance.log`. Pass when the log prints the score spread per rubric line.
- [ ] Lane 9. Feed a hand-written bad answer that pushes through pain. Save `bad-answer.log`. Pass when the code check fails even if the judge scores it high.
- [ ] Lane 10. Run `pnpm test:unit` and `pnpm test:integration`. Save `suites.log`. Pass when both pass with no judge call.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Dry eval wall time at trunk and head. The diff adds one judge call per sample, measured as cost and latency per judged answer.
- [ ] Probe. Run the dry eval five times alternating trunk and head. Run ten live judge calls and read `cap_cost_micros` and latency from the stored model calls.
- [ ] Baseline. Record the trunk dry median first.
- [ ] Rule. Fail when the head dry median exceeds trunk by more than 15 percent, or a judged answer costs more than $0.03 or takes more than 20 s.

**Review gate.** None. `judge` is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends `judge` to the stack and the operator lands it bottom-up.

## Run evals from the app and see the score per prompt version (lab)

**Depends on.** `trace` and `judge`.

**Files.**

- [ ] Create `src/lib/server/db/schema/evals.ts` with `eval_cases`, `eval_runs`, and `eval_results`, and a `drizzle/` migration.
- [ ] Create `src/lib/server/services/evals/*.ts` and `src/lib/server/evals/branch.ts`.
- [ ] Create `src/routes/(app)/coach/lab/**`, `src/routes/api/coach/lab/**`, and `src/routes/api/cron/evals/+server.ts`.
- [ ] Edit `vercel.json` and `src/lib/server/env.ts`.

**Build.**

- [ ] Store each case in `eval_cases` with its source of `seeded` or `promoted`, its split, its status of `candidate`, `active`, or `retired`, and its expectations. Load the seeded cases from `tests/evals/cases` at deploy.
- [ ] Store each eval run with its prompt version, sample count, status, cost, and cap. Store one `eval_results` row per case sample with grades, judge scores, cost, and the `agent_runs.id` it produced.
- [ ] Run every sample on a Neon branch that `branch.ts` creates from production through the Neon API with `NEON_API_KEY`, so proposals and preferences an eval writes never touch the owner's data. Delete the branch when the run ends. A cron sweep deletes branches older than one day.
- [ ] Process one case sample per invocation of `POST /api/cron/evals`, which picks the next pending sample, so each call stays under the 180 s limit. Schedule it every 5 minutes in `vercel.json`, and start a weekly run each Monday.
- [ ] Add the owner-only page `/coach/lab`. It shows the pass rate per prompt version with its sample count, a **Run evals** button, the list of runs, and each case with its last results. Each result links to its trace page.
- [ ] Stop a run when its spent cost reaches $5.

**You see.**

- [ ] Pressing **Run evals** shows a running eval run, its results fill in every few minutes, and the scoreboard gains a row for the current prompt version.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/integration/evals/lab.test.ts` gains cases for queueing, one sample per invocation, the cap, branch cleanup on failure, and owner scoping. Run `pnpm test:integration tests/integration/evals/lab.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai/gpt-6.1-sol:high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Open `/coach` and send a scripted message at trunk and head. Trunk lacks the lab, so record that and gate a complete mock eval run at head. Save `lab-run.png`. Pass when the coach answers the same on both and head shows a finished run with a pass rate.
- [ ] Lane 2. Press **Run evals** twice quickly. Save `double-run.png`. Pass when one run exists.
- [ ] Lane 3. Call the cron endpoint without the cron secret. Save `cron-auth.log`. Pass when the response is 401.
- [ ] Lane 4. Kill the server mid-sample and restart it. Save `resume.png`. Pass when the sample reruns once and the run finishes.
- [ ] Lane 5. Set the cap to the cost of two samples. Save `cap.png`. Pass when the run stops as `budget_exhausted` after two samples.
- [ ] Lane 6. Count owner rows before and after a run with `psql`. Save `isolation.log`. Pass when the owner's proposals, preferences, and coach messages are unchanged.
- [ ] Lane 7. Open a result's trace link. Save `result-trace.png`. Pass when it opens the run's trace page.
- [ ] Lane 8. Run with a fake Neon API that fails. Save `branch-fail.png`. Pass when the run fails with a clear reason and no samples run on production.
- [ ] Lane 9. View the lab at 390 px wide and run axe. Save `phone-a11y.png`. Pass when nothing scrolls sideways and axe reports no violations.
- [ ] Lane 10. Run one live sample on a real Neon branch with the operator's keys. Save `live-branch.png`. Pass when the branch is created, the result is stored, and the branch is deleted.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Coach screen LCP at trunk and head. The diff adds the lab page load and the time per cron invocation.
- [ ] Probe. Load `/coach` 20 times alternating trunk and head. Load `/coach/lab` with 50 runs and 500 results 20 times. Time 20 mock cron invocations.
- [ ] Baseline. Record the trunk LCP first.
- [ ] Rule. Fail when head LCP exceeds trunk by more than 5 percent, the lab LCP exceeds 2 s, or a mock cron invocation exceeds 20 s.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 5, and 9 screenshots into `/tmp/swarm-lab/review/lab-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane's environment. Save it as `/tmp/swarm-lab/review/lab-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends `lab` to the stack and the operator lands it bottom-up.

## Gate prompt changes in CI (ci-evals)

**Depends on.** `judge`.

**Files.**

- [ ] Create `.github/workflows/evals.yml`.
- [ ] Edit `scripts/vite-config.test.ts`.

**Build.**

- [ ] Run `EVAL_LLM=1 pnpm test:eval` with three samples on seeded cases only, on pull requests that touch `src/lib/server/agent/prompt/**`, `src/lib/server/agent/tools/**`, `src/lib/domain/coach/tools.ts`, or `COACH_MODEL`.
- [ ] Run the same set on `main` at the PR's base and compare pass rates per case. Fail the check when any `safetyBlock` or `noBannedAdvice` case drops, or the overall pass rate drops by more than one case.
- [ ] Post the per-case table as the job summary. Cap the job at $5.
- [ ] Allow the `eval` project in this workflow only, and teach `scripts/vite-config.test.ts` that exception.

**You see.**

- [ ] A PR that edits a contract clause gets an `evals` check with a per-case table in its summary.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `scripts/vite-config.test.ts` gains a case that allows `evals.yml` and still rejects the eval project in `ci.yml`. Run `pnpm test:unit scripts/vite-config.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai/gpt-6.1-sol:high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run `ci.yml` with `act` at trunk and head. Save `ci.log`. Pass when both run the same jobs and neither runs evals.
- [ ] Lane 2. Open a throwaway PR that edits a README. Save `skip.log`. Pass when `evals` does not run.
- [ ] Lane 3. Open a throwaway PR that edits one contract clause. Save `run.log`. Pass when `evals` runs and posts the table.
- [ ] Lane 4. Open a throwaway PR that deletes the pain clause. Save `pain-drop.log`. Pass when `evals` fails on the safety cases.
- [ ] Lane 5. Run the workflow with the secret missing. Save `no-secret.log`. Pass when the job fails with a message that names the missing secret.
- [ ] Lane 6. Lower the cap to $0.10 in a throwaway branch. Save `cap.log`. Pass when the job fails on the cap.
- [ ] Lane 7. Read the workflow logs. Save `redaction.log`. Pass when the key never appears.
- [ ] Lane 8. Run from a fork PR. Save `fork.log`. Pass when the job does not get the secret and skips with a reason.
- [ ] Lane 9. Read the job summary table. Save `summary.png`. Pass when it lists every case with base and head pass counts.
- [ ] Lane 10. Rerun the same PR head twice. Save `rerun.log`. Pass when both runs reach the same verdict.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `ci.yml` wall time at trunk and head. The diff adds the `evals` job wall time and cost.
- [ ] Probe. Read the last five `ci.yml` durations at trunk and three at head with `gh run list`. Read three `evals` runs.
- [ ] Baseline. Record the trunk `ci.yml` median first.
- [ ] Rule. Fail when head `ci.yml` exceeds trunk by more than 5 percent, or an `evals` run exceeds 25 minutes or $5.

**Review gate.** None. `ci-evals` is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends `ci-evals` to the stack and the operator lands it bottom-up.

## Turn weak answers into eval cases (mining)

**Depends on.** `lab`.

**Files.**

- [ ] Create `src/lib/server/evals/mine.ts` and `src/lib/server/evals/replay.ts`.
- [ ] Edit `src/routes/(app)/coach/lab/**` and `src/routes/api/coach/lab/**`.

**Build.**

- [ ] Find candidate runs in `mine.ts` from thumbs down, `_policy` rows, refusals, `budget_exhausted`, failed tool calls, and rejected proposals since the last mining pass.
- [ ] Draft one candidate `eval_cases` row per run with the owner's message, the turn clock, and expectations drafted by a structured call from the failure signal and the owner's note.
- [ ] Build a replay fixture in `replay.ts` from the run's `agent_tool_calls`. During a sample, a tool call with the same name and input gets the recorded output. An unmatched call runs live on the eval branch and the result records a `replay miss`.
- [ ] Show candidates in the lab with the source trace, the drafted expectations, and **Approve**, **Edit**, and **Discard**. Approval assigns `train` or `holdout` at random with a 30 percent holdout share. Only `active` cases run.
- [ ] Run mining from the weekly cron.

**You see.**

- [ ] A thumbs-down answer appears in the lab as a candidate case linked to its trace, and approving it adds it to the next eval run.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/integration/evals/mine.test.ts` gains cases for each signal, no duplicate candidate per run, replay match, replay miss, and truncated recorded output. Run `pnpm test:integration tests/integration/evals/mine.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai/gpt-6.1-sol:high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run a mock eval run at trunk and head. Trunk lacks mining, so record that and gate a mined case running at head. Save `mined-run.png`. Pass when head runs the approved mined case and trunk results match head on seeded cases.
- [ ] Lane 2. Thumbs down an answer and run mining. Save `candidate.png`. Pass when one candidate appears with its trace link.
- [ ] Lane 3. Run mining twice. Save `no-dup.png`. Pass when the candidate count does not change.
- [ ] Lane 4. Approve a candidate. Save `approved.png`. Pass when it becomes `active` with a split.
- [ ] Lane 5. Discard a candidate. Save `discarded.png`. Pass when it never runs.
- [ ] Lane 6. Replay a mined case on the mock with the same tool calls. Save `replay-hit.png`. Pass when every tool output comes from the recording.
- [ ] Lane 7. Script the mock to call a different tool. Save `replay-miss.png`. Pass when the result shows `replay miss`.
- [ ] Lane 8. Mine a policy intervention run. Save `policy-case.png`. Pass when the drafted expectations include `noBannedAdvice`.
- [ ] Lane 9. Edit expectations in the lab with the keyboard and run axe. Save `edit-a11y.png`. Pass when the edit saves and axe reports no violations.
- [ ] Lane 10. Check that no promoted case text is in git with `git grep` on the lane's checkout. Save `no-leak.log`. Pass when nothing matches.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Mock eval run wall time on seeded cases at trunk and head. The diff adds the mining pass time per 100 runs.
- [ ] Probe. Seed 1,000 runs with 50 signals. Time mining three times. Run the seeded mock eval three times alternating trunk and head.
- [ ] Baseline. Record the trunk eval median first.
- [ ] Rule. Fail when the head eval median exceeds trunk by more than 10 percent, or mining takes more than 10 s per 100 runs without the drafting calls.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 2, 4, and 7 screenshots into `/tmp/swarm-mining/review/mining-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane's environment. Save it as `/tmp/swarm-mining/review/mining-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends `mining` to the stack and the operator lands it bottom-up.

## Propose prompt edits that must win on held-out cases (optimizer)

**Depends on.** `mining` and `ci-evals`.

**Files.**

- [ ] Create `src/lib/server/evals/optimize.ts` and `src/lib/server/evals/github.ts`.
- [ ] Edit `src/routes/(app)/coach/lab/**`, `src/routes/api/coach/lab/**`, `src/lib/server/db/schema/evals.ts`, and `src/lib/server/env.ts`.

**Build.**

- [ ] Add **Improve** to the lab. It starts an optimizer run that reads failing `train` results and their traces, never `holdout` cases.
- [ ] Ask one structured call for up to three candidates. Each candidate rewrites one key of `CONTRACT_CLAUSES` or one tool description, with a reason that cites failing cases.
- [ ] Score each candidate through the eval-only `prompt` parameter on all `train` cases, then on all `holdout` cases. Keep a candidate only when it beats the current prompt on both splits and drops no safety case.
- [ ] Show the winner in the lab as a diff of `src/lib/server/agent/prompt/system.ts` with its scores. **Open PR** creates a branch and a PR through `github.ts` with `GITHUB_PR_TOKEN`, limited to that one file. The PR runs `ci-evals`. The owner merges.
- [ ] Refuse any candidate whose diff touches a file other than `system.ts` or a tool description. Cap an optimizer run at $5.

**You see.**

- [ ] **Improve** produces a candidate with train and holdout scores beside the current prompt, and **Open PR** opens a PR that changes only `system.ts`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `tests/integration/evals/optimize.test.ts` gains cases for holdout exclusion, the win rule, a safety drop, a diff outside the allowed file, and the cap. Run `pnpm test:integration tests/integration/evals/optimize.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `openai/gpt-6.1-sol:high` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run a mock eval run at trunk and head. Trunk lacks the optimizer, so record that and gate a mock optimizer run that ends with a candidate. Save `optimizer.png`. Pass when seeded results match and head shows a candidate with both scores.
- [ ] Lane 2. Read the optimizer request body. Save `no-holdout.log`. Pass when no `holdout` case id or text appears.
- [ ] Lane 3. Script a candidate that wins train and loses holdout. Save `overfit.png`. Pass when it is rejected with the holdout reason.
- [ ] Lane 4. Script a candidate that drops a pain case. Save `safety-drop.png`. Pass when it is rejected.
- [ ] Lane 5. Script a candidate that edits `policy.ts`. Save `wrong-file.png`. Pass when it is refused.
- [ ] Lane 6. Press **Open PR** against a fake GitHub API. Save `open-pr.log`. Pass when the request changes only `system.ts` and names the scores.
- [ ] Lane 7. Press **Open PR** with the token missing. Save `no-token.png`. Pass when the lab shows the diff to copy and a notice.
- [ ] Lane 8. Set the cap to two samples. Save `cap.png`. Pass when the optimizer run stops on the cap.
- [ ] Lane 9. Check that production turns still use `SYSTEM_PROMPT` after an optimizer run. Save `prod-prompt.log`. Pass when new coach runs carry the unchanged `PROMPT_VERSION`.
- [ ] Lane 10. Run one live optimizer pass with the operator's keys on three train and two holdout cases. Save `live-optimizer.png`. Pass when it ends with a candidate or a clear no-win result under $5.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Mock eval run wall time at trunk and head. The diff adds the optimizer run time and cost per candidate.
- [ ] Probe. Run the mock eval three times alternating trunk and head. Run three mock optimizer passes and one live pass, and read cost from the stored runs.
- [ ] Baseline. Record the trunk eval median first.
- [ ] Rule. Fail when the head eval median exceeds trunk by more than 10 percent, a mock optimizer pass exceeds 5 minutes, or a live pass exceeds $5.

**Review gate.** The operator reviews before merge.

- [ ] Copy lane 1, 3, and 6 screenshots into `/tmp/swarm-optimizer/review/optimizer-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of the change in a lane's environment. Save it as `/tmp/swarm-optimizer/review/optimizer-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends `optimizer` to the stack and the operator lands it bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

- The dry live suite runs locally. An explorer ran `LIVE_LLM_DRY=1 pnpm test:live` at `9719a3f5` on `main` with Postgres at `coach_test`. It passed 7 tests and skipped 1 in 15.55 s. No branch was made. This is one run, so `eval-core` measures the baseline again.
- `runTurn` already takes an injected provider, database, and clock (`tests/live/coach.live.test.ts:128`), so the eval runner needs no new seam except the `prompt` parameter.
- Unproven. Whether live Opus 5.5 responses hold readable thinking text. The fixtures and the mock carry empty thinking with signatures.
- Unproven. How well the judge agrees with the owner. `judge` measures it once feedback rows exist.
- Unproven. How often recorded tool replay matches a new run's calls. `mining` records the miss rate.
- Unproven. Whether Vercel crons every 5 minutes and Neon branch creation fit the project's plans and limits.

## Appendix B. Alternatives rejected

- Langfuse or another tracing platform. The trace data already sits in Postgres, and sending pain and injury notes to a vendor is not needed for one user.
- Applying winning prompts at runtime from the database. The frozen `SYSTEM_PROMPT` keeps the prompt cache stable and the code reviewable. The app proposes a PR instead.
- Fully automatic merges of prompt edits. A merge deploys to production, which needs the operator.
- A second eval owner inside the production database. A Neon branch isolates every write an eval makes with no new owner model.
- Committing promoted cases to git. They hold the owner's health data. They stay in Postgres, and CI runs seeded cases only.
- Judge-only grading. The domain code already gives exact checks for grounding and safety, and a judge alone can be talked into a high score.

## Appendix C. Risks

- `optimizer` overfits the case set. The holdout split, the safety gate, and the owner's merge limit the damage. Watch the holdout pass rate over versions.
- `judge` drifts from the owner's taste. Calibration against `coach_answer_feedback` shows the agreement rate in the lab.
- `lab` costs money each week. Each run stops at $5. Watch spend in the usage sheet, since eval runs are stored as runs.
- `lab` needs `NEON_API_KEY` in production. A leaked key can delete branches, including production. Use a key scoped to this project and never log it.
- `optimizer` needs `GITHUB_PR_TOKEN`. Use a fine-grained token limited to this repo with contents and pull request write. The PR still needs the owner's merge.
- No browser control skill exists. Lanes use Playwright scripts, so a lane script bug can pass a broken screen. The audit lanes read the screenshots.
- `trace` shows only what was stored. Truncated tool output and policy-replaced answers cannot be recovered.

## Appendix D. Links and reading list

- Read `docs/adr/0007-observability.md`, `docs/adr/0013-coach-agent-loop.md`, `docs/adr/0014-coach-memory-proposals.md`, and `docs/testing.md` before editing.
- Read `tests/live/coach.live.test.ts`, `tests/live/gate.ts`, and `tests/integration/coach/harness.ts` before `eval-core`.
- `trace`, `lab`, and `optimizer` read `~/dotfiles/packages/orchestrator/skills/how/SKILL.md` over `src/lib/server/agent` first. `optimizer` reads `~/dotfiles/packages/orchestrator/skills/interrogate/SKILL.md` before merge-ready, because its win rule is contested design.
- Keep the decision trail per `~/dotfiles/packages/orchestrator/skills/show-me-your-work/SKILL.md` under `plan/trace-evals/trail.md`.
