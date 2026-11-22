# Feature map

What the owner can do in the app, and the spec that proves each one. One file per feature. Each
file says what the feature is, how the owner reaches it, how to drive it, and what end state
proves it works.

Run any spec with `.claude/skills/verify-coach/scripts/verify run e2e/<spec>`.

| Feature | File | Spec |
| --- | --- | --- |
| Log a strength workout | [strength-workout.md](strength-workout.md) | `e2e/journey-strength.serial.e2e.ts` |
| Log offline and sync once | [offline-sync.md](offline-sync.md) | `e2e/journey-offline.serial.e2e.ts` |
| Build and change a program | [program.md](program.md) | `e2e/program-journey.serial.e2e.ts` |
| Ask the coach and accept a proposal | [coach.md](coach.md) | `e2e/coach-journey.serial.e2e.ts` |
| Weekly review and next week | [weekly-review.md](weekly-review.md) | `e2e/journey-weekly-review.serial.e2e.ts` |

Mapped by a spec but with no file here yet: runs and Muay Thai classes
(`e2e/journey-run-muay-thai.serial.e2e.ts`) and the cycle review
(`e2e/journey-cycle-review.serial.e2e.ts`). `e2e/journeys.ts` is the repo's own index of every
product journey and the test titles that prove it; a feature added here should be added there too.

When a change adds a feature or a new way into one, add or update its file and its spec in the same
pull request. A feature with no file here has no agreed proof.
