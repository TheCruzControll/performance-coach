---
name: verify-workout-sync
description: Model-check the offline workout sync's promise that a logged change reaches the server exactly once and in order. Use when changing src/lib/client/workout/sync.ts, outbox-rules.ts, store.ts or reconcile.ts, src/lib/server/services/workouts/sync.ts, src/lib/server/db/repositories/sync.ts, src/lib/server/db/schema/sync.ts, dependsOn in src/lib/domain/workout/mutations.ts, or the offline workout sync ADR (docs/adr/0012-offline-workout-sync.md).
---

# Verify the offline workout sync

The outbox on the phone, the sync engine in each tab and the server's ledger together promise that a workout change the owner logs reaches the server exactly once and in order. Tests check the orders someone wrote down. A TLA+ model in `verification/workout-sync/` lets the TLC model checker try every order of steps, within small bounds. Use it to check a change to the files below before you open the PR.

## The command

```sh
verification/workout-sync/check.sh            # every check, about a minute
verification/workout-sync/check.sh baseline   # only the code as it is, about 10 s
```

The script downloads TLC 1.7.4 (`tla2tools.jar`) and, if no working `java` is on the PATH, a Temurin 21 JRE. Both are pinned by SHA-256 and kept in `verification/workout-sync/.cache/`, which git ignores. Set `JAVA` to use another Java 11 or later. Each run writes TLC's output to `.cache/run/<check>/tlc.out`.

Every line must say `ok`:

- `baseline` is the model of the code as it is, with the Web Lock. It must pass.
- `nolock` is the same code where `navigator.locks` is missing, so both tabs flush at once. It must pass.
- `finding` is the model with finding F1 switched on. It must fail on `AppliedInOrder` until F1 is fixed.
- Each mutant is a broken variant. It must fail on the property it guards. A mutant that passes means the model can no longer see that break.

Exit 0 means every check ended as expected and the covered code matches the sync commit. Exit 1 means a check did not end as expected. Exit 2 means every check ended as expected, but a covered file changed since the sync commit, so a pass says nothing about your change yet. Follow "When the code changed" below.

For every TLC result, find and read the installed `statechart` skill and follow it. It turns each violation into its shortest path in plain words. Give it `MC.tla` with a copy of `MC.cfg` set to the run you want, and `verification/workout-sync/view.mjs`, which words the steps for the owner. The baseline has about 40,000 states, more than its chart budget, so a passing run gives no chart, only the list of rules that hold.

## What is verified

The scenario (`MC.tla`, `MC.cfg`): the owner logs set S (`set.log`, mutation 1), then edits it twice (`set.edit`, mutations 2 and 3). By `dependsOn`, 2 waits for 1, and 3 waits for 1 and 2. The first edit's payload is one the server rejects until the owner fixes it.

| Property            | In one sentence                                                                                                                                            | Harm if broken                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `AppliedAtMostOnce` | No change's effect is committed on the server twice.                                                                                                       | A set is logged twice.                               |
| `AppliedInOrder`    | No change is applied before a change it depends on: an edit never lands before its row's create, nor before an earlier edit of that row that lands at all. | An edit fails on a missing row, or older values win. |
| `NothingLost`       | Until a change is applied it stays in the outbox, unless the owner discarded it.                                                                           | A set the owner logged never reaches the server.     |
| `EventuallySynced`  | Every logged change is eventually applied and leaves the outbox, or the owner discarded it.                                                                | A change waits forever, and the status never clears. |
| `TypeOK`            | The variables hold values of the right kind.                                                                                                               | None by itself. It catches a broken model.           |

TLC tries every order of these steps: two tabs, each with its own engine. The Web Lock `pc-workout-sync` is present (`WebLocks = TRUE`), or missing in the `nolock` run. A POST can time out or lose its answer while the server goes on running it, or after the server has already committed. A request nobody waits for any more can be lost. There is one pagehide keepalive send, whose answer nobody reads. On the server, a mutation can be rejected, deferred (`missing`, `blocked`), answered `duplicate`, or hit a database error that stops the batch with `retry`. That error can come before the COMMIT, or after the COMMIT landed. The function can also die mid-batch. A batch holds at most 2 changes (`BatchCap`). Timeouts, lost answers, server errors and deaths together number at most 2 (`MaxFaults`). The owner can fix, try again or discard.

Bounds: `Tabs` = 2, `N` = 3 changes, `BatchCap` = 2, `MaxFaults` = 2, `MaxKeepalive` = 1. The baseline explores about 40,000 distinct states in about 10 s. The `nolock` run has no Web Lock, 1 fault and no keepalive send, about 31,000 states in about 15 s. Without the lock and with 1 fault and 1 keepalive send, the model also passed, with about 304,000 states in about 4 minutes, too slow for every change. Without the lock and with 2 faults it passed 500,000 states without finishing. The whole script takes about a minute on an Apple-silicon Mac. A pass covers this model at these bounds, not the whole system.

## Assumptions

- Every counted failure may park its entry as `stuck`. The code parks at `STUCK_AFTER` (50 failures, or 24 hours). The model allows more orders than the code, so its safety results still hold.
- A backoff wait (`nextAt`) ends eventually (`WaitEnds`). Once something can be sent, a round eventually starts (the backoff timer, `online`, becoming visible, or the flush after every saved dispatch). The owner eventually fixes a refused change and presses Try again on a stuck one. `EventuallySynced` rests on these fairness conditions. Discard is never forced.
- A round reads the outbox, runs `nextBatch` and posts in one step. The code awaits between the read and the post, but a stale batch is the same as one posted earlier and delivered late, and the model allows that. The keepalive send uses the engine's last read, by the same argument.
- Each server mutation is one atomic step, because each is one Postgres transaction with `claimMutation` first. Two requests' mutations interleave one at a time. The unique key on `sync_mutations.mutation_id` makes concurrent claims of one id act in some order.
- Discard is modeled as `outbox-rules.ts` `discard` would act when wired. Nothing calls it yet.

## What is left out

Sign-out (`purgeServerCopies`) and the passkey 403. Offline time, where nothing is sent and nothing is counted. Changes too large to send (`tooLarge`). The byte caps. `reconcile.ts`, which includes parking an edit of a set deleted on another device, and another device's outbox. Every `dependsOn` reason except a row's create and its earlier edits: a workout's start, a custom exercise, a pain report's substitution. More than one workout. What the screen shows, from the projection and the canonical rows. A dispatch whose IndexedDB write fails, which never enters the outbox. BroadcastChannel, database upgrades and `stop()`. The foreign-owner check on ledger ids. Clock time, apart from waits ending.

## Finding F1 (current code): a discard does not stop a request already on its way

Rule: `AppliedInOrder`. Run: `check.sh finding` (`DiscardInFlight = TRUE`). The baseline sets `DiscardInFlight = FALSE`, which only forbids discarding a change that an unanswered request still carries. That lets the other checks see breaks that F1 would hide.

The path, in the code's words:

1. The owner logs set S and edits it. One flush posts both. The server applies the log and rejects the edit, and `acknowledge` parks the edit as refused.
2. The owner fixes it (`replaceInPlace`). The engine posts the edit alone. The POST passes `REQUEST_TIMEOUT_MS`, while the server is still running it. `countFailure` counts the failure against the edit, which reaches `STUCK_AFTER`, and it is parked as stuck.
3. The owner presses Discard. `discard` removes the edit from the outbox, and nothing tells the server.
4. The owner edits S again. Nothing holds the new edit, so the pagehide keepalive send (or the next flush) posts it, and the server applies it.
5. The first request now reaches the edit and applies it, because its id is not in the ledger and the row exists. Set S ends with the discarded edit's values, applied after the owner's latest edit.

Harm: the set shows older values than the owner last entered, though the owner discarded them. This is latent, because no screen calls `discard` yet. The 'Needs attention' screen in ADR 0012 will. Steps 2 to 4 were replayed on the real `outbox-rules.ts` functions in a scratch Vitest test. Step 5 follows from `applySyncBatch`, which holds a change only behind changes in the same batch. When a fix lands, `check.sh finding` should pass. Then make that its expected result, and later remove the flag.

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

Their shortest paths:

- `ackOnSend`. The owner logs S, and a tab posts it. The outbox is already empty, so a timeout or a lost request loses the set.
- `claimOwnTx`. S is posted twice: the tab's flush and the keepalive send. A database error stops the first after its claim committed. The second is answered 'duplicate', and `acknowledge` removes S, which was never applied.
- `claimAfterApply`. S is posted twice: a flush and the keepalive send. The server applies it in both.
- `skipWaitingHead`. The first edit is refused. The second edit is posted by keepalive and again by the next flush with the fixed first edit. The server applies the second edit, then the first.
- `blockedApplied`. A flush posts both edits. The server rejects the first and applies the second. After the fix, the first edit lands last.
- `retryContinues`. After the fix, both edits are posted together. A database error on the first answers 'retry', and the batch goes on to apply the second. The first lands later.
- `fixKeepsParked`. The owner fixes the refused edit, and it stays in 'Needs attention'. The second edit is held behind it forever.

## Coverage record

Sync commit: `d325f6c40887e0f471ccac5d7de3510dd7996c45`

At this commit the model was confirmed to describe every function below. `check.sh` exits 2 when a file listed here differs from it. Move it forward only after you have confirmed that the model describes every covered function at the new commit, and say so in the PR.

| File                                       | Function                                                                | Model (`WorkoutSync.tla`)                                         |
| ------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/lib/client/workout/store.ts`          | `dispatch`, `write` (outbox `add` in one transaction)                   | `Log`                                                             |
| `src/lib/client/workout/store.ts`          | `acknowledge` (one transaction over the results)                        | `Receive`                                                         |
| `src/lib/client/workout/store.ts`          | `countFailure`, `backOnline` through `revise`                           | `CountFailure` in `ReceiveFailed`, `Timeout`; `WaitEnds`          |
| `src/lib/client/workout/store.ts`          | `outbox`                                                                | `NextBatch` reads `box`                                           |
| `src/lib/client/workout/outbox-rules.ts`   | `nextBatch`                                                             | `Scan`, `NextBatch`                                               |
| `src/lib/client/workout/outbox-rules.ts`   | `applyResults`, `fail`, `STUCK_AFTER`                                   | `Receive`, `Stuck`                                                |
| `src/lib/client/workout/outbox-rules.ts`   | `countFailure`                                                          | `CountFailure`                                                    |
| `src/lib/client/workout/outbox-rules.ts`   | `backOnline`, `nextDelay`                                               | `WaitEnds`                                                        |
| `src/lib/client/workout/outbox-rules.ts`   | `discard`, `dependantsOf`                                               | `Discard`, `Gone`                                                 |
| `src/lib/client/workout/outbox-rules.ts`   | `tryAgain`                                                              | `TryAgain`                                                        |
| `src/lib/client/workout/outbox-rules.ts`   | `replaceInPlace`                                                        | `Fix`                                                             |
| `src/lib/client/workout/sync.ts`           | `round`, `drain` under `SYNC_LOCK`, `post`                              | `StartRound`, `EndRound`, `lock`, `pc`                            |
| `src/lib/client/workout/sync.ts`           | `drain`'s `answered` case (halted or short answer ends the drain)       | `Receive`                                                         |
| `src/lib/client/workout/sync.ts`           | `drain`'s `failed` case, `REQUEST_TIMEOUT_MS`                           | `ReceiveFailed`, `Timeout`                                        |
| `src/lib/client/workout/sync.ts`           | `keepalive` (pagehide)                                                  | `Keepalive`                                                       |
| `src/lib/client/workout/sync.ts`           | `schedule`, `kick`, `flush`                                             | fairness on `StartRound`, `WaitEnds`                              |
| `src/lib/client/workout/reconcile.ts`      | none (left out)                                                         | none                                                              |
| `src/lib/server/services/workouts/sync.ts` | `applySyncBatch` (order, `held`, `waitsFor`, 'retry' and 503)           | `ServerStepAt`, `ServerErrorAt`, `ServerDiesAt`                   |
| `src/lib/server/services/workouts/sync.ts` | `applyOne` (claim first, then handler, in one transaction), `refusalOf` | `ServerStepAt` (`outcome`, `Missing`), `ServerErrorAt` (`landed`) |
| `src/lib/server/db/repositories/sync.ts`   | `claimMutation`                                                         | `ledger`                                                          |
| `src/lib/server/db/schema/sync.ts`         | `syncMutations` (unique `mutation_id`)                                  | `ledger`                                                          |
| `src/lib/domain/workout/mutations.ts`      | `dependsOn`                                                             | `Dep` (`MCDep` in `MC.tla`), `Creates`                            |

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
