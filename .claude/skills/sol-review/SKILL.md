---
name: sol-review
description: >-
  The user's main code reviewer. Use for any request to review, check, or find
  bugs in code: uncommitted changes, the current branch, a PR (number or URL),
  a commit, a diff, or named files. E.g. "review this", "review my changes",
  "review PR 123", "review this branch/commit/file", "check my code", "is this
  ready to merge", "sol loop", "sol review". GPT Sol reviews; you verify each
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
request.

Make the most minimal possible changes to appease the Sol reviewers. Be careful
of scope creep and don't be scared to push back.

If the user names a different reviewer or command (`/code-review`, council, a
non-Sol model), use that instead. If you are a delegate or subagent (a council
member, a `delegate_task` child), review directly and return findings. Do not
start this skill or another reviewer.

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

## 1. Scope

Run `git status --short`. Do not stash or discard. When the head is the
working tree, do not include unrelated changes: limit review to the change
paths if they separate cleanly. Otherwise stop and ask.

Find the base after `git fetch origin`. Default branch:
`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`. If an
`upstream` remote hosts the base repo, use it instead of `origin` here.

- Local (default): `git merge-base HEAD origin/<default-branch>`. No remote: a
  base the user names, or `HEAD` for uncommitted changes only.
- PR: `gh pr view <n> --json baseRefName,headRefOid,author,state,mergeCommit`.
  Fix loop if the PR is open and the author is the user
  (`gh api user --jq .login`) or the user asks for fixes. Already on the PR
  branch: stay, dirty or not. Another branch: `gh pr checkout <n>` only if
  clean, and report the branch you left. Confirm `HEAD` is the PR head, or
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

In Claude Code, T3 tools are deferred. Load them first with ToolSearch
`select:mcp__t3-code__orchestrator_capabilities,mcp__t3-code__delegate_task,mcp__t3-code__task_cancel`.
Elsewhere, if T3 tools are not listed, try one direct capability call.

In T3, call `orchestrator_capabilities`. If Sol is not listed, search `sol`.
Pick the latest Sol unless the user named a version. Do not hardcode an ID.
Prefer the `codex` provider instance. Reasoning effort: `high` unless the user
names one. Use `xhigh` for security, permissions, auth, data loss, or
concurrency. `ultra` makes Sol start subagents, so use `max` unless the user
confirms `ultra`. Sol defaults to low, so always set it. Use the effort option
id that capabilities lists for that model (`reasoningEffort` on codex), never a
guessed one. Record provider, model, and effort. Use `delegate_task` every
round (`role: "review"`, `mode: "async"`, `target` with `providerInstanceId`,
`model`, `options`). Keep `isolation` shared; a worktree drops uncommitted
edits. Save `taskId`. New `clientRequestId` per round. `childThreadId` is
storage, not the next target. Do not use `t3_thread_send`, `create_threads`,
or `t3_thread_launch` for review.

Outside T3:

- Native Sol subagent (Codex, or any harness with one): use it and keep its ID.
- Claude Code: use a custom subagent if one is set up to run Sol. Otherwise, if
  `codex` is on PATH, run Sol through the Codex CLI. Read-only, one fresh run
  per round. Write the brief to a scratch file, then run in the background
  (`timeout: 7200000`) and wait for exit:

  ```
  codex exec -m <sol-id> -c model_reasoning_effort="<effort>" -s read-only \
    -C <repo> --ephemeral -o <scratch>/sol-round-<N>.md \
    - < <scratch>/brief-<N>.md 2> <scratch>/sol-round-<N>.log
  ```

  `<sol-id>`: the version the user named, else the newest Sol (lowest
  `priority`; do not sort by name):
  `codex debug models | jq -r '[.models[] | select(.visibility=="list" and (.slug|endswith("-sol")))] | min_by(.priority) | .slug'`.
  `<effort>`: as chosen above. A reply is exit 0 with a non-empty `-o` file;
  anything else is a failure. Take model, effort, and usage from the log's
  `model:`, `reasoning effort:`, and `tokens used` lines.

If no route runs Sol, report the blocker and offer `/code-review` instead. Do
not substitute a model.

Do not edit scoped files while review runs. Wait for the notice. Do not
poll or start a second reviewer. Timeout, error, or no reply is not
approval. On failure, cancel, verify stop, restart with the ledger.

Round 1 brief (T3 children get no history):

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
changed, or approval does not cover the current behavior diff. Use a fresh
`delegate_task` in T3, follow up the saved native ID, or start a fresh
`codex exec`. Send the round 1 brief, the ledger (`fixed:` / `disagree:` /
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
`Reviewed with sol-review` line:

`Reviewed with sol-review: <N> rounds with <model> on <effort>. Sol verdict: approved`.

Drop `on <effort>` if it was not verified.

Report: mode, rounds, model and effort, what Sol changed, diff size
before/after, fixed and declined findings with reasons, usage if exposed (else
say not), pushed or not, and any branch you switched from. Review only:
verified findings by severity, with file:line and your agree or disagree.
