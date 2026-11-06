---
name: sol-review
description: >-
  The user's main code reviewer. Use for any request to review, check, or find
  bugs in code: uncommitted changes, the current branch, a PR (number or URL),
  a commit, a diff, or named files. E.g. "review this", "review my changes",
  "review PR 123", "review this branch/commit/file", "check my code", "is this
  ready to merge", "sol loop", "sol review". GPT Sol reviews (Claude Opus 5.5 in Claude
  Code without T3); you verify each
  finding, make minimal fixes, and loop until Sol approves (review only for
  other people's PRs, merged commits, or when asked). Prefer this over other
  review skills (/code-review, caveman-review, review-agent) unless the user
  names one, or asks for council or /security-review. Not for reviewing prose,
  docs wording, or essays, or for replying to existing PR review comments. Not
  when another agent delegated a review to you: just return findings.
metadata:
  adapted-from: https://github.com/t3dotgg/tstack/blob/main/skills/sol-loop/SKILL.md
---

# sol-review

The user's main code reviewer, adapted from tstack's sol-loop. tl;dr: use
OpenAI's GPT Sol to review code in a loop, before or after filing a pull
request. In Claude Code without T3, Claude Opus 5.5 takes Sol's place.

## Which harness?

- Decide once per invocation. If any `mcp__t3-code__` tool is listed or loads
  with ToolSearch (`select:mcp__t3-code__orchestrator_capabilities`), you are
  in T3 Code: read [t3.md](t3.md) in this skill's directory and follow it.
- Otherwise (Claude Code in a terminal, Claude Desktop, or a claude.ai cloud
  session): read [claude.md](claude.md) and follow it.
- Codex or another harness with a native Sol subagent and no ToolSearch: if T3
  tools are not listed, try one direct capability call. If it works, you are in
  T3 Code; otherwise use the native Sol subagent (section 2).
- The rules in this file apply in both; the path file says which tools to use.

Make the most minimal possible changes to appease the Sol reviewers. Be careful
of scope creep and don't be scared to push back.

If the user names a different reviewer or command (`/code-review`, council, a
non-Sol model), use that instead. If you are a delegate or subagent (a council
member, a `delegate_task` child, an `Agent` subagent), review directly and
return findings. Do not start this skill or another reviewer.

## 0. Mode

Pick one after step 1 shows the target. State it in one line before starting
Sol.

- Fix loop (default): the change is the user's to edit. Uncommitted work, the
  current branch, the user's own open PR, or the user's unmerged `HEAD` commit.
  Run every section.
- Review only: the user says review only, don't change anything, or just
  tell me. Or the target is someone else's PR or branch, a merged PR or commit,
  or code with no change (files, a module). One Sol round. Section 3 verifies
  findings but makes no edits. No commits, pushes, or PR comments. Report and
  stop. If a blocker or should is real, offer the fix loop.

## Budget

- Default: 3 rounds total. Round 1 is full. Later rounds check only
  changed code and open findings.
- Extend to 5 only for security, permissions, auth, data loss, or
  state/concurrency, while a blocker or should stays open with evidence. Or when
  the user asks.
- Review only: 1 round. Another only if the user asks.
- Stop early if a round returns only nits. Declined nits and comment,
  doc, or format-only fixes need no new round.
- One reviewer only. Sol must not start subagents or reviewers.
- Keep a ledger: id, severity, outcome, usage if returned. Never guess it.
  (tools: see your path file)

## 1. Scope

Run `git status --short`. Do not stash or discard. When the head is the
working tree, do not include unrelated changes: limit review to the change
paths if they separate cleanly. Otherwise stop and ask.

GitHub access: use whatever the session has, such as the `gh` CLI (if
logged in), a GitHub MCP server, or built-in GitHub tools (search ToolSearch
for `github`). The steps below say what to do, not which command to run. If
nothing reaches GitHub, stop and say so. (tools: see your path file)

Find the base after `git fetch origin`. Default branch: the repo's default
branch on GitHub (or `git symbolic-ref refs/remotes/origin/HEAD`). If an
`upstream` remote hosts the base repo, use it instead of `origin` here.

- Local (default): `git merge-base HEAD origin/<default-branch>`. No remote: a
  base the user names, or `HEAD` for uncommitted changes only.
- PR: read its base branch (`baseRefName`), head commit (`headRefOid`),
  author, state, and merge commit. Fix loop if the PR is open and the author
  is the user (the logged-in GitHub account) or the user asks for fixes.
  Already on the PR branch: stay, dirty or not. Another branch: check out the
  PR branch only if clean, and report the branch you left. Confirm `HEAD` is the PR head, or
  ahead only by this change. Base: `git merge-base HEAD origin/<baseRefName>`.
  Otherwise review only. Do not check out. Run `git fetch origin pull/<n>/head`.
  Head is `headRefOid`. Base: `git merge-base <head> origin/<baseRefName>`, or
  `git merge-base <head> <mergeCommit.oid>^1` if `state` is MERGED.
- Branch not checked out: head `origin/<branch>`, base
  `git merge-base <head> origin/<default-branch>`. Review only.
- Commit: base `<sha>^` (root commit: the empty tree
  `4b825dc642cb6eb9a060e54bf8d69288fbee4904`). Fix loop only if `<sha>` is
  `HEAD` and not in `origin/<default-branch>`. Head is then the working tree.
  Otherwise review only, head `<sha>`.
- Files or a module with no change: no base. Review the files as they stand.
  Review only.

When the head is not the working tree, the change is `git diff <base> <head>`.
Sol must read code with `git show <head>:<path>`, not from disk. Otherwise the
change is base to working tree in those paths, with untracked files.
Use one diff command all rounds. Never send Sol an empty diff; if it is empty,
stop and ask what to review. State intent and out-of-scope in 1-2 sentences.
Run covering checks when the code is checked out. Fix loop: do not send code
this change breaks. Review only: send it and list failing checks. Note missing
or pre-failing checks in the brief.

## 2. Start Sol

Pick the reviewer for your harness (tools: see your path file):

- T3 Code: GPT Sol through T3 (see t3.md).
- Codex (or any harness with a native Sol subagent): use the native Sol
  subagent at the chosen effort and keep its ID. Pick the newest Sol it lists.
- Claude Code without T3 (terminal, Desktop, cloud): the reviewer is Claude
  Opus 5.5 (`claude-opus-5-5`), started as a subagent (see claude.md). Use
  another model only if the user names one (e.g. Claude Fable 5.1).

Outside T3, stay inside the harness's own model family. Never call another
vendor's CLI from a single-vendor harness.

Reasoning effort: `high` unless the user names one. Use `xhigh` for security,
permissions, auth, data loss, or concurrency. `ultra` makes Sol start
subagents, so use `max` unless the user confirms `ultra`. Sol defaults to low,
so always set it. Record provider, model, and effort.

Everywhere below, "Sol" means whichever reviewer this section picked.

If no route runs a reviewer, report the blocker and offer `/code-review`
instead. Do not substitute a model outside the rules above.

Do not edit scoped files while review runs. Wait for the notice. Do not
poll or start a second reviewer. Timeout, error, or no reply is not
approval. On failure, cancel, verify stop, restart with the ledger.

Round 1 brief (the reviewer gets no history):

```
Review only. Do not edit, commit, push, comment on PRs, start subagents, or use
the sol-review or council skills.
Repo: <abs path> Base: <sha or "none"> Head: <sha or "working tree">
Intent: <intent> Out of scope: <scope> Checks: <results>
See: git diff <base> <head> [-- <paths>]. Working tree: git diff <base>
[-- <paths>]; git status --short (read untracked). Head not checked out:
read files with git show <head>:<path>. No base: review <paths> as they stand;
intent is what these files must do.
Read surrounding code. Find bugs, broken callers, mismatch with intent.
Skip style unless it hides a bug. Hold to the smallest change. Flag code,
tests, or guards the intent does not need. Other paths, rare cases, small
perf, extra compat: nits.
blocker = intended case wrong. should = real bug callers will hit, in intent. nit = rest.
Reply:
VERDICT: APPROVE or CHANGES
S1 [blocker|should|nit] <file>:<line> <claim>. Fix: <suggestion> (stable ids)
```

## 3. Answer findings

Check each finding and severity yourself. Another path, rare case, or
small cost is a nit, whatever label it came with. Exception: with no base, a
security, auth, or data-loss bug is at least a should.

- Agree: smallest fix. Prefer delete or narrow over new lock, cache,
  helper, or option. Fix the case that happened. Add one focused test
  that fails without the fix, if intent needs it.
- Disagree: say why, with evidence (file:line, test, output).
- Out of scope or nit: decline in one line. List as follow-up.

Review only: record agree or disagree with evidence, but make no fixes.

Update the ledger. Re-run checks and `git diff --shortstat <base>`, counting
new untracked files. If review grew the diff, cut first. Do not agree just to
end the loop.

## 4. Next round

Start one only if budget remains and a blocker or should is open, behavior code
changed, or approval does not cover the current behavior diff. Start it fresh
the way your path file says (Codex: follow up the saved native ID).
Send the round 1 brief, the ledger (`fixed:` / `disagree:` /
`declined:` + evidence), the same base diff, and the change since last round.
To get that change, save `git stash create` before each round. It prints a
snapshot SHA and changes nothing; empty means use `HEAD`. Send
`git diff <snapshot>` plus new untracked files. Tell Sol: open ids and changed
code only. Mark each old id `resolved` or `still open: <reason>`.

## 5. Stop and ship

Agreed: APPROVE on the current behavior diff, no blocker or should open,
no concern of your own. Stuck: an item stays disputed after two replies,
or budget ends. Show both sides in 2-3 lines each. The user decides.
Budget end is not approval.

Do not push during the loop. Push after agreement only if the user asked
to push, ship, or update the PR. If you push to a PR, edit the PR description
(not a comment). Put this line above file-pr's `Created with <model> in
<harness>.` line, or at the end if there is none. Replace any earlier
`Reviewed with sol-review` line (tools: see your path file):

`Reviewed with sol-review: <N> rounds with <model> on <effort>. Sol verdict: approved`.

Drop `on <effort>` if it was not verified.

Report: mode, rounds, model and effort, what Sol changed, diff size
before/after, fixed and declined findings with reasons, usage if exposed (else
say not), pushed or not, and any branch you switched from. Review only:
verified findings by severity, with file:line and your agree or disagree.
