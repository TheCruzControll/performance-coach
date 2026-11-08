# Workouts (M4)

The pure, isomorphic rules of a logged workout. The same code runs in the browser (offline
logging, the optimistic UI) and on the server (the sync endpoint), so the screens and Postgres
never disagree. The contract is wire format v1, decided in the offline workout sync ADR
(`docs/adr/`).

This list is written once, for every M4 domain module. Later slices do not edit it; docs-m4
checks it against the merged code.

## Where to import from

- `index.ts`: the contract (`types.ts`, `mutations.ts`, `protocol.ts`). It never loads a
  validator, so the workout pages may import it. Not re-exported from `src/lib/domain/index.ts`.
- By path: every other module below; `schemas.ts` (zod) on servers always and in browsers only
  on demand (the Fix flow).
- Test-only: `tests/fixtures/workout-day.ts`, the start kits of M3's 'workout-day' program.

## Modules

| Module                       | What it holds                                                                                                                                                       | Slice                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `types.ts`                   | `StartKit` (strength, run, other), `KitExercise`, `KitSet`, `LoggedSet`, `DeviceState` with its rest and stopwatch, `WorkoutView`                                   | workout-contract                                        |
| `mutations.ts`               | The 16 `MUTATION_TYPES` and their `MUTATION_RULES` (kinds, identity, entity), `Envelope`, `createMutation`, `entityKey`, `dependsOn`, `LocalAction`, `PAIN_ACTIONS` | workout-contract                                        |
| `protocol.ts`                | `SyncRequest`, `SyncResult` with `SYNC_STATUSES` and `SYNC_CODE_LABEL`, `SYNC_LIMITS`, `CanonicalWorkout` keyed by client ids                                       | workout-contract                                        |
| `timers.ts`                  | The rest timer and the stopwatch on absolute timestamps; `restFor(set, exercise, defaults)`, `restClassOf(exercise, set)`                                           | workout-timers                                          |
| `project.ts`, `selectors.ts` | `project()`, `applyMutation()`, `applyLocal()` over a reducer table; `setsFor`, `currentExercise`, `nextExercise`, `previousFor`, progress, planned vs logged       | workout-projection                                      |
| `reducers/`                  | `core`, `sets`, `device`, `structure`, `run`, `other`; `tables.ts`: `strengthTable`, `otherTable`; `run.ts`: `runTable`; each typed over its kind's types           | workout-projection; substitution-rules; run-other-rules |
| `logging.ts`                 | `setFields(measure, loadType)`, `checkSet(set, exercise)` at dotted paths, `e1rmApplies`, `volumeOf`, `totals`, `prKinds`                                           | logging-rules                                           |
| `prefill.ts`                 | `nextSet(slot, logged, kit, unit)`, `defaultMissedReps`, `RPE_CHIPS`                                                                                                | set-prefill                                             |
| `flow.ts`                    | `groups(kit)` with A1/A2 labels, `afterSet(view, position)`, `upNext(view)`                                                                                         | workout-flow                                            |
| `run.ts`, `other.ts`         | `expandSegments`, `segmentPace`, `runTotals`; `metricInput`                                                                                                         | run-other-rules                                         |
| `summary.ts`                 | The finish summary: volume, estimated e1RM and PRs, duration and session load                                                                                       | workout-summary                                         |
| `substitution.ts`, `copy.ts` | `QUICK_ACTIONS`, `effectsOf`, `rankFor`, `painChoices`; every quick-action, dislike and pain string                                                                 | substitution-rules                                      |
| `describe.ts`                | Each mutation in words, 'Set 3 of Back squat · 100 kg × 5'                                                                                                          | sync-status                                             |
| `adhoc.ts`                   | `adhocKit(kind, units, now)`                                                                                                                                        | workout-start                                           |
| `schemas.ts`                 | zod/mini: `envelopeSchema`, a payload schema per type, `syncRequestSchema`, `DB_CHECKED_BAD_VALUES`, `SCHEMA_ONLY_BAD_VALUES`                                       | mutation-schemas                                        |

## The contract in brief

- **Identity.** A create's id is its new row's client id (`id === entityId`); an edit, a delete,
  a finish or an abandon has a fresh id and names its row. A segment's first `run.segment`
  creates it; `run.log` and `other.log` always have a fresh id and name their workout.
- **Entity keys.** `workout:`, `set:`, `segment:`, `exercise:` by client id; `run:`, `other:` and
  `slot:<workout>:<position>` by workout. Two mutations of one key are never reordered.
- **Dependencies.** Everything waits for its workout's `workout.start`; a change waits for its
  row's earlier mutations; a mutation naming a custom exercise still in the outbox waits for its
  `exercise.create`; a pain report waits for the substitution it chose.
- **Kinds.** `workout.*` belong to every kind, `run.*` to runs, `other.log` to other sessions and
  the rest to strength, so each route's reducer table handles only its own.
- **Units.** Weights in the unit entered, distances in metres, durations in seconds; a kit's
  loads and paces read in the training profile's units.
