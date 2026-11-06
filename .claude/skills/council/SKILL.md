---
name: council
description: Trigger this if the user says 'council'.
metadata:
  source: https://github.com/t3dotgg/tstack/blob/main/skills/council/SKILL.md
---

# Council

Before an audit, address outstanding PR comments, fix known issues, and run
relevant checks. Give council the updated implementation; do not defer known
fixes until reviews return. If the user wants to discard the implementation
and explore new ideas, skip fixes to code being replaced.

Bring in three delegates to help with the user's request, usually for review
or feedback. Use one strong model from each of three different providers, at
high reasoning effort. If the user's instructions name council members, use
those. Otherwise pick the latest flagship model from each provider, for
example Claude Opus, GPT Sol, and Gemini Pro.

In T3 Code, use `orchestrator_capabilities` to resolve the models, then
`delegate_task` to start one delegate per model in parallel. Gemini comes from
the `antigravity` provider in T3. In Claude Code, T3 tools are deferred: load
them first with ToolSearch
`select:mcp__t3-code__orchestrator_capabilities,mcp__t3-code__delegate_task`.

Without T3 (Claude Code Desktop, plain Claude Code), seat each vendor its own
way and start all three in the background at once:

- Claude: the harness's own subagent (Agent tool, Opus).
- GPT Sol: the `codex` CLI, read-only, exactly as the sol-review skill runs it
  (`codex exec -m <sol-id> -c model_reasoning_effort="high" -s read-only
  -C <repo> --ephemeral -o <scratch>/sol.md - < <scratch>/brief.md`).
- Gemini: the `gemini` CLI in read-only plan mode
  (`gemini --approval-mode plan -o json -p "" < <scratch>/brief.md >
  <scratch>/gemini.json`). Add `-m <model>` if the user named one. Read the
  model name from the JSON `stats`. It needs `GEMINI_API_KEY` set (Google's
  personal login no longer works with this CLI). In a folder Gemini does not
  trust, it drops plan mode, so the brief must also say not to edit files.

A missing or logged-out CLI means that vendor is unavailable. Cloud sessions
usually have neither CLI.

If a vendor's flagship is not on the account (e.g. no Gemini Pro), seat
that vendor's strongest available model and use its real name in the results.
Providers are model vendors (Anthropic, OpenAI, Google), not T3 provider
instances; a second model from a vendor already seated does not count. If you
cannot reach three providers, or a named member is unavailable, report it
instead of substituting.

Give each delegate the request and relevant context. For review or feedback,
keep their work read-only, and tell them to answer directly without using the
sol-review or council skills. Collect their responses and summarize the useful
findings, disagreements, and recommended next steps.

For a code review, ask each delegate for a score out of 10.
Count each full review pass as one round.
A fresh review after fixes starts a new round.

If the work ends in a pull request, put the results in the PR description.
Put this section before the model and harness line at the end:

```markdown
## Council review

Rounds: 2

| Delegate | Round 1 | Round 2 |
| --- | --- | --- |
| Claude Opus | 7/10 | 9/10 |
| GPT Sol | 8/10 | 10/10 |
| Gemini Pro | 7/10 | 9/10 |
```

If a delegate gives no score, write `no score`. Do not invent one.
If the PR is open, edit the description. Do not post a comment for this.
If there is no PR, put the same results in the final reply only.

If you agree with their recommendations, make the changes and request a fresh
review after. Continue this process until all delegates are satisfied with the
outcome.

Do not let repeated reviews result in scope creep. It is your job to fight to
keep scope limited.
