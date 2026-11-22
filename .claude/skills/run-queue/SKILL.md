---
name: run-queue
description: Work through the build queue in plan/queue.md one slice at a time, taking each from spec to a merged and deployed pull request. Use when asked to run the queue, work the backlog, keep building, or build the app unattended, and as the command given to /loop.
---

# Run the queue

`plan/queue.md` is the list of work. Each call of this skill moves the queue forward one step: it serves the
pull requests waiting on CI, then starts one more slice if there is room. Called under `/loop`, it keeps going row by row until nothing is left that it can
act on.

The queue file is the memory. A session can end at any point, from a full context or a closed
laptop, and the next one continues from what the file says. So write to it as you go, not at the
end.

## Each call

### 1. Read the state

- Read `plan/queue.md`: the tables, the Lessons, and the last few Log lines.
- `git fetch origin`. If the last Log line says a slice was in progress, look at its branch and
  pull request before starting anything new. Finish or park that row first.
- Check nothing is mid-deploy: the newest `Post-deploy smoke` run should be complete and passing
  (`gh run list --workflow "Post-deploy smoke" --limit 3`). If the last one failed, stop here and
  tell the owner. Nothing merges on top of a broken production.

### 2. Serve what is waiting on CI

Heavy checks run on GitHub, so several pull requests can be waiting there at once while this
machine does something else. Rows waiting on CI are marked `in-ci`. Go through them first, oldest
first, and read each one's live state (`gh pr checks <number>`):

- **Still running:** leave it.
- **A check failed:** follow `feature-slice` step 7 for that row: `ci-triage`, then a re-run or a
  fix round. A fix round is local work, so it takes this call's local slot (step 3).
- **All green:** follow `feature-slice` steps 8 to 10: confirm the proof, pass the merge gate,
  merge, and wait for the post-deploy check. One merge at a time. After a merge, the other `in-ci`
  rows are behind `main`; rebase the ones whose files the merge touched and let CI run again.

### 3. Use the local slot

Only one slice is in the local stage (spec, build, review) at a time. If serving CI did not use
the slot, and fewer than four rows are `in-ci`, take the first row, top to bottom, that you can
act on:

- `pr-open`: an existing pull request to finish.
- `ready`: a specified slice whose dependencies are all `merged`.
- `needs-spec`: as `ready`, but you write the spec first from the source its note names.

Skip `owner`, `hold`, `parked` and `merged` rows, and rows whose dependencies are not merged.
Open pull requests come before new work: unmerged branches go stale and conflict with each other.
The cap of four keeps the pile small enough that each merge does not force a round of rebases
across a dozen branches.

Add a Log line saying the row is started, then follow the `feature-slice` skill for it, up to the
point where its pull request is open and CI is running. Mark the row `in-ci` and stop there; a
later call picks it up in step 2.

- A `pr-open` row enters `feature-slice` at its review step, on the PR's branch. First re-read the
  PR's live state: checks, conflicts, how far behind `main` it is. Bring it up to date with `main`
  and push, so CI runs on what would merge. A PR that only needed a rebase is still reviewed
  before it merges; it was written before the current `main`.
- A row for verifying a milestone uses the `milestone-verifier` agent, then records the evidence
  in `docs/milestones.md` and `docs/progress.md` as a docs pull request through the same path.
- A row too large for one pull request is split: replace it with smaller rows, each with its own
  spec, and take the first.

`feature-slice` carries the limits: heavy work in CI, one local slice, two fix rounds, the merge
gate, and the wait for the post-deploy check. Do not loosen them here.

If nothing is `in-ci` and no row can be acted on, go to "When to stop".

### 4. Write the result back

Update the row's status and add one Log line with the date, the row id, what happened, and the PR:

- pull request open and CI running: `in-ci`
- merged and the post-deploy check passed: `merged`
- stopped after two fix rounds, or blocked on a decision: `parked`, with the reason and what would
  unblock it in the row's note
- needs something only the owner has: `owner`, with what is needed

Update `docs/progress.md` when a merge changes what it says. Commit queue and progress changes on
the slice's branch before it merges when you can, so they land with it; otherwise put them in the
next slice's branch. Never push them to `main` directly.

### 5. Learn

After each row, ask what would have made it go better, and write it under Lessons when the answer
is specific: a check the builder skipped, a finding the reviewer raised that a rule would have
prevented, a flaky test `ci-triage` identified, a step in a skill that was wrong.

When the same lesson is there twice, act on it instead of writing it a third time. Edit the file
that would have prevented it (`.claude/agents/builder.md`, `.claude/agents/reviewer.md`,
`feature-slice`, a verification skill, `CLAUDE.md`, or a lint rule or test when the lesson can be
enforced in code), as its own small pull request through the same path, and remove the two lines.
Prefer a check that fails over a sentence that asks.

## When to stop

Stop the loop, and tell the owner why, when any of these is true:

- No row can be acted on and none is `in-ci`. Say which rows are waiting on the owner and what
  each needs.
- A post-deploy check failed. This one is urgent: say so first, with the run link.
- Three rows in a row were parked. Something systematic is wrong, such as a broken `main`, a
  failing environment, or specs that are too loose, and more attempts will not fix it.
- The owner said stop, or a row needs a decision only they can make and nothing else is ready.
- `verify-coach`'s doctor fails in a way you cannot repair, so nothing can be verified.

Under `/loop`, end the loop when you stop. Otherwise schedule the next call: at once when the
local slot has work, or in about ten minutes when everything left is waiting on CI. A full CI run
takes roughly fifteen to twenty minutes.

If `PushNotification` is available, send one line when the loop stops and for each merge. An
overnight run should leave the owner a short summary in the Log they can read in a minute: what
merged, what was parked and why, and what is waiting on them.

## What this skill never does

- Merge outside `feature-slice`'s gate, push to `main`, or force-push.
- Roll back production, change environment variables, or touch Neon or Vercel settings.
- Mark a row `merged` before its post-deploy check passed.
- Put two rows in the local stage at once, or run a full suite on this machine.
- Edit a `hold` or `owner` row's status. Those are the owner's.
