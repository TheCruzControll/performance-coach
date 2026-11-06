# leaving-pr-comments: Pi path

Extends [SKILL.md](SKILL.md); its rules still apply. This file says which tools
to use in Pi.

## Header values

- `<model>`: the model Pi reports for this session (`/model`). Do not guess. If
  none is reported, use the harness name (Pi).
- `<user>`: the user's name if they gave it, else their GitHub login
  (`gh api user --jq .login`).

No harness footer: add nothing after the reply.

## GitHub access

MCP is available only through extensions: use `gh` with the `bash` tool unless
a GitHub tool is listed. If nothing reaches GitHub, stop and say so.

## Posting with `gh`

Write the body to a file first (`write` tool) so quoting and blank lines
survive the shell.

- Top-level PR comment: `gh pr comment <pr> --body-file <file>`.
- Reply in a review thread:
  `gh api repos/{o}/{r}/pulls/{n}/comments/{id}/replies -F body=@<file>`.

## Verifying and resolving

Confirm the URL GitHub returns (`html_url`, or the URL `gh pr comment` prints)
before going on. Then resolve the thread with `gh api graphql`
`resolveReviewThread` (the `PRRT_...` thread node ID). If a GitHub tool is
listed instead, use its comment, reply and resolve tools (check the tool's
schema).
