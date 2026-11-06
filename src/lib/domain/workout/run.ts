/**
 * A run as it is logged (PRD §8, §9): the planned segments the owner works through, each
 * segment's pace, and the run's totals. The run screen, its reducers and the sync endpoint share
 * these, so a pace or a total reads the same on the device, on the server and in History.
 *
 * - A planned run lists a repeat group once, with its repeats (M3's RunSegment). expandSegments
 *   turns it into the segments run, in order: 6 × (400 m + 90 s) is twelve, interval then
 *   recovery, each with its round. A segment's position is what its run.segment names.
 * - An ad-hoc run has no plan; its segments are free, at whatever positions the owner adds them.
 * - Pace is M1's: paceSecondsPer per km, the unit rows store it in (run_records' generated
 *   pace), shown in the owner's unit through convertPace. Never redefined here.
 * - Totals count only what was run. A planned segment the owner skipped has no actuals, so it
 *   counts for nothing; no target ever stands in for one.
 */
import type { ProfileDistanceUnit } from '../profile/types.ts';
import type { RunSegment } from '../training/types.ts';
import type { RunSegmentKind } from '../training/vocabulary.ts';
import { cleanFloat, convertPace, paceSecondsPer } from '../units.ts';
import type { RunFields, RunSegmentFields } from './mutations.ts';

/** What a planned segment asks for: M3's targets, without the repeat group's bookkeeping. */
export type SegmentTarget = Omit<RunSegment, 'kind' | 'repeatGroup' | 'repeats'>;

/** One segment of a planned run, expanded: what the owner logs, in the order it is run. */
export interface PlannedSegment {
	/** 1-based, in the run: the position its run.segment names. */
	position: number;
	kind: RunSegmentKind;
	/** Its round of a repeat group, from 1, and the group's repeats; both null outside a group. */
	repeat: number | null;
	repeats: number | null;
	target: SegmentTarget;
}

/** A planned run's segments, each repeat group's consecutive segments run `repeats` times. */
export function expandSegments(segments: readonly RunSegment[]): PlannedSegment[] {
	const planned: PlannedSegment[] = [];
	for (let first = 0; first < segments.length;) {
		const group = segments[first]!.repeatGroup;
		let end = first + 1;
		while (group !== null && segments[end]?.repeatGroup === group) end++;
		const repeats = group === null ? null : (segments[first]!.repeats ?? 1);
		const members = segments.slice(first, end);
		for (let round = 1; round <= (repeats ?? 1); round++) {
			for (const { kind, repeatGroup: _group, repeats: _repeats, ...target } of members) {
				const repeat = repeats === null ? null : round;
				planned.push({ position: planned.length + 1, kind, repeat, repeats, target });
			}
		}
		first = end;
	}
	return planned;
}

/** The distance, time and heart rate a segment or a run recorded; any may be missing. */
export type SegmentAmounts = Pick<RunSegmentFields, 'distanceMetres' | 'durationSeconds' | 'avgHr'>;

/**
 * Seconds per km or per mile, through M1's paceSecondsPer (per km, as rows store it) and
 * convertPace; null without both a distance and a time.
 */
export function segmentPace(
	{ distanceMetres, durationSeconds }: Pick<SegmentAmounts, 'distanceMetres' | 'durationSeconds'>,
	unit: ProfileDistanceUnit
): number | null {
	if (distanceMetres === null || durationSeconds === null) return null;
	const perKm = paceSecondsPer(durationSeconds, distanceMetres, 'km');
	return perKm === null ? null : convertPace(perKm, 'km', unit);
}

/** What a run's totals give its run.log: the run's pace is segmentPace of them. */
export type RunTotals = Pick<RunFields, 'distanceMetres' | 'durationSeconds' | 'avgHr'>;

const sumOf = (values: number[]) =>
	values.length === 0 ? null : cleanFloat(values.reduce((sum, v) => sum + v, 0));

/**
 * The run's totals from its segments as run:
 * - the distance and the time, each summed over the segments that recorded it, and null when
 *   none did (run_records keeps a total it does not have empty, never 0)
 * - the heart rate, optional: the time-weighted mean of the segments with both a heart rate and
 *   a time, in whole beats per minute; a segment without one is left out, never counted as 0
 * So the pace of the totals is the one run_records generates from them.
 */
export function runTotals(segments: readonly SegmentAmounts[]): RunTotals {
	const timed = segments.filter((s) => s.avgHr !== null && s.durationSeconds !== null);
	const beats = sumOf(timed.map((s) => s.avgHr! * s.durationSeconds!));
	const hrSeconds = sumOf(timed.map((s) => s.durationSeconds!));
	return {
		distanceMetres: sumOf(segments.flatMap((s) => s.distanceMetres ?? [])),
		durationSeconds: sumOf(segments.flatMap((s) => s.durationSeconds ?? [])),
		avgHr: beats === null || !hrSeconds ? null : Math.round(beats / hrSeconds)
	};
}
