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
| `theme.ts`               | Applies the theme preference to the page (profile's picker, the preferences start); not in the unit-only screens' initial JS    |
| `design.ts`              | Per-device design: today's (default) or the Graphite 2004 preview; applied before first paint by `src/app.html`'s head script   |
| `connectivity.svelte.ts` | `online` state from `navigator.onLine` + events (a hint: failed requests are still handled, see `src/hooks.client.ts`)          |
| `service-worker.ts`      | Registers the service worker after `load` and hydration, in an idle period; imported on mount (SvelteKit's registration is off) |
| `leaving.ts`             | Is the page being left? Loads it cancels on the way out (WebKit reports each) are then not logged or reported as errors         |
| `profile-form.ts`        | Saves profile sections: validates with the services' zod schemas (loaded on idle, never initial JS), posts JSON to the action   |
| `section-form.svelte.ts` | One profile section's form state (value, field errors, busy, dirty); `submit()` validates, then saves through `profile-form.ts` |
| `screen-memory.ts`       | The last screen each tab showed (a DOM copy, one per tab), in memory only, so a revisit shows it at once                        |

## Workouts (M4)

Workout logging never loses a set and never waits on the network (PRD §9, §15, §18). The design
is the offline workout sync ADR (`docs/adr/`); the wire format is `src/lib/domain/workout/`.
Logic lives in plain `.ts`, because Vitest's unit project excludes `*.svelte.test.ts`.
`active.svelte.ts` and `status.svelte.ts` are thin `$state.raw` wrappers;
`device-workout.svelte.ts` is one small `$state` object that the resume bar writes.

Checked against the merged M4 code on 2026-11-10 (docs-m4), with sign-out's flush (#367), the
boot path (#394) and the prepaint (#410). Sign-out flushes first and asks before it deletes
`pc-offline` (`signout.ts`, `workout/shutdown.ts`).

| Module                             | What it holds                                                                                                                                                                | Slice                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `workout/names.ts`                 | `'pc-offline'` (the name M2's sign-out deletes), its version 1 and its store names, with no runtime imports, so the e2e helpers cannot drift                                 | workout-store                                  |
| `workout/db.ts`                    | `openDB` through idb with every store at version 1 (workouts, outbox, kits, library, meta); a database with missing stores is recreated; closed for good on versionchange    | workout-store                                  |
| `workout/store.ts`                 | `createStore({ table })`: `dispatch` with its follow-ups in one transaction, 'Not saved on this device' and `retry`, `acknowledge`, kits, `prune`, `onChange`                | workout-store; sync-engine; reconcile-and-tabs |
| `workout/probe.ts`                 | Raw IndexedDB reads for other screens (`activeSummary`, `pendingCount`, `savedKits`): never creates the database, reads a foreign one as empty                               | workout-store                                  |
| `workout/restore.ts`               | The workout pages' first-render read: the active workout's inputs with raw IndexedDB, never creating `pc-offline`; 'upgraded' for a newer database. The store loads after it | workout-shell                                  |
| `workout/prepaint.ts`              | `pc:workout-prepaint:v1`: the current exercise card as words, and the inline script that paints it before the app starts; dropped on every store change, deleted by sign-out | prepaint                                       |
| `workout/outbox-rules.ts`          | `nextBatch` (FIFO within the caps; a parked or waiting entry holds only its dependants), `applyResults`, the 'Needs attention' cap, Discard, Try again, Fix, `syncStatus`    | outbox-rules                                   |
| `workout/sync.ts`                  | `startSync`: one flusher per device under the Web Lock `pc-workout-sync`, 15 s aborts, the 48 KB keepalive send on pagehide, 401 and 403                                     | sync-engine                                    |
| `workout/online.ts`                | The store's write path and the page's one sync engine, one chunk loaded on idle; flushes on 'saved' and 'view'; `stop()`                                                     | workout-sync-wiring                            |
| `workout/status.svelte.ts`         | The reactive sync status for the screens                                                                                                                                     | sync-engine                                    |
| `workout/reconcile.ts`             | `createReconciler`: `reconcile(workoutId)` with a 10 s abort, a pending edit of a deleted set parked, the 404 rule; `adoptRemote(workoutId)`                                 | reconcile-and-tabs                             |
| `workout/channel.ts`               | BroadcastChannel `pc-workout`: changed, purged, closed and signed-out                                                                                                        | reconcile-and-tabs                             |
| `workout/settings.ts`              | `pc:workout:v1`, validated field by field: rest per class, auto-start rest, sound, vibration and keep-awake                                                                  | device-settings                                |
| `workout/feedback.ts`              | Vibration where it exists, else the iPhone's haptic (a hidden switch, in a tap), a short Web Audio tone unlocked by the first tap, the Screen Wake Lock; loaded on demand    | device-settings                                |
| `workout/kinds.ts`                 | Workout kind → route path: `/workout`, `/workout/run`, `/workout/session`                                                                                                    | workout-shell                                  |
| `workout/active.svelte.ts`         | The reactive active workout over the store, with the route's reducer table, and the store's `onChange` for the engine                                                        | workout-shell; workout-sync-wiring             |
| `workout/start.ts`                 | `startPlanned`, `startAdHoc` and `saveKits(lineages)`; loaded only for `?start` or `?new`                                                                                    | workout-start                                  |
| `workout/coming-kits.ts`           | `comingLineages`, `saveComingKits`: today's and the next two days' kits (Today and Train, the only other screens that may create `pc-offline`)                               | start-entry-points                             |
| `workout/kit-mark.ts`              | `pc:kit-refresh:v1` in sessionStorage: the workout the start flow began from a saved kit, so its page refreshes it                                                           | workout-start                                  |
| `workout/kit-refresh.ts`           | The saved kit's fresh copy, in the background: attached while the workout is untouched; replanned offers to start again                                                      | workout-start                                  |
| `workout/today-kits.ts`            | `savedToday`: the offline screen's list of today's saved sessions                                                                                                            | start-entry-points                             |
| `workout/library.ts`               | The exercise library, fetched with If-None-Match, cached and searched; a created exercise joins it at once, with the local name clash check                                  | add-exercise; custom-exercises-ui              |
| `workout/shutdown.ts`              | What sign-out loads lazily: `unsyncedAfterFlush()` (the flush bounded to 5 s, then what is left) and `keepOnlyUnsynced()` (a signed-out URL without sign-out's marker)       | signout-workout-data                           |
| `workout/previous.ts`              | The last session of an exercise the kit holds none for (5 s timeout), attached with `kit.attach` when its slot becomes current                                               | substitutions                                  |
| `workout/exercise-history.ts`      | An exercise's history for its sheet, a page at a time, with a 5 s timeout; offline, the session the device holds                                                             | exercise-history-sheet                         |
| `workout/device-workout.svelte.ts` | The workout in progress on this device as the resume bar last read it, for Today's and the session screen's Resume                                                           | resume-bar                                     |
| `workout/standalone-rest.ts`       | Train's rest timer under `pc:rest:v1`: the same timestamps as a workout's rest, no workout, kept by sign-out                                                                 | workout-settings                               |
| `plates.ts`                        | `pc:plates:v1`: one plate inventory per unit, defaulting to M1's `STANDARD_BARS` and `STANDARD_PLATES`                                                                       | device-settings                                |
