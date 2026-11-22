# 0014 — Coach memory and proposals: a snapshot from records, changes only as accepted proposals

- **Status:** Accepted (M5, 2026-11-11). Implemented and switched on in production by
  coach-launch (#449); docs/agent-architecture.md describes the code. Two details moved during
  M5: the snapshot takes at most 18 queries (9 for the profile, 9 for the records, which read the
  reviews' decisions too), and a segment's summary is made right after the answer that fills it
  when it can, so the next turn rolls over without a model call first.
- **Context:** Context must persist across conversations from structured data, not a replayed
  chat (PRD §4). An explicit "I dislike this exercise" must persist, while a machine being taken
  must not become a preference (PRD §4, §6). Recommendations and committed changes are separate,
  and nothing changes the program until the owner accepts it (PRD §14). Stored free text (notes,
  reasons, titles) can carry instructions, so it must reach the model only as data. M3's
  `coach_proposals` table and `programming_decisions` already exist.

## Decision

- **One snapshot, built from records.** `getCoachingMemory` builds a deterministic
  `MemorySnapshot` (`src/lib/domain/coach/memory.ts`) in at most 18 queries: profile sections
  (goals ranked, the program and week, the last 14 days planned against done, baselines measured
  or estimated, trends, preferences with their source and reason, equipment, injuries, movements
  to avoid) and record sections (pain reports from the last 28 days, recovery notes, decisions
  with their why, pending and recently decided proposals, reviews, other threads' summaries and
  workout analyses). Every item carries its `SourceRef`. It is serialised canonically, capped at
  6 KB by section priority, and every stored string is wrapped as `untrusted_text`.
- **Where it sits.** The snapshot opens each conversation segment as a user message labelled as
  data, never as a system message, and stays frozen for the segment. Each turn adds fresh facts
  after the owner's message: the current week (which overrides the snapshot's program section)
  and the ids and statuses of proposals decided since the last turn.
- **Segments, not edits.** A long thread is never edited. At the start of a turn, a segment
  becomes a `thread_summary` note when the last call's input reached 60K tokens, at 40 messages,
  or when the prompt version changed; the next segment opens with a new snapshot.
- **Every change is a proposal.** The agent changes programming, goals and workouts only by
  creating a `coach_proposals` row: kind, a versioned payload and its hash, title, summary,
  rationale, diff, impact and the program version it was based on. Postgres enforces that a row
  is inserted as `proposed`, its content never changes, its status only moves forward (proposed →
  accepted, rejected, applied or superseded; accepted → applied or superseded) and a decided row
  is frozen.
- **Accept by id.** Accept takes only the id, re-parses the stored payload, re-checks it against
  today and applies it through the services in one transaction: a new program version and a
  decision with the coach's rationale. A stale base becomes `superseded` (`program_changed`);
  'Ask for changes' supersedes it with a revision (`revised`); a rejection keeps an optional note
  that memory shows the coach as untrusted text.
- **Two direct writes only.** The coach may save its own workout analysis, and record an exercise
  preference when this turn's owner message holds an explicit statement about that exercise
  (source 'coach', with a decision note quoting the owner). A situational statement becomes a
  session-scoped substitution proposal, never a preference.

## Alternatives considered

| Option                           | Why not                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| Replaying chat history as memory | Costly, drifts from the records, and replays any injected instruction.                          |
| Embeddings and a vector store    | One owner whose data is already structured; retrieval would blur facts the coach must cite.     |
| Memory in the system prompt      | It would change the cached prefix every time a record changed, and give stored text authority.  |
| Auto-applying low-risk changes   | PRD §14: the owner commits every change.                                                        |
| Proposals the client sends back  | A payload could be altered between view and accept; accepting by id with stored content cannot. |

## Consequences

- What the coach knows is visible and editable through the normal Profile screens.
- A proposal can go stale; superseding it is explicit and recorded, never a silent rebase.
- New memory sections and proposal kinds are additive; the snapshot's cap decides what is cut,
  by priority, never at random.
