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
  computed `backdrop-filter`. Judge glass on a device or WebKit: headless Chromium does not
  paint `backdrop-filter` under mobile emulation (`isMobile`, as in the iPhone e2e project), so
  those screenshots show unblurred content behind the nav (checked in M1 review round 2: the
  same page blurs with mobile emulation off).
- **Layers:** `--z-raised 10 · sticky 50 · nav 100 · overlay 200 · sheet 210 · toast 300`.
- **Safe areas:** `--safe-top/right/bottom/left` from `env(safe-area-inset-*)`;
  `viewport-fit=cover`. Installed on iOS, the status bar is `black-translucent` (white text over
  the dark canvas) and switches to `default` (dark text) when the light theme applies: the inline
  theme script sets it before iOS reads it at launch, and changing the theme updates it for the
  next launch. Not yet verified on a device (no iOS/WebKit available while building M1).

## Layout

- App shell: content column `--content-max` (34 rem) with safe-area-aware gutters; fixed
  **bottom navigation** (Today · Train · Progress · Coach · Profile), glass background,
  58 px tall + home-indicator inset; `aria-current="page"` on the active tab; tabs cross-fade
  with the View Transitions API (the `root` snapshot fades while the named tab bar stays put).
  Never put a `view-transition-name` on an ancestor of a glass surface: it becomes a backdrop
  root and the blur silently stops working.
- Every app screen fits a 393 × 659 iPhone viewport without sideways scrolling, and nothing
  important sits under fixed chrome at rest (Coach suggestions end above the composer; both
  landing CTAs are above the fold). `e2e/shell.e2e.ts` asserts all three.
- Failure states keep the shell: offline and error screens render inside it with the screen's
  title (`src/routes/ErrorView.svelte`), and a connectivity notice appears while offline.
- Large titles (`PageHeader`): eyebrow + 34 px display title, iOS-style.
- Toasts appear at the top (clear of the thumb zone and nav); sheets rise from the bottom.

## Components (`src/lib/ui/components`)

| Component           | Highlights                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Button`            | `primary · secondary · ghost · danger`, `sm · md · lg` (36/48/56 px; hit area always ≥ 44 px), leading/trailing icon, `loading` (keeps width, `aria-busy`), `block`, renders `<a>` with `href`; pressed = scale 0.97 + tone.                 |
| `IconButton`        | Circular, required `label` (accessible name), `ghost · filled · accent`, `sm · md · lg`.                                                                                                                                                     |
| `Icon`              | Inline SVG set (`src/lib/ui/icons/icons.ts`, 24 px grid, 1.75 px round strokes); decorative unless `label`.                                                                                                                                  |
| `Surface` / `Card`  | Levels 1–3, padding, radius, discipline `tone` tint, `interactive`/`href`; `Card` adds eyebrow/title/action header (`aria-labelledby`).                                                                                                      |
| `NumberStepper`     | One-handed −/+ (56 px), press-and-hold accelerating repeat, tap-to-type (`inputmode=decimal`), `role=spinbutton` with ArrowUp/Down, PageUp/Down, Home/End.                                                                                   |
| `BottomSheet`       | Native `<dialog>` + `showModal()` (platform focus trap, inert background), Escape/backdrop close, focus returns to opener, swipe-to-dismiss (distance or velocity), content mounted only while open.                                         |
| `SegmentedControl`  | `radiogroup` with roving tabindex and arrow keys; spring-animated thumb; `sm` (36 px track) options extend their hit area to 44 px.                                                                                                          |
| `Tabs`              | WAI-ARIA tabs (automatic activation, arrows/Home/End), animated accent indicator, renders active panel.                                                                                                                                      |
| `BottomNav`         | Primary navigation (real links, preload on tap).                                                                                                                                                                                             |
| `Skeleton`          | Shimmer placeholder (static under reduced motion); pair with `aria-busy` on the region.                                                                                                                                                      |
| `EmptyState`        | Medallion glyph (tone-tinted), title, guidance, optional actions; `compact` variant.                                                                                                                                                         |
| `Toaster` + `toast` | Polite live region; `neutral · positive · danger`; optional action; auto-dismiss.                                                                                                                                                            |
| `PageHeader`        | Eyebrow + large title + trailing slot.                                                                                                                                                                                                       |
| `BrandMark`         | The performance-gauge mark (also the PWA icon).                                                                                                                                                                                              |
| `Stat`              | The one metric tile: label, big value + inline unit, optional rating (word + dot), caption. `level 1` on the canvas (28 px value), `level 2` nested in a card (22 px). No value → a dash announced as "No data yet", never a made-up number. |
| `Badge`             | Uppercase status pill: `neutral` (default; the only tone for "Soon"), `accent` (the next step, sparingly), `positive · warning · danger`; optional icon. Words carry the meaning.                                                            |
| `Chip`              | Quiet outlined label (e.g. a discipline) with an optional discipline-colour dot; static, not a control.                                                                                                                                      |
| `ListRow`           | Tool/destination row: tinted icon tile, title, subtitle, chevron or `trailing` snippet; renders a link (`href`), a button (`onclick`) or a dashed, non-interactive row (`disabled`, for "Soon").                                             |
| `Section`           | Titled group on a screen ("This week", "Tools"): one heading style and spacing everywhere, `aria-labelledby` wired.                                                                                                                          |
| `training/*`        | `PlateDiagram` (sleeve picture), `PlateCalculator` (code-split sheet body; its kg/lb switch is local and never changes the app-wide preference).                                                                                             |
| `TextField`         | Labelled single-line input (label above, never placeholder-as-label), 56 px tall, 16 px text so iOS never zooms, hint or error wired with `aria-describedby` (the error replaces the hint), `mono` for codes, `type="date"`, "Optional".     |
| `NumberField`       | A number that may stay blank (`null`, never 0): decimal or numeric keypad, `enterkeyhint`, unit inside the field and in its description, digits and one decimal point only, "Optional" marker. For values people nudge: `NumberStepper`.     |
| `TextArea`          | Multi-line notes: label above, 16 px text, grows with its content (`field-sizing`; `rows` and a resize handle where unsupported), `maxlength`, hint or error wired with `aria-describedby`, "Optional" marker.                               |
| `ChoiceGroup`       | One (radio) or several (checkbox) from a short list as wrapping pills or cards with a hint line; native inputs in a `fieldset` (Tab, arrows, Space), ≥ 44 px, selected shows a tick or a filled mark (never colour alone), discipline dot.   |
| `DayPicker`         | Monday-first row of seven round toggles, ticked when picked: native checkboxes named with the full day, value always in week order, hit areas reaching into the gaps so each stays ≥ 44 × 44 px inside a padded card at 393 px, error state. |
| `Toggle`            | On/off row: a native checkbox with `role="switch"` covering the whole row (the hit area, ≥ 44 px), the title as its name and the description as `aria-describedby`; Space flips it; the thumb's side says on or off.                         |
| `TagInput`          | Short free-text list: Add or Return adds the trimmed text, a repeat in any case is refused, `maxlength` and `max` hold; removable pills (44 px remove buttons), one-tap suggestions, every change and refusal announced politely.            |
| `Notice`            | Inline state message: `danger` (role `alert`) · `positive` · `warning` · `neutral` (role `status`); tinted, icon + words.                                                                                                                    |
| `RecoveryCodes`     | One-time display of recovery codes: numbered monospace list (one per row on a phone, two columns when the container allows), copy and download, required acknowledgement checkbox.                                                           |

A `ChoiceGroup` records a choice; it is never an "add" action (arrow keys check every radio they
pass, so a radio that adds a row adds one per keypress). An optional single choice offers an
explicit option such as "Not set" or "Any" that the caller maps to `null`: there are no clearable
radios.

Screens compose these primitives instead of styling their own tiles, pills, rows or section
headings, so the same pattern cannot drift between screens (PRD §16). `/design` shows every
primitive (the Inputs, Data and Feedback groups load when their tab opens).

Auth screens (`/`, `/setup`, `/recover`, `/recover/passkey`) share `src/routes/AuthScreen.svelte`:
brand row, an editorial display headline, the brand mark as a quiet watermark, and the one action
panel pinned to the thumb zone. Security (`/profile/security`) uses grouped rows on `Surface`s,
destructive actions behind a confirming `BottomSheet`, and toasts for outcomes.

## Accessibility checklist (applies to every new component)

- Touch targets ≥ 44 × 44 px; visible `:focus-visible` ring (`--color-accent-ring`).
- Text contrast ≥ 4.5:1 in **both** themes. `e2e/a11y.e2e.ts` runs axe-core (WCAG 2.1 A/AA)
  on every screen, the plate-calculator sheet and each `/design` group in dark and light; CI
  runs it with the rest of the e2e suite (Lighthouse only audits the default dark theme).
- Use native elements first (`<dialog>`, `<button>`, links); ARIA patterns for composites.
- Never convey state by colour alone: badges are words, `Stat` ratings are a word plus a dot
  (e.g. RUM p75 tiles: "Good" / "Needs work" / "Poor").
- Respect `prefers-reduced-motion`.

## Iconography & brand

- Mark: a 270° gauge track with a volt arc stopping short of full ("progress, not perfection").
- App icons are rendered from `static/icons/*.svg` by `pnpm icons` (Playwright Chromium):
  `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (content inside the 80% safe zone),
  `apple-touch-icon.png` (180 px); `favicon.svg` for browsers.
