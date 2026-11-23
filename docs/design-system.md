# Design system

Dark-first, iPhone-first, built by hand on CSS custom properties (ADR 0005). Live reference:
**`/design`** in the running app (also linked from Profile).

## Principles

1. **Glanceable under load.** Mid-set, sweaty, one hand: big numerals, high contrast, ≥ 44 px
   targets, primary actions in the thumb zone.
2. **Quiet neutral surfaces, one amber accent for the next thing to do.** Hueless greys, hairline
   borders, and amber on the one action that comes next. Discipline colours appear only as small
   signals (dots, tags, series).
3. **No boxes.** Space groups first, then a hairline between rows; a surface only for a sheet, a
   field, a chat bubble, a toast or a round control. No shadows and no gradients: depth comes from
   the tones (Instrument v2).
4. **Motion explains.** Short, spring-eased transitions that show where things came from; all
   motion collapses under `prefers-reduced-motion`.
5. **Every state is designed.** Empty, loading (skeletons, streamed data), error, offline.

## Theming

`src/lib/ui/styles/tokens.css` declares each colour once with `light-dark(<light>, <dark>)`.

| `<html>`              | Result                         |
| --------------------- | ------------------------------ |
| no `data-theme`       | **dark** (designed default)    |
| `data-theme="light"`  | light                          |
| `data-theme="system"` | follows `prefers-color-scheme` |

The choice (Profile → Appearance) is stored per device and applied before first paint by an inline
script in `src/app.html`, which also updates `<meta name="theme-color">`: `#0a0a0b` in dark and
`#f4f4f0` in light, the canvas of each theme. The manifest's `background_color` and `theme_color` are
`#0a0a0b`. With **Auto**, the app
keeps listening to `prefers-color-scheme` while open, so when iOS switches appearance (e.g.
automatic dark mode at sunset) the theme-color and status-bar metas follow the CSS (e2e-tested).
**Browser baseline:** `light-dark()` needs Safari 17.5+ / Chrome 123+.

## Colour

| Token                     | Dark                      | Light                     | Use                                                                 |
| ------------------------- | ------------------------- | ------------------------- | ------------------------------------------------------------------- |
| `--color-canvas`          | `#0a0a0b`                 | `#f4f4f0`                 | the page background on every board                                  |
| `--color-surface-1`       | `#151517`                 | `#ffffff`                 | the bottom sheet and dialogs; charts (see Data visualisation)       |
| `--color-surface-2`       | `#19191c`                 | `#ecece7`                 | fields, chat bubbles, toasts, the avatar, a quiet button in a sheet |
| `--color-surface-3`       | `#222226`                 | `#e2e2dc`                 | a control on a surface: the composer's send button, a stepper       |
| `--color-surface-inverse` | `#f2f2ee`                 | `#111113`                 | an inverted fill, with `--color-text-inverse` on it                 |
| `--color-overlay`         | `rgb(10 10 11 / 0.7)`     | `rgb(244 244 240 / 0.7)`  | the scrim behind a sheet                                            |
| `--color-glass`           | `rgb(10 10 11 / 0.92)`    | `rgb(244 244 240 / 0.92)` | the glass tab bar and the composer                                  |
| `--color-hairline`        | `rgb(255 255 255 / 0.07)` | `rgb(17 17 19 / 0.08)`    | between list rows, above the tab bar, the rail's right edge         |
| `--color-border`          | `rgb(255 255 255 / 0.08)` | `rgb(17 17 19 / 0.08)`    | a sheet's top edge                                                  |
| `--color-border-strong`   | `rgb(255 255 255 / 0.1)`  | `rgb(17 17 19 / 0.12)`    | focusable outlines; v2 has no bordered control                      |
| `--color-highlight`       | `transparent`             | `transparent`             | unchanged                                                           |
| `--color-text`            | `#f2f2ee`                 | `#111113`                 | titles, body, values, the active tab                                |
| `--color-text-secondary`  | `#a3a3a8`                 | `#55555c`                 | the date line, back links, text links, field labels                 |
| `--color-text-tertiary`   | `#86868e`                 | `#66666e`                 | inactive tabs, units, table heads, the composer's placeholder       |
| `--color-text-quiet`      | `#7a7a82`                 | `#6e6e76`                 | the letter of a day with nothing planned; canvas only               |
| `--color-text-disabled`   | `#55555c`                 | `#a9a9af`                 | the planned-day ring on the week strip; never readable text         |
| `--color-text-inverse`    | `#111113`                 | `#f2f2ee`                 | text on `--color-surface-inverse`                                   |
| `--color-accent`          | `#ffb02e`                 | `#ffb02e`                 | the one amber: primary fills and the "today" dot                    |
| `--color-on-accent`       | `#1a1200`                 | `#1a1200`                 | labels on an accent fill: Start, Done, Accept, Save                 |
| `--color-on-accent-muted` | `#3d2a00`                 | `#3d2a00`                 | secondary text on an accent fill, e.g. the selected day's letter    |
| `--color-accent-hover`    | `#ffbe55`                 | `#ffbe55`                 | hover on a fill (derived: the design draws no hover)                |
| `--color-accent-pressed`  | `#e89c1c`                 | `#e89c1c`                 | pressed (derived)                                                   |
| `--color-accent-text`     | `#ffb02e`                 | `#7a4e00`                 | amber as text; v2 never sets it, the token stays for existing uses  |
| `--color-accent-subtle`   | `rgb(255 176 46 / 0.12)`  | `rgb(135 86 0 / 0.12)`    | the tint behind an accent state                                     |
| `--color-accent-ring`     | `#ffb02e`                 | `#9a6400`                 | keyboard focus ring (≥ 3:1 on every surface)                        |
| `--color-positive`        | `#7fd49a`                 | `#1b7340`                 | not used in v2; kept                                                |
| `--color-warning`         | `#ffb02e`                 | `#7a4e00`                 | amber, always with a word                                           |
| `--color-danger`          | `#ff5a52`                 | `#bb2c28`                 | the field error line, the error toast's icon, Discard workout       |
| `--color-danger-subtle`   | `rgb(255 90 82 / 0.14)`   | `rgb(187 44 40 / 0.1)`    | the tint behind a danger state                                      |
| `--color-info`            | `#6cb6ff`                 | `#1b66b3`                 | not used in v2; kept                                                |

Neutrals are hueless greys (`#0a0a0b` to `#f2f2ee`). Borders are white alphas on dark and ink
(`#111113`) alphas on light: hairline 7% and 8%, border 8% and 8%, border-strong 10% and 12%. Light
is designed (board 15), not proposed.

Two contrast limits are accepted, not met, and the design draws them the same way. The accent
fill is 1.66:1 against the light canvas: amber cannot reach 3:1 on a light ground and stay amber.
Primary buttons carry their own label at 10.2:1, and selected segments sit inside a bordered
group, so the state is never carried by fill alone. Control borders (`--color-border-strong`) are
about 1.3:1 against the canvas in both themes: inputs and secondary buttons are identified by their
label and placeholder, so the text meets WCAG 1.4.11. The outline itself is faint.

Text, measured on the canvas (dark / light, WCAG): text 17.6 / 17.1; secondary 7.9 / 6.7; tertiary
5.5 / 5.2, and 4.9 / 4.8 on surface-2. Tertiary is 4.4 / 4.4 on surface-3, below AA, as it was
before #581, so it is never set on surface-3. `--color-text-quiet` (4.7 / 4.6 on the canvas) is
below 4.5:1 on surface-2 and surface-3, and on dark surface-1, so it is for the canvas only.

Discipline colours (signals only — never large fills):

| Token                  | Dark      | Light     |
| ---------------------- | --------- | --------- |
| `--color-strength`     | `#f2b544` | `#b37515` |
| `--color-running`      | `#46c2f0` | `#0b80b3` |
| `--color-combat`       | `#ff6a4d` | `#d2452a` |
| `--color-hypertrophy`  | `#b28dff` | `#7a4bd6` |
| `--color-conditioning` | `#3fd6b5` | `#0e9b7c` |

v2 shows no discipline colours: every chart is one series in `--color-text`, and `v2/14` decides
the charts' future.

Status: `--color-positive`, `--color-warning`, `--color-danger` (+ `-subtle`), `--color-info`.
All four are text-safe: ≥ 4.5:1 on canvas, surface-1 and surface-2 in both themes. Dark is
positive `#7fd49a`, warning `#ffb02e`, danger `#ff5a52`, info `#6cb6ff`; light is positive
`#1b7340`, warning `#7a4e00`, danger `#bb2c28`, info `#1b66b3`. Warning is its own token even
though it equals the accent in dark: the design's only warning is amber, and it is always paired
with a text label. On their own 12% tint (badges) the light theme darkens the text a further 18%.
Plate colours in the plate calculator follow the physical IWF convention on purpose.

`--color-track` (the unfilled part of a progress line, and a chart's baseline: `#2a2a2e` dark,
`#d4d4ce` light) and `--color-handle` (a sheet's grab handle, 36 × 4: `#3a3a3f` dark, `#c9c9c3`
light) are the two neutrals v2 adds.

## Data visualisation

Charts take their colours from the `--chart-*` tokens, never from the discipline signals above.
Colour is checked by computation, not by eye: `src/lib/ui/charts/palette.test.ts` reads
`tokens.css` and recomputes every check below in both themes on the chart surface
(`palette-check.ts`, ported from the dataviz palette validator: OKLab/OKLCH, Machado 2009
protan/deutan simulation, ΔE as OKLab ×100, WCAG contrast). A palette change that fails it does
not ship. The order and roles live in `src/lib/ui/charts/palette.ts`.

**Series**, in one fixed order for stacks, legends and table twins (`STACK_ORDER`):

| Token                  | Dark      | Light     |
| ---------------------- | --------- | --------- |
| `--chart-strength`     | `#c08600` | `#b37515` |
| `--chart-hypertrophy`  | `#9e79e9` | `#7a4bd6` |
| `--chart-conditioning` | `#00ac8d` | `#0e9b7c` |
| `--chart-combat`       | `#ef5b3f` | `#d2452a` |
| `--chart-running`      | `#0da0cd` | `#0b80b3` |

- Light uses the discipline values. Dark is stepped into the dark lightness band (OKLCH L
  0.48–0.67): the dark signals sit at L 0.71–0.81, too light to read as marks of equal weight.
- Each series: inside the band, chroma ≥ 0.10, ≥ 3:1 on the surface. Each neighbour in the
  order: CVD ΔE ≥ 8 and normal-vision ΔE ≥ 15. Measured: worst neighbour CVD 11.1 dark and 10.3
  light; normal-vision floor 25.6 dark and 28.3 light.
- Colour follows the discipline, never its rank: a chart without some disciplines keeps the
  order and leaves them out. Strength and combat collapse under deuteranopia (ΔE 2.3), so they
  are never neighbours in the order, and every series is labelled in words.
- A series colour is never a status colour (each pair at least ΔE 2 apart; status always carries
  an icon and a word). M1's dark strength is ΔE 2.25 from warning, just above the floor of 2,
  one more reason charts use their own steps.

**Diverging pair**, for a signed difference from a target (actual minus target RPE): cool below,
warm above, a grey with no hue at zero, so on target reads as nothing to see.

| Token                  | Dark      | Light     |
| ---------------------- | --------- | --------- |
| `--chart-diverge-cool` | `#4f78e8` | `#3f74e6` |
| `--chart-diverge-warm` | `#d9507a` | `#c63d6b` |
| `--chart-diverge-mid`  | `#74747a` | `#86867f` |

- The poles: ≥ 3:1, normal-vision ΔE 27.7 light and 26.6 dark, CVD 19.9 and 17.3 (floors 15 and
  8). The midpoint: chroma < 0.02, 3.66:1 light and 3.93:1 dark.
- Each pole is at least ΔE 8 from every status and series colour (closest: light warm against
  danger, 8.6; dark warm against combat, 9.6). The pair never shares a chart with discipline
  series, and a status shown beside it is labelled in words.

**Furniture** (everything that is not data):

| Token              | Dark      | Light     | Use                                                    |
| ------------------ | --------- | --------- | ------------------------------------------------------ |
| `--chart-surface`  | surface-1 | surface-1 | what every chart sits on                               |
| `--chart-muted`    | `#6b6b71` | `#8b8b85` | a context series beside the one in colour (≥ 3:1)      |
| `--chart-grid`     | `#1f1f23` | `#ebebe6` | hairline gridlines                                     |
| `--chart-axis`     | `#2a2a2e` | `#d4d4ce` | axis rules and ticks                                   |
| `--chart-baseline` | `#55555c` | `#a3a39d` | the zero line marks stand on                           |
| `--chart-band`     | `#19191c` | `#f4f4f0` | the fill behind a target range or a highlighted period |

All greys. Grid, axis and baseline stand out in that order and stay below 3:1, so they never read
as data.

**Rules for every chart:**

- **Emphasis before colour.** One series in colour, the rest in `--chart-muted`; past that,
  **small multiples** (one small chart per discipline on a shared scale) before more hues.
- **One axis.** Never a dual axis; two measures of different scale are two charts.
- **Estimated against measured.** Hollow rings for estimated values (e1RM from a set), square
  diamonds for measured ones (a tested max), so the kind never rests on colour.
- **The week in progress** is marked 'so far': a dashed ring on lines, an outlined column on bars,
  labelled in words.
- **Table twins.** Every chart ships its title, a one-sentence summary and a `<details>` table of
  the same numbers, rendered on the server; without JavaScript the plot says 'Chart needs
  JavaScript' and the table still reads.
- **Text never wears a series colour.** Values, labels, legends and tick labels use the text
  tokens; a coloured mark beside them carries identity.
- **Surfaces.** Charts sit on surface-1 (`--chart-surface`: `#151517` dark, `#ffffff` light), never
  surface-2: light conditioning is 2.95:1 on surface-2. v2 draws its charts on the canvas; moving
  them is open (`v2/14`, which re-runs the palette checks).
- **Motion.** Marks do not animate in. Hover and scrub feedback uses `--duration-fast`, a
  refetch keeps the previous frame at reduced opacity with `aria-busy`, and under
  `prefers-reduced-motion` nothing moves.
- **HTML marks** ([ADR 0016](adr/0016-hand-built-charts.md)). The SVG draws only lines, areas and
  bands: a 0–100 viewBox stretched to the plot box, 2 px `non-scaling-stroke` lines. Every mark
  with a pixel size is an HTML box placed in percent and sized in CSS (`ui/charts/marks.css`), so
  it reads the same at 320 px and at 1440 px: columns at most 24 px wide with a 4 px rounded data
  end, square at the baseline; a 2 px surface gap between stacked parts; 8 px markers with a 2 px
  ring; hit areas at least 24 px; tick labels. Nothing measures the window, and hover rules sit
  inside `(hover: hover) and (pointer: fine)`.
- **Every mark is reachable.** A line chart is one tab stop whose arrow keys move the week, read
  by a polite live region; a bar chart's marks and a row chart's rows (`RowList`, each row a 44 px
  button) take the tab stop in turn (roving), with Home, End and Escape. A tap, hover or focus
  shows the same words as the mark's name, in a tooltip kept inside the plot.
- **Forced colours.** Marks become `CanvasText`; stacked parts alternate 45° and 135° hatches,
  which the legend repeats; sides and statuses stay in words.
- **'So far' everywhere.** The week in progress is never in a total, a mean or a verdict: tiles
  give it as 'This week so far' against the same days of last week, charts as a dashed ring or an
  outlined column, and table twins as a row marked 'so far'.

## Typography

Mona Sans sets all text and every numeral. Hubot Sans sets the one display line on a screen (the
display, title, statement and sheet-title roles below), and never a numeral. There is no mono type
and no uppercase: no `text-transform` appears on the page, except the recovery-code input, which
uppercases what is typed.

| Role                          | Family     | Size / line-height (px)     | Weight           | Tracking |
| ----------------------------- | ---------- | --------------------------- | ---------------- | -------- |
| Display line (hero)           | Hubot Sans | 56 / 60                     | 600              | −0.035em |
| Page title                    | Hubot Sans | 40 / 44                     | 600              | −0.03em  |
| Statement (finding, question) | Hubot Sans | 32 / 38                     | 600              | −0.025em |
| Sheet title                   | Hubot Sans | 26 / 32                     | 600              | −0.02em  |
| Body / paragraph              | Mona Sans  | 17 / 26                     | 400              | 0        |
| Row (list title and value)    | Mona Sans  | 17 / 22                     | 400              | 0        |
| Button label                  | Mona Sans  | 17 / 22                     | 600              | 0        |
| Secondary line / link         | Mona Sans  | 15 / 22                     | 400              | 0        |
| Row label in a table          | Mona Sans  | 15 / 18                     | 400              | 0        |
| Caption                       | Mona Sans  | 13 / 18                     | 400              | 0        |
| Day letter                    | Mona Sans  | 13 / 16                     | 400 (600 today)  | 0        |
| Tab label                     | Mona Sans  | 12 / 16                     | 400 (600 active) | 0        |
| Numeral XL (set, rest clock)  | Mona Sans  | 112 / 104 (clock 112 / 112) | 600              | −0.04em  |
| Numeral L                     | Mona Sans  | 64 / 68                     | 600              | −0.04em  |
| Numeral M                     | Mona Sans  | 56 / 64                     | 500              | −0.035em |
| Numeral pace                  | Mona Sans  | 44 / 56                     | 500              | −0.03em  |
| Unit beside a numeral         | Mona Sans  | 24 / 32                     | 400              | 0        |

Two Mona Sans sizes sit beside the roles: a run segment's name ("Intervals") is 40 / 44, 600,
−0.03em, and plate counts ("25 · 15") are 32 / 38, 600, −0.025em. The sign-in screen's display line
is Mona Sans too, as drawn in Paper, not Hubot.

Numerals that update in place or line up in columns use `.tabular` (`tabular-nums`). Mona Sans is
proportional by default, so `.numeric` (a standalone value) sets `proportional-nums`. Paper cannot
set tabular numerals in these fonts without a slashed zero, so the design shows none.

Scale (`--text-*`, px): 2xs 12 · xs 13 · meta 15 · sm 15 · ui 17 · base 17 · lg 19 · xl 24 · 2xl 26 ·
3xl 32 · 4xl 40 · 5xl 56 · 6xl 64 · 7xl 112 · pace 44. Names are kept across components, so a name
can carry a different size from the one it had: `--text-meta` and `--text-sm` are both 15, and
`--text-ui` and `--text-base` are both 17. Inputs are never below 16 px (prevents iOS zoom).

Line heights: `--leading-none 1`, `--leading-tight 1.1` (40 px titles), `--leading-snug 1.1875`
(32 px statements), `--leading-normal 1.53` (17 px body). Display lines and numerals take their
line height from their role token.

Weights: `--weight-regular 400`, `--weight-medium 500` (numeral M and pace), `--weight-semibold 600`
(every display, title, statement and sheet title; button labels; numerals XL and L; the active tab
and today). `black 800` is unused. `bold 700` stays on a few titles and numerals (`PageHeader`,
`WorkoutHeader`, `NumberStepper`, `ExerciseCard`) until their screen rows move them to 600.

Tracking: `--tracking-hero -0.04em` (numerals XL and L), `--tracking-display-lg -0.035em` (the 56 px
display line and numeral M), `--tracking-display -0.03em` (40 px titles and pace),
`--tracking-statement -0.025em` (32 px statements), `--tracking-tight -0.02em` (26 px sheet titles),
`--tracking-normal 0` everywhere else.

### Role tokens

Each role is one `font` shorthand in `src/lib/ui/styles/tokens.css`, so no screen re-derives a size:

```css
--type-display: var(--weight-semibold) var(--text-5xl) / 1.0714 var(--font-display);
--type-title: var(--weight-semibold) var(--text-4xl) / 1.1 var(--font-display);
--type-statement: var(--weight-semibold) var(--text-3xl) / 1.1875 var(--font-display);
--type-sheet-title: var(--weight-semibold) var(--text-2xl) / 1.2308 var(--font-display);
--type-body: var(--weight-regular) var(--text-base) / 1.5294 var(--font-sans);
--type-row: var(--weight-regular) var(--text-ui) / 1.2941 var(--font-sans);
--type-button: var(--weight-semibold) var(--text-ui) / 1.2941 var(--font-sans);
--type-button-lg: var(--weight-semibold) var(--text-lg) / 1.2632 var(--font-sans);
--type-secondary: var(--weight-regular) var(--text-sm) / 1.4667 var(--font-sans);
--type-caption: var(--weight-regular) var(--text-xs) / 1.3846 var(--font-sans);
--type-tab: var(--weight-regular) var(--text-2xs) / 1.3333 var(--font-sans);
--type-numeral-xl: var(--weight-semibold) var(--text-7xl) / 0.9286 var(--font-numeric);
--type-numeral-l: var(--weight-semibold) var(--text-6xl) / 1.0625 var(--font-numeric);
--type-numeral-m: var(--weight-medium) var(--text-5xl) / 1.1429 var(--font-numeric);
--type-numeral-pace: var(--weight-medium) var(--text-pace) / 1.2727 var(--font-numeric);
--type-unit: var(--weight-regular) var(--text-xl) / 1.3333 var(--font-sans);
```

The `font` shorthand resets `font-variant-numeric`, and it also overrides a class set on the same
element. So set `font-variant-numeric` (or `.tabular`) after `font`, and set the tracking token
from the same role as `letter-spacing`.

### Labels

There is no label style. The small line above a title is a plain secondary line: `.eyebrow`
(`src/lib/ui/styles/base.css`) is the `secondary` role in `--color-text-secondary`, Mona Sans 15 / 22,
weight 400, with no transform and no tracking. v2 screens remove most of these ("no small label
above a heading"). Field labels use the same secondary role; a table's column heads use the
caption role in tertiary.

### Fonts: loading strategy

- Self-hosted from `@fontsource-variable/{mona-sans,hubot-sans}` (5.3.0, OFL-1.1, devDependencies).
  Vite emits the woff2 files that `src/lib/ui/styles/fonts.css` references. The latin `wght` files
  are Mona Sans 39.8 KB and Hubot Sans 48.3 KB; their latin-ext files sit behind a `unicode-range`
  and are fetched only when needed. The weight axis is declared as `200 900`.
- Only the **Mona Sans latin** file is preloaded (one file, 39.8 KB): every screen paints its text
  and its numerals in Mona Sans. Hubot Sans swaps in behind its metric-matched fallback. The policy
  is in `src/lib/ui/fonts.ts` and applied in `hooks.server.ts`; the budget is ≤ 2 preloaded files
  (`pnpm budgets`).
- Metric-matched fallbacks: `Mona Sans Fallback` → local Arial/Helvetica (`size-adjust` 105%,
  `ascent-override` 103.8%, `descent-override` 30.5%, `line-gap-override` 0%), and
  `Hubot Sans Fallback` → local Arial/Helvetica (`size-adjust` 102%, `ascent-override` 106.9%,
  `descent-override` 31.4%, `line-gap-override` 0%). They are computed with fontTools at weight 400:
  the average advance over an English sample, and the hhea ascent, descent and line gap. The
  Mona and Hubot faces are not yet re-measured for CLS: re-measure on the audited routes
  (docs/performance.md).

## Space, shape, depth, motion

- **Spacing** (4 px grid): `--space-0-5` 2 · `1` 4 · `1-5` 6 · `2` 8 · `2-5` 10 · `3` 12 · `3-5` 14 ·
  `4` 16 · `4-5` 18 · `5` 20 · `6` 24 · `7` 28 · `8` 32 · `9` 36 · `10` 40 · `11` 44 · `12` 48 ·
  `14` 56 · `16` 64 · `20` 80 px. Page gutter `--gutter` 20 px for now. Every v2 phone board pads its
  content 28 px (`--space-7`); the gutter takes it with the shell in `v2/03`.
- **Radii:** 2 handle and segments · 14 fields · 16 buttons and toasts · 18 the workout's Done ·
  20 bubbles · 28 sheets and the composer · full avatar and dots; no card radius, v2 has no cards.
  The tokens are `--radius-xs`, `-sm`, `-md`, `-lg`, `-xl`, `-action-lg` and `-full`.
- **Elevation:** flat. `--elevation-1/2/3` and `--glow-accent` are transparent zero shadows
  (`0 0 0 0 transparent`), so components can list them in a longer `box-shadow`. Depth comes from the
  surface tones and the hairline borders; the primary CTA has no glow.
- **Motion:** `--duration-instant 90ms · fast 160 · base 240 · slow 380 · slower 560`;
  `--ease-standard`, `--ease-out`, `--ease-in`, and `--ease-spring` (CSS `linear()` spring) for
  thumbs and indicators. `prefers-reduced-motion` sets durations to 0 and disables shimmer.
- **Glass:** `--color-glass` (92% canvas) + `backdrop-filter: saturate(180%) blur(32px)` on the
  bottom nav and the coach composer (opaque and blurred enough that text scrolling behind a tab
  label cannot be read). The sheet scrim has none: a blur under its fade is redrawn every frame.
  Write only the standard `backdrop-filter`; Lightning CSS adds `-webkit-backdrop-filter` for the
  Safari build targets.
  (Writing both, standard first, makes the minifier keep only the prefixed one, which Chromium
  ignores.) `pnpm budgets` fails if a
  built rule ships a `-webkit-` property without its standard twin, and e2e asserts the nav's
  computed `backdrop-filter`. Judge glass on a device, not on e2e screenshots, which can show
  text through the nav (see docs/testing.md).
- **Layers:** `--z-raised 10 · sticky 50 · nav 100 · overlay 200 · sheet 210 · toast 300`.
- **Safe areas:** `--safe-top/right/bottom/left` from `env(safe-area-inset-*)`;
  `viewport-fit=cover`. Installed on iOS, the status bar is `black-translucent` (white text over
  the dark canvas) and switches to `default` (dark text) when the light theme applies: the inline
  theme script sets it before iOS reads it at launch, and changing the theme updates it for the
  next launch. Not yet verified on a device (no iOS/WebKit available while building M1).

## Layout

- App shell: content column `--content-column` (34 rem on a phone, 40 rem from 640 px) with
  safe-area-aware gutters; fixed **bottom navigation** (Today · Train · Progress · Coach ·
  Profile), glass background, 58 px tall + home-indicator inset, a left rail from 1024 px
  (Responsive layout → Shell); `aria-current="page"` on the active tab; tabs cross-fade with the
  View Transitions API (the `root` snapshot fades while the named nav stays put).
  Never put a `view-transition-name` on an ancestor of a glass surface: it becomes a backdrop
  root and the blur silently stops working.
- Every app screen fits a 393 × 659 iPhone viewport without sideways scrolling, and nothing
  important sits under fixed chrome at rest (Coach suggestions end above the composer; both
  landing CTAs are above the fold). `e2e/shell.e2e.ts` asserts all three.
- Failure states keep the shell: offline and error screens render inside it with the screen's
  title (`src/routes/ErrorView.svelte`), and a connectivity notice appears while offline.
- Large titles (`PageHeader`): eyebrow + 32 px display title, iOS-style.
- Toasts appear at the top (clear of the thumb zone and nav); sheets rise from the bottom, and
  open as centred dialogs from 1024 px (Responsive layout → Dialogs & toasts).

## Responsive layout

iPhone-first, and laid out for a desktop window too, never as a stretched phone layout (PRD §7,
§16). `scripts/layout-rules.test.ts` enforces the rules marked **(guard)** on every stylesheet and
on the browser code, naming the file, the line and the fix; `e2e/desktop.ts` holds the helpers
that specs verify the rest with.

### Widths & tokens

- Three widths: **phone** below 640 px (the default every rule starts from), **tablet** 640–1023
  px, **desktop** from 1024 px.
- Media queries use only `(width >= 40rem)`, `(width >= 64rem)`, `(width < 40rem)`,
  `(width < 64rem)` and `(40rem <= width < 64rem)` **(guard)**; `min-width`, `max-width`, other
  values, height and orientation queries fail. They are written out, because custom properties
  cannot be used inside `@media`, and in rem, so a larger default text size moves to the narrower
  layout (WCAG reflow). Lightning CSS rewrites the range syntax to `min-width` for the build
  targets.
- Components adapt to their container with `@container`, not to the window.
- Layout changes only in CSS **(guard)**: SSR paints the final layout, nothing shifts when the page
  hydrates, and no route gains JavaScript for it. `matchMedia` and Svelte's `MediaQuery` ask only
  `prefers-reduced-motion`, `prefers-color-scheme` or `display-mode`; nothing reads `innerWidth`,
  `innerHeight`, `outerWidth`, `outerHeight`, `visualViewport` or `screen.width`/`height`, or
  listens for `resize` (`<svelte:window bind:innerWidth>` and `onresize` included). Allowed:
  `@container`, `@supports`, `prefers-*`, `display-mode`, `forced-colors`, `print` and the CSS
  `resize` property.
- Tokens (`tokens.css`):
  - `--content-max` 34 rem: the phone column.
  - `--content-readable` 40 rem: the readable column from 640 px.
  - `--content-wide` 72 rem: a wide screen's content.
  - `--content-list` 20 rem: the list beside its editor on a split screen.
  - `--rail-width` 5.5 rem: the navigation rail from 1024 px.
  - `--rail-mark` 2.25 rem: the brand mark atop the rail.
  - `--content-column`: the shell's column, which screen chrome is centred over: `--content-max`,
    and `--content-readable` from 640 px.
  - `--nav-inset-bottom`: what fixed chrome clears at the bottom: in the shell, the bottom bar and
    the home indicator (`--nav-height` + `--safe-bottom`), and the home indicator alone from
    1024 px; `0px` outside the shell (set under `:root:has(.app-nav)`).
  - `--nav-inset-left`: what it clears at the left: `0px`, and in the shell the rail and the left
    safe area from 1024 px.
  - `--resume-inset`: the resume bar's room while it shows, `0px` otherwise; in the shell
    `--nav-inset-bottom` includes it, so the content and all bottom chrome clear the bar.

### Content width

A screen declares its width with `data-layout` on its root element:

- **readable**, the default: forms, text, settings (Security), conversations (Coach). The column
  is `--content-readable` from 640 px; the phone column stays `--content-max`.
- **wide**: dashboards and grids, up to `--content-wide`.
- **split**: a list and its editor, `--content-list` beside a readable detail.
- Never a single text column wider than `--content-readable`.

### Shell

`AppNav` is one `<nav>` at every width, restyled by CSS, so its five destinations, their order,
links and `aria-current` cannot differ between widths. `e2e/shell.desktop.e2e.ts` verifies the
shell at 1440 × 900 and the widths around it.

- **Below 1024 px** the glass bottom bar, unchanged. On a tablet (640–1023 px) only the column
  widens, from 34 to 40 rem.
- **From 1024 px** a solid left rail, `--rail-width` (88 px) plus the left safe area, on
  `--color-surface-1` with a hairline right border and no blur. Items are stacked icon above
  label, each at least 56 px tall, with a hover tint for fine pointers and the focus ring inside
  the item. Nothing is fixed to the bottom edge. A rail rather than a labelled sidebar: the five
  labels are short, and it leaves the most width at 1024 px (a sidebar would be CSS only).
- **The brand mark** tops the rail: two masked pseudo-elements of the nav (`layout.css`) fill
  `static/brand/mark-track.svg` with `--color-text` at 18% and `static/brand/mark-arc.svg` with
  `--color-accent`. They are the favicon's two strokes on no background, in amber here while the favicon is still lime (see known issues); the favicon's opaque
  dark tile can be neither a mask nor a themed image. The mark follows the theme with no markup
  and no script, and the service worker precaches both files with the other static files, so it
  renders offline.
- **Order.** The nav comes before `<main>`, after the skip link, so on a desktop window Tab goes
  skip link → rail → content, as the eye reads it, and the skip link skips past the rail into
  the content. On an iPhone nothing moves, but VoiceOver reads the tab bar before the content.
- **Content.** `<main>` is `--content-column` wide, centred beside the rail; a screen that
  declares `data-layout="wide"` or `"split"` widens it to `--content-wide` from 1024 px
  (`layout.css`). Screen chrome follows the column through the insets and `--content-column`,
  so no screen file needs an edit; outside the shell the insets are `0px`, so a toast on
  `/design` is centred in the window.
- **CSS only**, so no route gains initial JS for the layout. The shell's own stylesheet (`AppShell`
  with `AppNav`) is inlined into every app page while it stays under SvelteKit's
  `inlineStyleThreshold` (4,096 characters, `vite.config.ts`). `scripts/check-budgets.ts` fails
  if it is ever linked instead, so page-agnostic shell rules go in `src/lib/ui/styles/layout.css`.

### Fixed and sticky chrome

Two kinds, and neither is offset by `--nav-height` **(guard)**: only `tokens.css` and the nav
itself read it.

- **Screen chrome** belongs to a whole readable screen (Coach's composer; a section's Save bar
  below 1024 px) or to the app (toasts). It is `position: fixed` at
  `bottom: var(--nav-inset-bottom)` (toasts keep their top inset), centred with
  `left: calc(50% + var(--nav-inset-left) / 2)` and `translateX(-50%)`, and at most
  `var(--content-column)` wide. Only readable screens have it at the bottom.
- **Column chrome** belongs to one column of a wide or split screen (an editor's Save bar, Build's
  "Start week 1", a session's actions). From 1024 px it is `position: sticky` at
  `bottom: var(--nav-inset-bottom)`, the last child of its column, with no left offset and no
  transform, so it takes the column's width and never covers another column. No ancestor up to the
  column sets `overflow`. Below 1024 px the column is the whole content, so it may stay screen
  chrome.
- **The resume bar** (`(app)/ResumeBar.svelte`) is the app's own screen chrome: fixed and
  centred over the column like a composer, above the tab bar below 1024 px and at the bottom of
  the content column beside the rail from there. It sits under `--resume-inset`, so the shell's
  bottom padding and every other bottom chrome rise with it and it covers nothing.
- **The held screen** (`(app)/HeldScreen.svelte`) covers the column, not the window: fixed
  under the nav from `--safe-top` and `--nav-inset-left`, the content column's width inside, so the
  screen being left keeps its layout and scroll underneath.
- Specs check chrome against the element it belongs to, never against `<main>` for a column:
  `expectCentredOver(page, chrome, area)` for screen chrome and
  `expectInColumn(page, chrome, column, others)` for column chrome. A screen that later turns
  from readable to split then keeps its specs green.

### Density

Density comes from columns, not from smaller targets or type: targets stay at least 44 px and the
type scale is the same at every width, because a 1024–1366 px window can be a touch iPad.

### Pointer & hover

- Hover styles live only inside `@media (hover: hover) and (pointer: fine)` **(guard)**: a bare
  `:hover`, `(hover: hover)` alone, `(pointer: coarse)`, `any-hover` and `any-pointer` fail. The
  iPhone has no hover, and a touch laptop or an iPad never gets a hover state that sticks.
- Hover is never the only cue: what it shows is also there on focus or press.
- Every interactive primitive has one: buttons and icon buttons tint, rows and cards strengthen
  their border, an unselected tab gets a tinted pill, a choice or a day not yet picked lifts to
  `--color-surface-3` with a stronger border, a switch that is off strengthens its track's border,
  and a picked day or a switch that is on takes `--color-accent-hover`. Native controls drawn by a
  face (`ChoiceGroup`, `DayPicker`, `Toggle`) cover it, so the whole face shows the pointer cursor
  and takes the click.
- A mouse never drags a sheet: only a finger or a pen swipes it down. Touch targets keep 44 px
  at every width (hit areas reach past a control's 1 px border).

### Keyboard & focus

- The skip link comes first and moves focus to `<main>`.
- Focus order matches reading order and visual order.
- Every interactive element shows a visible `:focus-visible` ring, at least 2 px. Fields draw
  theirs as a 3 px shadow over a transparent 2 px outline: forced colours (Windows contrast
  themes) drop shadows and draw the outline instead.
- Escape closes the top dialog only; arrow keys move inside composite controls.
- No keyboard traps, and no shortcuts that take over typing keys.

### Dialogs & toasts

- Below 1024 px a `BottomSheet` rises from the bottom with its handle, and a swipe down closes
  it.
- From 1024 px the same `<dialog>` opens centred in the window: `min(100% − 2 gutters, 32rem)`
  wide, at most `min(85dvh, 48rem)` tall with its content scrolling inside under the title, every
  corner rounded and bordered all round. It fades in as it rises 8 px, and has no handle. The
  focus trap and Escape are the platform's; the backdrop and focus return work as on a phone.
- Stacked dialogs (Security's step-up over Remove passkey) stay usable: the top one is on top,
  holds focus, and is the only one Escape closes; focus then returns into the one below. When the
  button that opened a dialog cannot take focus back (it was disabled while it worked), focus
  returns to the dialog underneath.
- Toasts stay at the top as screen chrome.

### Screens

One line per screen as its desktop layout lands (the auth screens, the main screens, then each
later-pass screen).

- **Auth screens** (`AuthScreen`: `/`, `/setup`, `/recover`, `/recover/passkey`): from 1024 px
  `<main>` itself is a two-column grid (never `display: contents`: the skip link's target keeps
  its box). The brand, the headline and the footer sit at the left; the body and the panel sit at
  the right as one `--color-surface-1` card, 28 rem wide and vertically centred, with every notice
  and error inside it. The frame is at most `--content-wide`, and the watermark is larger and stays
  inside it. Tablets keep the phone's column, pinned to the thumb zone, at `--content-readable`,
  the watermark fading out before the frame's edge. CSS only: no route gains initial JS.
- **Session** (`/train/session/[key]`): wide. From 1024 px the title and chips span the content;
  a side column (the edits, the details, the baseline callout; at least `--content-list`) sits
  left of the main column (the exercises, the run, a class's metrics; at most
  `--content-readable`), side first as in the markup, so Tab and the eye agree. An older
  version's banner tops the main column, and the edit sheets open as centred dialogs. Below
  1024 px the columns are `display: contents`, so the phone's order is unchanged.
- **History** (`/train/history/[[version]]`): split. From 1024 px the versions, with 'Show older
  versions' and its Retry at their foot, sit beside the version picked (`aria-current`), which
  stays in the URL; with none picked, a 'Pick a version' card (or 'No changes yet') takes its
  place. A version's load carries the list's first page, and pages loaded in place are kept
  while versions are picked. Below 1024 px a version stands alone, as on a phone.
- **Program detail components**: `ExerciseBlock` (the coach's words beside the sets),
  `RunSegments` (each segment on one line), `SessionDetails` (a class's stats beside its metrics)
  and `BaselineCallout` (the steps beside the why) adapt from 35 rem with container queries,
  above the phone column, so the iPhone is unchanged.
- **Progress** (`/progress`): wide (`data-layout="wide"` on its root). From 1024 px the view nav
  and the period picker share one row over the view; the overview's five trend tiles keep one row,
  and its discipline cards and chart frames pair up from a 44 rem column (a container query).
- **Reviews** (`/progress/reviews/[[key]]`): split. From 1024 px the reviews list (the block to
  review, the cycle reviews, then every week, a Create button on each one not yet reviewed)
  beside the review shown (`aria-current`), or beside 'Pick a review'; every section of a review
  shows in full, with nothing to open. Below 1024 px the list and a review are separate screens,
  with 'All reviews' back to the list, opening a review focuses its title, and each section
  collapses to its verdict line.
- **Exercise detail** (`/progress/exercises/[id]`): wide. From a 44 rem column (a container
  query) the e1RM tile sits beside its context, the e1RM chart beside the rep-max table, and the
  PRs beside the top sets and RPE; the recent sessions fill rows of cards. From 1024 px the period
  picker keeps 24 rem.
- **Coach** (`/coach`): readable, as a conversation should be. From 1024 px the suggestions sit in
  two columns; the composer is screen chrome, centred over the column.
- **Security** (`/profile/security`): readable, a settings screen, and left as it is (its route
  has the least initial-JS headroom). Its four sections and Sign out read, and Tab, in order.
- **Design gallery** (`/design`, outside the shell): from 1024 px up to `--content-wide`, its
  groups in pairs (Color beside Type, Components beside Cards & tones, Charts beside Workout), each
  about a phone column wide so no specimen stretches; the header and the icon grid span both, with
  larger cells.
- **Error and offline states** (`ErrorView`): inside the shell they stay in the readable column;
  outside it they are centred in the window at `--content-readable`.
- **Profile** (`/profile`): wide. From 1024 px two columns, read row by row as on a phone: the
  account (identity, Security, preferences) beside the training profile's sections, the system's
  status under the account.
- **Profile sections** (`/profile/[section]`): split. From 1024 px `SectionList` (the sections,
  the open one `aria-current`) beside the editor in the readable column; Back is hidden. The
  skeleton reserves the window's height below the title, so Save starts at the window's foot and
  stays put when the editor arrives. Save is column chrome at the editor column's foot. Below
  1024 px: list → editor → Back, the 28 rem skeleton and the fixed Save bar.
- **Onboarding** (`/onboarding/[[step]]`): outside the shell. From 1024 px each step is a
  `--color-surface-1` card centred in the window, `--content-readable` wide and as tall as the
  window allows (capped at 52 rem), so moving on moves neither the card nor its actions. The
  progress bar runs across its top edge, with Finish later above the form; the form scrolls
  inside the card when it is taller than the room; Back, Skip and Continue close the card in a
  row under the form (after it in the focus order too), never pinned to the window, and the offline or no-goal notice sits in that row above them, taking focus. The
  review declares `wide` and `ProfileSummary` pairs its blocks (a container query). Phones and
  tablets keep one column with the actions sticky at its foot.
- **Train** (`/train`): wide. From 1024 px the program header and the week strip span the
  content; the selected day's sessions sit in a main column at most `--content-readable` wide,
  beside the week's brief and then the tools (at least `--content-list`), and a state card sits
  where the sessions would. The week is a subgrid of the screen, so it keeps its own busy state;
  the error and offline states keep the readable column. `WeekStrip` (taller tiles from 35 rem,
  outlined from 56 rem), `SessionCard` (badges at the end from 35 rem) and `ProgramHeader`
  (actions beside the titles from 48 rem) adapt with container queries above the phone column,
  so the iPhone is unchanged. CSS only: one selected day, as on a phone.
- **Today** (`/today`): wide. From 1024 px the week runs across the top (M2's week, or the plan's
  `WeekStrip`, a subgrid row that holds its room while the plan loads); the state's panel (setup,
  Build, the plan, or its skeleton or Retry) takes a main column at most `--content-readable`
  wide, beside This week, the tools and the goals (at least `--content-list`). Build my program
  spans both: week 1 in the main column with Start week 1 as its column chrome, the block
  timeline beside it. A failed read and offline keep the readable column. CSS only.
- **Workout pages** (`/workout`, `/workout/run`, `/workout/session`; outside the shell): from
  1024 px the header spans the page in one row, and below it the Shell's two columns are centred:
  the side column (`--content-list`: `ExerciseList` for strength, the segments for a run, sticky)
  beside the main column (at most `--content-readable`: the current exercise, its sets and the
  logger as a card under them). The rest timer docks at the top of the main column under the
  header, over nothing, first in the DOM. A session, the start flow and every state screen keep one
  readable column, centred. Below 1024 px one column, the logger and the rest pill in the thumb
  zone (The workout screen).
- **Workout history** (`/progress/workouts/[[id]]`): split. From 1024 px the list (waiting to sync,
  then completed) beside the picked workout's detail on the same route (`aria-current`); with
  none picked, a calm 'Pick a workout' card. Below 1024 px the list and the detail are separate
  screens, and opening one moves focus to the detail's title. An exercise's name opens its history
  as a centred dialog.

### Verification

- Every UI slice is designed and verified at **393 × 659** (the iPhone projects) and at
  **1440 × 900** (`test.use(DESKTOP)` from `e2e/desktop.ts`, or a `*.desktop.e2e.ts` spec), and
  its PR attaches both screenshots.
- A desktop spec checks that nothing scrolls sideways (`expectNoSideScroll`, at `DESKTOP_WIDTHS`
  and at `BELOW_DESKTOP_WIDTH`, 1023 px, where the layout changes), its chrome against the element
  the chrome belongs to, and that a swap moves nothing with
  `expectNoShift(page, { action, boxes })`, never `layoutShiftDuring` alone: WebKit reports no
  layout-shift entries, so `layoutShiftDuring` throws there and `expectNoShift` checks the named
  boxes, with an annotation.
- A screen in the shell checks `<main>` against the rail, never the window, at the width its
  `data-layout` declares, read from the token rather than written as a number:
  `expectMainCentred(page, await tokenPx(page, '--content-readable'))` (or `--content-wide`).
- `*.desktop.e2e.ts` specs run in the `desktop-chromium` project (1440 × 900), not in the iPhone
  projects; a serial spec's desktop cases use `test.use(DESKTOP)` and run on Chromium and WebKit.
  There is no desktop WebKit project (the owner's desktop browser is Chrome; docs/testing.md).

## Components (`src/lib/ui/components`)

| Component           | Highlights                                                                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`            | `primary · secondary · ghost · danger`, `sm · md · lg` (36/48/56 px; hit area always ≥ 44 px), leading/trailing icon, `loading` (keeps width, `aria-busy`), `block`, renders `<a>` with `href`; pressed = scale 0.97 + tone.                                                       |
| `IconButton`        | Circular, required `label` (accessible name), `ghost · filled · accent`, `sm · md · lg`; `tooltip` captions it with the label on hover and keyboard focus (fine pointers only).                                                                                                    |
| `Icon`              | Inline SVG set (`src/lib/ui/icons/icons.ts`, 24 px grid, 1.75 px round strokes); decorative unless `label`.                                                                                                                                                                        |
| `Surface` / `Card`  | Levels 1–3, padding, radius, discipline `tone` tint, `interactive`/`href`; `Card` adds eyebrow/title/action header (`aria-labelledby`).                                                                                                                                            |
| `NumberStepper`     | One-handed −/+ (56 px), press-and-hold accelerating repeat, tap-to-type (`inputmode=decimal`), `role=spinbutton` with ArrowUp/Down, PageUp/Down, Home/End; `error` replaces `hint` (`aria-invalid`, `role=alert`).                                                                 |
| `BottomSheet`       | Native `<dialog>` + `showModal()` (platform focus trap, inert background), Escape/backdrop close, focus returns to opener, touch swipe-to-dismiss (distance or velocity), content mounted only while open. A centred dialog from 1024 px.                                          |
| `SegmentedControl`  | `radiogroup` with roving tabindex and arrow keys; spring-animated thumb; `sm` (36 px track) options extend their hit area to 44 px.                                                                                                                                                |
| `Tabs`              | WAI-ARIA tabs (automatic activation, arrows/Home/End), animated accent indicator, renders active panel.                                                                                                                                                                            |
| `AppNav`            | Primary navigation (real links, preload on tap): the glass bottom bar, a solid left rail from 1024 px under the brand mark; one `<nav>`, so destinations, order and `aria-current` match at every width (Responsive layout → Shell).                                               |
| `Skeleton`          | Shimmer placeholder (static under reduced motion); pair with `aria-busy` on the region.                                                                                                                                                                                            |
| `EmptyState`        | Medallion glyph (tone-tinted), title, guidance, optional actions; `compact` variant.                                                                                                                                                                                               |
| `Toaster` + `toast` | Polite live region; `neutral · positive · danger`; optional action; auto-dismiss. Screen chrome at the top, centred over the column (beside the rail from 1024 px), or in the window outside the shell.                                                                            |
| `PageHeader`        | Eyebrow + large title + trailing slot; a `badge` sits on the eyebrow line, clear of the title.                                                                                                                                                                                     |
| `BrandMark`         | The performance-gauge mark (also the PWA icon).                                                                                                                                                                                                                                    |
| `Stat`              | The one metric tile: label, big value + inline unit, optional rating (word + dot), caption. `level 1` on the canvas (26 px value), `level 2` nested in a card (24 px). No value → a dash announced as "No data yet", never a made-up number.                                       |
| `Badge`             | Status pill: `neutral` (default; the only tone for "Soon"), `accent` (the next step, sparingly), `positive · warning · danger`; optional icon. Words carry the meaning.                                                                                                            |
| `Chip`              | Quiet outlined label (e.g. a discipline) with an optional discipline-colour dot; static, not a control.                                                                                                                                                                            |
| `ListRow`           | Tool/destination row: tinted icon tile, title, subtitle, chevron or `trailing` snippet; renders a link (`href`), a button (`onclick`) or a dashed, non-interactive row (`disabled`, for "Soon").                                                                                   |
| `Section`           | Titled group on a screen ("This week", "Tools"): one heading style and spacing everywhere, `aria-labelledby` wired.                                                                                                                                                                |
| `training/*`        | `PlateDiagram` (sleeve picture), `PlateCalculator` (code-split sheet body; its kg/lb switch is local and never changes the app-wide preference; from a set row it opens at that set's weight and unit), `PlateInventory` (this device's bar and plates).                           |
| `WeekStrip`         | `src/lib/ui/program`, like the next two. Seven days Monday first in a radiogroup (roving tabindex, arrows, Home/End), each ≥ 44 px at 393 px; a dot per session (a ring if skipped), counted in its name; the server's today ringed.                                               |
| `SessionCard`       | A session: discipline dot, title, 'Strength · 60 min · Hard · Evening'; Skipped, Moved from Mon, Done and Baseline as worded badges; with `href` one link named by its title; `pending` sets `aria-busy` and sweeps a progress line.                                               |
| `PrescriptionLines` | describe.ts's words as a list: '3 × 5 @ RPE 7', the load only when describe could compute one, its basis, rest and tempo, the baseline instruction; run steps with each segment's pace and effort. It never computes a number.                                                     |
| `ProgramHeader`     | Train's program title, its block and place ('Baseline week · Week 1 of 5'), a status badge, an actions row (`.action` pills, busy while loading), the weeks as pills between previous and next (≥ 44 px, this week ringed, a loading week busy); week links keep scroll and focus. |
| `BlockTimeline`     | The plan on a rail (timeline.ts's words): each block's name, phase, dates and length, then its weeks; 'This week', an 'Event' under its week, outline weeks 'Not planned yet' and never links; with `weekHref`, planned weeks are links.                                           |
| `PlanOverviewSheet` | Train's plan in a `BottomSheet`, code-split and fetched on intent; a tapped week closes it and opens on Train through the week's pending state. A chunk that fails to load: 'Couldn’t open your plan' with Retry beside Plan.                                                      |
| Bridge week         | A late start's unplanned weeks between blocks: Train and History's 'Unplanned week · between blocks' card with the next block's start (no strip or rest days), the week's workouts 'Off-plan'; Today's 'Between blocks' with Log something else; a hatched timeline block.         |
| `ExerciseBlock`     | A planned exercise as an `article` named by its heading: its name (a superset's 'A1' before it), the coach's instructions, then its sets as `PrescriptionLines`, from session-words.ts's `exerciseViews`.                                                                          |
| `RunSegments`       | A run as a timeline in describe.ts's words: a dot per step on a rail, each repeat group as one bracketed block ('6×', 'Repeat 6 times') over its segments, each with its pace in the owner's unit and effort.                                                                      |
| `SessionDetails`    | A session at a glance: duration and target RPE as two `Stat`s (the intensity as the RPE's caption), then an other session's metrics as a grouped list, label left and value right, each row ≥ 44 px.                                                                               |
| `BaselineCallout`   | Week 1's baseline instructions on a strength session, on an accent `Surface`: why it sets the loads ahead, how to work up to the target RPE, and what to record. Copy from session-words.ts.                                                                                       |
| `EditSheetHost`     | Every edit's sheet, code-split with its `BottomSheet`: a skeleton while the edit loads, 'Couldn’t load this editor' with Retry if it fails; Save busy and disabled while posting; focus back on the trigger; a toast once saved.                                                   |
| `MoveSheet`         | Inside the host: the week's remaining days as `ChoiceGroup` cards with what is planned, rule warnings before saving, an optional reason; conflict and offline notices; 'No other day left this week' offers Skip.                                                                  |
| `SwapSheet`         | From an exercise's Swap: ranked alternatives as `ChoiceGroup` cards, each with why it fits; an explained 'Never prescribe … again' `Toggle` (off: this session only); a reason. Empty: 'Nothing fits your equipment and injuries', why, a Profile → Equipment link, no Save.       |
| `AdjustSheet`       | On an exercise, a run or a class: a `NumberStepper` per value it has (sets, reps, RPE, load, rest; repeats, distance, duration, pace; length), a row picked first as cards when there are several, a reason; a value out of range is its stepper's error and nothing posts.        |
| `SkipSheet`         | What skipping does, said before saving, and a reason. Skipped, the session shows a 'Skipped' `Notice` with a History link in place of its edit row; Train's card says Skipped.                                                                                                     |
| `TextField`         | Labelled single-line input (label above, never placeholder-as-label), 56 px tall, 16 px text so iOS never zooms, hint or error wired with `aria-describedby` (the error replaces the hint), `mono` for codes, `type="date"`, "Optional".                                           |
| `NumberField`       | A number that may stay blank (`null`, never 0): decimal or numeric keypad, `enterkeyhint`, unit inside the field and in its description, digits and one decimal point only, "Optional" marker. For values people nudge: `NumberStepper`.                                           |
| `TextArea`          | Multi-line notes: label above, 16 px text, grows with its content (`field-sizing`; `rows` and a resize handle where unsupported), `maxlength`, hint or error wired with `aria-describedby`, "Optional" marker.                                                                     |
| `ChoiceGroup`       | One (radio) or several (checkbox) from a short list as wrapping pills or cards with a hint line; native inputs in a `fieldset` (Tab, arrows, Space), ≥ 44 px, selected shows a tick or a filled mark (never colour alone), discipline dot.                                         |
| `DayPicker`         | Monday-first row of seven round toggles, ticked when picked: native checkboxes named with the full day, value always in week order, hit areas reaching into the gaps so each stays ≥ 44 × 44 px inside a padded card at 393 px, error state.                                       |
| `Toggle`            | On/off row: a native checkbox with `role="switch"` covering the whole row (the hit area, ≥ 44 px), the title as its name and the description as `aria-describedby`; Space flips it; the thumb's side says on or off.                                                               |
| `TagInput`          | Short free-text list: Add or Return adds the trimmed text, a repeat in any case is refused, `maxlength` and `max` hold; removable pills (44 px remove buttons), one-tap suggestions, every change and refusal announced politely.                                                  |
| `Notice`            | Inline state message: `danger` (role `alert`) · `positive` · `warning` · `neutral` (role `status`); tinted, icon + words.                                                                                                                                                          |
| `RecoveryCodes`     | One-time display of recovery codes: numbered list (one per row on a phone, two columns when the container allows), copy and download, required acknowledgement checkbox.                                                                                                           |
| `ChartFrame`        | `ui/charts`. A chart's `<figure>`: title, context and summary server-rendered; the plot box reserved with a hairline grid; the body from a `CHART_BODIES` loader after hydration; a failed chunk: `Notice` and Retry; no JS: 'Chart needs JavaScript'; an `availability` slot.     |
| `ChartTable`        | `ui/charts`. The table twin: `<details>` 'Show as table' (≥ 44 px), a keyboard-scrollable table with scoped headers, units, every value ('No data' when missing), the week in progress marked 'so far'.                                                                            |
| `LineChart`         | `ui/charts/bodies`, `CHART_BODIES.line`. Up to 4 series: 2 px lines with gaps, legend from 2, end labels with leaders (numbers < 18rem); 8 px end dot, hollow ring (estimated), diamond (measured), dashed ring 'so far'; crosshair and tooltip by pointer, touch or ←/→/Home/End. |
| `BarChart`          | `ui/charts/bodies`, `CHART_BODIES.bar`. Columns ≤ 24 px, rounded data end; stacks in `STACK_ORDER`, 2 px gaps, rect keys, totals that fit; dashed plan outline, target band, outlined 'so far' week; each mark a button, tooltip by hover, tap or arrows; forced colours: hatches. |
| `RangeBars`         | `ui/charts/bodies`, `CHART_BODIES.range`. A horizontal bar a group in one hue, largest first (ties by name); range bracket (open past the axis), plan tick; status as icon and words (Below, Within, Above range); each row a ≥ 44 px button, tooltip by tap, hover or arrows.     |
| `DivergingBars`     | `ui/charts/bodies`, `CHART_BODIES.diverging`. Actual − target RPE a row, bars from a centred zero: `--chart-diverge-cool` below, `-warm` above, `-mid` within ±0.5; signed value and Easier, On target or Harder in words; rows and tooltips as `RangeBars`.                       |
| `TrendTile`         | `ui/analytics`. A metric at a glance: label, value + unit, kind `Badge`, delta in words + icon toned by direction × good (normal variation neutral), the so-far line, a server-computed sparkline (one 2 px polyline), verdict; read as one sentence; `Stat`’s no-data contract.   |
| `VerdictBadge`      | `ui/analytics`. Real improvement, Real decline, Normal variation or Not enough data yet · 2 of 6 weeks, in words + icon, with ‘over the last 12 weeks’ when the window is not the period’s; sentence case, wraps.                                                                  |
| `MetricContext`     | `ui/analytics`. One line: the period, its comparison, the trend window when it differs, what counts as good; then a `<details>` (≥ 44 px) with the method and any caveat.                                                                                                          |
| `PeriodPicker`      | `ui/analytics`. Five real links to `?period=` (4w … All, named in full), `aria-current`, each a history entry, `data-sveltekit-reset="false"`, ≥ 44 px at 320 px; another period loading dims the content, `aria-busy` and inert, no skeleton.                                     |

A `ChoiceGroup` records a choice; it is never an "add" action (arrow keys check every radio they
pass, so a radio that adds a row adds one per keypress). An optional single choice offers an
explicit option such as "Not set" or "Any" that the caller maps to `null`: there are no clearable
radios.

Screens compose these primitives instead of styling their own tiles, pills, rows or section
headings, so the same pattern cannot drift between screens (PRD §16). `/design` shows every
primitive (the Inputs, Data and Feedback groups load when their tab opens), and the Plan tab the
program components on a fixture week, their pending and status states included. Its Workout section
shows every `src/lib/ui/workout` component in each state (loaded when it opens).

Auth screens (`/`, `/setup`, `/recover`, `/recover/passkey`) share `src/routes/AuthScreen.svelte`:
brand row, an editorial display headline, the brand mark as a quiet watermark, and the one action
panel pinned to the thumb zone (a card beside the headline from 1024 px: Responsive layout →
Screens). Security (`/profile/security`) uses grouped rows on `Surface`s, destructive actions
behind a confirming `BottomSheet`, and toasts for outcomes.

## The workout screen (M4)

The screen used mid-set, sweaty and one-handed (PRD §7–§8). Every rule here holds on the three
workout pages and is audited on `/design` → Workout, one state at a time.

- **Focus mode.** The workout pages live outside the shell: no tab bar and no rail, so the thumb
  zone belongs to logging. Minimise (top left) returns to Today, where the resume bar waits.
- **Safe areas.** No shell applies them here, so the workout Shell does: the header
  `--safe-top`, the content `--safe-left` and `--safe-right`, the foot `--safe-bottom`; the
  logger pads its own foot above the home indicator.
- **The thumb zone.** Below 1024 px the logger (`SetLogger`) is stuck to the foot, full-bleed, and
  the rest pill sits just above it on every exercise; what is read (the card, the set rows) sits
  above, what is tapped sits within reach. From 1024 px both move into the main column.
- **Density mid-set.** The card says only what the next set needs: its place, the prescription
  lines, the load, the rest and last time inline. Big tabular numerals for the steppers and the
  rest; small quiet type for status. The load and the rest keep the room of the exercise's
  tallest, and the logger keeps its fields from set to set, so logging a set moves nothing.
- **One loud accent.** Complete set is the only primary button while a set is at hand; between
  exercises Up next's Start (or Finish workout) takes its place. Everything else is secondary or
  ghost; the accent also marks the current set's ring, the chosen RPE and 'Rest over'.
- **Never colour alone.** Set states are words ('Now', 'Done', '2 missed', 'Not saved on this
  device'), the sync pill is an icon and words, a chosen chip shows a tick beside its ring, and an
  exercise's state ('Swapped for this session', 'Stopped') is written on the card.
- **Targets.** At least 44 × 44 px at every width (the steppers' ± are 56 px); sheets are dialogs
  that take focus, close on Escape and return it; RPE is one radio group.

### Desktop layout

- **Columns.** From 1024 px the header spans the page; under it the side column
  (`--content-list`) holds the session's list (exercises with sets done and A1/A2 labels, or a
  run's segments) beside the main column at the readable width (Responsive layout → Screens).
- **The docked timer.** The rest timer docks at the top of the main column under the header, never
  over content; the logger is a card under the set rows, not stuck to the window.
- **History.** The list beside the picked workout's detail, 'Pick a workout' when none is picked.
- **The resume bar.** On the rail layout it docks at the bottom of the content column, inset by the
  rail, and the content's bottom padding grows with it (`--resume-inset`), so it covers nothing.
- Every control has a hover state for fine pointers and a `:focus-visible` ring; the side list and
  the steppers answer the arrow keys. No shortcut overrides a browser one (Alt+Arrow is Back).

### Workout components

| Component                        | Highlights                                                                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SetRow`                         | `src/lib/ui/workout`, like the next eight. One set: number, target or what was done, its state in words (to do, now, done, missed, skipped, extra, not saved); a logged one is a button to its editor.                            |
| `SetLogger`                      | The set at hand: big steppers for exactly the fields its exercise records (weight, added weight, assistance; reps, time, distance), `RpeChips`, Missed reps, Skip set, Complete set (the one accent).                             |
| `RpeChips`                       | RPE 6–10 in halves and 'No RPE', two rows of native radios in a fieldset: one Tab stop, arrows move the choice, a tick beside the ring.                                                                                           |
| `RestTimer`                      | Time left in big tabular numerals over a bar, exact after a reload; Pause, Reset, +30 s, Skip; paused: Resume; over: 'Rest over · 0:42 ago' in the accent with +30 s and Dismiss.                                                 |
| `Stopwatch`                      | The workout's running time (a `timer`, not announced each second); the time is the Pause button; paused, it dims and opens Resume and Reset.                                                                                      |
| `SyncPill`                       | Saved, Saving…, Offline · N pending, Retrying in n s, N need attention, Sign in to sync, Finish adding your passkey: icon and words, a fixed box, a 44 px button to the sync sheet.                                               |
| `UpNext`                         | The next exercise and its first target, the superset partner inside a round; between exercises Start, once all is done Finish workout; Add exercise; where the flow went, said politely.                                          |
| `ExerciseCard`                   | The current exercise: place, A1/A2, name (a button to its history), prescription lines, load, rest, last time (or why there is none), its slot's state and what it replaced, Options, the set rows.                               |
| `ExerciseHistorySheet`           | An exercise's best e1RM (estimated), rep PRs and last performances a page at a time; offline the session this device holds; failed: Retry. Code-split, a centred dialog from 1024 px.                                             |
| `ExerciseList`                   | `src/routes/workout`, like the rest. The side column from 1024 px: each exercise with its label and sets done, `aria-current`, one Tab stop moved by the arrows, Add exercise after the last.                                     |
| `WorkoutHeader`                  | Minimise with the sync pill, the title, the stopwatch and More: two rows on a phone, one row spanning the page from 1024 px; applies `--safe-top`.                                                                                |
| `ExerciseActionsSheet`           | Machine unavailable, Suggest an alternative, I don't like this exercise (confirmed first), This hurts, Skip exercise; alternatives as `AlternativeList` buttons with why each fits.                                               |
| `PainSheet`                      | Where, how bad and a note, all optional; then Stop this exercise, gentler options, or End the workout here; Profile → Injuries and a professional pointed to, never a diagnosis. In a run or a class, End the workout here alone. |
| `SessionActionsSheet`            | A run's or a class's Options: This hurts (the pain sheet, ending the session); Swap (in a run, a zone 2 bike that ends it; in a Muay Thai class, a lighter type); in a run, Skip this segment; Ask the coach.                     |
| `ExercisePicker`                 | Add exercise: the cached library searched by name and alias, arrows and Enter; offline with none cached, why and Try again; Add my own exercise under the list.                                                                   |
| `CustomExerciseSheet`            | The owner's own exercise: name, measure, load, pattern, then muscles and equipment behind a disclosure; a name clash shows before anything is sent.                                                                               |
| `PlateSheet`                     | The plate calculator from a set row, at that set's weight and unit, with this device's bar and plates; focus returns to the row's plate button.                                                                                   |
| `SetEditSheet`                   | A logged set's fields, missed reps, RPE and warm-up; Save sends every value, Delete asks first; reused as the Fix editor for set changes.                                                                                         |
| `WorkoutMenu`                    | More: Finish workout, Settings (`SettingsSheet`: rest per exercise type, rest on completion, tone, vibration, screen awake, kept on the device at once) and Discard, which says what it does first.                               |
| `FinishSheet`                    | Open planned sets asked about first; then the `Summary` with the duration, session RPE and notes; Done finishes, and the page shows the completed state, offline too.                                                             |
| `StartConflictSheet`             | Another workout in progress: Resume it, or Discard it (what that does said first) and start the new one.                                                                                                                          |
| `SyncIssuesSheet`                | Every change still on the device, in words: Needs attention with why, Fix (the registry's editors and Fix sheets), Try again and Discard (counted first); then Waiting to sync.                                                   |
| `RunFixSheet`                    | `src/routes/workout/fix`, like the next two. A refused segment or run log: why first, then its values as `SegmentFields` asks for them (and its RPE and notes); Save re-queues it under the same id.                              |
| `OtherFixSheet`                  | A refused session log: why first, then `SessionFields` with the server's errors at their fields; a metric its plan lacks can be removed; Save re-queues it under the same id.                                                     |
| `SubstituteFixSheet`             | A refused swap: the slot's alternatives again, ranked for the swap's reason, under why; choosing one re-queues the swap under the same id.                                                                                        |
| `StartFlow`                      | Getting your session ready (a skeleton, aria-busy), the conflict sheet, signed out, or unreachable with no kit and a session of the owner's own instead; at the readable width.                                                   |
| `EmptyWorkout`, `SignedOutState` | No workout on this device: Today, or a strength, run or other session of the owner's own. After a 401: no workout details, the changes waiting and Sign in.                                                                       |
| `SegmentRow`                     | `src/routes/workout/run`. A run's segment: number, what it is, its target or what was run with the pace, its state in words; a 44 px button, the arrows move between rows.                                                        |
| `RunView`, `SegmentFields`       | The run: the current segment's distance, time and heart rate (nudged or typed, the pace worked out as they change), Log segment, the segments, the totals, RPE and notes. Options (the run's quick actions) beside Log segment.   |
| `OtherView`, `SessionFields`     | `src/routes/workout/session`. What the plan asked for, then type, duration, RPE chips, each metric's control (`MetricField`) and notes, and Options (the session's quick actions); a draft on the device until Save.              |
| `WorkoutList`                    | `src/routes/(app)/progress/workouts`. History, newest first: waiting to sync (not links), then each workout's dot, title, date, duration and key number; one 44 px link, `aria-current`.                                          |
| `WorkoutDetail`                  | One workout in words: its numbers, PRs, sets with RPE and states, a run's segments (`RunDetail`) or a session's metrics (`OtherDetail`); a name opens its history sheet.                                                          |
| `ResumeBar`                      | `src/routes/(app)`. Resume workout · title with the time and the sync pill, or N changes waiting to sync; screen chrome over the column that raises `--resume-inset`, so it covers nothing.                                       |
| `HeldScreen`                     | `src/routes/(app)`. While another screen loads: its last copy in this page, else the tab's skeleton (aria-busy, 'Loading Train'); inert, fixed over the column under the nav.                                                     |

## The coach (M5)

A conversation in the readable column (Responsive layout → Screens), with the composer as screen
chrome; the Proposals inbox is a split screen from 1024 px. Every state has its own words, and
words carry it, never colour alone. All of them are on `/design` → Coach and in the screenshot set
(`e2e/coach-screens.ts`: 55 states, each at 393 × 659 and 1440 × 900).

| Component                         | Highlights                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AnswerBlocks`                    | `src/lib/ui/coach`, like the next ten rows. An answer's blocks, each labelled in words (Fact, Calculated, Recommendation, Safety, Note); a metric's method behind a disclosure; 'Not checked against your data'; dated sources; 'Show all'. |
| `RichText`                        | A block's words as elements from the server's tree, never `{@html}`; a link only for an app path.                                                                                                                                           |
| `ActivityChip`                    | One step of a turn in words ('Looking at your last 6 bench sessions…', then what it found or that it could not); a spinner, check or alert only repeats it.                                                                                 |
| `ThinkingIndicator`               | 'Thinking…' between Send and the first step or words: three dots in CSS that hold still under reduced motion.                                                                                                                               |
| `LiveAnnouncer`                   | A polite log: each completed block once, then 'Answer complete'; never tokens.                                                                                                                                                              |
| `Composer`                        | 'Message your coach', up to 4,000 characters over eight lines; Send becomes Stop; Enter sends on a fine pointer, Return adds a line on a phone; disabled, it says why in its placeholder.                                                   |
| `CoachNotice`                     | Every state the coach cannot answer in: not launched, switched off, misconfigured, each way a turn ends, chunk-failed, load-failed, action-failed and empty; Retry where it can work; a rate limit counts down.                             |
| `LoadingRows`                     | Skeleton rows the shape of conversations or messages, `aria-busy` with words for screen readers.                                                                                                                                            |
| `MockBadge`                       | 'Practice coach' on every answer the mock wrote.                                                                                                                                                                                            |
| `ProposalCard`, `DiffRows`        | What changes (from … to …, 'Added', 'Removed'), why and the impact; Accept, Reject, 'Ask for changes'; busy while deciding; 'Couldn’t save' with Retry; offline says why; then 'Applied as version N'. Loaded with the first card.          |
| `RejectSheet`                     | Lazy: an optional reason (reject) or what should change (revise).                                                                                                                                                                           |
| `Thread`                          | `src/routes/(app)/coach/[[thread]]`, like the rest. The conversation, oldest first, with live turns, notices in place of a failed answer, and cards after the answer that made them.                                                        |
| `ThreadList`, `ManageSheet`       | Recent conversations with 'Show older'; rename, and archive with an Undo toast.                                                                                                                                                             |
| `ArchivedSheet`, `ArchivedBanner` | Archived conversations, a page at a time, with Unarchive; an archived conversation opens read-only under 'Archived · Unarchive to continue'.                                                                                                |
| `KnowsSheet`, `UsageSheet`        | 'What the coach knows' from structured memory, section by section; usage as cards on a phone and a table in a `wide` dialog (`BottomSheet`'s `wide`: 56rem, centred, from 1024 px). Both loaded on the first press.                         |
| `Suggestions`, `ContextChip`      | PRD §12's questions, two columns from 1024 px, disabled and dashed while the coach cannot answer; where a prefilled question came from.                                                                                                     |
| `InboxList`, `Detail`             | `src/routes/(app)/coach/proposals/[[id]]`. Waiting for you, then Decided; the opened proposal beside the list from 1024 px, with the same card and decisions.                                                                               |

Designed states, by name: Thinking (`ThinkingIndicator`), loading (`LoadingRows`, the inbox's
`Pending`), chunk-failed ('Couldn’t load this part of the coach': a toast or notice with Retry, and
a second failure while online reloads the page), action-failed ('That didn’t go through': in place
on the card, row or sheet, with Retry), Archived (`ArchivedBanner`) and not-launched ('Answers
grounded in your own training data are on their way', the composer disabled and the suggestions
dashed).

**The screenshot review.** `coach-journey.serial.e2e.ts` captures the set, and
`scripts/coach-screens-index.ts` turns a CI run's screens into the owner's contact sheet. The
launch (#449) merged on 2026-11-12 and the coach is live in production, so the owner's review is
no longer its merge gate; it is still open as a review after launch (#405). Outcome: not yet
recorded; its follow-ups go here once it is. Known from the M5 measurements: the coach route was
0.3 KB over the initial-JS gate on `9ac3521`, before #473 trimmed it under the gate, and the inbox
has no Lighthouse audit recorded yet; its seeding failure was fixed in 61d467b9 (with #395)
(docs/performance.md, "M5 (coach)").

## Progress and reviews (M6)

Every number comes from the server in context: its period, its comparison, its verdict with the
weeks it read, and whether it is estimated or measured. A screen never shows a ghost chart: before
the data exists it says what appears and when. Charts follow Data visualisation above; the chart
kit and the analytics components are on `/design` → Charts.

**Screenshots** (CI artifacts, `test-results/screens/<project>/<name>.png`, each at 393 × 659 and
1440 × 900): `progress-{overview,strength,running,general,exercise}-{phone,desktop}`
(`e2e/progress*.serial.e2e.ts`), `reviews-*`, `review-sections-*`, `review-next-week-*`,
`review-write-up*`, `review-entry-*`, `review-proposal-*`, `cycle-review-*`, `next-cycle-*`,
`train-review-notice-*` and `bridge-week-*` (their `e2e/*.serial.e2e.ts` specs), and the kit's
`design-charts-*` and `design-tiles-*` (`e2e/design-charts*.e2e.ts`: 320 px, 393 px, 1440 px,
both themes, hover, tap, scrub, forced colours, loading and failed). The screen gallery
(`e2e/gallery.gallery.ts`) shoots Progress's screens in its `history` group and the reviews in its
`reviews` group, in both themes.

| Component                      | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ChartFrame`                   | `src/lib/ui/charts`, like the next six rows. Every chart's frame, server-rendered: title, context caption, one-sentence summary and the table twin, the plot box reserved at full height. The body fades in after hydration; a failed body is a Notice with Retry; without JavaScript the plot says so; `availability` ('Available after 6 weeks') takes the plot's place.                                                                                                                                                                                                           |
| `ChartTable`                   | The table twin behind 'Show as table': scoped headers with units, 'No data' for a gap, the week in progress marked 'so far'. It never computes.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LineChart`                    | Up to four series, legend from two, direct end labels with leaders (numbers under 18 rem); estimates as hollow rings, measurements as square diamonds; scrubbing snaps a crosshair to the nearest week (`touch-action: pan-y`).                                                                                                                                                                                                                                                                                                                                                      |
| `BarChart`                     | A column a week, stacked by discipline in `STACK_ORDER` with a rect-key legend and each stack's total on its cap where it fits; a dashed planned outline; the week in progress outlined, not filled.                                                                                                                                                                                                                                                                                                                                                                                 |
| `RangeBars`                    | Muscle-group volume against its target range: a bar a group in one hue, largest first, the range as a bracket (open past the axis), a tick for the plan, and 'Below range', 'Within range' or 'Above range' in words with an icon.                                                                                                                                                                                                                                                                                                                                                   |
| `DivergingBars`                | Actual minus target RPE a row an exercise, from a zero in the middle: easier in `--chart-diverge-cool`, harder in `--chart-diverge-warm`, within ±0.5 in the hueless mid, each side said in words ('Easier', 'On target', 'Harder').                                                                                                                                                                                                                                                                                                                                                 |
| `RowList`                      | The rows the two horizontal bodies draw: a legend in words, each row a 44 px button named by its words, a value axis, and a tooltip beside the row.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `TrendTile`                    | `src/lib/ui/analytics`, like the next four rows. One metric at a glance: value and unit, Estimated or Measured, the change against the named previous period (icon and word, neutral on normal variation), 'This week so far', a static server-computed sparkline and the verdict with its window; one sentence to a screen reader; `data-value` holds the canonical number.                                                                                                                                                                                                         |
| `VerdictBadge`                 | 'Real improvement', 'Real decline', 'Normal variation' or 'Not enough data yet · 2 of 6 weeks', plus 'over the last 12 weeks' when it reads other weeks; words first, tone only reinforces, free to wrap at 320 px.                                                                                                                                                                                                                                                                                                                                                                  |
| `MetricContext`                | One line of context (period, comparison, trend window, what counts as good), then a disclosure with how the figure is worked out and its caveat, in the catalogue's words.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PeriodPicker`                 | Five real links to `?period=` (4w, 12w, 26w, 52w, All), each ≥ 44 px at 320 px and a history entry; while another period loads the figures hold their frame dimmed, inert and `aria-busy`, never a skeleton.                                                                                                                                                                                                                                                                                                                                                                         |
| `ReviewPrompt`                 | 'Your week in review is ready' or 'Block complete — review it and plan the next' at the top of Today and Overview: Create review (a form that works without JavaScript; pending, not reviewable yet, failed with Retry, offline), or 'See your review'.                                                                                                                                                                                                                                                                                                                              |
| Progress views                 | `src/routes/(app)/progress`: Overview (a verdict card per discipline, then the tiles and headline charts), Strength, Running and General (an intro, then their trends), each served whole by the server; their trends load after hydration in place (`TrendsLoader`, `SectionLoader`), and a failed chunk says 'Couldn’t load your trends' with Retry while the verdicts stay.                                                                                                                                                                                                       |
| Exercise detail                | `progress/exercises/[id]`: the e1RM verdict in the header, then the best estimated 1RM with the profile's maxes as their own marks, the e1RM chart beside the 1–10 rep-max table, PRs, top sets, RPE against target and recent sessions linking to their workouts.                                                                                                                                                                                                                                                                                                                   |
| `ReviewList`                   | `src/routes/(app)/progress/reviews/[[key]]`, like the rest. Reviews newest first, each a ≥ 44 px link with its summary; a week or block with no review has Create, with the same four states as `ReviewPrompt`.                                                                                                                                                                                                                                                                                                                                                                      |
| `ReviewHero`                   | The weekly and cycle review's shared hero: period, title (focused on a phone), one-sentence summary and the adherence meter in words.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ReviewSections`, `ReviewBody` | The review's trends and sections (RPE, volume and intensity, running, Muay Thai, recovery and fatigue, conflicts, PRs; for a block, goals, progression, fatigue and exercise effectiveness), each a disclosure with its verdict line; each chart's room reserved, its table without JavaScript.                                                                                                                                                                                                                                                                                      |
| `NextWeekCard`, `KeepSheet`    | Next week's changes, each with before → after, its why, a checkbox and a half step; a passed one struck through ('Monday has passed'); 'Generate next week' and 'Keep next week as planned' with an optional reason; a proposed deload as one card (m7/51): its headline, 'Why' (up to five stored signals), 'What changes' (`DiffRows`), 'Accept the deload' and 'Keep the plan' with no list; out of date or late, with 'Propose again'; pending (`aria-busy`), offline (disabled, with the reason) and failed with Try again; then what was decided, with the version in History. |
| `NextCycleCard`                | The next block: 'This week' or 'Next Monday', each with its own preview (phase, weeks, dates, a bridge's unplanned weeks, weeks lost before a race, week 1, what changes and why, starting loads labelled estimated); Adjust (keep an exercise, move or skip the deload); 'Start next block'.                                                                                                                                                                                                                                                                                        |
| `CoachWriteUp`, `WriteUpLive`  | The coach's write-up after the figures, in a box reserved at six lines: written, 'Your coach is writing this up…', or why there is none (not launched, switched off, budget, rate limited, offline, failed) with Retry; 'Discuss with your coach'.                                                                                                                                                                                                                                                                                                                                   |
| Bridge weeks                   | A late start's unplanned weeks: Train's state card ('Unplanned week · between blocks', with the day the next block starts and the week's workouts marked Off-plan), History's notice, Today's 'Between blocks', and `BlockTimeline`'s hatched block with its weeks 'Unplanned'.                                                                                                                                                                                                                                                                                                      |
| Train's review notice          | On a week a review changed: who decided it, each change with its why, and a link to the review (`services/programs/week-changes.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## Accessibility checklist (applies to every new component)

- Touch targets ≥ 44 × 44 px; visible `:focus-visible` ring (`--color-accent-ring`).
- Text contrast ≥ 4.5:1 in **both** themes. `e2e/a11y-suite.ts` runs axe-core (WCAG 2.1 A/AA)
  on every screen, the plate-calculator sheet and each `/design` group in dark and light; CI
  runs it with the rest of the e2e suite (Lighthouse only audits the default dark theme).
- Use native elements first (`<dialog>`, `<button>`, links); ARIA patterns for composites.
- Never convey state by colour alone: badges are words, `Stat` ratings are a word plus a dot
  (e.g. RUM p75 tiles: "Good" / "Needs work" / "Poor").
- Respect `prefers-reduced-motion`.
- Verified at 393 × 659 and 1440 × 900 (Responsive layout → Verification).

## Iconography & brand

- Mark: a 270° gauge track with a lime arc stopping short of full ("progress, not perfection").
- App icons are rendered from `static/icons/*.svg` by `pnpm icons` (Playwright Chromium):
  `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (content inside the 80% safe zone),
  `apple-touch-icon.png` (180 px); `favicon.svg` for browsers.
- Product icons (`<Icon name>`): 24 × 24 grid, 1.75 px round strokes, path data in
  `src/lib/ui/icons/icons.ts`. `<Icon>` draws them with `<use>` from one generated sprite, so they
  cost no JavaScript: after adding or changing one, run `pnpm icons:sprite` and commit
  `sprite.svg` and `names.ts` (a unit test fails while they are stale; `pnpm budgets` fails if path
  data reaches a client chunk).

## Advanced coaching (M7)

One line per M7 UI slice, each replaced by its own slice only; docs-m7 turns them into rows.

m7/04 train-week-findings: a week finding is one line right under its `SessionCard` (outside the card's link): the summary of a native `<details>` whose body is the why, so it opens without JavaScript, with a 44 px summary, the focus ring and a brighter colour on hover. A CSS glyph (a ring, filled in `--color-warning` for `caution`) and the words carry the meaning, label first: 'Heads-up' (an avoid finding nothing explains, or the owner's own move; caution), 'Your move' (advice) or 'Trade-off, explained' (kept for a stated reason); never the danger tone. Its markup and CSS live in Train's page, not in `SessionCard`, so Today and History load none of it (Train's 0.15 KB allowance); /design → Plan shows a copy. `ProgramHeader` shows the week line under the position, in its style, hidden while empty: '1 heads-up this week', 'No clashes ahead this week' (the current week counts only what is ahead) or 'No clashes this week'; Train leaves it empty on past, outline and bridge weeks and on 'First block complete'.

m7/14 placement-why: every card of a planned week that a decision names has 'Why Monday?' under it (after its finding's note, when it has one): a second native `<details>`, closed by default, with the note's 44 px summary, focus ring and hover colour but no glyph, so it never reads as a finding. Its body is a plain list, one line a decision, the owner's moves first, then newest first, at most six: 'Session moved (You, version 2): …'. The server writes every word (lever 3: plain text in one native disclosure), and its markup and CSS sit beside the note's in Train's page (lever 1), so Today and History load none of it; /design → Plan shows one under the trade-off card. A session no decision names has none, and when the decisions cannot be read the week renders without them.

m7/23 move-evaluation: the Move sheet judges each day it offers with the week's M7 context (one read for the sheet). The day the scheduler would move the session to adds 'Clears this week’s clash' to its card's hint, after what is planned there. Each day a move would bring a clash to is one calm line in a 'Heads-up before you pick' list under the day cards (not inside them: a choice card is one whole hit area, so nothing in it can open): a native `<details>` whose summary is 'Wed · Heavy lower body the day before hard Muay Thai' and whose body is the rule's reason, with a 44 px summary, the focus ring and a brighter colour on hover, in the secondary text colour, never a warning tone. A day shows one finding, avoid before prefer and M3's placement rules before M7's (TARGET_WARNING_ORDER); a warning never blocks the move. When the context cannot be read, the days show M3's warnings alone and no 'Clears' hint.

m7/38 week-kind-indicators: a deload, taper, event, recovery, cutback or maintenance week still ahead is named in `ProgramHeader` under the position, and at the top of Today's day (inside its section, so the desktop subgrid keeps its rows): the kind as a neutral `Badge` ('Deload week'), then its why as plain secondary text, the server's words (the week's own decision's summary, else M3's, else `WEEK_KIND_WHY`), with ' · 10K race in 24 days' when an event is within 8 weeks. Never a tone: lighter is deliberate, not a warning. The badge never wraps; the why wraps under it on a narrow screen. On Train the tag is the line's `::before`, drawn from `data-tag` in `Badge`'s neutral style rather than the component, and a light week's pill draws its word after its number in the same style from `data-mark` ('Deload', 'Taper', 'Event', 'Recovery', 'Cutback'; a maintenance week none), its accessible name saying it ('Week 4, Taper'): no element or component for either, to keep Train's initial JS small. No line on a normal, past, outline or bridge week, or when the read fails.

m7/39 periodisation-timeline: Train's plan sheet lays the season (`season.ts`, the server's words) over `BlockTimeline`, which without `season` stays M3's (Today's BuildPreview and desk Today pass none). Every block from this one on lists each goal's role under its head as plain text, one fixed-height line each, the leader first in semibold: 'Muay Thai fight · leads', 'Marathon · secondary', 'Build muscle · maintenance', under the caption 'Goal roles' (' · worked out from your goals' for a program built before M7). Its phase tone (build `--color-info`, peak `--color-strength`, taper `--color-conditioning`, recovery `--color-positive`; this block the accent) colours only its node, beside its name, never in place of words. A deload, taper or recovery week carries the word after its number ('Week 5 Deload'), this week is ringed in `--color-accent-ring`, and four or more outline weeks in a row without an event are one counted row ('Weeks 12–17 · 6 weeks · Not planned yet'). From 1024 px a segmented track runs above the list (aria-hidden; the list is its twin): a thin tone bar per block, hatched in outline, widths by weeks, labels clipped, ticks, a diamond per event and a ring for today, the events named in a one-line legend ('◆ Muay Thai fight · Sat 16 Jan'). While the season streams the region (`section`, 'Your season') is aria-busy with a polite 'Loading your season', the track's room and each block's lanes (the open-goal count, plus the caption) held, so it lands with no shift; a read that fails leaves M3's timeline and shows no error. /design → Plan shows it loaded and streaming.

m7/49 replan-notice-ui: after a goal change, Profile → Goals shows what the priority trigger made of it as one calm line under the list: `ReplanNotice` (`ui/profile`), in a polite live region that is empty and takes no room until an answer arrives. It says a re-plan is ready to review (a link to its proposal), that the plan already fits these priorities, that the next block will follow them, that the owner should build a program from Today (a link), or that a re-plan could not be prepared, with a 'Try again' that runs `?/replan` (busy while it runs; the repo's one verb for it, scripts/try-again-copy.test.ts). The words live in `replan-notice.ts`, a pure helper, so the states are unit-tested; the component uses `Notice`'s neutral tint with no icon, and its link keeps a 44 px hit area. Never a warning tone, and it wraps at 320 px. A reorder moves the list at once, and the notice follows when the answer comes; a save or a delete passes its answer up from `GoalSheet`. Train shows one line under its program status (`ProgramHeader`, a `replan` prop): 'A re-plan for your new priorities is ready · Review', linking to the proposal, present only while an open goal_priority re-plan waits (`replanNote` in Train's load, which passes null and records a failed read).

m7/50 replan-proposal-card: a re-plan proposal says where it came from, under its title: 'From your goal change', 'From your training load', 'From your weekly review · Week of 2 Nov' (linking to the review), or 'From your coach' for a re-plan the coach proposed (linking to its conversation). Its week rows go through the generic `DiffRows`, and when they were capped at 12, the stored line under them says how many more there are ('3 more changes not listed'); a deload says 'Week of 16 Nov becomes a deload week' above its impact, by date so it reads the same days later. A stale re-plan, superseded as profile_changed, plan_changed, start_passed, sessions_passed or program_changed, keeps its reason and offers 'Propose again' in the proposals inbox and its detail: the `?/proposeAgain` action asks for the same directive again from today (a deload whose week has passed moves to the week holding today) through the engine's guards, and the fresh proposal opens. The card shows each state in place: busy with `aria-busy` (a second tap is ignored), the engine's sentence on a neutral line with no proposal made (or 'This can’t be proposed again from here' when its source cannot be read again), 'Couldn’t prepare it' with Try again, which sends the same request and is then the only button, and offline, disabled with the reason. An answer moves focus to its note or to Try again. The words live in `src/lib/domain/coach/cards.ts` and `src/lib/domain/coach/propose-again.ts`, the service in `src/lib/server/services/periodisation/propose.ts`, and the card's markup in `src/lib/ui/coach/ProposalCard.svelte`; no card in a conversation offers the action, which needs the inbox's detail.

m7/51 deload-review-ui: a weekly review's proposed deload is one card on the review page (`NextWeekCard`, its view from `load.ts`), and an open deload's headline is computed when the page is read from the deload's week and today, never stored: 'This week becomes a deload week from today' when today falls inside that week (Monday to Sunday), 'Next week becomes a deload week' when that week starts the Monday after today's week, else 'Week of 16 Nov becomes a deload week'. 'Why' lists the signals the deload stored (`snapshot.deload.reasons`, else the fatigue reasons), at most five plain lines; 'What changes' lists the proposal's rows through the inbox's `DiffRows`, or its summary lines when it has none. The sessions already done that stay as they were are not named: neither the rows nor the payload carry them. 'Accept the deload' and 'Keep the plan' are as before. A deload superseded as profile_changed, plan_changed, start_passed, sessions_passed or program_changed says 'This deload is out of date', and a late one, with no session left in its week, says 'No session is left in that week' under a headline by date only ('Week of 16 Nov becomes a deload week'); both offer 'Propose again', which posts the card's form to `?/proposeAgain` and calls m7/50's `proposeAgain` on the review's own proposal (`proposeDeloadAgainAction` in `src/lib/server/forms/reviews.ts`). An engine refusal or an answer that changes nothing shows its sentence on a neutral line, a failure shows 'Couldn’t prepare it' with Try again, and a fresh proposal opens its inbox page (`/coach/proposals/<id>`, as m7/50's detail opens it) rather than reloading the review, which still points at the stale proposal. Pending is `aria-busy` and a second tap posts nothing; offline the actions are disabled with the reason.

m7/52 hr-fields-ui: not built yet.
