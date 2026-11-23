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
   Each says one thing and offers at most one thing to do.

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
`#0a0a0b`. With **Match my phone**, the app
keeps listening to `prefers-color-scheme` while open, so when iOS switches appearance (e.g.
automatic dark mode at sunset) the theme-color and status-bar metas follow the CSS (e2e-tested).
**Browser baseline:** `light-dark()` needs Safari 17.5+ / Chrome 123+.

## Colour

| Token                     | Dark                      | Light                     | Use                                                                    |
| ------------------------- | ------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `--color-canvas`          | `#0a0a0b`                 | `#f4f4f0`                 | the page background on every board                                     |
| `--color-surface-1`       | `#151517`                 | `#ffffff`                 | the bottom sheet and dialogs; charts (see Data visualisation)          |
| `--color-surface-2`       | `#19191c`                 | `#ecece7`                 | fields, chat bubbles, toasts, the avatar, a quiet button in a sheet    |
| `--color-surface-3`       | `#222226`                 | `#e2e2dc`                 | a round icon button (the stepper's ±), a quiet button's hover          |
| `--color-surface-inverse` | `#f2f2ee`                 | `#111113`                 | an inverted fill, with `--color-text-inverse` on it                    |
| `--color-overlay`         | `rgb(10 10 11 / 0.7)`     | `rgb(244 244 240 / 0.7)`  | the scrim behind a sheet                                               |
| `--color-glass`           | `rgb(10 10 11 / 0.92)`    | `rgb(244 244 240 / 0.92)` | the composer                                                           |
| `--color-hairline`        | `rgb(255 255 255 / 0.07)` | `rgb(17 17 19 / 0.08)`    | between list rows, above the tab bar, the rail's right edge            |
| `--color-border`          | `rgb(255 255 255 / 0.08)` | `rgb(17 17 19 / 0.08)`    | a sheet's top edge                                                     |
| `--color-border-strong`   | `rgb(255 255 255 / 0.1)`  | `rgb(17 17 19 / 0.12)`    | focusable outlines; v2 has no bordered control                         |
| `--color-highlight`       | `transparent`             | `transparent`             | unchanged                                                              |
| `--color-text`            | `#f2f2ee`                 | `#111113`                 | titles, body, values, the active tab                                   |
| `--color-text-secondary`  | `#a3a3a8`                 | `#55555c`                 | the date line, back links, text links, field labels                    |
| `--color-text-tertiary`   | `#86868e`                 | `#66666e`                 | inactive tabs, units, table heads, the composer's placeholder          |
| `--color-text-quiet`      | `#7a7a82`                 | `#6e6e76`                 | a day with nothing planned; a disabled primary or quiet button's label |
| `--color-text-disabled`   | `#55555c`                 | `#a9a9af`                 | the planned-day ring on the week strip; never readable text            |
| `--color-text-inverse`    | `#111113`                 | `#f2f2ee`                 | text on `--color-surface-inverse`                                      |
| `--color-accent`          | `#ffb02e`                 | `#ffb02e`                 | the one amber: primary fills and the "today" dot                       |
| `--color-on-accent`       | `#1a1200`                 | `#1a1200`                 | labels on an accent fill: Start, Done, Accept, Save                    |
| `--color-on-accent-muted` | `#3d2a00`                 | `#3d2a00`                 | secondary text on an accent fill, e.g. the selected day's letter       |
| `--color-accent-hover`    | `#ffbe55`                 | `#ffbe55`                 | hover on a fill (derived: the design draws no hover)                   |
| `--color-accent-pressed`  | `#e89c1c`                 | `#e89c1c`                 | pressed (derived)                                                      |
| `--color-accent-text`     | `#ffb02e`                 | `#7a4e00`                 | amber as text; v2 never sets it, the token stays for existing uses     |
| `--color-accent-subtle`   | `rgb(255 176 46 / 0.12)`  | `rgb(135 86 0 / 0.12)`    | the tint behind an accent state                                        |
| `--color-accent-ring`     | `#ffb02e`                 | `#9a6400`                 | keyboard focus ring (≥ 3:1 on every surface)                           |
| `--color-positive`        | `#7fd49a`                 | `#1b7340`                 | not used in v2; kept                                                   |
| `--color-warning`         | `#ffb02e`                 | `#7a4e00`                 | amber, always with a word                                              |
| `--color-danger`          | `#ff5a52`                 | `#bb2c28`                 | the field error line, the error toast's icon, Discard workout          |
| `--color-danger-subtle`   | `rgb(255 90 82 / 0.14)`   | `rgb(187 44 40 / 0.1)`    | the tint behind a danger state                                         |
| `--color-info`            | `#6cb6ff`                 | `#1b66b3`                 | not used in v2; kept                                                   |

Neutrals are hueless greys (`#0a0a0b` to `#f2f2ee`). Borders are white alphas on dark and ink
(`#111113`) alphas on light: hairline 7% and 8%, border 8% and 8%, border-strong 10% and 12%. Light
is designed (board 15), not proposed.

Two contrast limits are accepted, not met, and the design draws them the same way. The accent
fill is 1.66:1 against the light canvas: amber cannot reach 3:1 on a light ground and stay amber.
Primary buttons carry their own label at 10.2:1, and selected segments sit inside a bordered
group, so the state is never carried by fill alone. Control borders (`--color-border-strong`) are
about 1.3:1 against the canvas in both themes: inputs are identified by their label and
placeholder, so the text meets WCAG 1.4.11. The outline itself is faint. Quiet buttons have no
outline: a surface-2 fill, identified by its label.

Text, measured on the canvas (dark / light, WCAG): text 17.6 / 17.1; secondary 7.9 / 6.7; tertiary
5.5 / 5.2, and 4.9 / 4.8 on surface-2. Tertiary is 4.4 / 4.4 on surface-3, below AA, as it was
before #581, so it is never set on surface-3. `--color-text-quiet` (4.7 / 4.6 on the canvas) is
below 4.5:1 on surface-2 and surface-3, and on dark surface-1, so it is for the canvas only. One
exception: the label of a disabled primary, secondary or danger button sits on surface-2, where
`--color-text-quiet` is 4.2 / 4.3:1. WCAG exempts disabled controls, and a loading button takes
tertiary instead, so no enabled control carries it.

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
with a text label. A `Badge` draws its status word on the line with no tint, so it uses these tokens directly.
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

### Links

There are two kinds, both secondary text with an underline. A link in running text (a sentence
with a link, a `RichText` link, a `Notice`'s line) takes the `.text-link` class
(`src/lib/ui/styles/base.css`): it inherits the line's font and size, its underline is
`--color-text-disabled` 1 px and sits 4 px under the text. `data-strong` makes it the strong link
of a toast's Undo or an error line's Try again: `--color-text`, 600, underlined in its own colour.
A standalone action (Add a goal, Add a passkey, Log something anyway) is `Button variant="link"`
instead: no padding, a 44 px hit area through `::after`, and the same underline. Hover and press
brighten the text and the underline to `--color-text`, on a fine pointer only.

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
  `14` 56 · `16` 64 · `20` 80 px. Page gutter `--gutter` 28 px (`--space-7`). The workout keeps
  20 px until `v2/10`: its logger's one-row steppers need 22 rem, which a 393 px phone loses at 28 px.
- **Radii:** 2 handle and segments · 14 fields · 16 buttons and toasts · 18 the workout's Done ·
  20 bubbles and legacy cards (`Surface`/`Card`, until their screen rows) · 28 sheets and the
  composer · full avatar and dots.
  The tokens are `--radius-xs`, `-sm`, `-md`, `-lg`, `-xl`, `-action-lg` and `-full`.
- **Elevation:** flat. `--elevation-1/2/3` and `--glow-accent` are transparent zero shadows
  (`0 0 0 0 transparent`), so components can list them in a longer `box-shadow`. Depth comes from the
  surface tones of sheets, fields and bubbles, and the hairline borders; a legacy card has only its
  hairline; the primary CTA has no glow.
- **Motion:** `--duration-instant 90ms · fast 160 · base 240 · slow 380 · slower 560`;
  `--ease-standard`, `--ease-out`, `--ease-in`, and `--ease-spring` (CSS `linear()` spring) for
  thumbs and indicators. `prefers-reduced-motion` sets durations to 0 and disables shimmer.
- **Glass:** `--color-glass` (92% canvas) + `backdrop-filter: saturate(180%) blur(32px)` on the
  coach composer (blurred enough that text scrolling behind it cannot be read). The tab bar is a
  solid canvas since `v2/03a`. The sheet scrim has none: a blur under its fade is redrawn every frame.
  Write only the standard `backdrop-filter`; Lightning CSS adds `-webkit-backdrop-filter` for the
  Safari build targets.
  (Writing both, standard first, makes the minifier keep only the prefixed one, which Chromium
  ignores.) `pnpm budgets` fails if a
  built rule ships a `-webkit-` property without its standard twin, and e2e asserts the nav's
  computed `backdrop-filter` (`none` on the bar). Judge glass on a device, not on e2e screenshots, which can show
  text through the nav (see docs/testing.md).
- **Layers:** `--z-raised 10 · sticky 50 · nav 100 · overlay 200 · sheet 210 · toast 300`.
- **Safe areas:** `--safe-top/right/bottom/left` from `env(safe-area-inset-*)`;
  `viewport-fit=cover`. Installed on iOS, the status bar is `black-translucent` (white text over
  the dark canvas) and switches to `default` (dark text) when the light theme applies: the inline
  theme script sets it before iOS reads it at launch, and changing the theme updates it for the
  next launch. Not yet verified on a device (no iOS/WebKit available while building M1).

## Layout

- App shell: content column `--content-column` (34 rem on a phone, 40 rem from 640 px) with
  safe-area-aware gutters; fixed **bottom navigation** (Today · Train · Progress · Coach), a
  canvas bar with a hairline above it: 12 px, then the 46 px tabs (`--nav-height`, 58 px), then a
  foot of 12 px or the home indicator's room, whichever is more (`--nav-foot`), and the 1 px
  hairline (71 px with no home indicator, 93 px with a 34 px one); Profile opens from the
  avatar on Today (the rail's foot from 1024 px); detail pages have a back link; a left rail from
  1024 px (Responsive layout → Shell); `aria-current="page"` on the active tab; tabs cross-fade with the
  View Transitions API (the `root` snapshot fades while the named nav stays put).
  Never put a `view-transition-name` on an ancestor of a glass surface: it becomes a backdrop
  root and the blur silently stops working.
- Every app screen fits a 393 × 659 iPhone viewport without sideways scrolling, and nothing
  important sits under fixed chrome at rest (Coach suggestions end above the composer; both
  landing CTAs are above the fold). `e2e/shell.e2e.ts` asserts all three.
- Failure states keep the shell: offline and error screens render inside it
  (`src/routes/ErrorView.svelte`, words in `src/routes/error-copy.ts`): one sentence at the foot
  of the column, at most one action, and on Today the avatar; while offline a screen that still
  works shows one quiet line, 'Offline. Your sets are saved on this device.'
- Large titles (`PageHeader`): eyebrow + 32 px display title, iOS-style.
- Toasts appear at the foot: one line 10 px above the tab bar (and the resume line), at the
  column's foot from 1024 px; sheets rise from the bottom, and open as centred dialogs or
  right-hand panels from 1024 px (Responsive layout → Dialogs & toasts).

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
  - `--content-readable` 40 rem: the readable column from 640 px; 38.5 rem from 1024 px (560 px
    of text inside the 28 px gutters). The workout keeps 40 rem until `v2/10` (`workout/Shell.svelte`).
  - `--content-wide` 72 rem: a wide screen's content.
  - `--content-list` 20 rem: the list beside its editor on a split screen.
  - `--content-profile` 68 rem, from 1024 px: Profile's split (`data-measure="profile"`), its list
    400 px wide (narrower windows narrow it, to 320 px at least), 56 px, then the open screen
    576 px wide behind a hairline, inside the gutters.
  - `--rail-width` 5.5 rem: the navigation rail from 1024 px.
  - `--column-offset-max`: from 1024 px, the most `<main>` sits right of the rail, 200 px less the
    gutter, so a screen's text starts at most 200 px from the rail.
  - `--column-start`, `--column-width`: in the shell from 1024 px, where `<main>` lies (its left
    edge and its width), for fixed chrome, which has no shell box to measure.
  - `--main-max`: a wide or split screen's column (`layout.css`), on `#main` and on the root; the
    shell places `<main>` and fixed chrome by it, `--content-column` without it.
  - `--content-column`: the shell's column, which screen chrome is centred over: `--content-max`,
    and `--content-readable` from 640 px.
  - `--nav-foot`: the bottom bar's foot, `max(--space-3, --safe-bottom)`: 12 px, or the home
    indicator's room where that is more.
  - `--nav-inset-bottom`: what fixed chrome clears at the bottom: in the shell, the whole bottom
    bar (`--nav-height` + `--nav-foot` + its 1 px hairline), and the home indicator alone from
    1024 px; `0px` outside the shell (set under `:root:has(.app-nav)`).
  - `--nav-inset-left`: what it clears at the left: `0px`, and in the shell the rail and the left
    safe area from 1024 px.
  - `--resume-inset`: the resume line's room while it shows (44 px and the 12 px below it), `0px`
    otherwise; in the shell `--nav-inset-bottom` includes it, so the content and all bottom chrome
    clear the line.

### Content width

A screen declares its width with `data-layout` on its root element:

- **readable**, the default: forms, text, settings (Security), conversations (Coach). The column
  is `--content-readable` from 640 px; the phone column stays `--content-max`.
- **wide**: dashboards and grids, up to `--content-wide`.
- **split**: a list and its editor, `--content-list` beside a readable detail. Profile's screens
  add `data-measure="profile"`: `--content-profile` in all, a 400 px list (320 px at least in a
  narrower window), then a 576 px detail behind a hairline with 56 px inside it.
- Never a single text column wider than `--content-readable`.
- From 1024 px `<main>` is centred right of the rail, at most 200 px from it to the text: a
  readable screen at 1440 px is 560 px of text starting 200 px from the rail, and a wide one is
  centred until the window is wider still.

### Shell

`AppNav` is one `<nav>` at every width, restyled by CSS, so its links, their order and
`aria-current` cannot differ between widths (Profile's avatar link shows only from 1024 px).
`e2e/shell.desktop.e2e.ts` verifies the shell at 1440 × 900 and the widths around it.

- **Below 1024 px** a canvas tab bar, with no blur: the four tabs (Today, Train, Progress, Coach),
  24 px icons and 12 px labels, current in text colour and 600 with no pill, and a hairline above
  it. Profile is not a tab: Today's avatar opens it. On a tablet (640–1023 px) only the column
  widens, from 34 to 40 rem.
- **From 1024 px** a rail on the canvas with a hairline at its right, `--rail-width` (88 px) plus
  the left safe area, and no blur: the four tabs 28 px apart from 40 px down, each as on the tab
  bar (64 × 46, icon above label), with the text lifted for fine pointers, and the avatar at the
  foot, 32 px up. No brand mark. The readable column is 560 px, starting 200 px right of the rail
  (centred in the room when the window is narrower); the rest of the window is empty. Nothing is
  fixed to the bottom edge. A rail rather than a labelled
  sidebar: the labels are short, and it leaves the most width at 1024 px (a sidebar would be CSS
  only).
- **The avatar** (`layout.css`, `.avatar-link`) is Profile's way in: a 32 px `--color-surface-2`
  circle with the `profile` glyph, not an initial (the shell has no layout load for one), and a
  44 px hit area. Current on Profile, it takes a 1.5 px text ring. On Today it sits at the end of
  the page header, and is hidden from 1024 px, where the rail's foot has it.
- **Back links** (`layout.css`, `.back-link`): a detail page's way back is the parent's name after
  a 16 px chevron, 15 px secondary, 44 px tall, with 12 px above it. Each page keeps its own
  desktop behaviour: `SectionScreen` and Profile hide theirs from 1024 px, where the rail is the
  way back.
- **Order.** The nav comes before `<main>`, after the skip link, so on a desktop window Tab goes
  skip link → rail → content, as the eye reads it, and the skip link skips past the rail into
  the content. On an iPhone nothing moves, but VoiceOver reads the tab bar before the content.
- **Content.** `<main>` is `--content-column` wide, centred beside the rail but at most
  `--column-offset-max` from it; a screen that declares `data-layout="wide"` or `"split"` widens
  it to `--content-wide` from 1024 px (`layout.css`, `--main-max`). Screen chrome follows the
  column through the insets, `--content-column` and, from 1024 px, `--column-start`, so no screen
  file needs an edit; outside the shell the insets are `0px`, so a toast on `/design` is centred
  in the window.
- **CSS only**, so no route gains initial JS for the layout. The shell's own stylesheet (`AppShell`
  with `AppNav`) is inlined into every app page while it stays under SvelteKit's
  `inlineStyleThreshold` (4,096 characters, `vite.config.ts`). `scripts/check-budgets.ts` fails
  if it is ever linked instead, so page-agnostic shell rules go in `src/lib/ui/styles/layout.css`.

### Fixed and sticky chrome

Two kinds, and neither is offset by `--nav-height` **(guard)**: only `tokens.css` and the nav
itself read it.

- **Screen chrome** belongs to a whole readable screen (Coach's composer; a section's Save bar
  below 1024 px) or to the app (toasts). It is `position: fixed` at
  `bottom: var(--nav-inset-bottom)`, centred with
  `left: calc(50% + var(--nav-inset-left) / 2)` and `translateX(-50%)`, and at most
  `var(--content-column)` wide. From 1024 px in the shell it starts with the column instead:
  `left: calc(var(--column-start) + var(--column-width) / 2)`, as `<main>` is no longer centred
  once the column is capped. Only readable screens have it at the bottom.
- **Toasts** sit above all of it: `bottom` is `--nav-inset-bottom` plus `--toast-lift` plus
  10 px. A screen with chrome at its foot sets `--toast-lift` on `:root` through `:has()` (the
  composer: 70 px). The workout keeps its toasts at the top until v2/10.
- **Column chrome** belongs to one column of a wide or split screen (an editor's Save bar, Build's
  "Start week 1", a session's actions). From 1024 px it is `position: sticky` at
  `bottom: var(--nav-inset-bottom)`, the last child of its column, with no left offset and no
  transform, so it takes the column's width and never covers another column. No ancestor up to the
  column sets `overflow`. Below 1024 px the column is the whole content, so it may stay screen
  chrome.
- **The resume line** (`(app)/ResumeBar.svelte`) is one plain row on the canvas, 44 px plus 12
  below, above the tab bar (at the foot of the column beside the rail from 1024 px): changes
  waiting to sync on every screen, a workout in progress until a screen claims it
  (`resume-state.svelte.ts`; Today's hero in `v2/06`). It is screen chrome, fixed on the tab bar's
  hairline and as wide as the column. Its height is `--resume-inset`, so the shell's bottom padding
  and every other bottom chrome rise with it and it covers nothing.
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
- Every interactive primitive has one: the primary lightens, quiet buttons lift to
  `--color-surface-3`, text buttons and links brighten their text, icon buttons tint, list rows tint to
  `--color-surface-2`, a legacy `Surface` or `Card` tints to `--color-surface-2` (see Components), session cards still strengthen their border, an unselected tab tints to `--color-surface-2`, a pill not yet picked lifts to
  `--color-surface-3`, a choice-list row tints to `--color-surface-2`, a switch that is off
  strengthens its track's border, and a picked day or switch keeps its inverse fill, which
  steps toward the canvas on hover (never amber). Native controls drawn by a
  face (`ChoiceGroup`, `DayPicker`, `Toggle`) cover it, so the whole face shows the pointer cursor
  and takes the click.
- A mouse never drags a sheet: only a finger or a pen swipes it down. Touch targets keep 44 px
  at every width (hit areas reach past a control's 1 px border).

### Keyboard & focus

- The skip link comes first and moves focus to `<main>`.
- Focus order matches reading order and visual order.
- Every interactive element shows a visible `:focus-visible` ring, at least 2 px. Fields draw
  theirs as a 3 px shadow over a transparent 2 px outline, with no border colour change: forced colours (Windows contrast
  themes) drop shadows and draw the outline instead.
- The focus ring stays amber (`--color-accent-ring`). It is the one amber use that is not the
  next thing to do: Paper draws no focus state, so the ring is the design's own choice.
- Escape closes the top dialog only; arrow keys move inside composite controls.
- No keyboard traps, and no shortcuts that take over typing keys.

### Dialogs & toasts

- Below 1024 px a `BottomSheet` rises from the bottom with its handle, and a swipe down closes
  it. The handle is 36 × 4 px with 28 px under it; the title is Hubot 26/32 with 16 px before the
  content; the bottom is the home indicator’s inset plus 10 px, at least 16 px in the footer and
  24 px under a body with no footer, so an iPhone with an inset gets 44 px. The close × is a quiet
  ghost.
- From 1024 px the same `<dialog>` opens centred in the window: `min(100% − 2 gutters, 30rem)`
  (480 px) wide, at most `min(85dvh, 48rem)` tall with its content scrolling inside under the
  title, on `--color-surface-1` with a `--color-border` edge and 28 px corners, over the
  `--color-overlay` backdrop. It has 24 px above the header, 40 px at the sides, 16 px between the
  header and the content, and 24 px under the body, whether the dialog's edge or a footer comes
  next; a footer adds 12 px above its buttons and keeps 40 px under them. It fades in as it rises
  8 px, and has no handle. The focus trap and Escape are the platform's; the backdrop and focus return work as on a phone.
- With `desktop="panel"` it opens instead as a right-hand panel: 31 rem (496 px) wide, the
  window's full height, on the canvas with a hairline at its left, 48 px down and 56 px in, its
  title Hubot 32/38, sliding 24 px in from the right as it fades. The backdrop is clear, so the
  screen stays in view beside it, but it is still a modal dialog: a click beside it closes it.
  `desktop="panel"` is for a sheet used beside the screen (Change, More); the dialog for a
  decision or a pick-one.
- Stacked dialogs (Security's step-up over Remove passkey) stay usable: the top one is on top,
  holds focus, and is the only one Escape closes; focus then returns into the one below. When the
  button that opened a dialog cannot take focus back (it was disabled while it worked), focus
  returns to the dialog underneath.
- A toast is one line 10 px over the tab bar (and the resume line), above any chrome a screen
  keeps at its foot (`--toast-lift`). Below 1024 px it is 52 px tall with 16 px corners and as
  wide as the column, a plain line's words centred; from 1024 px in the shell it is 48 px with
  14 px corners, at the column's text edge 40 px over the window's foot, and as wide as its words.
  One at a time: a new toast takes the place of the one on screen. The × only on a toast that
  stays (`duration: 0`); a tap on its words reaches the screen under it. It rises 16 px into
  place (falls from the top in the workout). Below 1024 px, while a `BottomSheet` is open, it stays
  at the top too and falls from there: the sheet is a top-layer dialog, so the toast sits under its
  scrim, not above it.

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
  groups in pairs (Color beside Type, Components beside Legacy: cards, Charts beside Workout), each
  about a phone column wide so no specimen stretches; the header and the icon grid span both, with
  larger cells.
- **Error and offline states** (`ErrorView`): inside the shell, at the foot of the readable column
  (48 px over the tab bar; 72 px over the window's foot from 1024 px), the sentence in Hubot 32/38
  (40/44 from 1024 px, in 520 px), 'Nothing here' at 56/60; an error adds one red line above it
  and the reference under its button. 'Needs a connection' and 'the server isn’t answering' offer
  nothing: they open by themselves. Offline at the start URL, Today keeps its title and avatar,
  the quiet line, and the sessions saved on this device or 'Today isn’t saved on this device'
  with 'Log something else'. Outside the shell the same block is centred in the window at
  `--content-readable`.
- **Profile** (`/profile`): one list in groups (You, Training, App, Security), each row with its
  answer, then About this app (Backups first, then database, version, environment) and the
  real-user performance card. From 1024 px the list up to 400 px wide (44 px rows, no chevrons,
  answers in tertiary) and the open screen beside it behind a hairline, `--content-profile` (68 rem) in
  all, centred right of the rail; on Profile itself the open side is About this app, and the
  owner's name sits above the title.
- **Appearance** (`/profile/appearance`): the theme as a choice list (Dark, Light, Match my
  phone), then this device's weights and distances. A choice applies at once, so no Save. From
  1024 px Profile's columns, with Appearance open.
- **Profile sections** (`/profile/[section]`): split. From 1024 px `ProfileList` (Profile's whole
  list, the open one `aria-current`) beside the editor, in Profile's columns; Back is hidden. The
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
- **Train** (`/train`): readable (Instrument v2, v2/07a1). On a phone and from 1024 px alike,
  one column: the week's place and its arrows, its title and what is done, `WeekLines`, the
  week's one line and More, which opens the plan, history and tools in place. A state (no plan,
  not planned yet, a free week, a block done, the error) stands at the foot of a phone above the
  tab bar, and at the column's top from 1024 px. The picked session's column at the right (Paper,
  11 · Desktop) arrives with v2/08.
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
  `expectMainCentred(page, await tokenPx(page, '--content-readable'))` (or `--content-wide`). It
  expects `<main>` centred right of the rail, or 200 px less the gutter from it where centring
  would put it further.
- `*.desktop.e2e.ts` specs run in the `desktop-chromium` project (1440 × 900), not in the iPhone
  projects; a serial spec's desktop cases use `test.use(DESKTOP)` and run on Chromium and WebKit.
  There is no desktop WebKit project (the owner's desktop browser is Chrome; docs/testing.md).

## Components (`src/lib/ui/components`)

| Component           | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Button`            | `primary · secondary · danger · ghost · link`: the one filled button a screen has (disabled and loading go quiet on surface-2); `secondary` and `danger` are quiet surface-2 buttons; `ghost` is a 15 px text button; `link` an underlined text action. `sm · md · lg` 36/48/60 px (hit area always ≥ 44 px), radius 16, leading/trailing icon, `loading` (keeps width, `aria-busy`), `block`, renders `<a>` with `href`; pressed = scale 0.97 + tone.                                                                                                                   |
| `IconButton`        | Round. `ghost · filled · accent`, `sm · md · lg` 36/44/60; filled is surface-3, the stepper's ±; `pressed` shows the inverse fill; required `label` (accessible name); `tooltip` captions it with the label on hover and keyboard focus (fine pointers only).                                                                                                                                                                                                                                                                                                            |
| `Icon`              | Inline SVG set (`src/lib/ui/icons/icons.ts`, 24 px grid, 1.75 px round strokes); decorative unless `label`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Surface` / `Card`  | Legacy in v2: padding kept; a hairline outline, no fill, tint or shadow; every radius is 20 px; `level` and `tone` are accepted and draw nothing; `interactive`/`href` take the list-row tint (surface-2) on hover and press, with no scale. `Card` adds eyebrow/title/action header (`aria-labelledby`); its title is 17 px semibold.                                                                                                                                                                                                                                   |
| `NumberStepper`     | One-handed −/+: round 60 px surface-3 controls (`IconButton` lg) around a 64 px Mona numeral, tabular; the label sits left above it at 15 px. Press-and-hold accelerating repeat, tap-to-type (`inputmode=decimal`), `role=spinbutton` with ArrowUp/Down, PageUp/Down, Home/End; `error` replaces `hint` (`aria-invalid`, `role=alert`). The workout logger and the set edit sheet keep their pre-v2 text and 56 px controls until v2/10.                                                                                                                                |
| `BottomSheet`       | Native `<dialog>` + `showModal()` (platform focus trap, inert background), Escape/backdrop close, focus returns to opener, touch swipe-to-dismiss (distance or velocity), content mounted only while open. The title (Hubot 26/32) and the quiet ghost × at every width; on a phone a 36 × 4 handle with 28 px under it and a bottom of the home inset plus 10 px. From 1024 px a 480 px dialog (surface-1, 28 px corners, 40 px in), or with `desktop="panel"` a full-height 496 px panel at the right, on the canvas over a clear backdrop, so the page stays in view. |
| `SegmentedControl`  | Legacy in v2: `radiogroup` with roving tabindex and arrow keys; an inverse thumb on a surface-2 track, no outline; `sm` (36 px track) options extend their hit area to 44 px.                                                                                                                                                                                                                                                                                                                                                                                            |
| `Tabs`              | Legacy in v2: WAI-ARIA tabs (automatic activation, arrows/Home/End), an animated text-coloured indicator (never amber), renders active panel.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `AppNav`            | Primary navigation (real links, preload on tap): four tabs, 24 px icons and 12 px labels, current in text colour and 600 with no pill, on a canvas bar with a hairline; from 1024 px a left rail on the canvas with a hairline at its right and no brand mark, the tabs 28 px apart and the avatar link to Profile at its foot; one `<nav>`, so the links, their order and `aria-current` match at every width (Responsive layout → Shell).                                                                                                                              |
| `.avatar-link`      | Global (layout.css). `.avatar-link`: Profile's 32 px surface-2 avatar link with a 44 px hit area, current with a 1.5 px text ring. `.back-link`: a detail page's way back, the parent's name after a 16 px chevron, 15 px secondary, 44 px tall (Responsive layout → Shell).                                                                                                                                                                                                                                                                                             |
| `Skeleton`          | Shimmer placeholder (static under reduced motion); pair with `aria-busy` on the region.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `EmptyState`        | One sentence (Hubot 26/32; 17 px 600 when `compact`), a 17/26 line on what to do (15/22 compact), at most one action; lined up with the text above it, `align="center"` when alone. No glyph: `icon` and `tone` are deprecated, accepted and not drawn.                                                                                                                                                                                                                                                                                                                  |
| `Toaster` + `toast` | Polite live region; `neutral · positive · danger`; optional action, a strong text link (Undo); auto-dismiss. One surface-2 line at a time, a new one taking the place of the one on screen: 10 px over the tab bar and the resume line, plus `--toast-lift`; 52 px, 16 px corners, as wide as the column; from 1024 px in the shell 48 px, 14 px corners, at the column's text edge 40 px over the window's foot, as wide as its words. Only `danger` has a leading alert icon; a 44 px × only on a toast that stays (`duration: 0`).                                    |
| `PageHeader`        | Eyebrow + large title + trailing slot; a `badge` sits on the eyebrow line, clear of the title.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `BrandMark`         | The performance-gauge mark (also the PWA icon).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Stat`              | Legacy in v2: the one metric tile, with no fill or outline and its padding kept: label, big value + inline unit, optional rating (word + dot), caption. `level 1` on the canvas (26 px value), `level 2` nested in a card (24 px). No value → a dash announced as "No data yet", never a made-up number.                                                                                                                                                                                                                                                                 |
| `Badge`             | Legacy in v2: a status word on its line, with no pill, tint or outline: `neutral` (default; the only tone for "Soon"), `accent` (the next step, sparingly), `positive · warning · danger`; optional icon. Words carry the meaning.                                                                                                                                                                                                                                                                                                                                       |
| `Chip`              | Legacy in v2: plain secondary label (e.g. a discipline, no outline or pill) with an optional discipline-colour dot; static, not a control.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ListRow`           | Instrument v2 list row: title, subtitle, an optional trailing `value` in secondary text, then a chevron or a `trailing` snippet (a "Soon" badge). At least 60 px, no fill, a hairline under each row but a list’s last; `danger` draws the title in the danger colour with no chevron. Renders a link (`href`), a button (`onclick`) or a static row (`disabled`); `static` is a status row (no action, no chevron) and `valueTone="warning"` draws the value in `--color-warning`. `icon` and `tone` are accepted and not drawn: v2 rows have no tiles.                 |
| `ProfileList`       | `src/lib/ui/profile`. Profile's list: the sections in You and Training, then App (Appearance) and Security; each a `ListRow` with its answer (`answers.ts`, streamed from the Profile layout's load, `app:profile-answers`; the theme once mounted); the open one `aria-current`. From 1024 px 44 px rows with no chevron, answers in tertiary, the group headings for assistive tech only.                                                                                                                                                                              |
| Appearance screen   | `/profile/appearance`. `ChoiceGroup` cards: the theme (Dark, Light, Match my phone, applied when picked, no Save), then this device's weights and distances (`preferences.svelte.ts`). Words in `src/lib/ui/profile/appearance.ts`.                                                                                                                                                                                                                                                                                                                                      |
| `Section`           | Legacy in v2: titled group on a screen ("This week", "Tools"): one heading style and spacing everywhere, `aria-labelledby` wired.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `training/*`        | `PlateDiagram` (sleeve picture), `PlateCalculator` (code-split sheet body; its kg/lb switch is local and never changes the app-wide preference; from a set row it opens at that set's weight and unit), `PlateInventory` (this device's bar and plates).                                                                                                                                                                                                                                                                                                                 |
| `WeekStrip`         | `src/lib/ui/program`, like the next two. Seven days Monday first in a radiogroup (roving tabindex, arrows, Home/End), each ≥ 44 px at 393 px; a dot per session (a ring if skipped), counted in its name; the server's today ringed.                                                                                                                                                                                                                                                                                                                                     |
| `SessionCard`       | A session: discipline dot, title, 'Strength · 60 min · Hard · Evening'; Skipped, Moved from Mon, Done and Baseline as worded badges; with `href` one link named by its title; `pending` sets `aria-busy` and sweeps a progress line.                                                                                                                                                                                                                                                                                                                                     |
| `PrescriptionLines` | describe.ts's words as a list: '3 × 5 @ RPE 7', the load only when describe could compute one, its basis, rest and tempo, the baseline instruction; run steps with each segment's pace and effort. It never computes a number.                                                                                                                                                                                                                                                                                                                                           |
| `WeekLines`         | `src/lib/ui/program`. A week as 60 px lines (week-lines.ts's words): the day, the title, then a tick, 'Skipped' or the length; past lines quiet, today's 'Today' in 600; a day off one 'Rest' line; a day's second session leaves its day blank. With `href` each session's line links to its page, busy while it loads; read-only weeks and off-plan workouts link nowhere.                                                                                                                                                                                             |
| `BlockTimeline`     | The plan on a rail (timeline.ts's words): each block's name, phase, dates and length, then its weeks; 'This week', an 'Event' under its week, outline weeks 'Not planned yet' and never links; with `weekHref`, planned weeks are links.                                                                                                                                                                                                                                                                                                                                 |
| `PlanOverviewSheet` | Train's plan in a `BottomSheet`, code-split and fetched on intent; a tapped week closes it and opens on Train through the week's pending state. A chunk that fails to load: 'Couldn’t open your plan' with Retry under its row in More.                                                                                                                                                                                                                                                                                                                                  |
| Bridge week         | A late start's unplanned weeks between blocks: Train's 'Free week' statement with the next block's start (no rest days), the week's workouts as lines that link nowhere; History's 'Unplanned week · between blocks' card; Today's 'Between blocks' with Log something else; a hatched timeline block.                                                                                                                                                                                                                                                                   |
| `ExerciseBlock`     | A planned exercise as an `article` named by its heading: its name (a superset's 'A1' before it), the coach's instructions, then its sets as `PrescriptionLines`, from session-words.ts's `exerciseViews`.                                                                                                                                                                                                                                                                                                                                                                |
| `RunSegments`       | A run as a timeline in describe.ts's words: a dot per step on a rail, each repeat group as one bracketed block ('6×', 'Repeat 6 times') over its segments, each with its pace in the owner's unit and effort.                                                                                                                                                                                                                                                                                                                                                            |
| Run zones           | On the session screen a segment's effort is its heart-rate zone in bpm, 'Zone 2 · 134–148 bpm', from the owner's max or threshold heart rate, resting refining max (Profile → Running & Muay Thai → Heart rate), and 'Zone 2' with none told; then its RPE.                                                                                                                                                                                                                                                                                                              |
| `SessionDetails`    | A session at a glance: duration and target RPE as two `Stat`s (the intensity as the RPE's caption), then an other session's metrics as a grouped list, label left and value right, each row ≥ 44 px.                                                                                                                                                                                                                                                                                                                                                                     |
| `BaselineCallout`   | Week 1's baseline instructions on a strength session, on a `Surface` (its accent tone no longer tints): why it sets the loads ahead, how to work up to the target RPE, and what to record. Copy from session-words.ts.                                                                                                                                                                                                                                                                                                                                                   |
| `EditSheetHost`     | Every edit's sheet, code-split with its `BottomSheet`: a skeleton while the edit loads, 'Couldn’t load this editor' with Retry if it fails; Save busy and disabled while posting; focus back on the trigger; a toast once saved.                                                                                                                                                                                                                                                                                                                                         |
| `MoveSheet`         | Inside the host: the week's remaining days as `ChoiceGroup` cards with what is planned, rule warnings before saving, an optional reason; conflict and offline notices; 'No other day left this week' offers Skip.                                                                                                                                                                                                                                                                                                                                                        |
| `SwapSheet`         | From an exercise's Swap: ranked alternatives as `ChoiceGroup` cards, each with why it fits; an explained 'Never prescribe … again' `Toggle` (off: this session only); a reason. Empty: 'Nothing fits your equipment and injuries', why, a Profile → Equipment link, no Save.                                                                                                                                                                                                                                                                                             |
| `AdjustSheet`       | On an exercise, a run or a class: a `NumberStepper` per value it has (sets, reps, RPE, load, rest; repeats, distance, duration, pace; length), a row picked first as cards when there are several, a reason; a value out of range is its stepper's error and nothing posts.                                                                                                                                                                                                                                                                                              |
| `SkipSheet`         | What skipping does, said before saving, and a reason. Skipped, the session shows a 'Skipped' `Notice` with a History link in place of its edit row; Train's line says Skipped.                                                                                                                                                                                                                                                                                                                                                                                           |
| `TextField`         | Labelled single-line input, label above (never placeholder-as-label). Instrument v2: 56 px, 14 px corners, surface-2, no border; 17 px text, so iOS never zooms. `mono` for codes, `type="date"`, "Optional". The hint or error is wired with `aria-describedby`; the error replaces the hint and is one red line under the field, never a red border. Disabled is disabled text (`--color-text-disabled`), not faded.                                                                                                                                                   |
| `NumberField`       | A number that may stay blank (`null`, never 0): a 56 px v2 field, the unit in tertiary inside it and in its description; decimal or numeric keypad, `enterkeyhint`, digits and one decimal point only, "Optional" marker. For values people nudge: `NumberStepper`.                                                                                                                                                                                                                                                                                                      |
| `TextArea`          | Multi-line notes: label above; 14 px corners, surface-2, 17/26 text (no iOS zoom); grows with its content (`field-sizing`; `rows` and a resize handle where unsupported), `maxlength`, hint or error wired with `aria-describedby`, "Optional" marker.                                                                                                                                                                                                                                                                                                                   |
| `ChoiceGroup`       | One (radio) or several (checkbox) from a short list. `pill` (default): a quiet surface-2 pill, a picked one the inverse fill, never amber. `card` is the v2 choice list: 60 px rows, a hairline between them (none under the last), the picked row in 600 with a check; the hint sits under the label, or at the row's end with `hintPlacement="end"` for a short one. Native inputs in a `fieldset` (Tab, arrows, Space), ≥ 44 px, a discipline dot, errors as one red line.                                                                                            |
| `DayPicker`         | Monday-first row of seven round toggles: an unpicked day is a surface-2 disc, a picked one the inverse fill (never amber) and ticked. Native checkboxes named with the full day, value always in week order, hit areas reaching into the gaps so each stays ≥ 44 × 44 px inside a padded card at 393 px; an error draws the danger border.                                                                                                                                                                                                                               |
| `Toggle`            | On/off row: a native checkbox with `role="switch"` covering the whole row (the hit area, ≥ 44 px), the title as its name and the description as `aria-describedby`; Space flips it. On is the inverse fill, never amber; the thumb's side says on or off.                                                                                                                                                                                                                                                                                                                |
| `TagInput`          | Short free-text list: Add or Return adds the trimmed text, a repeat in any case is refused, `maxlength` and `max` hold; its field is a v2 field; removable quiet surface-2 pills (44 px remove buttons), one-tap suggestions, every change and refusal announced politely.                                                                                                                                                                                                                                                                                               |
| `Notice`            | Inline line: `danger` is one red line (`role="alert"`); `positive`, `warning`, `neutral` plain words (`role="status"`). No box, no glyph (`icon` deprecated).                                                                                                                                                                                                                                                                                                                                                                                                            |
| `RecoveryCodes`     | One-time display of recovery codes: numbered list (one per row on a phone, two columns when the container allows), copy and download, required acknowledgement checkbox.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ChartFrame`        | `ui/charts`. A chart's `<figure>`: title, context and summary server-rendered; the plot box reserved with a hairline grid; the body from a `CHART_BODIES` loader after hydration; a failed chunk: `Notice` and Retry; no JS: 'Chart needs JavaScript'; an `availability` slot.                                                                                                                                                                                                                                                                                           |
| `ChartTable`        | `ui/charts`. The table twin: `<details>` 'Show as table' (≥ 44 px), a keyboard-scrollable table with scoped headers, units, every value ('No data' when missing), the week in progress marked 'so far'.                                                                                                                                                                                                                                                                                                                                                                  |
| `LineChart`         | `ui/charts/bodies`, `CHART_BODIES.line`. Up to 4 series: 2 px lines with gaps, legend from 2, end labels with leaders (numbers < 18rem); 8 px end dot, hollow ring (estimated), diamond (measured), dashed ring 'so far'; crosshair and tooltip by pointer, touch or ←/→/Home/End.                                                                                                                                                                                                                                                                                       |
| `BarChart`          | `ui/charts/bodies`, `CHART_BODIES.bar`. Columns ≤ 24 px, rounded data end; stacks in `STACK_ORDER`, 2 px gaps, rect keys, totals that fit; dashed plan outline, target band, outlined 'so far' week; each mark a button, tooltip by hover, tap or arrows; forced colours: hatches.                                                                                                                                                                                                                                                                                       |
| `RangeBars`         | `ui/charts/bodies`, `CHART_BODIES.range`. A horizontal bar a group in one hue, largest first (ties by name); range bracket (open past the axis), plan tick; status as icon and words (Below, Within, Above range); each row a ≥ 44 px button, tooltip by tap, hover or arrows.                                                                                                                                                                                                                                                                                           |
| `DivergingBars`     | `ui/charts/bodies`, `CHART_BODIES.diverging`. Actual − target RPE a row, bars from a centred zero: `--chart-diverge-cool` below, `-warm` above, `-mid` within ±0.5; signed value and Easier, On target or Harder in words; rows and tooltips as `RangeBars`.                                                                                                                                                                                                                                                                                                             |
| `TrendTile`         | `ui/analytics`. A metric at a glance: label, value + unit, kind `Badge`, delta in words + icon toned by direction × good (normal variation neutral), the so-far line, a server-computed sparkline (one 2 px polyline), verdict; read as one sentence; `Stat`’s no-data contract.                                                                                                                                                                                                                                                                                         |
| `VerdictBadge`      | `ui/analytics`. Real improvement, Real decline, Normal variation or Not enough data yet · 2 of 6 weeks, in words + icon, with ‘over the last 12 weeks’ when the window is not the period’s; sentence case, wraps.                                                                                                                                                                                                                                                                                                                                                        |
| `MetricContext`     | `ui/analytics`. One line: the period, its comparison, the trend window when it differs, what counts as good; then a `<details>` (≥ 44 px) with the method and any caveat.                                                                                                                                                                                                                                                                                                                                                                                                |
| `PeriodPicker`      | `ui/analytics`. Five real links to `?period=` (4w … All, named in full), `aria-current`, each a history entry, `data-sveltekit-reset="false"`, ≥ 44 px at 320 px; another period loading dims the content, `aria-busy` and inert, no skeleton.                                                                                                                                                                                                                                                                                                                           |

v2 has no cards, chips, segmented controls or stat tiles: they are flattened and each screen row removes them; new work uses list rows, choice lists and sheets.

A `ChoiceGroup` records a choice; it is never an "add" action (arrow keys check every radio they
pass, so a radio that adds a row adds one per keypress). An optional single choice offers an
explicit option such as "Not set" or "Any" that the caller maps to `null`: there are no clearable
radios.

Screens compose these primitives instead of styling their own tiles, pills, rows or section
headings, so the same pattern cannot drift between screens (PRD §16). `/design` shows every
primitive (the Inputs, Data and Feedback groups load when their tab opens), and the Plan tab the
program components on a fixture week, their pending and status states included, and Train's
`WeekLines` on Paper's week. Its Workout section
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
  run's segments) beside the main column at the readable width (Responsive layout → Screens),
  which stays 40 rem here (the shell's is 38.5 rem) until `v2/10`.
- **The docked timer.** The rest timer docks at the top of the main column under the header, never
  over content; the logger is a card under the set rows, not stuck to the window.
- **History.** The list beside the picked workout's detail, 'Pick a workout' when none is picked.
- **The resume line.** On the rail layout it docks at the bottom of the content column, inset by
  the rail, and the content's bottom padding grows with it (`--resume-inset`), so it covers nothing.
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
| `ResumeBar`                      | `src/routes/(app)`. One plain line on the tab bar: Resume {title} with the time, the sync pill and a chevron, N changes waiting to sync, or Continue here on Today; it raises `--resume-inset`, so it covers nothing.             |
| `HeldScreen`                     | `src/routes/(app)`. While another screen loads: its last copy dimmed to 40 %, else the tab's title and four short bars (aria-busy, 'Loading Train'); inert, fixed over the column under the nav.                                  |

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
| Bridge weeks                   | A late start's unplanned weeks: Train's 'Free week' statement (with the day the next block starts, and the week's workouts as lines), History's notice, Today's 'Between blocks', and `BlockTimeline`'s hatched block with its weeks 'Unplanned'.                                                                                                                                                                                                                                                                                                                                    |
| Train's review notice          | On a week a review changed, in the week's note behind the one line under the week: who decided it, each change with its why, and links to History and the review (`services/programs/week-changes.ts`).                                                                                                                                                                                                                                                                                                                                                                              |

## Accessibility checklist (applies to every new component)

- Touch targets ≥ 44 × 44 px; visible `:focus-visible` ring (`--color-accent-ring`).
- Text contrast ≥ 4.5:1 in **both** themes. `e2e/a11y-suite.ts` runs axe-core (WCAG 2.1 A/AA)
  on every screen, the plate-calculator sheet and each `/design` group in dark and light; CI
  runs it with the rest of the e2e suite (Lighthouse only audits the default dark theme).
- Use native elements first (`<dialog>`, `<button>`, links); ARIA patterns for composites.
- Selected is a check or the inverse fill plus weight, never amber.
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

The engine's words reach the screens as the server wrote them: a finding, a placement, a week's
kind and a re-plan's source are plain sentences, and a component never computes one. Calm, not
alarming: a clash is a heads-up in the secondary text colour or the warning glyph, never the danger
tone, and a lighter week is deliberate, so it never takes a tone at all. Each disclosure is a native
`<details>` with a 44 px summary, the focus ring and a brighter colour on hover, so it opens without
JavaScript. Train's M7 markup and CSS live in Train's page (its week note), not in `SessionCard`,
so Today and History load none of it; `/design` → Plan shows a copy of each.

| Piece                        | Highlights                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Week finding (Train)         | In the week's note, behind the one line under the week (v2/07a1): each finding once (not once per session it names), label and headline first, then 'Why: …' in tertiary text. A CSS glyph (a ring, filled in `--color-warning` for `caution`) and the words carry the meaning: 'Heads-up' (an avoid finding nothing explains, or the owner's own move), 'Your move' (advice) or 'Trade-off, explained' (kept for a stated reason). The line itself counts them: '1 heads-up this week', 'No clashes ahead this week' or 'No clashes this week'; none on past, outline and bridge weeks.                |
| 'Why Lower A on Monday?'     | In the week's note, after the findings: per session a decision names, a `<details>`, closed by default, with no glyph, so it never reads as a finding. Its body is a plain list, one line a decision, the owner's moves first, then newest first, at most six: 'Session moved (You, version 2): …'. A session no decision names has none, and when the decisions cannot be read the week renders without them.                                                                                                                                                                                          |
| Move sheet                   | Each day it offers is judged with the week's M7 context. The day the scheduler would pick adds 'Clears this week’s clash' to its card's hint. Each day a move would bring a clash to is one line in a 'Heads-up before you pick' list under the day cards (a choice card is one hit area, so nothing inside it can open), in the secondary text colour. One finding a day; a warning never blocks the move. Without the context, the days show M3's warnings alone.                                                                                                                                     |
| Week kind (Train and Today)  | A deload, taper, event, recovery, cutback or maintenance week still ahead is named in Train's week note, behind the one line under the week (the line says 'Deload week' when nothing comes before it), and at the top of Today's day: the kind ('Deload week'), then its why in secondary text, with ' · 10K race in 24 days' when an event is within 8 weeks. Today shows the kind as a neutral `Badge`. Never a tone.                                                                                                                                                                                |
| Season timeline (plan sheet) | `PlanOverviewSheet` lays the season over `BlockTimeline`. Each block from this one on lists each goal's role as one fixed-height line, the leader first in semibold ('Muay Thai fight · leads'), under 'Goal roles'. A phase tone colours only its node, beside its name. Four or more outline weeks without an event are one counted row ('Weeks 12–17 · 6 weeks · Not planned yet'). From 1024 px a segmented track runs above the list (aria-hidden; the list is its twin). While the season streams the region ('Your season') is aria-busy with its room held; a failed read leaves M3's timeline. |
| `ReplanNotice` (Profile)     | `src/lib/ui/profile`. One calm line under Profile → Goals, in a polite live region that takes no room until an answer arrives: a re-plan is ready (a link to it), the plan already fits, the next block will follow, build a program from Today, or it could not be prepared, with 'Try again'. `Notice`'s neutral tint, no icon; the words live in `replan-notice.ts`. Train's week note links 'See the plan your coach suggests' while one waits.                                                                                                                                                     |
| Re-plan proposal card        | `ProposalCard` says where a re-plan came from, under its title: 'From your goal change', 'From your training load', 'From your weekly review · Week of 2 Nov' or 'From your coach', each linking to its source. A deload reads 'Week of 16 Nov becomes a deload week'. A stale re-plan keeps its reason and offers 'Propose again' in the inbox's detail; busy is `aria-busy`, a refusal is the engine's sentence on a neutral line, a failure is 'Couldn’t prepare it' with Try again, and offline the button is disabled with the reason.                                                             |
| Deload card (weekly review)  | `NextWeekCard`. Its headline is worked out when the page is read: 'This week becomes a deload week from today', 'Next week becomes a deload week' or 'Week of 16 Nov becomes a deload week'. 'Why' lists at most five signals; 'What changes' lists the proposal's rows through `DiffRows`. 'Accept the deload' and 'Keep the plan'. A stale or late deload says so and offers 'Propose again', with the same busy, refusal, failure and offline states as the proposal card.                                                                                                                           |
| Heart-rate fields (Profile)  | `SpecificsEditor`, in Profile → Running & Muay Thai and in onboarding: a 'Heart rate' `Section` of three optional `NumberField`s in bpm (max, resting, threshold) on the numeric keypad, after the Running card. Range and order errors show at their fields. A run session then reads 'Zone 2 · 134–148 bpm', or 'Zone 2' with none told, as server text.                                                                                                                                                                                                                                              |

## Final QA and release (M9)

m9/52 backup-status: Profile's About this app group opens with a Backups status row (`ListRow static`): the server's words (`src/lib/domain/backup/status.ts`), 'Not set up', '6 h ago · 2.5 MB', 'Can’t check now' in secondary text, or a calm warning in `--color-warning` with its words, 'None since Tue 3 Nov', 'Last one failed', 'None yet'. Never the danger tone, a Notice or a toast. While the status streams, a 7 rem Skeleton holds the value's place in the same 60 px row ('Checking…' for screen readers), so nothing below moves. v2/21a put it first among the status rows under About this app.
