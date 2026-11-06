# babysit-pr: Pi path

Extends [SKILL.md](SKILL.md). Its rules still apply; this file says which tools
to use in the Pi coding agent. Pi tells you where this skill lives; resolve
`scripts/pr-wait` against that directory.

## GitHub access

Use the `gh` CLI through `bash`. MCP exists in Pi only through extensions: use
a GitHub tool only if one is listed.

## Waiting: `pr-wait` in the foreground

Pi has no background jobs: `bash` runs a command in the foreground until it
exits. Your one watcher per PR is `scripts/pr-wait` (use its absolute path). It
needs the `gh` CLI. It uses GraphQL when it can and switches to the REST API by
itself when GraphQL is blocked.

```bash
/abs/path/to/scripts/pr-wait <pr> [--repo owner/name] --until ready 2>&1
```

It prints one line per real event and blocks until an event ends it; you see
the output when it exits. It exits 0
when the `--until` condition is met or the PR merges, 1 when it needs you (a
required check failed, conflicts, unresolved threads, PR closed), and 2 on bad
input.

- `ready` (default): required checks green, Greptile or Macroscope reviewed the
  head, and no unresolved threads. Use this to babysit.
- `green`: required checks only. Use it when the repo has no Greptile or
  Macroscope.
- `any-change`: exit on the first event. Prefer it when you want to react to
  each event (a new comment or review) rather than only to exits.

Handle what it printed, then start it again. When an event needs no action,
start it again instead of ending your turn, and say nothing. Never post or say "still waiting". Never
write your own loop or `sleep` around it or `gh`.

If the `bash` tool takes a timeout (check the tool's schema), give it a long
one; if it times out while the PR is still open, start `pr-wait` again.

In REST mode (its summary says `threads unchecked`), `pr-wait` cannot see
whether review threads are resolved, so `ready` does not wait on them. Before
you call the PR ready, make sure every review comment has a reply or a fix.

Start it again after you push, after you handle an exit 1, and after a resume.
It remembers what it already reported, so nothing that arrived in between is
lost. If it says another pid already watches the PR, do not start a second one.
Kill the old one only if its events do not reach you. Only the thread that owns
the PR runs `pr-wait`: never start it from a subagent run.

## Reading and fixing failures

A failed check: `gh run view --log-failed` for Actions logs.

## Replying and resolving

Write every comment with the `leaving-pr-comments` skill. Reply in a review
thread, post top-level comments, and resolve threads with `gh` (`gh api`).

## Base branch and merging

`pr-wait` reports when new base commits touch this PR's files, and when the PR
becomes BEHIND or DIRTY. Rebase locally and push.

Stop when `pr-wait --until ready` (or `green`) exits 0; with `any-change`, exit
0 only means an event arrived: handle it and start again. If the user asked for
a merge, merge with `gh pr merge --match-head-commit <sha>`, pinned to the head
SHA you checked.

## Asking

When a decision is the user's (merge, closing an obsolete PR), ask in plain
text and stop.
