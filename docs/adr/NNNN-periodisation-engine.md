# NNNN — Periodisation engine: rules as data, one evaluator, one load model

- **Status:** Proposed (M7). Numbered at merge, like a migration slot, so M7's slices refer to it
  by its title, "the periodisation engine ADR". docs-m7 accepts it.
- **Context:** M7 plans a season of block types (strength, hypertrophy, marathon and half, fight
  camp, recovery and maintenance) around several goals at once, judges every week for
  concurrent-training clashes and fatigue, and re-plans as priorities and fatigue change (PRD §2,
  §5). Train, the Move sheet, the coach, the generator and M6's weekly review must all reach the
  same verdict on the same week and give the same reason, and every number must be a default
  the owner can find and change.

## Decision

- **Rules as data, in one registry.** Every rule is an entry in
  `src/lib/domain/programming/rules/registry/`, whose id is the rule key decisions cite. A
  constant entry points at the live constant (`path#EXPORT`) and carries its values, read from
  it, never copied; a behaviour entry points at the function that applies a rule with no
  constant behind it (`goals.paused`, `edits.move`). A rule an M7 rule replaces stays, marked
  superseded with the id replacing it. Each area has its own file, filled by one slice.
  docs/programming-rules.md is generated from the registry.
- **One evaluator.** `evaluateWeek` is the only judge of a week. It returns findings (rule,
  severity, days, sessions, headline, message, why, an optional resolution and whether the
  owner can still act on it), a 0–100 score and a grade (`evaluate/types.ts`). M3's four
  interference rules run unchanged through `checkWeek`; with no context every surface falls back
  to it. M7's rules join when the context carries load, priorities, the week kind or events.
- **One load model, on M1's and M6's code.** A session's load is M1's sRPE through M3's
  `sessionLoadOf`, as M6's `sessionLoads` computes it, split into five systems (lower, upper,
  aerobic, combat and CNS). Each system has a residual with a half-life and M1's acute:chronic
  ratio, null under 28 days as Progress shows it. A logged session with no RPE or duration is
  'load unknown', never 0. Total daily load equals M6's `dailyLoads`, as tested.
- **Priorities.** Inside its lead window an event goal leads; otherwise rank decides. Each goal
  is primary, secondary or at maintenance, with a sentence naming the goals, the dates and the
  rule. Maintenance doses are M3's maintenance split and band, through one `doseBand`.
- **The scheduler.** `repairWeek` moves sessions to clear findings, as M3 `moveSession` ops, and
  keeps the owner's own moves wherever a generator or review uses it.
- **Context reads bounded by Postgres, never by a timer.** A read abandoned by a JS timer keeps
  its client busy, so the caller's next query queues behind it. On the pool, the context reads
  run in one short read-only transaction with `SET LOCAL statement_timeout`; inside a caller's
  transaction, in a read-only savepoint with the same setting, always rolled back to. A
  cancelled read (57014) falls back to `checkWeek` and records an app error.
- **Open vocabularies, no migration.** Decision kinds, phases, week kinds and the optional week
  targets (`mainLifts`, `setsPerGroup`, `running`, `combat`, `maintenance`) are open lists or
  jsonb, named once in m7-contract, so weeks stored before M7 read unchanged.

## Alternatives

- **A hand-written rules catalogue.** It drifts from the code; the registry reads the live
  constants and a test fails when a source moves.
- **One evaluator per surface.** Train and the weekly review would disagree about the same week.
- **A second load model.** A new EWMA would give Progress and the coach different numbers.
- **A JS timeout on context reads.** It leaves the query running on a shared client, which the
  one-query-per-client guard fails, and a cancel would abort the caller's transaction.

## Consequences

- A coaching number changes in one place, and the rules reference and every surface follow.
- Every M7 rule key must resolve in the registry; each registry slice asserts its own area's.
- Each context read path carries a stall test under the one-query guard.
