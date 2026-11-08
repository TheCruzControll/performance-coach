# Design system

Dark-first, iPhone-first, built by hand on CSS custom properties (ADR 0005). Live reference:
**`/design`** in the running app (also linked from Profile).

## Principles

1. **Glanceable under load.** Mid-set, sweaty, one hand: big numerals, high contrast, ≥ 44 px
   targets, primary actions in the thumb zone.
2. **Quiet surfaces, one loud accent.** Near-black layers, hairline borders, a single volt accent
   for the next action. Discipline colours appear only as small signals (dots, tags, series).
3. **Depth from light, not shadow.** Dark UIs read elevation from tone and a 1 px top highlight.
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
script in `src/app.html`, which also updates `<meta name="theme-color">`. With **Auto**, the app
keeps listening to `prefers-color-scheme` while open, so when iOS switches appearance (e.g.
automatic dark mode at sunset) the theme-color and status-bar metas follow the CSS (e2e-tested).
**Browser baseline:** `light-dark()` needs Safari 17.5+ / Chrome 123+.

## Colour

| Token                    | Dark      | Light     | Use                                                |
| ------------------------ | --------- | --------- | -------------------------------------------------- |
| `--color-canvas`         | `#0a0a0b` | `#f4f4f0` | page background                                    |
| `--color-surface-1`      | `#121214` | `#ffffff` | cards                                              |
| `--color-surface-2`      | `#19191c` | `#ecece7` | inputs, segmented tracks, nested surfaces          |
| `--color-surface-3`      | `#222226` | `#e2e2dc` | pressed states                                     |
| `--color-text`           | `#f2f2ee` | `#111113` | primary text                                       |
| `--color-text-secondary` | `#a3a3a8` | `#55555c` | supporting text                                    |
| `--color-text-tertiary`  | `#86868e` | `#66666e` | captions, eyebrows (≥ 4.5:1 on canvas/surface-1/2) |
| `--color-accent`         | `#c8f031` | `#c8f031` | **the** accent: primary CTA, active nav, focus     |
| `--color-accent-text`    | `#d2f25a` | `#4b6400` | accent used as text (contrast-safe)                |
| `--color-on-accent`      | `#0c0e03` | `#0c0e03` | text on accent (14.8:1)                            |

Discipline colours (signals only — never large fills):

| Token                  | Dark      | Light     |
| ---------------------- | --------- | --------- |
| `--color-strength`     | `#f2b544` | `#b37515` |
| `--color-running`      | `#46c2f0` | `#0b80b3` |
| `--color-combat`       | `#ff6a4d` | `#d2452a` |
| `--color-hypertrophy`  | `#b28dff` | `#7a4bd6` |
| `--color-conditioning` | `#3fd6b5` | `#0e9b7c` |

Status: `--color-positive`, `--color-warning`, `--color-danger` (+ `-subtle`), `--color-info`.
All four are text-safe: ≥ 4.5:1 on canvas, surface-1 and surface-2 in both themes (the light
values were darkened in M1 review round 2: positive `#0f7a40`, warning `#955a09`, danger
`#bb2c28`, info `#1b66b3`). On their own 12% tint (badges) the light theme darkens the text a
further 18%.
Plate colours in the plate calculator follow the physical IWF convention on purpose.

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
  an icon and a word). M1's dark strength sits ΔE 0.7 from warning, one more reason charts use
  their own steps.

**Diverging pair**, for a signed difference from a target (actual minus target RPE): cool below,
warm above, a grey with no hue at zero, so on target reads as nothing to see.

| Token                  | Dark      | Light     |
| ---------------------- | --------- | --------- |
| `--chart-diverge-cool` | `#4f78e8` | `#3f74e6` |
| `--chart-diverge-warm` | `#d9507a` | `#c63d6b` |
| `--chart-diverge-mid`  | `#74747a` | `#86867f` |

- The poles: ≥ 3:1, normal-vision ΔE 27.7 light and 26.6 dark, CVD 19.9 and 17.3 (floors 15 and
  8). The midpoint: chroma < 0.02, 3.66:1 light and 4.03:1 dark.
- Each pole is at least ΔE 8 from every status and series colour (closest: light warm against
  danger, 8.6; dark warm against combat, 9.6). The pair never shares a chart with discipline
  series, and a status shown beside it is labelled in words.

**Furniture** (everything that is not data):

| Token              | Dark      | Light     | Use                                                    |
| ------------------ | --------- | --------- | ------------------------------------------------------ |
| `--chart-surface`  | surface-1 | surface-1 | what every chart sits on                               |
| `--chart-muted`    | `#6b6b71` | `#8b8b85` | a context series beside the one in colour (≥ 3:1)      |
| `--chart-grid`     | `#1f1f23` | `#ebebe6` | hairline gridlines                                     |
| `--chart-axis`     | `#2e2e33` | `#d4d4ce` | axis rules and ticks                                   |
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
- **Surfaces.** Charts sit on surface-1 (`--chart-surface`), never surface-2: light conditioning
  is 2.95:1 there.
- **Motion.** Marks do not animate in. Hover and scrub feedback uses `--duration-fast`, a
  refetch keeps the previous frame at reduced opacity with `aria-busy`, and under
  `prefers-reduced-motion` nothing moves.

## Typography

| Role               | Family                    | Notes                                                                                                         |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Display / headings | **Hubot Sans** (variable) | Mechanical, athletic grotesk; large titles at weight 720–840, tight tracking                                  |
| UI / body          | **Mona Sans** (variable)  | Refined grotesk; body at weight 420                                                                           |
| Data numerals      | **Mona Sans** figures     | `.numeric`: proportional lining figures for standalone values; `.tabular`: tabular figures for timers/columns |

Why numerals are not Hubot: Hubot's zero is barred, and both families' tabular figures use a
slashed zero — legible in columns, but noisy for one big number read at a glance in the gym. Big
standalone values (target weight, stats) therefore use Mona's proportional lining figures.

Scale (`--text-*`): 2xs 11 · xs 12 · sm 14 · base 16 · lg 18 · xl 22 · 2xl 28 · 3xl 34 · 4xl 44 ·
5xl 56 · 6xl 72 px. Inputs are never below 16 px (prevents iOS zoom). Weights:
`--weight-regular 420`, `medium 520`, `semibold 620`, `bold 720`, `black 840`.
Tracking: `--tracking-display -0.032em`, `--tracking-tight -0.016em`, `--tracking-caps 0.08em`
(uppercase eyebrows).

### Fonts: loading strategy

- Self-hosted from `@fontsource-variable/{mona-sans,hubot-sans}`; only the **latin** `wght`
  woff2 files are declared for the main ranges (39.8 KB + 48.3 KB); Mona latin-ext is declared
  with a `unicode-range` and only fetched when needed.
- Both latin files are **preloaded** (policy in `src/lib/ui/fonts.ts`, applied in
  `hooks.server.ts`; budget ≤ 2 files) with `font-display: swap`.
- Metric-matched fallbacks (`Mona Sans Fallback`, `Hubot Sans Fallback` → local Arial/Helvetica
  with `size-adjust` / `ascent-override` / `descent-override`) computed from the font files with
  fontTools; measured CLS is 0.000 on audited routes (docs/performance.md).

## Space, shape, depth, motion

- **Spacing** (4 px grid): `--space-0-5` 2 · `1` 4 · `1-5` 6 · `2` 8 · `3` 12 · `4` 16 · `5` 20 ·
  `6` 24 · `8` 32 · `10` 40 · `12` 48 · `16` 64 · `20` 80 px. Page gutter `--gutter` 20 px.
- **Radii:** `xs` 6 · `sm` 10 · `md` 14 · `lg` 20 · `xl` 28 · `full`. Buttons and segmented
  controls are pills; cards use `lg`/`xl`.
- **Elevation:** `--elevation-1/2/3` = top highlight + soft ambient shadow; `--glow-accent` only
  on the primary CTA.
- **Motion:** `--duration-instant 90ms · fast 160 · base 240 · slow 380 · slower 560`;
  `--ease-standard`, `--ease-out`, `--ease-in`, and `--ease-spring` (CSS `linear()` spring) for
  thumbs and indicators. `prefers-reduced-motion` sets durations to 0 and disables shimmer.
- **Glass:** `--color-glass` (92% canvas) + `backdrop-filter: saturate(180%) blur(32px)` on the
  bottom nav and the coach composer (opaque and blurred enough that text scrolling behind a tab
  label cannot be read); the sheet scrim uses a light 2 px blur. Write only the standard
  `backdrop-filter`; Lightning CSS adds `-webkit-backdrop-filter` for the Safari build targets.
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
- Large titles (`PageHeader`): eyebrow + 34 px display title, iOS-style.
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
  `--color-accent`. They are the favicon's two strokes on no background; the favicon's opaque
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
- **Session** (`/train/session/[key]`): readable, one column centred beside the rail; its stats,
  exercise cards and run timeline keep the phone's order, and Back has hover and focus states.
- **Progress** (`/progress`): wide (`data-layout="wide"` on its root). From 1024 px the three
  `Stat` tiles keep one row across the full width, with wider gaps, over a taller empty plot.
- **Coach** (`/coach`): readable, as a conversation should be. From 1024 px the suggestions sit in
  two columns; the composer is screen chrome, centred over the column.
- **Security** (`/profile/security`): readable, a settings screen, and left as it is (its route
  has the least initial-JS headroom). Its four sections and Sign out read, and Tab, in order.
- **Design gallery** (`/design`, outside the shell): from 1024 px up to `--content-wide`, its
  groups in pairs (Color beside Type, Components beside Cards & tones), each about a phone column
  wide so no specimen stretches; the header and the icon grid span both, with larger cells.
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
- `*.desktop.e2e.ts` specs run in the `desktop-chromium` and `desktop-webkit` projects (1440 × 900),
  not in the iPhone projects.

## Components (`src/lib/ui/components`)

| Component           | Highlights                                                                                                                                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`            | `primary · secondary · ghost · danger`, `sm · md · lg` (36/48/56 px; hit area always ≥ 44 px), leading/trailing icon, `loading` (keeps width, `aria-busy`), `block`, renders `<a>` with `href`; pressed = scale 0.97 + tone.                                                       |
| `IconButton`        | Circular, required `label` (accessible name), `ghost · filled · accent`, `sm · md · lg`.                                                                                                                                                                                           |
| `Icon`              | Inline SVG set (`src/lib/ui/icons/icons.ts`, 24 px grid, 1.75 px round strokes); decorative unless `label`.                                                                                                                                                                        |
| `Surface` / `Card`  | Levels 1–3, padding, radius, discipline `tone` tint, `interactive`/`href`; `Card` adds eyebrow/title/action header (`aria-labelledby`).                                                                                                                                            |
| `NumberStepper`     | One-handed −/+ (56 px), press-and-hold accelerating repeat, tap-to-type (`inputmode=decimal`), `role=spinbutton` with ArrowUp/Down, PageUp/Down, Home/End; `error` replaces `hint` (`aria-invalid`, `role=alert`).                                                                 |
| `BottomSheet`       | Native `<dialog>` + `showModal()` (platform focus trap, inert background), Escape/backdrop close, focus returns to opener, touch swipe-to-dismiss (distance or velocity), content mounted only while open. A centred dialog from 1024 px.                                          |
| `SegmentedControl`  | `radiogroup` with roving tabindex and arrow keys; spring-animated thumb; `sm` (36 px track) options extend their hit area to 44 px.                                                                                                                                                |
| `Tabs`              | WAI-ARIA tabs (automatic activation, arrows/Home/End), animated accent indicator, renders active panel.                                                                                                                                                                            |
| `AppNav`            | Primary navigation (real links, preload on tap): the glass bottom bar, a solid left rail from 1024 px under the brand mark; one `<nav>`, so destinations, order and `aria-current` match at every width (Responsive layout → Shell).                                               |
| `Skeleton`          | Shimmer placeholder (static under reduced motion); pair with `aria-busy` on the region.                                                                                                                                                                                            |
| `EmptyState`        | Medallion glyph (tone-tinted), title, guidance, optional actions; `compact` variant.                                                                                                                                                                                               |
| `Toaster` + `toast` | Polite live region; `neutral · positive · danger`; optional action; auto-dismiss.                                                                                                                                                                                                  |
| `PageHeader`        | Eyebrow + large title + trailing slot.                                                                                                                                                                                                                                             |
| `BrandMark`         | The performance-gauge mark (also the PWA icon).                                                                                                                                                                                                                                    |
| `Stat`              | The one metric tile: label, big value + inline unit, optional rating (word + dot), caption. `level 1` on the canvas (28 px value), `level 2` nested in a card (22 px). No value → a dash announced as "No data yet", never a made-up number.                                       |
| `Badge`             | Uppercase status pill: `neutral` (default; the only tone for "Soon"), `accent` (the next step, sparingly), `positive · warning · danger`; optional icon. Words carry the meaning.                                                                                                  |
| `Chip`              | Quiet outlined label (e.g. a discipline) with an optional discipline-colour dot; static, not a control.                                                                                                                                                                            |
| `ListRow`           | Tool/destination row: tinted icon tile, title, subtitle, chevron or `trailing` snippet; renders a link (`href`), a button (`onclick`) or a dashed, non-interactive row (`disabled`, for "Soon").                                                                                   |
| `Section`           | Titled group on a screen ("This week", "Tools"): one heading style and spacing everywhere, `aria-labelledby` wired.                                                                                                                                                                |
| `training/*`        | `PlateDiagram` (sleeve picture), `PlateCalculator` (code-split sheet body; its kg/lb switch is local and never changes the app-wide preference).                                                                                                                                   |
| `WeekStrip`         | `src/lib/ui/program`, like the next two. Seven days Monday first in a radiogroup (roving tabindex, arrows, Home/End), each ≥ 44 px at 393 px; a dot per session (a ring if skipped), counted in its name; the server's today ringed.                                               |
| `SessionCard`       | A session: discipline dot, title, 'Strength · 60 min · Hard · Evening'; Skipped, Moved from Mon, Done and Baseline as worded badges; with `href` one link named by its title; `pending` sets `aria-busy` and sweeps a progress line.                                               |
| `PrescriptionLines` | describe.ts's words as a list: '3 × 5 @ RPE 7', the load only when describe could compute one, its basis, rest and tempo, the baseline instruction; run steps with each segment's pace and effort. It never computes a number.                                                     |
| `ProgramHeader`     | Train's program title, its block and place ('Baseline week · Week 1 of 5'), a status badge, an actions row (`.action` pills, busy while loading), the weeks as pills between previous and next (≥ 44 px, this week ringed, a loading week busy); week links keep scroll and focus. |
| `BlockTimeline`     | The plan on a rail (timeline.ts's words): each block's name, phase, dates and length, then its weeks; 'This week', an 'Event' under its week, outline weeks 'Not planned yet' and never links; with `weekHref`, planned weeks are links.                                           |
| `PlanOverviewSheet` | Train's plan in a `BottomSheet`, code-split and fetched on intent; a tapped week closes it and opens on Train through the week's pending state. A chunk that fails to load: 'Couldn’t open your plan' with Retry beside Plan.                                                      |
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
| `RecoveryCodes`     | One-time display of recovery codes: numbered monospace list (one per row on a phone, two columns when the container allows), copy and download, required acknowledgement checkbox.                                                                                                 |
| `ChartFrame`        | `ui/charts`. A chart's `<figure>`: title, context and summary server-rendered; the plot box reserved with a hairline grid; the body from a `CHART_BODIES` loader after hydration; a failed chunk: `Notice` and Retry; no JS: 'Chart needs JavaScript'; an `availability` slot.     |
| `ChartTable`        | `ui/charts`. The table twin: `<details>` 'Show as table' (≥ 44 px), a keyboard-scrollable table with scoped headers, units, every value ('No data' when missing), the week in progress marked 'so far'.                                                                            |

A `ChoiceGroup` records a choice; it is never an "add" action (arrow keys check every radio they
pass, so a radio that adds a row adds one per keypress). An optional single choice offers an
explicit option such as "Not set" or "Any" that the caller maps to `null`: there are no clearable
radios.

Screens compose these primitives instead of styling their own tiles, pills, rows or section
headings, so the same pattern cannot drift between screens (PRD §16). `/design` shows every
primitive (the Inputs, Data and Feedback groups load when their tab opens), and the Plan tab the
program components on a fixture week, their pending and status states included.

Auth screens (`/`, `/setup`, `/recover`, `/recover/passkey`) share `src/routes/AuthScreen.svelte`:
brand row, an editorial display headline, the brand mark as a quiet watermark, and the one action
panel pinned to the thumb zone (a card beside the headline from 1024 px: Responsive layout →
Screens). Security (`/profile/security`) uses grouped rows on `Surface`s, destructive actions
behind a confirming `BottomSheet`, and toasts for outcomes.

## Accessibility checklist (applies to every new component)

- Touch targets ≥ 44 × 44 px; visible `:focus-visible` ring (`--color-accent-ring`).
- Text contrast ≥ 4.5:1 in **both** themes. `e2e/a11y.e2e.ts` runs axe-core (WCAG 2.1 A/AA)
  on every screen, the plate-calculator sheet and each `/design` group in dark and light; CI
  runs it with the rest of the e2e suite (Lighthouse only audits the default dark theme).
- Use native elements first (`<dialog>`, `<button>`, links); ARIA patterns for composites.
- Never convey state by colour alone: badges are words, `Stat` ratings are a word plus a dot
  (e.g. RUM p75 tiles: "Good" / "Needs work" / "Poor").
- Respect `prefers-reduced-motion`.
- Verified at 393 × 659 and 1440 × 900 (Responsive layout → Verification).

## Iconography & brand

- Mark: a 270° gauge track with a volt arc stopping short of full ("progress, not perfection").
- App icons are rendered from `static/icons/*.svg` by `pnpm icons` (Playwright Chromium):
  `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (content inside the 80% safe zone),
  `apple-touch-icon.png` (180 px); `favicon.svg` for browsers.
- Product icons (`<Icon name>`): 24 × 24 grid, 1.75 px round strokes, path data in
  `src/lib/ui/icons/icons.ts`. `<Icon>` draws them with `<use>` from one generated sprite, so they
  cost no JavaScript: after adding or changing one, run `pnpm icons:sprite` and commit
  `sprite.svg` and `names.ts` (a unit test fails while they are stale; `pnpm budgets` fails if path
  data reaches a client chunk).
