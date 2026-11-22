---
name: verify-coach
description: Drive the real Performance Coach web app the way the owner does and keep the evidence. Runs the production build against a disposable Postgres database through the repo's Playwright harness, on an iPhone viewport and a desktop window. Use to prove a change works before a pull request is opened or merged, to check a feature end to end, or when asked whether something actually works in the app.
---

# Verify Performance Coach

Tests passing is not the same as the app working. This skill proves a change on the real artifact:
the production Node build, a real Postgres database, a real browser, signed in as the owner with a
passkey. It wraps the Playwright harness the repo already has, so a verification is a Playwright
spec that walks a user's path and checks what they would see and what the database holds.

**Where it runs.** By default, on GitHub: CI runs every spec under `e2e/` on each pull request,
on Chromium and WebKit, and keeps the screenshots, report and server log as a
`playwright-<run>-<group>-<engine>-<shard>` artifact for 14 days. So the usual way to verify a
change is to make sure a journey covers it, push, and confirm that journey passed in the PR's CI
run. Run it on this machine, with the helper below, to reproduce a CI failure, to try a new spec
before pushing, or when asked to prove something right now. A local run builds the app and takes
most of this machine's memory, so nothing else heavy can run beside it.

Everything local goes through one helper. Run it from the repo root:

```sh
.claude/skills/verify-coach/scripts/verify doctor
.claude/skills/verify-coach/scripts/verify run e2e/journey-strength.serial.e2e.ts
```

## Doctor

`verify doctor` is read-only and answers "can this machine run a verification right now?". Run it
first, and again whenever a run fails before any test starts. It checks:

- Node is 22. The repo refuses other versions; fix with `nvm use`.
- `node_modules` is newer than the lockfile; fix with `pnpm install --frozen-lockfile`.
- Postgres answers on the e2e database (`coach_e2e`); fix by starting Postgres, then
  `pnpm db:setup`.
- Playwright and its Chromium are installed; fix with `pnpm exec playwright install chromium`.
- Port 4173 is free. If something is listening there, another run or a dev server owns it. Do not
  kill it unless you started it; wait, or see Isolation below.

## Launch

There is no separate launch step. `verify run` starts everything through Playwright's global setup
(`e2e/global-setup.ts`), from an empty state every time:

1. drops and recreates the `coach_e2e` database and applies every migration in `drizzle/`
2. mints a one-time owner setup token
3. builds the app with the Node adapter (`pnpm build:node`)
4. starts `node build/index.js` on `http://localhost:4173` with test routes on and the mock coach,
   and waits for `/api/health`
5. runs the `setup` project, which registers the owner with a virtual passkey and saves the
   signed-in browser state to `e2e/.auth/`

Ready means the line `[e2e] production server ready at http://localhost:4173` followed by the
`setup` tests passing. The build makes the first minute slow; a whole journey takes one to three
minutes. Teardown is automatic: Playwright stops the server when the run ends.

## Drive

A verification is one or more spec files under `e2e/`. Pick from the feature map in
[features/README.md](features/README.md), or write a new one for the change in hand.

```sh
.claude/skills/verify-coach/scripts/verify list                      # journeys that exist
.claude/skills/verify-coach/scripts/verify run e2e/<spec>.e2e.ts     # run one or more specs
```

The helper picks the Playwright project from the file name. A `*.serial.e2e.ts` spec changes the
one owner's profile, program or workouts, so it runs alone in `serial-chromium`. Any other spec
runs in `iphone-chromium`. Run the two kinds in separate commands.

To drive something no spec covers yet, write a spec. That spec is the verification and it stays in
the repo as a regression test. Follow the journeys already there:

- Start where the owner starts, usually Today, and move with the app's own controls. Find elements
  by role and name (`page.getByRole('button', { name: 'Start workout' })`) or by the
  `data-testid` values the screens already carry. Never use coordinates.
- `gotoHydrated(page, path)` from `e2e/support.ts` opens a page and waits until it is interactive.
- `query(sql, params)` from `e2e/support.ts` reads the e2e database, so a step can assert the rows
  it should have written.
- `captureScreen(page, testInfo, name)` from `e2e/support.ts` saves a settled screenshot of a
  state.
- Seed through the support files (`e2e/program-support.ts`, `e2e/workout-support.ts`,
  `e2e/coach-support.ts`, `e2e/review-support.ts`), which use the test-only routes under
  `/api/test-support/`. Use those routes to set a scene, never to perform the step being proven.
- The coach runs on the deterministic mock provider (ADR 0009). No run calls a real model or
  spends money.

Name a spec `*.serial.e2e.ts` when it writes the owner's profile, program, workouts or coach
threads, and `*.e2e.ts` when it only reads or works in data of its own.

## Evidence

`verify run` writes a folder per run under `verify-evidence/` (git-ignored) and prints its path:

- `summary.txt`: the commit, the specs, the project, and PASS or FAIL with the counts
- `playwright.log`: every test title with its result
- `screens/`: the screenshots the spec captured, by project
- `traces/`: a Playwright trace per test, with every action, network call and DOM snapshot.
  Open one with `pnpm exec playwright show-trace <path>/trace.zip`
- `server.log`: the server's output for the run

What counts as proof:

- The spec walks the real user path. A step done by calling an endpoint or a test route directly
  proves the endpoint, not the feature.
- It checks the action and the resulting state: what the screen shows after, and the rows in
  Postgres. A screenshot of the final screen alone is not enough.
- It covers every way in that the feature map lists for the feature, not only the easiest one.
- The run passed on the code that will be merged. `summary.txt` records the commit and whether the
  tree had uncommitted changes.

Quote `summary.txt` and the evidence path when you report a verification. If a run fails, report
the failure; do not edit the spec until it passes unless the spec was wrong, and say so if it was.

## Cleanup

Nothing to do after a normal run. If a run was killed before teardown, `verify doctor` will report
the port as taken:

```sh
.claude/skills/verify-coach/scripts/verify cleanup     # stops only the e2e server it finds on the port
.claude/skills/verify-coach/scripts/verify prune       # keeps the 5 newest evidence folders
```

`cleanup` refuses to stop a process that is not `node build/index.js`. Never kill by process name.
Cleanup never removes evidence; only `prune` does, and only older runs. A run with traces is about
50 MB.

## Isolation

One run at a time on the default port and database. Do not start a second run, a dev server on
4173, or another heavy command (`pnpm check`, `pnpm build`) alongside it: this machine has 8 GB of
memory. A second checkout can run side by side only with its own port and database, set before the
command: `E2E_PORT=<port> E2E_DATABASE_URL=postgres://coach:coach@localhost:5432/<name>_e2e`.

The harness only ever touches the local e2e database and a local server. It does not reach
production, Neon or Vercel.

## Keeping this skill true

The feature map is the maintained list of what can be verified. When a change adds a user-facing
feature or a new way into one, add or update its file under `features/` and its spec in the same
pull request. To check the whole map against the app after a stretch of changes, follow pstack's
`maintain-verification-skill`.
