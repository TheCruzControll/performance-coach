# file-pr: Codex CLI path

Extends [SKILL.md](SKILL.md); its rules still apply. This file says which tools
to use in the Codex CLI.

## GitHub access

Use the `gh` CLI (if logged in) through `exec_command`, or a GitHub MCP server
if the user configured one under `[mcp_servers.<name>]` in
`~/.codex/config.toml`. Prefer what is there. If neither reaches GitHub, stop
and say so.

## Existing PR and diff

- Existing PR: `gh pr list --head <branch> --state open` (or the GitHub MCP
  server's list-PRs tool). If one exists, do not open a second one.
- Diff: `git fetch origin` then `git diff origin/main...HEAD` (and `--stat`).
- Title conventions: `git log --oneline origin/main` and
  `gh pr list --state merged`.

## Attribution

Harness name: `Codex CLI`. Model: the model Codex reports for the session; do
not guess. If it is unavailable, name the harness only. Include models of
`spawn_agent` subagents that wrote part of the change (the `model` you passed).

## Opening the PR

Push the branch first (`git push -u origin <branch>`).

- `gh pr create --title ... --body-file ... --base <base>` (not `--draft`), or
  the GitHub MCP server's create-PR tool.
- Editing an existing PR: `gh pr edit`.
- Rate limit used up: check with `gh api rate_limit`. `gh pr create` uses
  GraphQL; the REST route is `gh api repos/{o}/{r}/pulls -f title=... -f
  head=... -f base=... -f body=...`.

Give the user the PR URL the command returns.

## After filing

- Babysitting: continue with the `babysit-pr` skill (its `codex.md` path).
- A needed comment: `leaving-pr-comments`, posted with `gh pr comment`.
