# Log offline and sync once

Sets the owner logs, edits or deletes with no connection are kept on the device, survive a reload,
and reach the server exactly once with their final values when the connection returns.

## Sub-features

- `offline-log` logs, edits and deletes sets with the network off.
- `reload` keeps every offline change across a page reload.
- `reconnect` syncs each change once, with its final values.
- `replay` creates no duplicate when the outbox or the API sends a change again.
- `two-tabs` shares every set between two tabs logging in turn.
- `recover` gets past a 500, an answer lost after the commit, and a refused change the owner
  discards.

## How to get to it (user POV)

- Start a workout, then lose the connection: airplane mode, or a tunnel.
- The sync pill and its sheet on the workout screen, which show waiting and parked changes and
  offer Try again and Discard.

## Driving it with verify-coach

`verify run e2e/journey-offline.serial.e2e.ts`

The spec takes the browser offline, logs through the real screens, and counts the rows in Postgres
after each phase. Proof is the exact row counts and values per workout, by client id, after
reconnect, after replay, and after each fault.

## Gotchas

- The offline reload step needs the service worker's precache, and Playwright emulates offline for
  service-worker traffic only in Chromium. The helper runs Chromium, so the step runs.
- This journey proves the orders someone wrote down. The promise across every order of steps is
  checked by the `verify-workout-sync` skill, a TLA+ model. A change to the sync engine, the
  outbox, or the server's sync ledger needs both.
