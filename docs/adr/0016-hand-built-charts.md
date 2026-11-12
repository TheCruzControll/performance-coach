# 0016 — Hand-built charts: lazy SVG for lines, HTML for marks, one SSR-guarded registry

- **Status:** Accepted (M6, 2026-11-12). Built as decided below: four bodies (`line`, `bar`,
  `range`, `diverging`) in `src/lib/ui/charts/bodies/`, loaded only through `CHART_BODIES`
  (`bodies.ts`), on Progress, exercise detail and both reviews. Two details came later:
  horizontal bars (range and diverging) share `RowList.svelte`, each row a 44 px button, and a
  body that fails twice while online reloads the page, because Chromium keeps a failed module
  fetch for the document's lifetime. The `pnpm budgets` check on `pc-chart-body` is m6-perf's
  (#413), still open on 2026-11-12.
- **Context:** Progress, exercise detail and the weekly and cycle reviews draw trends, stacked
  weekly totals, ranges and signed differences (PRD §10, §11), on an iPhone first and in a desktop
  window (§16). Every chart must read the same at 320 px and at 1440 px: a column is a column,
  not a smear, and a marker stays round. The routes that show charts already sit close to their
  initial-JS and render-blocking-CSS budgets (docs/performance.md), the owner reads them on a
  phone in the gym, and every chart needs a table alternative and a no-JavaScript state.

## Decision

- **No chart dependency.** The kit lives in `src/lib/ui/charts/`: pure scales (`scale.ts`:
  bars from zero, a nice domain for lines, 1-2-5 ticks, at most five, week and month slots) and
  a pure geometry model in percent of the plot box (`geometry.ts`: line and area paths, columns,
  stacks, markers, end labels with leaders, hit bands), both unit-tested.
- **Marks are split by what they need.** A stretched SVG cannot keep a pixel size, so:
  - the SVG draws only lines, areas and bands: a 0–100 viewBox, `preserveAspectRatio="none"`
    and 2 px `vector-effect: non-scaling-stroke` strokes;
  - every mark with a pixel size is an HTML box placed in percent and sized in CSS
    (`marks.css`): columns at most 24 px wide with a 4 px rounded data end, square at the
    baseline; a 2 px surface gap between stacked segments; 8 px markers with a 2 px ring; hit
    areas at least 24 px wide; tick labels.
  - Nothing measures the window or listens for resize, and hover sits inside
    `(hover: hover) and (pointer: fine)` (scripts/layout-rules.test.ts).
- **One registry, behind the SSR guard.** A chart body (the component that draws) lives in
  `src/lib/ui/charts/bodies/` and is imported only by `bodies.ts`, only as
  `import.meta.env.SSR ? never() : import('./bodies/X.svelte')`. So no body is in the server
  build, and SvelteKit never links a body's CSS into a page as render-blocking.
  `scripts/chart-body-imports.test.ts` refuses any other import, on the shared import walker.
- **The frame is server-rendered.** `ChartFrame` renders the title, a context caption (period ·
  comparison · estimated or measured · trend window), the one-sentence summary and the table twin
  (`ChartTable`, a `<details>` 'Show as table'), and reserves the plot box at its full height. The
  body loads after hydration and fades in; nothing moves. A failed chunk is a Notice with Retry;
  without JavaScript the plot says 'Chart needs JavaScript' beside the table.

## Alternatives

Measured in a scratch build of the same fixture, gzip:

| Option              | Cost         | Why not                                                                                                                        |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| uPlot               | about 20 KB  | Canvas: no HTML marks or per-mark accessible structure, sizes in device pixels read from the window, its own CSS to load.      |
| d3-scale + d3-shape | 12–15 KB     | Scales and paths only, which is the small part; the marks, layout and states are still ours to build, now on two vocabularies. |
| Chart.js            | about 70 KB  | Canvas, larger than a route's whole initial-JS headroom, resize listeners, and a look that fights the design system.           |
| Hand-built (this)   | the kit only | Only what the charts use: small pure scales and geometry, marks that follow docs/design-system.md, counted by pnpm budgets.    |

## Consequences

- Each chart is one body under `bodies/` and one registry entry; the frame, its states and the
  table twin come with it.
- Pixel specs hold at every width, measured in e2e (e2e/design-charts.e2e.ts at 320 and 393 px,
  the desktop spec at 1440 px), including on WebKit, whose non-scaling strokes and percent
  positions are covered by those measurements and screenshots.
- Interaction (crosshair, tooltips, arrow keys) is ours to build in the chart slices, on the hit
  bands and `nearestIndex`.
- m6-perf's `pnpm budgets` fails when the reserved class `pc-chart-body` reaches a route's initial
  JS or render-blocking CSS.
