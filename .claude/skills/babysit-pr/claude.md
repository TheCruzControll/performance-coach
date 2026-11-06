# babysit-pr: Claude Code / Claude Desktop path

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
- **Cloud:** write to GitHub only through the GitHub MCP. `gh` works for REST
  reads and search through a proxy; GraphQL returns 403. The proxy also offers
  `GET repos/{o}/{r}/pulls/{n}/ccr/review_threads` (thread resolution state) and
  `POST repos/{o}/{r}/pulls/{n}/ccr/comments/{id}/resolve`.

Reading the PR with the GitHub MCP: `mcp__github__pull_request_read` with
`method` `get` (state, mergeable, head SHA), `get_check_runs`, `get_status`,
`get_reviews`, `get_review_comments` (threads with resolved state and node IDs),
`get_comments`, `get_files`, `get_commits`, `get_diff`.

## Waiting

### Local: `pr-wait` under Monitor

(Also the cloud fallback below.)

Wait with `scripts/pr-wait` from this skill's directory (use its absolute
path). It needs the `gh` CLI: your login on a local machine, or the
pre-installed `gh` that cloud sessions authenticate through their GitHub proxy.
It uses GraphQL when it can and switches to the REST API by itself when
GraphQL is blocked, as it is in cloud sessions.

```bash
pr-wait <pr> [--repo owner/name] [--until ready|green|any-change]
```

It prints one line per real event. It exits 0 when the `--until` condition is
met or the PR merges, 1 when it needs you (a required check failed, conflicts,
unresolved threads, PR closed), and 2 on bad input.

- `ready` (default): required checks green, Greptile or Macroscope reviewed the
  head, and no unresolved threads. Use this to babysit.
- `green`: required checks only. Use it when the repo has no Greptile or
  Macroscope.
- `any-change`: exit on the first event.

Run it with the `Monitor` tool, so each line wakes you. Always pass
`timeout_ms: 1800000`: the default is 5 minutes and 30 minutes is the maximum.
Without a monitor, run it in the background (Bash `run_in_background`,
`timeout: 7200000`; cloud sessions cap background commands at 30 minutes) and
wait for it to exit. Append `2>&1` so a crash message reaches you.

In REST mode (its summary says `threads unchecked`), `pr-wait` cannot see
whether review threads are resolved, so `ready` does not wait on them. Before
you call the PR ready, make sure every review comment has a reply or a fix.

Start it again after you push, after you handle an exit 1, after a resume, and
when the Monitor timeout ends while the PR is still open.
It remembers what it already reported, so nothing that arrived in between is
lost. If it says another pid already watches the PR, do not start a second one.
Kill the old one only if its events do not reach you.

### Cloud: `subscribe_pr_activity`

Call `mcp__claude-code-remote__subscribe_pr_activity` (`owner`, `repo`,
`pullNumber`) right after you handle the existing checks and comments, then end
your turn. GitHub comments, reviews and CI results arrive as events and wake
the session; follow the PR-handling rules the session's own system prompt
delivers with the `subscription.created` event. Never poll alongside it. If the
result says another Claude agent already watches the PR, that agent owns it:
do not start `pr-wait` as a second watcher. Tell the user which session watches
it and stop. Use `pr-wait` under Monitor (it works in cloud through REST) only
when `subscribe_pr_activity` is not listed.
Call `mcp__claude-code-remote__unsubscribe_pr_activity` when the PR merges or
closes, or the user asks to stop monitoring.

On each wake, check the gate yourself: required checks green
(`get_check_runs`), Greptile or Macroscope reviewed the head if the repo uses
them (`get_reviews`), no unresolved threads (`get_review_comments`, or the
`ccr/review_threads` proxy).

To re-check before a merge or after a known CI duration, use
`mcp__claude-code-remote__send_later` (one-shot reminder into this session), not
a sleep.

## Reading and fixing failures

A failed check: `mcp__github__get_check_run` (`checkRunId` from the event or
`get_check_runs`) for its output, and `mcp__github__get_job_logs` (`run_id`,
`failed_only: true`, `return_content: true`) for Actions logs. Locally,
`gh run view --log-failed` does the same.

## Replying and resolving

Write every comment with the `leaving-pr-comments` skill. Reply in a review
thread with `mcp__github__add_reply_to_pull_request_comment` (numeric
`commentId`); top-level PR comments with `mcp__github__add_issue_comment`.
Resolve a thread with `mcp__github__resolve_review_thread` (`threadId`: the
thread node ID from `get_review_comments`). In cloud sessions every GitHub
comment or review you post ends with the harness footer
`---\n_Generated by [Claude Code](https://claude.ai/code)_`; keep it.

## Base branch and merging

`pr-wait` reports when new base commits touch this PR's files, and when the PR
becomes BEHIND or DIRTY. With `subscribe_pr_activity`, read `mergeable` and the
base yourself (`pull_request_read` `get`, `mcp__github__list_commits` on the
base with `path`). Rebase locally and push; `mcp__github__update_pull_request_branch`
merges the base in server-side when a merge commit is acceptable.

Stop when `pr-wait` exits 0, or (cloud subscription) when the gate passes on
the latest head. If the user asked for a merge, merge with
`mcp__github__merge_pull_request` passing `expectedHeadSha` (locally `gh pr
merge` also works).

## Handing off

A cloud session is reclaimed after it sits idle, and its watcher goes with it.
When you hand off or stop and the PR is still open, tell the user they can turn
on auto-fix (the ⋮ menu next to the PR title in the session's Changes card).
GitHub then wakes Claude on new CI failures and review comments. You cannot
turn it on yourself.

Local: if `PushNotification` is listed and the user may have walked away, send
one line when the PR is ready or blocked on them.
