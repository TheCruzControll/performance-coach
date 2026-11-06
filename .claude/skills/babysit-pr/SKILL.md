---
name: babysit-pr
description: Monitor a pull request through review and CI. Use when the user asks to monitor, watch, or babysit a PR.
metadata:
  source: https://github.com/t3dotgg/tstack/blob/main/skills/babysit-pr/SKILL.md
---

# Babysit PR

Many repos have AI review bots. They're helpful, even if they are not always
right.

## Which harness?

- Decide once per invocation. If any `mcp__t3-code__` tool is listed or loads
  with ToolSearch (`select:mcp__t3-code__orchestrator_capabilities`), you are
  in T3 Code: read [t3.md](t3.md) in this skill's directory and follow it.
- Otherwise (Claude Code in a terminal, Claude Desktop, or a claude.ai cloud
  session): read [claude.md](claude.md) and follow it.
- The rules in this file apply in both; the path file says which tools to use.

## Waiting

GitHub access: use whatever the session has, such as the `gh` CLI (if
logged in), a GitHub MCP server, or built-in GitHub tools (search ToolSearch
for `github`). The steps in this skill say what to do, not which command to run. If
nothing reaches GitHub, report that and stop.

Never write your own watcher, polling loop, or `sleep` loop. Use one watcher
per PR (which one: see your path file). Never run two watchers on the same PR.
Every watcher on a GitHub account shares one rate limit.

Handle the existing checks and comments first, then start the watcher.

A wake is news, not a merge decision. Check the merge gate yourself.

With any watcher: when an event needs no action, end your turn without a
message. Never post or say "still waiting".

## GitHub rate limits

GitHub's GraphQL and REST APIs have separate rate limits. When one is used
up, read the PR, its check runs, and its comments through the other.

No watcher available at all (for example no `gh` and no T3 or cloud PR
watcher): read the PR, its checks, and its comments once
with whatever GitHub access the session has, handle what is there, report the
PR's state, and stop. Do not poll.

## Reviews

Only act on checks and comments newer than the latest push. Verify every bot
finding against the source before changing code. Fix real findings and CI
failures, distinguish repository failures from infrastructure flakes, and reply
with a written reason when dismissing false positives.

If the repo has `.macroscope/check-run-agents/*.md`, read those rules before you
reply to a Macroscope finding. Its findings cite them.

CodeRabbit is advisory. Treat its findings like any other finding, but never
wait for it and never hold a merge for it.

If a review bot leaves feedback you believe is not worth addressing, reply with
a written reason and resolve the comment. Use the `leaving-pr-comments` skill
for every comment posted on the user's behalf.

Screenshots and videos help as well, when you have a way to upload them.

Keep the PR at the size the user's goal needs. Review loops tend to grow a
PR one cheap-looking fix at a time. Fix real bugs in the intended case.
Decline the rest with a written reason, and list them as follow-ups:
unneeded tests, guards for edge cases that do not matter, extra integration
or compatibility, and small performance costs. Prefer the fix that deletes or
narrows code.

## Base branch and merging

Keep an eye on changes to `main` and rebase when needed. Before you call the PR
ready, make sure it is not BEHIND or DIRTY (whether your watcher reports this:
see your path file).
If an overlapping PR makes this one obsolete, stop monitoring, report it to the
user, and ask before closing the PR unless closure was explicitly authorized.

If nothing has changed, stay quiet rather than posting filler comments. Stop
when the merge gate passes on the latest head (how your watcher signals it:
see your path file). Merge only when the user explicitly requested it;
otherwise report that the PR is ready. Right before a merge, run `git fetch` and
check the PR again. Never merge when it is BEHIND or DIRTY, or when base commits
that landed after the last green run touch this PR's files. Rebase, push, and
wait for green again.
