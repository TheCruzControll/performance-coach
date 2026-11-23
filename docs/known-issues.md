# Known issues

Open problems, stale docs and claims nobody has verified. Add an entry when you find one, and
delete it in the change that fixes it. Each entry says what is wrong, how it was found, and what
would close it.

Last reviewed: 2026-11-21, against `main` at the merge of #501.

## Product limits

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

## Stale documentation

- **milestones.md lists M6 to M9 as Planned.** The git history holds merged slices for M6 (59), M7
  (17) and M9 (19), and 25 M7 pull requests are open. No evidence is recorded against those
  milestones' criteria. Closes when each milestone's criteria are run and the table is updated.
- **The README status block stops at Milestone 5.** It says nothing of the analytics, reviews or
  periodisation work (M6 and M7) that has merged. Closes when the README status is rewritten from
  [progress.md](progress.md).
- **The README repository map marks the coach as "(M5)" and the offline store as "(M4)"**, as if
  both were still to come. Both folders hold shipped code.
- **Three ADRs are still named `NNNN-` and Proposed**: encrypted backups, the periodisation
  engine, and lifecycles as data. Work under several of them has merged. Closes when the docs
  slice numbers them and sets their status. M6's three (trend classification, hand-built charts,
  planning later blocks) are accepted as 0015 to 0017.
- **ADR 0011 (email sign-in link) is still Accepted**, while milestones.md records that the owner
  dropped the emailed link on 2026-11-07. Not checked against the code. Closes when the ADR is
  marked Superseded or the note in milestones.md is corrected.
- **environment.md has seven accepted gaps**, listed in `scripts/docs-known-gaps.json`: five
  variables without a row and two rows that are not schema keys. The docs tests stay lenient
  until these are closed.

## Verification gaps

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
  naming the proposal it was made from, so going back shows "This deload is out of date" until the
  review is read again. Propose again then answers with the open or applied proposal, so nothing is
  applied twice, but the card lags. Found while building m7/51's deload card
  (`src/routes/(app)/progress/reviews/[[key]]/next-week-actions.svelte.ts`). Closes when the review
  names the proposal that replaced its stale one, or the card reads that one.

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
