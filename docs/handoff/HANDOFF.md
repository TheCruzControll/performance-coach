# Performance Coach: handoff (cloud session wound down on 2026-11-07; the final state is the first section)

This is everything a new Claude Code session needs to resume the build on another machine. The
product spec is `docs/product-requirements.md` on `main`; milestone criteria are in
`docs/milestones.md`. Read this file from `origin/handoff` (it is not on `main`).

## Mac + pi session, paused 2026-11-07 19:15 UTC (read this first)

The owner paused the Mac + pi build at 19:15 UTC. It continues in a Claude cloud session, driven
from the owner's phone. This section is the current state. The sections below it are history.
The goal file is `docs/handoff/pi/GOAL.md`. The decision trail is `docs/handoff/pi/notes.md`.
Both are copies of the Mac scratch files at the pause.

### Status at the pause

From `slice-counts.py` at 19:15 UTC. Dropped slices are left out of every total.

| Milestone | Merged / total | Dropped |
| --- | --- | --- |
| M2 | 28 / 28 | 1 |
| M2X | 11 / 18 | 3 |
| M3 | 43 / 50 | 0 |
| M4 | 29 / 61 | 0 |
| M5 | 23 / 61 | 0 |
| M6 | 11 / 63 | 0 |
| M7 | 0 / 59 | 0 |
| M9 | 10 / 61 | 1 |
| All | 155 of 401 | 5 |

Open PRs are #212 (`m3/45-adjust-skip`) and #13 (this branch, never merge it). The session merged
26 PRs. They are #157 and #186 through #211, except the closed #188. No wave or agent is running.

In-flight branches. All are pushed to origin. Only adjust-skip has a PR.

| Branch (head) | Stage | Next step |
| --- | --- | --- |
| `m3/45-adjust-skip` (9a07998), PR #212 | Sol approved. Click-through passed on iPhone 15 Pro and 1440x900. CI red. Both E2E serial legs fail `e2e/adjust-skip.serial.e2e.ts:250`, "Adjust left open while another tab skips the session: Reload closes it onto the skipped state" (deep equality). The wave's fix loop was stopped before it pushed. | Fresh fixer with `gh run view 42401737652 --log-failed`. New commit, no rebase. Sol round on the fix diff, then CI green, then merge. |
| `m3/42-build-my-program` (62f2410) | Implemented in 2 commits. Local gates and mutation check pass. Sol approved round 1 at 62f2410. Not published. | Open the PR against main. Wait for CI. Click-through (UI slice). Merge. |
| `m3/48-docs-data-model` (5687595) | Docs only. Local gates pass. Claims checked against merged code. No Sol review yet. | Sol review of the claims (as #186 had), `docs-guard-check.sh`, open the PR, CI, merge. |
| `m4/32-sync-status` (ee7bff9) | Implemented with the F1 fix. Sol approved round 4 (xhigh) at ee7bff9, all 7 findings resolved. Carries 9 `fixup!` commits because the publish rebase was aborted at the pause. Not published. | `git rebase -i --autosquash origin/main` (or merge main). Confirm the tree matches what Sol approved. Rerun the light gates and `verification/workout-sync/check.sh`. Push, open the PR, CI, click-through, merge. |
| `m4/33-exercise-navigation` (c339ba5) | Implemented. Local gates, integration and mutation checks pass. No Sol review yet. It moves `upNext` out of `flow.ts`. | Sol loop, then publish, CI, click-through, merge. |
| `m9/12-restore-schema-step` (6156747) | One `wip` commit, paused mid-implementation. Ungated. The M9 wave `wf_9c9c3e4e2fe0` left no journal. | Resume it through the implementer's RESUME CHECK in a fresh M9 wave. Backups stay off. |

The M4 slices #192 workout-shell, #197 strength-view, #198 sync wiring, #204 log-set and #209
set-actions merged on the old script without a click-through. `/workout` is dark-launched and
nothing links to it. One click-through pass over the workout screen is owed.

### The owner's decisions, 2026-11-07

- The email sign-in link is dropped. #188 is closed. The merged email pieces stay on main,
  switched off.
- The security-change emails (`auth-change-email`) are dropped.
- Backups are built but stay off until the owner adds `BLOB_READ_WRITE_TOKEN`.
- Desktop WebKit tests are dropped (#190). Chrome for iOS is WebKit, so the iPhone WebKit tests
  stay. Desktop Chrome is Chromium.
- The owner does not want an offline mode. Keep what is built. Add no offline scope.
- #157 was merged on the owner's say.
- The Lighthouse TBT limit stays as it is.
- Heavy tests (e2e, Lighthouse, builds, budgets) run in CI only. Locally, agents run lint,
  check and unit tests, plus integration for db or migration slices.
- Sol review must pass. Then CI must be green. Then, for UI slices, a separate agent clicks
  through the real production build in headed Chromium at iPhone size and at 1440x900. It
  records pass or fail per acceptance item in the PR body, with screenshots. On the Mac, `gh`
  could not upload images, so the bodies list screenshot paths.
- Up to 3 waves run at once. Screen chains run at limit 1, backend waves at limit 2.
- The never list and the ask-first list in `GOAL.md` still hold.

### How to resume in a Claude cloud session

1. Read this file from `origin/handoff`, then `docs/handoff/pi/GOAL.md` and `docs/handoff/pi/notes.md`.
2. Set up the container as in "How a new session resumes" in the 08:41 UTC section below.
   Start Postgres 16 with `max_connections` 300 and `docs/handoff/tools/pg18` (Postgres 18, as
   CI and Neon run), or adjust if the container differs. Copy `docs/handoff/pi/tools/*` and
   `docs/handoff/tools/pg18` to `<scratch>/bin/`, and `docs/handoff/plans/*` to `<scratch>/plans/`.
3. Port the workflow. `docs/handoff/workflows/dag-cloud.js` is the original cloud script and runs
   under Claude's Workflow tool. `docs/handoff/pi/wf/dag-cloud.js` is the pi version with the v2
   gating: light local gates, a CI wait and fix loop, and the click-through verifier. Its
   prompts are the best spec of the current process. Port them into the cloud script. Change the
   paths, `gh` versus the GitHub MCP, and the model names. Sol reviews through the sol-review
   skill's route available in the cloud. The Workflow tool only loads a `scriptPath` inside the
   working directory or the scratchpad.
4. Fix the CI wait before relying on it. `wait-ci.sh` polls `gh pr checks --required`. The
   required check "E2E (iPhone viewport · Chromium + WebKit)" only appears after the E2E legs
   finish. On #212 the watcher saw 4 required checks pass at 18:38 and reported green. The E2E
   legs failed at 18:40 and 18:42 and the aggregate check went red at 18:46. Wait for that check
   by name.
5. Build each wave with `build-plan-wave.py` and `plans/dropped.json`. Pass `--only` to bound it.
   `plans/m4-plan.json` on this branch already carries the dependency fix (M2X names, 646ca01).
6. Merge one PR at a time through `steward-plan` (from `docs/handoff/pi/tools`). Run
   `docs-guard-check.sh <branch>` before each merge. Merge with the head SHA and the title "Merge <PR title> (#N)".

### Next work, in order

1. Finish the five in-flight branches and #212, per the table above.
2. The owed click-through over the workout screen (#192, #197, #198, #204, #209).
3. The rest of the M4 chain. `sync-status` and `exercise-navigation` are in flight. Then
   `run-logging`, `other-logging`, then `start-kit` and the rest in plan order.
4. M3's remaining Today and Train slices.
5. The M9 backup and restore chain. Build it, switched off.
6. Then M5, M6, M7 and M9 in plan order.
7. M8 councils (`wf/councils.js`) after M4 and again at the end. The owner gives the bar.

### Lessons from this session

- Starting or replacing a `/goal` reloads pi and kills every background agent, watcher and wave.
- pi passes workflow args as a JSON string. The scripts parse either form.
- BSD `paste` needs `-` to read stdin. `wait-ready.sh` printed usage on every pass until fixed.
- The parallel E2E legs (#189) took PR E2E from about 39 to about 14 minutes.
- Stacked workout slices kept hitting semantic conflicts (#197 with #198, #204 with #209). A test
  that compares text across a reload must wait for the lazily loaded logger first.
- The WebKit onboarding flake was a hover preload cancelled by the next navigation. Fixed in #191.
- `/workout` reached 58.7 KB against the plan's 53.8 KB allocation. The 60 KB gate is the guard
  and the plan figure is runway. #194 cut shared entry JS from 47.7 to 44.5 KB rather than raise
  allowances. A 4 KB cut was not reachable without framework changes (measured).
- The TLA+ check (#187) runs with `verification/workout-sync/check.sh`, skill
  `.pi/skills/verify-workout-sync`. It found F1, a discarded change landing after a newer one.
  `m4/32-sync-status` fixes it and updates `verification/workout-sync`.
- GitHub "dirty" on a stacked branch often merges cleanly locally. Check `git merge-tree` before
  sending a conflict agent.
- A CI watcher on required checks alone can report green before the E2E aggregate exists (#212).

## Final state, 2026-11-07 08:41 UTC (superseded by the Mac + pi session above)

The owner asked to finish the work in progress, start nothing new, and update this file. That is
done. Every slice that was being built when they asked now has a PR, and every PR is merged. #184 and #185 were merged at the owner's request
while their E2E job was still running (every other check was green and Sol had approved): check
that job and `main`'s first CI run below. No new wave was started.

|                                   |                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------ |
| On `main`                         | **134 of 405 slices** (91 at the previous hand-off)                            |
| Merged since 2026-11-06 23:41 UTC | **43 PRs**, #142 → #185                                                        |
| Open PRs                          | only #13 (this branch, never merged) and #157 (the owner's call)               |
| Closed                            | #14, the old paused onboarding WIP, now that every onboarding slice has landed |
| Running                           | nothing: no workflow, watcher or wave                                          |

### Slices on main, by milestone (`tools/slice-counts.py`)

| Milestone | On main | Not started | Plan                                  |
| --------- | ------: | ----------: | ------------------------------------- |
| M2        |      27 |           1 | `briefs/m2-onboarding-plan.json` (28) |
| M2X       |      11 |          10 | `plans/m2x-plan.json` (21)            |
| M3        |      42 |           8 | `plans/m3-plan.json` (50)             |
| M4        |      24 |          37 | `plans/m4-plan.json` (61)             |
| M5        |      10 |          51 | `plans/m5-plan.json` (61)             |
| M6        |      11 |          52 | `plans/m6-plan.json` (63)             |
| M7        |       0 |          59 | `plans/m7-plan.json` (59)             |
| M9        |       9 |          53 | `plans/m9-plan.json` (62)             |
| **Total** | **134** |     **271** | 405 slices                            |

M1 is done. M8 has no slice plan: it runs `workflows/councils.js` after M4 and again at the end.

### What merged (#142 → #185)

| Milestone                  | PRs                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M2 Onboarding              | #155 guided setup, #167 save on leave, #172 review every answer, #173 Today "finish setting up", #178 pick up where you left off, #181 Today goals and week shape. **M2 is 27 of 28 done**; only `docs-profile` is left. |
| M2X Desktop and email link | #161 email-link schema, #166 desktop main screens, #179 desktop Chromium + WebKit projects, #180 email-link service                                                                                                      |
| M3 Programs                | #144 preferences link, #156 programming service, #159 swap/adjust edits, #169 program history, #177 swap an exercise                                                                                                     |
| M4 Workouts                | #143 log-gaps service, #151 sync ledger, #154 reconcile and tabs, #158 mutation schemas, #165 pain reports, #175 `POST /api/workouts/sync`, #182 canonical reads, #184 run and other-session handlers                    |
| M5 Coach                   | #153 safety rules, #162 prompt layout, #171 agent orchestrator, #183 proposal payloads                                                                                                                                   |
| M6 Analytics               | #142 running, #147 strength, #150 workload, #152 chart tokens, #164 metric catalogue, #168 test support, #185 progression rules                                                                                          |
| M9 Hardening               | #145 docs guards, #146 restore order, #148 report skeletons, #149 backup format, #160 envelope, #163 journey matrix, #170 Blob store, #174 backup config, #176 export                                                    |

### What stopped, and what it left

- **The container restarted at about 05:10 UTC** and killed all seven waves, the two fix workflows and every watcher. Nothing was lost: each slice's worktree survived with its commits and uncommitted work. `workflows/build-finish.py` built one workflow (`wave-finish.js`) from the dead waves' items. It held only the 9 slices that were in flight, plus the #172 and #173 fixes, and resumed each from its worktree through the implementer's RESUME CHECK. All 9 were approved by Sol (1–2 rounds each) and published as #177–#185.
- **Started after the owner's request, then stopped before any push:** `restore-schema-step` and `backup-run-service` (M9 wave). Their worktrees were not kept; start them fresh.
- **Not started, ready now** (all dependencies merged; `slice-counts.py` prints the full lists):
  - **M2** (1): `docs-profile`
  - **M2X** (10): `desk-profile`, `desk-onboarding`, `email-link-endpoints`, `email-link-signin`, `docs-email-security`, `desk-train-week`, …
  - **M3** (8): `today-lazy-panels`, `build-my-program`, `adjust-skip`, `today-sessions`, `perf-program-screens`, `docs-data-model`, …
  - **M4** (37): `workout-shell`, `workout-sync-wiring`, `start-kit`, `strength-view`, `log-set`, `perf-set-logging`, …
  - **M5** (51): `proposal-diff`, `provider-selection`, `coach-bundle-guards`, `anthropic-provider`, `coach-conversations-db`, `coach-proposals-db`, …
  - **M6** (52): `chart-kit-core`, `analytics-facts`, `line-chart`, `analytics-plans`, `strength-dashboard-service`, `running-dashboard-service`, …
  - **M7** (59): `m7-contract`, `periodisation-scenarios`, `week-evaluation`, `train-week-findings`, `m7-stage-list`, `load-systems`, …
  - **M9** (53): `e2e-ci-capacity`, `lighthouse-ci-capacity`, `restore-schema-step`, `backup-run-service`, `restore-rows`, `backup-cron-endpoint`, …

### How a new session resumes

The steps in the 2026-11-06 section below still hold. These are the additions:

1. **Tools added to `tools/`:**
   - `wait-ready.sh`: the watcher. It runs `steward-plan` every 3 minutes and exits only on an `ACTION`, a red check or a conflict. List the PR numbers of PRs being fixed in `<scratch>/wait-ignore.txt` so it doesn't stop on them.
   - `docs-guard-check.sh <branch>`: run it before every merge. It merges the branch onto main in a scratch worktree and runs the 81 docs-guard tests (ADR index, citations, environment rows, milestones, layout rules, reports).
   - `drain-monitor.py`: the wind-down monitor. It reports when every allowed slice of a wave has published, so the wave can be stopped.
   - `steward-plan` now merges a PR whose only staleness is markdown that main changed, provided it still merges cleanly. The docs guard checks the result first.
2. **To finish slices after a crash,** use `workflows/build-finish.py`. It builds one script from `wave-M5b.js`'s body, with `A.items` = the in-flight slices and their unmerged dependencies as `external`. Then run it with `limit` 5. Don't `resumeFromRunId` the old waves: they would go on to start new slices.
3. **Waves to build next:** use `build-plan-wave.py`. Its "ready now" lists are above. M2's `docs-profile` and M2X's email-link endpoints and sign-in are short, so do them first. Then build M4's `workout-shell` chain, M5's `anthropic-provider` → `coach-turn` chain, and M9's `e2e-ci-capacity`, which the E2E job's 40-minute timeout depends on.

### Waiting on the owner

- **Vercel Blob for backups (new):** create a private Blob store and put `BLOB_READ_WRITE_TOKEN` in Production, next to `BACKUP_ENCRYPTION_KEY`. #170 and #174 are merged and the code never reads the environment itself. Backups stay switched off (never the app) until both variables are set. Creating the store may need the paid plan; the session must ask before spending.
- **Email sign-in link:** add `RESEND_API_KEY` (Production, Sensitive). #180 is merged; without the key the link is switched off.
- **#157:** a test-only fix from another Claude session (lock-race refusals in the auth tests). It's green and needs a Sol review or the owner's call before it merges. The steward never merges it alone.
- **Lighthouse TBT (#122), the M8 council bar and the plan defaults:** see the 2026-11-06 list below; nothing there changed.
- **Never merge #13** (this branch).

### Lessons from this wind-down

- **A container restart kills every background task but keeps the disk.** Worktrees, the scratchpad, Postgres data and journals all survive. Restart Postgres (`service postgresql start` and `tools/pg18`), then rebuild one finish workflow from the worktrees. Slices resume cleanly because the implementer brief starts with a RESUME CHECK.
- **Parallel onboarding slices conflicted for real, three times.** #172 conflicted with #167, and #178 with #172, in `Step.svelte`, `+page.svelte` and `onboarding.serial.e2e.ts`. Each fix was a merge agent followed by an independent verify agent, with the push only after the verifier approved. Each combination also needed one real change that neither PR had:
  - Back from a review edit has to return to the review (`target()` appends `&then=review`).
  - The welcome step opened from the review must not show the resume card.

  Order onboarding-like chains with limit 1, or stack them.

- **A late paint is an LCP regression even when FCP is fine.** On #173, `/today` had FCP 906 ms but LCP 2785 ms: the setup card's copy paragraph painted after hydration. The fix renders it in the first paint. Lighthouse (median of 5) caught it; the local e2e budget did not.
- **Main moving only under markdown no longer forces a CI rerun.** The steward used to refresh such PRs one at a time, about 25 minutes each. Now it merges them once `docs-guard-check.sh` passes on the merged tree. That rule cut most refreshes in this wind-down.
- **Migration numbers collide when two PRs add a migration.** #165 collided with #161. To fix: take main's `drizzle/meta`, delete the PR's migration files, run `drizzle-kit generate --name X` then `--custom --name X_guards`, restore the guard SQL and run `db:drift`.
- **A watcher's regex matched a PR title.** Its pattern for a failing check also matched "error" in #166's title "…and error states…". The watcher now matches `ci (failure|failed|error|…)` only.

## Wind-down, 2026-11-06 23:41 UTC (superseded by the 2026-11-07 final state above)

The owner asked to finish only the work already in progress and then hand off. That is done: every
run that was building a slice has finished or been stopped, every PR it produced is merged, and no
slice was started until the owner asked to resume. Production runs `main` on coach.nikocruz.com
(`/api/health` at 22:00 UTC: `ok`, db up, version `0.1.0+6d76691`).

### Merged during the wind-down (20:10 → 23:41 UTC)

| Milestone    | PRs                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| M2 Profile   | #73 basics, #74 specifics, #76 body, #77 general goals, #81 injuries, #83 exercises, #84 goal status, #89 schedule, #93 goal order, #104 goal drag |
| M2X Desktop  | #132 sign-in, setup and recovery on desktop, #138 desktop sheets, hover and focus states                                                           |
| M3 Programs  | #125 session detail, #128 plan overview, #140 move a session                                                                                       |
| M4 Workout   | #134 run and other-session rules, #137 log-gaps schema, #139 substitution and pain rules                                                           |
| M5 Coach     | #131 typed coach tools, #136 coach analytics service                                                                                               |
| M6 Analytics | #130 trend classifier, #133 prescribed vs actual, #135 adherence                                                                                   |
| CI           | #141 the E2E job gets 40 minutes (see the lessons below)                                                                                           |

### Still open at hand-off

None apart from #13 (this branch, never merged) and #14 (the old paused onboarding WIP).

### Build resumed (23:20 UTC): the owner set the goal "finish the app"

Seven waves of `dag-cloud.js` run with 12 agents in total. Their scripts are `<scratch>/wave-<M>.js`: `dag-cloud-resume.js` with the args embedded, built by `workflows/build-plan-wave.py`.

| Wave | Run               | Limit | Slices                                                                                                                                                                                              |
| ---- | ----------------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M9   | `wf_f88f2fc2-e2a` |     2 | report-skeletons, docs-guards, the backup pipeline (format, envelope, store, export, config, run service, CLI) and the restore steps                                                                |
| M2   | `wf_8031ff65-d34` |     2 | onboarding-flow, today-setup, save-on-leave, resume, review, today-summary, docs-profile                                                                                                            |
| M3   | `wf_37e7ec18-88f` |     2 | preferences-link, programming-service, edit-swap-adjust, swap-exercise, program-history, adjust-skip                                                                                                |
| M4   | `wf_be1afe62-090` |     2 | reconcile-and-tabs, log-gaps-service, mutation-schemas, sync-ledger-db, pain-reports-db, sync-endpoint, canonical-reads, run-other-handlers, start-kit, workout-history-data, exercise-library-json |
| M6   | `wf_986bf2b8-9c1` |     2 | strength, running and workload analytics, metric-catalogue, chart-tokens, progression-rules, test support, the review snapshot and composers                                                        |
| M2X  | `wf_99857716-c45` |     1 | desk-main-screens, desk-e2e, the email sign-in link (schema, service, endpoints, sign-in), docs-email-security                                                                                      |
| M5   | `wf_a3136819-aa6` |     1 | coach-safety-rules, prompt-layout, agent-orchestrator                                                                                                                                               |

If this session stops, do not resume these runs (their limit is above 1). Rebuild each wave with `build-plan-wave.py`. Slices with a PR become dependencies, and a slice whose worktree exists resumes from it.

### Slices on main, by milestone (from `tools/slice-counts.py`)

| Milestone | On main | Open PR | Not started | Plan                                  |
| --------- | ------: | ------: | ----------: | ------------------------------------- |
| M2        |      21 |       0 |           7 | `briefs/m2-onboarding-plan.json` (28) |
| M2X       |       7 |       0 |          14 | `plans/m2x-plan.json` (21)            |
| M3        |      37 |       0 |          13 | `plans/m3-plan.json` (50)             |
| M4        |      16 |       0 |          45 | `plans/m4-plan.json` (61)             |
| M5        |       6 |       0 |          55 | `plans/m5-plan.json` (61)             |
| M6        |       4 |       0 |          59 | `plans/m6-plan.json` (63)             |
| M7        |       0 |       0 |          59 | `plans/m7-plan.json` (59)             |
| M9        |       0 |       0 |          62 | `plans/m9-plan.json` (62)             |
| **Total** |  **91** |   **0** |     **314** | 405 slices                            |

M1 is done (its audit is in `plans/m1-audit.json`). M8 has no slice plan: it runs
`workflows/councils.js` after M4 and again at the end (the owner passes the bar as `args.bar`).

### What was stopped, and what it left

- **M4 wave C2** (`wf_35eac1e9-b9e`) published #134 and #137, then kept starting slices: its
  concurrency limit was 2, so whenever a slot freed it took the next ready slice. It was stopped at
  21:22 with `reconcile-and-tabs` and `log-gaps-service` just begun, and `substitution-rules`
  waiting behind them for its second review. `workflows/dag-cloud-resume.js` then finished
  substitution-rules on its own: a fresh reviewer for round 2 approved, and it was published as
  #139.
- **M2X wave X1** (`wf_8b198cf0-2e4`) was stopped while `desk-main-screens` was being read in.
  Desk-primitives was published by a one-agent workflow (#138).
- **M3 wave B3** (`wf_f5435f32-765`) was stopped at 21:55, right after it published move-session
  (#140) and began `program-history`.
- **None of the stopped slices left any work**: their worktrees had no commits, no staged files and
  no changes, and were removed. A new session starts `desk-main-screens`, `reconcile-and-tabs`,
  `log-gaps-service` and `program-history` from scratch.
- M5 wave D2, M6 wave F1, the profile chain and the planner (M9 plan) all finished on their own.

### How a new session resumes

1. Read this file from `origin/handoff`. Copy `docs/handoff/tools/*` to `<scratch>/bin/` and
   `docs/handoff/plans/*` to `<scratch>/plans/`. Start Postgres 16 (raise `max_connections` to 300)
   and `tools/pg18` (Postgres 18, which CI and Neon run).
2. **Merge what is open** with `tools/steward-plan` (one PR per pass). Merge through the GitHub MCP
   `merge_pull_request` with `expectedHeadSha` and the title `Merge <PR title> (#N)`.
   `tools/wait-steward` re-runs the plan every 3 minutes and exits on an `ACTION` line, a failure or
   a new PR.
3. **Build the next wave** with `workflows/build-plan-wave.py <plan> <M> <brief> <slug> <port>`
   (M2X, M4–M9) or `workflows/build-dag-args.py` (M2, M3). Slices that already have a PR become
   external dependencies. Then run `workflows/dag-cloud.js` (replace `<scratch>` and `<repo>`).
   Ready next, in plan order:
   - **M2:** `onboarding-flow`, `today-setup`, `onboarding-save-on-leave`, `onboarding-resume`,
     `onboarding-review`, `today-summary`, `docs-profile` (after #89, #93, #104 merge).
   - **M3:** `preferences-link`, `programming-service`, `edit-swap-adjust`, `program-history`,
     `swap-exercise`, `adjust-skip`, `today-sessions`, `build-my-program`, …
   - **M2X:** `desk-main-screens`, `desk-e2e`, `desk-profile`, `desk-onboarding`, then the email
     sign-in link (`email-link-schema` → `email-link-service` → `email-link-endpoints` →
     `email-link-signin`). The link needs `RESEND_API_KEY` from the owner.
   - **M4:** `reconcile-and-tabs`, `log-gaps-service`, `mutation-schemas`, `sync-ledger-db`,
     `pain-reports-db`, `sync-endpoint`, `canonical-reads`, `workout-shell`, …
   - **M5–M7, M9:** follow each plan's order; `build-plan-wave.py` works out which are ready.
4. **To wind a wave down**, stop it as soon as its last wanted slice is past implementation. Then
   finish any slice that is mid-review with `workflows/dag-cloud-resume.js`: give it
   `resume: {<id>: {impl, round, ledger, prevHead, head}}`, taken from the stopped run's
   `journal.jsonl`. A `limit: 2` wave otherwise keeps starting new slices.

### Waiting on the owner

- **Email sign-in link:** create a Resend account and add `RESEND_API_KEY` (Production,
  Sensitive). The session asks before setting `OWNER_EMAIL`.
- **Lighthouse:** TBT on `/` was 316 ms on one shared-runner sample (#122; the budget is 300).
  Raise the CI run count, loosen TBT for CI, or accept it. Separately, patch `scripts/lighthouse.ts`
  to count a same-frame LCP candidate 1 µs after FCP as FCP, or accept a rare red Lighthouse run.
- **M8:** the council bar (`args.bar`), before the first council after M4.
- **Plan defaults** (each slice lists its own under "## Owner decisions"; none blocks).
  `open-questions/` holds every milestone's list: M2X, M4, M5, M6, M7 (21) and M9 (26). Defaults
  added in this wind-down:
  - #140 move-session: the session screen's initial JS grows to 57.9 KB, so the session ceiling
    rises to 58 KB. A move stays within its week, and an interference warning never blocks one.
    The History link in its toast waits for m3/44.
  - #139 substitution rules: "Just swap it today" re-sends a refused dislike with reason
    `situational`, not `dislike`.
  - #138 desktop sheets: Train's route CSS is 13.6 of 14 KB. Two review nits stay open as
    follow-ups: focus falls back to the first open sheet instead of the last, and hover overrides
    `:active`.
  - #136 coach analytics: a trend under 3 % counts as flat, the load window is 56 days, and the
    trend window is 8 weeks.
  - #132 desktop sign-in: tablets keep the phone layout, and the desktop card is 28 rem wide.
- **Never merge #13** (this branch). **#14** is the old paused onboarding WIP; close it once the
  onboarding slices land.

### Lessons from the wind-down

- **GitHub's "dirty" on stacked branches is often not real.** After a chain link merges, GitHub
  marks the next links dirty, and its update-branch call refuses ("merge conflict between base and
  head"), even when `git merge-tree --write-tree origin/main origin/<branch>` merges cleanly. The
  cause is criss-cross merge history. Merge main in locally, run lint, check and unit, and push.
  Merge the chain from the top down, refreshing the next link after each merge (as #89 → #93 →
  #104 were).
- **The WebKit and service worker rule caught a fourth PR.** #132's routed sign-in test failed only
  on WebKit, the same cause as #117, #125 and #128. The rule is in `dag-cloud.js`, but waves started
  before 18:46 run `dag-cloud-pre1846.js`, which lacks it. Before CI, check any new spec that uses
  `page.route` for `serviceWorkers: 'block'`.
- **Real conflicts can come from a chain's own fixes.** #84 carried a Tabs fix (the pill as the
  moving box, so its spring never widens a 393 px page). That conflicted with #138's
  `pointer-events: none`. Keep main's fix and re-apply the PR's line, then run `primitives.desktop`
  and `design-program` (the 393 px test).
- **The E2E job outgrew its timeout.** Both engines run on one worker. With the Profile and desktop specs the suite grew from 14 to 22–25 minutes, so the 25-minute job timeout cancelled passing runs on #89, #104 and #140, mid-suite with nothing failed. #141 raised it to 40 minutes. M9's `e2e-ci-capacity` (parallel legs, measured ceilings) is the real fix: schedule it early. A PR's run takes the workflow from its merge commit, so after such a fix lands, merge main into each affected branch to rerun it.
- **A merge call can time out and still not merge.** Check `origin/main` before retrying.

## Cloud session log, 2026-11-06 (06:28 → 20:10 UTC)

A claude.ai cloud session (4 CPUs, 15 GB, Linux; no T3, no Codex) is working the goal "finish
M1–M9 on main with evidence and the app live on coach.nikocruz.com". State at 20:10 UTC:

- **Production is live** on coach.nikocruz.com since the cutover (#50, 07:13 UTC); every merge to
  `main` deploys it, and the post-deploy smoke check runs after each deploy.
- **Owner setup done** (10:43 UTC) on the owner's iPhone 16 Pro Max, iOS 27.0.1, in **Chrome for
  iOS** (the browser they use; WebKit engine). Passkey and recovery codes stored;
  `OWNER_SETUP_TOKEN_HASH` cleared in Vercel (an empty value; the owner deletes the variable when
  at a desk). The real-device checklist passed in Chrome; record it in M2's docs PR and change the
  checklist in `docs/testing.md` to target Chrome for iOS (Add to Home Screen optional).
- **Merged today: 76 PRs.** By 13:40: #12, #18–#47, #50–#67, #69–#72, #75, #78–#80, #82, #85, #87,
  #88. Since: #68 (ranked goals), #86 (section pages load no editor CSS), #91 (e2e fixture programs
  and full M3 reset), #92 (week-1 loads), #94 (history queries), #95 (program versions), #96
  (desktop rules), #97 (weekly volume), #98 (M4 timers), #99 (e2e race fixes), #100 (week
  placement), #101 (M5 coach contracts), #102 (M4 outbox rules), then #90 (M4 icon sprite, with a
  real WebKit fix: leaving detection now lives in `app.html`'s inline script), #103, #105–#116.
  Since 17:45: #118 (set prefill), #119 (M6 analytics foundation), #120 (on-device workout store),
  #121 (coach markdown), #122 (leaving + version.json fix), #123 (LlmProvider + MockProvider),
  #124 (mail layer), #117 (Train week), #126 (workout flow), #127 (sync engine), #129 (workout
  summary). **69 of 328 planned slices are on main** (M7 added 59). `curl -sI
https://coach.nikocruz.com` at 19:46 UTC: `HTTP/2 200`.
- **Usage limit, 19:20–20:00 UTC**: the owner's weekly usage limit stopped every subagent ("You've
  hit your weekly limit · resets 8pm (UTC)"), then the session's worker restarted. After the restart
  the primary working directory is `/workspace` (empty) and the new scratchpad is
  `/tmp/claude-0/-workspace/<session>/scratchpad`; the repo (`/home/user/performance-coach`), the
  old scratchpad (`<scratch>` below, with worktrees, env files, plans, tools) and the workflow
  journals all survived. Postgres 16 had stopped: `pg_ctlcluster 16 main start`, then `<scratch>/bin/pg18`.
  The Workflow tool only loads a `scriptPath` inside the working directory or the new scratchpad,
  so the scripts were copied to `<new scratch>/wf/`.
- **Status page for the owner's phone** (private artifact, republished from the session):
  https://claude.ai/artifact/JDAZPdKRPVXrQ7ZgScuLHR. Built by `<scratch>/status/status.py` then
  `to_artifact.py`; a new session republishes it by passing that URL as `url`.
- **Plans** (all in `plans/`): `m3-plan.json`, `m2x-plan.json` (21 slices), `m4-plan.json` (61),
  `m5-plan.json` (61), `m6-plan.json` (63), `m7-plan.json` (59). The planner (`milestone-plans-cloud.js`,
  run `wf_3f53c5db-7bb`, resumed at 20:01) is revising M9. Its `write:` step refuses to retype a 150 KB plan, so take the
  final plan from its journal (the `revise:M<n>#2` result) with a script and save it to `plans/`. Each plan's `openQuestions` are answered with defaults; slices list the default
  under "## Owner decisions" in their PR.

### Open PRs and how they merge

- **Profile chain** (they add entries to the same section registries): `workflows/profile-chain.js`
  (run `wf_ee68f6ee-303`) restacked #73 → #74 → #76 → #77 → #81 → #83 → #84 → #89 → #93 as one
  chain on main + #86: each link merges main and the previous link and resolves the registry
  conflicts (keep every entry), a fresh reviewer reads the remerge-diff and full gates run while
  the next link stacks. Every link was reviewed (APPROVE) and passed full gates; fixes on #74 and
  #84 were cascaded down locally before the usage limit stopped it at the push. Its resume re-ran
  finished steps (see the resume rule below), so it was stopped and `workflows/profile-chain-finish.js`
  (run `wf_73d5b399-642`, started 20:05) finishes it: merge current main into #73 and carry it down
  the chain with lint + check per link and full gates at #93, push in order (fast-forward), update
  each PR body ("Depends on" the previous link, no "Merge hold:"), then audit. Until it pushes the
  PRs are held in `<scratch>/steward-hold`; remove those lines after the push and the steward
  merges them in order.
  **#104** (goal drag) is built on the old #93 and is restacked onto the new one after that.
- **#125** (session detail) and **#128** (plan overview) were cut from #117 before its WebKit fix.
  Fixed by hand at 19:58 (6c482cf, feb708d): main merged in and the routed tests moved into a
  describe that blocks the service worker; the specs passed 59/59 and 56/56 on Chromium with
  `--repeat-each=3`. CI (with WebKit) running at 20:10; the steward merges them when green.
- **Never merge #13** (this branch). **#14** is an old paused WIP branch; leave it.

### Rules learned today (now in `workflows/dag-cloud.js`'s instructions)

- **One query at a time per Executor** (#62): never `Promise.all` over one `db` handle or
  transaction; the integration suite fails any test that does.
- **Postgres 18 locally**: CI and Neon run 18, the container's server is 16, and they differ (an ON
  DELETE RESTRICT refusal is 23001 on 18, 23503 on 16). `tools/pg18` starts an embedded Postgres
  18 on port 5433 (binaries in `/var/lib/pg18`, from npm `@embedded-postgres/linux-x64`); gates
  run the integration suite on both; `tests/integration/helpers.ts` has `restrictRefusalCode`.
- **Lazy imports get no JS modulepreload** (one rule in `vite.config.ts`): WebKit keeps a failed
  modulepreload stuck (bug 270357), so Retry could never load a lazy chunk on Safari/Chrome iOS.
- **Profile section editors stay out of the server build** (#86): SvelteKit links the CSS of every
  dynamic import the server build can reach, render-blocking; `pnpm budgets` now guards it.
- **WebKit + service worker + `page.route`**: on WebKit, `page.route` does not see requests from a
  page the app's service worker controls (it calls `clients.claim()`), so a test that holds or fails
  `__data.json` must run in a describe with `test.use({ serviceWorkers: 'block' })` (#117).
- **WebKit's `document.fonts.ready`** resolves only after the load event; tests that hold a request
  wait on `document.fonts.status === 'loaded'` instead (Playwright's screenshots await `ready`).
- **Lighthouse LCP artefact** (found on #90, main is equally exposed): Chrome truncates the FCP
  trace timestamp through seconds-as-double, so at some runner uptimes LCP lands 1 µs after FCP
  for the same frame and Lantern takes its slow path (≈2.5 s simulated LCP on `/profile`). It shows
  when CI's apt step runs slow and the audits start late. Owner decision pending (below).
- **Lost runners**: a job "cancelled" at its timeout with no log and no artifacts is a lost runner;
  re-runs are refused to this integration, so bring main in (a real change) for a fresh run.
- **GitHub pagination**: `gh api --paginate` follows `repositories/<id>/...` links that the
  session's proxy refuses; page by number (`&page=N`) instead (`build-plan-wave.py` does).
- **Shared docs** (`docs/testing.md`, `security.md`, `performance.md`, `milestones.md`): code
  slices put their lines in a "## Docs to add" section of the PR body; each milestone's docs PR
  collects them from the merged PRs.
- **Workflow resume is prefix-based**: a resumed run replays cached agents only while its agent()
  calls happen in the same order as before. A pipelined or `limit > 1` run calls agents in a
  timing-dependent order, so its resume re-runs finished steps (seen on the profile chain and C1b).
  Resume only sequential runs (`limit: 1`); otherwise start a fresh wave with `build-plan-wave.py`
  (slices that already have a PR become external dependencies; a slice whose worktree exists
  resumes from it). Editing a script also changes every prompt after the edit.
- **Stacked history**: a PR built on another slice's branch shows "dirty" on GitHub once that
  slice merges, though `git merge-tree` merges it cleanly; merge main into it locally, run quick
  checks on its files, push. `tools/steward-plan` also passes a PR whose head already holds all of
  main (merging main changes nothing) without another refresh.

### Running workflows (scripts in `workflows/`, args in `<scratch>/dag-*.json`)

At 20:10 UTC (`dag-cloud.js` unless noted; scripts copied to `<new scratch>/wf/`):

- C2 `wf_35eac1e9-b9e` (M4: run/other rules, substitutions, reconcile and tabs, log gaps, sync
  ledger, pain reports, sync endpoint, canonical reads, start kit, workout history, library JSON),
  fresh at 20:06.
- D1 `wf_08f629f2-6f6` (M5 tool framework, publishing), X1 `wf_8b198cf0-2e4` (M2X desktop auth
  screens publish, primitives, main screens, desktop e2e), F1 `wf_c5e1e5d9-cc8` (M6 trend
  classifier publish, prescribed vs actual, adherence), all resumed at 20:01 from
  `dag-cloud-pre1846.js` (the script text they started with).
- B3 `wf_f5435f32-765` (M3 move-session, then program-history); profile-chain-finish
  `wf_73d5b399-642`; planner `wf_3f53c5db-7bb` (M9).
  Agent cap: 12 (owner-approved). `build-plan-wave.py <plan> <M> <brief> <slug> <port>` builds a
  wave's args from any milestone plan. Next once the profile chain is pushed: M3 `preferences-link`
  (on #83) and M2 `onboarding-flow` (on the whole chain), then Today setup, onboarding save/resume/
  review, Today summary and M2's docs PR.

### Waiting on the owner

- Email sign-in link: create a Resend account and add `RESEND_API_KEY` (Production, Sensitive);
  the session asks before setting `OWNER_EMAIL`.
- M8: the council bar (`args.bar`), asked when M4 lands. M8/M9: real-traffic Core Web Vitals at
  p75 and the owner's sign-off.
- **Lighthouse TBT** (#122): one shared-runner sample put `/` at 316 ms TBT (budget 300) on code
  byte-identical to runs at 16–76 ms. Raise the CI run count, loosen TBT for CI, or accept it.
- **M7 plan defaults** (21, in `<scratch>/m7-open-questions.md`), e.g. event lead windows (fight 8
  weeks, half 12, marathon 16, meet 10, other race 6) and same-day order by goal rank, 6 h apart.
- **Lighthouse gate**: patch `scripts/lighthouse.ts` to treat a same-frame LCP candidate 1 µs after
  FCP as FCP (a measurement correction, with a test), or accept a rare red Lighthouse run.
- Defaults to confirm (none blocking; each PR's "## Owner decisions"): tablet 640–1023 px keeps the
  bottom bar and Security stays one column on desktop (#96); default rests 3:00/2:00/1:30/1:00
  (#98); coach off = every turn refused, tagged-label answers (#101); a failing change is parked
  after 50 failures or 24 h, backoff 1–60 s (#102); assisted/bodyweight logging rules (#103); the
  plans' `openQuestions`, e.g. M2X link lifetime; #73's coach units vs device units; #63's restore
  of a retired custom exercise name.

To resume in a fresh cloud session: copy `tools/*` to `<scratch>/bin`, `plans/*` to
`<scratch>/plans`, start Postgres 16 (raise `max_connections` to 300) and `tools/pg18`, then build
wave args with `workflows/build-plan-wave.py` (M2X/M4/M5…) or `build-dag-args.py` (M2/M3) and run
`workflows/dag-cloud.js` (paths replaced) once per wave. Branches with PRs become external
dependencies; a slice whose branch exists resumes from it.

## The owner's rules (follow them exactly)

- **Small atomic PRs.** One concern each, green on its own, ideally ≤ 600 lines of non-test code.
  Real tests that prove behaviour; a regression test must fail without its fix.
- **Merge each PR when it is green, with a merge commit** titled `Merge <PR title> (#N)`. Ask first
  only before deleting real data, spending money beyond the free plans, or touching anything
  outside this project.
- **Every PR goes through the owner's three skills** (user-level skills in `~/.claude/skills/`;
  install them on the new machine, or ask the owner for them):
  - `/sol-review`: Sol (GPT Sol, currently `gpt-6.1-sol`) reviews the branch in a fix loop until it
    approves. Effort `xhigh` for auth, security, data loss and concurrency, `high` otherwise.
    Docs-only PRs skip it. Workflow agents cannot use T3's `delegate_task` (it fails with
    `parent_not_active`), so they use the skill's Codex CLI route (`codex exec … -s read-only`).
  - `/file-pr`: title is a concise human-readable Conventional Commit that says why it matters. The
    body opens with the problem in plain words, then the change (no inventory), a short "Tests"
    section, then one `Depends on #N.` line per unmerged dependency, then
    `Reviewed with sol-review: <N> rounds with <model> on <effort>. Sol verdict: approved` (or
    `sol-review: not applicable (docs only).`), and last `Created with <model> in Claude Code.`
  - `/babysit-pr`: only the main thread watches PRs (`watch_pull_request` in T3 Code); children
    never do. Before every merge: never merge DIRTY or BEHIND, or when a `main` commit that landed
    after the last green run touches the PR's files. Refresh the branch and wait for green again.
- **Commits:** Conventional Commits, a plain-prose body, and the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No AI model names anywhere else.
- **Agent load:** on the old Mac (8 GB RAM) the owner capped it at **8 agents at once** and heavy
  commands (svelte-check, vite build, Playwright) at 2 at a time. Ask the owner what the new
  machine allows before raising either.

> The sections from here down describe the 13:40 UTC state. Their rules, tools and lessons still hold; their status tables and "next steps" are superseded by "Final state" at the top.

## Where things stand

| Area                                       | State                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **M1** Foundation                          | Merged (#1). An independent audit (`plans/m1-audit.json`) found 3 gaps: 2 fixed, 1 (WebKit nav screenshots) WIP |
| **M2** auth + training profile             | Merged (#2–#12)                                                                                                 |
| **M2** security review (15 fixes)          | **All merged** (#18–#20, #23–#31, #34, #35, #40 step-up re-authentication)                                      |
| **M2** input primitives, save path         | Merged: #32, #36, #37, #42. #47 (Toggle + TagInput) open, green, needs a branch refresh                         |
| **M2** Profile editing, onboarding, Today  | Not started, except `m2/21-profile-equipment` (WIP branch). Plan: `briefs/m2-onboarding-plan.json`              |
| **M2** production cutover                  | Branch `feat/m2-production-cutover` (7 commits, Sol round 1 was running). Needs the owner's setup-token hash    |
| **M3** data model and programs (50 slices) | Plan: `plans/m3-plan.json`. Merged #41, #43. Open #45, #46. Six more slices in progress (branches below)        |
| **M4–M7, M9**                              | Briefs in `briefs/`; not yet planned into slices                                                                |
| **M8** councils                            | `workflows/councils.js`; the bar is held privately by the owner (pass it as `args.bar`)                         |

Production is still off: `vercel.json` keeps `main` from deploying until the cutover PR merges.

### Open PRs

| PR  | What                                 | State                                                      |
| --- | ------------------------------------ | ---------------------------------------------------------- |
| #47 | feat(ui): Toggle switch and TagInput | Green, Sol approved; refresh from `main`, merge **first**  |
| #45 | M3 exercise catalogue part 1         | Refreshed, CI was running; Sol approved                    |
| #46 | M3 program-plan contract             | Green, Sol approved; refresh from `main`                   |
| #13 | this handoff (branch `handoff`)      | Keep open; never merge it with the steward                 |
| #14 | the old WIP onboarding PR            | Close it once the Profile and onboarding slices replace it |

### Pushed branches without a PR yet

Every one is on `origin`. "WIP" means the last commit is `wip(handoff): …`: unfinished, ungated and
unreviewed. Fold it into a real commit (or redo it) before publishing.

| Branch                                      | State                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `feat/m2-production-cutover`                | Implemented and gated; Sol round 1 was running when paused. Finish Sol, PR |
| `fix/m1-screenshots-after-view-transitions` | Implemented; needs mutation check, Sol, PR                                 |
| `fix/m1-today-train-next-step-copy`         | Implemented; needs Sol, PR                                                 |
| `ci/m1-keep-server-log-and-main-runs`       | Implemented; workflow YAML, Sol not applicable; PR                         |
| `ci/m1-actions-node-24`                     | Implemented; workflow YAML, Sol not applicable; PR                         |
| `fix/m1-one-query-at-a-time-per-client`     | Implemented (3 commits); needs mutation check, Sol, PR                     |
| `m2/21-profile-equipment`                   | WIP (stacked on #42 and #47)                                               |
| `m3/02-train-headroom`                      | Implemented, plus a WIP commit from a resume                               |
| `m3/04-training-metrics`                    | WIP (stacked on #46)                                                       |
| `m3/06-exercise-catalogue-upper`            | Implementation in progress (stacked on #45)                                |
| `m3/08-describe-prescriptions`              | Started from #46; no own commits yet                                       |
| `m3/11-exercise-library-db`                 | WIP (stacked on #43 and #45); adds a migration                             |

## Next steps, in order

1. **Set up the machine** (see "How to work" below), then copy `docs/handoff/tools/*` into your
   scratchpad's `bin/` and run `steward --dry-run` from the repo.
2. **Drain the merge queue.** Put `47` in `<scratch>/steward-priority`, then run `steward` whenever
   a watched PR wakes you. It refreshes one stale PR at a time and merges what is ready.
3. **Production cutover.** Finish `feat/m2-production-cutover` (`workflows/m2-cutover.js` is the
   prompt that built it). Its PR must carry
   `Merge hold: OWNER_SETUP_TOKEN_HASH must be set in Vercel Production first …`; the steward
   skips any PR with a `Merge hold:` line. Then the owner:
   1. runs `pnpm auth:setup-token` on their own machine (the token never goes in chat);
   2. sets the printed hash as `OWNER_SETUP_TOKEN_HASH` in Vercel → Production (sensitive), or sends
      you only the hash to set;
   3. after the cutover merges and production deploys, opens
      `https://coach.nikocruz.com/setup?token=<token>` on the iPhone, registers the passkey, stores
      the recovery codes, then removes the hash from Vercel.

   **Update 2026-11-06:** the owner has set `OWNER_SETUP_TOKEN_HASH` in Vercel Production and
   holds the link, so the PR needs no merge hold. Their first try at the link returned Vercel's
   `404 DEPLOYMENT_NOT_FOUND`, as expected with production still off; the token is unused. Remove
   the hold line if the PR has one. If Vercel refuses the production deploy with
   "Resource is limited", wait for the 24-hour window and redeploy.

4. **Resume the build graph.** `workflows/build-dag-args.py` reads the M3 plan, the M2 slice list
   and the M1 items, asks GitHub which branches already have PRs, and emits the graph (merged or
   open slices become external dependencies, the rest become items). Generate a runnable script by
   embedding that JSON as `const DATA` into `workflows/dag-main.js` (replace `args.limit`,
   `args.external`, `args.items` with `DATA.*`) and run it with the Workflow tool. Each item:
   implement (resuming an existing branch or worktree if one exists) → mutation check → Sol fix
   loop → gates → push → PR with one `Depends on #N.` line per open dependency. A priority limiter
   runs the longest dependency chain first, which puts M2's Profile editing ahead of the M3
   backend. Known quirk: the limiter only orders once it is saturated, so the first slots go to
   whatever is ready first; add a tick of delay before dispatch if that matters.
5. **Plan M4, M5, M6, M7 and M9** with `workflows/milestone-slice-plan.js` (two planners →
   synthesizer → completeness critic; pass `{milestone, brief, priorPlans: ['m3-plan.json']}`), then
   add their slices to the graph. M5 (the AI coach) uses the `claude-api` skill; `ANTHROPIC_API_KEY`
   is set in Vercel Production. M8 runs `workflows/councils.js` after M4 and again at the end. M9
   adds backups (Vercel Cron → encrypted export → Vercel Blob), the restore drill and the reports.

## Waiting on the owner

- **The cutover.** The setup token hash is set; once production is live, the owner opens the link.
- **M3 product defaults.** The planner chose these; each is a named constant, cheap to change:
  - a program starts next Monday (the build preview also offers "This week");
  - the first block is 1 baseline + 3 accumulation weeks + a deload, shortened to build + taper
    when the top event is under 6 weeks away;
  - the highest-priority dated goal shapes the block; another event inside it gets a taper week;
  - days per week count fixed commitments (5 days with Muay Thai Tue/Thu leaves 3 free days);
  - unset equipment means a commercial gym; an unset session length is 60 min;
  - session length caps every session except the long run (explained when longer);
  - "Never prescribe this again" swaps every upcoming occurrence in the current program;
  - a move that breaks an interference rule is warned and recorded, not blocked.
- **Resetting the shared `preview` Neon branch.** Per-PR previews applied migrations from unmerged
  branches, so it is in a mixed state. Nothing uses it now. Before any on-demand preview, empty it
  and re-migrate (docs/deployment.md, "Resetting the preview database"). Ask first: it is a Neon
  change, though it only deletes disposable preview data.

## Changes made to the project's settings this session

- GitHub default branch switched from `claude/install-neon-skills` to `main`. That registered the
  Backup workflow (run 42147437996 skipped gracefully without secrets) and turns on Dependabot's
  weekly PRs (Mondays).
- Branch protection on `main`: the 5 CI jobs are required checks, `strict: false`, admins not
  enforced, no required reviews. Auto-merge is not enabled; the steward merges.
- Vercel Git deployments now happen only for `main` (#44: `git.deploymentEnabled` has
  `"**": false`). The Hobby plan caps an account at 100 deployments a day and per-PR previews hit
  it (`api-deployments-free-per-day`). CI runs the Vercel build and the migrations on every PR.
  Vercel reads `vercel.json` from the pushed commit, so **a branch cut before #44 still deploys on
  every push**: merge `main` into it first. Every branch listed above already has it (except the
  superseded `m2/12-onboarding`). The cap is a rolling 24-hour window; the heavy use ended about
  2026-11-06 04:00 UTC. If the cutover's production deploy is refused, redeploy after that, or ask
  the owner about Vercel Pro (it costs money).
- Stale Playwright browser caches were deleted (#21 keys the cache by runner image).

## How to work on it

```sh
nvm use                                # Node 22 (the shell may default to another version)
pnpm install && pnpm db:setup          # local Postgres 16+; the old Mac used Homebrew postgresql@18
pnpm check && pnpm lint && pnpm test:unit && pnpm test:integration
pnpm build && pnpm build:node && pnpm budgets
pnpm test:e2e                          # Chromium; E2E_WEBKIT=1 adds WebKit (CI always runs both)
```

### Tools in `docs/handoff/tools/` (copy them to `<scratch>/bin/`)

- `agent-env <slug> <port>`, run inside a git worktree: installs that worktree's own
  `node_modules`, creates `coach_<slug>_{dev,test,e2e}`, migrates dev, and writes
  `<scratch>/env/<slug>.sh`, which every later command sources. One slug and port per agent.
- `slot <cmd…>`: a machine-wide semaphore for heavy commands (`SLOT_COUNT`, default 2 here).
- `steward [--dry-run]`: the merge gate. In PR-number order (the numbers in `steward-priority`
  first), it merges a PR only when it is open against `main`, has no WIP title and no
  `Merge hold:` line, every `Depends on #N.` is merged, the latest run of each required job passed,
  the body carries the Sol line, and GitHub says clean. Staleness is exact: it compares the tree CI
  tested (head merged with `main` as of the run) with the tree a merge would make now, and counts
  only the PR's own files. It refreshes one stale PR at a time (strict queue, `steward-queue`)
  through GitHub's update-branch. It skips #13 and #14. Set `REPO_DIR` if you run it outside the
  checkout.

### Workflows in `docs/handoff/workflows/`

Replace `<SCRATCH>` and `<REPO>` with your paths first.

- `dag-main.js` + `build-dag-args.py` (+ `m1-items.json`): the build graph (step 4).
- `m2-cutover.js`: the cutover slice's full prompt.
- `milestone-slice-plan.js`: the planner that produced `plans/m3-plan.json`.
- `m1-audit.js`: the M1 audit (its verdict is `plans/m1-audit.json`).
- `councils.js`, `m2-security-fixes.js`, `m2-onboarding-plan.js`, `milestone-build.js`,
  `m2-stack-review.js`: from the earlier session.

## Lessons learned (this session)

**Merging**

- **Shared docs serialise everything.** Nearly every PR edited the same paragraphs of
  `docs/testing.md` and `docs/security.md`, so each merge made every other PR stale and forced
  another CI run. Code slices must not rewrite those paragraphs; add one new line, or land a
  wave's doc updates as one docs PR at the end.
- **Refresh one stale PR at a time.** Refreshing all of them wastes CI, because the next merge
  makes them stale again.
- **Stacked PRs need care.** `gh pr merge` on a stacked PR merges it into its stacked base, not
  `main`. Merge with REST (`PUT /pulls/N/merge` with `sha` and `commit_title`) only when the base is
  `main`. Prefer every PR based on `main` with `Depends on #N.` lines over GitHub base branches.
- **`gh pr create/edit/merge` fail here** with a Projects (classic) GraphQL deprecation error. Use
  `gh api` REST calls.
- **Semantic conflicts happen.** Two PRs, each green on its own, broke together twice: a test
  helper reused a setup token after #19 made tokens single-use, and a fake session lacked step-up's
  new `reauthenticatedAt`. Run the type-check and the tests after every merge of `main` into a
  branch.
- **Migrations clash in parallel.** Two branches both generated `0007`. Renumber the later one: take
  `main`'s journal and snapshot, delete your migration files, `drizzle-kit generate --name …`,
  re-create custom SQL with `--custom`, then verify on a fresh database. The journal order is
  unit-tested.

**CI and infrastructure**

- **Linux WebKit on CI sometimes has no WebAuthn.** The sign-in page then correctly says it
  cannot use passkeys; #39 made the test check real support.
- **Old browser caches broke WebKit** (ICU mismatch between Ubuntu releases). #21 keys the cache by
  `ImageOS`.
- **A CI "failure" is often infrastructure.** Read the job log before touching code: apt timeouts,
  browser downloads, the Vercel deployment cap. Re-run with `gh run rerun <id> --failed`.

**Local machine**

- **macOS WebKit differs from CI's Linux WebKit.** On `main`, three `e2e/shell.e2e.ts` tests fail
  locally only (plate calculator focus, late animation frame, theme before first paint). CI is
  the gate.
- **Give every agent its own worktree, `node_modules`, databases and e2e port.** Raise Postgres
  `max_connections` (300 here).
- **8 GB of RAM could not take 16 agents.** Agents leave Playwright browsers and Node servers
  behind: kill them, and remove worktrees when items finish.
