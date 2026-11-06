# file-pr: Pi path

Extends [SKILL.md](SKILL.md); its rules still apply. This file says which tools
to use in the Pi coding agent.

## GitHub access

Use the `gh` CLI through `bash`. MCP exists in Pi only through extensions: use
a GitHub tool only if one is listed. If nothing reaches GitHub, stop and say
so.

## Existing PR and diff

- Existing PR: `gh pr list --head <branch> --state open`. If one exists, do not
  open a second one.
- Diff: `git fetch origin` then `git diff origin/main...HEAD` (and `--stat`).
- Title conventions: `git log --oneline origin/main` and
  `gh pr list --state merged`.

## Attribution

Harness name: `Pi`. Model: the model Pi reports (`/model`); do not guess. If it
is unavailable, name the harness only. Include models of subagent-tool runs
that wrote part of the change (the `model` in that agent's definition, else
the session's model).

## Opening the PR

Push the branch first (`git push -u origin <branch>`).

- `gh pr create --title ... --body-file ... --base <base>` (not `--draft`).
- Editing an existing PR: `gh pr edit`.
- Rate limit used up: check with `gh api rate_limit`. `gh pr create` uses
  GraphQL; the REST route is `gh api repos/{o}/{r}/pulls -f title=... -f
  head=... -f base=... -f body=...`.

Give the user the PR URL the command returns.

## After filing

- Babysitting: continue with the `babysit-pr` skill (its `pi.md` path).
- A needed comment: `leaving-pr-comments`, posted with `gh pr comment`.
