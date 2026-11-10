# Coach trace and self-improving evals

This folder holds everything needed to build the coach run trace, the coach evals, and the loop that improves them. Nothing here is built yet. The plan was written on `main` at `9719a3f5`.

## What the owner asked for

1. For each coach run, follow every step the agent took to answer: each model call, each tool call with its input and output, policy changes, and the final answer. Another platform was allowed, and the owner chose to keep it in the app.
2. Real evals that measure coaching quality, run many times per prompt version, not only the code-correctness tests that exist today.
3. Evals that improve themselves, run from inside the app.

## Files

- `plan.md` is the build plan. It is the checklist an owner runs box by box. It has eight PRs in order, each with files, build steps, unit checks, ten live verification lanes, a perf gate, a review gate, and merge steps. Its appendices hold prototype evidence, rejected alternatives, risks, and a reading list.
- `research/current-state.md` records what exists on `main` today for the agent, memory, tracing, and tests, with file pointers.
- `research/trace-surfaces.md` is an explorer's report on the code the trace PRs touch.
- `research/eval-surfaces.md` is an explorer's report on the code the eval PRs touch, including a dry run of the live suite.
- `research/design-rationale.md` records why the coach agent is built the way it is, from the ADRs and git history, with confidence labels.
- `research/coach-agent-explainer.html` is a visual explainer of the coach agent. Open it in a browser. The `.src.html` file next to it is its source for the visual-explainer renderer.

## Decisions the owner made

These came from the owner's answers while planning. Treat them as settled.

| Question                      | Decision                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How to trace runs             | Own tables and an in-app page. No Langfuse or OpenTelemetry. The data already sits in `agent_runs`, `agent_model_calls`, `agent_tool_calls`, and `coach_messages`.                                                                                                                                          |
| Where eval cases come from    | A synthetic seeded owner, plus real runs promoted into cases. Every promoted case needs the owner's approval. Promoted cases stay in Postgres, never in git, because they hold health data.                                                                                                                 |
| How far self-improvement goes | Grow the eval set from weak runs, and propose prompt edits as PRs that must beat the current prompt on the full set and on a hidden holdout. The owner merges. The optimizer never edits cases or graders. The owner asked that this run inside the app, which the `lab`, `mining`, and `optimizer` PRs do. |
| How answers are graded        | Code checks first (grounding, safety block, banned advice, proposals), then an LLM judge with a rubric. The judge is calibrated against the owner's thumbs ratings.                                                                                                                                         |
| Cadence and spend             | Run on every PR that touches the prompt, tools, or model, plus a weekly run. Cap each run at $5.                                                                                                                                                                                                            |

## Defaults the planner picked

The owner can change these before execution.

- Evals run on a temporary Neon branch created from production through the Neon API, so eval writes never touch the owner's data. The alternative was a second eval owner inside the production database.
- The app opens prompt PRs with a fine-grained `GITHUB_PR_TOKEN` limited to this repo. Without the token, the lab shows the diff to copy.
- The execution playbook is `autopilot-stack`. Owners build and verify. The owner lands the stack bottom-up.

## What the owner must provide

- `ANTHROPIC_API_KEY` as a GitHub repository secret before the `ci-evals` PR.
- `NEON_API_KEY`, scoped to this project, as a Vercel variable before the `lab` PR.
- `GITHUB_PR_TOKEN` as a Vercel variable before the `optimizer` PR.

## How to pick this up on another machine

1. Pull this branch, then `git fetch origin main` and check how far `main` has moved since `9719a3f5`. Re-check the file pointers in `research/` against the new `main` before building.
2. The plan cites skills under `~/dotfiles/packages/orchestrator/skills/`. Make sure the dotfiles repo is checked out at that path, or update the paths in `plan.md`.
3. Run `node ~/dotfiles/packages/orchestrator/skills/orchestrator/scripts/check-plan.mjs plan/trace-evals/plan.md`. It printed `8 PR sections, 0 problems` when the plan was written.
4. Start Postgres and run `pnpm db:setup`. Confirm the baseline with `LIVE_LLM_DRY=1 pnpm test:live`, which passed 7 tests and skipped 1 in 15.55 s at `9719a3f5`.
5. Tell the agent to execute `plan/trace-evals/plan.md` under the playbook it names, and give the explicit go.

## Open questions nobody has settled

- Whether live Opus 5.5 responses hold readable thinking text. Fixtures and the mock carry empty thinking with signatures.
- How well the judge agrees with the owner's ratings.
- How often recorded tool outputs match a new run's tool calls during replay.
- Whether Vercel crons every 5 minutes and Neon branch creation fit the project's plans and limits.
- Whether any tool reads pain reports older than 28 days.
