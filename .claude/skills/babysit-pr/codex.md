# babysit-pr: Codex CLI path

Extends [SKILL.md](SKILL.md). Its rules still apply; this file says which tools
to use in the Codex CLI. Some tools may be deferred behind tool search; load
them before the first call.

## GitHub access

A logged-in `gh` CLI, or a GitHub MCP server the user configured under
`[mcp_servers.<name>]` in `~/.codex/config.toml`. Prefer what is there.

## Waiting: `pr-wait` through `exec_command`

Your one watcher per PR is `scripts/pr-wait` from this skill's directory (use
its absolute path). It needs the `gh` CLI. It uses GraphQL when it can and
switches to the REST API by itself when GraphQL is blocked.

```bash
pr-wait <pr> [--repo owner/name] [--until ready|green|any-change] 2>&1
```

It prints one line per real event. It exits 0 when the `--until` condition is
met or the PR merges, 1 when it needs you (a required check failed, conflicts,
unresolved threads, PR closed), and 2 on bad input.

- `ready` (default): required checks green, Greptile or Macroscope reviewed the
  head, and no unresolved threads. Use this to babysit.
- `green`: required checks only. Use it when the repo has no Greptile or
  Macroscope.
- `any-change`: exit on the first event.

Nothing wakes you on output in Codex, so read the one watcher's output
yourself:

1. Start it with `exec_command` (`cmd`, `workdir` = the repo, a short
   `yield_time_ms`). While it runs, the result carries a `session_id`.
2. Poll that session with `write_stdin` with empty `chars` and a long
   `yield_time_ms` (it waits up to 300 s per call). Act on each event line as
   it arrives, and on its exit code when it exits.
3. When an event needs no action, poll again instead of ending your turn, and
   say nothing. Never post or say "still waiting".

This is not a hand-written polling loop: you read the single watcher's output.
Never wrap `pr-wait` or `gh` in your own loop or `sleep`.

In REST mode (its summary says `threads unchecked`), `pr-wait` cannot see
whether review threads are resolved, so `ready` does not wait on them. Before
you call the PR ready, make sure every review comment has a reply or a fix.

Start it again after you push, after you handle an exit 1, and after a resume.
It remembers what it already reported, so nothing that arrived in between is
lost. If it says another pid already watches the PR, do not start a second one.
Kill the old one only if its events do not reach you. Only the thread that owns
the PR runs `pr-wait`: never start it from a `spawn_agent` subagent.

## Reading and fixing failures

A failed check: `gh run view --log-failed` for Actions logs, or the GitHub MCP
server's check-run and job-log tools if it has them.

## Replying and resolving

Write every comment with the `leaving-pr-comments` skill. Reply in a review
thread, post top-level comments, and resolve threads with `gh` (`gh api`) or
the GitHub MCP server's tools.

## Base branch and merging

`pr-wait` reports when new base commits touch this PR's files, and when the PR
becomes BEHIND or DIRTY. Rebase locally and push.

Stop when `pr-wait` exits 0 (with `any-change`, exit 0 only means an event
arrived: handle it and start again). If the user asked for a merge, merge with
`gh pr merge --match-head-commit <sha>` (or the MCP server's merge tool),
pinned to the head SHA you checked.

## Asking

There is no question tool: when a decision is the user's (merge, closing an
obsolete PR), ask in plain text and stop.
