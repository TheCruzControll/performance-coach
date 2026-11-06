# 0010 — Program versioning: immutable versions with copy-on-write membership

- **Status:** Accepted (M3)
- **Context:** History is never overwritten (PRD §4–5). Every owner edit to planned programming
  (move, swap, adjust, skip) creates a new program version with a decision record saying what
  changed, why and who decided; older versions stay readable. The coach (M5) and adaptation (M6)
  reason over that history, and logging training (M4) must never create a version. One program
  holds a few hundred planned sessions, each with exercises and set prescriptions, and an edit
  usually touches one week.

## Decision

- **Tree.** `programs` → `program_versions` → blocks → weeks → `planned_sessions` (and, from
  later M3 slices, planned exercises, set prescriptions, run segments and other-session details).
  `src/lib/server/db/schema/programs.ts` defines the tables.
- **Copy-on-write at week granularity, with membership tables.** A version's tree is its rows in
  `program_version_blocks` and `program_version_weeks`. An edit creates version _n + 1_, copies
  only the affected week subtrees (new row ids, same `lineage_id`) and reuses every other
  membership row. A block that changes is copied with its weeks.
- **Lineage ids** identify a block, week or session across versions, so screens address
  sessions by lineage (`/train/session/<lineage>`, `?v=n` for an older version) and URLs survive
  edits.
- **One mutable pointer.** `programs.current_version_id` moves forward by compare-and-set inside
  the revising transaction (`SELECT … FOR UPDATE`), so a stale base is a conflict, never a lost
  update. One program per owner is active (a partial unique index).
- **Decisions.** `programming_decisions` records each choice: kind and rule key (open lists),
  summary, a non-empty why, `decided_by` (owner, coach or rules), the version it produced and the
  lineages it touched.
- **Status.** Planned, skipped and moved are stored on each version's session rows; skip and move
  are owner edits. 'Completed' is derived from logged workouts, so it carries across versions.
- **Profile references.** History rows refer to M2's mutable rows (goals, commitments) by uuid
  with no foreign key, as `training_goal_events` does, so no SET NULL or CASCADE can reach them.

## Immutability, enforced by Postgres

- A custom migration (`drizzle/*_program_history_guards.sql`) installs row triggers.
  `history_refuse_update()` refuses every UPDATE of a version, block, week, membership row,
  planned session or decision. `history_refuse_delete()` refuses every DELETE, always, with no
  session flag. `program_head_guard()` lets a program change only `status`, `archived_at` and a
  forward `current_version_id` to one of its own versions, and a new program starts with none.
  Each refusal is a `restrict_violation` (23001) naming its table and guard, never a value.
  Later M3 tables attach the same two functions.
- **TRUNCATE is the only bypass.** It fires no row triggers. Only test and reset code uses it:
  the integration suite's `withCommitted`, the e2e program reset and the explain database reset.
  There is no BEFORE TRUNCATE trigger, because `withCommitted` relies on it. There is no delete
  flag either. `scripts/history-guards.test.ts` fails if server code (`src/lib/server/**`, server
  route files, hooks) contains `truncate`, `session_replication_role` or `disable trigger`.
- Inserts are not guarded. The program store adds rows only under the version it is creating,
  in one transaction, and its integration tests prove that older versions read back unchanged.

## Alternatives considered

| Option                         | Why not                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Per-row validity ranges        | Every edit UPDATEs history rows to close their range, and every read needs range filters.  |
| Full deep copy per version     | Copies the whole program (thousands of rows) to move one session.                          |
| Mutable rows plus an audit log | The current plan is overwritten; reading an old version means replaying the log backwards. |
| Event sourcing                 | Every read folds events; the generator and the screens want a materialised tree.           |

## Consequences

- **Deleting the owner row is refused:** its ON DELETE CASCADE reaches `programs`, whose guard
  refuses it. `pnpm auth:reset-owner` keeps the owner row. Erasing training history is a
  deliberate maintenance step outside the app, not a code path.
- Never add an FK action (SET NULL, CASCADE) from a mutable table into a guarded one; refer to
  mutable rows by uuid with no foreign key.
- Every program table reaches `owners` through foreign keys (`programs.owner_id`, or a parent),
  so the test cleanup's `truncate owners … cascade` clears it.
- Guards live in custom migrations, never in generated files; after a rebase onto a newer
  migration the custom SQL is re-pasted (docs/development.md).
- Reads join through membership (indexed: `program_version_weeks_week_idx`,
  `planned_sessions_week_day_idx`, `planned_sessions_lineage_idx`). Storage grows only by the
  weeks an edit touches.
