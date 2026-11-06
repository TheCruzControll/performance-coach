# sol-review: Codex CLI path

Extends [SKILL.md](SKILL.md); its rules still apply. This file says which
Codex tools to use. Subagent tools may be deferred behind tool search; load
them first.

## T3 check

Codex or another harness with a native Sol subagent and no ToolSearch: if T3
tools are not listed, try one direct capability call. If it works, you are in
T3 Code; otherwise use the native Sol subagent (section 2).
If it works, follow [t3.md](t3.md) instead of this file. Otherwise the native
Sol subagent is the one in Start Sol below.

## GitHub access

Use what is there: a logged-in `gh` CLI, or a GitHub MCP server the user
configured under `[mcp_servers.<name>]` in `~/.codex/config.toml`. Prefer what
is there. Read PR fields with `gh pr view <n> --json
baseRefName,headRefOid,author,state,mergeCommit`; the logged-in account with
`gh api user`.

## Ledger and questions

Keep the ledger as text: it goes into every brief. Record usage only if the
subagent result reports it.

When SKILL.md says stop and ask, or offers a choice (fix loop after review
only, `/code-review` when no reviewer runs, a stuck dispute), ask in plain
text and end your turn.

## Start Sol

Use the native Sol subagent at the chosen effort and keep its ID. Pick the
newest Sol it lists.

Resolve the model at run time; never hardcode it. `codex debug models` prints
JSON `{models: [{slug, display_name, visibility, priority,
supported_reasoning_levels, ...}]}`. Take the `visibility == "list"` slugs
ending in `-sol` and pick the lowest `priority` (lower is preferred), unless
the user named a version. If no Sol is listed, report it and stop.

Use whichever subagent tool set you have:

- v1: `spawn_agent` (`message`, `agent_type`, `fork_context`, `model`,
  `reasoning_effort`), then `wait_agent`; continue with `send_input`;
  `close_agent` when done.
- v2: `spawn_agent` (`task_name`, `message`, `agent_type`, `fork_turns`,
  `model`, `reasoning_effort`), then `wait_agent`; continue with
  `send_message` or `followup_task`; stop with `interrupt_agent`;
  `list_agents` shows what runs.

Spawn one agent: `model` = the Sol slug, `reasoning_effort` = the effort from
SKILL.md (it must be in that slug's `supported_reasoning_levels`; if not,
report it and stop), built-in `agent_type` `default`, no forked history
(`fork_context` false; omit `fork_turns`). The `message` is the full round 1
brief from SKILL.md. Save the agent id. Record provider `codex`, the slug and
the effort you passed.

`wait_agent` returning with the agent finished is the notice. Do not poll; if
it returns while the agent still runs, call `wait_agent` again. A reply is a final message
with a `VERDICT:` line; anything else is a failure. On failure, stop the agent
(`close_agent`, or `interrupt_agent` in v2), verify it stopped, then spawn a
fresh one with the brief and the ledger.

Prefer `spawn_agent` over shelling out. Only if the subagent tools are
disabled, run each round as a one-shot in the foreground (fresh run every
round, so send the brief plus the ledger each time):

```sh
codex exec -m <sol-slug> -c model_reasoning_effort="<effort>" -s read-only \
  -C <repo> --ephemeral -o <file> - < brief.md
```

Never call another vendor's CLI.

## Next round

Follow up the saved native ID: `send_input` (v1) or `followup_task` /
`send_message` (v2) to the same agent with the round 1 brief, the ledger, the
same base diff, and the change since last round, then `wait_agent`. If
continuing is not possible, spawn a fresh agent with the same content.
`close_agent` when the loop ends.

## Ship: PR description

Push with `git push`. Read the body with `gh pr view <n> --json body`; write
it with `gh pr edit <n> --body-file <file>` (or the configured GitHub MCP
server). Name the model by the slug you passed.
