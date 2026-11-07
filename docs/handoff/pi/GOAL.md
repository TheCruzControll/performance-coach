# Goal: finish Performance Coach on this Mac under pi

Repo: github.com/TheCruzControll/performance-coach, checkout /Users/franciscruz/playground/performance-coach.
Run it as a standing program with the orchestrator's Orchestrate playbook. Keep a decision trail with show-me-your-work in /Users/franciscruz/playground/pc-scratch/notes.md.

## Done when all four hold, checked on the real artifacts
1. Every non-dropped plan slice merged (`/Users/franciscruz/playground/pc-scratch/bin/slice-counts.py` reports all of them; dropped slices are listed in `plans/dropped.json`).
2. The latest CI run on main is green in every job, including E2E.
3. The M8 councils (`wf/councils.js`) passed after M4 and again at the end, against the bar the owner gives.
4. `docs/handoff/HANDOFF.md` on the handoff branch describes the finished state.

## Owner decisions 2026-11-07
- **A. Skip the email sign-in link.** Slices `email-link-endpoints`, `email-link-signin` and `docs-email-security` are dropped (`plans/dropped.json`). The merged email pieces stay on main, switched off. PR #188 is closed. Dependants are still built and skip the email-link part, noting it under "## Owner decisions".
- **B. Test on the real app, heavy tests in CI.** Agents run only lint, check and unit tests locally (integration only for migrations or db-layer changes). CI runs e2e, Lighthouse, builds and budgets. Sol review must still pass. After the push, `wf/dag-cloud.js` waits for the PR's CI, and for UI slices a separate agent clicks through the production build in headed Chromium. A PR is ready only when CI is green and the click-through passed or does not apply.

- **C. Drop the security-change emails** (`auth-change-email`, in `plans/dropped.json`). **Backups stay off** until the owner says otherwise; backup slices are still built, switched off. **Offline**: the owner does not need an offline mode but keeps what is built; do not add offline scope beyond the plan.

## Sources of truth, in order
- `git show origin/handoff:docs/handoff/HANDOFF.md`. Read "Final state, 2026-11-07" and "The owner's rules" first.
- `docs/handoff/pi/README.md` on the handoff branch: how the harness runs under pi.
- `/Users/franciscruz/playground/pc-scratch/PLAN.md`: this machine's plan and the owner's answers.

Where they disagree about this Mac, PLAN.md and the pi README win. For the product, the owner's rules and the plans win.

## Already set up
- Scratch at ~/playground/pc-scratch: `bin/` tools, `plans/`, `waves/`, `wf/dag-cloud.js`, `wf/councils.js`, `wf/build-plan-wave.py`.
- Worktrees go in ~/playground/pc-wt.
- One Postgres 18 on 5432 (role coach). Node 22 via nvm.
- Workflow args reach the scripts as a JSON string. The scripts parse it.

## Start with (resume of the 2026-11-07 19:15 UTC pause)
The top section of HANDOFF.md on origin/handoff ("Mac + pi session, paused") lists the in-flight work. Read it first.
1. Check `pgrep caffeinate` and `status/run.sh` are running; start them if not (`nohup caffeinate -ims -t 259200 &`, `status/run.sh`).
2. #212 (`m3/45-adjust-skip`): a fresh fixer for its red E2E serial test (`e2e/adjust-skip.serial.e2e.ts:250`), then a Sol round on the fix, then CI, then merge.
3. Start four waves at once from the prepared args (they resume the pushed in-flight branches from their worktrees):
   - `waves/m4-r2.json` (limit 1): sync-status (squash its `fixup!` commits first and rerun `verification/workout-sync/check.sh`), exercise-navigation, run-logging, other-logging.
   - `waves/m3-r2.json` (limit 1): build-my-program, today-sessions, perf-program-screens, docs-data-model, program-journey, docs-m3-status.
   - `waves/m9-r2.json` (limit 2): the backup/restore chain (backups stay off) and recovery-codes-120-bit.
   - `waves/m5-r2.json` (limit 2): the next coach slices.
   Rebuild an args file with `wf/build-plan-wave.py` if a branch merged or a PR opened since it was written.
4. After sync-status merges: one click-through agent over the whole /workout screen (owed for #192, #197, #198, #204, #209), headed Chromium at iPhone size and 1440x900, findings fixed as their own PRs.
5. Keep four waves going: as a wave ends, start the next in plan order (rest of M4, M2X desktop screens, M6, M7, rest of M5 and M9). M8 councils after M4 and at the end.

## How
- **Waves.** Build waves with `build-plan-wave.py --only` listing exactly the wanted slices, so each wave ends by itself.
  - Run up to 4 waves at once (owner, 2026-11-08: push the parallelism): screen chains at limit 1, backend waves at limit 2, about 6 agents. Drop a wave if free disk < 8 GB, memory pressure is red, or PRs queue for CI more than 30 minutes.
  - Use limit 1 for chains that edit the same screens: onboarding, Today, Train session, workout shell. Use limit 2 otherwise.
- **Budget.** 5-6 agents in total, and 2 heavy-command slots (`SLOT_COUNT=2`). Drop to 3 agents if free disk falls under 8 GB or memory pressure turns red.
- **Models.** Opus implements and Sol (`openai/gpt-6.1-sol`) reviews. Never use the same model family for both. Every PR body ends "Created with Claude Opus 5.5 in pi."
- **Merges.** One at a time, from the main session, through `bin/steward-plan`.
  - Run `bin/docs-guard-check.sh <branch>` before every merge.
  - Merge with `gh api -X PUT repos/TheCruzControll/performance-coach/pulls/N/merge`, passing `sha` and `commit_title` "Merge <PR title> (#N)".
  - Watch with `bin/wait-ready.sh` in a background_task. Use goal_wait while CI runs instead of polling.
- **Conflicts.** A merge agent resolves the conflict, then a separate verifier agent checks the result before anything is pushed.
- **Lessons.** Follow the handoff's lessons: migration-number collisions, WebKit with a service worker and `page.route`, and markdown-only staleness.
- **HANDOFF.md.** Update it on the handoff branch after every wave, and before you stop.

## Ask the owner first (ask_user_question)
- Deleting real data.
- Resetting the Neon `preview` branch.
- Spending money.
- Touching anything outside this repo.
- Setting OWNER_EMAIL.
- The M8 council bar, when M4 lands.

## Never
- Print or use the owner setup token.
- Merge #13.
- Merge #157 without the owner's say.
- Skip, weaken or quarantine a test to get green.

## Build around these (don't block on them)
- BLOB_READ_WRITE_TOKEN
- RESEND_API_KEY
- Lighthouse TBT (#122)
- The council bar

## If usage runs out
When any agent, workflow or your own turn fails with a usage, quota or rate-limit error (e.g. "hit your weekly limit", "usage limit", "insufficient_quota", HTTP 429 that persists past one retry):
1. Start nothing new: no wave, no agent, no merge.
2. Follow the orchestrator's Pause safely playbook: cancel background watchers, record every in-flight slice (branch, worktree, last step, PR) in notes.md, and push a HANDOFF.md update to the handoff branch if the run can still make tool calls.
3. End the turn without goal_complete, goal_blocked or goal_wait. pi-goal marks the goal `usage_limited` and stops all automatic turns; the owner clears or resumes it.

Everything else is yours to decide. Don't ask whether to keep going. Use goal_blocked only when the same external blocker recurs three turns in a row.
