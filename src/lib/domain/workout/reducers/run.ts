/**
 * The run family, runs only, by the contract's identity rule:
 * - run.log sets the run's own fields it carries (entity run:<workout>), absolutely, so a later
 *   one replaces the values an earlier one set.
 * - run.segment adds a segment on its first send (id === entityId) and replaces all its values on
 *   every later one. A first send of a known segment is a no-op, so a replay never undoes a
 *   correction; a later send of a segment not known yet waits until the segment's rows arrive.
 * - The run's record exists from its first run.log or its first segment, whichever comes first,
 *   with every total empty until a run.log sets it. Its totals and its segments are separate
 *   rows, so neither depends on the order the other arrives in.
 * - Each pace is the one Postgres generates from the row's own distance and time (run.ts's
 *   segmentPace, per km), so a row this device changed reads as it will once stored.
 */
import type { MutationOf, RunFields } from '../mutations.ts';
import { onRows } from '../project.ts';
import type { MutationReducers } from '../project.ts';
import type { CanonicalRun, CanonicalSegment, CanonicalWorkout } from '../protocol.ts';
import { segmentPace } from '../run.ts';

const RUN_FIELDS = [
	'distanceMetres',
	'durationSeconds',
	'avgHr',
	'rpe',
	'notes'
] as const satisfies (keyof RunFields)[];

/** A run's record before any run.log. */
const EMPTY_RUN: CanonicalRun = {
	distanceMetres: null,
	durationSeconds: null,
	avgHr: null,
	rpe: null,
	notes: null,
	paceSecondsPerKm: null,
	segments: []
};

/** The run's fields a run.log carries, and nothing else it may hold. */
const carried = (payload: Partial<RunFields>) =>
	Object.fromEntries(
		RUN_FIELDS.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]])
	) as Partial<RunFields>;

const withRun = (rows: CanonicalWorkout, run: CanonicalRun): CanonicalWorkout => ({ ...rows, run });

/** The segment a run.segment sends: every value it carries, under its client id. */
function segmentOf({ entityId, payload }: MutationOf<'run.segment'>): CanonicalSegment {
	const { position, kind, distanceMetres, durationSeconds, avgHr, rpe } = payload;
	const values = { position, kind, distanceMetres, durationSeconds, avgHr, rpe };
	return { id: entityId, ...values, paceSecondsPerKm: segmentPace(values, 'km') };
}

/** The rows with a new segment, unless its id is known; the run's record made if need be. */
function added(rows: CanonicalWorkout, m: MutationOf<'run.segment'>): CanonicalWorkout {
	const run = rows.run ?? EMPTY_RUN;
	if (run.segments.some((s) => s.id === m.entityId)) return rows;
	return withRun(rows, { ...run, segments: [...run.segments, segmentOf(m)] });
}

/** The rows with a known segment's values replaced; unchanged while it is not known. */
function edited(rows: CanonicalWorkout, m: MutationOf<'run.segment'>): CanonicalWorkout {
	const run = rows.run;
	if (!run?.segments.some((s) => s.id === m.entityId)) return rows;
	const next = segmentOf(m);
	return withRun(rows, {
		...run,
		segments: run.segments.map((s) => (s.id === next.id ? next : s))
	});
}

export const run: MutationReducers<'run.log' | 'run.segment'> = {
	'run.log': onRows((rows, m) => {
		const own = { ...(rows.run ?? EMPTY_RUN), ...carried(m.payload) };
		return withRun(rows, { ...own, paceSecondsPerKm: segmentPace(own, 'km') });
	}),
	'run.segment': onRows((rows, m) => (m.id === m.entityId ? added(rows, m) : edited(rows, m)))
};
