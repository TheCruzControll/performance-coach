# Ask the coach and accept a proposal

The owner asks the coach a question and gets an answer whose facts link to their sources. When the
coach suggests a change, it arrives as a proposal the owner accepts or rejects. Nothing changes a
program without that.

## Sub-features

- `ask` streams an answer with labelled facts, and a source opens that workout in History.
- `propose` shows a proposal card; Accept creates a new program version with the coach's why.
- `reject` records the reason, which the coach reads on the next turn.
- `memory` lists what the coach knows, each section edited through Profile.
- `dislike` said to the coach reaches Profile and, once accepted, removes the exercise next week.
- `pain` gets the safety block and never push-through wording.
- `unavailable` leaves set logging working when the coach cannot answer.
- `reload` keeps the conversation and its proposal.

## How to get to it (user POV)

- The Coach tab: type a question, or open an earlier conversation.
- A proposal card in the conversation, or the proposals inbox.
- "What the coach knows" from the Coach screen.

## Driving it with verify-coach

`verify run e2e/coach-journey.serial.e2e.ts`

The coach runs on the mock provider with scripted answers, so the run is deterministic and free.
Proof is the answer's facts matching the sets in Postgres, the new program version after Accept,
the stored rejection reason, and the absence of any banned phrase on the pain path.

## Gotchas

- The mock proves the app's handling of the coach's output, not the quality of a real model's
  answer. Real-model behaviour is covered by `pnpm test:live`, which spends money and is not part
  of a verification run.
- Serial: coach threads, proposals and the program are the one owner's.
