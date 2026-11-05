# 0005 — Hand-built design system on CSS custom properties

- **Status:** Accepted (M1)
- **Context:** Design quality is a first-class requirement: premium, distinctive, dark-first,
  iPhone-first; explicitly not a stock component-library look (PRD §16). Performance budgets
  limit CSS to 20 KB gzip and initial JS to 60 KB gzip per route.

## Decision

- Tokens as CSS custom properties (`src/lib/ui/styles/tokens.css`): color (declared once with
  `light-dark()`), type scale, spacing, radii, elevation, motion, z-index, safe areas.
- Primitives as scoped Svelte components in `src/lib/ui/components/`; no Tailwind, no component
  library, no icon font (inline SVG set).
- Self-hosted variable fonts from `@fontsource-variable` (latin subset, woff2): Mona Sans (UI,
  numerals) and Hubot Sans (display). Both preloaded; metric-matched fallbacks.

## Alternatives considered

| Option                              | Why not                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| Tailwind CSS                        | Fast to build, but drifts to a generic look; utility soup in markup; explicitly out of scope. |
| shadcn-svelte / Skeleton / Flowbite | Recognisable library aesthetics; extra JS; harder to reach the bespoke feel.                  |
| CSS-in-JS                           | Runtime cost; Svelte's scoped styles already solve isolation.                                 |
| Google Fonts CDN                    | Third-party request + privacy; self-hosting enables preload and long caching.                 |

## Consequences

- Full control of look, motion and accessibility; total CSS measured at 15.3 KB gzip.
- We own accessibility behaviour (focus management, ARIA patterns) — covered by e2e tests.
- `light-dark()` sets a browser baseline of Safari 17.5+ / Chrome 123+ (acceptable for one
  owner on a current iPhone).
