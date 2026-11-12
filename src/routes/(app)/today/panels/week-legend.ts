/**
 * The week strip's legend in Graphite 2004 (WeekLegend.svelte, through StatusSlot.svelte): what
 * each dot on the strip means, for the disciplines this week has, in the strip's colours, then the
 * ring a skipped session leaves, for the dots the strip draws. The strip's day names already say
 * all of it to assistive tech; the legend is for the eye. Only WeekLegend.svelte imports it, so it
 * ships only to a device that chose Graphite. It lays out in rows of LEGEND_COLUMNS, and
 * Program.svelte holds a room for at least that many rows from the first paint.
 */
import type { DisciplineTone } from '#lib/domain/profile/catalog.ts';
import type { StripDayView } from '#lib/ui/program/words.ts';

/** One key: a discipline's dot, or the skipped ring. */
export interface LegendKey {
	tone: DisciplineTone | null;
	label: string;
}

/** The disciplines in the order the legend names them, with the names Progress uses. */
const TONES: readonly (readonly [DisciplineTone, string])[] = [
	['strength', 'Strength'],
	['running', 'Running'],
	['combat', 'Muay Thai'],
	['hypertrophy', 'Hypertrophy'],
	['conditioning', 'Conditioning']
];

export const LEGEND_COLUMNS = 3;
/** The dots WeekStrip.svelte draws on a day (its MAX_DOTS): a key needs a dot to explain. */
export const STRIP_DOTS = 4;

export function weekLegend(days: readonly Pick<StripDayView, 'dots'>[]): LegendKey[] {
	const dots = days.flatMap((day) => day.dots.slice(0, STRIP_DOTS));
	const keys: LegendKey[] = TONES.filter(([tone]) => dots.some((d) => d.tone === tone)).map(
		([tone, label]) => ({ tone, label })
	);
	if (dots.some((d) => d.skipped)) keys.push({ tone: null, label: 'Skipped' });
	return keys;
}
