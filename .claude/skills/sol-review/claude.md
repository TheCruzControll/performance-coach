# sol-review: Claude Code / Claude Desktop path

Extends [SKILL.md](SKILL.md). Its rules still apply; this file says which tools
to use in Claude Code (terminal, Desktop local sessions, claude.ai cloud
sessions). Load deferred tools with ToolSearch `select:<name>` before the first
call.

Tell the two apart once: in a **cloud session (claude.ai/code)**
`mcp__claude-code-remote__subscribe_pr_activity` is listed; **local (terminal or
Desktop on your machine)** it is not.

## GitHub access

- **Local:** a logged-in `gh` is fine. The GitHub MCP (`mcp__github__*`) may or
  may not be connected; prefer what is there.
- **Cloud:** make GitHub API writes (PR edits) only through the GitHub MCP.
  `gh` works for REST reads and search through a proxy; GraphQL returns 403, so
  `gh pr view` fails there. Use `gh api` REST paths for reads if you need them.
  `git fetch` and `git push` work.

## Ledger

Keep the ledger as text: it goes into every brief. If the loop runs more than
one round, you may mirror it with `TaskCreate` (one task per finding id,
`subject` like `S1 should: <claim>`) and `TaskUpdate` (`status: "completed"`
when fixed, declined or resolved; outcome in `description`) so the user sees
it. Record usage only if the `Agent` result reports it.

## Scope: reading a PR

- Logged-in account: `mcp__github__get_me`, or locally `gh api user`.
- PR fields: `mcp__github__pull_request_read` with `method: "get"` (`owner`,
  `repo`, `pullNumber`). Map: base branch `base.ref` (`baseRefName`), head
  `head.sha` (`headRefOid`), author `user.login`, state (`merged: true`
  is MERGED), merge commit `merge_commit_sha`
  (`mergeCommit.oid`). Locally `gh pr view <n> --json
  baseRefName,headRefOid,author,state,mergeCommit` also works.
- CI results for the brief's `Checks:` when the code is not checked out:
  `pull_request_read` `method: "get_check_runs"` (or `get_status`); details of
  a failure with `mcp__github__get_check_run` (`checkRunId`) or
  `mcp__github__get_job_logs` (workflow `run_id`, `failed_only: true`,
  `return_content: true`).
- Fetch the PR head with `git fetch origin pull/<n>/head` as SKILL.md says.

When SKILL.md says stop and ask (unrelated changes that do not separate, empty
diff), or offers a choice (fix loop after review only, `/code-review` when no
reviewer runs, a stuck dispute), ask with `AskUserQuestion` if it is listed;
otherwise ask in plain text and end your turn.

## Start the reviewer

The reviewer is Claude Opus 5.5 (`claude-opus-5-5`). Start it with the `Agent`
tool:

- `model: "opus"`, `effort` as chosen in SKILL.md (the skill sets it
  explicitly), `subagent_type: "general-purpose"`, `run_in_background: false`.
- `description`: short, e.g. "sol-review round 1".
- `prompt`: the round 1 brief from SKILL.md, filled in. The subagent starts
  without this conversation, so include everything it needs.

Use another model only if the user names one (e.g. `fable` for Claude Fable
5.1, `sonnet` for Claude Sonnet 5.5). A reply is a non-empty final message with
a `VERDICT:` line; anything else is a failure. Record model `Claude Opus 5.5`
(or what ran) and the effort.

The `Agent` call returns when the reviewer finishes; that is the notice. A
foreground call has nothing to cancel: on failure, make a fresh `Agent` call
with the brief and the ledger.

## Next round

Use a fresh `Agent` call each round with the round 1 brief plus the ledger, the
same base diff, and the change since last round, as in SKILL.md section 4. Do
not continue the earlier reviewer.

## Ship: PR description

Push with `git push` (works locally and in cloud). Then edit the description:

- Read the current body: `mcp__github__pull_request_read` `method: "get"`, or
  locally `gh pr view <n> --json body`.
- Write it: `mcp__github__update_pull_request` (`owner`, `repo`, `pullNumber`,
  full new `body`), or locally `gh pr edit <n> --body-file <file>`. In cloud
  only the GitHub MCP writes.

If the harness gives its own attribution lines for PR descriptions (cloud
sessions do), keep them exactly and last: put the `Reviewed with sol-review`
line (above file-pr's `Created with ...` line) before them, and never remove
or contradict them.
