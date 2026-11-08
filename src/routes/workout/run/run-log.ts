/**
 * The run view's rules (PRD §8), pure, so the page, its Fix editor and the tests agree:
 * - the segments to log: the kit's planned ones, expanded (run.ts), each with what was logged at
 *   its position, then any logged at a position the plan has none (an ad-hoc run's free segments,
 *   or one added beyond the plan)
 * - what a segment's entry starts from: what was logged, else the target (a distance-only
 *   target's time from the middle of its pace range)
 * - what logging one dispatches: its run.segment (the first entry creates it, any later one edits
 *   it, after it synced too), the run's totals as a run.log when they change, and on a first
 *   entry the move to the next segment not logged yet, all in one dispatch
 * - the words: targets, actuals and paces in the owner's distance unit (the kit's, the training
 *   profile's; the M4 plan's open question on units)
 * Distances are typed in that unit and stored in metres, to the millimetre as M3 keeps them.
 */
import type { ProfileDistanceUnit } from '#lib/domain/profile/types.ts';
import type { RunSegmentKind } from '#lib/domain/training/vocabulary.ts';
import {
	cleanFloat,
	convertPace,
	formatDuration,
	fromMetres,
	toMetres
} from '#lib/domain/units.ts';
import type { LocalAction, Mutation, RunFields, WorkoutView } from '#lib/domain/workout/index.ts';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import { expandSegments, runTotals, segmentPace } from '#lib/domain/workout/run.ts';
import type { SegmentTarget } from '#lib/domain/workout/run.ts';

/**
 * Each kind in words: the vocabulary's RUN_SEGMENT_KIND_LABEL, which a unit test holds this to.
 * Kept here so the vocabulary's other tables stay out of /workout/run's initial JavaScript.
 */
export const SEGMENT_WORDS: Readonly<Record<RunSegmentKind, string>> = {
	warm_up: 'Warm-up',
	easy: 'Easy',
	steady: 'Steady',
	tempo: 'Tempo',
	interval: 'Interval',
	recovery: 'Recovery',
	long: 'Long',
	cool_down: 'Cool-down'
};

/** A run's effort, 1 to 10 (M3's session RPE): an easy run is a 3, so the chips start at 1. */
export const RUN_RPE_CHIPS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** M3's RECORD_LIMITS.heartRate, which a unit test holds this to (the schemas stay lazy). */
export const HEART_RATE = [20, 250] as const;

export type LoggedSegment = NonNullable<WorkoutView['run']>['segments'][number];

/** One segment to log, planned or free. */
export interface SegmentItem {
	position: number;
	kind: RunSegmentKind;
	/** Its round of a repeat group and the group's repeats; null outside one. */
	repeat: number | null;
	repeats: number | null;
	/** The plan's target; null for a free segment. */
	target: SegmentTarget | null;
	logged: LoggedSegment | null;
}

/** What a segment's entry records; null where nothing was given. */
export interface SegmentValues {
	distanceMetres: number | null;
	durationSeconds: number | null;
	avgHr: number | null;
}

/** The planned segments with what was logged at each position, then the free ones, in order. */
export function segmentItems(view: WorkoutView): SegmentItem[] {
	const logged = view.run?.segments ?? [];
	const at = (position: number) => logged.find((s) => s.position === position) ?? null;
	const planned = view.kit?.kind === 'run' ? expandSegments(view.kit.run.segments) : [];
	const items: SegmentItem[] = planned.map((p) => ({ ...p, logged: at(p.position) }));
	for (const s of logged) {
		if (items.some((i) => i.position === s.position)) continue;
		items.push({
			position: s.position,
			kind: s.kind,
			repeat: null,
			repeats: null,
			target: null,
			logged: s
		});
	}
	return items.sort((a, b) => a.position - b.position);
}

/** A segment not planned and not logged yet, at `position`. */
export const freeItem = (position: number, kind: RunSegmentKind): SegmentItem => ({
	position,
	kind,
	repeat: null,
	repeats: null,
	target: null,
	logged: null
});

/** Where a segment added after the others goes. */
export const nextFreePosition = (items: readonly SegmentItem[]) =>
	(items.at(-1)?.position ?? 0) + 1;

/** What the entry starts from: the logged values, else the target's. */
export function prefillOf({ logged, target }: SegmentItem): SegmentValues {
	if (logged) {
		const { distanceMetres, durationSeconds, avgHr } = logged;
		return { distanceMetres, durationSeconds, avgHr };
	}
	const distance = target?.distanceMetres ?? null;
	const paces = [target?.paceMinSecondsPerKm, target?.paceMaxSecondsPerKm].filter(
		(p): p is number => typeof p === 'number'
	);
	const pace = paces.length ? paces.reduce((a, b) => a + b) / paces.length : null;
	const duration =
		target?.durationSeconds ??
		(distance !== null && pace !== null ? Math.round((distance / 1000) * pace) : null);
	return { distanceMetres: distance, durationSeconds: duration, avgHr: null };
}

/** 0 leaves a value out: a stepper has no blank. */
export const normalized = (v: SegmentValues): SegmentValues => ({
	distanceMetres: v.distanceMetres ? v.distanceMetres : null,
	durationSeconds: v.durationSeconds ? v.durationSeconds : null,
	avgHr: v.avgHr ?? null
});

export type EntryError = 'amount' | 'heart-rate';

/** Asked for before a segment is logged. */
export const ENTRY_ERRORS: Readonly<Record<EntryError, string>> = {
	amount: 'Enter a distance or a time',
	'heart-rate': `Heart rate between ${HEART_RATE[0]} and ${HEART_RATE[1]}`
};

/** What the entry lacks (run_record_segments needs a distance or a time); null when it can go. */
export function entryError(values: Partial<SegmentValues>): EntryError | null {
	const v = normalized({ distanceMetres: null, durationSeconds: null, avgHr: null, ...values });
	const measured = 'distanceMetres' in values || 'durationSeconds' in values;
	if (measured && v.distanceMetres === null && v.durationSeconds === null) return 'amount';
	const hr = v.avgHr;
	if (hr !== null && !(Number.isInteger(hr) && hr >= HEART_RATE[0] && hr <= HEART_RATE[1])) {
		return 'heart-rate';
	}
	return null;
}

/**
 * Logging a segment: its run.segment, the run.log of the totals when they change, and on its
 * first entry the move to the next segment still to log.
 */
export function segmentActions(
	view: WorkoutView,
	items: readonly SegmentItem[],
	item: SegmentItem,
	values: SegmentValues,
	at: string
): [Mutation, ...(Mutation | LocalAction)[]] {
	const workoutId = view.workout.id;
	const { position, kind, logged } = item;
	const payload = { position, kind, ...values, rpe: logged?.rpe ?? null };
	const segment = createMutation('run.segment', { workoutId, entityId: logged?.id, at, payload });
	const actions: [Mutation, ...(Mutation | LocalAction)[]] = [segment];
	const totals = totalsMutation(view, segment.entityId, values, at);
	if (totals) actions.push(totals);
	const next = items.find((i) => i.position > position && !i.logged);
	if (!logged && next) actions.push({ type: 'goTo', workoutId, position: next.position });
	return actions;
}

/**
 * The run.log of the run's totals with `values` as segment `id`'s (a new one or a correction);
 * null when they do not change.
 */
export function totalsMutation(
	view: WorkoutView,
	id: string,
	values: SegmentValues,
	at: string
): Mutation | null {
	const run = view.run;
	const others = (run?.segments ?? []).filter((s) => s.id !== id);
	const totals = runTotals([...others, values]);
	const same =
		run &&
		totals.distanceMetres === run.distanceMetres &&
		totals.durationSeconds === run.durationSeconds &&
		totals.avgHr === run.avgHr;
	return same
		? null
		: createMutation('run.log', { workoutId: view.workout.id, at, payload: totals });
}

/** The run.log of the run's own effort or notes; null when it changes nothing. */
export function runFieldMutation(
	view: WorkoutView,
	change: Partial<Pick<RunFields, 'rpe' | 'notes'>>,
	at: string
): Mutation | null {
	const run = view.run;
	const changed = (Object.keys(change) as ('rpe' | 'notes')[]).some(
		(key) => change[key] !== (run?.[key] ?? null)
	);
	return changed
		? createMutation('run.log', { workoutId: view.workout.id, at, payload: change })
		: null;
}

// ---- Words ----------------------------------------------------------------------------------

/** Metres in the owner's unit, and back to the millimetre. */
export const inUnit = (metres: number, unit: ProfileDistanceUnit) => fromMetres(metres, unit);
export const toStoredMetres = (value: number, unit: ProfileDistanceUnit) =>
	cleanFloat(toMetres(value, unit), 3);

/** '400 m' and '5.2 km', or '3.1 mi'. */
export function distanceText(metres: number, unit: ProfileDistanceUnit): string {
	if (unit === 'km' && metres < 1000) return `${Math.round(metres)} m`;
	return `${cleanFloat(inUnit(metres, unit), 2)} ${unit}`;
}

/** Seconds per km as '3:52 /km', or per mile. */
export const paceText = (secondsPerKm: number, unit: ProfileDistanceUnit) =>
	`${formatDuration(convertPace(secondsPerKm, 'km', unit))} /${unit}`;

/** A distance and a time's pace in words; null without both. */
export function paceOf(values: Partial<SegmentValues>, unit: ProfileDistanceUnit): string | null {
	const { distanceMetres = null, durationSeconds = null } = normalized({
		distanceMetres: null,
		durationSeconds: null,
		avgHr: null,
		...values
	});
	const perKm = segmentPace({ distanceMetres, durationSeconds }, 'km');
	return perKm === null ? null : paceText(perKm, unit);
}

/** 'Interval 3 of 6', 'Warm-up'. */
export const segmentTitle = ({
	kind,
	repeat,
	repeats
}: Pick<SegmentItem, 'kind' | 'repeat' | 'repeats'>) =>
	`${SEGMENT_WORDS[kind]}${repeat !== null ? ` ${repeat} of ${repeats}` : ''}`;

/** What a target asks for: '400 m · 3:45–4:00 /km', '10:00 · Zone 2'. */
export function targetText(target: SegmentTarget | null, unit: ProfileDistanceUnit): string {
	if (!target) return 'Your own segment';
	const { distanceMetres: d, durationSeconds: t, paceMinSecondsPerKm: fast } = target;
	const slow = target.paceMaxSecondsPerKm;
	const pace =
		fast !== null && slow !== null && fast !== slow
			? `${formatDuration(convertPace(fast, 'km', unit))}–${paceText(slow, unit)}`
			: (fast ?? slow) !== null
				? paceText((fast ?? slow)!, unit)
				: null;
	const parts = [
		d !== null && distanceText(d, unit),
		t !== null && formatDuration(t),
		pace,
		target.hrZone !== null && `Zone ${target.hrZone}`,
		target.targetRpe !== null && `RPE ${target.targetRpe}`
	];
	return parts.filter(Boolean).join(' · ') || 'As you feel';
}

/** What was run: '400 m · 1:32 · 3:50 /km · 162 bpm'. */
export function actualText(s: SegmentValues, unit: ProfileDistanceUnit): string {
	const pace = paceOf(s, unit);
	const parts = [
		s.distanceMetres !== null && distanceText(s.distanceMetres, unit),
		s.durationSeconds !== null && formatDuration(s.durationSeconds),
		pace,
		s.avgHr !== null && `${s.avgHr} bpm`
	];
	return parts.filter(Boolean).join(' · ');
}
