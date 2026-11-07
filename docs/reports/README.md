# Reports

PRD §17 ends with two deliverables, written from the independent councils' results on the
running application:

| Report                                        | Council                      | What it answers                                                                                                  |
| --------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| [Performance Report](./performance-report.md) | Performance (five reviewers) | scores, measurements, optimisations, remaining bottlenecks, browser/device results                               |
| [Design Report](./design-report.md)           | Design (five reviewers)      | scores, screens and workflows evaluated, improvements, remaining usability issues, mobile and desktop assessment |

Both start as skeletons. The tech lead fills them from M8's council rounds and from the
measurements of the head that is released, before v1.0.0 is tagged. Nothing in a skeleton is a
result: every cell to fill reads `pending (Sn)`, or `pending` where the tech lead writes the text
(a date, a summary, a row to add), until a real value replaces it.

## Filling a report

- Keep every `##` heading and every reviewer row. `scripts/reports.test.ts` (part of
  `pnpm test:unit`) fails when a required section or a reviewer is missing, when a reviewer is
  added twice, or when a score cell is anything other than a 0–10 score, `pending (Sn)` or
  `not run`. A renamed council role is changed in that test's `REPORTS` constant and in the
  report's table, nowhere else.
- Copy each reviewer's own score, verdict and issues from that reviewer's output for the round.
  Never average scores, round them to look better or edit a reviewer's wording into agreement.
  Disagreements are investigated, and the investigation and its resolution go in the report
  (PRD §17).
- The councils' stopping criterion is private (PRD §17). A report states scores and evidence; it
  never states, implies or compares against a stopping bar.
- Lab numbers come from one head. Name its SHA once in the report's header, and mark any row
  measured on another head with that SHA.

## Cell markers

| Marker                     | Meaning                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pending (S3)`             | Not filled yet (the skeleton's default). `S3` is the row in the report's **Sources** table the value must come from. |
| `pending`                  | Not filled yet, and written by the tech lead rather than measured: a date, a summary, a row to add.                  |
| `55.5 KB (S1)`             | Filled. The value keeps its source key.                                                                              |
| `not measured (reason)`    | Looked for and not available, with the reason, e.g. `not measured (no desktop Lighthouse mode on this head)`.        |
| `not run (reason)`         | A council round that did not take place, e.g. `not run (stopped after round 2)`.                                     |
| `insufficient data (n=12)` | A RUM aggregate with fewer samples than the minimum its query states.                                                |

Never write an estimate, a target or a number from an earlier head in a cell as if it had been
measured. A target belongs in the column or row that says "target".

## Every number names its source

Each report ends with a **Sources** table. Every key used in a cell has a row there, and every
row names exactly one of:

- **a CI run**: the run URL, its head SHA and the job (for example "Build (Vercel + Node) &
  budgets" for `pnpm budgets`);
- **a Lighthouse file**: the `lighthouse-<run id>` artifact and the report file inside it
  (`lighthouse-reports/<name>.report.json`), with the number of runs the median is over;
- **a RUM query**: the query or the command that ran it, its window (start and end, UTC) and the
  sample count per row;
- **a screenshot path**: the artifact (`playwright-<run id>`) and the path inside it, under
  `test-results/screens/`;
- **a pull request** (`#NNN`), for an optimisation or an improvement;
- **the owner's own capture**, cited by date and SHA-256 only (see below).

CI artifacts expire after 14 days, so a report is filled from a run that is still available, and
its Sources table records the run URL even after the files are gone.

## Privacy: this repository is public

Everything committed here is readable by anyone, forever, in the history. A report therefore
holds only counts, aggregates (p75, medians, sample counts), durations, sizes, scores, digests,
versions, SHAs, timestamps and pass/fail.

- Screenshots come only from CI artifacts of seeded test data (the state gallery and the golden
  path journey) or from the emptied preview deployment. Production screenshots never go here.
- Production row content never goes here: no names, goals, notes, injuries, thread titles, coach
  text or workout entries, quoted or paraphrased.
- RUM is reported as aggregates per `route_id` only (`/(app)/train/session/[key]`, not a concrete
  path, which can carry a key), never as individual rows.
- The owner's own captures (on-device checks, anything from production) stay private. A report
  cites one as `owner capture, YYYY-MM-DD, sha256:<hex>`, never the file.
- A reviewer's words are quoted only where they describe seeded test data or the code.

A reviewer of a report PR checks this rule before anything else.
