# Performance Coach

## What this is

A private, single-user AI performance coaching app, served at coach.nikocruz.com. One owner, no
public registration, not indexed. It has two halves:

- **A training app**, iPhone-first and laid out for desktop too. The owner builds a program,
  follows it, logs every set (offline-first), and reads progress across strength, running,
  Muay Thai, hypertrophy and conditioning.
- **An AI coach** that plans, adapts and explains the training. It reads through tools over the
  same services the screens use, and it changes a program only through proposals the owner
  accepts.

Stack: SvelteKit 3 (Svelte 5 runes), TypeScript strict, Vite 8, pnpm 10, Node 22. PostgreSQL
through Drizzle with committed SQL migrations (Neon in production and preview, local Postgres in
dev and CI). Vercel hosting. Passkey authentication, deny by default. The Anthropic SDK sits
behind a provider interface with a deterministic mock. The design system is hand-built on CSS
custom properties.

Neon is used for Postgres only (`neon.ts`). Auth, LLM calls, hosting, cron and file storage are
already decided (ADRs 0006, 0009 and 0002, Vercel crons, Vercel Blob), so the `neon-auth`,
`neon-ai-gateway`, `neon-functions`, `neon-object-storage` and `neon-realtime` skills do not apply
here unless the owner asks to change one of those decisions.

`docs/product-requirements.md` is the source of truth for scope. It is the owner's brief,
captured verbatim, so do not reformat or reword it.

## Where to look first

| Question                             | File                                                           |
| ------------------------------------ | -------------------------------------------------------------- |
| What is in scope                     | `docs/product-requirements.md`                                 |
| What is built and what is next       | `docs/progress.md`, then `docs/milestones.md` for criteria     |
| Why something is built the way it is | `docs/decisions.md`, then the ADRs in `docs/adr/`              |
| What is broken, stale or unverified  | `docs/known-issues.md`                                         |
| How the code is layered              | `docs/architecture.md`, `docs/agent-architecture.md`           |
| What tools the coach has             | `docs/coach-tools.md` (generated)                              |
| How to run, test and deploy          | `docs/development.md`, `docs/testing.md`, `docs/deployment.md` |
| Environment variables                | `docs/environment.md`, `.env.example`                          |
| Visual design                        | `docs/design-system.md`, live at `/design`                     |
| Security model                       | `docs/security.md`                                             |

Keep `docs/progress.md`, `docs/decisions.md` and `docs/known-issues.md` current as part of the
change that makes them out of date.

## Building features

Work comes from `plan/queue.md`. Three skills carry a slice from there to production:

- `run-queue` keeps several rows of the queue moving at once and merges them in trains of up to four, one train at a time. It is
  the command to give `/loop`.
- `feature-slice` takes one slice from spec to a merged pull request, using the `builder`,
  `reviewer` and `ci-triage` agents.
- `verify-coach` drives the real app and keeps the evidence. `verify-workout-sync` model-checks
  offline sync. A slice is not done until the verification that covers it passes, and each slice
  adds to the verifications for what it built.

Limits that apply to every session here:

- A merge to `main` deploys production and migrates its database. Merge only through
  `feature-slice`'s gate. Never push to `main` directly and never force-push.
- This machine has 8 GB of memory, so heavy checks run in CI on GitHub, not here. Locally, run
  narrow checks on the files in hand (`pnpm exec prettier --check`, `pnpm exec eslint`,
  `pnpm exec vitest run --project unit <file>`), push, and read the result from the pull request.
  Run a full suite, a build or Playwright locally only to reproduce a CI failure, one at a time.
- Several slices are built at once, each in its own git worktree under `../pc-wt/`. Do not edit
  tracked files in the main checkout; other sessions share it. Merges happen one at a time: a train of up to four slices is tested and merged as one.

## Commands

```sh
pnpm install
pnpm db:setup && pnpm db:migrate   # local Postgres: coach_dev, coach_test, coach_e2e
pnpm dev                           # http://localhost:5173

pnpm check                         # svelte-check and the service worker's tsc
pnpm lint                          # Prettier and ESLint
pnpm test:unit                     # Vitest, includes the repo guards in scripts/*.test.ts
pnpm test:integration              # Vitest on a real Postgres test database
pnpm test:e2e                      # Playwright, phone and desktop, against the Node build
pnpm test:live                     # live LLM suite; LIVE_LLM_DRY=1 runs it without spend
pnpm budgets                       # performance budgets
verification/workout-sync/check.sh # TLA+ model check of offline workout sync
```

## Conventions the repo enforces

These are checked by lint or by tests, so a change that breaks one fails CI.

- **Layer boundaries.** `domain` is pure, `server` never reaches the browser, `client` is
  browser-only, and the import rules between them are linted (ADR 0004).
- **Conventional Commits**, one slice per pull request. Slices reach `main` in trains (`run-queue`),
  whose merge commit is titled `Merge train: #<a>, #<b> (#<train>)`. Every merge to `main` deploys production,
  migrating the database first.
- **Docs are tested.** Paths, `pnpm` scripts and relative links cited in the operational docs must
  exist. Every `#123` in `docs/` must be a merged PR. Every ADR needs one row in
  `docs/adr/README.md`. `docs/milestones.md` and `docs/reports/` keep a fixed shape. Known,
  accepted gaps live in `scripts/docs-known-gaps.json`.
- **No personal mail address** in any tracked file. Fixtures use `example.test`.
- **No secrets** in the repo or the client bundle. `pnpm security:scan` checks both.

## Folder map

```
src/
  lib/
    domain/          pure logic, no I/O: training, programming, workout, analytics,
                     coach, profile, exercises, backup
    server/
      db/            Drizzle schema, pool, repositories
      services/      use-cases shared by the routes and the coach
      agent/         the AI coach: provider interface, agent loop, tools, memory
      auth/          passkeys, sessions, recovery, the deny-by-default guard
      backup/        encrypted backups
      mail/          outgoing mail
      observability/ Server-Timing, JSON logs, error and vitals recording
      forms/         form parsing and validation
      test-support/  helpers behind the test-only endpoints
    client/          browser-only: offline workout store and sync, coach stream client
    ui/              design system: styles (tokens), components, icons, charts, and the
                     feature UI for coach, workout, program, profile, analytics
  routes/
    (app)/           signed-in tabs: today, train, coach, progress, profile, offline
    workout/         the live workout: session, run, fix
    onboarding/      first-run profile setup
    setup/ recover/  owner setup and passkey recovery
    api/             endpoints: auth, workouts, coach, reviews, exercises, cron, health,
                     vitals, client-errors, test-support
    design/          the live design system page
  service-worker/    PWA service worker: versioned precache, offline fallback

drizzle/             committed SQL migrations and the Drizzle journal
e2e/                 Playwright specs (*.e2e.ts) and their support files
tests/
  integration/       Vitest on real Postgres, one folder per area
  live/              tests that call the real LLM
  fixtures/          recorded Anthropic responses and shared test data
scripts/             CLIs behind the pnpm scripts (db, auth, backup, budgets, lighthouse,
                     icons) and the repo guard tests (*.test.ts)
verification/
  workout-sync/      TLA+ spec and model check for offline workout sync
docs/                requirements, architecture, operations, and:
  adr/               architecture decision records, indexed in adr/README.md
  reports/           the performance and design report skeletons
  progress.md        what is built, in flight and next
  decisions.md       decision log, pointing into adr/
  known-issues.md    open problems, stale docs, unverified claims
plan/
  queue.md          the build queue the run-queue skill works through
  trace-evals/       the plan and research for the coach run trace and evals
static/              fonts, PWA icons, manifest
.github/workflows/   CI, the nightly backup, the post-deploy smoke check, the production
                     probe, the screen gallery

neon.ts              Neon project config (Postgres only)
vercel.json          headers, crons, build settings
vite.config.ts       Vite and the Vitest projects (unit, integration, live, explain)
playwright.config.ts Playwright projects and e2e targets
eslint.config.js     lint rules, including the layer boundaries
```

Agent tooling lives in `.claude/`, `.agents/`, `.codex/` and `.pi/`. None of it ships with the app.
