# NNNN — Lifecycles as data: a typed transition table next to each status list

- **Status:** Proposed. Numbered at merge, like a migration slot, so the follow-on PRs refer to it
  by its title, "the lifecycles as data ADR".
- **Context:** No single place says which states a workout or a coach proposal can be in, or what
  may follow what. The rules are spread across if-chains and status strings. A workout has no
  rule at all: `finishWorkout` (`src/lib/server/services/training/log.ts`) writes whatever end
  status it receives, and the device reducer (`src/lib/domain/workout/reducers/core.ts`) does the
  same in any order, so a late abandon from a second device can turn a completed workout, and its
  planned session, back into "not done". Some machines are already explicit, but each in its own
  way: Postgres enforces the coach proposal moves in `coach_proposals_transition_guard` and its
  frozen and insert guards (`drizzle/0026_coach_proposals_guards.sql`) while the app's writes stay
  scattered, and the workout reducer tables (`ReducerTable` in `src/lib/domain/workout/project.ts`)
  are exhaustive per event but carry no from-state guards. Closed vocabularies (`*_LABEL` and
  `keysOf`) already feed the DB CHECKs, and the domain layer is pure and isomorphic (ADR 0004).

## Decision

- **A declared lifecycle is a typed transition table** that sits next to the closed status list
  it is keyed on: `WORKOUT` in `src/lib/domain/workout/lifecycles.ts` (states `WORKOUT_STATES`,
  which satisfy the domain `WorkoutStatus`) and `PROPOSAL` in
  `src/lib/domain/training/lifecycles.ts` (states `PROPOSAL_STATUSES`). A pure helper of about 100
  lines, `src/lib/domain/lifecycle.ts`, backs every table.
- **Each edge** names its from-states, its target and its plain-language `effects`, with an
  optional `why`, `certainty: 'unknown'` (not proven from code) and `legacy: true` (allowed today,
  meant to go). The last two stay separate: an unverified edge and known debt are different
  things. `on` is a mapped type over the events, so an event without an edge fails `pnpm check`
  (the `ReducerTable` trick).
- **`checkLifecycle()`** reports unknown states, non-legacy exits from a terminal state and states
  no edge reaches; the registry test runs it on every table in `src/lib/domain/lifecycles.ts`.
  `PROPOSAL` equals the 0026 trigger's moves exactly, and a test pins that grid.
- **`WORKOUT` follows owner decision D1:** finish from in progress or abandoned (completion beats
  an earlier abandon from another device), abandon only from in progress, and nothing leaves
  completed. A late or second end is answered `applied`, never with a new sync code.
  `src/lib/domain/workout/ends.ts` (`END_FROM`, `canEnd`) carries just those from-lists, so the
  device reducer can follow the table without loading its documentation strings.
- **Status writers take a branded `Transitioned<S>`**, which only `step()` and `unchecked()`
  make. The server guard, `transition()` in `src/lib/server/services/lifecycle-guard.ts`, returns
  one per move. Each machine is either enforced (an illegal move throws `IllegalTransitionError`)
  or observed (it logs `lifecycle.observed` and goes ahead) by its entry in the `ENFORCE` code
  constant, so every flip is a reviewed PR. `LIFECYCLE_STRICT=1`, set only in unit, integration
  and e2e runs, makes an observed machine throw too, so CI catches drift between a table and its
  writers.
- **`docs/lifecycles.md` is generated** from the tables by `pnpm lifecycles`
  (`scripts/lifecycles.ts`); a staleness test fails when it is out of date. An edge not proven
  from code renders as `unknown`.
- **What follows.** This record covers step 0: the helper, the two tables, the registry, the
  generated doc and the guard, with no change users can see. The P0 fixes come next: the
  finishWorkout end policy (D1), one in-progress workout per device enforced only in Discard
  (D5), Discard abandoning instead of deleting (D2) and sign-out asking first (D3). Then an
  observe pilot on `PROPOSAL`, which the trigger already enforces. Later: an observe rollout for
  the other machines, consolidating derived statuses, two waves of P1 fixes, enforce flips one
  machine per PR after a soak with no non-legacy `lifecycle.observed` hits, DB CHECKs added
  `NOT VALID` after zero-violator queries on production and the latest backup and validated
  later, and finally the P2 machines.

## Alternatives considered

| Option                                      | Why not                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| XState or another state-machine library     | Against the minimal-dependency stance (8 runtime dependencies), weight on the workout route's bundle, and mapped types already do it. |
| An ESLint rule on status literals           | Noisy, and weaker than the compile-time `Transitioned<S>` brand.                                                                      |
| Enforcement flags in environment variables  | They hide behaviour changes. `LIFECYCLE_STRICT` only makes observe mode throw in tests; enforcement stays in `ENFORCE`.               |
| Answering refusals with new sync codes      | They would park outbox entries on devices already in the field; D1 answers `applied`.                                                 |
| Logging observe hits as `app_errors` rows   | Noise in the error table, and it hides the hits among real errors.                                                                    |
| The DB triggers as the only source of truth | Client-side machines can't use them, and the coach needs the legal actions before it writes.                                          |
| Rewriting every machine at once             | Too much change in one step; one machine per PR keeps each move reviewable.                                                           |

## Consequences

- One place answers "what can follow what" for each declared machine, and the doc can't drift
  from the code.
- Branded writer signatures touch many files, so machines move to the brand one per PR.
- TypeScript and Postgres agree only while a trigger and its table change together: a trigger
  migration updates its table in the same PR. The friction is intended.
- Observe logs can go unread. Strict mode in CI catches drift in tests, and every `ENFORCE` flip
  attaches a log query; how much production under-reports stays unknown.
- Tables cost bundle bytes, and each route has an initial-JS limit (`/workout`: 53.2 KB of 60 KB
  in CI at the time of writing). So tables stay per route and are marked `/* @__PURE__ */`, and
  the device reducer loads only `ends.ts`.
- Behaviour that looks like a bug may be intended, such as a proposal leaving `accepted`, which
  the trigger allows and no code does yet. Such edges carry a `why`, or stay `legacy` or `unknown`,
  until the owner decides.
