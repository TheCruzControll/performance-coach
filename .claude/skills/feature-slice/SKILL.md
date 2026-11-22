---
name: feature-slice
description: Take one feature or slice from a spec to a merged, deployed pull request, using the builder, reviewer and ci-triage agents and the repo's verification skills. Use when asked to build, implement or ship a feature, a slice, or a fix end to end in this repo, or to finish an open pull request.
---

# Feature slice

One slice goes through the same path every time: you write the spec, a `builder` agent writes the
code, a `reviewer` agent checks it, you verify it on the real app, it becomes a pull request with
green checks, and it merges. You stay the owner throughout. The agents do the writing and the
reading; every decision and every claim in the final report is yours.

The path uses plain `Agent` calls, so it works in any Claude Code harness.

## Limits that hold for the whole run

- **A merge is a production deploy.** Every merge to `main` deploys coach.nikocruz.com and
  migrates its database. The owner has allowed this path to merge, under the gate in step 9 and
  nowhere else. Never push to `main` directly, and never force-push `main`. A pull request branch
  you have rebased is pushed with `git push --force-with-lease`, never plain `--force`.
- **Heavy work runs on GitHub, not here.** This machine has 8 GB of memory. CI runs type-check,
  lint, the unit and integration suites, both builds, the budgets, every Playwright journey on
  Chromium and WebKit, and Lighthouse, on every pull request that changes more than docs. Do not run `pnpm check`,
  `pnpm lint`, `pnpm test:unit`, `pnpm test:integration`, `pnpm build` or `pnpm test:e2e`
  locally. Run narrow checks on the files in hand, push, and let CI be the judge.
- **One worktree per slice.** Several slices can be in progress at once under `run-queue`, each in
  its own git worktree, so they never share a working copy. Everything you and the agents do for a
  slice happens in that slice's worktree. Never edit the main checkout: other sessions use it.
- **Two fix rounds, then stop.** If the reviewer or CI still finds a real problem after two rounds
  of fixes, park the slice and report where it stands. A third round usually means the spec is
  wrong, and that is yours to fix, not the builder's.
- **Stop for the owner** when the slice needs a secret, a real device, a product decision, or a
  migration that drops or rewrites existing data.

## 1. Prepare

- Check `node -v` is 22. The repo refuses other versions (`engine-strict`); switch with `nvm use`
  if needed.
- `git fetch origin`, then give the slice its own worktree beside the others, from the main
  checkout: `git worktree add ../pc-wt/loop-<slug> -b <branch> origin/main` for a new slice, or
  `git worktree add ../pc-wt/loop-<slug> <branch>` for an existing pull request's branch. When
  `run-queue` started this slice, it has already done this; use the worktree it names.
- New slice: branch from `origin/main`, or from the branch of the slice it depends on when that
  one is not merged yet. Follow the branch names already in use (`m7/45-reactive-deload`,
  `feat/program-start-date`, `fix/train-history-desktop`).
- Existing pull request: bring its branch up to date with its base in the worktree. Read the PR
  description and the diff; they are the spec. Skip to step 4.
- Run `pnpm install --frozen-lockfile` in the worktree.
- Put the worktree's absolute path at the top of every agent brief for this slice, and tell the
  agent to work only there.

## 2. Write the spec

This is the design step, and it is yours. Read the code the slice touches before writing. The
builder runs on a small model and makes no design decisions, so the spec has to settle them:

- the goal, in one or two sentences, and what is out of scope
- the files to create or change
- the data shapes, types and signatures, chosen before any logic
- which layer each piece lives in (`domain` pure, `server`, `client`, `ui`, `routes`)
- the migration, if the schema changes
- the tests that prove it, and the commands that run them
- the verification: which journey in the `verify-coach` feature map proves it, or the new spec to
  write when none does

If the slice is too large to spec this precisely, split it and run this skill once per part.

Keep the spec in the conversation. It goes into the builder's brief and later into the PR
description; it does not need a file.

## 3. Build

Start one `Agent` with `subagent_type: "builder"`. Its prompt is the spec in full: it starts
without this conversation.

When it reports back, read the diff yourself (`git diff`, `git status --short`). If the builder
says the spec had a gap, fix the spec and start a fresh builder with the corrected spec and the
first builder's report. Do not answer the gap by editing the code yourself and moving on, or the
next round starts from a spec that no longer matches the code.

## 4. Review

Start one `Agent` with `subagent_type: "reviewer"`. Give it the spec, the base, and "working tree"
or the branch head as the head.

Check each finding yourself before acting on it. For each blocker or should that is real, add it
to a fix list. Decline nits and out-of-scope findings in one line each and keep them for the
report.

If the fix list is not empty, start a fresh builder with the spec, the fix list, and the current
state of the branch, then review again. That is one fix round.

## 5. Tests: only what the slice needs

The owner wants CI small: a pull request runs lint, type-check, unit and integration tests, the
build, and the PRD journeys in one browser (`scripts/ci-legs.ts`). Keep it that way.

- Every slice comes with unit or integration tests for the logic it adds, which fail without it.
- Add or change a browser test only when the slice adds or changes one of the PRD journeys
  (`e2e/journey-*.serial.e2e.ts`); then update that journey. Do not add other e2e specs,
  screenshot sets, performance guards, accessibility sweeps or formal models.
- A change to code `verify-workout-sync` covers (the offline sync engine, the outbox, the
  server's sync ledger): run that skill's check here; the baseline takes under a minute.
- Never weaken a test to get a pass. If a test is wrong, fix it as its own change.

## 6. Narrow local checks, then open the pull request

Run only what is cheap, on the files the slice changed:

```sh
pnpm exec prettier --check <changed files>
pnpm exec eslint <changed files>
pnpm exec vitest run --project unit <changed or new test files>
```

Every push of a change to code starts 28 CI jobs, and about 20 run at once across all pull
requests, so push finished work, not work in progress. Commit locally as often as you like, and
push once per review round. Keep docs-only changes in pull requests of their own where the slice
allows it: CI runs those in a few minutes (`scripts/ci-scope.ts`).

Commit with a Conventional Commits message. Then `git fetch origin` and rebase the branch onto
`origin/main` before every push, so CI always runs on the newest `main` and conflicts show up here
instead of at merge time. Push the branch and open the PR with the `file-pr` skill. Put the spec's goal first in the description, then the review result and the journey that
proves the slice. Opening the pull request is what starts the real checks.

## 7. Let CI run, and fix what it finds

CI takes a while, and waiting costs nothing here. When this skill runs under `run-queue`, the slice
now leaves the local stage: record it as waiting on CI and go back to the dispatcher, which
returns here when CI finishes. Run alone, watch the PR with the `babysit-pr` skill.

For each failed check, start one `Agent` with `subagent_type: "ci-triage"`, giving it the PR
number and the failed check. It reads the log so you do not have to.

- `FLAKE`: re-run the check (`gh run rerun <run-id> --failed`).
- `REAL`: send its finding to a fresh builder, then push. This counts as a fix round.
- `PRE-EXISTING`: leave the PR as it is and note the broken check in the report.
- `UNCLEAR`: read the log yourself before deciding.

Reproduce a failure locally only when the log is not enough, and then with one spec through the
`verify-coach` skill, never a whole suite.

## 8. Confirm the proof

Green checks prove what ran. Confirm the slice's own tests were among it: the unit or integration
tests it added ran and passed in the PR's latest run (`gh pr checks <number>`), and, when the
slice changed a PRD journey, that journey passed in the e2e job (`gh run view <run-id> --log |
grep "<journey file>"`).

## 9. Merge

Under `run-queue`, rows merge as a train (that skill's step 2). A row boards only when every line
below that concerns the row holds for its boarding head: its review, its queue status, the
stop-for-the-owner cases and `plan/queue.md`. Its own checks must be green, but its branch need
not contain `main`. The lines about checks, `main`, the proof and deploys are then checked on the
train's branch and its run. Run alone, the whole gate applies to the slice's own pull request.

Merge only when every line below is true on the PR's latest head. If any is false, do not merge;
fix it or park the slice.

- All five required checks are green on the latest head, and none was skipped or disabled to get
  there. The one exception is a light run: when the `Scope of the run` job answered `light` (the
  change touches only docs, the plan, agent tooling, root Markdown or `.env.example`), the integration tests, the e2e legs and
  Lighthouse are skipped by design, and there is no journey to confirm in step 8.
- The checks ran on the `main` this would land on. After `git fetch origin`, the branch must
  contain the tip of `main` (`git merge-base --is-ancestor origin/main HEAD` succeeds in the
  slice's worktree). If it does not, rebase onto `origin/main`, push with `--force-with-lease`,
  and wait for green on the new head before coming back to this gate. Two pull requests that each
  pass alone can break together, and this is the only place that catches it before production. A
  rebase that applied cleanly needs no new review; one where you resolved a conflict does. For a
  train, do not rebase: close its pull request, delete the branch, and build a new train from the
  new `origin/main`.
- The last review of this head returned `APPROVE`, or every blocker and should was fixed and
  re-reviewed.
- Step 8 confirmed the slice's tests passed in CI on this head, and the `verify-workout-sync`
  check passed if step 5 called for it.
- The slice is not one of the "stop for the owner" cases above, and its queue row is not `hold` or
  `owner`.
- The branch does not change `plan/queue.md`, unless it is the queue's own housekeeping change.
- No earlier merge is still deploying. One merge at a time, a row or a train, however many slices are in flight.

Merge the way this repo's history does, as a merge commit titled `Merge <PR title> (#<number>)`:

```sh
gh pr merge <number> --merge --subject "Merge <PR title> (#<number>)"
```

## 10. Watch the deploy

A merge is not finished until production is confirmed healthy.

- Wait for the `Post-deploy smoke` workflow run for the merge commit
  (`gh run list --workflow "Post-deploy smoke" --limit 5`) and read its result.
- **If it passes,** the slice is done.
- **If it fails, or no run appears within 20 minutes,** stop. Do not start another slice and do
  not merge anything else. Tell the owner at once, with the run link, and point them at "Rollback"
  in `docs/deployment.md`. Rolling back is the owner's decision; do not do it yourself.

## Report

Tell the owner:

- the PR link and whether it merged, or why it is parked
- what was built, against the spec
- the reviewer's verdict, what was fixed, and what was declined and why
- the CI run link, the tests that prove the slice, and the sync check if it ran
- what you added to the verification skills
- the post-deploy result
- fix rounds used, and anything left as a follow-up
