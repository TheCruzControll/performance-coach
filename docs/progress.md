# Progress

What is built, what is in flight, and what is next. Acceptance criteria and evidence stay in
[milestones.md](milestones.md). Update this file in the change that moves a line.

Last updated: 2026-11-23, from `main` at the merge of #634.

## Milestones

"Recorded status" is what [milestones.md](milestones.md) says. "Merged slices" counts the
distinct slice branches (`m4/57`, `m5/46`, and so on) named in the git history, so it shows where
work has landed even though the milestone has not been signed off.

| #   | Milestone                       | Recorded status                                                         | Merged slices       |
| --- | ------------------------------- | ----------------------------------------------------------------------- | ------------------- |
| M1  | Foundation & infrastructure     | Done                                                                    | one PR              |
| M2  | Auth & profile                  | Done                                                                    | 34, plus 17 desktop |
| M3  | Training data model & programs  | Done                                                                    | 42 named in history |
| M4  | Workout application             | In progress: owner screenshot review pending                            | 55                  |
| M5  | AI performance coach            | In progress: launched; screenshot review and first live-suite run open  | 55                  |
| M6  | Analytics & reviews             | In progress: 61 slice PRs merged; the performance slice closed unmerged | 61                  |
| M7  | Advanced coaching               | In progress: 67 slice PRs merged; the journey and real-device pass open | 67                  |
| M8  | Performance & design refinement | Planned                                                                 | none                |
| M9  | Final QA & production release   | Planned                                                                 | 19                  |

M4 has evidence recorded per criterion and waits only on the owner's screenshot review and the
real-device checklist's workout item. M5 has evidence recorded per criterion; its screenshot review
and first live-suite run are open. M6 has evidence recorded per criterion, with its numbers in
docs/performance.md; it is in progress because its performance slice was closed unmerged and one
page load misses its target. Its merged-slice count is its 61 merged PRs, which the branch names in
the history undercount. M7 has evidence recorded per criterion, with its numbers in
docs/performance.md: the PRD §5 examples are tested as domain rules, and one of them through the
coach's mock provider. It is in progress because the multi-discipline journey was never built and
the real-device checklist's M7 items have not been run. Its count is its 67 merged PRs, `m7/` and
`m7r/`. M9 has substantial merged work but no recorded verification against its acceptance
criteria. Treat it as built and unverified until someone runs the criteria and updates
milestones.md.

## Recently merged

- Running the schedule stage on its own plan changes nothing, for every scenario: a deload, taper or
  other week that keeps its own days is repaired against the week before it as planned, not against
  the week whose days the block shares. journeyHybrid is back in the run-twice check.
- `docs/programming-rules.md` lists every programming rule the registry holds, 401 of them, by the
  key decisions cite: what it does, why, its severity and source, and a constant's live values.
  `pnpm docs:rules` writes it, and a unit test fails when it is stale, when a module under
  `src/lib/domain/programming/rules/` exports a number no rule names, or when code cites a key no
  active rule has. 28 coaching numbers that no decision cited are registered with it (commitment
  efforts, the shortest run and the time-based week, strength's days and working RPE, the volume
  caps, added sessions), and so are the three keys the services cite (`program.confirmed`,
  `program.start_moved`, `review.weekly`).
- The owner can enter max, resting and threshold heart rate in Profile → Running & Muay Thai and in
  onboarding, and a run session shows each segment's zone in beats per minute ('Zone 2 · 134–148 bpm',
  or 'Zone 2' with none told). A plan built with a heart rate records the zones and the method
  (threshold, then heart-rate reserve, then max); a plan without one is unchanged.
- Muay Thai follows the fight camp: each camp week plans Muay Thai up to its sessions with the
  classes counted, hard sparring up to its target with each hard class counted and none in the
  last 7 days before the fight, conditioning in 3-minute rounds when the week asks for rounds, and a
  fight week of technique and light pads before the fight. When the week runs short, the camp takes
  strength sessions of goals held at maintenance down to their dose, and only while each major
  muscle group keeps its weekly sets, never a run. Sparring and
  conditioning share what is left by turns, and a session no day holds is left out with a decision
  that says so. A Muay Thai goal that does not lead keeps technique and pads, with no sparring.
- Marathon and half blocks are built to their race plan: the long run takes its planned length and
  grows at most 1.5 km a week, a cutback week holds at most 80 % of the biggest week, the race week
  has no long run, and each week's quality sessions are its phase's race work up to its hooks' count
  (marathon pace in the long run and a threshold run in a marathon build and peak, only the
  marathon-pace long run in its taper, a threshold run and 10K-pace intervals in a half's build and
  peak). A half reads its own hooks. A running goal that trains alongside the leader holds its dose in distance mode:
  65 % of recent volume, one quality run, the long run no longer than the recent longest.
- Runs are paced from current fitness: the best race of the last 26 weeks sets every pace by its
  VDOT (Daniels' formula); a race 26 to 52 weeks old, or an undated one when no race has a date, is
  a rough guide; else the told easy pace's VDOT. A run the coach adds is paced the same way. In a
  marathon build, peak or taper week of a next block, the long run closes at marathon pace.
- Progress and the reviews judge an M7 week by the targets its own plan set: a hypertrophy week by
  its own sets per muscle group, a maintenance or fight-camp week by its dose, a secondary strength
  goal by the lower half of its band, and the average RPE by the week's own cap. M3's programs read
  as before.
- Hypertrophy weeks are built to their own sets per muscle group, rising week on week until the
  deload, and each week keeps the exercises of the week before. A strength goal that trains
  alongside the leader gets the lower half of its band (8–11 hard sets a group), and one held at
  maintenance 4–10.
- Each week's main lifts follow its block's phase: sets of 6–8, then 3–5, 1–3 and 1–2 toward a
  meet. Peak and taper weeks keep half the accessories. A strength goal held at maintenance tops out
  at RPE 8.
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

- **Backup status (m9/51, m9/52).** Every backup run is logged in `backup_runs`: the daily cron and
  `pnpm backup:run --blob` open a row, expire runs abandoned for 15 minutes, and finish once as
  succeeded, failed or skipped (`src/lib/server/services/backups/run.ts`). Profile streams a Backups
  row from it (`src/lib/server/services/backups/status.ts`): how long ago and how big the last
  backup was, a calm warning when none has succeeded in 36 hours, the last run failed or none has
  run, and a neutral row when backups are not set up or the log cannot be read in 1.5 s. Neither
  `BACKUP_CLASSIFICATION` nor `e2e/text-columns.ts` exists yet:
  `BACKUP_CLASSIFICATION` is not on main, though m9/26's queue row says merged, and the
  `e2e/text-columns.ts` entry (m9/36) is not queued. Each must classify `backup_runs` as
  exclude/operational and not owner-writable when it lands.
- **Abuse limits (m9/35).** Every public POST has a rate-limit bucket (`PUBLIC_POST_BUCKETS`), every declared request body is capped in the hook (`src/lib/server/body-limit.ts`), and every cookie write goes through `src/lib/server/auth/http.ts` or `guard.ts`, each proven by a unit guard; no e2e leg was added.
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
  mentions Undo. The coach's Undo card (`src/lib/ui/coach/RecordedCard.svelte`) shows each weigh-in
  it logged, 'Logged 82.4 kg for today · Undo', after the run's answer and again on reload while
  the weigh-in still holds that run's write. Undo says 'Undone', or 'Nothing to undo' when the
  weigh-in is gone or changed, and a failed request can be tried again. The screens come after it.
- **M7, re-sliced.** On 2026-11-22 the parked M7 pull requests were re-sliced into 38 `m7r/`
  rows in `plan/m7-reslice.md`. By the end of that day every row that does not wait on m7r/03
  had merged, along with m7/47 to m7/51. That covers the generator's stages and season, Train's
  week findings and the season timeline, the coach's interference and trade-off reads, the whole
  re-plan path with its notice, proposal card and Propose again, the weekly review's deload, and
  the coach's block, deload and taper proposals with this week's block in every turn. m7r/03 is
  built: each block's day pattern is planned across week boundaries, and every clash a generated
  week keeps is recorded as explained (a priority trade-off or a schedule_kept decision). m7r/04 is
  built too: each week's main lifts follow its block's phase. m7r/05 too: hypertrophy weeks get
  their own sets per muscle group, and a secondary strength goal the lower half of its band. m7r/06
  too: Progress and the reviews judge M7 weeks by their own targets. m7r/07 too: runs are paced from
  the VDOT of the best recent race or the told easy pace, and a marathon block's long run closes at
  marathon pace. m7r/08 too: marathon and half blocks follow their race plan's long runs, cutbacks
  and race work, and a running goal that does not lead holds its dose. m7r/10 and m7r/09 too: heart
  rate on Profile and run sessions in bpm, and Muay Thai that follows the fight camp's sessions,
  sparring cap, conditioning rounds and fight week. m7r/03b too: the schedule stage is a fixed point,
  so a second run changes no session. m7/58 too: every programming rule, its values and its why, in
  `docs/programming-rules.md`, generated from the registry. m7/59 records where M7 stands
  (docs/milestones.md, M7) and accepts ADRs 0018 and 0019. Every re-slice row has merged; the 24 old
  M7 pull requests, PR 416 to PR 499, are still open.
- **Instrument v2 tokens (`v2/01a`).** The colours, surfaces, borders, spacing, radii and the theme
  colour follow Instrument v2 in `src/lib/ui/styles/tokens.css`, in dark and
  light; `docs/design-system.md` and `/design` show them. The 28 px gutter arrived with `v2/03a`;
  the workout keeps 20 px until `v2/10`, since at 28 px its logger grew over the exercise header
  (the effort chips now keep one line). The rest of the Instrument v2 rows are queued in
  `plan/queue.md` and wait on the tokens.
- **Instrument v2 type (`v2/01b`).** Mona Sans sets all text and every numeral, Hubot Sans the one
  display line on a screen, and the mono and uppercase labels are gone (`src/lib/ui/styles/tokens.css`,
  `base.css`, `fonts.css`). The fonts are self-hosted `@fontsource-variable/mona-sans` and
  `hubot-sans` (5.3.0), with only Mona Sans latin preloaded. `/design` shows the type scale and the
  `--type-*` roles. The 390 px layouts still need the CI e2e run and a look in a browser.
- **Instrument v2 buttons, links and icon buttons (`v2/02a`).** Button's `lg` is the 60 px amber
  primary with 16 px corners; `secondary` and `danger` are quiet surface-2 buttons, `ghost` a text
  button and the new `link` an underlined text action. IconButton is round, with `filled` on
  surface-3. `.text-link` (`src/lib/ui/styles/base.css`) styles links in running text. The workout
  logger and the set edit sheet keep their 56 px controls until `v2/10` (known-issues). The
  `/design` Buttons tab and `docs/design-system.md` show them; PR 586's ghost-hover specs are carried
  over. Phone layouts and the axe run are CI's to prove.
- **Instrument v2 fields, steppers and choice lists (`v2/02b`).** A field is 56 px on surface-2 with
  14 px corners and no border; an error is one red line under it. The stepper's ± are the round 60 px
  controls around a 64 px numeral. `ChoiceGroup`'s `card` is the v2 choice list (60 px hairline rows,
  the picked row in 600 with a check, `hintPlacement` for a short hint at the row's end), and its
  pills take the inverse fill. DayPicker and Toggle drop amber for the inverse fill. The `/design`
  Inputs tab and `docs/design-system.md` show them. The logger and the set edit sheet keep their
  pre-v2 stepper text and 56 px controls until `v2/10` (known-issues). Phone layouts and the axe run
  are CI's to prove.
- **Instrument v2 rows, sheets and toasts (`v2/02c`).** `ListRow` is the v2 list row: 60 px, a
  hairline under each row but a list's last, an optional trailing `value`, a `danger` title, and
  no icon tile (its `icon` and `tone` are accepted and not drawn). Sheets have a 36 × 4 handle, a
  Hubot 26/32 title, a bottom of the home indicator's inset plus 10 px (44 px on an iPhone with
  an inset), and a quiet ghost close.
  Toasts are a surface-2 line that stays at the top until `v2/03`. The `/design` Data and Feedback
  tabs and `docs/design-system.md` show them. Phone layouts and sheet heights are CI’s to prove.
- **Instrument v2 shell, phone (`v2/03a`).** Four tabs (Today, Train, Progress, Coach) on a canvas
  bar with a hairline, the current one in text colour and 600 with no pill. Profile is not a tab:
  Today's avatar opens it, and the rail's foot does from 1024 px. Detail pages share one back link
  (`.back-link`), and Profile has one to Today. The page gutter is 28 px everywhere but the
  workout, which keeps 20 px until `v2/10`. The resume line, the rail's look and the desktop column
  and sheets are `v2/03b` and `v2/03c`.
- **Instrument v2 resume line (`v2/03b`).** The floating resume bar is one plain 44 px line on the
  canvas, on the tab bar's hairline (at the foot of the column beside the rail from 1024 px), with
  a chevron: changes waiting to sync, Resume {title}, or a workout in progress on another device
  with Continue here on Today. `resume-state.svelte.ts` lets a screen claim the in-progress state;
  nothing claims it until Today's hero in `v2/06`. Phone layouts and the e2e run are CI's to prove.
- **Instrument v2 Profile list (`v2/21a`).** Profile is one list in groups (You, Training,
  Security), each row showing its answer, streamed from the Profile layout's load; the account
  card goes and the system card becomes status rows under About this app, Backups first. The
  titles say "and" ("Name and units"). Appearance and the desk layout are `v2/21b`, Goals
  `v2/21c`. Phone layouts and the e2e run are CI's to prove.
- **Instrument v2 at a desk (`v2/03c`), which completes the Instrument v2 shell (`v2/03`).** The
  rail is the canvas with a hairline, the four tabs 28 px apart and the avatar at its foot, with
  no brand mark. A readable screen is 616 px (560 of text) centred right of the rail but at most
  200 px from it to the text, so at 1440 px its text starts at 288 px; fixed chrome starts with
  it (`--column-start`). `BottomSheet` opens from 1024 px as a 480 px dialog, or with
  `desktop="panel"` as a full-height 496 px panel at the right (no caller yet; `/design` →
  Feedback shows one). The workout keeps its 640 px column until `v2/10`. The e2e run is CI's to
  prove.
- **Instrument v2 legacy components (`v2/02d`), which completes `v2/02`.** Cards, chips, badges,
  segmented controls, stat tiles, tabs and section headings lose their pills, fills, tint and amber
  and keep their padding and sizes, so no screen moves. A card keeps a hairline outline until its
  screen row. Each is marked legacy in its component comment; `/design`'s Data tab and its legacy
  card show them. Phone layouts and the e2e run are CI's to prove.
- **Adding a session to a program.** The builder, the storage
  (`src/lib/server/services/programs/add.ts`), Train's Add session sheet and the coach's proposal
  are built: `propose_program_adjustment` takes an `add_session` op, and accepting it is one new
  version.
- **Coach run trace and self-improving evals.** Planned, nothing built. The plan is eight PRs in
  `plan/trace-evals/plan.md`, written 738 commits ago, so its file pointers need re-checking
  against `main` before anyone builds from it. The owner must provide three secrets before the
  later PRs, listed in `plan/trace-evals/README.md`.

## Next

- Land or close the 32 open pull requests.
- Finish M4: the owner's screenshot review and the real-device workout check.
- Finish M5: the owner's screenshot review (#405), the first live-suite run, an inbox Lighthouse
  number, and the owner's run of the coach items on the real-device checklist (docs/testing.md,
  items 9 to 13).
- Verify M6 against its acceptance criteria and record the evidence in milestones.md.
- M8: the performance and design councils, which fill the skeletons in `docs/reports/`.
- M9: security review, the restore drill, and owner sign-off on the deployed app.
