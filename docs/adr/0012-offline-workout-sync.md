# 0012 — Offline workout sync: inputs on the device, one projection, applied exactly once

- **Status:** Accepted (M4, 2026-11-10). Built as decided here by M4's slices, #87 to #355.
  The owner has not answered the plan's open questions, so each runs on the plan's default, kept
  in a named constant (listed under "Defaults the owner can change"). One part is not merged
  yet: sign-out's flush and ask ("Losing the session"); until it is, sign-out deletes
  `pc-offline` with any unsynced changes in it.
- **Context:** A workout must never lose a set and never wait for the network (PRD §9, §15,
  §18). A set is confirmed in under 100 ms in a gym with no signal; a reload offline restores the
  workout exactly, timers included; Postgres never stores a set twice, however often a device
  replays it. There is one owner, but a phone, a laptop and several tabs. M3's training log
  (`drizzle/0014`) already makes creates idempotent by client id, edits audited and deletes soft.
  iOS Safari has no Background Sync and evicts a site's storage after 7 days unless it is
  installed.

## Decision

- **The device stores inputs, not derived state.** One IndexedDB database, `pc-offline` (the
  name M2's sign-out already deletes), through `idb`, with every store declared at version 1:
  `workouts`, `outbox`, `kits`, `library`, `meta`. Each workout keeps its start kit, the server's
  canonical rows (keyed by client ids, tombstones included) and the device-only state; the outbox
  keeps the pending mutations in order. An action writes its outbox entries and the device state
  in one readwrite transaction that awaits nothing but IndexedDB, because Safari commits a
  transaction that awaits anything else. A quota or private-mode error reads 'Not saved on this
  device', with Retry, on the action that failed.
- **One projection.** Every screen shows `project(table, kit, canonical, pending, device)`, with
  its route's reducer table: strength (core, sets, structure), run (core, run), session (core,
  other), each with the device actions. That one function is the optimistic UI, restore, other
  tabs, other devices and every sync response. Reducers are idempotent by entity: a create of a
  known id is a no-op (a tombstone included), edits are absolute and deletes leave tombstones, so
  replaying what the server already applied changes nothing. A seeded property holds:
  `project(kit, serverModel(M[0..k]), M[i..n])` equals the fold of M for any i ≤ k + 1.
- **Wire format v1** (`src/lib/domain/workout/`). The envelope is
  `{ v, id, type, workoutId, entityId, at, payload }`, with 16 types. A create's id is its new
  row's client id; edits, deletes, finish and abandon carry a fresh id and name their row, so an
  edit made before its create synced still works. A segment's first `run.segment` creates it;
  `run.log` and `other.log` always carry a fresh id and name their workout, whose id is
  `workout.start`'s. Entity keys (`workout:`, `set:`, `segment:`, `run:`, `other:`, `slot:`,
  `exercise:`) and `dependsOn` order the outbox and the server. Device actions (position, drafts,
  added exercises, attached data, the timers) are never sent. The format is M4's own: the sync
  endpoint maps it onto M3's services, so an M3 rename changes one adapter. After merge only
  optional fields and new types are added; `v` changes only with a server that accepts both.
- **Exactly once.** `sync_mutations` records each applied id in the same transaction as its
  effect (`INSERT … ON CONFLICT DO NOTHING RETURNING`); a concurrent duplicate waits on the
  uncommitted key, then reads it as seen. Each mutation runs in its own transaction, with M3's
  services in it and `app.actor` 'owner'. A result is `applied`, `duplicate` (nothing applied, the
  canonical rows returned), `rejected` (dotted field errors), `deferred` (its target has not
  arrived) or `retry` (transient; it stops the batch). Only applied mutations leave a ledger row,
  so Fix re-sends a corrected payload under the same id, in its place, even as another type.
  Within a batch, once one of a row's mutations is refused or deferred, that row's later ones are
  deferred too. The server always validates; a browser validates only in the Fix flow.
- **Bounded flushing.** Strict FIFO by outbox sequence, where a parked or waiting entry blocks
  only its dependants. A batch is at most 25 mutations and 64 KB, and the pagehide keepalive batch
  48 KB, so RUM's beacon still fits the page's 64 KB keepalive quota. A POST is aborted after
  15 s and a reconcile GET after 10 s. Backoff is full jitter, `random × min(60 s, 1 s × 2^n)`,
  reset on success and on `online`. After 50 counted failures or 24 hours (an offline device
  counts none) an entry is parked as 'Needs attention', with Try again and Discard. Every type can
  be discarded, and a registry keyed by type gives each a Fix path or a Discard-only reason. A
  dispatch, `online`, becoming visible, app start and the backoff timer flush; one engine per page.
- **Reconciliation.** The view is always the server's rows with the pending mutations replayed.
  The server applies mutations in arrival order, so the last applied wins and `training_audit`
  records both. A device's own pending edit wins locally until it is acknowledged. A pending edit
  of a set deleted on another device is rejected as `deleted` and parked for Discard. The server
  never touches device state. A 404 while the workout's start is pending waits for the flush; a
  404 after it was acknowledged (the server lost it) keeps the local copy, whose sends answer
  `deferred` until the cap surfaces them.
- **Tabs.** The Web Lock `pc-workout-sync` keeps one flusher per device; without Web Locks the
  ledger deduplicates. BroadcastChannel `pc-workout` says changed, purged, closed or signed-out.
  A connection closes on `versionchange` and then refuses to write until reload, so sign-out's
  `deleteDatabase` is never blocked and a stale tab never recreates the data.
- **Losing the session.** On a 401 the engine deletes what the server already holds (kits,
  canonical rows, the library, synced and finished workouts) and keeps only the unsynced outbox and
  an unfinished workout's device state; the pages show 'Signed out on this device · N changes
  waiting', with no workout details, and after sign-in the outbox flushes and the view is rebuilt
  from the server. A recovery session's 403 asks to finish adding a passkey and keeps everything;
  any other 403 backs off. Sign-out flushes first (≤ 5 s), asks before deleting what remains, then
  clears the device and leaves a one-shot marker; the sign-in page's `?signedOut=1` without that
  marker keeps unsynced changes and asks.
- **The pages.** `/workout` (strength, the empty state and the start), `/workout/run` and
  `/workout/session` are prerendered, public and data-free, outside `(app)`: the same HTML for
  everyone, precached with every immutable chunk, their data only from IndexedDB and owner-only
  JSON endpoints, their headers from `vercel.json`. Each imports only its own view, so each kind's
  path is budgeted; a page holding another kind's workout replaces itself with that kind's route.
  The service worker matches them ignoring the query string. They were dark-launched: nothing
  linked to them until Today, the session screen, Train and History gained Start and Resume
  (start-entry-points, #366).
- **Version skew.** A newer app's database upgrade, or a missing lazy chunk of an older build,
  shows 'App updated — reload to continue'; reloading is safe because everything is in IndexedDB.
  A `pc-offline` with other stores reads as empty and is recreated by the workout store.
- **Eviction.** `storage.persist()` is requested when a workout starts, and the outbox flushes
  eagerly on every trigger, since iOS has no Background Sync.

## Mapping onto M3's training log

`workout.start` → `workouts` (`client_id`, a pinned `planned_session_id`); `set.*` and
`exercise.skip` → `set_records` by `client_mutation_id`; `exercise.substitute`, `exercise.dislike`
→ `workout_substitutions` (a dislike also through M3's preference and swap services);
`exercise.create` → `exercises` through `createCustomExercise` with the device's id;
`pain.report` → M4's `pain_reports`; `run.log`, `run.segment` → `run_records`,
`run_record_segments`; `other.log` → `other_session_records`. The fallback slice log-gaps-db
added M3 amendments A1–A2 to the log: `set_records.assistance`, the not-skipped amount CHECK, a
day's cap on seconds and a 50 cap on missed reps; `workout_substitutions.exercise_position` and
`deleted_at`. The fallback slice log-gaps-service added A3–A4 to the write services: sets by
measure and load type (checkSet), `addRunSegment`, `editRunSegment` and `editOtherSession` by
client id, every write in the caller's transaction, and a start's pinned planned session checked
against the lineage and program it names. A6, a never-again swap in the caller's transaction that
re-bases on the current version, was added by substitution-handlers (#246) in
`services/programs/edits.ts`. A set's distance is whole metres, as `set_records.metres` keeps it.

## Alternatives considered

| Option                            | Why not                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| Per-row version locking           | Refuses the owner's own offline edits whenever another device wrote first.               |
| CRDTs                             | One owner; last-applied with an audit trail is enough, and CRDTs ship kilobytes of code. |
| A service-worker-owned queue      | iOS stops workers at will and has no Background Sync; two writers to one database.       |
| Caching personal HTML             | Breaks M1's rule; personal data must live only where sign-out can erase it.              |
| One endpoint per mutation         | A round trip per change for an offline backlog.                                          |
| Last-writer-wins on client clocks | Device clocks disagree.                                                                  |
| Lazy per-kind views on one route  | About 1.0 KB more on the strength path, in chunks the budget check cannot see.           |

## Consequences

- Contract churn costs every track, so the contract is frozen first and only grows.
- The ledger is never pruned in M4 (about 15k rows a year), so an outbox replayed months later is
  still recognised.
- The store's read path is in each workout page's initial JavaScript; validation, the sync
  engine and every sheet load on demand.
- A device that stays offline after its session was lost keeps showing its workout until it
  next reaches the server.

## Measured (2026-11-10)

On the merged M4 code (CI runs 42806982845 and 42802588785, 4-vCPU Linux runners; the numbers
and how they were taken are in docs/performance.md, "M4 (workout)"):

- Initial JS: `/workout` 53.8 KB, `/workout/run` and `/workout/session` 53.7 KB, of 60 KB. One
  route per kind kept every kind's whole path in `pnpm budgets`; the rejected lazy view measured
  about 1.0 KB more on the strength path in the plan's prototype.
- A logged set shows as done in a median of 22.9 ms, p95 32.5 ms, over 20 sets at 4× CPU
  (criterion: under 100 ms). INP p75 on `/workout` is 56 ms from Event Timing and from
  web-vitals (criterion: 200 ms or less).
- A service-worker reload of `/workout` with a workout in progress blocks the main thread for a
  median of 0 ms; loading it blocks for 6 ms.

## Defaults the owner can change

Each open question of the M4 plan that the code answers runs on the plan's default:

| Question                       | Default                                                                  | Where                                                |
| ------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| Two devices edit one set       | The last mutation the server applies wins; both are audited              | `reducers/sets.ts`, `services/workouts/sync.ts`      |
| A change that keeps failing    | 'Needs attention' after 50 counted failures or 24 hours                  | `STUCK_AFTER` in `client/workout/outbox-rules.ts`    |
| A session lost elsewhere       | Keep only unsynced changes and the unfinished workout's device state     | `purgeServerCopies` in `client/workout/store.ts`     |
| Ledger retention               | Never pruned in M4                                                       | `db/schema/sync.ts`                                  |
| Default rest per exercise type | Main lift 3:00, other compounds 2:00, isolation 1:30, timed 1:00         | `DEFAULT_REST_SECONDS` in `domain/workout/timers.ts` |
| Load types                     | Assisted: no e1RM, volume or PR; unweighted bodyweight: 'most reps' only | `LOAD_RULES` in `domain/workout/logging.ts`          |
| Supersets                      | A1 → A2 alternate, the round's rest after its last member                | `SUPERSET_FLOW` in `domain/workout/flow.ts`          |
| Device settings                | Per device in localStorage; sign-out keeps them                          | `WORKOUT_SETTINGS_KEY`, `PLATES_KEY`                 |
