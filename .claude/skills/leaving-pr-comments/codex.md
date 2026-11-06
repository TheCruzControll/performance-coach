# leaving-pr-comments: Codex CLI path

Extends [SKILL.md](SKILL.md); its rules still apply. This file says which tools
to use in the Codex CLI.

## Header values

- `<model>`: the model Codex reports for this session. Do not guess. If none
  is reported, use the harness name (Codex CLI).
- `<user>`: the user's name if they gave it, else their GitHub login
  (`gh api user --jq .login`).

No harness footer: add nothing after the reply.

## GitHub access

Use the `gh` CLI (if logged in) or a GitHub MCP server configured under
`[mcp_servers.<name>]` in `~/.codex/config.toml`, if the user has one. Prefer
what is there. If nothing reaches GitHub, stop and say so.

## Posting with `gh`

Run commands with `exec_command`. Write the body to a file first so quoting
and blank lines survive the shell.

- Top-level PR comment: `gh pr comment <pr> --body-file <file>`.
- Reply in a review thread:
  `gh api repos/{o}/{r}/pulls/{n}/comments/{id}/replies -F body=@<file>`.

With a GitHub MCP server instead, use its comment, reply and review tools
(check each tool's schema).

## Verifying and resolving

Confirm the URL GitHub returns (`html_url`, or the URL `gh pr comment` prints)
before going on. Then resolve the thread with `gh api graphql`
`resolveReviewThread` (the `PRRT_...` thread node ID), or the MCP server's
resolve tool.
