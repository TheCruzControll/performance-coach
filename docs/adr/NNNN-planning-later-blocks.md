# NNNN — Planning later blocks: a new version, a bridge for a late start, no session before the first day

- **Status:** Proposed (M6). Extends [ADR 0010](0010-program-versioning.md). Numbered at merge,
  like a migration slot, so M6's slices refer to it by its title, "the planning later blocks
  ADR". docs-m6-architecture accepts it.
- **Context:** M3 plans a program's first block and dates the road after it as outline blocks
  with no sessions. M6's cycle review plans the next block from what the owner actually did
  (PRD §11), often days or weeks after the last block ended, and sometimes with no outline left.
  History is never overwritten (ADR 0010), the version that planned a block is what judges its
  weeks later (services/analytics/targets.ts), and the owner may choose to start on a Wednesday.

## Decision

- **A new version, as every edit is stored.** `planBlock` (`services/programs/next-block.ts`)
  writes version _N + 1_ under the program head's lock; a base that is no longer current is a
  `ProgramConflictError`, before anything is written. Version _N_, its weeks and every workout
  logged against them are untouched.
- **What it shares and what it writes.** The base's planned blocks are shared with their weeks
  (`program-replan.ts`'s `insertVersionSharing`). The outline block it plans comes back as a new
  planned row with the outline's lineage, so links and decisions keep naming it. Every outline
  block after it comes back as a new row with its lineage and new dates, without weeks. An
  outline block the dates leave out (an event build cut to no weeks) leaves the version. When no
  outline is left, the block is appended (`APPEND`) with a new lineage.
- **The bridge.** A start k ≥ 1 weeks after the reviewed block ended stores a planned
  'Between blocks' block before the new one: phase `transition`, k `unplanned` weeks, no
  sessions (`next-block/dates.ts` decides the dates; `planBlock` refuses a bridge with sessions).
  A workout logged in those weeks stays off-plan.
- **Validated as a whole.** The new version is rebuilt as one `ProgramPlan` (the base's planned
  blocks with their weeks, the bridge, the new block and the outline after it) and parsed with
  `programPlanSchema`, so a gap, an overlap or an outline before a planned block is refused with
  `checkPlan`'s message.
- **Never planned before the first day.** `programPlanSchema` checks sessions against the
  version's own first planned day, which is week 1 of the program. `planBlock` also refuses any
  new-block session dated before the chosen `firstPlannedDay`, naming the session and the day, so
  a 'this week' start on a Wednesday plans nothing on Monday or Tuesday.
- **The input stays with the block.** The version stores the generator (`next-block/1`), the
  fingerprint, the catalogue digest and the input snapshot. A week is judged by the input of the
  lowest-numbered generated version that plans its block, so the planning version judges the new
  block and earlier blocks keep theirs.
- **Decisions** name the new block as `blocks.0` (the generator's paths) and are stored as the
  new rows' lineages; a ref outside the new block is refused.

## Alternatives considered

| Option                                           | Why not                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Copy the outline block's row in place with weeks | History rows are never updated (ADR 0010); a new row with the same lineage is an insert     |
| Leave the lived-through weeks out of the program | A gap breaks contiguity, which every reader of a version relies on                          |
| Plan the bridge weeks with sessions in the past  | They were lived through; planning them now invents adherence that never had a chance        |
| A new program per block                          | Loses the version history, the lineages and the stored input that judges each earlier block |

## Consequences

- One transaction writes the new version with one multi-row insert per
  table, and reads the base once; the statement count never grows with the plan.
- Readers already handle a planned block with no sessions; bridge weeks need their own copy
  (bridge-week-states).
