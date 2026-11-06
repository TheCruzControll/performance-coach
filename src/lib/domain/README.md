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
