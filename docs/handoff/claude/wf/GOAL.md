Finish Performance Coach (github.com/TheCruzControll/performance-coach, checkout ~/dev/performance-coach) and make building it faster as you go. Ultracode is on: orchestrate with Workflow runs, verify adversarially, keep the user posted on findings and changes of plan.

DONE when all hold, checked on the real artifacts:
1. Every non-dropped slice in the plans is merged (`python3 /tmp/pc-scratch/bin/slice-counts.py`; dropped slices are in plans/dropped.json).
2. The latest CI run on main is green in every job, including E2E.
3. The M8 councils (performance and design) passed after M4 and again at the end, against the bar the owner gives.
4. docs/handoff/HANDOFF.md on the handoff branch describes the finished state and how this Mac's harness runs.

SOURCES OF TRUTH: the plans (`/tmp/pc-scratch/plans/*-plan.json`, from origin/handoff docs/handoff/plans), docs/product-requirements.md, docs/milestones.md, the owner's rules in origin/handoff HANDOFF.md ("The owner's rules", "The owner's decisions"). Memory: build-harness-on-this-mac.

HOW THE BUILD RUNS (this Mac: 10 CPU, 32 GB; scratch /tmp/pc-scratch, worktrees /tmp/pc-wt, Workflow scripts in .git/pc-wf/):
- Slices are built by the DAG Workflow (`.git/pc-wf/dag-claude.js`; a round embeds its args from `python3 /tmp/pc-scratch/wf/build-all.py --limit N --max M`). Each slice: implement in its own worktree with light local gates and a mutation check, a fresh-reviewer review loop (Claude Opus 5.5; xhigh for auth, security, data loss, concurrency, migrations), then a PR. Dependants stack on open PRs. Screen chains run one at a time.
- 6 agents at once in total across running workflows, 3 heavy-command slots (`slot`). Heavy tests (e2e, Lighthouse, builds, budgets) run in CI only.
- The main thread alone watches and merges: `bin/wait-ready.sh` in the background merges one ready PR per pass (CI green, review line, fresh against main, docs guard, merge commit "Merge <PR title> (#N)") and exits on red CI or a conflict. On red: build args with `python3 /tmp/pc-scratch/bin/repair-args.py [--mode ci|conflict|review] <pr>...` (reads branch and failing jobs from GitHub; never type them by hand) and run `.git/pc-wf/open-prs.js` with them: a fresh fixer, then a fresh reviewer on the fix, then CI again. A leg that only timed out with every test passed gets `gh run rerun <id> --failed` instead. PRs under repair go in /tmp/pc-scratch/wait-ignore.txt. Conflicts: a merge agent resolves, a separate verifier checks before any push.
- When a round finishes, build the next with build-all.py (slices with PRs become dependencies; a slice whose branch or worktree exists resumes from it). Never resume a limit>1 workflow with resumeFromRunId; build a fresh round instead.
- After each screen chain merges (workout, coach, progress, Train, Today), one click-through agent drives the production build in headed Chromium at iPhone 15 Pro and 1440x900; findings become their own fix PRs.

IMPROVE AS YOU GO (standing order; spend real effort here, not just on slices):
- CI wall time is the main bottleneck (a PR run was ~26 min: ~10 min queued for runners under the 20-concurrent-job cap, then ~16 min of jobs; WebKit serial legs 11-13 min; every E2E leg sets up and builds on its own). Keep measuring (`gh run view <id> --json jobs`, step timings, Playwright reports) and land improvements as small PRs: fewer jobs per run, build once and share, faster setup (caches), balanced shards, more workers per runner, skipping work a diff cannot affect (docs-only PRs), anything else measured to help. Target: a typical PR's CI under 10 minutes wall clock without weakening what it proves: never skip, weaken or quarantine a test, never drop an engine or a required check, never loosen a budget. Paid runners: ask the owner first.
- Whenever agents stall, repeat work, hit the same failure twice, or a step in the harness is slow or flaky, fix the harness (agent-env, slot, prompts, watcher, builder, the DAG script) or the repo's developer tooling (scripts, test helpers, docs/development.md) and note it in the handoff. Measure before and after.
- Report each improvement with its measured effect.

ASK THE OWNER FIRST: deleting real data; resetting the Neon preview branch; spending money (paid runners, Vercel or Neon upgrades, turning the live coach on in production); anything outside this repo; setting OWNER_EMAIL; the M8 council bar (when M4 lands).

NEVER: print or use the owner setup token; merge #13 (the handoff PR) or #157 without the owner; skip, weaken or quarantine a test to get green; force-push a branch with a PR (fixes are new commits); mention AI models anywhere except the commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and the PR body's review and "Created with Claude Opus 5.5 in Claude Code." lines.

BUILD AROUND (don't block on): BLOB_READ_WRITE_TOKEN (backups stay off), RESEND_API_KEY (email link dropped), the council bar until M4 lands. Owner-gated slices (coach-launch, preview-e2e-run, restore-drill-record, release-1-0, signoff-record) are built up to the owner step, then wait with a "Merge hold:" line and a question to the owner.

IF /tmp/pc-scratch IS GONE (reboot): copy origin/handoff docs/handoff/claude/tools/* to /tmp/pc-scratch/bin, docs/handoff/plans/* (and briefs/m2-onboarding-plan.json as m2-plan.json) to /tmp/pc-scratch/plans, docs/handoff/claude/wf/build-all.py to /tmp/pc-scratch/wf and the .js files to .git/pc-wf/ (already ported (paths: scratch /tmp/pc-scratch, repo ~/dev/performance-coach, worktrees /tmp/pc-wt; agent-env uses fnm's node 22, PGADMIN_URL, and the explain and backup scratch databases), and rebuild the round from live PR state. Postgres 18 runs as the owner's Homebrew service on localhost:5432 (role coach/coach); it cannot be started from inside Claude.

IF USAGE RUNS OUT: start nothing new, record every in-flight slice (branch, worktree, last step, PR) in HANDOFF.md on the handoff branch, and stop.
