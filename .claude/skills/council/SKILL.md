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
or feedback, at high reasoning effort. If the user's instructions name council
members, use those. Otherwise the seats depend on the harness.

**T3 Code (multi-vendor):** one strong model from each of three different
providers: the latest flagship from each, for example Claude Opus, GPT Sol,
and Gemini Pro. Use `orchestrator_capabilities` to resolve the models, then
`delegate_task` to start one delegate per model in parallel. Gemini comes from
the `antigravity` provider. In Claude Code, T3 tools are deferred: load them
first with ToolSearch
`select:mcp__t3-code__orchestrator_capabilities,mcp__t3-code__delegate_task`.
If a vendor's flagship is not on the account (e.g. no Gemini Pro), seat that
vendor's strongest available model and use its real name in the results.
Providers are model vendors (Anthropic, OpenAI, Google), not T3 provider
instances; a second model from a vendor already seated does not count.

**Single-vendor harness (Claude Code without T3, Codex):** use only that
vendor's models. Never call another vendor's CLI. Seat three different models
from the family, and start all three in parallel with the harness's subagent
tool:

- Claude Code (terminal, Desktop, cloud): Claude Fable 5.1, Claude Opus 5.5,
  and Claude Sonnet 5.5 (Agent tool `model: "fable"`, `"opus"`, `"sonnet"`,
  `effort: "high"`). If one is not on the account, use Claude Haiku 5.5
  (`"haiku"`) in its place.
- Codex: the three highest-priority models in `codex debug models` with
  `visibility == "list"` that belong to different lines (for example
  GPT-6.1-Sol, GPT-6-Astra, GPT-6.1-Terra; not two versions of Sol). Resolve
  them from the list at run time; do not hardcode.

If you cannot seat three different models, or a named member is unavailable,
report it instead of substituting.

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

Name each delegate by the model that ran (in Claude Code without T3, for
example Claude Fable 5.1, Claude Opus 5.5, Claude Sonnet 5.5).

If a delegate gives no score, write `no score`. Do not invent one.
If the PR is open, edit the description. Do not post a comment for this.
If there is no PR, put the same results in the final reply only.

If you agree with their recommendations, make the changes and request a fresh
review after. Continue this process until all delegates are satisfied with the
outcome.

Do not let repeated reviews result in scope creep. It is your job to fight to
keep scope limited.
