# Queue

The work the build loop takes from. One row per slice. The `run-queue` skill
(`.claude/skills/run-queue/SKILL.md`) reads this file, takes the first row it can act on, runs it,
and writes the result back. Edit it by hand to add, reorder, or hold work.

Pull requests are written as `PR 499`, without a hash sign, so the docs checks that look for
merged-PR citations ignore this file.

## Status values

| Status       | Meaning                                                                    | Who acts  |
| ------------ | -------------------------------------------------------------------------- | --------- |
| `ready`      | Has a spec and its dependencies are merged. Not started.                   | the loop  |
| `needs-spec` | Named but not specified. The loop writes the spec first, then builds.      | the loop  |
| `pr-open`    | A pull request exists. The loop gets it green, verifies it, and merges it. | the loop  |
| `in-ci`      | The loop has reviewed it and pushed. CI is running, or a fix is in hand.   | the loop  |
| `parked`     | Two fix rounds failed, or it needs a decision. The note says why.          | the owner |
| `owner`      | Only the owner can do it (a device check, a secret, a sign-off).           | the owner |
| `hold`       | Skip until the owner removes the hold.                                     | the owner |
| `merged`     | Merged and the post-deploy checks passed.                                  | nobody    |

A row's `Depends on` lists row ids that must be `merged` first. An empty cell means none.

## Open pull requests

Recorded on 2026-11-21 from GitHub. "Checks" is the count of failed checks at that time; the loop
re-reads the live state before acting, so treat it as a starting hint. All of these target `main`.
M7 rows are in slice order, which is the order to land them in unless a PR says otherwise.

| Id                              | Branch                            | PR     | Status    | Checks       | Slice                                                                                      |
| ------------------------------- | --------------------------------- | ------ | --------- | ------------ | ------------------------------------------------------------------------------------------ |
| m5-61-docs-m5-status            | `m5/61-docs-m5-status`            | PR 468 | `pr-open` | 13 failed    | docs(m5): record how the coach runs, what it costs and where M5 stands                     |
| m6-59-m6-perf                   | `m6/59-m6-perf`                   | PR 413 | `pr-open` | 2 failed     | test(perf): hold Progress, exercise detail and the reviews to the performance budgets      |
| m6-62-docs-m6-architecture      | `m6/62-docs-m6-architecture`      | PR 482 | `pr-open` | 11 failed    | docs(m6): record the analytics engine, charts, reviews and replanning as built             |
| m7-04-train-week-findings       | `m7/04-train-week-findings`       | PR 417 | `pr-open` | 13 failed    | feat(train): flag sessions that clash in the week, with a note on each card and a count in |
| m7-05-m7-stage-list             | `m7/05-m7-stage-list`             | PR 416 | `pr-open` | none failing | refactor(programming): make room for M7's season stages without changing any plan          |
| m7-14-placement-why             | `m7/14-placement-why`             | PR 455 | `pr-open` | 14 failed    | feat(train): say why each session sits on its day, from the program's own decisions        |
| m7-22-evaluation-context        | `m7/22-evaluation-context`        | PR 462 | `pr-open` | 14 failed    | feat(periodisation): judge the week with what you actually did, your priorities and events |
| m7-23-move-evaluation           | `m7/23-move-evaluation`           | PR 497 | `pr-open` | 10 failed    | feat(programs): judge a move with M7's rules and show why, plus the day that clears the cl |
| m7-24-review-conflicts-engine   | `m7/24-review-conflicts-engine`   | PR 481 | `pr-open` | 12 failed    | feat(reviews): judge the weekly review and its proposed moves with M7's evaluator, on the  |
| m7-28-generator-season          | `m7/28-generator-season`          | PR 418 | `pr-open` | none failing | feat(programming): plan new programs by effective goal priority and the season             |
| m7-29-generator-schedule        | `m7/29-generator-schedule`        | PR 419 | `pr-open` | none failing | feat(programming): repair every planned week so no clash stands unexplained                |
| m7-30-generator-phasing         | `m7/30-generator-phasing`         | PR 421 | `pr-open` | none failing | feat(programming): each week's prescriptions follow its block type: phase rep schemes, hyp |
| m7-31-periodised-targets        | `m7/31-periodised-targets`        | PR 423 | `pr-open` | none failing | fix(analytics): judge M7 weeks by the targets their plan actually set                      |
| m7-32-generator-running         | `m7/32-generator-running`         | PR 422 | `pr-open` | none failing | feat(programming): plan runs from current fitness, with VDOT paces, safe long-run steps an |
| m7-33-generator-combat          | `m7/33-generator-combat`          | PR 426 | `pr-open` | none failing | feat(programming): Muay Thai follows the fight camp: capped sparring, conditioning rounds  |
| m7-34-next-cycle-periodised     | `m7/34-next-cycle-periodised`     | PR 434 | `pr-open` | none failing | feat(reviews): the cycle review plans the next block from the season: block type, week tar |
| m7-36-hr-zones                  | `m7/36-hr-zones`                  | PR 435 | `pr-open` | none failing | feat(programming): show heart-rate zones in bpm when a heart rate is told                  |
| m7-37-road-view                 | `m7/37-road-view`                 | PR 476 | `pr-open` | 11 failed    | feat(periodisation): the road view: blocks, goal modes, events, deloads and tapers from to |
| m7-38-week-kind-indicators      | `m7/38-week-kind-indicators`      | PR 487 | `pr-open` | 14 failed    | feat(train): mark light and special weeks with why they are lighter, and a countdown       |
| m7-39-periodisation-timeline    | `m7/39-periodisation-timeline`    | PR 499 | `pr-open` | none failing | feat(train): see the season — each block's goals, deloads and events on the plan timeline  |
| m7-40-replan-domain             | `m7/40-replan-domain`             | PR 461 | `pr-open` | none failing | feat(programming): re-plan mid-cycle from a Monday by regenerating, tapering or deloading  |
| m7-41-replan-store              | `m7/41-replan-store`              | PR 469 | `pr-open` | none failing | feat(programs): store a re-plan as a new version, so history stays untouched               |
| m7-42-replan-preview            | `m7/42-replan-preview`            | PR 467 | `pr-open` | 15 failed    | feat(periodisation): preview a re-plan week by week before accepting it                    |
| m7-43-replan-proposals          | `m7/43-replan-proposals`          | PR 486 | `pr-open` | 13 failed    | feat(coach): re-plans become proposals the owner confirms, re-checked and applied once     |
| m7-44-priority-replan-trigger   | `m7/44-priority-replan-trigger`   | PR 498 | `pr-open` | 11 failed    | feat(profile): changing goal priorities proposes a re-plan, never blocking the save        |
| m7-45-reactive-deload           | `m7/45-reactive-deload`           | PR 493 | `pr-open` | 10 failed    | feat(reviews): a weekly review that finds high fatigue or declining performance deloads th |
| m7-46-tools-periodisation-reads | `m7/46-tools-periodisation-reads` | PR 488 | `pr-open` | none failing | feat(coach): let the coach check a week's interference and explain its schedule trade-offs |
| m7-52-hr-fields-ui              | `m7/52-hr-fields-ui`              | PR 443 | `pr-open` | 14 failed    | feat(profile): enter max, resting and threshold heart rate, and see run zones in bpm       |
| perf-workout-layout-motion      | `perf/workout-layout-motion`      | PR 454 | `pr-open` | 2 failed     | perf(workout): no jumps between exercises, a smooth rest bar and aligned clocks            |
| ci-alone-third-shard            | `ci/alone-third-shard`            | PR 494 | `pr-open` | none failing | ci(e2e): a third shard for the alone·chromium perf leg, so it stays well inside its timeou |
| feat-program-start-date         | `feat/program-start-date`         | PR 496 | `pr-open` | 2 failed     | feat(programming): a program starts only after setup, and its start date can be moved      |
| claude-quirky-bohr-h9l613       | `claude/quirky-bohr-h9l613`       | PR 502 | `pr-open` | none failing | feat(programming): move some easy runs to a zone 2 bike when the owner has one             |

## Next work

Not started. Each needs a spec before it can be built; `needs-spec` rows are specified by the loop
when it reaches them, from the source named in the note.

| Id             | Slice                                                                          | Depends on           | Status       | Spec                                      | Note                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------ | -------------------- | ------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| m4-signoff     | M4 sign-off: the owner's screenshot review and the real-device workout check   |                      | `owner`      | `docs/milestones.md`, M4                  | The loop cannot do either.                                                                                                     |
| m5-verify      | Verify M5 against its acceptance criteria and record the evidence              |                      | `ready`      | `docs/milestones.md`, M5                  | Run the `milestone-verifier` agent, then update `docs/milestones.md` and `docs/progress.md` in one PR.                         |
| m6-verify      | Verify M6 against its acceptance criteria and record the evidence              |                      | `ready`      | `docs/milestones.md`, M6                  | As above.                                                                                                                      |
| m7-verify      | Verify M7 against its acceptance criteria and record the evidence              | every M7 row above   | `ready`      | `docs/milestones.md`, M7                  | As above, once the M7 pull requests have landed.                                                                               |
| ci-model-check | Run `verification/workout-sync/check.sh` in CI when the files it covers change |                      | `needs-spec` | `.pi/skills/verify-workout-sync/SKILL.md` | Moves the last heavy local check to GitHub. `scripts/ci-workflow.test.ts` guards the workflow's shape.                         |
| adr-numbering  | Number the six `NNNN-` ADRs and set their status                               |                      | `needs-spec` | `docs/known-issues.md`                    | Docs only.                                                                                                                     |
| readme-status  | Rewrite the README status block and repository map from `docs/progress.md`     | m5-verify, m6-verify | `needs-spec` | `docs/known-issues.md`                    | Docs only.                                                                                                                     |
| trace-evals    | Coach run trace and self-improving evals (eight PRs)                           |                      | `hold`       | `plan/trace-evals/plan.md`                | The plan is 738 commits old and needs three secrets from the owner. Re-check it against `main`, then split it into eight rows. |
| m8-councils    | M8: the performance and design councils                                        | m7-verify            | `needs-spec` | `docs/milestones.md`, M8                  | Fills `docs/reports/`.                                                                                                         |
| m9-release     | M9: security review, restore drill, owner sign-off                             | m8-councils          | `needs-spec` | `docs/milestones.md`, M9                  | The restore drill and sign-off are the owner's.                                                                                |

## Lessons

What the loop has learned that should change how it works. One line each, newest first, with the
row that taught it. When the same lesson appears twice, the loop turns it into an edit to an agent
or skill file, in its own pull request, and removes the lines.

_None yet._

## Log

One line per loop action, newest first: the date, the row, what happened, and the PR.

_None yet._
