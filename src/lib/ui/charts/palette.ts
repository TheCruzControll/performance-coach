/**
 * The chart palette as data (docs/design-system.md#data-visualisation). The colours themselves
 * are the --chart-* custom properties in src/lib/ui/styles/tokens.css; this module fixes the
 * order they are used in and the job each one does. palette.test.ts recomputes every colour
 * check from tokens.css, in both themes, on the chart surface (surface-1).
 */
import type { DisciplineTone } from '#lib/domain/profile/catalog.ts';

/** The custom property that colours a discipline's series. */
export const SERIES_TOKEN: Readonly<Record<DisciplineTone, `--chart-${DisciplineTone}`>> = {
	strength: '--chart-strength',
	hypertrophy: '--chart-hypertrophy',
	conditioning: '--chart-conditioning',
	combat: '--chart-combat',
	running: '--chart-running'
};

/**
 * The one order disciplines take in stacks, legends and table twins, whatever the chart.
 *
 * - Colour follows the discipline, never its rank: a chart without some disciplines keeps
 *   this order and leaves the missing ones out, so the survivors are never repainted.
 * - Every neighbour in it clears colour-vision-deficiency ΔE 8 and normal-vision ΔE 15
 *   (OKLab ×100), in both themes.
 * - Strength (amber) and combat (red-orange) collapse under deuteranopia (ΔE 2.3), so they
 *   sit three places apart, and like every series they are always labelled in words. When the
 *   disciplines between them are absent they do touch: the label and the 2 px surface gap
 *   between segments carry them apart.
 */
export const STACK_ORDER = [
	'strength',
	'hypertrophy',
	'conditioning',
	'combat',
	'running'
] as const satisfies readonly DisciplineTone[];

/**
 * The diverging pair, for a signed difference from a target: actual minus target RPE.
 *
 * - Two poles that read as opposites, cool for below the target (easier than planned) and
 *   warm for above it (harder than planned), with a hueless grey at zero, so being on target
 *   reads as nothing to see.
 * - The poles are not discipline or status colours: each sits at least ΔE 8 from every one of
 *   them. The pair never shares a chart with discipline series, and a status shown beside it
 *   is labelled in words.
 */
export const DIVERGING = {
	below: '--chart-diverge-cool',
	above: '--chart-diverge-warm',
	zero: '--chart-diverge-mid'
} as const;

/**
 * The chart furniture: everything a chart draws that is not data.
 * - surface: what a chart sits on; always surface-1 (light conditioning drops to 2.95:1 on
 *   surface-2).
 * - muted: a series shown for context beside the one in colour (emphasis before colour); a
 *   grey that still reads as a mark (≥ 3:1).
 * - grid, axis, baseline: hairline gridlines, the axis rules and ticks, the zero line marks
 *   stand on; greys that recede in that order and never reach 3:1, so they never read as data.
 * - band: the quiet fill behind a target range or a highlighted period.
 * Tick labels and every other word are text and wear the text tokens, never a chart colour.
 */
export const FURNITURE = {
	surface: '--chart-surface',
	muted: '--chart-muted',
	grid: '--chart-grid',
	axis: '--chart-axis',
	baseline: '--chart-baseline',
	band: '--chart-band'
} as const;
