# NNNN — Re-plans as versions: four directives, three mechanisms, never the past

- **Status:** Proposed (M7). Extends [ADR 0010](0010-program-versioning.md) and the planning
  later blocks ADR ([NNNN](NNNN-planning-later-blocks.md)). Numbered at merge; M7's docs slice
  accepts it.
- **Context:** M7's goals change while a program runs: a reorder or a paused goal, a block the
  owner or coach picks, an event that needs its taper, fatigue that needs a deload now (PRD §2,
  §5). Rewriting the stored plan would lose what judged the weeks already trained (ADR 0010), and
  regenerating the whole program would move days the owner has already lived or logged.

## Decision

- **A directive, not a plan.** A re-plan is asked for as one of four directives
  (`domain/training/replan.ts`): `priorities`, `block` (a phase for 3 to 8 weeks), `taper` (full
  or mini) and `deload` (one Monday). An M5 proposal of kind `replan` stores only the directive,
  `from`, the base version, the fingerprint and the shape digest; the change is derived again at
  accept.
- **Three mechanisms** (`periodisation/replan.ts`, rules in `rules/replan.ts`):
  - _regenerate_ (priorities, block) from `from`, the next clean Monday: a block running across it
    is cut on the Sunday before, one starting on or after it is replaced, never cut to zero weeks.
    New priorities from the program's own start: `generateProgram` plans it all. Otherwise (a
    chosen block too, even from the start, since `generateProgram` cannot take a chosen phase) M6's
    `generateNextBlock` plans the new block (no bridge, every still-eligible exercise kept, none
    rotated) and the season outlines the rest.
  - _splice_ (taper): the taper weeks are `taperSessions` of the current weeks, in a taper block
    cut into the event-aligned one; every block after the event is kept.
  - _in place_ (deload): the week's sessions still ahead get `deloadSessions`' values and the week
    becomes a deload. Nothing else changes. A light week in it or the two after keeps M6's path.
- **One new version each**, validated whole with `programPlanSchema`, under M5's proposal
  lifecycle; version _N_ and every logged workout stay as they were. Event dates never move.
- **Two hashes.** The fingerprint covers today's profile input, the directive, the base version
  and `from`, never the actuals, so a logged set never makes a proposal stale. The shape digest
  covers phases, week kinds and dates and the sessions' days, types and titles, never loads.
- **Refusals in words:** `too_close`, `not_applicable`, `conflicts_with_event`,
  `too_many_blocks` (the plan budget) and `nothing_ahead`, each with its sentence.

## Alternatives considered

| Option                                  | Why not                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| Edit the stored weeks in place          | History rows are never updated (ADR 0010); the old version must still judge     |
| Regenerate the whole program every time | Moves the week in progress and sessions already logged                          |
| Store the new plan in the proposal      | Goes stale with every logged set; re-deriving at accept is cheap and exact      |
| Rotate exercises on a re-plan           | A change of priorities is no reason to relearn movements; the cycle review does |

## Consequences

- Each re-plan adds blocks to the version, so the plan budget (10 of the 12 blocks a plan holds)
  eventually asks the owner to start a new program.
- A block a re-plan cut short gets no cycle review of its own; the block replacing it is reviewed
  at its end (replan-store).
