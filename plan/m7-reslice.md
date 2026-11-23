# M7 stack re-slice

Written on 2026-11-22 against `origin/main` at `1ba0f61e`. It replaces the 24 open M7 pull
requests (PR 416 to PR 499) with 36 small slices that each land on today's `main` by themselves,
in the order below. The old pull requests stay open until their slices merge. Nobody closes them
until then.

## What the old stack really holds

Every old branch targets `main`, but each one carries the whole stack under it, plus merges of
many M5 and M6 branches that have since reached `main` as squashed merges. That is why PR 416
shows 136 files and 13k lines. Its only own commit is `58e204d8`, which is 149 lines of source.
The 24 branches hold 44 distinct non-merge commits between them:

- **33 feature commits**, about 10,500 lines of source once tests, docs, new e2e specs and test
  fixtures are left out. None of them is on `main` yet. A grep of `main` for each commit's key
  symbols (`stages/prepare.ts`, `stages/schedule.ts`, `services/periodisation/explain.ts`,
  `context.ts`, `road-view.ts`, `week-line.ts`, `preview.ts`, `programs/replan.ts`,
  `coach/apply/replan.ts`, `agent/tools/periodisation.ts`, `evaluate_week_interference`,
  `maxHeartRate` in the UI, `REACTIVE_DELOAD`) found nothing.
- **What `main` already has** from M7: the domain primitives from m7/01 to m7/27 (season, priority
  weights, doses, paces and heart-rate zones in `paces.ts`, deload, taper, fight camp, the
  evaluator, the schedule repair, the rules registry), heart rate stored on the profile, and the
  week findings on Train (PR 417). The re-slice builds on these. It does not repeat them.
- **Already on `main` in another form:** `e12498ae` and `251a1ed5` (the "Try again" copy on the
  review screens). Every file they touch already says "Try again".
- **Test-only commits:** `4544ae8c`, `5f694b1c`, `b31159b0`, `a2321efa`, `29462376`, `9be8a54e`
  and `764defda`. They adjust tests for merges that `main` has since done its own way. Fold one
  in only if the slice's own test still fails without it.
- **New e2e specs, all dropped** (the owner allows no new e2e beyond the PRD journeys):
  `hr-zones`, `train-why`, `move-evaluation`, `train-week-kinds` and `train-road`
  (`*.serial.e2e.ts`). Their test-support endpoint and fixtures in `2f729dcb`
  (`api/test-support/analytics`, `analytics-fixtures/periodisation-road.ts`) go with them. A
  one-line edit an existing spec needs, such as a `GENERATOR_ID` string in
  `e2e/next-cycle.serial.e2e.ts`, stays.

A dry run picked all 33 feature commits, in the order below, onto `main` in memory
(`git merge-tree`, with no working tree touched). Most apply cleanly. The real conflicts are:

| Commit     | Conflicts in                                                         | Slice          |
| ---------- | -------------------------------------------------------------------- | -------------- |
| `d0c08a68` | `src/lib/domain/programming/demand.ts`                               | m7r/02         |
| `4ed23958` | `src/lib/server/db/queries/periodisation.ts`, `train/week.server.ts` | m7r/20         |
| `2f729dcb` | `ui/program/PlanOverviewSheet.svelte`, `train/+page.server.ts`       | m7r/22         |
| `81a65c7f` | `src/lib/server/services/coach/proposals.ts`                         | m7r/32, m7r/33 |
| `b8d023ea` | `docs/architecture.md` (regenerate, do not merge by hand)            | m7r/23         |

`src/routes/(app)/today/panels/Program.svelte`, the file where PR 416 conflicts, comes from the
merged M5 and M6 branches, not from M7 work. Only `4ed23958` (m7r/20) touches it, with 20 lines,
and that applies cleanly.

## Old pull requests and their fate

| PR     | Branch                            | Own commits                                                | Fate                                                                                                                  |
| ------ | --------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| PR 416 | `m7/05-m7-stage-list`             | `58e204d8`                                                 | Becomes m7r/01. The rest of its diff is merged M5 and M6 branches that are already on `main`.                         |
| PR 418 | `m7/28-generator-season`          | `d0c08a68`                                                 | Becomes m7r/02.                                                                                                       |
| PR 419 | `m7/29-generator-schedule`        | `48d05605`, `5f694b1c`                                     | Becomes m7r/03. `5f694b1c` is test-only, so it is dropped.                                                            |
| PR 421 | `m7/30-generator-phasing`         | `61578710`                                                 | Split into m7r/04 and m7r/05.                                                                                         |
| PR 423 | `m7/31-periodised-targets`        | `4e2ad52b`                                                 | Becomes m7r/06.                                                                                                       |
| PR 422 | `m7/32-generator-running`         | `9cb265c1`, `2c7b7452`                                     | `9cb265c1` goes into m7r/03. `2c7b7452` is split into m7r/07 and m7r/08.                                              |
| PR 426 | `m7/33-generator-combat`          | `c16d4740`                                                 | Becomes m7r/09.                                                                                                       |
| PR 434 | `m7/34-next-cycle-periodised`     | `d9b143e9`                                                 | Becomes m7r/11.                                                                                                       |
| PR 435 | `m7/36-hr-zones`                  | `79c78f06`, `b31159b0`                                     | Goes into m7r/10. `b31159b0` is an e2e tweak, so it is dropped.                                                       |
| PR 443 | `m7/52-hr-fields-ui`              | `91d39500`, `a2321efa`, `29462376`                         | Goes into m7r/10. The `hr-zones` e2e spec and the two test fixes are dropped.                                         |
| PR 455 | `m7/14-placement-why`             | `292e0a72`, `da803bce`, `4544ae8c`                         | Split into m7r/12 and m7r/13. The `train-why` e2e is dropped. `4544ae8c` is folded into m7r/12's test only if needed. |
| PR 462 | `m7/22-evaluation-context`        | `7ac34d8e`                                                 | Split into m7r/14 and m7r/15.                                                                                         |
| PR 497 | `m7/23-move-evaluation`           | `054e3002`, `2c29910c`                                     | Becomes m7r/16. The `move-evaluation` e2e is dropped.                                                                 |
| PR 481 | `m7/24-review-conflicts-engine`   | `92b6b2e3`, `dd294c8f`                                     | Split into m7r/17 and m7r/18.                                                                                         |
| PR 476 | `m7/37-road-view`                 | `8fb4bed0`                                                 | Becomes m7r/19.                                                                                                       |
| PR 487 | `m7/38-week-kind-indicators`      | `4ed23958`, `e12498ae`                                     | Becomes m7r/20. The `train-week-kinds` e2e is dropped. `e12498ae` is already on `main`.                               |
| PR 499 | `m7/39-periodisation-timeline`    | `2f729dcb`                                                 | Split into m7r/21 and m7r/22. The `train-road` e2e, its endpoint and its fixture are dropped.                         |
| PR 488 | `m7/46-tools-periodisation-reads` | `b8d023ea`, `764defda`, `251a1ed5`                         | Split into m7r/23 and m7r/24. `764defda` is test-only and `251a1ed5` is already on `main`.                            |
| PR 461 | `m7/40-replan-domain`             | `903a2b0e`, `0757a2d4`                                     | Split into m7r/25, m7r/26 and m7r/27.                                                                                 |
| PR 469 | `m7/41-replan-store`              | `6777c6ab`                                                 | Split into m7r/28 and m7r/29.                                                                                         |
| PR 467 | `m7/42-replan-preview`            | `3e7a9e6a`, `8f2973ac`                                     | Becomes m7r/30.                                                                                                       |
| PR 486 | `m7/43-replan-proposals`          | `ee5765d5`, `6cb6e9ea`, `81a65c7f`, `9be8a54e`, `dcd698e4` | Split into m7r/31, m7r/32 and m7r/33. `9be8a54e` is test-only.                                                        |
| PR 498 | `m7/44-priority-replan-trigger`   | `806fd49f`                                                 | Becomes m7r/34.                                                                                                       |
| PR 493 | `m7/45-reactive-deload`           | `e91111fe`, `6cb3051c`, `b8f7f508`                         | Split into m7r/35 and m7r/36.                                                                                         |

Each PR's "Owner decisions" section records the defaults it chose. They carry over unchanged
with the code. The `m7-open-questions` row in `plan/queue.md` still covers them.

## How to build a slice

- Branch from today's `origin/main` as `m7r/NN-name`, in a worktree under `../pc-wt/`.
- When a slice takes a whole commit, use `git cherry-pick -n <sha>`. Then remove any file the
  slice drops (new e2e specs, test-support endpoints), resolve the conflicts listed above, and
  commit.
- When a slice takes part of a commit, apply only its files:
  `git show <sha> -- <paths> | git apply -3`. Where a file is split between two slices (for
  example `rules/registry/generator.ts`), take the hunks that the slice's own code reads. The
  next slice takes the rest.
- Carry the commit's own unit and integration tests for the files taken. Do not write new e2e
  specs, performance checks or screenshot suites. Where a test was written against the old
  stack's fixtures and fails on `main` for that reason alone, fix the test to fit `main`.
- The size is the source lines changed, leaving out tests, docs and generated files. Check it
  with `git diff --stat origin/main`, as the queue's lessons say, before pushing.
- A generator slice that bumps a `GENERATOR_ID` or a fingerprint states in its pull request
  which stored versions and open proposals then read as stale.

## Risk legend

- **None:** pure domain or server code that nothing on a screen calls yet. Merging it changes
  nothing the owner sees.
- **Plans:** it changes the plans the generator makes from the merge onward: a new program, the
  cycle review's next block, and later a re-plan. Stored program versions are untouched. The
  live program changes only when the owner accepts a newly generated plan.
- **Screen:** it changes what the owner sees or what an action does on the live app as soon as
  it deploys.
- **Migration:** it migrates the production database when it merges.

## The slices

Sizes are estimates from the old commits' numstat.

| Id     | Branch                        | Goal                                                                                                                    | Source                                                                                                                                                                                    | Depends on     | Size                | Risk      |
| ------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------- | --------- |
| m7r/01 | `m7r/01-stage-list`           | The generator's stages live in their own files with a prepare hook, and every plan stays byte for byte the same         | `58e204d8` (PR 416), whole                                                                                                                                                                |                | 150                 | None      |
| m7r/02 | `m7r/02-generator-season`     | New programs are planned by effective goal priority and the season                                                      | `d0c08a68` (PR 418), whole; resolve `demand.ts`                                                                                                                                           | m7r/01         | 365                 | Plans     |
| m7r/03 | `m7r/03-generator-schedule`   | Every planned week is repaired by the scheduler, so no clash stands unexplained                                         | `48d05605` (PR 419) and `9cb265c1` (PR 422)                                                                                                                                               | m7r/02         | 510                 | Plans     |
| m7r/04 | `m7r/04-phasing-strength`     | Each week's strength prescriptions follow its block type: rep schemes and dose bands                                    | `61578710` (PR 421): `stages/phasing.ts`, `stages/loads.ts`, `stages/progression.ts`, `progression.ts`, and their hunks in `random.ts` and `registry/generator.ts`                        | m7r/03         | 250                 | Plans     |
| m7r/05 | `m7r/05-phasing-hypertrophy`  | Hypertrophy weeks set sets per muscle group from the block                                                              | `61578710` (PR 421): `stages/volume.ts`, `volume.ts`, and the rest of `registry/generator.ts`                                                                                             | m7r/04         | 230                 | Plans     |
| m7r/06 | `m7r/06-periodised-targets`   | Progress and the reviews judge an M7 week by the targets its own plan set                                               | `4e2ad52b` (PR 423), whole                                                                                                                                                                | m7r/05         | 220                 | Screen    |
| m7r/07 | `m7r/07-running-paces`        | Runs are paced from current fitness: VDOT paces with undated races counted and marathon pace on steady segments         | `2c7b7452` (PR 422): `pacesOf`, `segment` and the paces part of `running.ts`, `templates/running.ts`, `registry/m3.ts`                                                                    | m7r/05         | 290                 | Plans     |
| m7r/08 | `m7r/08-running-long-runs`    | Marathon and half blocks get safe long-run steps, cutback weeks and race-specific work                                  | `2c7b7452` (PR 422): `sizeWeek`, the race-work part of `running.ts`, `periodisation/endurance.ts`, and its hunks in `registry/generator.ts`                                               | m7r/07         | 290                 | Plans     |
| m7r/09 | `m7r/09-combat-camp`          | Muay Thai follows the fight camp: capped sparring, conditioning rounds and a sharpening fight week                      | `c16d4740` (PR 426), whole                                                                                                                                                                | m7r/08         | 415                 | Plans     |
| m7r/10 | `m7r/10-hr-zones`             | The owner enters max, resting and threshold heart rate, and a run session shows its zones in bpm                        | `79c78f06` (PR 435) and `91d39500` (PR 443), without `e2e/hr-zones.serial.e2e.ts`                                                                                                         | m7r/08         | 205                 | Screen    |
| m7r/11 | `m7r/11-next-cycle-season`    | The cycle review plans the next block from the season: block type, week targets, deloads and tapers                     | `d9b143e9` (PR 434), whole                                                                                                                                                                | m7r/02         | 330                 | Plans     |
| m7r/12 | `m7r/12-placement-why`        | A read of why each session sits on its day, from the program's own decisions                                            | `292e0a72` (PR 455), whole                                                                                                                                                                |                | 250                 | None      |
| m7r/13 | `m7r/13-why-this-day`         | Train shows "Why this day?" under each session card, without JavaScript                                                 | `da803bce` (PR 455), without `e2e/train-why.serial.e2e.ts`                                                                                                                                | m7r/12         | 180                 | Screen    |
| m7r/14 | `m7r/14-evaluation-context`   | The week evaluator can be given what was actually done, the goal priorities, the week's kind and the events             | `7ac34d8e` (PR 462): `services/periodisation/context.ts` and the fixture's hunk                                                                                                           | m7r/12         | 350                 | None      |
| m7r/15 | `m7r/15-evaluation-wiring`    | Train's week findings are judged with that context and suggest a fix                                                    | `7ac34d8e` (PR 462): `services/periodisation/evaluate.ts`, `train/week.server.ts`                                                                                                         | m7r/13, m7r/14 | 160                 | Screen    |
| m7r/16 | `m7r/16-move-evaluation`      | A move is judged by M7's rules, and the Move sheet shows each day's heads-up and the day that clears the clash          | `054e3002` and `2c29910c` (PR 497), without `e2e/move-evaluation.serial.e2e.ts`                                                                                                           | m7r/15         | 395                 | Screen    |
| m7r/17 | `m7r/17-review-evaluator`     | Domain: judge a reviewed week and next week's changes with M7's evaluator                                               | `92b6b2e3` (PR 481), whole                                                                                                                                                                | m7r/15         | 445                 | None      |
| m7r/18 | `m7r/18-review-wiring`        | The weekly review uses that evaluator on the load that was logged                                                       | `dd294c8f` (PR 481), whole                                                                                                                                                                | m7r/14, m7r/17 | 80                  | Screen    |
| m7r/19 | `m7r/19-road-view`            | A road view read: blocks, goal modes, events, deloads and tapers from today to the last event                           | `8fb4bed0` (PR 476), whole                                                                                                                                                                | m7r/02, m7r/12 | 340                 | None      |
| m7r/20 | `m7r/20-week-kind-marks`      | Train and Today mark light and special weeks, with why they are lighter and a countdown to the event                    | `4ed23958` (PR 487), without `e2e/train-week-kinds.serial.e2e.ts`; resolve `queries/periodisation.ts` and `week.server.ts`                                                                | m7r/19         | 200 (+300 fixtures) | Screen    |
| m7r/21 | `m7r/21-season-model`         | Train's server load carries the season: road faults, the season rows and the week rows                                  | `2f729dcb` (PR 499): `road-faults.ts`, `ui/program/season.ts`, `week-rows.ts`, `train/road.server.ts`, `train/+page.server.ts`                                                            | m7r/20         | 330                 | None      |
| m7r/22 | `m7r/22-season-timeline`      | The plan sheet shows the season: each block's goals, deloads and events                                                 | `2f729dcb` (PR 499): `BlockTimeline.svelte`, `PlanOverviewSheet.svelte`, `design/ProgramPanel.svelte`, `train/+page.svelte`, `week.server.ts`                                             | m7r/21         | 330                 | Screen    |
| m7r/23 | `m7r/23-tool-interference`    | The coach can check a week's interference, and propose moves without a draft                                            | `b8d023ea` (PR 488): `evaluate_week_interference`, the ops input in `programming-proposals.ts`, `registry.ts`, `coach/tools.ts`, `activity.ts`, and the regenerated `docs/coach-tools.md` | m7r/15, m7r/19 | 400                 | Screen    |
| m7r/24 | `m7r/24-tool-tradeoffs`       | The coach can explain the schedule's trade-offs from the program's decisions                                            | `b8d023ea` (PR 488): `explain_schedule_tradeoffs`, its part of `services/periodisation/explain.ts`, `mock-scripts/periodisation.ts`                                                       | m7r/23         | 330                 | Screen    |
| m7r/25 | `m7r/25-replan-rules`         | Domain: a re-plan's rules, types and skeleton, and where it starts                                                      | `903a2b0e` (PR 461): `rules/replan.ts`, `registry/replan.ts`, `training/replan.ts`, `replanSkeleton` and `replanStart` in `periodisation/replan.ts`                                       | m7r/11         | 390                 | None      |
| m7r/26 | `m7r/26-replan-regenerate`    | Domain: a re-plan from a Monday regenerates the rest of the block                                                       | `903a2b0e` (PR 461): `regenerate` and `generateReplan` in `periodisation/replan.ts`, `stages/carryover.ts`, `next-block/generate.ts`                                                      | m7r/25         | 250                 | None      |
| m7r/27 | `m7r/27-replan-taper-deload`  | Domain: a re-plan can splice in a taper or deload one week in place                                                     | `903a2b0e` (PR 461): `splice`, `inPlace` and `taperBlock`, plus `0757a2d4`                                                                                                                | m7r/26         | 330                 | None      |
| m7r/28 | `m7r/28-replan-store`         | A re-plan is stored as a new version, cut or replaced at a Monday, with history untouched                               | `6777c6ab` (PR 469): `storeReplan`, `program-periodise.ts`, `queries/programs.ts`, `repositories/programs.ts`, `read.ts`, `revise.ts`                                                     | m7r/27         | 400                 | None      |
| m7r/29 | `m7r/29-replan-store-deload`  | A one-week deload is stored in place, and a cut block gets no cycle review                                              | `6777c6ab` (PR 469): `reviseDeload`, `services/reviews/cycle.ts`                                                                                                                          | m7r/28         | 200                 | None      |
| m7r/30 | `m7r/30-replan-preview`       | Preview a re-plan week by week, inside the caller's transaction                                                         | `3e7a9e6a` and `8f2973ac` (PR 467), whole                                                                                                                                                 | m7r/14, m7r/27 | 440                 | None      |
| m7r/31 | `m7r/31-replan-proposal-kind` | A `replan` proposal kind, with the reasons a stale one is refused                                                       | `6cb6e9ea` and the vocabulary from `ee5765d5` (PR 486). Generate `drizzle/0034_*` again with `pnpm db:generate` rather than copying the snapshot.                                         | m7r/30         | 100 + migration     | Migration |
| m7r/32 | `m7r/32-replan-apply`         | An accepted re-plan is checked again and applied once. Nothing proposes one yet                                         | `81a65c7f` (PR 486): `coach/apply/replan.ts`, `apply/index.ts`, plus `dcd698e4`                                                                                                           | m7r/29, m7r/31 | 350                 | None      |
| m7r/33 | `m7r/33-replan-propose`       | The coach can propose a re-plan, and its card says what changes                                                         | `81a65c7f` (PR 486): `periodisation/propose.ts`, `coach/proposals.ts`, `cards.ts`, `memory.ts`, `memory-records.ts`, `mock-scripts/programming-reads.ts`                                  | m7r/32         | 300                 | Screen    |
| m7r/34 | `m7r/34-priority-replan`      | Changing goal priorities proposes a re-plan, and never blocks the save                                                  | `806fd49f` (PR 498), whole                                                                                                                                                                | m7r/33         | 300                 | Screen    |
| m7r/35 | `m7r/35-deload-assess`        | The weekly snapshot can record a deload, next week's rules know M7's light weeks, and a reactive deload can be assessed | `e91111fe` and `6cb3051c` (PR 493), whole                                                                                                                                                 | m7r/18, m7r/33 | 240                 | None      |
| m7r/36 | `m7r/36-deload-in-review`     | A weekly review that finds high fatigue or declining performance proposes a deload for the next week                    | `b8f7f508` (PR 493), whole                                                                                                                                                                | m7r/35         | 295                 | Screen    |

The total is about 10,500 lines of source over 36 slices. Every slice except m7r/03 is under
about 450 lines. m7r/03 is 510, almost all of it the one stage file `stages/schedule.ts`, which
has no clean place to split. m7r/20 also carries about 300 lines of test fixtures in
`src/lib/server/test-support/`. Keep them only if its integration test needs them.

### The tracks

The slices form three tracks. They meet only where the table says.

- **Generator (m7r/01 to m7r/11):** domain only. 01 is a safe refactor. 02 to 05 and 07 to 09
  change the next plan generated. 06 and 10 change screens.
- **Reads and screens (m7r/12 to m7r/24):** 12 and 13 can start at once, beside 01. 14, 17, 19
  and 21 add server reads behind no screen. The others put those reads on Train, the Move
  sheet, the weekly review and the coach.
- **Re-plans (m7r/25 to m7r/36):** domain first (25 to 27), then storage (28, 29), the preview
  (30), the migration (31) and apply (32). All of that is invisible. Then 33, 34 and 36 put it in
  front of the owner. Apply lands before propose, so no proposal reaches the owner before it can
  be accepted.

### What proves each slice

Each slice carries the unit and integration tests that its source commit added for the files it
takes. CI already runs them. The main ones:

| Slice  | Test                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------ |
| m7r/01 | `generate.test.ts` and `next-block/generate.test.ts` golden hashes (unchanged plans), `stages/prepare.test.ts`           |
| m7r/02 | `generate-season.test.ts`, `demand.test.ts`                                                                              |
| m7r/03 | `generate-schedule.test.ts`                                                                                              |
| m7r/04 | `generate-phasing.test.ts`, the strength and rep-scheme cases                                                            |
| m7r/05 | `generate-phasing.test.ts`, the hypertrophy cases, and `volume.test.ts`                                                  |
| m7r/06 | `tests/integration/analytics/targets.test.ts`, `registry/targets.test.ts`                                                |
| m7r/07 | `generate-running.test.ts`, the paces cases, and `running.test.ts`                                                       |
| m7r/08 | `generate-running.test.ts`, the long-run, cutback and race-work cases                                                    |
| m7r/09 | `generate-combat.test.ts`                                                                                                |
| m7r/10 | `hr-zones.test.ts`, `ui/profile/specifics.test.ts`, `session-words.test.ts`, `integration/training/session-load.test.ts` |
| m7r/11 | `next-block/periodised.test.ts`, `integration/reviews/next-cycle.test.ts`                                                |
| m7r/12 | `integration/periodisation/explain.test.ts`                                                                              |
| m7r/13 | `integration/periodisation/train-page-data.test.ts` (the why items), then the Train journey in `verify-coach`            |
| m7r/14 | `integration/periodisation/context.test.ts`                                                                              |
| m7r/15 | `integration/periodisation/evaluate.test.ts`                                                                             |
| m7r/16 | `integration/training/edit-move-skip.test.ts`, `integration/programs/batch.test.ts`, `session-words.test.ts`             |
| m7r/17 | `review/weekly.test.ts`, `review/next-week.test.ts`                                                                      |
| m7r/18 | `integration/reviews/weekly-conflicts.test.ts`                                                                           |
| m7r/19 | `road-view.test.ts` (unit and integration)                                                                               |
| m7r/20 | `integration/periodisation/week-line.test.ts`                                                                            |
| m7r/21 | `road-faults.test.ts`, `season.test.ts`, `week-rows.test.ts`, `integration/periodisation/train-road.test.ts`             |
| m7r/22 | `ui/program/block-timeline.test.ts`                                                                                      |
| m7r/23 | `integration/coach/periodisation-tools.test.ts`, the interference cases, and `registry-complete.test.ts`                 |
| m7r/24 | `integration/coach/periodisation-tools.test.ts`, the trade-off cases                                                     |
| m7r/25 | `training/replan.test.ts`, `periodisation/replan.test.ts`, the skeleton and start cases                                  |
| m7r/26 | `periodisation/replan.test.ts`, the regenerate cases                                                                     |
| m7r/27 | `periodisation/replan.test.ts`, the taper and deload cases                                                               |
| m7r/28 | `integration/programs/replan-store.test.ts`, the cut and replace cases                                                   |
| m7r/29 | `integration/programs/replan-store.test.ts`, the deload cases                                                            |
| m7r/30 | `integration/periodisation/preview.test.ts`                                                                              |
| m7r/31 | `coach/diff.test.ts`, `proposal-rules.test.ts`, `proposals.test.ts`, and the migration check in CI                       |
| m7r/32 | `integration/coach/replan-proposals.test.ts`, the apply cases                                                            |
| m7r/33 | `integration/coach/replan-proposals.test.ts`, the propose cases                                                          |
| m7r/34 | `integration/periodisation/priority-replan.test.ts`                                                                      |
| m7r/35 | `review/next-week.test.ts`, `review/snapshot.test.ts`, `services/periodisation/deload.test.ts`                           |
| m7r/36 | `integration/periodisation/reactive-deload.test.ts`, `reviews/store.test.ts`                                             |

The Train, Profile and weekly review screen slices (06, 10, 13, 15, 16, 18, 20, 22, 36) also run
the PRD journeys they touch through `verify-coach`, as `feature-slice` requires. No new e2e spec is
added. M7's acceptance criterion 2, a journey with several disciplines at once, is
`e2e/journey-run-muay-thai.serial.e2e.ts` on `main`.

## Changes while building

- **m7r/03 is parked.** See the queue's lessons. m7r/04 to m7r/10 depend on it.
- **m7r/07 restores an assertion.** `next-block/periodised.test.ts` lost its marathon-pace steady-segment assertion in m7r/11 (PR 537), because the feature is m7r/07's. m7r/07 adds it back.
- **m7r/12 and m7r/14 test Train in later slices.** Their Train-wiring tests moved to m7r/13 and m7r/15.

- m7r/22 took the Train stream of `loadTrainRoad` and `week.openGoals` from m7r/21, and fixed the any-day start on the timeline, the season track and Today's build preview.
- m7r/23's `ops` on `propose_program_adjustment` take move ops only, to stay under the strict-schema cap (8 of 24 used). Trade-off hints came from `getPlacementWhy`; m7r/24 moved them to `getScheduleTradeoffs` and added decision ids.
- m7r/26 took `replanSkeleton`, its helpers and the `replan.apply` rule; m7r/27 restored the taper and deload dispatch. They stayed two slices.
- m7r/28 kept `programPlanSchema` for a stored re-plan and corrected the ADR. It ships `cutShortLineages` and `CopyChanges.weeks` ahead of m7r/29, which uses them.
- m7r/30: compute `from` as the later of `replanStart(today, touched)` and the version's `startsOn`; a program whose start is still ahead otherwise throws `GeneratedPlanError`.
- m7r/07 restores the periodised marathon-pace assertion.
- m7r/29 adds a store-side refusal of a deload whose week is already over. m7r/32 routes a deload to `reviseDeload` (with `source`) and every other re-plan to `storeReplan`, re-checking the preview inside the accept transaction.
- m7r/30's preview judges both sides on their own modelled load through the week's Sunday, so the load rules run; the source commit filtered them out.
- m7r/31 adds migration 0034 (superseded reasons). m7r/33 stores only a re-plan's week rows, impact and summary lines, never the plan; m7r/34 caps those rows at 12 and makes `ReplanRequest` a discriminated union.
- m7r/35 targets a reactive deload at next week, or this week only when the review is exactly one week late. m7r/36 adds the review page's deload card (Accept the deload, Keep the plan), which the source commit lacked.
- For m7/50: a capped re-plan card should show its "N more changes" line, which today reaches only the coach. A late deload's toast still says "Next week".

## For the owner

1. **The generator slices change new plans as soon as they merge.** These are m7r/02 to m7r/05,
   m7r/07 to m7r/09 and m7r/11. Your current program stays as it is stored. The next program you
   build, the next cycle review and later every re-plan come out differently. m7r/01 also changes
   the next block's `GENERATOR_ID`, so a next cycle that was previewed before the merge but not
   accepted is refused once and must be previewed again. Default: accept this.
2. **The M7 screen slices and the Paper redesign touch the same screens.** m7r/13, 15, 16, 20 and
   22 change Train and Today, which `ui/06-today` and `ui/07-train` restyle. Default: build the M7
   screen slices first, because `ui/01` is parked. If the redesign lands first, they are rebuilt
   on its components.
3. **m7r/03 is 510 lines,** over the 400-line target, because one stage file does the work.
   Default: accept it as one pull request.
4. **The old pull requests stay open.** Default: close each one, linking its new slices, once the
   last of those slices merges.
