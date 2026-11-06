# council: Pi path

Extends [SKILL.md](SKILL.md); its rules still apply. This file says which Pi
tools to use.

## Seats (multi-vendor)

One strong model from each of three different providers: the latest flagship
from each, for example Claude Opus, GPT Sol, and Gemini Pro (Anthropic,
OpenAI, and Google providers, which the user has logged in). A second model
from a vendor already seated does not count. Seat other vendors only through
the subagent extension; never call another vendor's CLI.

Each seat needs a subagent agent definition (markdown with frontmatter `name`,
`description`, `model`, `tools`) whose `model` is that vendor's flagship.
Without `model` the agent inherits the session's model, so it cannot hold a
seat. Council agents should have read-only tools (read, grep/find/ls, and
bash for git and `gh` reads only).

If a needed agent file is missing, name it and where it goes (user or project
agents dir; see the subagent extension's README) and ask the user to add it.
Do not edit their Pi config unasked. If a member is unavailable, report it in
plain text and stop so the user can decide; do not substitute.

## Start delegates

Use the subagent tool from the subagent extension (check its schema for the
exact name and params) in parallel mode: `{tasks: [...]}` with one
`{agent, task}` per seat. The `task` is the brief from SKILL.md (request,
context, read-only, no sol-review/council skills, score out of 10 for code
review). Include the diff or the branch/PR to read, since each subagent is a
separate pi process without this conversation.

High reasoning effort: Pi sets the session's level with `/thinking`. For a
per-agent level, check the subagent tool's schema and the extension's README;
if it cannot be set, say so in the results.

For a fresh round, run the three again in parallel mode with the brief plus
what changed and each delegate's previous findings.

## Edit the PR description

Use `gh` with bash: read with `gh pr view <n> --json body`, write with
`gh pr edit <n> --body-file <file>`. Use a GitHub tool instead only if one is
listed.

Keep the model and harness line last and put the `## Council review` section
before it; never remove or contradict it. Name each delegate by the model in
its agent definition.
