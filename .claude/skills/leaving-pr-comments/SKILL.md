---
name: leaving-pr-comments
description: Use whenever leaving comments on GitHub.
metadata:
  source: https://github.com/t3dotgg/tstack/blob/main/skills/leaving-pr-comments/SKILL.md
---

# Leaving PR Comments

Prefix every agent-authored comment left on the user's behalf with the GitHub
note callout shown under Format.

## Which harness?

- Decide once per invocation. If any `mcp__t3-code__` tool is listed or loads
  with ToolSearch (`select:mcp__t3-code__orchestrator_capabilities`), you are
  in T3 Code: read [t3.md](t3.md) in this skill's directory and follow it.
- Otherwise (Claude Code in a terminal, Claude Desktop, or a claude.ai cloud
  session): read [claude.md](claude.md) and follow it.
- The rules in this file apply in both; the path file says which tools to use.

## Format

```md
> [!NOTE]
> 🤖 **<model> responding on behalf of <user>**

Actual comment starts here.
```

Use the verified public name of the model that wrote the comment, and the
user's name or GitHub login (where to find both: see your path file).

If the harness does not expose a model name, use the harness name. Do not guess.

Before posting, check the entire comment, including quoted text and
attachments, for secrets and private details.

Keep the attribution inside the note and the actual reply outside it. The
context line must start with the robot emoji. Do not add a horizontal rule,
Setext underline, heading, signature footer, or a second attribution. The one
exception is a footer the harness itself requires on every comment (see your
path file): keep it, after the reply.

Apply this format to top-level PR comments, inline review comments, replies to
bots or reviewers, and written explanations used before resolving or
dismissing feedback. Do not add it to PR descriptions, commit messages, or text
the user explicitly asked to post verbatim without attribution.

## Style

Write the comment itself in a direct style:

- Lead with the conclusion.
- Cite the relevant code, behavior, check, or reproduction.
- Keep it concise and avoid filler, canned thanks, or status narration.
- Distinguish verified facts from judgment.

## Posting

GitHub access: use whatever the session has (tools: see your path file). The
steps below say what to do, not which command to run. If nothing reaches
GitHub, stop and say so.

Preview the final Markdown before posting so quoting and blank lines render as
shown. After posting, verify that GitHub returned the comment or review URL.
Resolve a review thread only after its response was posted successfully.
