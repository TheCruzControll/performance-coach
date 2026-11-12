/**
 * Finishing a workout (PRD §7, §9; the M4 plan's finish-workout slice), loaded only with the finish
 * sheet or the completed state, never in a workout route's first render:
 * - openSets: the planned sets still open, which Finish asks about first
 * - the summary's fields (duration from the stopwatch, session RPE, notes), as they start and as
 *   the finish carries them
 * - finishWorkout: Done. The finish and the stopwatch's pause go through the store in one write
 *   (the engine flushes it); online, it opens the History detail only if the server takes it
 *   within FINISH_SYNC_WAIT_MS of Done, so the detail has the workout and the page never jumps
 *   late. Offline, refused or slow, the page stays on its completed state, the summary at once,
 *   with 'View in History' when the sync confirms.
 * - the summary in words (domain summary.ts's numbers): an e1RM and a PR from one always say
 *   'estimated', because both come from RPE estimates; nothing here says 'record'.
 * Plain .ts with no runes: the store and the clock are given.
 */
import type { WorkoutStore } from '#lib/client/workout/store.ts';
import { OTHER_SESSION_KIND_LABEL } from '#lib/domain/training/vocabulary.ts';
import { cleanFloat, formatDuration, formatWeight, fromMetres } from '#lib/domain/units.ts';
import type { FieldErrors } from '#lib/domain/validation.ts';
import { createMutation } from '#lib/domain/workout/index.ts';
import type { KitUnits, Mutation, WorkoutFields, WorkoutView } from '#lib/domain/workout/index.ts';
import type { Totals } from '#lib/domain/workout/logging.ts';
import { unfinishedSets } from '#lib/domain/workout/substitution.ts';
import { kitBests, summarizeWorkout } from '#lib/domain/workout/summary.ts';
import type { ExerciseResult, Pr, WorkoutSummary } from '#lib/domain/workout/summary.ts';

/** The session RPE chips: 1 to 10. */
export const FINISH_RPE_CHIPS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * How long, from Done, the server has to take the finish for the page to open the History detail
 * by itself: about as long as a navigation still feels like Done's answer. Past it (a slow or
 * lying connection) the page stays on its completed state, the local summary shown at once, which
 * offers 'View in History' once the workout has synced: never a page jump seconds after Done.
 */
export const FINISH_SYNC_WAIT_MS = 300;

/** M3's finishWorkoutSchema: a duration up to a day, notes up to 500 characters. */
export const DURATION_MINUTES = [1, 24 * 60] as const;
export const NOTES_MAX = 500;

/** Units for a view with no kit (a purge took it): the server's defaults. */
const FALLBACK_UNITS: KitUnits = { weight: 'kg', distance: 'km' };

export const unitsOf = (view: WorkoutView): KitUnits => view.kit?.units ?? FALLBACK_UNITS;

/**
 * The summary of `view`, against the bests its kit carried, at `now` on this device's clock. A
 * finish the server refused can hold a session RPE outside 0–10 or a negative duration (another
 * tab's): the summary reads neither, so the page still opens for Fix instead of throwing.
 */
export function summaryOf(view: WorkoutView, now: number): WorkoutSummary {
	const { sessionRpe, durationSeconds } = view.workout;
	const workout = {
		...view.workout,
		sessionRpe: sessionRpe !== null && sessionRpe >= 0 && sessionRpe <= 10 ? sessionRpe : null,
		durationSeconds: durationSeconds !== null && durationSeconds >= 0 ? durationSeconds : null
	};
	return summarizeWorkout({ ...view, workout }, kitBests(view.kit), unitsOf(view), now);
}

/** The planned sets with no row yet, logged or skipped, across every exercise. */
export const openSets = (view: WorkoutView): number =>
	view.slots.reduce((n, slot) => n + unfinishedSets(slot).length, 0);

/**
 * What the summary's fields start from: what the workout carries, else the stopwatch's duration
 * and the RPE a run or a session was logged with.
 */
export function finishValues(view: WorkoutView, now: number): WorkoutFields {
	const { workout, run, other } = view;
	const seconds = summaryOf(view, now).durationSeconds;
	return {
		durationSeconds: seconds && seconds >= 1 ? Math.min(seconds, DURATION_MINUTES[1] * 60) : null,
		sessionRpe: workout.sessionRpe ?? run?.rpe ?? other?.rpe ?? null,
		notes: workout.notes
	};
}

/** What the finish sheet starts from: the fields a refused change carries, over finishValues. */
export function valuesOf(m: Mutation | undefined, view: WorkoutView | null, now: number) {
	const start: WorkoutFields = view
		? finishValues(view, now)
		: { durationSeconds: null, sessionRpe: null, notes: null };
	return m?.type === 'workout.update' || m?.type === 'workout.finish'
		? { ...start, ...m.payload }
		: start;
}

/** Notes as stored: trimmed, and null when empty. */
export const noteOf = (text: string | null) => text?.trim() || null;

/** The server's error for one of the fields, from a refused change ('payload.sessionRpe'). */
export const fieldError = (errors: FieldErrors | undefined, field: keyof WorkoutFields) =>
	errors?.[`payload.${field}`] ?? null;

/** Done's finish, under a fresh id, carrying the summary's fields. */
export const finishMutation = (workoutId: string, values: WorkoutFields, at: number) =>
	createMutation('workout.finish', {
		workoutId,
		at: new Date(at).toISOString(),
		payload: { ...values, notes: noteOf(values.notes) }
	});

export interface FinishOptions {
	online?: () => boolean;
	waitMs?: number;
	now?: () => number;
}

/**
 * Settles true once the outbox holds no change of the workout (the server took them all), false
 * when one is parked (refused, or failing past the cap), or after `waitMs`.
 */
export function synced(store: WorkoutStore, workoutId: string, waitMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let done = false;
		const end = (outcome: boolean) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			unsubscribe();
			resolve(outcome);
		};
		const check = () =>
			store.outbox().then(
				(entries) => {
					const mine = entries.filter((e) => e.envelope.workoutId === workoutId);
					if (mine.length === 0) end(true);
					else if (mine.some((e) => e.parked)) end(false);
				},
				() => end(false)
			);
		const timer = setTimeout(() => end(false), waitMs);
		const unsubscribe = store.onChange(() => void check());
		void check();
	});
}

/**
 * Done: `finish` and the stopwatch's pause in one write. 'history' once the server has the
 * finished workout within `waitMs` of Done, the write on this device included (online only);
 * 'stay' offline, refused or past the wait, on the completed state; 'not-saved' when this
 * browser refused the write.
 */
export async function finishWorkout(
	store: WorkoutStore,
	finish: Mutation,
	{
		online = () => navigator.onLine,
		waitMs = FINISH_SYNC_WAIT_MS,
		now = Date.now
	}: FinishOptions = {}
): Promise<'history' | 'stay' | 'not-saved'> {
	const { workoutId } = finish;
	const tapped = now();
	const { saved } = store.dispatch(finish, { type: 'stopwatch.pause', workoutId, at: tapped });
	if ((await saved) !== 'saved') return 'not-saved';
	if (!online()) return 'stay';
	const left = waitMs - (now() - tapped);
	if (left <= 0) return 'stay';
	return (await synced(store, workoutId, left)) ? 'history' : 'stay';
}

// ---- In words -------------------------------------------------------------------------------

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** '52 min', '1 h 05 min'. */
export function durationWords(seconds: number): string {
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

const distanceWords = (metres: number, { distance }: KitUnits) =>
	`${cleanFloat(fromMetres(metres, distance), 2)} ${distance}`;

/** Reps, seconds and metres totals, the non-zero ones: '24 reps', '2:30', '400 m'. */
function totalsWords(totals: Totals): string[] {
	return [
		totals.reps > 0 && count(totals.reps, 'rep'),
		totals.seconds > 0 && formatDuration(totals.seconds),
		totals.metres > 0 && `${cleanFloat(totals.metres, 2)} m`
	].filter((x): x is string => typeof x === 'string');
}

export interface Labelled {
	label: string;
	value: string;
}

export interface ExerciseWords {
	key: string;
	name: string;
	/** '3 sets · 1,500 kg', '3 sets · 2:15', '2 sets · 1 skipped'. */
	done: string;
	/** '100 kg × 5 · Estimated 1RM 116.7 kg', 'First time'; null with no working set. */
	best: string | null;
}

export interface PrWords {
	key: string;
	/** 'New estimated best · Back squat'. */
	title: string;
	/** 'Estimated 1RM 116.7 kg, was 110 kg'. */
	detail: string;
}

export interface SummaryWords {
	stats: Labelled[];
	exercises: ExerciseWords[];
	prs: PrWords[];
}

const PR_TITLE: Record<Pr['kind'], string> = {
	e1rm: 'New estimated best',
	rep_max: 'New best for its reps',
	most_reps: 'Most reps yet'
};

function prWords(pr: Pr, { weight }: KitUnits): PrWords {
	const amount = (n: number) =>
		pr.kind === 'most_reps' ? count(n, 'rep') : formatWeight(n, weight);
	const what =
		pr.kind === 'e1rm' ? 'Estimated 1RM' : pr.reps !== null ? `${count(pr.reps, 'rep')} at` : '';
	return {
		key: `${pr.exerciseId}:${pr.kind}:${pr.reps ?? ''}`,
		title: `${PR_TITLE[pr.kind]} · ${pr.name}`,
		detail: `${what ? `${what} ` : ''}${amount(pr.value)}, was ${amount(pr.previous)}`
	};
}

function exerciseWords(e: ExerciseResult, { weight }: KitUnits): ExerciseWords {
	const amount = e.volume !== null ? [formatWeight(e.volume, weight)] : totalsWords(e.totals);
	const done = [
		count(e.sets.done, 'set'),
		...(e.sets.skipped > 0 ? [`${e.sets.skipped} skipped`] : []),
		...amount
	].join(' · ');
	const { best } = e;
	const set =
		best &&
		(best.weight !== null
			? `${formatWeight(best.weight, best.unit)} × ${best.reps ?? best.seconds ?? best.metres}`
			: best.seconds !== null
				? formatDuration(best.seconds)
				: best.metres !== null
					? `${best.metres} m`
					: count(best.reps ?? 0, 'rep'));
	const e1rm = best?.e1rm && `Estimated 1RM ${formatWeight(best.e1rm.value, weight)}`;
	const parts = [set, e1rm, e.firstTime && 'First time'].filter((x) => typeof x === 'string');
	return { key: e.exerciseId, name: e.name, done, best: parts.join(' · ') || null };
}

/** The summary in words: its stats, each exercise, and the PRs. */
export function summaryWords(summary: WorkoutSummary): SummaryWords {
	const { units, run, other, sets } = summary;
	const stats: [string, string | null][] = [
		['Duration', summary.durationSeconds !== null ? durationWords(summary.durationSeconds) : null],
		[
			'Sets',
			summary.kind === 'strength'
				? `${sets.done} done${sets.skipped > 0 ? ` · ${sets.skipped} skipped` : ''}`
				: null
		],
		['Volume', summary.volume !== null ? formatWeight(summary.volume, units.weight) : null],
		['Distance', run?.distanceMetres != null ? distanceWords(run.distanceMetres, units) : null],
		['Run time', run?.durationSeconds != null ? formatDuration(run.durationSeconds) : null],
		['Pace', run?.pace != null ? `${formatDuration(run.pace)} /${units.distance}` : null],
		['Avg HR', run?.avgHr != null ? `${run.avgHr} bpm` : null],
		[
			other ? OTHER_SESSION_KIND_LABEL[other.kind] : '',
			other ? `${other.durationMinutes} min` : null
		]
	];
	return {
		stats: stats.flatMap(([label, value]) => (value === null ? [] : [{ label, value }])),
		exercises: summary.exercises.map((e) => exerciseWords(e, units)),
		prs: summary.prs.map((pr) => prWords(pr, units))
	};
}
