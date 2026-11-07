# Running the slice harness in pi

The cloud session built slices with `workflows/dag-cloud.js` on a Linux container. This directory
is the same harness ported to the owner's Mac and pi's `SubagentWorkflow` tool. The limiter, the
dependency graph, the mutation check, the Sol fix loop, the gates and the schemas are unchanged.
What changed is the machine, the GitHub write path, the models and the branding.

## Owner decisions, 2026-11-07

**A. Skip the email sign-in link.** `email-link-endpoints`, `email-link-signin` and
`docs-email-security` are dropped. The merged email config, mailer, schema and service stay on
main, switched off, and PR #188 is closed. `docs/handoff/plans/dropped.json` is the one list of
dropped slices (with `required-steps-not-skippable`), read by `build-plan-wave.py`,
`slice-counts.py` and the status collector. A dropped slice satisfies a dependency like a merged
one, is left out of every total (402 slices, not 405), and shows grey as "dropped" on the status
page. `build-plan-wave.py` gives every slice that names a dropped dependency an `extra` line,
derived from the plans and `dropped.json`. The line tells the implementer to skip the email
link's screen, routes and docs and to say so under "## Owner decisions" in the PR body.

**B. Test on the real app, heavy tests in CI.** The owner's laptop is spared heavy runs.

- Local gates for the implementer and every fixer are `pnpm lint`, `slot pnpm check` and
  `pnpm test:unit`. `pnpm test:integration` (and `db:drift`) runs locally only for
  `migration: true` slices or diffs that touch `src/lib/server/db`. No local Playwright,
  Lighthouse, builds or budgets. The mutation check and the rule that a regression test must
  fail without its fix stay.
- After Sol approves and the PR is pushed, a watcher runs `tools/wait-ci.sh <pr> <head>`. It
  polls the required checks every 3 minutes for up to 60 minutes. A red check goes to a fresh
  fixer with the failing job's log (`gh run view --log-failed`). The fixer pushes a new commit
  (never a rebase: other slices stack on the branch) and fresh Sol rounds review the fix diff,
  then CI runs again. A third red CI round hands the PR to the main thread.
- Then, for `ui` slices and slices whose acceptance names on-screen behaviour (the wave's
  `clickThrough` flag), a fresh Opus verifier builds the Node server (`slot pnpm build:node`),
  starts it on the slice's e2e port and database the way `e2e/global-setup.ts` does, with a
  throwaway setup token, and drives headed Chromium through Playwright's library at the iPhone
  viewport and at 1440 x 900. Screenshots go to `<scratch>/shots/<slug>/`, and their paths and
  one line per acceptance item go into the PR body under "## Click-through". `gh` cannot upload
  images, so they are not posted. A failed item goes back through a fixer and Sol like a red CI
  run, at most 3 times.
- Each wave result now carries `ci`, `clickThrough` (`pass`, `fail`, `n/a`, or `not run` when CI
  or Sol stopped first), `ready` and `needs`. A PR is ready only when CI is green and the
  click-through passed or is `n/a`. Dependants still stack as soon as the PR exists. They do not
  wait for its CI.

## Layout

- `wf/dag-cloud.js` builds slices. It is `dag-cloud-resume.js` with paths taken from `args`, so
  `args.resume` (optional) still continues a slice's Sol loop from a given round.
- `wf/councils.js` runs the M8 performance and design councils.
- `wf/build-plan-wave.py` writes a wave's args from a plan and GitHub's PR state.
- `wf/test/stub-harness.mjs` runs both scripts against stub hooks. It spawns no agents.
- `tools/` is the scratch `bin/` with real paths and a `slot` that fails instead of running
  unlimited. `tools/wait-ci.sh` is the CI watcher's poll loop.
- `status/` is the local status page (`run.sh` serves it on 127.0.0.1:8765 and refreshes every
  60 s). Its `vendor/` scripts (cytoscape, dagre, cytoscape-dagre) are not committed. Copy them
  from npm into `<scratch>/status/vendor/`.
- `../plans/dropped.json` lists the dropped slices.

## Setup (once)

```sh
S=~/playground/pc-scratch
mkdir -p $S/bin $S/plans $S/wf $S/waves ~/playground/pc-wt
cp docs/handoff/pi/tools/* $S/bin/
cp docs/handoff/plans/*.json docs/handoff/briefs/m2-onboarding-plan.json $S/plans/
cp -R docs/handoff/pi/wf/* $S/wf/
mkdir -p $S/status && cp docs/handoff/pi/status/* $S/status/
node $S/wf/test/stub-harness.mjs
```

Postgres 18 (Homebrew) must run on localhost:5432 with role coach/coach and `max_connections`
300. Use Node 22 (`nvm use 22`). `gh` must be authenticated as TheCruzControll.

## Run a wave

1. Build the args. `--only` is an allow-list, so the wave holds exactly the slices named. The
   script exits non-zero when a named slice cannot join, and says why.

   ```sh
   cd ~/playground/pc-scratch
   python3 wf/build-plan-wave.py m4-plan.json M4 m4.json m4s 4900 --limit 2 \
     --only workout-shell,start-kit > waves/m4-shell.json
   ```

2. Ask pi to run `SubagentWorkflow` with `scriptPath` `~/playground/pc-scratch/wf/dag-cloud.js`
   and `args` set to the contents of that file. The args carry `scratch`, `repo` and `worktrees`.
3. The main thread alone watches PRs. Use `bin/wait-ready.sh` or `bin/steward-plan --dry-run`,
   and run `bin/docs-guard-check.sh <branch>` before every merge. Children never merge.
4. Resume with `resumeFromRunId` only for a `limit: 1` run in the same pi session. pi's journal
   is per session and prefix-based. Otherwise build a fresh wave. A slice whose worktree or branch
   exists resumes from it through the implementer's RESUME CHECK.

## Budget

The owner allows 5 to 6 agents at once in total on this 8-CPU, 8 GB Mac, and 2 heavy commands at
once (`SLOT_COUNT=2`). A wave's `limit` is its agent count, so keep the sum of running waves'
limits within that budget. pi also caps one workflow at 6 agents. `slot` exits 75 without running
the command after `SLOT_MAX_WAIT_MS` (12 minutes by default). Agents are told to retry through
`slot`, never around it.

## Models

Opus writes every commit: `anthropic/claude-opus-5-5`, effort `high` for auth, security, data
loss and concurrency slices and `medium` otherwise. The CI watcher is Opus on `low`, and the
click-through verifier is a separate Opus agent on `medium`. Sol reviews: `openai/gpt-6.1-sol`, effort
`xhigh` for that class and `high` otherwise. The item's `effort` field is the Sol effort, and
`build-plan-wave.py` sets it to `xhigh` for migrations and for tracks named for auth, security,
backup, restore, sync or platform. Councils alternate Opus and Sol judges, with a Sol chair and
Opus implementers.

Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR bodies end with
`Reviewed with sol-review: <N> rounds with GPT-6.1 Sol on <effort>. Sol verdict: approved` (or
the docs-only line) and then `Created with Claude Opus 5.5 in pi.` PRs are created with
`gh pr create --body-file`.

## Retired, and why

- `tools/pg18` and the second integration run. The Mac's one Postgres is 18, the version CI and
  production run, so the suite runs once.
- `tools/drain-monitor.py`. It stopped waves that held more slices than wanted. Allow-listed
  waves hold exactly the slices wanted.
- `workflows/build-finish.py`. It rebuilt a script from the Linux session's journals. pi resumes
  with `resumeFromRunId`, and a fresh allow-listed wave resumes slices from their worktrees.
- `workflows/dag-cloud-resume.js` as a separate script. `dag-cloud.js` takes `args.resume`.
- The GitHub MCP, ToolSearch, the `Claude-Session` trailer and the claude.ai footer.

Not ported: `tools/wait-publish.py` still reads the cloud journal's event format, which was not
checked against pi's `<run id>.workflow.jsonl`. The other workflows in `workflows/` were not
ported.
