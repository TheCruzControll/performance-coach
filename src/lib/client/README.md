# `src/lib/client` — browser-only application code

Code in this folder runs only in the browser. It must never import from `src/lib/server`
(enforced by ESLint import boundaries).

## Today (M1)

| Module                   | Purpose                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `vitals.ts`              | Real-user monitoring: lazy-loads `web-vitals`, beacons to `/api/vitals`; attributes each metric to the screen where it happened |
| `visits.ts`              | The screens shown in this page, recorded by the root layout for `vitals.ts` (the only RUM code in initial JS)                   |
| `preferences.svelte.ts`  | Per-device theme and unit preferences (localStorage)                                                                            |
| `preferences-start.ts`   | The root layout's start for preferences, loaded after mount so only screens that show a unit have them in initial JS            |
| `connectivity.svelte.ts` | `online` state from `navigator.onLine` + events (a hint: failed requests are still handled, see `src/hooks.client.ts`)          |
| `leaving.ts`             | Is the page being left? Loads it cancels on the way out (WebKit reports each) are then not logged or reported as errors         |
| `profile-form.ts`        | Saves profile sections: validates with the services' zod schemas (loaded on idle, never initial JS), posts JSON to the action   |
| `section-form.svelte.ts` | One profile section's form state (value, field errors, busy, dirty); `submit()` validates, then saves through `profile-form.ts` |

## Workouts (M4)

Workout logging never loses a set and never waits on the network (PRD §9, §15, §18). The design
is the offline workout sync ADR (`docs/adr/`); the wire format is `src/lib/domain/workout/`.
Logic lives in plain `.ts`, because Vitest's unit project excludes `*.svelte.test.ts`; the two
`.svelte.ts` modules are thin `$state.raw` wrappers.

This table is written once, for every M4 client module. Later slices do not edit it; docs-m4
checks it against the merged code.

| Module                     | What it holds                                                                                                                                                             | Slice                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `workout/names.ts`         | `'pc-offline'` (the name M2's sign-out deletes), its version 1 and its store names, with no runtime imports, so the e2e helpers cannot drift                              | workout-store                                  |
| `workout/db.ts`            | `openDB` through idb with every store at version 1 (workouts, outbox, kits, library, meta); a database with missing stores is recreated; closed for good on versionchange | workout-store                                  |
| `workout/store.ts`         | `createStore({ table })`: `dispatch` with its follow-ups in one transaction, 'Not saved on this device' and `retry`, `acknowledge`, kits, `prune`, `onChange`             | workout-store; sync-engine; reconcile-and-tabs |
| `workout/probe.ts`         | Raw IndexedDB reads for the other screens, `activeSummary()` and `pendingCount()`: never creates the database, reads a foreign one as empty                               | workout-store                                  |
| `workout/outbox-rules.ts`  | `nextBatch` (FIFO within the caps; a parked or waiting entry holds only its dependants), `applyResults`, the 'Needs attention' cap, Discard, Try again, Fix, `syncStatus` | outbox-rules                                   |
| `workout/sync.ts`          | `startSync`: one flusher per device under the Web Lock `pc-workout-sync`, 15 s aborts, the 48 KB keepalive send on pagehide, 401 and 403                                  | sync-engine                                    |
| `workout/status.svelte.ts` | The reactive sync status for the screens                                                                                                                                  | sync-engine                                    |
| `workout/reconcile.ts`     | `reconcile(workoutId)` with a 10 s abort, a pending edit of a deleted set parked, the 404 rule; `adoptRemote(workoutId)`                                                  | reconcile-and-tabs                             |
| `workout/channel.ts`       | BroadcastChannel `pc-workout`: changed, purged, closed and signed-out                                                                                                     | reconcile-and-tabs                             |
| `workout/settings.ts`      | `pc:workout:v1`, validated field by field: rest per class, auto-start rest, sound, vibration and keep-awake                                                               | device-settings                                |
| `workout/feedback.ts`      | Vibration where it exists, a short Web Audio tone unlocked by the first tap, the Screen Wake Lock; loaded only by the screens that use it                                 | device-settings                                |
| `workout/kinds.ts`         | Workout kind → route path: `/workout`, `/workout/run`, `/workout/session`                                                                                                 | workout-shell                                  |
| `workout/active.svelte.ts` | The reactive active workout over the store, with the route's reducer table, and the store's `onChange` for the engine                                                     | workout-shell; workout-sync-wiring             |
| `workout/start.ts`         | `startPlanned`, `startAdHoc` and `saveKits(lineages)`; loaded only for `?start` or `?new`                                                                                 | workout-start                                  |
| `workout/library.ts`       | The exercise library, fetched with If-None-Match, cached and searched; a created exercise joins it at once, with the local name clash check                               | add-exercise; custom-exercises-ui              |
| `workout/shutdown.ts`      | What sign-out loads lazily: the pending check, the flush bounded to 5 s, and closing every tab's store before `pc-offline` is deleted                                     | signout-workout-data                           |
| `workout/previous.ts`      | The last session of an exercise the kit holds none for (5 s timeout), attached with `kit.attach` when its slot becomes current                                            | substitutions                                  |
| `plates.ts`                | `pc:plates:v1`: one plate inventory per unit, defaulting to M1's `STANDARD_BARS` and `STANDARD_PLATES`                                                                    | device-settings                                |
