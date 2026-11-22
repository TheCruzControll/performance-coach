# Decisions

A short log of what was decided and why. The full reasoning for an architectural decision lives
in its ADR under [adr/](adr/README.md). This file is the index you read first, and the home for
decisions too small for an ADR.

## How to add one

Add a row at the top of the matching table: the date, the decision in one line, the reason in one
line, and a link to the ADR or plan if there is one. A decision that changes the architecture
also gets an ADR and a row in [adr/README.md](adr/README.md). When a decision is reversed, keep
the old row and add a new one that says what replaced it.

## Owner decisions

| Date       | Decision                                                                              | Why                                                                           | Source                         |
| ---------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------ |
| 2026-11-10 | Trace coach runs in the app's own tables and an in-app page                           | The data already sits in the agent tables; no Langfuse or OpenTelemetry       | `plan/trace-evals/README.md`   |
| 2026-11-10 | Eval cases come from a synthetic seeded owner plus owner-approved runs                | Promoted cases hold health data, so they stay in Postgres and never enter git | `plan/trace-evals/README.md`   |
| 2026-11-10 | Prompt edits arrive as PRs that must beat the current prompt; owner merges            | The optimizer never edits cases or graders                                    | `plan/trace-evals/README.md`   |
| 2026-11-10 | Grade answers with code checks first, then an LLM judge with a rubric                 | The judge is calibrated against the owner's thumbs ratings                    | `plan/trace-evals/README.md`   |
| 2026-11-10 | Run evals on PRs touching the prompt, tools or model, plus weekly, capped at $5 a run | Bounded spend                                                                 | `plan/trace-evals/README.md`   |
| 2026-11-07 | Drop the emailed sign-in link                                                         | Owner's call after setting the app up on their iPhone                         | [milestones.md](milestones.md) |
| 2026-11-06 | Add a desktop browser view of every screen, in CSS only                               | Owner request; a navigation rail and centred column from 1024 px              | [milestones.md](milestones.md) |

## Architecture decisions

Summaries only. Status is as recorded in [adr/README.md](adr/README.md).

| ADR                                          | Decision                                                          | Status   |
| -------------------------------------------- | ----------------------------------------------------------------- | -------- |
| [0001](adr/0001-single-sveltekit-app.md)     | One SvelteKit 3 app, TypeScript strict, pnpm                      | Accepted |
| [0002](adr/0002-vercel-hosting.md)           | Vercel on the Node runtime, Cloudflare DNS                        | Accepted |
| [0003](adr/0003-postgres-neon-drizzle.md)    | PostgreSQL on Neon, Drizzle, a node-postgres pool                 | Accepted |
| [0004](adr/0004-layered-modules.md)          | Layered modules with lint-enforced import boundaries              | Accepted |
| [0005](adr/0005-hand-built-design-system.md) | A hand-built design system on CSS custom properties               | Accepted |
| [0006](adr/0006-in-app-passkey-auth.md)      | In-app passkey authentication                                     | Accepted |
| [0007](adr/0007-observability.md)            | Built-in observability: Server-Timing, JSON logs, a RUM table     | Accepted |
| [0008](adr/0008-testing-strategy.md)         | Playwright e2e and integration tests on real Postgres             | Accepted |
| [0009](adr/0009-llm-provider-interface.md)   | The LLM behind a provider interface with a deterministic mock     | Accepted |
| [0010](adr/0010-program-versioning.md)       | Immutable program versions with copy-on-write membership          | Accepted |
| [0011](adr/0011-email-sign-in-link.md)       | One-time sign-in links to the owner's address                     | Accepted |
| [0012](adr/0012-offline-workout-sync.md)     | Offline workout sync: device inputs, one projection, a ledger     | Accepted |
| [0013](adr/0013-coach-agent-loop.md)         | A manual coach agent loop, streamed as labelled blocks            | Accepted |
| [0014](adr/0014-coach-memory-proposals.md)   | Coach memory from records; changes only as proposals              | Accepted |
| [NNNN](adr/NNNN-trend-classification.md)     | Trend vs noise: Theil–Sen, Mann–Kendall, a minimal change         | Proposed |
| [NNNN](adr/NNNN-encrypted-backups.md)        | App-level encrypted backups: a daily cron to a private Blob store | Proposed |
| [NNNN](adr/NNNN-hand-built-charts.md)        | Hand-built charts: lazy SVG lines, HTML marks, one registry       | Proposed |
| [NNNN](adr/NNNN-periodisation-engine.md)     | Periodisation: rules as data, one evaluator, one load model       | Proposed |
| [NNNN](adr/NNNN-planning-later-blocks.md)    | Planning later blocks: a new version, a bridge, no past days      | Proposed |
| [NNNN](adr/NNNN-lifecycles-as-data.md)       | Lifecycles as data: a typed transition table per status list      | Proposed |
