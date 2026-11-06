# sol-review: Pi path

Extends [SKILL.md](SKILL.md); its rules still apply. This file says which Pi
tools to use (read, bash, edit, write, plus grep/find/ls where enabled, and
the subagent extension's tool).

## GitHub access

Use `gh` with bash. Read PR fields with `gh pr view <n> --json
baseRefName,headRefOid,author,state,mergeCommit`; the logged-in account with
`gh api user`. Use a GitHub tool instead only if one is listed (MCP comes only
through extensions).

## Ledger and questions

Keep the ledger as text: it goes into every brief. Record usage only if the
subagent result reports it.

When SKILL.md says stop and ask, or offers a choice (fix loop after review
only, `/code-review` when no reviewer runs, a stuck dispute), ask in plain
text and end your turn.

## Start Sol

The reviewer is GPT Sol on Pi's OpenAI provider, run with the subagent tool
from the subagent extension (check its schema for the exact name and params).
That is Pi's own provider, not another vendor's CLI: never shell out to
another agent CLI.

Sol needs a subagent agent definition (markdown with frontmatter `name`,
`description`, `model`, `tools`) whose `model` is the latest GPT Sol (or the
version the user named). Without `model` the agent inherits the session's
model, so it is not Sol. Give it read-only tools: read, grep/find/ls, and bash
for git only.

If no such agent file exists, name the missing file and where it goes (user
or project agents dir; see the subagent extension's README) and ask the user
to add it. Do not edit their Pi config unasked, and do not substitute another
model.

Effort: Pi sets reasoning with `/thinking`; check the extension's README for
per-agent thinking. If you cannot set the effort SKILL.md picks, say so and
treat the effort as not verified. Record provider `openai`, the model in the
agent definition, and the effort.

Run it in single mode, `{agent, task}`. The `task` is the full round 1 brief
from SKILL.md: each subagent is a separate pi process without this
conversation.

The tool runs in the foreground and returns when the reviewer finishes; that
is the notice. A reply is a final message with a `VERDICT:` line; anything
else is a failure. There is nothing to cancel: on failure, make a fresh run
with the brief and the ledger.

## Next round

Make a fresh single run each round with the round 1 brief plus the ledger,
the same base diff, and the change since last round, as in SKILL.md section 4.

## Ship: PR description

Push with `git push`. Read the body with `gh pr view <n> --json body`; write
it with `gh pr edit <n> --body-file <file>`. Name the model as in the agent
definition.
