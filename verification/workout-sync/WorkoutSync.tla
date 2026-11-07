---------------------------- MODULE WorkoutSync ----------------------------
(***************************************************************************)
(* The offline workout sync (docs/adr/0012-offline-workout-sync.md): a     *)
(* change logged on the phone reaches the server exactly once and in       *)
(* order. The steps are the code's own atomic steps: one IndexedDB         *)
(* transaction on the device, one Postgres transaction per mutation on the *)
(* server, and one HTTP request whose answer may never arrive. The         *)
(* coverage record in .pi/skills/verify-workout-sync/SKILL.md maps each    *)
(* action to the code.                                                     *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Tabs,         \* the pages with a sync engine on this device
    N,            \* mutations the owner logs, in outbox (seq) order 1..N
    Dep,          \* <<a, b>>: dependsOn(a, b), a must not apply before b
    Creates,      \* mutations that create a row others edit
    Invalid,      \* mutations logged with a payload the server rejects until Fix
    BatchCap,     \* BATCH_CAPS.flush.maxCount, scaled down
    MaxFaults,    \* timeouts, lost answers, dead requests and database errors
    MaxKeepalive, \* pagehide keepalive sends
    WebLocks,     \* navigator.locks exists: one flusher per device
    DiscardInFlight, \* FALSE leaves out finding F1 (see the skill): no Discard
                     \* of a change a request still running on the server carries
    MUTANT        \* "none", or the name of a broken variant (see the skill)

Muts == 1..N
NoTab == "none"
Empty == [in |-> FALSE, wait |-> FALSE, park |-> "none"]
Queued == [in |-> TRUE, wait |-> FALSE, park |-> "none"]

VARIABLES
    logged,    \* how many of 1..N the owner has logged
    box,       \* the IndexedDB outbox: per mutation, present, waiting, parked
    valid,     \* the mutations whose payload on the device the server accepts
    discarded, \* removed by the owner's Discard (with their dependants)
    ledger,    \* sync_mutations: ids committed as applied
    history,   \* every application of a mutation's effect, in commit order
    reqs,      \* POST /api/workouts/sync requests the server may still run
    pc,        \* each tab's engine: idle, posting, or draining under the lock
    lock,      \* the Web Lock 'pc-workout-sync': its holder, or NoTab
    faults,
    kas

vars == <<logged, box, valid, discarded, ledger, history, reqs, pc, lock, faults, kas>>

Range(s) == {s[j] : j \in 1..Len(s)}
Remove(s, k) == SubSeq(s, 1, k - 1) \o SubSeq(s, k + 1, Len(s))
Release(t) == IF lock = t THEN NoTab ELSE lock

(* outbox-rules.ts nextBatch: FIFO by seq, an entry parked or waiting is   *)
(* held, and so is every later entry that depends on a held one.          *)
RECURSIVE Scan(_, _, _)
Scan(k, held, acc) ==
    IF k > N \/ Len(acc) = BatchCap THEN acc
    ELSE IF ~box[k].in THEN Scan(k + 1, held, acc)
    ELSE IF box[k].park # "none" \/ box[k].wait \/ \E h \in held : <<k, h>> \in Dep
        THEN Scan(k + 1, IF MUTANT = "skipWaitingHead" THEN held ELSE held \cup {k}, acc)
        ELSE Scan(k + 1, held, Append(acc, k))
NextBatch == Scan(1, {}, <<>>)

Request(from, batch) ==
    [from |-> from, batch |-> batch, ok |-> valid \cap Range(batch), i |-> 1,
     res |-> <<>>, held |-> {}, st |-> "open"]

(* A request whose answer nobody awaits is gone once it ends. *)
Put(k, r) == reqs' = IF r.st # "open" /\ r.from = NoTab THEN Remove(reqs, k)
                     ELSE [reqs EXCEPT ![k] = r]

(* outbox-rules.ts fail, through countFailure or applyResults: a counted  *)
(* failure parks the entry as stuck at STUCK_AFTER, here at any failure.  *)
Stuck(e) == [e EXCEPT !.wait = FALSE, !.park = "stuck"]

-----------------------------------------------------------------------------
(* The owner and the device *)

(* store.ts dispatch -> write: the outbox entry is added in one transaction. *)
(* A change to a row whose create the owner discarded cannot be made: the  *)
(* projection no longer shows the row, so it counts as discarded. A change *)
(* after a discarded edit of the row is made and sent as usual.            *)
Log ==
    LET m == logged + 1 IN
    /\ logged < N
    /\ logged' = m
    /\ IF \E d \in discarded \cap Creates : <<m, d>> \in Dep
        THEN discarded' = discarded \cup {m} /\ box' = box
        ELSE box' = [box EXCEPT ![m] = Queued] /\ discarded' = discarded
    /\ UNCHANGED <<valid, ledger, history, reqs, pc, lock, faults, kas>>

(* A backoff wait (nextAt) passes, or 'online' ends every wait (backOnline). *)
WaitEnds(m) ==
    /\ box[m].wait
    /\ box' = [box EXCEPT ![m].wait = FALSE]
    /\ UNCHANGED <<logged, valid, discarded, ledger, history, reqs, pc, lock, faults, kas>>

(* outbox-rules.ts replaceInPlace: a refused change corrected under its id. *)
Fix(m) ==
    /\ box[m].in /\ box[m].park = "refused"
    /\ valid' = valid \cup {m}
    /\ box' = [box EXCEPT ![m] = Queued]
    /\ UNCHANGED <<logged, discarded, ledger, history, reqs, pc, lock, faults, kas>>

(* outbox-rules.ts tryAgain *)
TryAgain(m) ==
    /\ box[m].in /\ box[m].park = "stuck"
    /\ box' = [box EXCEPT ![m] = Queued]
    /\ UNCHANGED <<logged, valid, discarded, ledger, history, reqs, pc, lock, faults, kas>>

(* outbox-rules.ts discard and dependantsOf. Nothing calls it yet: the     *)
(* 'Needs attention' screen (ADR 0012) will.                              *)
RECURSIVE Gone(_, _)
Gone(k, g) ==
    IF k > N THEN g
    ELSE Gone(k + 1, IF box[k].in /\ \E x \in g : <<k, x>> \in Dep THEN g \cup {k} ELSE g)

Discard(m) ==
    /\ box[m].in /\ box[m].park # "none"
    /\ LET g == Gone(m + 1, {m}) IN
        /\ DiscardInFlight \/ \A k \in 1..Len(reqs) : reqs[k].st # "open" \/ g \cap Range(reqs[k].batch) = {}
        /\ box' = [x \in Muts |-> IF x \in g THEN Empty ELSE box[x]]
        /\ discarded' = discarded \cup g
    /\ UNCHANGED <<logged, valid, ledger, history, reqs, pc, lock, faults, kas>>

-----------------------------------------------------------------------------
(* The sync engine, client sync.ts *)

(* drain: under the lock, nextBatch(await read()) and post it. *)
StartRound(t) ==
    /\ \/ pc[t] = "idle" /\ (~WebLocks \/ lock = NoTab)
       \/ pc[t] = "draining"
    /\ NextBatch # <<>>
    /\ reqs' = Append(reqs, Request(t, NextBatch))
    /\ pc' = [pc EXCEPT ![t] = "posting"]
    /\ lock' = IF WebLocks THEN t ELSE lock
    /\ box' = IF MUTANT = "ackOnSend"
                THEN [m \in Muts |-> IF m \in Range(NextBatch) THEN Empty ELSE box[m]]
                ELSE box
    /\ UNCHANGED <<logged, valid, discarded, ledger, history, faults, kas>>

(* drain returns once nothing is sendable, and the lock is released. *)
EndRound(t) ==
    /\ pc[t] = "draining"
    /\ NextBatch = <<>>
    /\ pc' = [pc EXCEPT ![t] = "idle"]
    /\ lock' = Release(t)
    /\ UNCHANGED <<logged, box, valid, discarded, ledger, history, reqs, faults, kas>>

Status(r, m) ==
    LET js == {j \in 1..Len(r.res) : r.res[j][1] = m}
    IN IF js = {} THEN "none" ELSE r.res[CHOOSE j \in js : TRUE][2]

(* An answer: store.ts acknowledge applies every result in one IndexedDB    *)
(* transaction (applyResults); a 'retry' or a short answer ends the drain. *)
Receive(t) ==
    /\ pc[t] = "posting"
    /\ \E k \in 1..Len(reqs) :
        LET r == reqs[k]
            failing == {m \in Range(r.batch) : box[m].in /\ Status(r, m) \in {"deferred", "retry"}}
            halted == Len(r.res) < Len(r.batch) \/ \E j \in 1..Len(r.res) : r.res[j][2] = "retry"
        IN /\ r.from = t /\ r.st = "answered"
           /\ \E stuck \in SUBSET failing :
                box' = [m \in Muts |->
                          IF ~box[m].in \/ Status(r, m) = "none" THEN box[m]
                          ELSE IF Status(r, m) \in {"applied", "duplicate"} THEN Empty
                          ELSE IF Status(r, m) = "rejected" THEN [box[m] EXCEPT !.wait = FALSE, !.park = "refused"]
                          ELSE IF m \in stuck THEN Stuck(box[m])
                          ELSE [box[m] EXCEPT !.wait = TRUE]]
           /\ reqs' = Remove(reqs, k)
           /\ pc' = [pc EXCEPT ![t] = IF halted THEN "idle" ELSE "draining"]
           /\ lock' = IF halted THEN Release(t) ELSE lock
    /\ UNCHANGED <<logged, valid, discarded, ledger, history, faults, kas>>

(* store.ts countFailure on the batch's head; it never touches a parked entry. *)
CountFailure(r) ==
    LET h == r.batch[1] IN
    \/ box' = box
    \/ box[h].in /\ box[h].park = "none" /\ box' = [box EXCEPT ![h] = Stuck(box[h])]

(* A 5xx or 503 answer, or a request that died on the way. *)
ReceiveFailed(t) ==
    /\ pc[t] = "posting"
    /\ \E k \in 1..Len(reqs) :
        /\ reqs[k].from = t /\ reqs[k].st = "failed"
        /\ CountFailure(reqs[k])
        /\ reqs' = Remove(reqs, k)
    /\ pc' = [pc EXCEPT ![t] = "idle"]
    /\ lock' = Release(t)
    /\ UNCHANGED <<logged, valid, discarded, ledger, history, faults, kas>>

(* REQUEST_TIMEOUT_MS aborts the POST, or its answer is lost: counted as a  *)
(* failure and the lock released, while the server may still run it, or     *)
(* may already have committed it.                                            *)
Timeout(t) ==
    /\ faults < MaxFaults
    /\ pc[t] = "posting"
    /\ \E k \in 1..Len(reqs) :
        /\ reqs[k].from = t
        /\ CountFailure(reqs[k])
        /\ reqs' = IF reqs[k].st = "open" THEN [reqs EXCEPT ![k].from = NoTab]
                   ELSE Remove(reqs, k)
    /\ pc' = [pc EXCEPT ![t] = "idle"]
    /\ lock' = Release(t)
    /\ faults' = faults + 1
    /\ UNCHANGED <<logged, valid, discarded, ledger, history, kas>>

(* pagehide: fetch keepalive with nextBatch of the outbox; nobody reads the *)
(* answer. The engine sends its last-read outbox; a stale read is the same *)
(* as this send made earlier and delivered late, which the model allows.   *)
Keepalive ==
    /\ kas < MaxKeepalive
    /\ NextBatch # <<>>
    /\ reqs' = Append(reqs, Request(NoTab, NextBatch))
    /\ kas' = kas + 1
    /\ UNCHANGED <<logged, box, valid, discarded, ledger, history, pc, lock, faults>>

-----------------------------------------------------------------------------
(* The server, services/workouts/sync.ts applySyncBatch *)

Missing(m) == \E c \in Creates : <<m, c>> \in Dep /\ c \notin ledger

(* One mutation, one Postgres transaction (applyOne): claimMutation first,  *)
(* then the handler; a refusal rolls the claim back.                       *)
ServerStep(k) ==
    LET r == reqs[k]
        m == r.batch[r.i]
        blocked == MUTANT # "blockedApplied" /\ \E h \in r.held : <<m, h>> \in Dep
        claimLast == MUTANT = "claimAfterApply"
        outcome ==
            IF m \notin r.ok THEN "rejected"
            ELSE IF blocked THEN "deferred"
            ELSE IF claimLast /\ Missing(m) THEN "deferred"
            ELSE IF claimLast THEN IF m \in ledger THEN "duplicate" ELSE "applied"
            ELSE IF m \in ledger THEN "duplicate"
            ELSE IF Missing(m) THEN "deferred"
            ELSE "applied"
        effect == outcome = "applied" \/ (claimLast /\ outcome = "duplicate")
        last == r.i = Len(r.batch)
    IN /\ r.st = "open"
       /\ ledger' = IF outcome = "applied" THEN ledger \cup {m} ELSE ledger
       /\ history' = IF effect THEN Append(history, m) ELSE history
       /\ Put(k, [r EXCEPT !.i = r.i + 1,
                           !.res = Append(r.res, <<m, outcome>>),
                           !.held = IF outcome \in {"rejected", "deferred"} THEN r.held \cup {m} ELSE r.held,
                           !.st = IF last THEN "answered" ELSE "open"])
       /\ UNCHANGED <<logged, box, valid, discarded, pc, lock, faults, kas>>

(* Any other error in a mutation's transaction (only a valid, unblocked     *)
(* one opens one) rolls it back and stops the                              *)
(* batch: the rest answer 'retry', or the request fails (503) when nothing *)
(* was answered yet.                                                        *)
ServerError(k) ==
    LET r == reqs[k]
        m == r.batch[r.i]
        rest == [j \in 1..(Len(r.batch) - r.i + 1) |-> <<r.batch[r.i + j - 1], "retry">>]
        last == r.i = Len(r.batch)
        reaches == m \in r.ok /\ ~\E h \in r.held : <<m, h>> \in Dep
    IN /\ faults < MaxFaults
       /\ r.st = "open"
       /\ reaches
       /\ faults' = faults + 1
       /\ ledger' = IF MUTANT = "claimOwnTx" THEN ledger \cup {m} ELSE ledger
       /\ IF MUTANT = "retryContinues" /\ r.res # <<>>
            THEN Put(k, [r EXCEPT !.i = r.i + 1, !.res = Append(r.res, <<m, "retry">>),
                                  !.st = IF last THEN "answered" ELSE "open"])
          ELSE IF r.res = <<>> THEN Put(k, [r EXCEPT !.st = "failed"])
          ELSE Put(k, [r EXCEPT !.res = r.res \o rest, !.st = "answered"])
       /\ UNCHANGED <<logged, box, valid, discarded, history, pc, lock, kas>>

(* The function is killed mid-batch: what committed stays committed. *)
ServerDies(k) ==
    /\ faults < MaxFaults
    /\ reqs[k].st = "open"
    /\ faults' = faults + 1
    /\ Put(k, [reqs[k] EXCEPT !.st = "failed"])
    /\ UNCHANGED <<logged, box, valid, discarded, ledger, history, pc, lock, kas>>

(* A request nobody awaits is lost on the way. *)
Dropped(k) ==
    /\ reqs[k].st = "open" /\ reqs[k].from = NoTab
    /\ reqs' = Remove(reqs, k)
    /\ UNCHANGED <<logged, box, valid, discarded, ledger, history, pc, lock, faults, kas>>

-----------------------------------------------------------------------------

Synced == logged = N /\ \A m \in Muts : ~box[m].in /\ reqs = <<>>

Done == Synced /\ UNCHANGED vars

Init ==
    /\ logged = 0
    /\ box = [m \in Muts |-> Empty]
    /\ valid = Muts \ Invalid
    /\ discarded = {}
    /\ ledger = {}
    /\ history = <<>>
    /\ reqs = <<>>
    /\ pc = [t \in Tabs |-> "idle"]
    /\ lock = NoTab
    /\ faults = 0
    /\ kas = 0

Next ==
    \/ Log \/ Keepalive \/ Done
    \/ \E m \in Muts : WaitEnds(m) \/ Fix(m) \/ TryAgain(m) \/ Discard(m)
    \/ \E t \in Tabs : StartRound(t) \/ EndRound(t) \/ Receive(t) \/ ReceiveFailed(t) \/ Timeout(t)
    \/ \E k \in 1..Len(reqs) : ServerStep(k) \/ ServerError(k) \/ ServerDies(k) \/ Dropped(k)

Fairness ==
    /\ WF_vars(Log)
    /\ \A m \in Muts : WF_vars(WaitEnds(m)) /\ WF_vars(Fix(m)) /\ WF_vars(TryAgain(m))
    /\ \A t \in Tabs : WF_vars(StartRound(t)) /\ WF_vars(EndRound(t))
                       /\ WF_vars(Receive(t)) /\ WF_vars(ReceiveFailed(t))
    /\ WF_vars(\E k \in 1..Len(reqs) : ServerStep(k))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* The promise *)

TypeOK ==
    /\ logged \in 0..N
    /\ box \in [Muts -> [in : BOOLEAN, wait : BOOLEAN, park : {"none", "refused", "stuck"}]]
    /\ ledger \subseteq Muts /\ discarded \subseteq Muts
    /\ pc \in [Tabs -> {"idle", "posting", "draining"}]
    /\ lock \in Tabs \cup {NoTab}

(* No set is applied twice: each mutation's effect commits at most once. *)
AppliedAtMostOnce ==
    \A i, j \in 1..Len(history) : i < j => history[i] # history[j]

(* No change is applied before one it depends on: a row's edit never      *)
(* lands before the row's create, nor before an earlier edit of that row  *)
(* that is applied at all.                                                *)
AppliedInOrder ==
    \A j \in 1..Len(history) : \A d \in Dep : d[1] = history[j] =>
        /\ d[2] \in Creates => \E i \in 1..(j - 1) : history[i] = d[2]
        /\ \A i \in (j + 1)..Len(history) : history[i] # d[2]

(* No change is lost: until it is applied it stays in the outbox, unless  *)
(* the owner discarded it.                                                *)
NothingLost ==
    \A m \in 1..logged : m \in Range(history) \/ box[m].in \/ m \in discarded

(* Every change logged is eventually applied and leaves the outbox, or the *)
(* owner discarded it.                                                     *)
EventuallySynced ==
    \A m \in Muts : (m <= logged) ~> (m \in discarded \/ (m \in Range(history) /\ ~box[m].in))

=============================================================================
