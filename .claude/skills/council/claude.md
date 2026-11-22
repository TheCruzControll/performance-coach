# council: Claude Code / Claude Desktop path

Extends [SKILL.md](SKILL.md); its rules still apply. This file says which
Claude Code tools to use. Load deferred tools with ToolSearch
`select:<name>` first.

## Seats (single vendor)

Claude Code (terminal, Desktop, cloud): the current Claude Fable, Claude Opus
and Claude Sonnet (`"fable"`, `"opus"`, `"sonnet"`). If one is not on the
account, use Claude Haiku (`"haiku"`) in its place.

When you cannot seat three different models or a named member, report it
with `AskUserQuestion` (if listed) so the user can decide; never substitute on
your own. Haiku in place of a missing seat (above) is the only standing
fallback.

## Start delegates

Send three `Agent` calls in one message so they run in parallel:

- `subagent_type: "general-purpose"`, `model: "fable"`, `"opus"`, `"sonnet"`
  (or `"haiku"`), `effort: "high"`.
- `description`: short, e.g. "Council review: Opus".
- `prompt`: the brief from SKILL.md (request, context, read-only, no
  sol-review/council skills, score out of 10 for code review). Include the
  diff or the branch/PR to read, since a subagent starts without this
  conversation.
- Delegates run in the background; you are notified when each finishes.

For a fresh round, continue each finished delegate with `SendMessage` (`to`
its agentId from the spawn result, or its name) with what changed, so it keeps
its earlier context. Start a new `Agent` only if continuing is not possible.

## Edit the PR description

Tell local from cloud: cloud if `mcp__claude-code-remote__subscribe_pr_activity`
is listed; local if it is not.

- Local (terminal or Desktop on your machine): `gh pr edit <n> --body-file
  <file>`, or `mcp__github__update_pull_request` (`body`) if the GitHub MCP is
  connected. Read the current body first (`gh pr view <n> --json body` or
  `mcp__github__pull_request_read` `method: "get"`).
- Cloud session (claude.ai/code): `gh` cannot write there; use
  `mcp__github__pull_request_read` `method: "get"` to read the body, then
  `mcp__github__update_pull_request` with the full new `body`.

The harness's attribution lines are the "model and harness line" at the end:
keep them last, put the `## Council review` section before them, and never
remove or contradict them.
