/**
 * The run's Status Display in Graphite 2004 (RunStatus.svelte), in words from what the run view
 * already shows: the segment on screen, the run's pace as the big numeral (its totals' pace, the
 * Totals card's), the distance and time behind it, and the segments logged against planned.
 * Today's design shows the same data in the entry's header, the Totals card and the segment list.
 */
import type { ProfileDistanceUnit } from '#lib/domain/profile/types.ts';
import { convertPace, formatDuration } from '#lib/domain/units.ts';
import type { StatusDisplayProps } from '#lib/ui/components/StatusDisplay.svelte';
import { distanceText, segmentTitle, type SegmentItem } from './run-log.ts';

export interface RunStatusInput {
	items: readonly SegmentItem[];
	/** The segment on screen. */
	item: SegmentItem;
	/** It is one of the plan's (else a segment of the owner's own). */
	planned: boolean;
	/** The run's totals, as the Totals card reads them; null before anything is logged. */
	totals: {
		distanceMetres: number | null;
		durationSeconds: number | null;
		paceSecondsPerKm: number | null;
	} | null;
	unit: ProfileDistanceUnit;
}

export function runStatus({
	items,
	item,
	planned,
	totals,
	unit
}: RunStatusInput): StatusDisplayProps {
	const pace = totals?.paceSecondsPerKm ?? null;
	const distance = totals?.distanceMetres ?? null;
	const time = totals?.durationSeconds ?? null;
	const done = items.filter((i) => i.logged).length;
	const behind = [
		distance !== null && distanceText(distance, unit),
		time !== null && formatDuration(time)
	].filter(Boolean);
	return {
		label: 'Run status',
		line: planned
			? `Segment ${item.position} of ${items.length} · ${segmentTitle(item)}`
			: `A segment of your own · ${segmentTitle(item)}`,
		// No pace until a segment gives one: a quiet dash, never an invented number.
		big: pace !== null ? formatDuration(convertPace(pace, 'km', unit)) : '—',
		unit: pace !== null ? `/${unit}` : undefined,
		dim: behind.length
			? `Run pace over ${behind.join(' in ')}`
			: 'Your pace shows once a segment is logged',
		bar: items.length
			? {
					label: 'Segments logged',
					start: 'Segments',
					end: `${done} of ${items.length} done`,
					progress: done / items.length
				}
			: null
	};
}
