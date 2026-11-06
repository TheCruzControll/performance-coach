# `src/lib/client` — browser-only application code

Code in this folder runs only in the browser. It must never import from `src/lib/server`
(enforced by ESLint import boundaries).

## Today (M1)

| Module                   | Purpose                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `vitals.ts`              | Real-user monitoring: lazy-loads `web-vitals`, beacons to `/api/vitals`; attributes each metric to the screen where it happened |
| `preferences.svelte.ts`  | Per-device theme and unit preferences (localStorage)                                                                            |
| `connectivity.svelte.ts` | `online` state from `navigator.onLine` + events (a hint: failed requests are still handled, see `src/hooks.client.ts`)          |
| `leaving.ts`             | Is the page being left? Loads it cancels on the way out (WebKit reports each) are then not logged or reported as errors         |
| `profile-form.ts`        | Saves profile sections: validates with the services' zod schemas (loaded on idle, never initial JS), posts JSON to the action   |
| `section-form.svelte.ts` | One profile section's form state (value, field errors, busy, dirty); `submit()` validates, then saves through `profile-form.ts` |

## Planned (M4): offline-first workout store

Workout logging must never lose data and must never wait on the network (PRD §9, §15, §18).

- **IndexedDB** (via a ~1 KB wrapper such as `idb-keyval`, or raw IDB) holds the active
  workout: completed sets, current exercise, timer state, pending mutations.
- **Outbox pattern**: every user action becomes an idempotent mutation with a client-generated
  UUIDv7 (`mutationId`). The UI applies it optimistically, persists it to IndexedDB in the same
  task, then a sync loop POSTs pending mutations in order.
- **No duplicates**: the server stores `mutationId` with a unique constraint and treats replays
  as no-ops, so retries after a network drop are safe.
- **Sync triggers**: `online` event, `visibilitychange`, app start, and after each mutation;
  exponential backoff on failure. Background Sync is used where available (not on iOS).
- **Restore**: on load, the active workout is rebuilt from IndexedDB before any network call.
- The service worker caches the app shell (code, fonts, the `/offline` screen) so the workout
  screen opens offline. It never stores server-rendered HTML or `__data.json`: private data
  lives only in IndexedDB, where the app controls it and sign-out can erase it.
