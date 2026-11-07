1. Branch policy: the brief says to commit on feat/m4-workout-app. M2 and M3 merge numbered slice PRs into main, and so does this plan (m4/NN-* into main, dark-launched until start-entry-points). Should M4 target an integration branch instead?

2. Security sign-off: /workout, /workout/run and /workout/session become public, prerendered, data-free pages, like /offline. Their data comes only from IndexedDB and owner-only endpoints, and their headers come from vercel.json. That is what lets a reload offline restore the workout without storing personal HTML. Is a public static shell acceptable, or must every page stay behind the guard, which would make an offline reload impossible?

3. Focus mode: the workout screen sits outside the tab bar and the rail, with Minimise back to Today and a resume bar on every tab. Confirm this, or should the navigation stay visible during a workout (+1.8 KB, and less thumb room)?

4. Dark launch: nothing links to the workout pages until the full loop is merged (substitutions, pain, finish and sign-out's flush included). Should the Today and Train entry points ship earlier for real-world feedback, accepting a partial workout screen in production?

5. 'I don't like this exercise' during a workout records the dislike and, through M3's never-again swap, replaces the exercise from today in the current program with the chosen alternative (one new version). A dislike synced after the plan changed applies to whatever version is current, and when its slot is gone it records only the preference and today's substitution. Is that right, or should it only stop future generated weeks from prescribing it?

6. Two devices editing the same set: the last mutation the server applies wins, and both edits are audited, rather than a stale edit being refused. Acceptable for a single owner?

7. Pain flow:
- area and severity are optional
- 'Stop this exercise' always comes first
- 'End the workout here' appears when the pain is severe, and opens the finish summary
- the copy links to Profile → Injuries, and points to a professional for sharp or lasting pain
The server-side gentler-option rules (domain/programming/rules/pain.ts) are a coaching judgement. Will the owner review them and the copy before kit-alternatives and pain-flow merge?

8. Default rest per exercise type, when a prescription has none: main lift 3:00, other compounds 2:00, isolation 1:30, timed 1:00. Confirm the values and the four types.

9. Sign-out with unsynced workout changes: the plan flushes first (5 s), then asks before deleting what remains. When the sign-in page is opened with ?signedOut=1 and no confirmation from this tab (a no-JavaScript sign-out, a stale link), it keeps unsynced changes and asks. Should sign-out instead be refused until everything has synced, or should that page delete everything regardless?

10. Units: logging uses the training profile's weight and distance units (the canonical preference since M2), and the plate calculator can switch locally. Should the device's unit preference win where they differ?

11. iOS limits: Safari has no Vibration API, the silent switch mutes the tone, and a web app cannot alert while the phone is locked (no local notifications without Web Push). The timer is correct when the app is reopened ('Rest over · 0:42 ago'). Is that acceptable, or is a push-based alert wanted later?

12. Storage eviction: Safari deletes script-written storage of a site not opened for 7 days, unless it is installed to the home screen. The plan asks for persistent storage and syncs eagerly. Should the app also prompt the owner to install it?

13. History lives at /progress/workouts, titled History, with a 'Workout history' row on Progress next to M6's analytics; on desktop the list sits beside the detail. Program history stays on Train (M3). Confirm the place and the name.

14. Per-exercise notes are not in M4; workout notes and pain notes are. Are they wanted?

15. 'Previous performance' means the last completed session of that exercise in any workout, planned or ad-hoc, not only the same planned slot; a substitute or an added exercise shows its own when the device is online. Confirm.

16. Editing a finished workout from History is not in the brief and not planned, although the sync path already supports it. A later milestone?

17. The sync ledger is never pruned in M4 (about 15k rows a year), so an outbox replayed months later is still recognised. Should rows older than 180 days be pruned in M9?

18. Rest defaults, sound, vibration, keep-awake, and the bar and plates are kept per device in localStorage, and sign-out keeps them, like theme and units. Should rest defaults follow the owner across devices through the profile instead (a migration)?

19. M3 amendments (decision 3), delivered now: A1–A2 to m3/19 before it starts (it is next in M3's schema chain), A3–A4 to m3/30 and m3/35, A6 to m3/39:
- set_records seconds, distance_m and assistance; nullable weight and reps with one coherence CHECK; missed_reps 0–50, independent of reps; run_records' totals nullable until set
- workout_substitutions' slot columns
- schemas and writes by measure and load type
- runs and other sessions by piece: addRunSegment, editRunSegment and editOtherSession by client id
- services in the caller's transaction, rows addressed by client id; startWorkout with a pinned planned_session_id
- swapExercise with a caller's transaction, the preference source and base 'current'
A5 is moot: m3/15 is built without it, so custom-exercise-sync adds it. If M3 declines any of the rest, the fallback slices log-gaps-db and log-gaps-service, and optional parameters in substitution-handlers, carry what is missing. Will M3 adopt them?

20. M2X: confirm or correct the provisional ids (decision 2). Specifically:
- M2X's desktop projects offer an opt-in that M4's specs use
- desktop variants of *.serial.e2e.ts are chained inside the serial chain (after serial-webkit, before perf)
- ADR 0011 is the email link's, and M4's ADR takes the next free number
- m2x-email-link-ui depends on icon-sprite (decision 4)
The migration order needs no answer: M2X's token migration and M4's are ordered by merge time, and the second to merge rebases.

21. A session lost elsewhere (a 401 after 'Sign out everywhere else', a revocation from Security, or expiry): the device deletes saved kits, canonical rows, the cached library and synced workouts, and keeps only unsynced changes and the unfinished workout's device state, until a sign-in. Acceptable, or should it delete the unsynced changes too?

22. Supersets: members alternate A1 → A2 with no rest inside a round and the round's rest after its last member, and Up next names the partner. Confirm, or should M4 show them as straight sets with A1/A2 labels only?

23. Load types: an assisted exercise logs its assistance in its own column and yields no e1RM, volume load or PR in M4. An unweighted bodyweight set yields only a 'most reps' PR. A weighted bodyweight set counts its added weight toward volume but has no e1RM, because body weight is not logged per set. Confirm.

24. One prerendered route per workout kind (/workout, /workout/run, /workout/session) costs about 60 B on every route, but keeps each kind's whole path budgeted on every build. The alternative, lazy views on one route, costs about 1.0 KB on the strength path. Confirm the routes.

25. Custom exercises from a workout use a short form: name, how it is measured and loaded, how long one bout lasts for a time-measured exercise, the pattern and main muscles prefilled from the exercise being replaced, and optional equipment. A name the owner retired is refused ('pick another name'), because restoring it would keep its old id. Should Profile → Exercises later offer to bring a retired exercise back? Aliases and a unilateral flag are left for Profile later. Confirm.

26. A change that keeps failing (a server error, a timeout or a missing target, never an offline device) is parked as 'Needs attention' after 50 counted failures or 24 hours, with Try again and Discard. Are those the right limits?
## From #98 (workout timers), defaults taken
- Default rest per exercise type when a prescription names none: main lift 3:00, other compounds 2:00, isolation 1:30, timed 1:00. These are the plan's defaults, kept in the named constant `DEFAULT_REST_SECONDS`. The 2:00 fallback is `FALLBACK_REST_SECONDS`. Changing a value is a one-line edit.


## Lighthouse gate artefact (found on #90, affects main too)
Chrome's FCP trace timestamp is truncated through seconds-as-double, so on some runner uptimes LCP lands 1 µs after FCP for the same frame; Lantern then takes its slow LCP path (~2.5 s simulated) instead of reusing the FCP graph. Main is equally exposed (re-audit median 2711 ms). Options: (a) patch scripts/lighthouse.ts to treat a same-frame LCP candidate within 1 µs of FCP as equal before Lantern, with a test; (b) leave as is and accept a rare red Lighthouse run when CI's apt step is slow. Needs the owner's call (it changes how the gate measures).

## From #102 (outbox rules), defaults taken
- Open question 26: a change that keeps failing (a 'retry' or 'deferred' answer, or a 5xx or timeout on a batch it heads; an offline device never counts) is parked as "Needs attention" after 50 counted failures or 24 hours since the first failure, not counting time offline. The default is `STUCK_AFTER = { failures: 50, ms: 24 h }` in `src/lib/client/workout/outbox-rules.ts`. Backoff is full jitter with `BACKOFF = { baseMs: 1000, maxMs: 60000 }`.

## From #103 (logging rules), defaults taken
- **Open question 23 (load types).** I used the plan's defaults, kept in `LOAD_RULES` in `src/lib/domain/workout/logging.ts`:
  - An assisted exercise logs its assistance in its own field and gets no e1RM, volume load or PR in M4.
  - An unweighted bodyweight set gets only a 'most reps' PR.
  - A weighted bodyweight set counts its added weight toward volume but gets no e1RM, because body weight is not logged per set.
  - Changing any of these is a one-line edit to the table.
- **Assistance is optional on an assisted exercise** (`LOAD_RULES.assisted.required = false`). A blank means it was not recorded, for example a band that has no number. A weight is required on external loads. Set `required: true` to make assistance compulsory; `checkSet` then refuses a blank at `payload.assistance`.

## From #110 (workout projection), defaults taken
- Open question 6, two devices editing the same set. Default kept: the last mutation the server applies wins. On this device its own pending edit shows on top of the server's rows until it is acknowledged, and an edit of a set deleted elsewhere changes nothing. The rule lives in `reducers/sets.ts` and in the replay order in `project.ts`, as the contract's ADR describes.

## From #112 (device settings), defaults taken
- **Default rest per exercise type** (open question 7): main lift 3:00, other compounds 2:00, isolation 1:30, timed 1:00. Set in `DEFAULT_REST_SECONDS` (domain timers, #98); the settings take their defaults from it.
- **Where settings live** (open question 17): per device in localStorage, and sign-out keeps them. Set in `WORKOUT_SETTINGS_KEY` and `PLATES_KEY`. Moving rest defaults to the profile later would need a migration.
- **iOS limits** (open question 10): iOS has no Vibration API, the silent switch mutes the tone, and nothing can alert on a locked phone. Feedback does nothing where an API is missing, and there is no push alert.
- **Units** (open question 9): one inventory per unit, so the calculator's local kg/lb switch works. Which unit it opens in is left to plates-from-set.
- **Feature defaults**: `DEFAULT_WORKOUT_SETTINGS` turns auto-start rest, sound, vibration and keep-awake all on. On an iPhone the tone and keep-awake are what alert. Bounds and feedback shapes are named constants: `REST_SETTING_LIMITS` (15 to 900 s), `PLATE_LIMITS`, `REST_OVER_TONE` (880 Hz, 180 ms, gain 0.25) and `REST_OVER_VIBRATION` ([200, 100, 200]).

## From #118 (set prefill), defaults taken
- **Q10 (units).** The caller passes the unit. It defaults to the training profile's weight unit (`kit.units.weight`). A load stored in the other unit is converted and rounded to 2.5 kg or 5 lb. A load already in the owner's unit is never re-rounded.
- **Q15 (previous performance).** The planned exercise reads the kit's previous session. A substitute or an added exercise reads only its own sets: today's first, then its attached sets, then the kit alternative's last top set.
- **Named defaults.**
  - `rpeInstruction` holds the blank-load wording.
  - The target RPE is preselected only when it is one of `RPE_CHIPS`.
  - A top set is the heaviest working set, or the one with least assistance.
  - Warm-ups match warm-ups when reading last session's sets.

- **Lighthouse TBT on `/` (#122):** one shared-runner sample put `/` at 316 ms TBT (budget 300) on code byte-identical to runs at 16–76 ms. Runner noise, not code. Your call: raise the CI run count, loosen TBT for CI, or accept a rare red run. No thresholds were changed.
