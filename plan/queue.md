# Queue

The work the build loop takes from. One row per slice. The `run-queue` skill
(`.claude/skills/run-queue/SKILL.md`) reads this file and keeps several rows moving at once, top
to bottom. Edit it by hand to add, reorder, or hold work.

This file is the plan, not the live state. While rows are in flight, their progress is on GitHub
(the pull request) and in the loop's git-ignored state file. The loop writes results back here in
a housekeeping pull request when it stops and after every ten merges.

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

A row's `Depends on` lists row ids and open pull requests that must be `merged` first. An empty
cell means none.

## Open pull requests

Recorded on 2026-11-21 from GitHub. "Checks" is the count of failed checks at that time; the loop
re-reads the live state before acting, so treat it as a starting hint. All of these target `main`.
The M7 rows are parked. On 2026-11-22 they were re-sliced into the `m7r/` rows under Next work
(`plan/m7-reslice.md`). Leave the pull requests open until their slices merge.

| Id                              | Branch                            | PR     | Status   | Checks                            | Slice                                                                                      |
| ------------------------------- | --------------------------------- | ------ | -------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| m5-61-docs-m5-status            | `m5/61-docs-m5-status`            | PR 468 | `merged` | 13 failed                         | docs(m5): record how the coach runs, what it costs and where M5 stands                     |
| m6-62-docs-m6-architecture      | `m6/62-docs-m6-architecture`      | PR 482 | `merged` | 11 failed                         | docs(m6): record the analytics engine, charts, reviews and replanning as built             |
| m7-04-train-week-findings       | `m7/04-train-week-findings`       | PR 417 | `merged` | 13 failed                         | feat(train): flag sessions that clash in the week, with a note on each card and a count in |
| m7-05-m7-stage-list             | `m7/05-m7-stage-list`             | PR 416 | `parked` | re-sliced, see plan/m7-reslice.md | refactor(programming): make room for M7's season stages without changing any plan          |
| m7-14-placement-why             | `m7/14-placement-why`             | PR 455 | `parked` | re-sliced, see plan/m7-reslice.md | feat(train): say why each session sits on its day, from the program's own decisions        |
| m7-22-evaluation-context        | `m7/22-evaluation-context`        | PR 462 | `parked` | re-sliced, see plan/m7-reslice.md | feat(periodisation): judge the week with what you actually did, your priorities and events |
| m7-23-move-evaluation           | `m7/23-move-evaluation`           | PR 497 | `parked` | re-sliced, see plan/m7-reslice.md | feat(programs): judge a move with M7's rules and show why, plus the day that clears the cl |
| m7-24-review-conflicts-engine   | `m7/24-review-conflicts-engine`   | PR 481 | `parked` | re-sliced, see plan/m7-reslice.md | feat(reviews): judge the weekly review and its proposed moves with M7's evaluator, on the  |
| m7-28-generator-season          | `m7/28-generator-season`          | PR 418 | `parked` | re-sliced, see plan/m7-reslice.md | feat(programming): plan new programs by effective goal priority and the season             |
| m7-29-generator-schedule        | `m7/29-generator-schedule`        | PR 419 | `parked` | re-sliced, see plan/m7-reslice.md | feat(programming): repair every planned week so no clash stands unexplained                |
| m7-30-generator-phasing         | `m7/30-generator-phasing`         | PR 421 | `parked` | re-sliced, see plan/m7-reslice.md | feat(programming): each week's prescriptions follow its block type: phase rep schemes, hyp |
| m7-31-periodised-targets        | `m7/31-periodised-targets`        | PR 423 | `parked` | re-sliced, see plan/m7-reslice.md | fix(analytics): judge M7 weeks by the targets their plan actually set                      |
| m7-32-generator-running         | `m7/32-generator-running`         | PR 422 | `parked` | re-sliced, see plan/m7-reslice.md | feat(programming): plan runs from current fitness, with VDOT paces, safe long-run steps an |
| m7-33-generator-combat          | `m7/33-generator-combat`          | PR 426 | `parked` | re-sliced, see plan/m7-reslice.md | feat(programming): Muay Thai follows the fight camp: capped sparring, conditioning rounds  |
| m7-34-next-cycle-periodised     | `m7/34-next-cycle-periodised`     | PR 434 | `parked` | re-sliced, see plan/m7-reslice.md | feat(reviews): the cycle review plans the next block from the season: block type, week tar |
| m7-36-hr-zones                  | `m7/36-hr-zones`                  | PR 435 | `parked` | re-sliced, see plan/m7-reslice.md | feat(programming): show heart-rate zones in bpm when a heart rate is told                  |
| m7-37-road-view                 | `m7/37-road-view`                 | PR 476 | `parked` | re-sliced, see plan/m7-reslice.md | feat(periodisation): the road view: blocks, goal modes, events, deloads and tapers from to |
| m7-38-week-kind-indicators      | `m7/38-week-kind-indicators`      | PR 487 | `parked` | re-sliced, see plan/m7-reslice.md | feat(train): mark light and special weeks with why they are lighter, and a countdown       |
| m7-39-periodisation-timeline    | `m7/39-periodisation-timeline`    | PR 499 | `parked` | re-sliced, see plan/m7-reslice.md | feat(train): see the season — each block's goals, deloads and events on the plan timeline  |
| m7-40-replan-domain             | `m7/40-replan-domain`             | PR 461 | `parked` | re-sliced, see plan/m7-reslice.md | feat(programming): re-plan mid-cycle from a Monday by regenerating, tapering or deloading  |
| m7-41-replan-store              | `m7/41-replan-store`              | PR 469 | `parked` | re-sliced, see plan/m7-reslice.md | feat(programs): store a re-plan as a new version, so history stays untouched               |
| m7-42-replan-preview            | `m7/42-replan-preview`            | PR 467 | `parked` | re-sliced, see plan/m7-reslice.md | feat(periodisation): preview a re-plan week by week before accepting it                    |
| m7-43-replan-proposals          | `m7/43-replan-proposals`          | PR 486 | `parked` | re-sliced, see plan/m7-reslice.md | feat(coach): re-plans become proposals the owner confirms, re-checked and applied once     |
| m7-44-priority-replan-trigger   | `m7/44-priority-replan-trigger`   | PR 498 | `parked` | re-sliced, see plan/m7-reslice.md | feat(profile): changing goal priorities proposes a re-plan, never blocking the save        |
| m7-45-reactive-deload           | `m7/45-reactive-deload`           | PR 493 | `parked` | re-sliced, see plan/m7-reslice.md | feat(reviews): a weekly review that finds high fatigue or declining performance deloads th |
| m7-46-tools-periodisation-reads | `m7/46-tools-periodisation-reads` | PR 488 | `parked` | re-sliced, see plan/m7-reslice.md | feat(coach): let the coach check a week's interference and explain its schedule trade-offs |
| m7-52-hr-fields-ui              | `m7/52-hr-fields-ui`              | PR 443 | `parked` | re-sliced, see plan/m7-reslice.md | feat(profile): enter max, resting and threshold heart rate, and see run zones in bpm       |
| perf-workout-layout-motion      | `perf/workout-layout-motion`      | PR 454 | `merged` | none failing                      | perf(workout): no jumps between exercises, a smooth rest bar and aligned clocks            |
| ci-alone-third-shard            | `ci/alone-third-shard`            | PR 494 | `merged` | none failing                      | ci(e2e): a third shard for the alone·chromium perf leg, so it stays well inside its timeou |
| feat-program-start-date         | `feat/program-start-date`         | PR 496 | `owner`  | none failing                      | feat(programming): a program starts only after setup, and its start date can be moved      |
| claude-quirky-bohr-h9l613       | `claude/quirky-bohr-h9l613`       | PR 502 | `merged` | none failing                      | feat(programming): move some easy runs to a zone 2 bike when the owner has one             |

## Next work

Everything still needed to finish the product requirements that no open pull request covers,
from a gap analysis of `docs/product-requirements.md` and every milestone's acceptance criteria
against `main` on 2026-11-21. Rows are in the order to build them. `Depends on` names rows in this
file or open pull requests; a row can start only when all of them are merged.

Where a row's spec names a plan, the plan is in the git history, with a goal and acceptance
criteria per slice:

- M6 plan: `git show fe561ee6:docs/handoff/plans/m6-plan.json`
- M7 plan: `git show fe561ee6:docs/handoff/plans/m7-plan.json`
- M9 plan: `git show fe561ee6:docs/handoff/plans/m9-plan.json`

Size is a guess: S is one small pull request, M is one pull request, L must be split into smaller
rows before it is built.

### UI: the Paper redesign

The owner redesigned the app in Paper. The file is `Performance Coach — App flow`, and the page
`Instrument · all screens` holds ten artboards, one per area, each with numbered phone screens
labelled with their route. The page `Desktop` shows the same screens in a 1440 × 900 window: a left
rail instead of the tab bar, two columns where a phone has one, and sheets as centred dialogs. The
goal of these rows is that the shipped app matches those designs. They change how screens look
and are laid out. They do not change behaviour, data, routes or copy the design does not show.

These rows come first because later UI rows should be built on the new primitives. Between
`ui/01` and the last screen row, production shows new tokens on old layouts; that is expected.

How every row in this section is specified and built:

- **The spec comes from Paper, read through the Paper tools, by the session that writes it.** The
  `builder` agent has no Paper tools, so the spec must carry the exact values. Call `get_guide`
  with `paper-mcp-instructions` first, find the artboard and screen by name with `get_basic_info`
  and `get_tree_summary`, then read `get_jsx` (with `includeNodeIds: false`) and
  `get_computed_styles`. Never take a size or a colour from a screenshot; screenshots are only for
  checking the result.
- **Paper's token list is stale.** It still lists the lime accent and no mono font, but the
  screens use an amber accent, monospace lowercase labels, squarer corners and a text-only tab
  bar. The nodes are the truth, not the token list. `ui/01` settles the token values once; later
  rows use tokens and never hard-code a value.
- **Paper must be open on that file** for the tools to answer. If they do not, park the row with
  that reason. Do not build from memory or from a screenshot.
- **Each screen row covers the phone screen and its frame on the `Desktop` page.**
- **The design is dark only.** Keep the light theme working: `ui/01` derives light values for
  every token it changes and keeps the contrast checks in `src/lib/ui/charts/palette.test.ts` and
  the axe runs green. The owner reviews light mode at `ui-signoff`.
- **Verification.** The journeys in the `verify-coach` feature map must still pass; update a
  selector only when the design removed or renamed the control, never to get a pass. Each row
  updates `docs/design-system.md` and the `/design` page for anything it adds, and the screen
  gallery workflow's captures are the evidence the reviewer compares with Paper.
- Keep the motion and performance budgets. A new font is subset and budgeted like the others
  (`src/lib/ui/styles/fonts.css`, `src/lib/ui/fonts.ts`).

Rows `ui/04` to `ui/20` touch different screens and can run side by side once their dependencies
are merged. Many open pull requests and M7 rows touch the same screens; the rule against two rows
changing the same files in the local stage applies.

| Id                          | Slice                                                                                                                    | Depends on                                                                         | Status       | Spec                                                                                                                                                                                                    | Size |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| ui/01-instrument-tokens     | The tokens, type and fonts are the Instrument design's: amber accent, mono labels, new radii and surfaces                |                                                                                    | `needs-spec` | Paper, every artboard on `Instrument · all screens`; read values from the nodes. `src/lib/ui/styles/`, `docs/design-system.md`, `/design`. Record the change of accent and type in `docs/decisions.md`. | M    |
| ui/02-instrument-primitives | Buttons, cards, rows, chips, segmented controls, fields, steppers, stats, sheets and section labels look like the design | ui/01                                                                              | `needs-spec` | Paper, the repeated parts across all ten artboards. `src/lib/ui/components/`. Split by component group if it is too large for one pull request.                                                         | L    |
| ui/03-shell-nav             | The text tab bar, the resume bar, page headers, and on desktop the left rail and sheets as centred dialogs               | ui/02                                                                              | `needs-spec` | Paper, the tab bar and resume bar on `3 · Today`, and the `Desktop` page. `src/routes/(app)/AppShell.svelte`, `AppNav`, `ResumeBar`, `BottomSheet`.                                                     | M    |
| ui/04-get-in                | Sign in and Lost passkey                                                                                                 | ui/02                                                                              | `needs-spec` | Paper, `1 · Get in`: Sign in, Recover. `src/routes/AuthScreen.svelte`, `src/routes/recover`, `src/routes/setup`.                                                                                        | S    |
| ui/05-first-run             | Onboarding steps and the setup card on Today that resumes them                                                           | ui/03                                                                              | `needs-spec` | Paper, `2 · First run`: Welcome, Goals, Experience, Setup card. The other steps follow the same pattern. `src/routes/onboarding`.                                                                       | M    |
| ui/06-today                 | Today: the week strip, today's sessions as a timetable with one Start workout, up next, the coach, goals, this week      | ui/03                                                                              | `needs-spec` | Paper, `3 · Today`: A training day, A rest day, Twelve weeks in. `src/routes/(app)/today`.                                                                                                              | M    |
| ui/07-train                 | Train: the week, a session with Move, Adjust and Skip sheets, and program history                                        | ui/03                                                                              | `needs-spec` | Paper, `4 · Train`: The week, A session, Program history. `src/routes/(app)/train`.                                                                                                                     | M    |
| ui/08-workout-logger        | The live workout: log a set with amber readouts and the set gauge, then rest                                             | ui/02                                                                              | `needs-spec` | Paper, `5 · Workout`: Log a set, Rest. `src/routes/workout` (`Logger`, `SetEditor`, `WorkoutHeader`, `WorkoutClock`). Run `verify-workout-sync` only if sync code changes; it should not.               | M    |
| ui/09-workout-sheets        | The workout's sheets: This hurts and Finish, and the other sheets in the same pattern                                    | ui/08                                                                              | `needs-spec` | Paper, `5 · Workout`: This hurts, Finish. `src/routes/workout/*Sheet.svelte`, `Summary.svelte`.                                                                                                         | M    |
| ui/10-workout-run           | Logging a run: entry, segments, totals, how it felt                                                                      | ui/08                                                                              | `needs-spec` | Paper, `5 · Workout`: A run. `src/routes/workout/run`.                                                                                                                                                  | M    |
| ui/11-progress-overview     | Progress Overview, the period picker, and the charts' look                                                               | ui/03                                                                              | `needs-spec` | Paper, `6 · Progress views`: Overview. `src/routes/(app)/progress`, `src/lib/ui/charts`, `src/lib/ui/analytics`.                                                                                        | M    |
| ui/12-progress-views        | The Strength, Running and General views                                                                                  | ui/11                                                                              | `needs-spec` | Paper, `6 · Progress views`: Strength, Running, General.                                                                                                                                                | M    |
| ui/13-progress-history      | An exercise's page, workout history, and one finished workout                                                            | ui/11                                                                              | `needs-spec` | Paper, `6 · Progress views`: An exercise, Workout history; `7 · Progress history and reviews`: A workout.                                                                                               | M    |
| ui/14-reviews-list          | The reviews list and its weekly-due and cycle-due states                                                                 | ui/11                                                                              | `needs-spec` | Paper, `7 · Progress history and reviews`: Reviews, A weekly review is due, A cycle review is due. `src/routes/(app)/progress/reviews`.                                                                 | S    |
| ui/15-review-pages          | The weekly review and the cycle review                                                                                   | ui/14                                                                              | `needs-spec` | Paper, `7 · Progress history and reviews`: Weekly review, Cycle review.                                                                                                                                 | M    |
| ui/16-coach-thread          | Coach: a new conversation, the composer, and a proposal in a thread                                                      | ui/03                                                                              | `needs-spec` | Paper, `8 · Coach`: A new conversation, A proposal. `src/routes/(app)/coach`, `src/lib/ui/coach`.                                                                                                       | M    |
| ui/17-coach-sheets          | What the coach knows, as a sheet, and the proposals inbox                                                                | ui/16                                                                              | `needs-spec` | Paper, `8 · Coach`: What it knows, Proposals inbox. `src/routes/(app)/coach/proposals`.                                                                                                                 | M    |
| ui/18-profile               | Profile's main page                                                                                                      | ui/03                                                                              | `needs-spec` | Paper, `9 · Profile`: Profile. `src/routes/(app)/profile`, `src/lib/ui/profile`.                                                                                                                        | M    |
| ui/19-profile-sections      | Profile's section editors and Security                                                                                   | ui/18                                                                              | `needs-spec` | Paper, `9 · Profile`: Equipment, Schedule, Security. The other sections follow the same pattern. `src/routes/(app)/profile/[section]`, `security`.                                                      | M    |
| ui/20-states                | Offline, Couldn't load and Not found keep the shell and say what to do next                                              | ui/03                                                                              | `needs-spec` | Paper, `10 · States`. `src/routes/(app)/offline`, `ErrorPage.svelte`, `ErrorView.svelte`, `OfflineToday.svelte`.                                                                                        | S    |
| ui/21-parity-pass           | Every screen is compared with its Paper screen on phone and desktop, and the differences are fixed                       | ui/04, ui/05, ui/06, ui/07, ui/09, ui/10, ui/12, ui/13, ui/15, ui/17, ui/19, ui/20 | `needs-spec` | The screen gallery workflow's captures against Paper screenshots of the same screens. List each difference, fix it at its component, and leave the list in the pull request for `ui-signoff`.           | M    |

### M7: advanced coaching

The `m7r/` rows rebuild the parked M7 pull requests (PR 416 to PR 499) as small slices that each
land on today's `main` by themselves. `plan/m7-reslice.md` gives each one its source commits,
its size, its risk and the test that proves it. Rows marked Screen or Plans in that file change
the live app, or the next plan it makes, as soon as they merge. After them come the M7 plan's
slices that no old pull request covered, without its test-only slices.

| Id                                  | Slice                                                                                                 | Depends on                                         | Status       | Spec                                          | Size |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------ | --------------------------------------------- | ---- |
| m7r/01-stage-list                   | The generator's stages live in their own files with a prepare hook; every plan stays byte for byte    |                                                    | `needs-spec` | `plan/m7-reslice.md`, m7r/01 (PR 416)         | S    |
| m7r/02-generator-season             | New programs are planned by effective goal priority and the season                                    | m7r/01                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/02 (PR 418)         | M    |
| m7r/03-generator-schedule           | Every planned week is repaired by the scheduler, so no clash stands unexplained                       | m7r/02                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/03 (PR 419)         | M    |
| m7r/04-phasing-strength             | Each week's strength prescriptions follow its block type: rep schemes and dose bands                  | m7r/03                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/04 (PR 421)         | S    |
| m7r/05-phasing-hypertrophy          | Hypertrophy weeks set sets per muscle group from the block                                            | m7r/04                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/05 (PR 421)         | S    |
| m7r/06-periodised-targets           | Progress and the reviews judge an M7 week by the targets its own plan set                             | m7r/05                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/06 (PR 423)         | S    |
| m7r/07-running-paces                | Runs are paced from current fitness: VDOT paces and marathon pace on steady segments                  | m7r/05                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/07 (PR 422)         | S    |
| m7r/08-running-long-runs            | Marathon and half blocks get safe long-run steps, cutback weeks and race-specific work                | m7r/07                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/08 (PR 422)         | S    |
| m7r/09-combat-camp                  | Muay Thai follows the fight camp: capped sparring, conditioning rounds and a sharpening fight week    | m7r/08                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/09 (PR 426)         | M    |
| m7r/10-hr-zones                     | The owner enters max, resting and threshold heart rate, and a run session shows its zones in bpm      | m7r/08                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/10 (PR 435, PR 443) | S    |
| m7r/11-next-cycle-season            | The cycle review plans the next block from the season: block type, week targets, deloads and tapers   | m7r/02                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/11 (PR 434)         | S    |
| m7r/12-placement-why                | A read of why each session sits on its day, from the program's own decisions                          |                                                    | `needs-spec` | `plan/m7-reslice.md`, m7r/12 (PR 455)         | S    |
| m7r/13-why-this-day                 | Train shows "Why this day?" under each session card, without JavaScript                               | m7r/12                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/13 (PR 455)         | S    |
| m7r/14-evaluation-context           | The week evaluator can be given what was done, the goal priorities, the week's kind and the events    | m7r/12                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/14 (PR 462)         | S    |
| m7r/15-evaluation-wiring            | Train's week findings are judged with that context and suggest a fix                                  | m7r/13, m7r/14                                     | `needs-spec` | `plan/m7-reslice.md`, m7r/15 (PR 462)         | S    |
| m7r/16-move-evaluation              | A move is judged by M7's rules; the Move sheet shows each day's heads-up and the day that clears it   | m7r/15                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/16 (PR 497)         | M    |
| m7r/17-review-evaluator             | Domain: judge a reviewed week and next week's changes with M7's evaluator                             | m7r/15                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/17 (PR 481)         | M    |
| m7r/18-review-wiring                | The weekly review uses that evaluator on the load that was logged                                     | m7r/14, m7r/17                                     | `needs-spec` | `plan/m7-reslice.md`, m7r/18 (PR 481)         | S    |
| m7r/19-road-view                    | A road view read: blocks, goal modes, events, deloads and tapers from today to the last event         | m7r/02, m7r/12                                     | `needs-spec` | `plan/m7-reslice.md`, m7r/19 (PR 476)         | S    |
| m7r/20-week-kind-marks              | Train and Today mark light and special weeks, with why they are lighter and a countdown               | m7r/19                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/20 (PR 487)         | M    |
| m7r/21-season-model                 | Train's server load carries the season: road faults, season rows and week rows                        | m7r/20                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/21 (PR 499)         | S    |
| m7r/22-season-timeline              | The plan sheet shows the season: each block's goals, deloads and events                               | m7r/21                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/22 (PR 499)         | S    |
| m7r/23-tool-interference            | The coach can check a week's interference, and propose moves without a draft                          | m7r/15, m7r/19                                     | `needs-spec` | `plan/m7-reslice.md`, m7r/23 (PR 488)         | M    |
| m7r/24-tool-tradeoffs               | The coach can explain the schedule's trade-offs from the program's decisions                          | m7r/23                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/24 (PR 488)         | S    |
| m7r/25-replan-rules                 | Domain: a re-plan's rules, types and skeleton, and where it starts                                    | m7r/11                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/25 (PR 461)         | M    |
| m7r/26-replan-regenerate            | Domain: a re-plan from a Monday regenerates the rest of the block                                     | m7r/25                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/26 (PR 461)         | S    |
| m7r/27-replan-taper-deload          | Domain: a re-plan can splice in a taper or deload one week in place                                   | m7r/26                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/27 (PR 461)         | S    |
| m7r/28-replan-store                 | A re-plan is stored as a new version, cut or replaced at a Monday, with history untouched             | m7r/27                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/28 (PR 469)         | M    |
| m7r/29-replan-store-deload          | A one-week deload is stored in place, and a cut block gets no cycle review                            | m7r/28                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/29 (PR 469)         | S    |
| m7r/30-replan-preview               | Preview a re-plan week by week, inside the caller's transaction                                       | m7r/14, m7r/27                                     | `needs-spec` | `plan/m7-reslice.md`, m7r/30 (PR 467)         | M    |
| m7r/31-replan-proposal-kind         | A `replan` proposal kind, with the reasons a stale one is refused (migration 0034)                    | m7r/30                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/31 (PR 486)         | S    |
| m7r/32-replan-apply                 | An accepted re-plan is checked again and applied once; nothing proposes one yet                       | m7r/29, m7r/31                                     | `needs-spec` | `plan/m7-reslice.md`, m7r/32 (PR 486)         | S    |
| m7r/33-replan-propose               | The coach can propose a re-plan, and its card says what changes                                       | m7r/32                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/33 (PR 486)         | S    |
| m7r/34-priority-replan              | Changing goal priorities proposes a re-plan, and never blocks the save                                | m7r/33                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/34 (PR 498)         | S    |
| m7r/35-deload-assess                | The weekly snapshot can record a deload, and a reactive deload can be assessed                        | m7r/18, m7r/33                                     | `needs-spec` | `plan/m7-reslice.md`, m7r/35 (PR 493)         | S    |
| m7r/36-deload-in-review             | A weekly review that finds high fatigue or declining performance proposes a deload for the next week  | m7r/35                                             | `needs-spec` | `plan/m7-reslice.md`, m7r/36 (PR 493)         | S    |
| m7/47-tools-periodisation-proposals | The coach can propose a block, a deload or a taper                                                    | m7r/24, m7r/33, m7r/36                             | `ready`      | M7 plan, slice of the same name               | M    |
| m7/48-coach-periodisation-context   | The coach knows this week's clashes, the block it is in and what lies ahead                           | m7/47, m7r/19, m7r/15                              | `ready`      | M7 plan, slice of the same name               | M    |
| m7/49-replan-notice-ui              | After goal priorities change, Profile and Train show the re-plan waiting                              | m7r/34, m7r/22                                     | `ready`      | M7 plan, slice of the same name               | M    |
| m7/50-replan-proposal-card          | Re-plan proposals say where they came from, what changes week by week, and why a stale one is refused | m7r/33, m7r/34, m7r/36                             | `ready`      | M7 plan, slice of the same name               | M    |
| m7/51-deload-review-ui              | The weekly review proposes a deload in plain words, with the signals that led to it                   | m7r/36, m7r/20                                     | `ready`      | M7 plan, slice of the same name               | M    |
| m7/58-rules-reference               | A rules reference generated from the registry: every rule, its values and its why                     | m7r/06, m7r/09, m7r/10, m7r/27, m7r/36             | `ready`      | M7 plan, slice of the same name               | S    |
| m7/59-docs-m7                       | M7's docs: the periodisation ADR accepted, the test inventory, measured performance, milestone status | m7/51, m7/58, m6/63-docs-m6-status, m7r/10, PR 482 | `ready`      | M7 plan, slice of the same name               | M    |

### Gaps outside the plans, and milestone verification

| Id                        | Slice                                                                                                         | Depends on               | Status       | Spec                                                                                                                                                | Size |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| m6/63-docs-m6-status      | M6's docs: where the milestone stands, with its measured numbers                                              | PR 482                   | `ready`      | M6 plan, slice `m6/63-docs-m6-status`                                                                                                               | S    |
| feat/run-session-actions  | Part 1: during a run or a class, This hurts and Skip this segment (PR 517)                                    |                          | `merged`     | PRD section 6, "equivalents for other disciplines where possible". The actions sheet is strength-only today. PR 502 is related.                     | M    |
| feat/run-session-swap     | Part 2: Swap it during a run or a class                                                                       | feat/run-session-actions | `owner`      | The owner picks how a swap works: a zone 2 bike for a run and a lighter class type for a class (recommended), a swap within the same kind, or none. | M    |
| docs/real-device-coach    | The real-device checklist gets coach items: a streamed answer, Stop, Accept on a proposal, the offline notice | PR 468                   | `needs-spec` | `docs/testing.md`, the real-device checklist                                                                                                        | S    |
| docs/real-device-progress | The real-device checklist gets items for Progress charts and for a weekly and a cycle review                  | PR 482                   | `needs-spec` | `docs/testing.md`, the real-device checklist                                                                                                        | S    |
| docs/adr-remaining        | The last `NNNN-` ADRs are numbered and ADR 0011 is marked Superseded                                          | m7/59, PR 482            | `needs-spec` | `docs/known-issues.md`. PR 482 numbers three of the six; this takes the rest.                                                                       | S    |
| docs/env-gaps             | The seven `docs/environment.md` gaps are closed, so docs strict mode can switch on                            |                          | `needs-spec` | `scripts/docs-known-gaps.json`                                                                                                                      | S    |

### M9: hardening and release

The M9 plan's slices 1 to 25 are merged. These are the rest that an agent can build. The test-heavy slices (security, accessibility and copy sweeps, journey maps, the release-candidate run, performance) were removed on 2026-11-22 by the owner's decision, with the M8 councils.

| Id                               | Slice                                                                                                 | Depends on                               | Status   | Spec                                                                                                                                                | Size |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| m9/26-backup-fidelity-all-tables | Every table survives a backup and restore round trip                                                  |                                          | `merged` | M9 plan, slice `m9/26-backup-fidelity-all-tables`. Tests exist on `main`; check they seed every table, then close the row or build what is missing. | S    |
| m9/30-session-rotation           | Every way of signing in revokes the session it was given                                              |                                          | `merged` | M9 plan, slice `m9/30-session-rotation`. Tests on `main` mention rotation; check each way in, then close the row or build what is missing.          | S    |
| m9/27-runtime-role               | A least-privilege database role that can never truncate or alter, applied on every restore            |                                          | `owner`  | PR 521 is green. Merge after the owner confirms `rolcreaterole` is `t` on production (see the PR).                                                  | M    |
| m9/34-headers-hardening          | API JSON is never cached, resources are same-origin only, and errors and redirects carry full headers |                                          | `merged` | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/35-abuse-limits               | Every public POST is rate-limited, every body is size-capped, cookies are hardened                    |                                          | `ready`  | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/38-log-redaction              | No secret, token or personal text in logs or error records                                            |                                          | `merged` | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/51-backup-runs-db             | An immutable log of backup runs                                                                       | m9/27                                    | `ready`  | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/52-backup-status              | Profile shows when the last backup ran, with a calm warning if backups stopped                        | m9/51                                    | `ready`  | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/56-readme-screens             | The README shows current status and real screenshots from seeded data                                 | PR 468, PR 482                           | `ready`  | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/60-release-1-0                | Version 1.0.0, a tag and a changelog                                                                  |                                          | `ready`  | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/61-docs-m9                    | Docs strict mode is on and every doc is current for 1.0                                               | docs/env-gaps, docs/adr-remaining, m9/60 | `ready`  | M9 plan, slice of the same name                                                                                                                     | M    |

## Waiting on the owner

The loop cannot do these. Each stays here until the owner does it and marks it `merged` or removes
the row. Rows above that depend on one of these wait for it.

| Id                         | What is needed                                                                                       | After                                             | Note                                                                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| m4-signoff                 | M4: review the strength journey's screenshots, and run the workout item of the real-device checklist |                                                   | Agents cannot judge the screens or hold the phone. Record the result in `docs/milestones.md`.                                                                                                                                              |
| m5-screenshot-review       | M5: review the coach screenshot set                                                                  | PR 468                                            | The launch did not wait for it; it is still unrecorded.                                                                                                                                                                                    |
| m5-live-suite              | M5: run the live suite against the real model for the first time                                     |                                                   | `LIVE_LLM=1 pnpm test:live` with the API key, capped at $1. It has never run.                                                                                                                                                              |
| m7-open-questions          | M7: answer the plan's 21 open questions                                                              |                                                   | Deload cadence, taper percentages, sparring caps, the six-hour same-day gap, the ten-block cap, whether a re-plan replaces your own moves. They are in the M7 plan's `openQuestions`. Until answered, slices build to the plan's defaults. |
| m9/21-auth-change-email    | Decide whether changing the owner's email is still wanted                                            |                                                   | The email sign-in link was dropped on 2026-11-07, but its code, PRD section 13 and ADR 0011 remain.                                                                                                                                        |
| real-device-pass           | Run the coach and Progress items on the iPhone and desktop Chrome                                    | docs/real-device-coach, docs/real-device-progress | Also the only check of the glass effects.                                                                                                                                                                                                  |
| backup-secrets             | Confirm production backups run                                                                       |                                                   | Needs `BACKUP_ENCRYPTION_KEY`, `BLOB_READ_WRITE_TOKEN` and `CRON_SECRET` in Vercel.                                                                                                                                                        |
| m9/59-restore-drill-record | Run the restore drill and record its times                                                           | m9/27, m9/52                                      | M9 criterion 2. Needs the backup key. The table in `docs/deployment.md` is blank.                                                                                                                                                          |
| m9/62-signoff-record       | Sign off the deployed app                                                                            | m9/60                                             | M9 criterion 3.                                                                                                                                                                                                                            |
| ui-signoff                 | Review the redesigned app against the Paper file, on the iPhone and on desktop, in dark and light    | ui/21-parity-pass                                 | Agents can compare captures, but only the owner can say it is the design. The light theme is derived, not designed; say if it needs its own pass.                                                                                          |
| trace-evals                | Coach run trace and self-improving evals (eight PRs)                                                 |                                                   | `hold`. Not a PRD requirement. The plan in `plan/trace-evals/plan.md` is 738 commits old and needs three secrets. Lift the hold to have the loop re-check it against `main` and split it into rows.                                        |

## Lessons

What the loop has learned that should change how it works. One line each, newest first, with the
row that taught it. When the same lesson appears twice, the loop turns it into an edit to an agent
or skill file, in its own pull request, and removes the lines.

- Fixture Postgres URLs with a password fail the secrets scan (twice: PR 516, PR 521). `builder.md` now runs `pnpm security:scan` and builds fixture URLs from parts. (m9/27-runtime-role)
- The M7 stack (PR 416 onward) drifted about 490 commits behind `main`, and its base alone is 13k lines with a conflict. Re-slice it before the loop takes it. (m7-05-m7-stage-list)
- Light runs on `main` meant nothing tested `main`'s exact tree, and a Sunday-only failure sat there unseen: CI now runs `main` in full every night. (fix-progress-sunday-new-owner)
- A builder proving "fails without the change" used `git stash` and applied the owner's old stash into its worktree: the stash list is shared by every worktree. `builder.md` now forbids it. (m9/38-log-redaction)
- Squashing with `git reset --soft origin/main` after `main` moved folds a revert of everything `main` gained into the commit. Rebuild from the slice's own files and check `git diff --stat origin/main` before pushing. (m9/38-log-redaction)
- A perf fix that moves work out of the load window also moves it out of every check that measures that window. (m6-59-m6-perf, closed)
- A rebased pull request branch can only be pushed with `--force-with-lease`; `feature-slice` said never to force-push, which was meant for `main`. Fixed in the skill. (m5-61-docs-m5-status)

## Log

- 2026-11-22: re-sliced the M7 stack (PR 416 to PR 499) into 36 `m7r/` rows of about 400 lines each, in `plan/m7-reslice.md`. The old rows are parked and their pull requests stay open.
- 2026-11-22: merged train PR 520 (PR 517, PR 519), train PR 523 (PR 454, PR 522), PR 502. PR 496 and PR 521 are green and wait on the owner. ui/01 parked: Paper Desktop was not running.
- 2026-11-22: owner decisions. CI is simple and cheap: each change runs lint, type-check, unit and integration tests, the build and the PRD journeys on Chromium (8 jobs); the rest nightly; no performance testing. 40 test-heavy rows removed. More parallel rows, and merges in trains of up to six.
- 2026-11-22: merged PR 505, PR 468, PR 506, train PR 508 (PR 507, PR 494, PR 482), PR 510, PR 512, train PR 514 (PR 511, PR 417), train PR 518 (PR 513, PR 515, PR 516). Closed PR 413 (performance), PR 509 (folded into PR 511). m9/30 was already done on `main`.
  One line per loop action, newest first: the date, the row, what happened, and the PR.

- 2026-11-21 m5-61-docs-m5-status: started. PR 468 was 317 commits behind; rebased onto `main` with two docs conflicts resolved. Review found eight stale claims (the coach launch had already happened); fix round 1 applied; second review running. Not pushed yet.
