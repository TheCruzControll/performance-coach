# Build and change a program

The owner finishes onboarding, builds a week-1 program from Today, starts it, and then moves or
swaps sessions. Every change makes a new program version with its reason, and earlier versions
stay readable.

## Sub-features

- `onboard` sets goals, schedule, classes and 1RMs, which may be left blank.
- `build` previews a generated week 1 and starts it on a chosen Monday.
- `week` shows strength, running and Muay Thai on Train, with classes on their days.
- `baseline` prescribes RPE-based top sets when no 1RM is known, and a percentage with a load in kg
  when one is measured.
- `move` and `swap` change a session and create a new version with its why.
- `history` lists every version; older ones are read-only.
- `findings` puts a calm note, with its why, under each card still ahead that clashes with
  another session, and counts them in Train's header.

## How to get to it (user POV)

- First run: `/onboarding`, then Today, then Build my program.
- Later: Today's setup card, or Profile to edit any section.
- Train, open a session, then Move, Swap, Adjust or Skip.
- Train, then History, for the versions.

## Driving it with verify-coach

`verify run e2e/program-journey.serial.e2e.ts`

`verify run e2e/train-findings.serial.e2e.ts` for `findings`: the notes and the week line on a
seeded week, against the domain's own evaluation of the stored week.

The spec goes through the real onboarding screens and the real generator, with no fixture program.
Proof is Train's week matching the generator's rules, versions 2 and 3 in History with their
reasons, and every screen agreeing with Postgres after reloads.

## Gotchas

- Dates come from the server's today in the program's time zone, and the journey starts the
  program next Monday so every session is ahead on any weekday.
- Serial: the profile and the program are the one owner's.
