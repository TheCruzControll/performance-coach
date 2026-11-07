# Domain functions

The pure, isomorphic training maths that every later milestone (M4 logging, M5 the coach, M6
reviews, M7 running) reuses. Nothing here does I/O or imports a framework, so the same function
runs in the browser (offline logging), on the server (services, history queries) and in the
coach's tools. Each number has one definition: call these functions, never re-derive their
formulas. A slice that adds a reusable domain function adds it here.

## Where to import from

- `src/lib/domain/index.ts`: M1's maths and `dates.ts`, below. `calendar.ts` by path.
- `src/lib/domain/training/index.ts`: the training vocabulary, the program-plan contract's types
  and the metrics. It never loads a validator, so screens may import it.
- By path only: `validation.ts`, `training/schemas.ts` and `profile/schemas.ts` (zod), on servers
  always and in browsers on demand.
- `src/lib/domain/exercises/`: the catalogue (`CATALOGUE`, `catalogueByKey`,
  `SUBSTITUTION_GROUPS`) and `match.ts`'s `matchExercise(text, library)`, which links free text
  to one exercise key, or null rather than a guess. Server-only at runtime; `import type` is fine.
- `src/lib/domain/programming/index.ts`: the generator's public entry point, below. Server-only
  at runtime, like the catalogue.
- `src/lib/domain/analytics/*` (M6), by path: there is no index file. Server-only at runtime
  except `periods.ts` and `types.ts` (`scripts/analytics-client-imports.test.ts`).

## Conventions

- Loads are stored and compared in **kilograms**, distances in **metres**, durations in
  **seconds**, paces in **seconds per km**. Conversions use exact factors (`KG_PER_LB`,
  `METRES_PER_MILE`) at the edges.
- RPE is the 1–10 reps-in-reserve scale. Estimates are always labelled `kind: 'estimated'`; an
  estimate is never stored or shown as a measured max.
- A calendar day is an ISO `YYYY-MM-DD` string (`IsoDate`). Weeks run Monday to Sunday. An instant
  becomes the owner's day through `localDay` and the profile's IANA time zone, never through UTC.
- Bad input is either `null` (an answer that does not exist, such as an e1RM below RPE 6) or a
  `RangeError` (a caller bug, such as a negative duration). Where a function below gives null or
  throws, it says so.

## M1: strength estimates (`e1rm.ts`, `rpe.ts`)

- `estimateOneRepMax({ weight, reps, rpe? })` → `E1rmEstimate | null`, in the unit of `weight`:
  its `value`, `method` and `confidence`, with `kind: 'estimated'`.
  - With an RPE: the RTS chart for reps 1–12 at RPE 6–10 (`rpe-table`); more reps use
    reps + reps in reserve in the formula mean (`reps-to-failure`, always `low` confidence).
  - Without an RPE: the mean of Epley and Brzycki, assuming the set went to failure, so it is a
    floor; confidence is capped at `medium`. A single is its own load (`single`).
  - Null for no weight, reps that are not a whole number of at least 1, an RPE below 6, above 10
    or off a half step, or more than `MAX_REPS_TO_FAILURE` (20) reps to failure.
- `loadForTarget(oneRepMax, reps, rpe)` → the load for a set (5 @ RPE 8 from a 180 kg 1RM), or
  null outside the chart. Unrounded: round it with `roundToIncrement`.
- `percentOfOneRepMax(reps, rpe)` → the chart's fraction of 1RM, or null outside reps 1–12 ×
  RPE 6–10 in half steps. It never extrapolates.
- `repsInReserve(rpe)` → `10 − rpe`; throws `RangeError` outside 1–10. `isValidRpe(rpe)` is true
  for 6–10 in half steps (`RPE_MIN`, `RPE_MAX`).
- `epley` and `brzycki` are exported for tests and explanations; prefer `estimateOneRepMax`.

## M1: load (`load.ts`)

- `sessionLoad(durationMinutes, sessionRpe)` → Foster's session load in AU (minutes × RPE),
  comparable across disciplines. Throws `RangeError` for negative minutes or an RPE outside 0–10.
- `volumeLoad(sets)` → Σ weight × reps (tonnage), negatives counted as 0. The sets must share one
  unit: convert first.
- `acuteChronicRatio(dailyLoads, acuteDays = 7, chronicDays = 28)` → `{ acute, chronic, ratio }`
  from exponentially weighted averages. `dailyLoads` is oldest first, one entry per day, 0 on rest
  days. Null until there are `chronicDays` days; `ratio` is null while the chronic load is 0.

## M1: units (`units.ts`)

- `convertWeight(value, from, to)`, `lbToKg`, `kgToLb`; `toMetres(value, unit)`,
  `fromMetres(metres, unit)`, `convertDistance(value, from, to)` for `km`, `mi` and `m`. Exact.
- `roundToIncrement(value, increment, mode = 'nearest' | 'down' | 'up')` → a loadable weight,
  free of floating-point noise. Throws `RangeError` when the increment is not positive.
- `DEFAULT_LOAD_INCREMENT` → `{ kg: 2.5, lb: 5 }`, the smallest jump typical gym plates allow.
- `cleanFloat(value, decimals = 6)` strips noise such as `102.49999999999999`.
- `paceSecondsPer(durationSeconds, distanceMetres, 'km' | 'mi')` → seconds per unit, or null when
  the distance is not positive. `convertPace(secondsPerUnit, from, to)` between per-km and per-mile.
- `formatDuration(seconds)` → `m:ss` or `h:mm:ss`, rounded, a leading minus when negative;
  `parseDuration(text)` is its inverse, null when malformed.
- `formatWeight(value, unit, decimals = 2)` → `102.5 kg`, `1,100 lb`: trailing zeros trimmed.

## M1: plates (`plates.ts`)

- `calculatePlates(target, bar, stock)` → `{ perSide, achieved, remainder, exact }`: the plates
  for one side, heaviest first, solved exactly for a limited stock. A target it cannot load
  exactly gives the heaviest load under it; one lighter than the bar gives the bar alone with a
  negative `remainder`. `STANDARD_PLATES` and `STANDARD_BARS` per unit.

## M2 and M3: days (`dates.ts`, `calendar.ts`)

- `localDay(instant, timeZone)` → the owner's `IsoDate` for an instant, daylight saving included.
  `canonicalTimeZone(value)` → the zone as `Intl` spells it, or null (fixed offsets are refused).
- `parseIsoDate(text)` → UTC midnight, or null for a date that never existed (`2027-02-29`).
- `addDays(date, days)`, `daysBetween(from, to)`, `weekdayOf(date)` (M2's `Weekday`),
  `mondayOf(date)` and `isoWeekKey(date)` (`2026-W53`, sortable). UTC arithmetic on calendar days,
  so no time zone or clock change can move a day. They throw `RangeError` for a malformed date.

## M3: training metrics (`training/metrics.ts`)

Built on the functions above. Logged sets arrive as `LoggedSet` (an M4 set record with the weight
in the unit entered); planned ones as the program-plan contract's `WeekPlan`.

- `setE1rm(set)` → `E1rmEstimate | null` in kg: `estimateOneRepMax` after `convertWeight` to kg.
  Null for a warm-up, a skipped set, a set without load or reps, and an RPE under 6. The training
  log stores its value as a set's `e1rm_kg`.
- `bestE1rm(sets)` → the highest `setE1rm` among **one exercise's** sets, with the set it came
  from; null when none gives one. Always `kind: 'estimated'`, even for a single at RPE 10. Ties go
  to the most recent set, so a database query must order by `e1rm_kg desc, performed_at desc`
  to agree. The highest value wins whatever its `confidence`; show the confidence with it.
- `personalRecords(sets)` → for **one exercise**, the heaviest load in kg for each rep count from
  1 to `PR_MAX_REPS` (10), working sets only, lightest rep count first; ties go to the most recent
  set. A rep count never lifted with a load is left out.
- `isHardSet(working, rpe)`: **the** hard-set definition. A working set (not a warm-up, not
  skipped) counts when its RPE is at least `HARD_SET_MIN_RPE` (7), or when it has no RPE.
  `HARD_SET_CREDIT` gives 1 to each primary muscle and 0.5 to each secondary one. These constants
  are a coaching judgement the owner can change in one place.
- `hardSets(sets, exercises, timeZone)` → `WeekHardSets[]`, oldest week first, weeks with no hard
  set left out: `{ weekStart, muscles, groups }` per Monday-to-Sunday week on the owner's
  calendar. A set credits each muscle group once, at its best credit: a row working the lats and
  upper back is one hard set for the back. `exercises` maps each set's `exercise` to its muscles
  (catalogue entries fit as they are); an exercise missing from it throws `RangeError`, even for
  a warm-up.
- `plannedHardSets(week, exercises)` → the same `WeekHardSets` for a planned week, so the
  generator's volume targets and the log are counted alike. Warm-up and ramp (work up) lines are
  not working sets (`NON_WORKING_ROLES`), so M4 must log a ramp's sets as warm-ups for the two to
  agree; a line with no target RPE counts. Only strength sessions credit sets: a run, a Muay Thai
  session or a strength class credits none. Plan exercises are looked up by
  `exerciseRefKey(ref)`: the catalogue key, or `custom:<uuid>`.
- `sessionLoadOf(session)` → `sessionLoad` for any discipline. A planned session uses its
  `estMinutes` and `targetRpe` and always has a load; a logged workout uses `durationSeconds` and
  `sessionRpe` and is null until both are recorded.
- `weeklyDistance(runs, unit, timeZone)` → `{ weekStart, metres, distance }` per week, oldest
  first, weeks with no run left out (fill gaps for a chart). Each run's distance, in the unit
  entered, goes through `toMetres`; the total is exact metres and `distance` is that total in
  `km` or `mi` through `fromMetres`, both free of floating-point noise (`cleanFloat`).
- `weekStartOf(instant, timeZone)` → the Monday of the owner's week: the bucket every weekly
  metric uses. Use it to line other weekly figures up with these.

Caveat for M4: `setE1rm`, `bestE1rm` and `personalRecords` read `weight` as external load. An
assisted exercise logs its assistance, where less is harder, so pass `weight: null` for it. A
bodyweight exercise's added load gives records of that added load and an e1RM without body weight.

## M3: concurrent-training interference (`programming/interference.ts`)

PRD §5's concurrent-training rules as pure checks over sessions: placement builds each week with
them and the move edit warns with them. Server-only at runtime, like all of `programming/` (it
reads the catalogue); import it by path. It reads only the sessions given: no clock, profile or
goal priority.

- `demandOf(session, traitsOf = catalogueTraits)` → `SessionDemand`: `heavyLower`, `heavyUpper`,
  `hardCombat`, `longRun`, `intervals`, `veryDemanding`, `hard` and `easy`. A region is worked
  heavily by a compound lift in a hard session or at a heavy set (RPE 8, or 80 % of a 1RM), or by
  `highVolumeHardSets` (10) of `isHardSet`'s hard sets at any load. Sparring is hard combat at any
  intensity. A hard commitment is also read by its discipline (`INTERFERENCE.hardCommitment`): a
  hard strength, athletic or custom class is very demanding, a hard running club is intervals.
  `traitsOf` gives an exercise's pattern, primary muscles and tags: the catalogue's by key, none
  for the owner's own unless the caller's lookup has them (they then count as neither region).
- `checkWeek(sessions, { traitsOf?, openDates? })` → `Violation[]`: `rule`, `severity` ('avoid'
  is a rule to keep, 'prefer' advice), `days`, the caller's own `sessions` and a `message` naming
  the days and sessions. By first day, then in `INTERFERENCE_RULES` order, and the same for any
  input order. Pass the sessions that will happen, a week or more. `openDates` (by default every
  date of the sessions' weeks) are where generated sessions could still move, for
  `hard_days_apart`; commitments never move.
- `INTERFERENCE` holds every threshold and `INTERFERENCE_RULES` every rule with its reason, so
  tuning one is an edit there. `BLOCKS_EDIT` says which severities block an owner's edit rather
  than warn: none by default.

## M3: the generator (`programming/index.ts`)

PRD §5's week-1 program generation: pure, deterministic rules with no clock, randomness or I/O,
so services and the M5 coach's tools call the same functions and get the same plan.

- `buildProgrammingInput(profile, { catalogue, customExercises?, preferences? })` →
  `ProgrammingInput`: the M2 profile normalised, every 'not told yet' default listed in
  `assumptions`.
- `generateProgram(input, { startsOn, firstPlannedDay })` → `ProgramPlan`: the first block and
  its outline, every decision with its 'why' (`program_purpose` first), checked against
  `programPlanSchema`. A plan the contract refuses throws `GeneratedPlanError` with its dotted
  paths. `startsOn` is a Monday; a 'This week' start plans only from `firstPlannedDay`.
- `catalogueDigest(catalogue, customExercises)`, `fingerprint(input, digest)` and
  `GENERATOR_ID`: the same profile, library and generator give the same fingerprint, so a build
  can tell a changed profile or library from a retry.
- `checkWeek` (above) and `alternativesFor(exerciseKey, input)`: the swaps that keep an
  exercise's intent, best first, with the blocked ones and why.

## M6: analytics (`analytics/`)

Every number on Progress, in the reviews and in the coach's analytics tools comes from these
modules: pure, with today always an argument, imported by path (no index file), no zod and no
runtime import of `programming/` or `exercises/`. Only `periods.ts` and `types.ts` may reach the
browser (`CLIENT_SAFE` in `scripts/analytics-client-imports.test.ts`); screens receive the rest's
results. Any change to a definition bumps `ANALYTICS_VERSION` (`version.ts`), which stored reviews
keep.

### Periods (`analytics/periods.ts`, client-safe)

A period is whole Monday-to-Sunday weeks that have ended, with today's week kept apart, so
totals, averages, trends and comparisons never set part of a week against whole ones.

- `PERIODS` (`4w`, `12w`, `26w`, `52w`, `all`), `PERIOD_LABEL` and `DEFAULT_PERIOD` (`12w`).
  `parsePeriod(value)` gives the default for anything unknown.
- `periodWindow(today, period, firstActivityOn)` → the period, its `weeks`, the week
  `inProgress`, the `previous` window and the `bucket`:
  - `weeks`: `{ from, to, count }`, the complete weeks ending the Sunday before today's week.
    For `all` they start on the Monday of the first activity's week, and are null before a first
    full week (a new owner sees only the week in progress).
  - `inProgress`: `{ weekStart, through: today, days }`, 1 on a Monday to 7 on a Sunday; never
    part of `weeks`.
  - `previous`: as many complete weeks, ending the day before `weeks`; null for `all`.
  - `bucket`: `week`, or `month` once `all` holds more than `MONTHLY_AFTER_WEEKS` (104) weeks.
- `weekStarts(range)` → each Monday of a range, oldest first.
- `trendWindow(window)` → the weeks a trend verdict reads: the period's own when it is at least
  `TREND_MIN_WEEKS` (12) weeks or `all`, otherwise the last 12 complete weeks, with
  `sameAsPeriod: false` and the label 'Trend over the last 12 weeks' for the tile to show.
- `sameDaysLastWeek(inProgress)` → last week's Monday to the same weekday, for 'This week so
  far: 6,200 kg · 5,900 kg by Wednesday last week'.

`types.ts` holds the shared shapes: `MetricKind` (measured, estimated, calculated, reported),
`Availability` (`{ ready: true }` or what it has and needs), `Bucket`, `SeriesPoint`
`{ at, value, inProgress }`, `MetricValue`, `Direction`, `Change` and `Comparison`.

### Series and statistics (`analytics/series.ts`)

- `byDay`, `byWeek` (through M3's `weekStartOf`) and `byMonth`. The first two group `Timed`
  values `{ at, value }` on the owner's calendar, summed unless given another `Reduce` (`mean`,
  `median`, a best). `byMonth` regroups weekly points by the month of each week's Thursday, so a
  month holds 4 or 5 whole weeks; its value is their mean (the axis keeps weekly units) unless
  told to sum.
- `fillWeeks(buckets, weeks, 'zero' | 'gap', inProgress?)` → one `SeriesPoint` per complete
  week, then the week in progress marked `inProgress`. A gap (null) is no data, not zero: fill
  `zero` only for counts of nothing.
- `totalOf`, `averageOf` and `rollingMedian(points, window)` leave out the point in progress and
  gaps; a rolling median is null until its window is full.
- `mean`, `median`, `mad` (unscaled; × 1.4826 estimates an SD), `sd` (sample, n − 1) and `total`:
  null without enough values, exactly 0 spread for a constant series, `RangeError` for NaN or an
  infinity.
- `compare(current, previous, direction)` → `{ delta, pct, change }`. All null, never NaN or
  Infinity, when the previous value is missing or 0: a period with nothing in it is not
  something to compare with. `change` is better or worse by the metric's direction, up or down
  when neither is better, or same.
- `soFar(values, inProgress, { timeZone, direction, reduce? })` → this week so far against the
  same days of last week, values on other days ignored, with the comparison and last week's days.

### Trends (`analytics/trend.ts`)

Whether a series is really moving or only varying, decided once for every screen, review and
coach answer (the trend classification ADR). Every series varies from week to week: sleep, food
and a busy day move an e1RM or a pace a little either way. **Normal variation** means the ups and
downs are no bigger, and no more one-sided, than that everyday scatter. A **real trend** is a
change that is consistent in direction, unlikely to be chance, and big enough to matter.

- `classifyTrend(points, { direction, mpc?, minPoints?, minSpanDays?, alpha? })` → `real_trend`
  (with `direction` up or down and `good`, null when the metric has no better way),
  `normal_variation`, or `insufficient_data` (with `needs: { points, days }` still to come).
  Every result carries `n`, `spanDays`, `slopePerWeek`, `change`, `changePct`, `noise`,
  `minChange`, `p`, `outliers` and `method` (`TREND_METHOD`, `theil-sen+mann-kendall/1`).
- Points in progress and gaps are dropped first; pass the weeks of `trendWindow(period)`.
- A verdict needs 6 points over 21 days (`TREND_MIN_POINTS`, `TREND_MIN_SPAN_DAYS`). It is real
  when the Mann–Kendall p is under 0.05 (`TREND_ALPHA`) and the Theil–Sen change over the window
  is at least the larger of the metric's minimal practical change (`mpc`: `abs` in its units,
  `rel` a share of the line's starting level) and twice the noise (`TREND_NOISE_MULTIPLE`).
- Points more than 3 robust SDs off the line (`TREND_OUTLIER_SDS`) are listed in `outliers` and
  kept in every figure; a real trend must also be real with any one of them left out.
- Deterministic and independent of the order of the points; `RangeError` for a value that is not
  finite or an option out of range.

### Strength (`analytics/strength.ts`)

Every strength figure, defined once on M4's logging rules and M3's metrics, with no formula of
its own. Inputs are `StrengthFact`s: M3's `LoggedSet` (the weight in the unit entered) with the
fields M4's rules read (`seconds`, `metres`, `assistance`, `missedReps`, `isExtra`), the set and
workout ids, the planned lineage, the set index and `deletedAt` (a set still carrying a deletion
is dropped). Exercises are `StrengthExercise`s: measure, load type, muscles and the profile lift
they stand for (a catalogue entry fits). Loads are kg through M1's exact factor; a session is one
workout's sets of an exercise, on the owner's day it started.

- `e1rmSeries(facts, exercise, timeZone)` → one point per session: M3's `bestE1rm` of the sets
  M4's `e1rmApplies` allows, always `kind: 'estimated'` with M1's method and confidence, and the
  set it came from. A bodyweight or timed exercise has none.
- `measuredMaxes(baselines)` → the profile's 1RMs (M2's baselines) in kg, labelled by the kind M2
  derived (`BASELINE_LABEL`): 'Measured' for a tested or competition max, 'Estimated · from your
  profile' otherwise. Never merged into a series.
- `topSets(facts, exercise, timeZone)` → each session's top set by M4's `topSetOf` (the most load,
  then reps) and its `workingLoad`: the load used for the most working sets (ties to the heavier)
  with the most reps done at it.
- `prTimeline(facts, exercise, timeZone)` → every record broken, oldest first, with the record it
  beat (`previous`: value, day, workout): the e1RM, rep maxes at 1–10 reps and most reps as M4's
  `prKinds` and `prCandidates` allow, and the session's volume load (`volumeOf`, above 0). A PR is
  strictly above the record beyond floating-point noise, so a tie, or the same load in lb, is no
  PR; a record's first value (the first session, a rep count first lifted) is its baseline. The
  e1RM, rep-max and most-reps PRs are exactly M4's `summarizeWorkout` PRs given the bests before
  each workout. So 5 × 100, 5 × 100, 5 × 102.5, 6 × 100 gives no PR, no PR, then the e1RM, the
  5-rep max and the volume, then the e1RM (118.06 kg over 117.45) and the volume, the 6-rep max
  starting there.
- `weeklyTonnage(facts, exercises, timeZone, window)` → kg per M3 week through M4's `volumeOf`
  (M1's `volumeLoad`): each complete week of the window, 0 with nothing lifted, then the week in
  progress flagged `inProgress`, which `totalOf` leaves out.
- `weeklyHardSets(facts, exercises, timeZone, window)` → per week the count of M3 hard sets
  (`isHardSet`) and M3's `hardSets` credit per muscle and group, the week in progress last.
- `muscleGroupWeeks(weeks, targets)` → each week's groups, in M3's order, with hard sets or a
  target: `below`, `within` (both ends included), `above` or `no_target`, against the week's
  `[lo, hi]` range (targets come from `services/analytics/targets.ts`).
- `rpeSummary(facts)` → the mean RPE of working sets that have one, how many sets and how many
  rated, and the share; `weeklyRpe(facts, timeZone, window)` → that mean per week, a gap (null)
  for a week with no rated set.
- `keyLifts(facts, exercises)` → at most `KEY_LIFTS_MAX` (6) exercises with an e1RM: those that
  stand for a profile lift first, then by sessions trained, the most recent, then id.

Hard sets per muscle group are weighted 1.0 for each primary muscle and 0.5 for each secondary
one (M3's `HARD_SET_CREDIT`), and each group is credited once per set, at its best credit. Worked
example: three hard barbell rows (primary upper back and lats; secondary rear delts, biceps,
lower back and forearms) and one hard back squat (primary quads and glutes; secondary adductors
and lower back) in a week give upper back 3, lats 3, rear delts 1.5, biceps 1.5, forearms 1.5,
lower back 2 (1.5 + 0.5), quads 1, glutes 1 and adductors 0.5; by group, back 3.5 (3 from the
rows, once each though two back muscles are primary and one secondary, and 0.5 from the squat),
shoulders 1.5, biceps 1.5, forearms 1.5, quads 1 and hips 1. Against a back range of 3.5–10 that
week is `within`, at the low edge.

### Prescribed against actual (`analytics/prescribed.ts`)

Every logged set is paired with the prescription line it was logged against, so actual against
target RPE, missed reps, completion and 'consistently below target' have one definition for the
dashboards, the reviews and the progression rules.

- `matchPrescription({ lineage, exerciseId, lines }, sets, { unit, e1rmKg? })` → each set by
  index: `done`, `skipped`, `missing` or `extra`, with its `target` and `actual`. Sets pair with
  lines by M4's slot numbering (`pairBySetIndex` in `workout/selectors.ts`, which
  `plannedVsLogged` uses too): the lines give the planned sets in order, and the first set
  logged at index i, of the planned exercise's lineage, takes the i-th.
  - Warm-up and ramp lines (`NON_WORKING_ROLES`) take warm-up sets; every other line, an unknown
    role included, takes working sets. A set of the other kind leaves its line missing and is
    extra, as is a set the device marked extra, a set beyond the lines and a second set at one
    index. A skip has no kind (`set.skip` carries none), so it takes the line at its index.
  - A target's `kg` is M3's `prescribedLoad` in the owner's unit, in kg: absolute, percent_1rm
    from its reference, from_e1rm only through the `e1rmKg` resolver; null for RPE-picked loads.
  - `rpeDeviation` is actual minus target RPE (positive: harder than prescribed), null when either
    is missing, never 0. `repsShort` is the reps under the line's lower bound; `hit` whether its
    reps, seconds or metres were reached.
  - A substitute's sets (another exercise at the planned lineage) fill their slots but compare
    against nothing.
- `exposure(match, day)` → one planned exercise in one workout: working sets prescribed,
  completed and extra, missed reps (per set, the larger of those logged and the reps short), the
  deviations and their mean, the top set (the first top-set line's, else the heaviest working set
  by M4's `topSetOf`) with its load in kg, and whether every target was hit. `substituted` when
  only a substitute's sets were done.
- `consistency(exposures, window = 3)` → `below`, `above`, `within` or `too_few`, from the lift's
  own last `window` exposures by day, with the ones that missed reps. Below or above is a mean
  deviation of at least 1.0 either way in 2 of them (`CONSISTENCY`); too few until 2 have an RPE.
- `rpeDeviationSummary(exposures)` → the mean, the mean absolute deviation, and the count and
  share within ±0.5 (`RPE_WITHIN`), overall, by exercise and by week (Monday).
- `sessionCompletion(session, matches | null, today)` → `completed`, `partial`, `skipped`,
  `missed` or `pending`. A completed workout is completed when it did `COMPLETED_SHARE` (80 %) of
  its prescribed working sets, else partial, and wins over a stored skip; without one, a session
  is skipped by choice, missed once its day has passed, and pending until then.

`CONSISTENCY`, `RPE_WITHIN` and `COMPLETED_SHARE` are coaching judgements the owner can change in
one place.

### Running (`analytics/running.ts`)

Weekly mileage, pace by run type, long-run progression, best efforts and reported races,
frequency and optional heart rate. Input: `RunFact` `{ workout, startedAt, sessionType, metres,
seconds, avgHr, rpe, segments }`, one completed, undeleted run with its record's totals (exact
metres: 5 mi is 8046.72 m) and its segments as run. `wholeRun(run)` gives its totals, each one
the record lacks taken from M4's `runTotals` of its segments. Every pace is M4's `segmentPace`
in s/km (lower is better) of amounts `runTotals` adds up; nothing here does pace arithmetic.
Weeks are M3's (`weekStartOf`), so a Sunday-evening run stays in its week, and the week in
progress is kept apart and flagged.

- `weeklyRunning(runs, window, unit, timeZone)` → each complete week, zero-filled, and the week
  in progress: `metres` (through M3's `weeklyDistance`), `distance` in km or mi, `runs`,
  `seconds` recorded and `longestMetres`, with `points` (metres per week) for a mileage trend.
- `runFrequency(runs, window, timeZone)` → runs over the complete weeks, the average week, runs
  by session type, and the week in progress's runs apart.
- `runPace(run)` → one run's pace input `{ basis, distanceMetres, durationSeconds,
paceSecondsPerKm }`, by the part of the run that shows its type (`PACE_PART`): a tempo run's
  tempo segments, else the whole run; intervals' interval segments only, pooled so longer reps
  weigh more, and no input without one; every other type, an unknown one included, the whole
  run. A segment counts only with a distance and a time; a run without a pace is left out.
  `paceByType(runs, window, timeZone)` → per session type its inputs, a weekly pace (a gap for a
  week without one) and the period's pace over the complete weeks.
- `longRuns(runs, window, timeZone)` → each week's long run: its longest `long_run` session,
  otherwise its longest run when at least `LONG_RUN_OF_MEAN` (1.5) × the week's mean run, with
  `changePct` from the latest earlier long run and `jump` when more than `LONG_RUN_JUMP_PCT`
  (10 %) longer.
- `bestEfforts(runs, races)` → for 5K, 10K, half and marathon (`EFFORT_DISTANCES`): logged runs
  within `EFFORT_TOLERANCE` (±2 %, edges included), the fastest by pace labelled `best_effort`
  (measured), the rest `effort`; and M2's race results at the distance labelled `reported`. An
  `other` race has no standard distance and is left out.
- `heartRateByType(runs, window, timeZone)` → per session type with a tracked run in the
  complete weeks: how many carry a heart rate and a time, and their time-weighted mean through
  `runTotals` once `HR_MIN_RUNS` (4) do; until then `availability` says how many it has.

`PACE_PART`, `LONG_RUN_OF_MEAN`, `LONG_RUN_JUMP_PCT`, `EFFORT_TOLERANCE` and `HR_MIN_RUNS` are
coaching judgements the owner can change in one place. There is no `race` session type: races
are best efforts and reported results (an open question for the owner).

### Adherence (`analytics/adherence.ts`)

Planned against completed, skipped and missed, with the weekly sessions and training time beside
it. Inputs: the planned sessions (M3's `SessionView` fits), the lineages with a completed,
undeleted workout (M3's `completedLineages`), and the completed workouts with their day (M4's
`CanonicalWorkoutRow` fits).

- `outcomeOf(session, completed, today)` → `completed` by lineage, in any version, as M3's program
  reads derive it (over a stored skip too); else `skipped` (the owner's choice, ahead of its day
  too), `missed` once its day has passed, or `pending` today and after.
- `weekAdherence(monday, facts, today)` → `planned` (= completed + skipped + missed + pending),
  each outcome, `moved` (those moved here), `extra` (off-plan workouts, outside the rate) and
  `pct`: completed ÷ (completed + skipped + missed) × 100. `pct` is null with `noRate`:
  `no_plan` ('No plan for this period') or `nothing_due` (`NO_RATE`). The week in progress is
  flagged `inProgress`, counted `through` today. Throws `RangeError` for a day not a Monday.
  - A session counts on the day it is planned now: a moved one on its new day, in its new week.
  - A lineage is one session: given in two versions' rows, the later row counts (pass versions
    oldest first), and a session logged late, in a later week, completes it and is never extra.
- `periodAdherence(facts, window)` → each complete week of a `periodWindow`, the week in progress
  apart, and `total`: the complete weeks' counts added, never their rates averaged.
- `adherenceByDiscipline(facts, weeks, today)`, in the catalogue's order, and
  `adherenceByWeekday(facts, weeks, today)`, Monday first, `oftenMissed` once a weekday is missed
  `OFTEN_MISSED` (3) times or more. A skip never counts toward it.
- `weeklySessions(workouts, window)` → completed workouts, planned and off plan, per week and
  discipline; `trainingTime(workouts, window)` → recorded seconds per week and discipline, with
  each session that has no duration named in `untimed`: never taken as 0, so a week of only such
  sessions has `seconds: null`, and a week with none has 0. Both give `{ weeks, inProgress, total }`,
  the total over the complete weeks only.

### Workload (`analytics/workload.ts`)

Session-RPE load across disciplines, the acute:chronic ratio, monotony and strain, Muay Thai load
and recovery. Inputs: completed, undeleted workouts with their run or other-session record
(`LoggedSession`) and M3's recovery notes (`RecoveryEntry`).

- `sessionLoads(sessions, timeZone)` → each session's load through M3's `sessionLoadOf` (minutes ×
  RPE, AU), on the owner's calendar day (`localDay`, so a clock change never moves it), in its
  chart group (`sessionTone`). The RPE is the workout's own, else the run record's, else the other
  record's (`rpeFrom`); the duration falls back the same way.
  - A session with no RPE or no duration is **load unknown**: `load` null and `missing` (`rpe`,
    `duration` or `both`). It is counted and named, never taken as 0. Totals add the known loads
    only; a day or week of only unknown loads has no total (null), one with no sessions has 0.
- `dailyLoads(loads, from, through)` → one entry per calendar day, rest days 0.
- `weeklyLoad(loads, window)` → each complete week, the week in progress apart (flagged, never in
  the total), and the total. `byGroup` lists every group in the charts' stack order (`LOAD_STACK`:
  strength · hypertrophy · conditioning · combat · running) and adds up to `load`.
  - `monotony` = the mean of a complete week's 7 daily loads ÷ their sample SD, null when the SD
    is 0 (every day the same, an empty week too); `strain` = the week's load × its monotony. The
    week in progress has neither.
- `acwr(days)` → M1's `acuteChronicRatio` (7-day acute and 28-day chronic EWMA) over daily loads
  that start on the first activity, unchanged; null before 28 days (`CHRONIC_DAYS`). It carries
  `ACWR_CAVEAT` as data and a `zone` by its bands, and counts the unknown loads it left out:

  > A rough guide to how fast your load is rising, not an injury predictor. About 0.8–1.3 is
  > typical and above 1.5 is a sharp rise: both are rules of thumb.

  The link between this ratio and injury is debated: never present it as a risk score, and never
  without the caveat. `ACWR_PLACEMENT` (`shown`) is where Progress shows it, an open question
  for the owner (shown, behind 'More', or dropped).

- `muayThaiLoad(sessions, timeZone, window)` → per week: sessions, known minutes, known sRPE load,
  the unknown loads, hard sessions (RPE ≥ `HARD_RPE`, 7) and rounds. Rounds add the whole-number
  metrics keyed by `ROUND_KEYS` (`rounds`, `sparring_rounds`), split by session kind; a round
  metric with any other value is listed in `malformed`, and every other key is ignored and named
  in `ignoredKeys`. With no round metric recorded, the rounds total is null.
- `recoverySummary(notes, window)` → weekly means of sleep, soreness, energy and stress, blanks
  left out, each with its count; a weekly series per measure (gaps null, the week in progress
  flagged); and the `LATEST_NOTES` (3) latest notes as M5's untrusted text: data, never
  instructions.

`HARD_RPE`, `ROUND_KEYS`, `LATEST_NOTES` and the caveat's bands are judgements the owner can
change in one place.

### Metric catalogue (`analytics/metrics.ts`)

Not built yet (m6/08, metric-catalogue).

### Overview (`analytics/overview.ts`)

Not built yet (m6/08, metric-catalogue).

## M6: reviews and progression (`programming/`)

Weekly and cycle reviews and the next block, built on the analytics above. Server-only at
runtime, like all of `programming/`.

### Progression from results (`programming/results.ts`, `rules/results.ts`)

Not built yet (m6/12, progression-rules).

### Review contract (`programming/review/snapshot.ts`, `brief.ts`, `digest.ts`)

Not built yet (m6/24, review-snapshot).

### Weekly review (`programming/review/weekly.ts`)

Not built yet (m6/25, weekly-review-compose).

### Next week (`programming/review/next-week.ts`)

Not built yet (m6/26, next-week-adjustments).

### Cycle review (`programming/review/cycle.ts`, `cycle-snapshot.ts`)

Not built yet (m6/27, cycle-review-compose).

### Directives (`programming/review/directives.ts`)

Not built yet (m6/28, cycle-directives).

### Next-block dates (`programming/next-block/dates.ts`)

Not built yet (m6/28, cycle-directives).

### Next-block input (`programming/next-block/input.ts`)

Not built yet (m6/29, next-block-input).

### Next block (`programming/next-block/generate.ts`)

Not built yet (m6/30, next-block-generator).

## M9: backups (`backup/`)

What a backup is, before anything writes one (the app-level encrypted backups ADR). Pure,
imported by path (no index file), with relative `.ts` specifiers so `scripts/backup/` runs it
under plain Node. Server-only by use: nothing in a page needs it.

- `format.ts`: `FORMAT_VERSION`, `SESSION_SETTINGS` and the zod/mini schemas of the archive's
  control lines (header, section, sequences, trailer). Row lines are Postgres's own
  `row_to_json` text and never parsed here. `parseControlLine`, `formatControlLine`,
  `isRowLine` and `schemaTag(header)` (`'<count>-<hash8>'`).
- `pathnames.ts`: `backupPathname(date)` gives `backups/YYYY/MM/DD/coach-YYYYMMDDTHHMMSSZ.pcbk`
  in UTC; `parseBackupPathname(name)` is strict and answers null for anything else.
- `retention.ts`: `selectForDeletion(names, now, RETENTION, mustKeep)` splits a listing into
  `keep`, `delete` and `unparseable`: the newest of each of the last 30 UTC days and the earliest
  of each of the last 12 UTC months (`RETENTION.monthlyKeeps`), never a future-dated, must-keep
  or unparseable name, the same answer for any input order.
