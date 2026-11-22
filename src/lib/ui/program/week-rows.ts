/**
 * How BlockTimeline lists a block's weeks under Train's season (m7/39): a long run of outline
 * weeks counted in one row (OUTLINE_RUN), so a long road stays legible at 320 px. No runtime
 * import: the lazy plan sheet carries it, and none of season.ts's vocabulary.
 */
import type { TimelineWeek } from './timeline.ts';

/**
 * Decision (m7/39, open question: how long a road stays legible at 320 px): this many outline
 * weeks in a row, none holding an event, are listed as one counted row. M3's outlines (a few
 * weeks to an event) stay listed week by week.
 */
export const OUTLINE_RUN = 4;

/** A row of a block's weeks: one week, or a counted run of outline weeks read as one. */
export interface WeekRow {
	/** A counted run: its first week's number, both weeks' dates, and `last` and `count` set. */
	week: TimelineWeek & {
		/** The run's last week's number: 'Weeks 9–20'. */
		last?: number;
		/** '12 weeks'. */
		count?: string;
	};
	/** Its weeks' tick words (season.ts's), joined: 'Deload', or ''. */
	tick: string;
}

/**
 * A block's weeks as rows, each with its `ticks` (by the week's place in the block, from 0):
 * every week of a planned block; in an outline, each run of at least OUTLINE_RUN weeks with no
 * event and not this week counted in one row, every other week on its own.
 */
export function weekRows(
	weeks: readonly TimelineWeek[],
	{
		outline,
		collapse,
		ticks = {}
	}: { outline: boolean; collapse: boolean; ticks?: Readonly<Record<number, string>> }
): WeekRow[] {
	const rows: WeekRow[] = [];
	const tick = (from: number, to: number) =>
		Object.entries(ticks)
			.filter(([i]) => from <= +i && +i <= to)
			.map(([, word]) => word)
			.join(' · ');
	let run: number[] = [];
	const flush = () => {
		const [from, to] = [run[0]!, run.at(-1)!];
		if (run.length >= OUTLINE_RUN) {
			const [a, b] = [weeks[from]!, weeks[to]!];
			const dates = `${a.dates.split(' – ')[0]} – ${b.dates.split(' – ')[1]}`;
			const count = `${run.length} weeks`;
			rows.push({ week: { ...a, dates, last: b.number, count }, tick: tick(from, to) });
		} else run.forEach((i) => rows.push({ week: weeks[i]!, tick: tick(i, i) }));
		run = [];
	};
	weeks.forEach((week, i) => {
		if (collapse && outline && week.events.length === 0 && !week.current) return void run.push(i);
		flush();
		rows.push({ week, tick: tick(i, i) });
	});
	flush();
	return rows;
}
