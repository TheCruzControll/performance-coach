---
name: verify-workout-sync
description: Model-check the offline workout sync's promise that a logged change reaches the server exactly once and in order. Use when changing src/lib/client/workout/sync.ts, outbox-rules.ts, store.ts or reconcile.ts, src/lib/server/services/workouts/sync.ts or apply/sets.ts, logSet or editSet in src/lib/server/services/training/log.ts, insertSet in src/lib/server/db/repositories/training-log.ts, src/lib/server/db/repositories/sync.ts, src/lib/server/db/schema/sync.ts, dependsOn in src/lib/domain/workout/order.ts, or the offline workout sync ADR (docs/adr/0012-offline-workout-sync.md).
---

# Verify the offline workout sync

The outbox on the phone, the sync engine in each tab and the server's ledger together promise that a workout change the owner logs reaches the server exactly once and in order. Tests check the orders someone wrote down. A TLA+ model in `verification/workout-sync/` lets the TLC model checker try every order of steps, within small bounds. Use it to check a change to the files below before you open the PR.

## The command

```sh
verification/workout-sync/check.sh            # every check, about three minutes
verification/workout-sync/check.sh baseline   # only the code as it is, about 40 s
```

The script downloads TLC 1.7.4 (`tla2tools.jar`) and, if no working `java` is on the PATH, a Temurin 21 JRE. Both are pinned by SHA-256 and kept in `verification/workout-sync/.cache/`, which git ignores. Set `JAVA` to use another Java 11 or later. Each run writes TLC's output to `.cache/run/<check>/tlc.out`.

Every line must say `ok`:

- `baseline` is the model of the code as it is, with the Web Lock. It must pass.
- `nolock` is the same code where `navigator.locks` is missing, so both tabs flush at once. It must pass.
- `finding` is the model with finding F1's step allowed: Discard of a change a request still running on the server carries. F1 is fixed, so it must pass.
- Each mutant is a broken variant. It must fail on the property it guards. A mutant that passes means the model can no longer see that break.

Exit 0 means every check ended as expected and the covered code matches the sync commit. Exit 1 means a check did not end as expected. Exit 2 means every check ended as expected, but a covered file changed since the sync commit, so a pass says nothing about your change yet. Follow "When the code changed" below.

For every TLC result, find and read the installed `statechart` skill and follow it. It turns each violation into its shortest path in plain words. Give it `MC.tla` with a copy of `MC.cfg` set to the run you want, and `verification/workout-sync/view.mjs`, which words the steps for the owner. The baseline has about 250,000 states, more than its chart budget, so a passing run gives no chart, only the list of rules that hold.

## What is verified

The scenario (`MC.tla`, `MC.cfg`): the owner logs set S (`set.log`, mutation 1), then edits it twice (`set.edit`, mutations 2 and 3). By `dependsOn`, 2 waits for 1, and 3 waits for 1 and 2. The first edit's payload is one the server rejects until the owner fixes it.

| Property            | In one sentence                                                                                                                                            | Harm if broken                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `AppliedAtMostOnce` | No change's write is committed on the server twice.                                                                                                        | An old edit overwrites newer values.                 |
| `AppliedInOrder`    | No change is applied before a change it depends on: an edit never lands before its row's create, nor before an earlier edit of that row that lands at all. | An edit fails on a missing row, or older values win. |
| `NothingLost`       | Until a change is applied it stays in the outbox, unless the owner discarded it.                                                                           | A set the owner logged never reaches the server.     |
| `EventuallySynced`  | Every logged change is eventually applied and leaves the outbox, or the owner discarded it.                                                                | A change waits forever, and the status never clears. |
| `TypeOK`            | The variables hold values of the right kind.                                                                                                               | None by itself. It catches a broken model.           |

TLC tries every order of these steps: two tabs, each with its own engine. The Web Lock `pc-workout-sync` is present (`WebLocks = TRUE`), or missing in the `nolock` run. A POST can time out or lose its answer while the server goes on running it, or after the server has already committed. A request nobody waits for any more can be lost. There is one pagehide keepalive send, whose answer nobody reads. On the server, a mutation can be rejected, deferred (`missing`, `blocked`), answered `duplicate`, or hit a database error that stops the batch with `retry`. That error can come before the COMMIT, or after the COMMIT landed. The function can also die mid-batch. A batch holds at most 2 changes (`BatchCap`). Timeouts, lost answers, server errors and deaths together number at most 2 (`MaxFaults`). The owner can fix, try again or discard. A discard keeps the ids it removed until a request carrying them is answered, and every request carries them; the server claims them as discarded before any mutation of that request. A request carries at most 25 of them: here any of them (`Carried`), and changes only with all of them.

Bounds: `Tabs` = 2, `N` = 3 changes, `BatchCap` = 2, `MaxFaults` = 2, `MaxKeepalive` = 1. The baseline explores about 250,000 distinct states in about 50 s, and `finding` about 670,000 in about 2.5 minutes. The `nolock` run has no Web Lock, 1 fault and no keepalive send, about 117,000 states in about 27 s. Without the lock and with 1 fault and 1 keepalive send, the model also passed, with about 304,000 states in about 4 minutes, too slow for every change. Without the lock and with 2 faults it passed 500,000 states without finishing. The whole script takes about six minutes on an Apple-silicon Mac. A pass covers this model at these bounds, not the whole system.

## Assumptions

- Every counted failure may park its entry as `stuck`. The code parks at `STUCK_AFTER` (50 failures, or 24 hours). The model allows more orders than the code, so its safety results still hold. Only the server's own answers count: a timeout, a network error or a page that is not its JSON is `unreachable` in `sync.ts` and counts nothing, which is `CountFailure` leaving `box` as it is. When the server answers again, `reached` calls `backOnline`, whose waits ending is `WaitEnds`.
- A backoff wait (`nextAt`) ends eventually (`WaitEnds`). Once something can be sent, a round eventually starts (the backoff timer, `online`, becoming visible, or the flush after every saved dispatch). The owner eventually fixes a refused change and presses Try again on a stuck one. `EventuallySynced` rests on these fairness conditions. Discard is never forced.
- A round reads the outbox, runs `nextBatch` and posts in one step. The code awaits between the read and the post, but a stale batch is the same as one posted earlier and delivered late, and the model allows that. The keepalive send uses the engine's last read, by the same argument.
- Running a handler is not the same as committing a write. A replayed `set.log` writes nothing, because `insertSet` is ON CONFLICT DO NOTHING on the client id. A replayed `set.edit` writes nothing when the row already holds its values (`holds` in `editSet`), and overwrites the row when a newer edit landed since. The model records a write in `history` only when it changes the row (`Holds`, `Run`). Each change's values differ from every other's.
- Each server mutation is one atomic step, because each is one Postgres transaction with `claimMutation` first. Two requests' mutations interleave one at a time. The unique key on `sync_mutations.mutation_id` makes concurrent claims of one id act in some order.
- Discard is `store.ts` `discard`, from the sync sheet: it takes only a parked entry, as `Discard`'s precondition requires (`box[m].park # "none"`), and rejects any other with a `RangeError`, writing nothing. One IndexedDB transaction removes the entries (`outbox-rules.ts` `discard`) and keeps their ids (`voided`). A round reads the outbox, then the discarded ids, and posts both; the code's two reads are the model's one step by the same argument as above, since a change the read sees was made after any discard before it. The server's `claimDiscarded` is one statement before the batch (`ServerVoidAt`); an id it already holds as applied keeps that row, which `Seen` treats alike.

## What is left out

Sign-out (`purgeServerCopies`, which keeps the discarded ids, and the signed-out mark it leaves, which changes only what the screens show) and the passkey 403. Offline time, where nothing is sent and nothing is counted, and the 24 hours paused while the server is out of reach. Changes too large to send (`tooLarge`). The byte caps. `reconcile.ts`, which includes parking an edit of a set deleted on another device, and another device's outbox. Every `dependsOn` reason except a row's create and its earlier edits: a workout's start, a custom exercise, a pain report's substitution. More than one workout, so Discard's refusal to bring a workout back into progress beside another (`ActiveWorkoutError` from `rearrange`) is not checked. A stuck workout.start's Discard re-queues it and keeps the workout.abandon queued behind it, or appends one (`discardAbandons`, `loggedIn`, `rearrange`'s `append`), however often it gets stuck: neither is deleted or kept as discarded, since the start may have landed, and only the changes logged in it go. Only a start parked refused is discarded as any other change. Discard never removes the finish or abandon of a workout a 401 purge stripped, which the device holds no rows for and no queued start will make (`endsOnServer`, a refusal in `rearrange`'s rule): it refuses one with a `RangeError`, writing nothing, and leaves one queued when a change it depends on goes, since the server holds that workout in progress and the device would end it alone; the sync sheet offers no Discard for it (`heldEnds`), and offers Try again, refused too: a refused one goes back through Fix (`replaceInPlace`, under its id), with `at` set to now when the server named it (`sentAgain` in `src/routes/workout/fix/workout.ts`). The model has no start, finish or abandon, so none of this is checked; the start conflict's Discard (`start.ts` `discardInProgress`) is left out with it. What the screen shows, from the projection and the canonical rows. A dispatch whose IndexedDB write fails, which never enters the outbox. BroadcastChannel, database upgrades and `stop()`. Closing the store: a deletion or upgrade under a page, and another tab's sign-out ('signed-out'), close it for that page for good (`db.ts` `closeForGood`), so a stale tab never recreates the database; `store.close()`, sign-out's own short-lived stores (`shutdown.ts`), closes only that store. The foreign-owner check on ledger ids. Clock time, apart from waits ending. `finishWorkout`'s from-state rule in `log.ts` (`canEnd` in `src/lib/domain/workout/ends.ts`, owner decision D1): a completed workout stays completed, an abandoned one may still be completed, and a refused end writes nothing and is still answered 'applied'. The model has no workout row and no finish or abandon mutation.

## Finding F1 (fixed): a discard did not stop a request already on its way

Rule: `AppliedInOrder`. Run: `check.sh finding` (`DiscardInFlight = TRUE`), which now passes. The baseline sets `DiscardInFlight = FALSE`, which only forbids discarding a change that an unanswered request still carries. The mutants run with it, so a break F1's path would hide still shows; `discardForgets` runs with it on.

The fix: `store.ts` `discard` keeps the removed ids (`discarded`), `sync.ts` sends them first with every request, the pagehide one too and alone when nothing else waits, and forgets them once a request carrying them is answered. More than a request holds (25) go alone, before any change (`gone`). `applySyncBatch` claims them in the ledger as type 'discarded' (`claimDiscarded`) before any mutation, so in step 5 below the old request reaches an id the ledger holds and answers 'duplicate'. If the old request got there first, its edit lands before the new one, which is in order. Without the ids (`discardForgets`) the path below fails `AppliedInOrder` again.

The path, as it was, in the code's words:

1. The owner logs set S and edits it. One flush posts both. The server applies the log and rejects the edit, and `acknowledge` parks the edit as refused.
2. The owner fixes it (`replaceInPlace`). The engine posts the edit alone. The POST passes `REQUEST_TIMEOUT_MS`, while the server is still running it. `countFailure` counts the failure against the edit, which reaches `STUCK_AFTER`, and it is parked as stuck.
3. The owner presses Discard. `discard` removes the edit from the outbox, and nothing tells the server.
4. The owner edits S again. Nothing holds the new edit, so the pagehide keepalive send (or the next flush) posts it, and the server applies it.
5. The first request now reaches the edit and applies it, because its id is not in the ledger and the row exists. Set S ends with the discarded edit's values, applied after the owner's latest edit.

Harm: the set showed older values than the owner last entered, though the owner discarded them. `sync.test.ts` ('a discard while a request may still be running on the server') replays the path on the real engine and store against a fake server, and `tests/integration/workouts/sync.test.ts` ('discarded changes') replays step 5 on Postgres. Later, remove the flag.

## Mutants: proof that each property can fail

Each is a `MUTANT` value in `MC.cfg`, and stands for one edit to the real code.

| Mutant            | Edit to the real code it stands for                                                                                     | Fails               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `ackOnSend`       | `sync.ts` `drain` removes the batch from the outbox when it posts it, not when the answer is stored.                    | `NothingLost`       |
| `claimOwnTx`      | `applyOne` calls `claimMutation` on `deps.db` outside the mutation's transaction, so a failed handler leaves the claim. | `NothingLost`       |
| `claimAfterApply` | `applyOne` runs the handler before `claimMutation` and answers 'duplicate' on 'seen' without rolling back.              | `AppliedAtMostOnce` |
| `skipWaitingHead` | `nextBatch` skips a parked or waiting entry without adding it to `held`.                                                | `AppliedInOrder`    |
| `blockedApplied`  | `applySyncBatch` drops the `held.some((earlier) => waitsFor(m, earlier))` check.                                        | `AppliedInOrder`    |
| `retryContinues`  | `applySyncBatch`'s catch answers 'retry' for that mutation and goes on with the batch, instead of the 503 or the break. | `AppliedInOrder`    |
| `fixKeepsParked`  | `replaceInPlace` keeps `parked` on the corrected entry.                                                                 | `EventuallySynced`  |
| `discardForgets`  | `store.ts` `discard` keeps no ids, so no request carries them (F1 as it was; run with `DiscardInFlight = TRUE`).        | `AppliedInOrder`    |
| `capSendsNewer`   | `sync.ts` `gone` lets changes go with only the first 25 discarded ids (run with `DiscardInFlight = TRUE`).              | `AppliedInOrder`    |

`claimAfterApply`'s path breaks `AppliedInOrder` at the same step. `check.sh` takes the first rule TLC names, and TLC checks them in `MC.cfg`'s order.

Their shortest paths:

- `ackOnSend`. The owner logs S, and a tab posts it. The outbox is already empty, so a timeout or a lost request loses the set.
- `claimOwnTx`. S is posted twice: the tab's flush and the keepalive send. A database error stops the first after its claim committed. The second is answered 'duplicate', and `acknowledge` removes S, which was never applied.
- `claimAfterApply`. A flush posts S and the first edit. The server applies S and rejects the edit. The owner fixes it. The keepalive send and the next flush each post both edits. The server applies the flush's two edits. Then it runs the keepalive's first edit: `editSet` writes its older values over the second edit's, and the late claim answers 'duplicate'. The set shows the older values, with an audit row, until the keepalive's second edit is written again. A batch holding only the old edit leaves them for good. This path was replayed on Postgres with the scratch change to `applyOne`: after step 13 the set held the first edit's reps, with one more audit row. A replayed `set.log` under the same change still gave one row, so the mutant needs an edit to show its harm.
- `skipWaitingHead`. The first edit is refused. The second edit is posted by keepalive and again by the next flush with the fixed first edit. The server applies the second edit, then the first.
- `blockedApplied`. A flush posts both edits. The server rejects the first and applies the second. After the fix, the first edit lands last.
- `retryContinues`. After the fix, both edits are posted together. A database error on the first answers 'retry', and the batch goes on to apply the second. The first lands later.
- `fixKeepsParked`. The owner fixes the refused edit, and it stays in 'Needs attention'. The second edit is held behind it forever.
- `discardForgets`. F1's path, above.
- `capSendsNewer`. F1's path, where the request with the owner's newer edit leaves out the discarded id of the edit still running on the server.

## Coverage record

Sync commit: `f15b739e2f84a20f89f8c049e87763697a125301`

At this commit the model was confirmed to describe every function below. `check.sh` exits 2 when a file listed here differs from it. Move it forward only after you have confirmed that the model describes every covered function at the new commit, and say so in the PR.

| File                                             | Function                                                                                                                   | Model (`WorkoutSync.tla`)                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/lib/client/workout/store.ts`                | `dispatch`, `write` (outbox `add` in one transaction)                                                                      | `Log`                                                             |
| `src/lib/client/workout/store.ts`                | `acknowledge` (one transaction over the results)                                                                           | `Receive`                                                         |
| `src/lib/client/workout/store.ts`                | `countFailure`, `backOnline` through `revise`                                                                              | `CountFailure` in `ReceiveFailed`, `Timeout`; `WaitEnds`          |
| `src/lib/client/workout/store.ts`                | `outbox`                                                                                                                   | `NextBatch` reads `box`                                           |
| `src/lib/client/workout/store.ts`                | `discard` (parked entries only; entries removed and their ids kept, one transaction), `discarded`, `forget`                | `Discard` (`voided`), `Request` (`voids`), `Receive`              |
| `src/lib/client/workout/store.ts`                | `tryAgain`, `fix` through `rearrange`; `discard` too, which may refuse when two workouts would be in progress              | `TryAgain`, `Fix`                                                 |
| `src/lib/client/workout/outbox-rules.ts`         | `nextBatch`                                                                                                                | `Scan`, `NextBatch`                                               |
| `src/lib/client/workout/outbox-rules.ts`         | `applyResults`, `fail`, `STUCK_AFTER`                                                                                      | `Receive`, `Stuck`                                                |
| `src/lib/client/workout/outbox-rules.ts`         | `countFailure`                                                                                                             | `CountFailure`                                                    |
| `src/lib/client/workout/outbox-rules.ts`         | `backOnline`, `nextDelay`                                                                                                  | `WaitEnds`                                                        |
| `src/lib/client/workout/outbox-rules.ts`         | `discard`, `dependantsOf`                                                                                                  | `Discard`, `Gone`                                                 |
| `src/lib/client/workout/outbox-rules.ts`         | `tryAgain`                                                                                                                 | `TryAgain`                                                        |
| `src/lib/client/workout/outbox-rules.ts`         | `replaceInPlace`                                                                                                           | `Fix`                                                             |
| `src/lib/client/workout/sync.ts`                 | `round`, `drain` under `SYNC_LOCK`, `post`                                                                                 | `StartRound`, `EndRound`, `lock`, `pc`                            |
| `src/lib/client/workout/sync.ts`                 | `drain`'s `answered` case (halted or short answer ends the drain)                                                          | `Receive`                                                         |
| `src/lib/client/workout/sync.ts`                 | `drain`'s `failed` case, `REQUEST_TIMEOUT_MS`; `unreachable` counts nothing, `reached`                                     | `ReceiveFailed`, `Timeout`; `CountFailure`'s `box' = box`         |
| `src/lib/client/workout/sync.ts`                 | `keepalive` (pagehide)                                                                                                     | `Keepalive`                                                       |
| `src/lib/client/workout/sync.ts`                 | `read` (the outbox, then the discarded ids), `bodyOf`, `gone`, `drain` sending ids alone and forgetting them once answered | `Request`, `Sendable`, `StartRound`, `EndRound`, `Receive`        |
| `src/lib/client/workout/sync.ts`                 | `schedule`, `kick`, `flush`                                                                                                | fairness on `StartRound`, `WaitEnds`                              |
| `src/lib/client/workout/reconcile.ts`            | none (left out)                                                                                                            | none                                                              |
| `src/lib/server/services/workouts/sync.ts`       | `applySyncBatch` (order, `held`, `waitsFor`, 'retry' and 503)                                                              | `ServerStepAt`, `ServerErrorAt`, `ServerDiesAt`                   |
| `src/lib/server/services/workouts/sync.ts`       | `applySyncBatch` claims the discarded ids first (`claimDiscarded`; a failure is the 503)                                   | `ServerVoidAt`, `ServerDiesAt`                                    |
| `src/lib/server/services/workouts/sync.ts`       | `applyOne` (claim first, then handler, in one transaction), `refusalOf`                                                    | `ServerStepAt` (`outcome`, `Missing`), `ServerErrorAt` (`landed`) |
| `src/lib/server/services/workouts/apply/sets.ts` | `set.log` through `logSet`, `set.edit` through `editSet`                                                                   | `RowOf`, `Holds`, `Run`                                           |
| `src/lib/server/services/training/log.ts`        | `logSet`, `editSet` (`holds`: an edit with the stored values writes nothing)                                               | `Holds`, `Run`                                                    |
| `src/lib/server/db/repositories/training-log.ts` | `insertSet` (ON CONFLICT DO NOTHING on `clientMutationId`)                                                                 | `Holds` (a create already in `history`)                           |
| `src/lib/server/db/repositories/sync.ts`         | `claimMutation`                                                                                                            | `ledger`                                                          |
| `src/lib/server/db/repositories/sync.ts`         | `claimDiscarded` (type 'discarded', ON CONFLICT DO NOTHING); `claimMutation` then answers 'seen'                           | `dropped`, `Seen`                                                 |
| `src/lib/server/db/schema/sync.ts`               | `syncMutations` (unique `mutation_id`)                                                                                     | `ledger`                                                          |
| `src/lib/domain/workout/order.ts`                | `dependsOn`                                                                                                                | `Dep` (`MCDep` in `MC.tla`), `Creates`                            |

The design is in `docs/adr/0012-offline-workout-sync.md`, sections 'Exactly once', 'Bounded flushing' and 'Tabs'.

## When the code changed

1. Run `git diff <sync commit> -- <covered files>` and read each changed function against its model action above.
2. If the model still describes the code, run `check.sh`. Then move the sync commit to the commit with your change.
3. If the change is intended and the model no longer describes it, edit the action so it does, at the code's atomicity. One IndexedDB transaction, one Postgres transaction, or one request is one step. Keep the properties as they are. Update the coverage record, and update a mutant whose code no longer exists. Then run `check.sh`, every line must say `ok`, and move the sync commit.

## A failing check: real bug or modeling error?

- If `baseline` fails, or `finding` fails on a rule other than `AppliedInOrder`, get the path in plain words through `statechart`. Replay it against the code, one step per action, through the coverage record. Where you can, replay the client half on the pure functions in `outbox-rules.ts` in a scratch Vitest test.
- If every step can happen in the code, it is a real bug. Report it with the path in the code's words. Do not weaken a property, and do not narrow the model until it passes. Add it as a finding with its own `MC.cfg` flag and `check.sh` line, as F1 is.
- If a step cannot happen in the code, the model is wrong. Fix the action, then rerun everything: each mutant must still fail on its property.
- If a mutant passes, or fails on a different rule, the model lost the power to see that break. Fix the model, not the mutant's expectation.
- If a line says `error`, read its `tlc.out`. It is a TLA+ parse or semantic error, or a deadlock, which is a model bug: a state the code can leave has no step out.
