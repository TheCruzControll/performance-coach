# Weekly review and next week

When a week's last session is logged, the owner is offered a review of it: planned against done,
the coach's write-up, and proposed changes for next week. The owner keeps, halves or leaves out
each change and generates the next week.

## Sub-features

- `prompt` offers the review on Today and Progress when the week completes.
- `review` shows planned against completed and adherence, with the coach's write-up.
- `choose` applies a change in full, at its half step, or not at all.
- `generate` creates next week as a new program version.
- `notice` lists every applied change and its why on Train, and links back to the review.
- `late` strikes through changes whose day has passed when the review is decided late.

## How to get to it (user POV)

- Today, after the week's last session is finished, then Create review.
- Progress, then the review entry.
- Train's notice on the new week, which leads back to the review.

## Driving it with verify-coach

`verify run e2e/journey-weekly-review.serial.e2e.ts`

The spec logs the week's last run through the real workout screens, then goes through the review
on screen only. Proof is the review's numbers matching the SQL oracle in `e2e/oracles/reviews.ts`,
next week's loads on Train, and versions 1 and 2 in History.

## Gotchas

- No request is held or faked in this journey, so the service worker stays on.
- The cycle review, at the end of a block, is a separate journey:
  `e2e/journey-cycle-review.serial.e2e.ts`.
