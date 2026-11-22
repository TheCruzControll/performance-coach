# Log a strength workout

The owner starts today's session, logs each set with weight, reps and RPE, rests, swaps an exercise
when a machine is taken, and finishes. The workout is then in History and Today reads Done.

## Sub-features

- `start` opens today's session from Today.
- `log-set` records weight, reps and RPE for the top set and the back-offs.
- `rest-timer` runs after a set and survives a refresh to within a second.
- `plates` opens the plate calculator from a set.
- `swap` replaces an exercise as "machine unavailable" without saving a preference or making a new
  program version.
- `restore` brings back the exercise, every set, the rest and the stopwatch after a refresh.
- `finish` ends the workout and shows it in History and in the exercise's own history.
- `this-hurts` offers Stop and gentler options, and never push-through wording.
- `dislike` removes an exercise from next week and lists it in Profile.

## How to get to it (user POV)

- Today, then Start workout.
- Train, open today's session, then Start.
- The resume bar, when a workout is already in progress.
- `/workout?start=<lineage>` for a session of a program week.

## Driving it with verify-coach

`verify run e2e/journey-strength.serial.e2e.ts`

The spec seeds the `workout-day` program for this week (`seedProgram` in
`e2e/program-support.ts`), then drives only the screens. It runs journeys 1 and 5 on the iPhone
viewport and again in a 1440 by 900 window. Proof is each set's row in Postgres with its final
values, the restored state after the refresh, the History entry, and the captured screens.

## Gotchas

- Serial: it resets and rewrites the one owner's training profile, so it cannot share a run with
  the functional specs.
- Every `/api/coach` request is aborted in this spec. Logging must never depend on the coach, and
  the spec asserts that no agent run was recorded.
- The service worker is blocked here because the coach requests are intercepted with `page.route`.
  Offline behaviour is proven in the offline journey instead.
