# Performance Coach: handoff (cloud session running; last updated 2026-11-06 13:40 UTC)

This is everything a new Claude Code session needs to resume the build on another machine. The
product spec is `docs/product-requirements.md` on `main`; milestone criteria are in
`docs/milestones.md`. Read this file from `origin/handoff` (it is not on `main`).

## Update: cloud session, 2026-11-06 (06:28 → 15:40 UTC, still running)

A claude.ai cloud session (4 CPUs, 15 GB, Linux; no T3, no Codex) is working the goal "finish
M1–M9 on main with evidence and the app live on coach.nikocruz.com". State at 15:40 UTC:

- **Production is live** on coach.nikocruz.com since the cutover (#50, 07:13 UTC); every merge to
  `main` deploys it, and the post-deploy smoke check runs after each deploy.
- **Owner setup done** (10:43 UTC) on the owner's iPhone 16 Pro Max, iOS 27.0.1, in **Chrome for
  iOS** (the browser they use; WebKit engine). Passkey and recovery codes stored;
  `OWNER_SETUP_TOKEN_HASH` cleared in Vercel (an empty value; the owner deletes the variable when
  at a desk). The real-device checklist passed in Chrome; record it in M2's docs PR and change the
  checklist in `docs/testing.md` to target Chrome for iOS (Add to Home Screen optional).
- **Merged today: 76 PRs.** By 13:40: #12, #18–#47, #50–#67, #69–#72, #75, #78–#80, #82, #85, #87,
  #88. Since: #68 (ranked goals), #86 (section pages load no editor CSS), #91 (e2e fixture programs
  and full M3 reset), #92 (week-1 loads), #94 (history queries), #95 (program versions), #96
  (desktop rules), #97 (weekly volume), #98 (M4 timers), #99 (e2e race fixes), #100 (week
  placement), #101 (M5 coach contracts), #102 (M4 outbox rules).
- **Plans** (all in `plans/`): `m3-plan.json`, `m2x-plan.json` (21 slices), `m4-plan.json` (61),
  `m5-plan.json` (61). The planner (`milestone-plans-cloud.js`, run `wf_3f53c5db-7bb`) is on M6,
  then M7 and M9. Each plan's `openQuestions` are answered with defaults; slices list the default
  under "## Owner decisions" in their PR.

### Open PRs and how they merge

- **Profile chain** (they add entries to the same section registries): `workflows/profile-chain.js`
  (run `wf_ee68f6ee-303`) restacks #73 → #74 → #76 → #77 → #81 → #83 → #84 → #89 → #93 as one
  chain on main + #86: each link merges main and the previous link and resolves the registry
  conflicts (keep every entry), a fresh reviewer reads the remerge-diff and full gates run while
  the next link stacks, fixes cascade down, then all are pushed in order with "Depends on <previous
  link>" and an audit checks no section was lost. Until it pushes they are held in
  `<scratch>/steward-hold`; remove those lines after the push and the steward merges them in order.
  **#104** (goal drag) is built on the old #93 and is restacked onto the new one after that.
- **#90** (M4 icon sprite): its two WebKit test bugs are fixed (a `minus` icon's zero-height box;
  `document.fonts.ready` waits for the load event in WebKit), and main is merged in (both budget
  guards kept). One WebKit e2e fails with this PR + current main: leaving `/design` while its
  startup CSS is held throws an uncaught "Unable to preload CSS" (the test holds the sprite too, and
  a held `<use>` sprite holds WebKit's load event). Fix in progress (`pr-ci-fix.js`).
- **In CI:** #103 (M4 set logging rules), #105 (M3 move/skip a session).
- **Never merge #13** (this branch). **#14** is an old paused WIP branch; leave it.

### Rules learned today (now in `workflows/dag-cloud.js`'s instructions)

- **One query at a time per Executor** (#62): never `Promise.all` over one `db` handle or
  transaction; the integration suite fails any test that does.
- **Postgres 18 locally**: CI and Neon run 18, the container's server is 16, and they differ (an ON
  DELETE RESTRICT refusal is 23001 on 18, 23503 on 16). `tools/pg18` starts an embedded Postgres
  18 on port 5433 (binaries in `/var/lib/pg18`, from npm `@embedded-postgres/linux-x64`); gates
  run the integration suite on both; `tests/integration/helpers.ts` has `restrictRefusalCode`.
- **Lazy imports get no JS modulepreload** (one rule in `vite.config.ts`): WebKit keeps a failed
  modulepreload stuck (bug 270357), so Retry could never load a lazy chunk on Safari/Chrome iOS.
- **Profile section editors stay out of the server build** (#86): SvelteKit links the CSS of every
  dynamic import the server build can reach, render-blocking; `pnpm budgets` now guards it.
- **WebKit's `document.fonts.ready`** resolves only after the load event; tests that hold a request
  wait on `document.fonts.status === 'loaded'` instead (Playwright's screenshots await `ready`).
- **Lighthouse LCP artefact** (found on #90, main is equally exposed): Chrome truncates the FCP
  trace timestamp through seconds-as-double, so at some runner uptimes LCP lands 1 µs after FCP
  for the same frame and Lantern takes its slow path (≈2.5 s simulated LCP on `/profile`). It shows
  when CI's apt step runs slow and the audits start late. Owner decision pending (below).
- **Lost runners**: a job "cancelled" at its timeout with no log and no artifacts is a lost runner;
  re-runs are refused to this integration, so bring main in (a real change) for a fresh run.
- **GitHub pagination**: `gh api --paginate` follows `repositories/<id>/...` links that the
  session's proxy refuses; page by number (`&page=N`) instead (`build-plan-wave.py` does).
- **Shared docs** (`docs/testing.md`, `security.md`, `performance.md`, `milestones.md`): code
  slices put their lines in a "## Docs to add" section of the PR body; each milestone's docs PR
  collects them from the merged PRs.
- **Stacked history**: a PR built on another slice's branch shows "dirty" on GitHub once that
  slice merges, though `git merge-tree` merges it cleanly; merge main into it locally, run quick
  checks on its files, push. `tools/steward-plan` also passes a PR whose head already holds all of
  main (merging main changes nothing) without another refresh.

### Running workflows (scripts in `workflows/`, args in `<scratch>/dag-*.json`)

`dag-cloud.js` waves: B1 (M3 generator: scenarios), B2 (M3 Train week, db-explain, …), X1 (M2X
desktop shell, email link), C1b (M4 projection, store, sync, …), D1 (M5 tool catalogue, markdown,
mock provider, tool framework); plus the profile chain, the #90 fix and the M6/M7/M9 planner.
Agent cap: 12 (owner-approved). `build-plan-wave.py <plan> <M> <brief> <slug> <port>` builds a
wave's args from any milestone plan. Next once the profile chain is pushed: M3 `preferences-link`
(on #83) and M2 `onboarding-flow` (on the whole chain), then Today setup, onboarding save/resume/
review, Today summary and M2's docs PR.

### Waiting on the owner

- Email sign-in link: create a Resend account and add `RESEND_API_KEY` (Production, Sensitive);
  the session asks before setting `OWNER_EMAIL`.
- M8: the council bar (`args.bar`), asked when M4 lands. M8/M9: real-traffic Core Web Vitals at
  p75 and the owner's sign-off.
- **Lighthouse gate**: patch `scripts/lighthouse.ts` to treat a same-frame LCP candidate 1 µs after
  FCP as FCP (a measurement correction, with a test), or accept a rare red Lighthouse run.
- Defaults to confirm (none blocking; each PR's "## Owner decisions"): tablet 640–1023 px keeps the
  bottom bar and Security stays one column on desktop (#96); default rests 3:00/2:00/1:30/1:00
  (#98); coach off = every turn refused, tagged-label answers (#101); a failing change is parked
  after 50 failures or 24 h, backoff 1–60 s (#102); assisted/bodyweight logging rules (#103); the
  plans' `openQuestions`, e.g. M2X link lifetime; #73's coach units vs device units; #63's restore
  of a retired custom exercise name.

To resume in a fresh cloud session: copy `tools/*` to `<scratch>/bin`, `plans/*` to
`<scratch>/plans`, start Postgres 16 (raise `max_connections` to 300) and `tools/pg18`, then build
wave args with `workflows/build-plan-wave.py` (M2X/M4/M5…) or `build-dag-args.py` (M2/M3) and run
`workflows/dag-cloud.js` (paths replaced) once per wave. Branches with PRs become external
dependencies; a slice whose branch exists resumes from it.

## The owner's rules (follow them exactly)

- **Small atomic PRs.** One concern each, green on its own, ideally ≤ 600 lines of non-test code.
  Real tests that prove behaviour; a regression test must fail without its fix.
- **Merge each PR when it is green, with a merge commit** titled `Merge <PR title> (#N)`. Ask first
  only before deleting real data, spending money beyond the free plans, or touching anything
  outside this project.
- **Every PR goes through the owner's three skills** (user-level skills in `~/.claude/skills/`;
  install them on the new machine, or ask the owner for them):
  - `/sol-review`: Sol (GPT Sol, currently `gpt-6.1-sol`) reviews the branch in a fix loop until it
    approves. Effort `xhigh` for auth, security, data loss and concurrency, `high` otherwise.
    Docs-only PRs skip it. Workflow agents cannot use T3's `delegate_task` (it fails with
    `parent_not_active`), so they use the skill's Codex CLI route (`codex exec … -s read-only`).
  - `/file-pr`: title is a concise human-readable Conventional Commit that says why it matters. The
    body opens with the problem in plain words, then the change (no inventory), a short "Tests"
    section, then one `Depends on #N.` line per unmerged dependency, then
    `Reviewed with sol-review: <N> rounds with <model> on <effort>. Sol verdict: approved` (or
    `sol-review: not applicable (docs only).`), and last `Created with <model> in Claude Code.`
  - `/babysit-pr`: only the main thread watches PRs (`watch_pull_request` in T3 Code); children
    never do. Before every merge: never merge DIRTY or BEHIND, or when a `main` commit that landed
    after the last green run touches the PR's files. Refresh the branch and wait for green again.
- **Commits:** Conventional Commits, a plain-prose body, and the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No AI model names anywhere else.
- **Agent load:** on the old Mac (8 GB RAM) the owner capped it at **8 agents at once** and heavy
  commands (svelte-check, vite build, Playwright) at 2 at a time. Ask the owner what the new
  machine allows before raising either.

## Where things stand

| Area                                       | State                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **M1** Foundation                          | Merged (#1). An independent audit (`plans/m1-audit.json`) found 3 gaps: 2 fixed, 1 (WebKit nav screenshots) WIP |
| **M2** auth + training profile             | Merged (#2–#12)                                                                                                 |
| **M2** security review (15 fixes)          | **All merged** (#18–#20, #23–#31, #34, #35, #40 step-up re-authentication)                                      |
| **M2** input primitives, save path         | Merged: #32, #36, #37, #42. #47 (Toggle + TagInput) open, green, needs a branch refresh                         |
| **M2** Profile editing, onboarding, Today  | Not started, except `m2/21-profile-equipment` (WIP branch). Plan: `briefs/m2-onboarding-plan.json`              |
| **M2** production cutover                  | Branch `feat/m2-production-cutover` (7 commits, Sol round 1 was running). Needs the owner's setup-token hash    |
| **M3** data model and programs (50 slices) | Plan: `plans/m3-plan.json`. Merged #41, #43. Open #45, #46. Six more slices in progress (branches below)        |
| **M4–M7, M9**                              | Briefs in `briefs/`; not yet planned into slices                                                                |
| **M8** councils                            | `workflows/councils.js`; the bar is held privately by the owner (pass it as `args.bar`)                         |

Production is still off: `vercel.json` keeps `main` from deploying until the cutover PR merges.

### Open PRs

| PR  | What                                 | State                                                      |
| --- | ------------------------------------ | ---------------------------------------------------------- |
| #47 | feat(ui): Toggle switch and TagInput | Green, Sol approved; refresh from `main`, merge **first**  |
| #45 | M3 exercise catalogue part 1         | Refreshed, CI was running; Sol approved                    |
| #46 | M3 program-plan contract             | Green, Sol approved; refresh from `main`                   |
| #13 | this handoff (branch `handoff`)      | Keep open; never merge it with the steward                 |
| #14 | the old WIP onboarding PR            | Close it once the Profile and onboarding slices replace it |

### Pushed branches without a PR yet

Every one is on `origin`. "WIP" means the last commit is `wip(handoff): …`: unfinished, ungated and
unreviewed. Fold it into a real commit (or redo it) before publishing.

| Branch                                      | State                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `feat/m2-production-cutover`                | Implemented and gated; Sol round 1 was running when paused. Finish Sol, PR |
| `fix/m1-screenshots-after-view-transitions` | Implemented; needs mutation check, Sol, PR                                 |
| `fix/m1-today-train-next-step-copy`         | Implemented; needs Sol, PR                                                 |
| `ci/m1-keep-server-log-and-main-runs`       | Implemented; workflow YAML, Sol not applicable; PR                         |
| `ci/m1-actions-node-24`                     | Implemented; workflow YAML, Sol not applicable; PR                         |
| `fix/m1-one-query-at-a-time-per-client`     | Implemented (3 commits); needs mutation check, Sol, PR                     |
| `m2/21-profile-equipment`                   | WIP (stacked on #42 and #47)                                               |
| `m3/02-train-headroom`                      | Implemented, plus a WIP commit from a resume                               |
| `m3/04-training-metrics`                    | WIP (stacked on #46)                                                       |
| `m3/06-exercise-catalogue-upper`            | Implementation in progress (stacked on #45)                                |
| `m3/08-describe-prescriptions`              | Started from #46; no own commits yet                                       |
| `m3/11-exercise-library-db`                 | WIP (stacked on #43 and #45); adds a migration                             |

## Next steps, in order

1. **Set up the machine** (see "How to work" below), then copy `docs/handoff/tools/*` into your
   scratchpad's `bin/` and run `steward --dry-run` from the repo.
2. **Drain the merge queue.** Put `47` in `<scratch>/steward-priority`, then run `steward` whenever
   a watched PR wakes you. It refreshes one stale PR at a time and merges what is ready.
3. **Production cutover.** Finish `feat/m2-production-cutover` (`workflows/m2-cutover.js` is the
   prompt that built it). Its PR must carry
   `Merge hold: OWNER_SETUP_TOKEN_HASH must be set in Vercel Production first …`; the steward
   skips any PR with a `Merge hold:` line. Then the owner:
   1. runs `pnpm auth:setup-token` on their own machine (the token never goes in chat);
   2. sets the printed hash as `OWNER_SETUP_TOKEN_HASH` in Vercel → Production (sensitive), or sends
      you only the hash to set;
   3. after the cutover merges and production deploys, opens
      `https://coach.nikocruz.com/setup?token=<token>` on the iPhone, registers the passkey, stores
      the recovery codes, then removes the hash from Vercel.

   **Update 2026-11-06:** the owner has set `OWNER_SETUP_TOKEN_HASH` in Vercel Production and
   holds the link, so the PR needs no merge hold. Their first try at the link returned Vercel's
   `404 DEPLOYMENT_NOT_FOUND`, as expected with production still off; the token is unused. Remove
   the hold line if the PR has one. If Vercel refuses the production deploy with
   "Resource is limited", wait for the 24-hour window and redeploy.

4. **Resume the build graph.** `workflows/build-dag-args.py` reads the M3 plan, the M2 slice list
   and the M1 items, asks GitHub which branches already have PRs, and emits the graph (merged or
   open slices become external dependencies, the rest become items). Generate a runnable script by
   embedding that JSON as `const DATA` into `workflows/dag-main.js` (replace `args.limit`,
   `args.external`, `args.items` with `DATA.*`) and run it with the Workflow tool. Each item:
   implement (resuming an existing branch or worktree if one exists) → mutation check → Sol fix
   loop → gates → push → PR with one `Depends on #N.` line per open dependency. A priority limiter
   runs the longest dependency chain first, which puts M2's Profile editing ahead of the M3
   backend. Known quirk: the limiter only orders once it is saturated, so the first slots go to
   whatever is ready first; add a tick of delay before dispatch if that matters.
5. **Plan M4, M5, M6, M7 and M9** with `workflows/milestone-slice-plan.js` (two planners →
   synthesizer → completeness critic; pass `{milestone, brief, priorPlans: ['m3-plan.json']}`), then
   add their slices to the graph. M5 (the AI coach) uses the `claude-api` skill; `ANTHROPIC_API_KEY`
   is set in Vercel Production. M8 runs `workflows/councils.js` after M4 and again at the end. M9
   adds backups (Vercel Cron → encrypted export → Vercel Blob), the restore drill and the reports.

## Waiting on the owner

- **The cutover.** The setup token hash is set; once production is live, the owner opens the link.
- **M3 product defaults.** The planner chose these; each is a named constant, cheap to change:
  - a program starts next Monday (the build preview also offers "This week");
  - the first block is 1 baseline + 3 accumulation weeks + a deload, shortened to build + taper
    when the top event is under 6 weeks away;
  - the highest-priority dated goal shapes the block; another event inside it gets a taper week;
  - days per week count fixed commitments (5 days with Muay Thai Tue/Thu leaves 3 free days);
  - unset equipment means a commercial gym; an unset session length is 60 min;
  - session length caps every session except the long run (explained when longer);
  - "Never prescribe this again" swaps every upcoming occurrence in the current program;
  - a move that breaks an interference rule is warned and recorded, not blocked.
- **Resetting the shared `preview` Neon branch.** Per-PR previews applied migrations from unmerged
  branches, so it is in a mixed state. Nothing uses it now. Before any on-demand preview, empty it
  and re-migrate (docs/deployment.md, "Resetting the preview database"). Ask first: it is a Neon
  change, though it only deletes disposable preview data.

## Changes made to the project's settings this session

- GitHub default branch switched from `claude/install-neon-skills` to `main`. That registered the
  Backup workflow (run 42147437996 skipped gracefully without secrets) and turns on Dependabot's
  weekly PRs (Mondays).
- Branch protection on `main`: the 5 CI jobs are required checks, `strict: false`, admins not
  enforced, no required reviews. Auto-merge is not enabled; the steward merges.
- Vercel Git deployments now happen only for `main` (#44: `git.deploymentEnabled` has
  `"**": false`). The Hobby plan caps an account at 100 deployments a day and per-PR previews hit
  it (`api-deployments-free-per-day`). CI runs the Vercel build and the migrations on every PR.
  Vercel reads `vercel.json` from the pushed commit, so **a branch cut before #44 still deploys on
  every push**: merge `main` into it first. Every branch listed above already has it (except the
  superseded `m2/12-onboarding`). The cap is a rolling 24-hour window; the heavy use ended about
  2026-11-06 04:00 UTC. If the cutover's production deploy is refused, redeploy after that, or ask
  the owner about Vercel Pro (it costs money).
- Stale Playwright browser caches were deleted (#21 keys the cache by runner image).

## How to work on it

```sh
nvm use                                # Node 22 (the shell may default to another version)
pnpm install && pnpm db:setup          # local Postgres 16+; the old Mac used Homebrew postgresql@18
pnpm check && pnpm lint && pnpm test:unit && pnpm test:integration
pnpm build && pnpm build:node && pnpm budgets
pnpm test:e2e                          # Chromium; E2E_WEBKIT=1 adds WebKit (CI always runs both)
```

### Tools in `docs/handoff/tools/` (copy them to `<scratch>/bin/`)

- `agent-env <slug> <port>`, run inside a git worktree: installs that worktree's own
  `node_modules`, creates `coach_<slug>_{dev,test,e2e}`, migrates dev, and writes
  `<scratch>/env/<slug>.sh`, which every later command sources. One slug and port per agent.
- `slot <cmd…>`: a machine-wide semaphore for heavy commands (`SLOT_COUNT`, default 2 here).
- `steward [--dry-run]`: the merge gate. In PR-number order (the numbers in `steward-priority`
  first), it merges a PR only when it is open against `main`, has no WIP title and no
  `Merge hold:` line, every `Depends on #N.` is merged, the latest run of each required job passed,
  the body carries the Sol line, and GitHub says clean. Staleness is exact: it compares the tree CI
  tested (head merged with `main` as of the run) with the tree a merge would make now, and counts
  only the PR's own files. It refreshes one stale PR at a time (strict queue, `steward-queue`)
  through GitHub's update-branch. It skips #13 and #14. Set `REPO_DIR` if you run it outside the
  checkout.

### Workflows in `docs/handoff/workflows/`

Replace `<SCRATCH>` and `<REPO>` with your paths first.

- `dag-main.js` + `build-dag-args.py` (+ `m1-items.json`): the build graph (step 4).
- `m2-cutover.js`: the cutover slice's full prompt.
- `milestone-slice-plan.js`: the planner that produced `plans/m3-plan.json`.
- `m1-audit.js`: the M1 audit (its verdict is `plans/m1-audit.json`).
- `councils.js`, `m2-security-fixes.js`, `m2-onboarding-plan.js`, `milestone-build.js`,
  `m2-stack-review.js`: from the earlier session.

## Lessons learned (this session)

**Merging**

- **Shared docs serialise everything.** Nearly every PR edited the same paragraphs of
  `docs/testing.md` and `docs/security.md`, so each merge made every other PR stale and forced
  another CI run. Code slices must not rewrite those paragraphs; add one new line, or land a
  wave's doc updates as one docs PR at the end.
- **Refresh one stale PR at a time.** Refreshing all of them wastes CI, because the next merge
  makes them stale again.
- **Stacked PRs need care.** `gh pr merge` on a stacked PR merges it into its stacked base, not
  `main`. Merge with REST (`PUT /pulls/N/merge` with `sha` and `commit_title`) only when the base is
  `main`. Prefer every PR based on `main` with `Depends on #N.` lines over GitHub base branches.
- **`gh pr create/edit/merge` fail here** with a Projects (classic) GraphQL deprecation error. Use
  `gh api` REST calls.
- **Semantic conflicts happen.** Two PRs, each green on its own, broke together twice: a test
  helper reused a setup token after #19 made tokens single-use, and a fake session lacked step-up's
  new `reauthenticatedAt`. Run the type-check and the tests after every merge of `main` into a
  branch.
- **Migrations clash in parallel.** Two branches both generated `0007`. Renumber the later one: take
  `main`'s journal and snapshot, delete your migration files, `drizzle-kit generate --name …`,
  re-create custom SQL with `--custom`, then verify on a fresh database. The journal order is
  unit-tested.

**CI and infrastructure**

- **Linux WebKit on CI sometimes has no WebAuthn.** The sign-in page then correctly says it
  cannot use passkeys; #39 made the test check real support.
- **Old browser caches broke WebKit** (ICU mismatch between Ubuntu releases). #21 keys the cache by
  `ImageOS`.
- **A CI "failure" is often infrastructure.** Read the job log before touching code: apt timeouts,
  browser downloads, the Vercel deployment cap. Re-run with `gh run rerun <id> --failed`.

**Local machine**

- **macOS WebKit differs from CI's Linux WebKit.** On `main`, three `e2e/shell.e2e.ts` tests fail
  locally only (plate calculator focus, late animation frame, theme before first paint). CI is
  the gate.
- **Give every agent its own worktree, `node_modules`, databases and e2e port.** Raise Postgres
  `max_connections` (300 here).
- **8 GB of RAM could not take 16 agents.** Agents leave Playwright browsers and Node servers
  behind: kill them, and remove worktrees when items finish.
