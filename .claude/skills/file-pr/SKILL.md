---
name: file-pr
description: File a concise pull request. Use when the user asks to file, open, or create a PR.
metadata:
  source: https://github.com/t3dotgg/tstack/blob/main/skills/file-pr/SKILL.md
---

# File PR

## Which harness?

- Decide once per invocation. If any `mcp__t3-code__` tool is listed or loads
  with ToolSearch (`select:mcp__t3-code__orchestrator_capabilities`), you are
  in T3 Code: read [t3.md](t3.md) in this skill's directory and follow it.
- Otherwise (Claude Code in a terminal, Claude Desktop, or a claude.ai cloud
  session): read [claude.md](claude.md) and follow it.
- The rules in this file apply in both; the path file says which tools to use.

## Steps

Before filing, check whether a PR for this branch already exists. Review the
diff locally against the base branch (usually `origin/main`) to make sure its
contents match the goal. (tools: see your path file)

PR titles usually become commit messages, so follow the repository's title
conventions. Look at recently merged PRs and Git history for examples. Prefer a
concise, human-readable title that explains why the change matters:

BAD

> ❌ perf(server): negotiate permessage-deflate on the websocket

GOOD

> ✅ perf(server): cut websocket frame size by 70%+ with gzipping

Open the description with a simple explanation of the problem based on the
user's original prompt, then briefly explain the solution. Do not lead with an
implementation inventory:

BAD

> ❌ Removed implicit workspace carry-over from every "new thread" entry point (cmd+n / cmd+shift+o, sidebar v1/v2 buttons, command palette). New threads inherit only the project from context; branch, worktree, and env mode always come from the configured defaults. Deleted buildContextualThreadOptions, startNewThreadInProjectFromContext, and the v1 sidebar's seed-context machinery.

GOOD

> ✅ My "new worktree" default was ignored when starting new threads on existing worktrees. Super unintuitive. Now your preferences always apply.

End the description with the public model name and harness that made the
changes, for example `Created with <model> in <harness>.` Include subagent
models that wrote part of the change. Use the model name the harness reports.
If model identity is unavailable, name the harness without guessing a model.
If the harness requires its own attribution lines at the end of PR
descriptions, keep them last and put this line before them.

Before submission, check the title, description, quotes, and attachments for
secrets and private details.

GitHub access: use whatever the session has, such as the `gh` CLI (if
logged in), a GitHub MCP server, or built-in GitHub tools (search ToolSearch
for `github`). The steps in this skill say what to do, not which command to
run (tools: see your path file). If nothing reaches GitHub, stop and say so.

Open a real PR rather than a draft so review bots run. If opening it fails
because a GitHub rate limit is used up, try another route the session has
(GitHub's REST API has its own limit, separate from GraphQL). If the user also
asked to babysit it, continue with the `babysit-pr` skill.

Do not post a follow-up PR comment unless it serves the user's request. When a
comment is needed, use the `leaving-pr-comments` skill.
