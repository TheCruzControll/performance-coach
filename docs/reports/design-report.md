# Design Report

PRD §17's Design Report: the design council's scores, the screens and workflows it evaluated,
the improvements made, the usability issues that remain, and the mobile and desktop
assessments. How to fill it, the cell markers and the privacy rule: [README](./README.md).

| Field                | Value        |
| -------------------- | ------------ |
| Head (SHA)           | pending (S1) |
| App version          | pending (S1) |
| Council rounds run   | pending (S2) |
| Last round (date)    | pending (S2) |
| Report filled (date) | pending      |

## Verdict

pending (S2): two or three paragraphs. The council's final scores in one sentence each, how the
product holds together across onboarding, the workout, analytics and coaching, the
disagreements between reviewers and how each was resolved, and the most important usability
issue that remains.

## Method

pending (S2): what was evaluated and how.

- The build evaluated (production build, seeded fake athlete, both themes, iPhone 393 × 659 and
  desktop 1440 × 900) and the head SHA.
- What each reviewer received (the screenshots and their index, the measurements) and that they
  worked blind and independently, then could open the running app themselves.
- The loop per round: capture → evaluate → collect → prioritise by impact → implement → test →
  capture → re-evaluate.

## Scores by reviewer and round

Each reviewer's own 0–10 score per round (S2), never averaged. "Final" is the score in the last
round run. "Evidence" names the screenshots or recordings the reviewer relied on.

| Reviewer                  | Round 1      | Round 2      | Round 3      | Round 4      | Final        | Evidence     |
| ------------------------- | ------------ | ------------ | ------------ | ------------ | ------------ | ------------ |
| Senior Product Designer   | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) |
| Visual Design Specialist  | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) |
| Mobile UX Specialist      | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) |
| Interaction Designer      | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) |
| Independent Design Critic | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) | pending (S2) |

Per reviewer, below the table: the verdict of the last round and the issues still open, each with
its severity and evidence (S2).

## Screens and workflows evaluated

Every screen with the states the council saw, linked to its screenshots: the state gallery's
folder for states (S3) and the golden path journey's folder for the workflow (S4). Add a row per
screen of the reported head.

| Screen or workflow                  | States seen (default, empty, loading, error, offline, sheets) | Themes       | iPhone       | Desktop      |
| ----------------------------------- | ------------------------------------------------------------- | ------------ | ------------ | ------------ |
| Sign-in, setup and recovery         | pending (S3)                                                  | pending (S3) | pending (S3) | pending (S3) |
| Onboarding                          | pending (S3)                                                  | pending (S3) | pending (S3) | pending (S3) |
| Today                               | pending (S3)                                                  | pending (S3) | pending (S3) | pending (S3) |
| Train week, plan and session detail | pending (S3)                                                  | pending (S3) | pending (S3) | pending (S3) |
| Active workout                      | pending (S3)                                                  | pending (S3) | pending (S3) | pending (S3) |
| History and exercise history        | pending (S3)                                                  | pending (S3) | pending (S3) | pending (S3) |
| Progress and analytics              | pending (S3)                                                  | pending (S3) | pending (S3) | pending (S3) |
| Weekly and cycle reviews            | pending (S3)                                                  | pending (S3) | pending (S3) | pending (S3) |
| Coach thread and proposals          | pending (S3)                                                  | pending (S3) | pending (S3) | pending (S3) |
| Profile, sections and security      | pending (S3)                                                  | pending (S3) | pending (S3) | pending (S3) |
| Golden path, fresh profile to coach | pending (S4)                                                  | pending (S4) | pending (S4) | pending (S4) |

## Improvements

What changed because of the council, highest impact first (S5).

| Improvement | Raised by    | Screens      | PR           |
| ----------- | ------------ | ------------ | ------------ |
| pending     | pending (S2) | pending (S3) | pending (S5) |

## Remaining usability issues

By severity (critical, major, moderate, minor), each with its evidence and whether it is
accepted or planned.

| Issue   | Severity     | Screens      | Evidence     | Accepted or planned |
| ------- | ------------ | ------------ | ------------ | ------------------- |
| pending | pending (S2) | pending (S3) | pending (S2) | pending             |

## Mobile assessment

The workout-specific questions of PRD §16, on the iPhone viewport and on the owner's iPhone.

| Question                                  | Assessment   | Evidence     |
| ----------------------------------------- | ------------ | ------------ |
| Next exercise understood at a glance      | pending (S2) | pending (S4) |
| One-handed set logging                    | pending (S2) | pending (S4) |
| Rest timer visibility                     | pending (S2) | pending (S4) |
| Previous performance                      | pending (S2) | pending (S4) |
| Substitution speed                        | pending (S2) | pending (S4) |
| Interrupted workout                       | pending (S2) | pending (S4) |
| Information density: workout vs analytics | pending (S2) | pending (S3) |

Below the table: what the owner's real-device check found (S7), cited by date and SHA-256.

## Desktop assessment

pending (S2): the screens at 1440 × 900 against `docs/design-system.md` (Responsive layout): the
navigation rail, content centred at a readable width, no stretched phone layout, hover and
keyboard focus states, and the desktop specs' results (S6).

## Accessibility

| Check                                                          | Result       |
| -------------------------------------------------------------- | ------------ |
| axe (WCAG 2.1 A/AA) on every screen and state, both themes     | pending (S6) |
| The same on desktop, both engines                              | pending (S6) |
| Keyboard: every control reachable, visible focus ring          | pending (S6) |
| Touch targets ≥ 44 × 44 px                                     | pending (S6) |
| Reduced motion respected                                       | pending (S6) |
| VoiceOver spot check on Today and the workout (owner's iPhone) | pending (S7) |

## Sign-off

| Who           | Date    | Head         | Note    |
| ------------- | ------- | ------------ | ------- |
| The tech lead | pending | pending (S1) | pending |
| The owner     | pending | pending (S1) | pending |

## Sources

Every `Sn` above, filled with the exact run, file or path (see the README).

| Key | What                                                                        | Where (fill in)                                                                        |
| --- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| S1  | The reported head and its version (`/api/health`)                           | pending: head SHA, version                                                             |
| S2  | The design council's outputs per reviewer and round: score, verdict, issues | pending: council run label, round numbers and dates                                    |
| S3  | The state gallery's screenshots, seeded test data                           | pending: `playwright-<run id>` artifact, `test-results/screens/states/<project>/`      |
| S4  | The golden path journey's screenshots, seeded test data                     | pending: `playwright-<run id>` artifact, `test-results/screens/golden-path/<project>/` |
| S5  | Pull requests that made each improvement                                    | pending: `#NNN` per row                                                                |
| S6  | The CI accessibility and desktop specs                                      | pending: run URL, specs and their results                                              |
| S7  | The owner's real-device check                                               | pending: date, device, iOS version; captures by SHA-256                                |
