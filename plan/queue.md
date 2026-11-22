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

### M7: advanced coaching

Thirteen slices of the M7 plan that are neither merged nor in an open pull request.

| Id                                   | Slice                                                                                                 | Depends on                                                                     | Status  | Spec                            | Size |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------- | ------------------------------- | ---- |
| m7/25-periodisation-plans            | M7's new database reads are checked by `db:explain`, so no slow query ships                           | PR 455, PR 462, PR 497                                                         | `ready` | M7 plan, slice of the same name | S    |
| m7/47-tools-periodisation-proposals  | The coach can propose a block, a deload or a taper                                                    | PR 488, PR 486, PR 493                                                         | `ready` | M7 plan, slice of the same name | M    |
| m7/48-coach-periodisation-context    | The coach knows this week's clashes, the block it is in and what lies ahead                           | m7/47, PR 476, PR 462                                                          | `ready` | M7 plan, slice of the same name | M    |
| m7/49-replan-notice-ui               | After goal priorities change, Profile and Train show the re-plan waiting                              | PR 498, PR 499                                                                 | `ready` | M7 plan, slice of the same name | M    |
| m7/50-replan-proposal-card           | Re-plan proposals say where they came from, what changes week by week, and why a stale one is refused | PR 486, PR 498, PR 493                                                         | `ready` | M7 plan, slice of the same name | M    |
| m7/51-deload-review-ui               | The weekly review proposes a deload in plain words, with the signals that led to it                   | PR 493, PR 487                                                                 | `ready` | M7 plan, slice of the same name | M    |
| m7/53-periodisation-scenario-suite   | Every PRD section 2 and 5 conflict example is proven by domain tests                                  | PR 419, PR 434, PR 435, PR 461                                                 | `ready` | M7 plan, slice of the same name | M    |
| m7/54-coach-periodisation-scenarios  | The same conflict examples run end to end through the coach with the mock provider                    | m7/47, m7/48, m7/53, PR 498, PR 493                                            | `ready` | M7 plan, slice of the same name | M    |
| m7/55-periodisation-explain          | M7's final query gate: the re-plan, road view, goal trigger and move queries                          | m7/25, m7/47, m7/48, m7/49, PR 476, PR 497, PR 498, PR 493, PR 434             | `ready` | M7 plan, slice of the same name | S    |
| m7/56-periodisation-perf             | The new M7 screens are held to the main-thread and Lighthouse budgets                                 | m7/49, m7/50, m7/51, PR 499, PR 497, PR 487, PR 443, PR 413                    | `ready` | M7 plan, slice of the same name | M    |
| m7/57-journey-concurrent-disciplines | A Playwright journey plans strength, a marathon and Muay Thai around each other                       | m7/49, m7/50, m7/53, PR 499, PR 497, PR 487, PR 455, PR 434                    | `ready` | M7 plan, slice of the same name | M    |
| m7/58-rules-reference                | A rules reference generated from the registry: every rule, its values and its why                     | m7/53, PR 426, PR 435, PR 461, PR 493, PR 423                                  | `ready` | M7 plan, slice of the same name | S    |
| m7/59-docs-m7                        | M7's docs: the periodisation ADR accepted, the test inventory, measured performance, milestone status | m7/51, m7/54, m7/55, m7/56, m7/57, m7/58, m6/63-docs-m6-status, PR 443, PR 482 | `ready` | M7 plan, slice of the same name | M    |

### Gaps outside the plans, and milestone verification

| Id                        | Slice                                                                                                         | Depends on     | Status       | Spec                                                                                                                            | Size |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---- |
| m5-verify                 | Confirm M5's recorded evidence against its acceptance criteria, once the M5 docs land                         | PR 468         | `ready`      | `docs/milestones.md`, M5. Run the `milestone-verifier` agent; every criterion already has a test on `main`.                     | S    |
| m6-verify                 | Verify M6 against its acceptance criteria and record the evidence                                             | PR 413, PR 482 | `ready`      | `docs/milestones.md`, M6. Run the `milestone-verifier` agent, then update `docs/milestones.md` and `docs/progress.md`.          | S    |
| m6/63-docs-m6-status      | M6's docs: where the milestone stands, with its measured numbers                                              | PR 482         | `ready`      | M6 plan, slice `m6/63-docs-m6-status`                                                                                           | S    |
| feat/run-session-actions  | During a run or a class, the same quick actions as for a lift: swap it, this hurts, skip                      |                | `needs-spec` | PRD section 6, "equivalents for other disciplines where possible". The actions sheet is strength-only today. PR 502 is related. | M    |
| docs/m4-perf-second-run   | M4's logging speed and responsiveness numbers come from two green CI runs, not one                            |                | `needs-spec` | `docs/milestones.md` M4 criteria 3 and 4; `docs/performance.md` says the second run is still to record                          | S    |
| docs/real-device-coach    | The real-device checklist gets coach items: a streamed answer, Stop, Accept on a proposal, the offline notice | PR 468         | `needs-spec` | `docs/testing.md`, the real-device checklist                                                                                    | S    |
| docs/real-device-progress | The real-device checklist gets items for Progress charts and for a weekly and a cycle review                  | PR 482         | `needs-spec` | `docs/testing.md`, the real-device checklist                                                                                    | S    |
| docs/adr-remaining        | The last `NNNN-` ADRs are numbered and ADR 0011 is marked Superseded                                          | m7/59, PR 482  | `needs-spec` | `docs/known-issues.md`. PR 482 numbers three of the six; this takes the rest.                                                   | S    |
| docs/env-gaps             | The seven `docs/environment.md` gaps are closed, so docs strict mode can switch on                            |                | `needs-spec` | `scripts/docs-known-gaps.json`                                                                                                  | S    |
| ci-model-check            | `verification/workout-sync/check.sh` runs in CI when the files it covers change                               |                | `needs-spec` | `.pi/skills/verify-workout-sync/SKILL.md`. `scripts/ci-workflow.test.ts` guards the workflow's shape.                           | S    |
| m7-verify                 | Verify M7 against its acceptance criteria and record the evidence                                             | m7/59          | `ready`      | `docs/milestones.md`, M7. Run the `milestone-verifier` agent.                                                                   | S    |

### M9: hardening and release

The M9 plan's slices 1 to 25 are merged. These are the rest that an agent can build.

| Id                               | Slice                                                                                                 | Depends on                                      | Status       | Spec                                                                                                                                                | Size |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| m9/26-backup-fidelity-all-tables | Every table survives a backup and restore round trip                                                  |                                                 | `needs-spec` | M9 plan, slice `m9/26-backup-fidelity-all-tables`. Tests exist on `main`; check they seed every table, then close the row or build what is missing. | S    |
| m9/30-session-rotation           | Every way of signing in revokes the session it was given                                              |                                                 | `needs-spec` | M9 plan, slice `m9/30-session-rotation`. Tests on `main` mention rotation; check each way in, then close the row or build what is missing.          | S    |
| m9/27-runtime-role               | A least-privilege database role that can never truncate or alter, applied on every restore            |                                                 | `ready`      | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/28-attack-surface             | The whole-app security review with a findings register (`docs/reports/security-review.md`)            |                                                 | `ready`      | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/29-surface-examples           | A seeded example URL for every dynamic route, for the security sweeps                                 | m9/28                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/31-authz-matrix               | Every page and endpoint refuses a recovery session and a cross-site request                           | m9/29                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/32-input-validation           | Malformed input to any POST gets a 4xx, never a 500, and writes nothing                               | m9/29, m9/31                                    | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/33-safe-methods               | GET and HEAD change nothing anywhere                                                                  | m9/29                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/34-headers-hardening          | API JSON is never cached, resources are same-origin only, and errors and redirects carry full headers | m9/29                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/35-abuse-limits               | Every public POST is rate-limited, every body is size-capped, cookies are hardened                    | m9/28                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/36-xss-stored-text            | Hostile text saved in any field renders as plain text everywhere                                      | m9/29                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/37-server-sinks               | Raw SQL only from reviewed constants, outbound calls only to known hosts                              | m9/28                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/38-log-redaction              | No secret, token or personal text in logs or error records                                            |                                                 | `ready`      | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/39-agent-adversarial          | A coach fed injected instructions still changes nothing without the owner, and cost stays capped      |                                                 | `ready`      | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/40-offline-exposure           | After sign-out or a revoked session nothing personal is left, and Back shows nothing                  | m9/29                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/41-deps-audit                 | CI fails on high or critical dependency advisories                                                    |                                                 | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/43-actions-pinned             | Every GitHub Action is pinned to a commit SHA                                                         | m9/41                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/42-smoke-specs                | A full browser production smoke: sign-in, headers, cookies, PWA, offline, accessibility               | m9/34                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/44-post-deploy-browser-smoke  | That smoke runs in Chromium and WebKit after every deploy                                             | m9/42, m9/43                                    | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/45-golden-path-journey        | One unbroken journey from a fresh profile to history and the coach, runnable on a preview             |                                                 | `ready`      | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/46-journeys-complete          | Every PRD journey and persistence case is mapped to its test, and the map is checked strictly in CI   | m7/57                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/47-a11y-route-coverage        | axe runs on every screen and state, from a registry built from the routes                             | m9/29                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/48-a11y-semantics             | One h1, landmarks, visible focus and no keyboard traps on every screen                                | m9/47                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/49-state-gallery              | Empty, loading, error and offline states are checked and captured per screen                          | m9/47                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/50-copy-guards                | No placeholder or debug copy, held by a glossary                                                      | m9/28                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/51-backup-runs-db             | An immutable log of backup runs                                                                       | m9/27                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/52-backup-status              | Profile shows when the last backup ran, with a calm warning if backups stopped                        | m9/51                                           | `ready`      | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/53-a11y-fixes                 | Every accessibility finding is fixed at its component                                                 | m9/47, m9/48                                    | `ready`      | M9 plan, slice of the same name                                                                                                                     | L    |
| m9/54-copy-state-fixes           | The copy and state problems the sweeps find are fixed                                                 | m9/49, m9/50                                    | `ready`      | M9 plan, slice of the same name                                                                                                                     | L    |
| m9/55-perf-report-script         | `pnpm perf:report` gathers lab numbers and a read-only RUM p75 per route                              |                                                 | `ready`      | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/56-readme-screens             | The README shows current status and real screenshots from seeded data                                 | PR 468, PR 482                                  | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/57-release-candidate-run      | A workflow that runs the full suite over HTTPS with retries off                                       | m9/44, m9/46, m9/53, m9/54                      | `ready`      | M9 plan, slice of the same name                                                                                                                     | M    |
| m9/60-release-1-0                | Version 1.0.0, a tag and a changelog                                                                  | m9/57, m9/58-preview-e2e-run                    | `ready`      | M9 plan, slice of the same name                                                                                                                     | S    |
| m9/61-docs-m9                    | Docs strict mode is on and every doc is current for 1.0                                               | docs/env-gaps, docs/adr-remaining, m9/28, m9/60 | `ready`      | M9 plan, slice of the same name                                                                                                                     | M    |

### M8: the performance and design councils

| Id                   | Slice                                                                                     | Depends on   | Status       | Spec                                                                                                                  | Size |
| -------------------- | ----------------------------------------------------------------------------------------- | ------------ | ------------ | --------------------------------------------------------------------------------------------------------------------- | ---- |
| m8/01-council-kit    | Briefs for the ten council roles, a blind scoring protocol and a capture bundle per round | m9/49, m9/55 | `needs-spec` | PRD section 17; `docs/reports/README.md`                                                                              | M    |
| m8/02-council-rounds | Performance and design rounds, each followed by fix slices, until the scores hold         | m8/01, m9/45 | `owner`      | PRD section 17 keeps the stopping criteria with the owner. The loop can run rounds once the owner says when they end. | L    |
| m8/03-fill-reports   | The Performance and Design reports are filled, with sources                               | m8/02, m9/55 | `needs-spec` | `docs/reports/`                                                                                                       | M    |

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
| rum-p75                    | Record real-use Core Web Vitals at p75                                                               | m9/55                                             | M8 criterion 2. Needs real use of the deployed app; the script makes it one command.                                                                                                                                                       |
| backup-secrets             | Confirm production backups run                                                                       |                                                   | Needs `BACKUP_ENCRYPTION_KEY`, `BLOB_READ_WRITE_TOKEN` and `CRON_SECRET` in Vercel.                                                                                                                                                        |
| m9/59-restore-drill-record | Run the restore drill and record its times                                                           | m9/27, m9/52                                      | M9 criterion 2. Needs the backup key. The table in `docs/deployment.md` is blank.                                                                                                                                                          |
| m9/58-preview-e2e-run      | Run the full suite against a preview deployment                                                      | m9/45                                             | Needs a real passkey setup on the preview.                                                                                                                                                                                                 |
| m9/62-signoff-record       | Sign off the deployed app                                                                            | m9/60                                             | M9 criterion 3.                                                                                                                                                                                                                            |
| trace-evals                | Coach run trace and self-improving evals (eight PRs)                                                 |                                                   | `hold`. Not a PRD requirement. The plan in `plan/trace-evals/plan.md` is 738 commits old and needs three secrets. Lift the hold to have the loop re-check it against `main` and split it into rows.                                        |

## Lessons

What the loop has learned that should change how it works. One line each, newest first, with the
row that taught it. When the same lesson appears twice, the loop turns it into an edit to an agent
or skill file, in its own pull request, and removes the lines.

- A rebased pull request branch can only be pushed with `--force-with-lease`; `feature-slice` said never to force-push, which was meant for `main`. Fixed in the skill. (m5-61-docs-m5-status)

## Log

One line per loop action, newest first: the date, the row, what happened, and the PR.

- 2026-11-21 m5-61-docs-m5-status: started. PR 468 was 317 commits behind; rebased onto `main` with two docs conflicts resolved. Review found eight stale claims (the coach launch had already happened); fix round 1 applied; second review running. Not pushed yet.
