# council: Codex CLI path

Extends [SKILL.md](SKILL.md); its rules still apply. This file says which
Codex tools to use. Subagent tools may be deferred behind tool search; load
them first.

## Seats (single vendor)

Seat the three highest-priority models in `codex debug models` with
`visibility == "list"` that belong to different lines (for example
GPT-6.1-Sol, GPT-6-Astra, GPT-6.1-Terra; not two versions of Sol). Resolve
them from the list at run time; do not hardcode. Start all three in parallel
with Codex's subagent tool.

`codex debug models` prints JSON `{models: [{slug, visibility, priority,
supported_reasoning_levels, ...}]}`; lower `priority` is preferred. Use the
`slug` as the model name.

When you cannot seat three different models or a named member, report it in
plain text and stop so the user can decide; never substitute on your own.

## Start delegates

Use whichever subagent tool set you have:

- v1: `spawn_agent` (`message`, `agent_type`, `model`, `reasoning_effort`),
  then `wait_agent`; continue with `send_input`; `close_agent` when done.
- v2: `spawn_agent` (`task_name`, `message`, `agent_type`, `model`,
  `reasoning_effort`), then `wait_agent`; continue with `send_message` or
  `followup_task`.

Make three `spawn_agent` calls (one per seat, `reasoning_effort: "high"`,
built-in `agent_type` `default`), then `wait_agent` for all three, so they
run in parallel. The `message` is the brief from SKILL.md (request, context,
read-only, no sol-review/council skills, score out of 10 for code review).
Include the diff or the branch/PR to read. Keep each agent's id.

`[agents] max_threads` caps concurrency.

For a fresh round, send what changed to each agent (`send_input`, or
`send_message`/`followup_task` in v2) so it keeps its earlier context. Spawn
a new agent only if continuing is not possible. When the loop ends, close
the agents with `close_agent` (v1).

Prefer `spawn_agent` over shelling out. Only if the subagent tools are
disabled, run each seat as a one-shot with `codex exec` (in the foreground,
one after another if you cannot run them together):

```sh
codex exec -m <slug> -c model_reasoning_effort="high" -s read-only \
  -C <repo> --ephemeral -o <file> - < brief.md
```

Never call another vendor's CLI.

## Edit the PR description

Use `gh` (read with `gh pr view <n> --json body`, write with `gh pr edit <n>
--body-file <file>`), or a GitHub MCP server from `~/.codex/config.toml` if
one is configured. Prefer what is there.

Keep the model and harness line last and put the `## Council review` section
before it; never remove or contradict it. Name each delegate by the model
you passed (its `display_name` from `codex debug models`).
