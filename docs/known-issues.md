# Known issues

Open problems, stale docs and claims nobody has verified. Add an entry when you find one, and
delete it in the change that fixes it. Each entry says what is wrong, how it was found, and what
would close it.

Last reviewed: 2026-11-23, against `main` at the merge of #618.

## Product limits

- **A body save from a second source fails briefly during the weight-tracking deploy.** For the few minutes before the new code is live, or after a rollback past it, the old body save meets the one-per-day index (`body_weight_entries_owner_day_uq`): a Profile save on a day that already has an onboarding weigh-in answers 500 and saves nothing. It closes once the new code serves, which replaces the day's entry.
- **The coach cannot ground a negative figure, so a signed change may be flagged.** The grounding check (`src/lib/domain/coach/grounding.ts`, the number pattern) reads a figure as written and has no minus sign, so `get_performance_trends`' signed delta and percentage can be flagged as ungrounded when the model quotes them with the sign. `get_body_weight` avoids this: it returns each change as an unsigned size with a direction (up, down or flat), and the answer says "down 0.4 kg a week".
- During a run, This hurts on segment 51 or later is refused, because a pain report's position is
  capped at 50 (`src/lib/domain/workout/schemas.ts`); the owner can only discard it. Runs plan up
  to 100 segments, so this needs an unusually long run.
- A zone 2 bike session counts in the planned running volume. The generator sizes the week's run
  volume before some easy runs become bike sessions, so the next block's run volume may start lower
  than planned. Unconfirmed.
- A run swapped to the zone 2 bike counts as two workouts in the week's count. The bike's minutes
  count as running training time and load, as planned zone 2 bikes do, never as running distance.
- Swap to the bike is offered whatever equipment the owner has: the device does not hold the
  equipment list.
- **A next block's first week is planned against no week before.** The schedule stage
  (`src/lib/domain/programming/stages/schedule.ts`) starts the load of the week before from nothing
  in a next-block generation, so the previous block's last week is not counted when the new block's
  first week is repaired and judged. Found reading the stage for m7r/03. The previous block is
  `previous.block` in `src/lib/domain/programming/next-block/generate.ts`. Closes when that week is
  passed into the stage as the week before, and a next block's first week is judged against it.
- **The schedule stage is not a fixed point on journeyHybrid's dosed plan.** Its lapse search
  (`src/lib/domain/programming/stages/schedule.ts`, the `candidates` and `pass` loop) stops at the
  first candidate week with no lapses. A second run starts from the first run's repaired sessions,
  so it can pick a different week, and the schedule changes. Found when the strength cap at RPE 8
  moved journeyHybrid's week 4 (m7r/04), which made the run-twice check in
  `src/lib/domain/programming/generate-schedule.test.ts` fail. That check leaves journeyHybrid out
  until this closes. Closes when the search is a fixed point, so a second run changes no session,
  and journeyHybrid goes back into the check.
- **The workout logger and the set edit sheet keep 56 px controls (v2 is 60) until v2/10.** Button
  and IconButton `lg` are 60 px everywhere else. The sticky logger (`src/lib/ui/workout/SetLogger.svelte`)
  and the set edit sheet (`src/routes/workout/SetEditSheet.svelte`) pin their controls at 56 px,
  because a phone has no room to grow the logger: it has broken CI three times. The phone test
  "the logger keeps 56 px controls" in `e2e/workout-log.e2e.ts` holds the pin. Closes when v2/10
  redesigns the set screen and removes both pins and that test's 56 px expectation. The steppers'
  text is pinned there too, at its pre-v2 size: the label at 13 px and the value at 56 px. Below a
  22 rem row (a 390 px phone), the v2 value would stack 12 px taller and the logger would grow.
- **Twelve files still style their own underlined links; screen rows move them to `.text-link`.**
  The links in running text are styled by each file: ProposalCard, RichText, Notice,
  ReplanNotice, ProgramHeader, ArchivedSheet, KnowsSheet, ThreadList, the proposal detail, and the
  three Train pages. (Toaster adopted `.text-link` in `v2/02c`.)
  Closes when each screen row adopts `.text-link` (or `Button variant="link"` for a standalone action).
- **`ListRow` still takes `icon` and `tone`, and draws neither.** v2 rows have no icon tiles, so
  both props are deprecated and accepted for the screens that still pass them.
  Closes when the last screen row drops them and `src/lib/ui/components/ListRow.svelte` removes them.
- **Cards, stat tiles, chips and segmented controls remain on screens until their v2 screen rows.**
  `v2/02d` flattened them and the tabs and badges too: no fill, pill, tint or amber, with their
  padding, borders and line boxes held, so no screen moves. v2 draws none of them, so each screen row
  removes the ones its screen does not need. `Badge` keeps its icon-side padding (`.with-icon`) so an
  icon badge keeps its width; the row that drops the pill drops it too. Closes when the screen rows
  have removed them.
- **On Train, the Rest timer row gains a hairline on its first hover.** Prefetch mounts the sheet's
  dialog as a sibling of the row, so the row's `:last-child` rule breaks. It stays until the Train
  screen row.
- **Toasts are at the top; v2 puts them above the tab bar (`v2/03`).** `v2/02c` restyled them and
  kept them at the top: above the tab bar they would cover the resume bar, the composer and the
  logger. Closes when `v2/03` moves them with the shell.
- **A taper splice's deload is judged by the tail's first range.** A taper spliced into a block
  (`splice` in `src/lib/domain/programming/periodisation/replan.ts`) gives the tail a new lineage,
  so the Strength view, the weekly review and the cycle review read the tail's own bands: its
  deload is judged by the tail's first range × the deload's factor, not by the range the block it
  was cut from set. Found in m7r/06 reading `blockBands` in
  `src/lib/domain/programming/planned-targets.ts`. Closes when a deload in a spliced tail is judged
  by the range its block set, or a test pins the first range as the intended judgement.
- **A first program's marathon blocks, and a first block that is a marathon or half taper, carry no running targets (`targets.running`), so their race work, long-run targets and race week without a long run reach only next blocks and re-plans.** A first program's half base, build and peak blocks do carry them. Found building m7r/07 and checked again in m7r/08 (`src/lib/domain/programming/running.ts`). Closes when a first program's marathon and taper weeks carry their running targets.
- **Heart-rate zones in bpm show only on the session screen.** The live run workout
  (`src/routes/workout/run/run-log.ts`) shows 'Zone 2' without bpm, and the coach's diff, a re-plan's
  changes, a session edit's change line (`segmentWords` in
  `src/lib/server/services/programs/edits.ts`) and `/design` read 'HR zone 2'
  (`src/lib/domain/training/describe.ts`). The plan's
  `hr_zones_set` decision keeps the rates of the day it was built, so after the owner edits them it
  can differ from the session screen until the next plan. Found building m7r/10. Closes when the
  workout shows bpm and the words agree.
- **A fight-camp week can lose a conditioning session twice over.** The other stage counts room the way placement does and leaves out what does not fit (`generator.camp_left_out`). Placement then treats conditioning as hard Muay Thai, so in a week where every free day sits next to a heavy lift it can drop the one the camp kept (`placement.every_day_clashes`). See journey with no classes in `placement.test.ts`. The owner sees both decisions. Found building m7r/09 (`src/lib/domain/programming/other.ts`). Closes when the camp's room count asks placement's clash rules, or conditioning is placed before the lifts.
- **In a tight fight-camp week, a held strength goal gives the camp no session.** A held lifting dose is M3's two-session maintenance split, and the camp takes a strength session only while the sessions left keep every major group at the week's `setsPerGroup` minimum (`generator.camp_room`). One session of that split never does, so in a week with no free day for them the camp's pad work, conditioning, technique and sparring are left out with `generator.camp_left_out`: recorded, not planned. journey's and multiGoal's camps show it (`src/lib/domain/programming/generate-combat.test.ts`). Found building m7r/09 (`src/lib/domain/programming/other.ts`). Revisit when doubles or a three-session maintenance split are allowed.
- **The camp counts a held goal's sets before the volume and progression stages.** So its check is strict in full weeks and loose in light ones: in a light week it compares the scaled minimum with sets not yet scaled down, so a tight fight week could take a lift and end below the band the analytics judge it by. No scenario does today. Found building m7r/09 (`src/lib/domain/programming/other.ts`). Fix by checking after the volume stage.

## Stale documentation

- **milestones.md lists M7 to M9 as Planned.** M6's row and criteria are updated. The git history
  holds merged slices for M7 and M9, and some M7 pull requests are open; the current counts are in
  [progress.md](progress.md). No evidence is recorded against those milestones' criteria. Closes
  when each milestone's criteria are run and the table is updated.
- **The README status block stops at Milestone 6.** It says nothing of the periodisation work (M7)
  that has merged. Closes when the README status is rewritten from [progress.md](progress.md).
- **The README repository map marks the coach as "(M5)" and the offline store as "(M4)"**, as if
  both were still to come. Both folders hold shipped code.
- **Three ADRs are still named `NNNN-` and Proposed**: encrypted backups, the periodisation
  engine, and lifecycles as data. Work under several of them has merged. Closes when the docs
  slice numbers them and sets their status. M6's three (trend classification, hand-built charts,
  planning later blocks) are accepted as 0015 to 0017.
- **ADR 0011 (email sign-in link) is still Accepted**, while milestones.md records that the owner
  dropped the emailed link on 2026-11-07. Not checked against the code. Closes when the ADR is
  marked Superseded or the note in milestones.md is corrected.
- **The app icons and favicon still use the old lime.** `static/favicon.svg`,
  `static/icons/*.svg` and the PNGs in `static/icons/` carry the volt lime `#c8f031`. Their canvas
  `#0a0a0b` matches Instrument v2's canvas again, as the theme colour and manifest do. The in-app
  brand mark (`static/brand/mark-arc.svg`, `--color-accent`) is amber, so it no longer matches the
  lime icons either. Closes when an icons row regenerates them with `pnpm icons` and the mark is
  decided.

## Verification gaps

- The Add session sheet has no e2e or verify-coach coverage yet.

- **The coach's weigh-in Undo card has no e2e test.** The mock provider has no script that logs a
  weigh-in, so no e2e turn can reach the card. Integration tests cover the event, the Undo answers
  and the card on reload (tests/integration/coach/weight-log.test.ts and screen-load.test.ts); the
  card's button is covered by the phase unit test only. Closes when a mock script logs a weigh-in
  and an e2e clicks Undo on the card.

- **The new fonts' CLS is not re-measured.** Mona Sans and Hubot Sans, with their metric-matched
  fallbacks, replace Geist and Geist Mono. The CLS of the audited routes has not been measured
  on them, so the expected value of about 0 is unproven. Closes when the routes in
  docs/performance.md are measured again.
- **M4 is not signed off.** The owner's screenshot review is pending and the real-device
  checklist's workout item (docs/testing.md, item 8) has not been run.
- **Glass effects are judged only on a real device.** Neither browser paints `backdrop-filter` in
  CI's headless iPhone projects, so the e2e screenshots cannot catch a regression there.
- **Performance is measured in the lab only.** Lighthouse and the main-thread budgets pass, but
  there are no real-device or RUM p75 numbers yet. M8's criterion on Core Web Vitals depends on
  them.
- **Production still connects as `neondb_owner`** until the owner switches `DATABASE_URL` to
  `coach_app_prod` (docs/deployment.md, 'Least-privilege runtime role'). The owner's direct URL
  also stays in Vercel's runtime environment. Closes on the switch, for the first part.

- **A move does not see an unsynced offline workout.** A workout started offline from a start kit
  of the old version, and not yet synced, is not counted when a move checks for logged workouts.
  After the move it syncs against a session the current version no longer has.

- **A swap can end the run without starting the bike.** If the app is killed between the two
  saves, or the bike's save fails, the run is finished and no bike session exists. Nothing logged
  is lost; start a session by hand.
- **A bike taken over on a second device has no planned minutes.** It is pinned to the run's
  planned session, so the other device loads the run's kit.
- **A meet's taper outline marks the wrong week.** Inside a meet's taper outline block, the
  season marks the week before the meet as `taper`. The generator places the actual one-week taper
  in the meet week. Outline blocks hold no stored weeks yet, so nothing is shown wrong today. It may
  matter when the next block fills that outline in.

- **The cycle review's deload choices cover the last-week deload only.** "Skip the deload" does
  not remove a deload the rules or the season put in week 1. "Move it to the last week" can leave
  a season deload in week 1 as well, which gives two. A deload the owner moved to week 1 is
  explained with the rules' "fatigue to clear" wording.

- **M7 adds sequential reads to Train's load.** The week's findings and its evaluation context
  read the program, the profile, 49 days of facts and the planned sessions one after another. On
  CI's two-year dataset that adds about 60 ms to the median (`db:explain` prints it). On Neon,
  where each read is a round trip, expect more. It is not gated, since performance is not tested.

- **A deload's review still points at the stale proposal after Propose again.** The review keeps
  naming the proposal it was made from, so going back shows "This deload is out of date" for as long as
  the review names it. Propose again then answers with the open or applied proposal, so nothing is
  applied twice, but the card lags. Found while building m7/51's deload card
  (`src/routes/(app)/progress/reviews/[[key]]/next-week-actions.svelte.ts`). Closes when the review
  names the proposal that replaced its stale one, or the card reads that one.

- **The weekly review's body-weight finding is not on the review page.** The page draws only the
  sections in `SECTION_IDS` (`src/routes/(app)/progress/reviews/[[key]]/sections.ts`), so `goals` is
  stored and read by the coach but not shown. Closes when the page draws it.

- **An edited weigh-in older than the review's eight weeks does not make the review stale.** The
  Sunday trend runs over every weigh-in, but the digest covers the window's weigh-ins and the goal,
  so such an edit can move the trend slightly without the review saying so. The review also reads
  the active goal when it is computed, not the goal in force on its Sunday. Closes when the digest
  covers every weigh-in up to the Sunday and the review reads the goal in force then.

- **A weekly review with no body-weight finding does not go stale when a weigh-in is back-dated into its window.** Such a review was digested without weigh-ins, so the view judges it without them, which keeps reviews stored before the finding from going stale on deploy (migration 0036 stamped every weigh-in's `updated_at`). A weigh-in logged into its window later is therefore not shown as a change, and the view offers no refresh; a refresh still computes the finding. Closes when the digest of such a review covers the weigh-ins in its window too, without making reviews stored before the deploy stale.

- **M6's performance slice was closed unmerged, so the Progress and review screens have no
  main-thread, Lighthouse or chart-body budget on `main`.** m6/59 would have put those screens in
  the main-thread guard and Lighthouse, and added the chart-body check to `pnpm budgets`. It was
  closed on 2026-11-22, after the owner decided not to test performance in CI. Found reading the M6
  plan against `main` and `scripts/check-budgets.ts`. Closes when perf specs for the Progress and
  review screens exist (or m6/59's are revived), are run locally, and the numbers are recorded in
  docs/performance.md ("M6 (analytics and reviews)").

- **The `/progress` overview at 'all' misses its 150 ms page-load target.** Its median is 192.0 ms
  (p95 204.9 ms) on the explain run 45220282661, which is under the 300 ms gate. Found by that run,
  recorded in docs/performance.md ("M6 (analytics and reviews)"). Closes when a measured head puts
  the median under 150 ms, or the owner changes the target.

- **Chart chunk sizes are not measured.** `pnpm budgets` reports each route's totals and not its
  chart chunks, so no chart's gzip size is recorded. Closes when the budget output or
  docs/performance.md lists each chart body's size.

## Working on this repo

- **The repo needs Node 22 and refuses anything else.** `.npmrc` sets `engine-strict`, so a pnpm
  script run under another Node version fails before it starts. Check `node -v` first when a
  `pnpm` command fails with an engine error.
- **Every merge to `main` deploys production**, migrating the database first. Branch protection
  requires five checks and no review. Do not merge as a side effect of other work.

## Coach trace and evals plan

The plan in `plan/trace-evals/` was written 738 commits before the current `main`. Its file
pointers and its "nothing here is built yet" claim need re-checking before anyone builds from it.
These are the open questions recorded in its README. None is settled.

- Whether live model responses hold readable thinking text. Fixtures and the mock carry empty
  thinking with signatures.
- How well the LLM judge agrees with the owner's ratings.
- How often recorded tool outputs match a new run's tool calls during replay.
- Whether Vercel crons every 5 minutes and Neon branch creation fit the project's plans and
  limits.
- Whether any tool reads pain reports older than 28 days.
- The plan cites skills under a `~/dotfiles` path that must exist on the machine that executes it.
