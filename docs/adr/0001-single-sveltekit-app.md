# 0001 — One SvelteKit 3 application

- **Status:** Accepted (M1)
- **Context:** A private, single-user product with three equal priorities: adaptive coaching,
  exceptional performance, premium mobile design (PRD §1, §14–16). The app needs SSR, a JSON
  API, a service worker/offline story, form handling, and a server-side home for the AI agent.

## Decision

Build one deployable **SvelteKit 3** app (Svelte 5 runes, TypeScript `strict`, Vite 8, pnpm).
Frontend, API (`src/routes/api`) and agent orchestration live in the same codebase, separated by
folders with enforced boundaries (ADR 0004).

SvelteKit 3 specifics we rely on: configuration through the `sveltekit({...})` Vite plugin
(no `svelte.config.js`), `#lib/*` subpath imports (with explicit `.ts` extensions), `$app/env`,
`$app/manifest` for the service worker, and `resolve()` with typed route ids.

## Alternatives considered

| Option                     | Why not                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Next.js (React)            | Larger client runtime (React + RSC runtime) for every route; the 60 KB initial-JS budget would be tight.   |
| Remix / React Router 7     | Same React baseline cost; fewer first-class PWA conveniences.                                              |
| Nuxt (Vue)                 | Viable; slightly larger runtime, less team familiarity with Vue 3 SSR + PWA edge cases on iOS.             |
| SPA + separate API service | Two deployables, CORS/auth complexity, worse first load (no SSR) — needless for one user.                  |
| Native iOS app             | Best device integration, but 2–3× the build cost, App Store distribution for a single user, no web access. |

## Consequences

- Smallest mainstream full-stack runtime: measured ~46 KB gzip initial JS for the lightest
  route including the framework (docs/performance.md).
- First-class SSR, streaming `load`, form actions, and a built-in service worker pipeline.
- SvelteKit 3 is recent (3.0 released 2026-10-01); some ecosystem docs still describe 2.x
  (`$lib`, `$service-worker`, `svelte.config.js`). We pin versions and document the 3.x idioms.
- TypeScript is pinned to 6.x because SvelteKit 3 and typescript-eslint do not yet support
  TypeScript 7 (the native port).
