# Performance Coach

A **private, single-user AI performance coaching platform** for Niko Cruz, served at
**coach.nikocruz.com**. An agent that plans, adapts and explains training across strength,
running, Muay Thai, hypertrophy and conditioning — and a fast, premium, iPhone-first web app to
log every set and talk to the coach.

> Status: **Milestone 1 — Foundation & infrastructure** (see [docs/milestones.md](docs/milestones.md)).
> The app shell, design system, database, observability, tests and CI/CD are in place; product
> features arrive from M2 onwards.

## Stack

| Concern       | Choice                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| App           | **SvelteKit 3** (Svelte 5 runes), TypeScript strict, Vite 8, pnpm 10, Node 22                        |
| Hosting       | Vercel (Node runtime, Fluid compute) · Cloudflare DNS (DNS-only CNAME)                               |
| Database      | PostgreSQL — Neon Lakebase Postgres in prod, local Postgres 16 in dev/test/CI                        |
| Data access   | Drizzle ORM + committed SQL migrations · node-postgres `Pool` + `attachDatabasePool`                 |
| Config        | zod-validated environment (`src/lib/server/env.ts`) · `neon.ts` (Postgres only)                      |
| UI            | Hand-built design system (CSS custom properties, dark-first), Mona Sans + Hubot Sans (self-hosted)   |
| PWA           | Web manifest, generated icons, SvelteKit service worker (versioned precache, offline fallback)       |
| Observability | Server-Timing, JSON logs, `app_errors`, RUM via web-vitals → `web_vitals`                            |
| Tests         | Vitest (unit + integration on real Postgres), Playwright 1.63 (iPhone viewport), budgets, Lighthouse |
| CI/CD         | GitHub Actions: CI, deploy (migrate → Vercel), nightly encrypted backups                             |

## Quick start

```sh
corepack enable                  # pnpm 10 from package.json
pnpm install
cp .env.example .env
pnpm db:setup                    # local Postgres 16: role + coach_dev/coach_test/coach_e2e
pnpm db:migrate
pnpm dev                         # http://localhost:5173
```

## Scripts

| Script                                                                     | Purpose                                                    |
| -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `pnpm dev`                                                                 | dev server                                                 |
| `pnpm check` · `pnpm lint` · `pnpm format`                                 | types (svelte-check + SW tsc) · Prettier + ESLint · format |
| `pnpm test:unit` · `pnpm test:integration` · `pnpm test:e2e` · `pnpm test` | test suites                                                |
| `pnpm build` · `pnpm build:node`                                           | Vercel build · Node build (e2e/Lighthouse/self-host)       |
| `pnpm budgets` · `pnpm lighthouse`                                         | performance budgets · Lighthouse mobile                    |
| `pnpm db:setup` · `db:generate` · `db:migrate` · `db:reset:test`           | database lifecycle                                         |
| `pnpm icons`                                                               | render PWA icons from SVG                                  |

## Repository map

```
src/lib/domain            pure training math (units, e1RM, RPE, plates, load)
src/lib/server/db         Drizzle schema, pool, repositories, migrations helper
src/lib/server/services   use-cases shared by routes and the coach
src/lib/server/agent      AI coach (M5) — provider interface, tools, memory
src/lib/server/auth       passkey auth (M2)
src/lib/client            browser-only: RUM, preferences, offline store (M4)
src/lib/ui                design system: tokens, fonts, icons, components
src/routes                screens and /api endpoints
src/service-worker        PWA service worker
drizzle/                  committed SQL migrations
e2e/ · tests/integration  Playwright and integration tests
```

## Documentation

- [Product requirements](docs/product-requirements.md) — source of truth for scope
- [Architecture](docs/architecture.md) and [ADRs](docs/adr/README.md)
- [Environment](docs/environment.md) · [Development](docs/development.md) · [Testing](docs/testing.md)
- [Deployment](docs/deployment.md) (Vercel + Neon + Cloudflare, secrets, backups/restore)
- [Performance](docs/performance.md) (budgets + measured baseline)
- [Design system](docs/design-system.md) · live at `/design`
- [Agent architecture](docs/agent-architecture.md) (plan for the coach)
- [Milestones](docs/milestones.md) (acceptance criteria and status)

## Privacy

Single owner, no public registration, not indexed (`noindex` everywhere). Authentication
(passkeys) lands in M2; until then the app holds no personal data and must not be exposed on the
production domain. LLM credentials never reach the browser.
