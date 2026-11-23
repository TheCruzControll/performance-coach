# Progress

What is built, what is in flight, and what is next. Acceptance criteria and evidence stay in
[milestones.md](milestones.md). Update this file in the change that moves a line.

Last updated: 2026-11-21, from `main` at the merge of #501 (2026-11-13).

## Milestones

"Recorded status" is what [milestones.md](milestones.md) says. "Merged slices" counts the
distinct slice branches (`m4/57`, `m5/46`, and so on) named in the git history, so it shows where
work has landed even though the milestone has not been signed off.

| #   | Milestone                       | Recorded status                                                        | Merged slices       |
| --- | ------------------------------- | ---------------------------------------------------------------------- | ------------------- |
| M1  | Foundation & infrastructure     | Done                                                                   | one PR              |
| M2  | Auth & profile                  | Done                                                                   | 34, plus 17 desktop |
| M3  | Training data model & programs  | Done                                                                   | 42 named in history |
| M4  | Workout application             | In progress: owner screenshot review pending                           | 55                  |
| M5  | AI performance coach            | In progress: launched; screenshot review and first live-suite run open | 55                  |
| M6  | Analytics & reviews             | Planned                                                                | 59                  |
| M7  | Advanced coaching               | Planned                                                                | 17                  |
| M8  | Performance & design refinement | Planned                                                                | none                |
| M9  | Final QA & production release   | Planned                                                                | 19                  |

M4 has evidence recorded per criterion and waits only on the owner's screenshot review and the
real-device checklist's workout item. M5 has evidence recorded per criterion; its screenshot review
and first live-suite run are open. M6, M7 and M9 have substantial merged work but no recorded
verification against their acceptance criteria. Treat them as built and unverified until someone
runs the criteria and updates milestones.md.

## Recently merged

- The app's look starts following the Paper redesign: an amber accent, new type and square corners
  (#581). The owner has since queued Instrument v2, which replaces it.
- Each planned week is repaired across the week boundary, so a hard Sunday leads to an easier
  Monday, and a clash the planner keeps says why (#591).
- The coach can propose a block, a deload or a taper, and knows this week's block in every turn.
- Re-plan proposals say where they came from and what changes; a stale one, or a stale deload on
  the weekly review, can be proposed again.
- The cycle review plans the next block from the season, and the deload choice on the review still applies to it.
- During a run, Swap moves the rest of it to a zone 2 bike; during a Muay Thai class, Swap offers a
  lighter format.
- A least-privilege database role for the app, re-granted by every migration and restore. Production switches to it in an owner step.
- The workout screen no longer jumps between exercises or when the rest timer comes and goes,
  and the rest bar and stopwatch move together.
- During a run or a class, This hurts records the pain and ends the session; a run can skip a segment.
- A program starts only after setup, on any day the owner picks, and its start date can be moved
  from Train until the first planned day, re-planning rather than shifting.
- End a plan and build a new one, keeping every logged workout (#501).
- The coach answers again, and programs can lift and run beside timed classes (#500).
- The agent architecture rewritten from the code, with a generated tools catalogue, and the coach
  ADRs accepted (#463).
- End-to-end proof of the cycle loop and the weekly review loop, on iPhone and desktop (#414,
  #412).
- Train shows what a weekly review changed, and Today and Progress prompt for a review when a week
  or block completes (#411, #409).
- The coach writes up each weekly and cycle review, and the owner can discuss it (#407).

## In flight

- **Weight tracking, started.** The trend, weekly rate, stats and log book are in the domain
  (`src/lib/domain/analytics/weight.ts`), and the goal line, milestones, verdicts and phase
  suggestion are in `src/lib/domain/analytics/weight-goal.ts`. The data slice adds one weigh-in
  per owner per day and the weight goal and milestone tables. The owner's weigh-ins are logged,
  replaced, edited, deleted and undone (a coach write) in `src/lib/server/services/weight/entries.ts`,
  and the Weight view, Today's figures and the coach's facts are read in
  `src/lib/server/services/weight/read.ts`. The one weight goal is set, edited, cleared and kept as
  history in `src/lib/server/services/weight/goals.ts`, and the profile's target follows it. The
  coach reads the trend, rate, stats, log rows and goal through `get_body_weight`
  (`src/lib/server/agent/tools/weight.ts`). The owner's forms are in `src/lib/server/forms/weight.ts`,
  wired to Progress's and Today's actions, and the coach's Undo of a weigh-in is
  `POST /api/coach/weights/[id]/undo`. The weekly review's `goals` finding reads the week's trend
  change and the goal's verdict (`src/lib/domain/programming/review/weekly.ts`), and an edited
  weigh-in makes the review stale. The coach records a weight the owner states in their
  message (`log_body_weight`, `src/lib/server/agent/tools/weight.ts`, with the check in
  `src/lib/domain/coach/weight-statement.ts`) at once, with source `coach`; its answer says so and
  mentions Undo. The Undo card is the next PR, and the screens come after it.
- **M7, re-sliced.** On 2026-11-22 the parked M7 pull requests were re-sliced into 38 `m7r/`
  rows in `plan/m7-reslice.md`. By the end of that day every row that does not wait on m7r/03
  had merged, along with m7/47 to m7/51. That covers the generator's stages and season, Train's
  week findings and the season timeline, the coach's interference and trade-off reads, the whole
  re-plan path with its notice, proposal card and Propose again, the weekly review's deload, and
  the coach's block, deload and taper proposals with this week's block in every turn. m7r/03 is
  built: each block's day pattern is planned across week boundaries, and every clash a generated
  week keeps is recorded as explained (a priority trade-off or a schedule_kept decision). m7r/04 to
  m7r/10, m7/58 and m7/59 build on it. The old M7 pull requests stay open until their rows merge.
- **The Paper redesign, Instrument v2.** Queued by the owner in `plan/queue.md`; the first
  Instrument rows after its tokens are on hold.
- **Adding a session to a program.** The builder, the storage
  (`src/lib/server/services/programs/add.ts`) and Train's Add session sheet are built; the coach's
  proposal is next.
- **Coach run trace and self-improving evals.** Planned, nothing built. The plan is eight PRs in
  `plan/trace-evals/plan.md`, written 738 commits ago, so its file pointers need re-checking
  against `main` before anyone builds from it. The owner must provide three secrets before the
  later PRs, listed in `plan/trace-evals/README.md`.

## Next

- Land or close the 32 open pull requests.
- Finish M4: the owner's screenshot review and the real-device workout check.
- Finish M5: the owner's screenshot review (#405), the first live-suite run, an inbox Lighthouse
  number, and a coach item on the real-device checklist.
- Verify M6 against its acceptance criteria and record the evidence in milestones.md.
- M8: the performance and design councils, which fill the skeletons in `docs/reports/`.
- M9: security review, the restore drill, and owner sign-off on the deployed app.
