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

Decide once per invocation, in this order:

1. Any `mcp__t3-code__` tool is listed or loads with tool search
   (`mcp__t3-code__orchestrator_capabilities`): T3 Code. Read [t3.md](t3.md).
   (T3 Code runs Claude Code or Codex underneath; T3 wins.)
2. You are Claude Code (terminal, Claude Desktop, or a claude.ai cloud session;
   you have tools such as Agent, ToolSearch, Skill): read [claude.md](claude.md).
3. You are Codex (your instructions start "You are Codex" or mention the Codex
   CLI; tools such as exec_command, apply_patch, spawn_agent): read
   [codex.md](codex.md).
4. You are Pi (the pi coding agent; tools such as read, bash, edit, write, and
   a skill path given by Pi): read [pi.md](pi.md).

Paths are relative to this skill's directory; follow the file you read. The
rules in this file apply everywhere; the path file says which tools to use.

## Waiting

GitHub access: use whatever the session has, such as the `gh` CLI (if
logged in), a GitHub MCP server, or built-in GitHub tools (in Claude Code, search
ToolSearch for `github`). The steps in this skill say what to do, not which command to run. If
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
