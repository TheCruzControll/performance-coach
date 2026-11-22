---
name: run-queue
description: Work through the build queue in plan/queue.md, several slices at a time, taking each from spec to a merged and deployed pull request. Use when asked to run the queue, work the backlog, keep building, or build the app unattended, and as the command given to /loop.
---

# Run the queue

`plan/queue.md` is the list of work. This skill is the dispatcher: it keeps several rows moving at
once, each in its own git worktree, and merges them in small trains, one train at a time, as they pass. Called under
`/loop`, it keeps going until nothing is left that it can act on.

You, the session running this skill, own every row. The `builder`, `reviewer` and `ci-triage`
agents do the writing and reading in the background; you write the specs, check what they return,
and make every merge decision. A subagent never starts another agent, so all dispatching happens
here.

## How much runs at once

| Stage                                  | At once | What limits it                                        |
| -------------------------------------- | ------- | ----------------------------------------------------- |
| Local: spec, build, review, fix rounds | 3 rows  | Your attention and context, not the machine           |
| Waiting on CI                          | 6 rows  | GitHub's runner queue                                  |
| Merge and deploy                       | 1 train | Each merge is a production deploy that must be checked |

Agents are light: the model runs in the cloud. What is heavy is a full suite, a build or
Playwright, and none of those run on this machine (see `feature-slice`). So three rows in the
local stage means up to three background agents and three worktrees, plus narrow checks.

These numbers are the settings. Lower them if agents start failing, if CI runs queue for more than
a few minutes, or if you lose track of a row. Raise the local number only after a run where three
rows went through cleanly.

## Where state lives

Parallel rows cannot all edit one file on their own branches, so live state is not kept in
`plan/queue.md` while rows are in flight.

- **`plan/queue.md` on `main`** is the plan: the rows, their order, their dependencies, and the
  statuses only the owner or a housekeeping change sets (`ready`, `needs-spec`, `owner`, `hold`,
  `parked`, `merged`). A slice's branch never edits it.
- **GitHub** is the truth for anything with a pull request. Look a row up by its branch
  (`gh pr list --head <branch> --state all --json number,state,headRefOid,mergedAt`): merged means
  the row is done, open means it is in flight, whatever the file says.
- **`plan/.loop-state.json`** (git-ignored, in the main checkout) holds what GitHub cannot: for
  each row in flight, its worktree path, its stage, the commit the last review approved, the fix
  rounds used, its boarding SHA once it is ready, and a note; and the train in flight, with its
  pull request, its branch and each row's boarding SHA. Write it after every step. A new session reads it to carry on. If it
  is lost, nothing breaks: rows with an open pull request are found on GitHub and reviewed again.
- **`plan/.loop-log.md`** (git-ignored) is the running log and the lessons, one line each, newest
  first.

**Housekeeping.** When the loop stops, and after every ten rows merged, put the accumulated changes
into `plan/queue.md` in one small pull request (`chore(plan): queue housekeeping`): mark merged
rows `merged`, parked rows `parked` with their reason, and copy the new log lines and lessons in.
It goes through the same path and gate as any slice. Update `docs/progress.md` in the same pull
request when the merges changed what it says.

## Each call

### 1. Read the state

- Read `plan/queue.md`, `plan/.loop-state.json` and the top of `plan/.loop-log.md`.
- `git fetch origin`, then fast-forward the main checkout (`git pull --ff-only origin main` there),
  so the skills and the queue you read are the newest. If it will not fast-forward because another
  session has changes there, leave it, read `plan/queue.md` and the skills from `origin/main`
  instead (`git show origin/main:<path>`), and say so in the log.
- Reconcile with GitHub: for every row in the state file and every `pr-open` row, look up its pull
  request. A row whose pull request merged is done. A worktree in the state file with no agent
  running and no stage recorded as waiting is a row a previous session left mid-step; read its
  diff and carry on from there.
- Look for a train in flight: the state file, and `gh pr list --state open --head` for any
  `train/` branch (`gh pr list --state open --json headRefName,number`). If one is open, a train is
  in flight.
- Check production: the newest `Post-deploy smoke` run should be complete and passing
  (`gh run list --workflow "Post-deploy smoke" --limit 3`). If the last one failed, stop here and
  tell the owner. Nothing merges on top of a broken production.

### 2. Merge what is ready, as a train

A merge needs CI to have passed on the tree that lands, and a full run is 28 jobs. Merging rows
one by one costs a rebase and a full run per row. So rows merge together: a train is one branch
that holds several ready rows on top of the current `main`, tested once and merged once. One
train is one CI run, one deploy and one post-deploy check, for up to four rows.

First read each waiting row's checks (`gh pr checks <number>`).

- **Still running:** leave it.
- **A check failed:** start a `ci-triage` agent for it in the background (`feature-slice` step 7)
  and move on. A `REAL` verdict turns into a fix round, which needs a local slot.
- **All green:** the row is ready to board when all of these hold, and then its head
  (`gh pr view <number> --json headRefOid`) is its boarding SHA, recorded in the state file:
  - its head is the commit its last review approved, or a clean rebase or merge of `main` into it
    with no other change;
  - its checks passed on that head;
  - its pull request's base is `main`. A stacked row (base is another row's branch) does not
    board: once the row beneath it has merged, retarget it (`gh pr edit <number> --base main`),
    bring it up to date, and review the result before it boards;
  - every line of `feature-slice` step 9 that concerns the row itself holds: its queue status is
    not `hold` or `owner`, it is not a stop-for-the-owner case, it does not change
    `plan/queue.md`, and it names its journey. Its branch need not contain `main`.

When no train is in flight (step 1 found none) and at least one row is ready:

1. **Build it.** In a worktree of its own (`../pc-wt/loop-train`), create `train/<date>-<n>` from
   `origin/main`. Merge the ready rows into it in queue order, at most four, each by its boarding
   SHA: `git merge --no-ff <boarding sha> -m "Merge <PR title> (#<number>)"`. After each merge,
   `git diff --name-only HEAD^1 HEAD` must list only files in `gh pr diff <number> --name-only`.
   If a merge conflicts, or the diff lists more, undo it (`git merge --abort` or
   `git reset --hard HEAD^1`) and leave the row out: it goes back to the local stage to be brought
   up to date and reviewed again. Never resolve a conflict on a train.
2. **Open it.** Push the branch and open a pull request titled `train: #<a>, #<b>, #<c>`, whose
   description lists each row with its pull request, boarding SHA, reviewer verdict and journey.
   Record the train in the state file. A train of one row is that row's own pull request instead:
   bring its branch up to date with `main`, push, and merge it with `feature-slice` step 9's own
   command and subject.
3. **Wait for its run,** using the time for other work. A train is not reviewed again: it holds
   only reviewed heads and clean merges.
4. **If a check fails,** brief `ci-triage` with the train's rows and each row's files, and ask it
   to name the row the failure belongs to. A flake is re-run. A real failure: close the train's
   pull request, send that row back for a fix round, and build the next train from the rest. If
   triage cannot tell, close the train and build one smaller train from the first half; the rest
   wait for the next train. If every row passes alone but not together, the later row goes back
   to its local stage.
5. **When it is green,** apply `feature-slice` steps 8 to 10 to the train: confirm in the train's
   run that every row's journey ran and passed, check the gate's lines about checks, `main`, proof
   and deploys on the train's branch, and merge it with
   `gh pr merge <train> --merge --subject "Merge train: #<a>, #<b>, #<c> (#<train>)"`. Confirm
   each row's pull request now shows `MERGED` (`gh pr view <number> --json state`); if one does
   not, build no further train, log it and tell the owner, because step 1 would treat that row as
   still in flight. Wait for `Post-deploy smoke`, then remove `../pc-wt/loop-train` and delete the
   train branch, local and remote.

**A train that falls behind.** If `main` moves while a train is in flight, do not rebase the
train: close its pull request, delete its branch, and build a new train from the new `main`.

Only one train is ever in flight. Rows that become ready meanwhile wait for the next one. Do not
add to a train after its run has started, and do not push to a branch that is on a train.

After a train merges, rows still in flight are behind `main`. Bring a row up to date straight away
only if the train touched files that row also changes (`gh pr diff <number> --name-only` against
the merged files), so a conflict surfaces early. Otherwise leave it: its next train handles it.

**Keep CI runs few.** Every push of a code change starts a full run, and about 20 jobs run at
once across all pull requests. Push a row once per review round, never to see what CI says about
unfinished work. Before pushing code, check the runner queue (`gh run list --status queued`):
when more than two runs of code changes are waiting, do local work first. Cancel a run that can
no longer matter (`gh run cancel <id>`): a closed pull request's, or one on a head you are about
to replace. Never cancel a run on `main`.

### 3. Fill the local slots

While fewer than three rows are in the local stage and fewer than six are waiting on CI, take the
next row, top to bottom, that you can act on:

- `pr-open`: an existing pull request to finish.
- `ready`: a specified slice whose dependencies are all merged.
- `needs-spec`: as `ready`, but you write the spec first from the source its note names.

Skip `owner`, `hold`, `parked` and `merged` rows, rows whose dependencies are not merged, and rows
already in flight. Open pull requests come before new work.

**Do not run two rows that change the same files in the local stage together.** Before starting a
row, list the files it will touch (the pull request's files, or the files the spec names) and
compare them with every row now in the local stage. If they overlap, skip to the next row and come
back to this one when the other has been pushed. Two builders editing the same file in different
worktrees produce two pull requests that cannot both merge without one being redone.

For each row you start:

1. Create its worktree: `git worktree add ../pc-wt/loop-<row id with slashes as dashes> <branch>`,
   from `origin/main` for a new slice or from the pull request's branch for an existing one. Run
   `pnpm install --frozen-lockfile` in it. Record the row in the state file.
2. Follow `feature-slice` for it from step 1, in that worktree. Start its agents in the
   background, with the worktree's absolute path at the top of every brief, and tell each agent to
   work only there.
3. Do not wait. Go on to the next free slot.

Then handle notifications as agents finish: read the builder's diff, send it to review, verify
the reviewer's findings, start a fix round, or push and open the pull request. Each row moves one
step per notification. When a row's pull request is open and CI is running, it leaves the local
stage and its slot is free.

Keep the rows straight. Every brief names its row and its worktree. When a report comes back,
match it to its row in the state file before acting on it, and update the state file before you
start the next step. If you are unsure which row a finding belongs to, re-read the report; do not
guess.

- A `pr-open` row enters `feature-slice` at its review step. First bring its branch up to date
  with `main` in the worktree, so the review and CI see what would merge. A pull request that only
  needed a rebase is still reviewed before it merges; it was written before the current `main`.
- A row for verifying a milestone uses the `milestone-verifier` agent, then records the evidence
  in `docs/milestones.md` and `docs/progress.md` as a docs pull request through the same path.
- A row marked L, or too large for one pull request, is split first: replace it with smaller rows
  in the next housekeeping change, each with its own spec, and take the first.

`feature-slice` carries the limits for each row: heavy work in CI, two fix rounds, the merge gate,
and the wait for the post-deploy check. Do not loosen them here.

### 4. Record

After every step, write the row's new stage to `plan/.loop-state.json` and add a line to
`plan/.loop-log.md`: the time, the row, what happened, and the pull request.

- parked after two fix rounds, or blocked on a decision: note the reason and what would unblock
  it, leave the pull request open, and free the slot
- needs something only the owner has: note what is needed, free the slot

When a row's pull request has merged and its deploy is confirmed, remove its worktree
(`git worktree remove ../pc-wt/loop-<id>`), but only a worktree this loop created and only when
`git status` there is clean. Leave any other worktree alone.

### 5. Learn

After each row, ask what would have made it go better, and write it under Lessons in the log when
the answer is specific: a check the builder skipped, a finding the reviewer raised that a rule
would have prevented, a flaky test `ci-triage` identified, a step in a skill that was wrong.

When the same lesson is there twice, act on it instead of writing it a third time. Edit the file
that would have prevented it (`.claude/agents/builder.md`, `.claude/agents/reviewer.md`,
`feature-slice`, this skill, a verification skill, `CLAUDE.md`, or a lint rule or test when the
lesson can be enforced in code), as its own small pull request through the same path. Prefer a
check that fails over a sentence that asks.

## When to stop

Stop the loop, and tell the owner why, when any of these is true:

- No row can be acted on and none is in flight. Say which rows are waiting on the owner and what
  each needs.
- A post-deploy check failed. This one is urgent: say so first, with the run link.
- Three rows in a row were parked. Something systematic is wrong, such as a broken `main`, a
  failing environment, or specs that are too loose, and more attempts will not fix it.
- The owner said stop, or a row needs a decision only they can make and nothing else is ready.

Before stopping, do the housekeeping change described above, so `plan/queue.md` on `main` says
what happened.

Under `/loop`, end the loop when you stop. Otherwise schedule the next call: at once when a slot
is free and a row is ready, or in about ten minutes when everything in flight is waiting on CI or
on an agent. A full CI run takes roughly fifteen to twenty minutes.

If `PushNotification` is available, send one line when the loop stops and for each merge. An
overnight run should leave the owner a short summary at the top of the log they can read in a
minute: what merged, what was parked and why, and what is waiting on them.

## What this skill never does

- Merge outside `feature-slice`'s gate, push to `main`, or force-push `main`.
- Merge two trains without confirming the first one's deploy in between, or put more than four
  rows on one train.
- Resolve a conflict on a train, or push to a branch that is on a train.
- Roll back production, change environment variables, or touch Neon or Vercel settings.
- Run a full suite, a build or Playwright on this machine.
- Put two rows that change the same files in the local stage together.
- Edit `plan/queue.md` on a slice's branch, or change a `hold` or `owner` row's status.
- Remove a worktree it did not create, or one with uncommitted changes.
