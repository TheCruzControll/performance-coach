/**
 * What workout History (/progress/workouts/[[id]]) renders, in words composed on the server, so
 * they cost the screen no JavaScript: the owner's completed workouts, newest first,
 * WORKOUT_PAGE_SIZE at a time (listWorkouts), and with an id that workout's detail
 * (getWorkoutDetail), beside the list from 1024 px. Kept out of +page.server.ts so integration
 * tests can run it with an unreachable database.
 *
 * - `?before=<id>` is the page after that workout, the cursor a page gives: 'Show older' reads it
 *   without navigating (preloadData). A malformed cursor is the first page.
 * - A malformed or unknown id is the 404 page in the shell. The route has no param matcher, which
 *   would cost every route JavaScript (docs/performance.md).
 * - It fails soft: a read that fails is recorded as a server error (kind 'load') and History shows
 *   its designed error with Retry, inside the shell, instead of the 500 page.
 * - Loads read in the training profile's units, dates and times in its time zone.
 */
import { error, isHttpError } from '@sveltejs/kit';
import { localDay } from '#lib/domain/dates.ts';
import {
	BODY_AREA_LABEL,
	DISCIPLINE_INFO,
	SEVERITY_INFO,
	type DisciplineTone
} from '#lib/domain/profile/catalog.ts';
import {
	OTHER_SESSION_KIND_LABEL,
	RUN_SEGMENT_KIND_LABEL,
	SUBSTITUTION_REASON_LABEL
} from '#lib/domain/training/vocabulary.ts';
import {
	cleanFloat,
	convertPace,
	formatDuration,
	formatWeight,
	fromMetres
} from '#lib/domain/units.ts';
import { setValues } from '#lib/domain/workout/describe.ts';
import type { CanonicalSet, KitUnits, PainAction } from '#lib/domain/workout/index.ts';
import { expandSegments } from '#lib/domain/workout/run.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import { isUuid } from '#lib/server/services/ids.ts';
import { getAthleteProfile } from '#lib/server/services/profile/index.ts';
import type { TrainingDeps } from '#lib/server/services/training/shared.ts';
import {
	getWorkoutDetail,
	listWorkouts,
	type WorkoutDetail,
	type WorkoutListItem,
	type WorkoutPage
} from '#lib/server/services/workouts/history.ts';
import { shortDate, longDate } from '#lib/ui/program/words.ts';

/** A completed workout as the list shows it: one link, everything it says in words. */
export interface WorkoutRowView {
	id: string;
	tone: DisciplineTone;
	title: string;
	/** 'Wed 4 Nov · 52 min'. */
	meta: string;
	/** The number that matters for its kind: '12 sets', '8.02 km', 'RPE 7'; null when unknown. */
	figure: string | null;
}

export interface SetView {
	key: string;
	/** 'Set 2' or 'Warm-up'. */
	label: string;
	/** '100 kg × 5', '0:45'; 'Not done' for a skipped set. */
	value: string;
	rpe: string | null;
	/** Skipped, extra and missed in words: 'Extra set · 2 missed'; null for a plain set. */
	mark: string | null;
}

export interface ExerciseView {
	key: string;
	/** What its history (the exercise-history sheet) is asked for. */
	exerciseId: string;
	name: string;
	/** 'Estimated 1RM · 117.5 kg': the best set's, always an estimate; null where none applies. */
	best: string | null;
	sets: SetView[];
}

/** A labelled value: a stat tile, a metric, a planned exercise and what became of it. */
export interface Labelled {
	label: string;
	value: string;
}

export interface WorkoutDetailView {
	id: string;
	tone: DisciplineTone;
	title: string;
	/** 'Muay Thai · Wednesday 4 November · 18:00'. */
	eyebrow: string;
	stats: Labelled[];
	/** 'Back squat · Estimated 1RM 120 kg, was 115 kg'. */
	prs: string[];
	exercises: ExerciseView[];
	/** 'Back squat → Leg press · Equipment busy or missing'. */
	substitutions: string[];
	pain: { key: string; title: string; note: string | null }[];
	/** A run's segments: '2. Interval' and '0.4 km · 1:36 · 4:00 /km'. */
	segments: (Labelled & { key: string })[];
	/** An other session's metrics. */
	metrics: (Labelled & { key: string })[];
	notes: string[];
	/** The planned session against what was done; null off plan. */
	planned: { title: string; lines: (Labelled & { key: string })[] } | null;
}

export type WorkoutHistoryData =
	| {
			state: 'ready';
			rows: WorkoutRowView[];
			/** The `before` that gives the next page; null on the last. */
			next: string | null;
			/** The first page is empty: nothing has been finished yet. */
			empty: boolean;
			detail: WorkoutDetailView | null;
	  }
	| { state: 'error' };

export interface WorkoutHistoryRequest {
	/** The route's optional [[id]], as given. */
	id: string | undefined;
	/** The ?before cursor, as given. */
	before: string | null;
	origin: Pick<ServerErrorInput, 'requestId' | 'method' | 'path' | 'routeId' | 'appVersion'>;
}

export interface WorkoutHistoryDeps extends Pick<TrainingDeps, 'db'> {
	/** Where a failure is recorded (app_errors): the app's database unless given. */
	errorsDb?: TrainingDeps['db'];
}

interface Context {
	units: KitUnits;
	timeZone: string;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** '52 min', '1 h 05 min'. */
export function durationWords(seconds: number): string {
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

const distanceWords = (metres: number, { distance }: KitUnits) =>
	`${cleanFloat(fromMetres(metres, distance), 2)} ${distance}`;

/** A pace stored per km, in the owner's unit: '4:00 /km', '6:26 /mi'. */
const paceWords = (perKm: number, { distance }: KitUnits) =>
	`${formatDuration(convertPace(perKm, 'km', distance))} /${distance}`;

/** `words(value)` for a value that is known, else null. */
const known = <T>(value: T | null | undefined, words: (value: T) => string) =>
	value === null || value === undefined ? null : words(value);

function rowView(item: WorkoutListItem, { units, timeZone }: Context): WorkoutRowView {
	const seconds =
		item.durationSeconds ??
		item.run?.durationSeconds ??
		(item.other ? item.other.durationMinutes * 60 : null);
	const distance = item.run?.distanceMetres ?? null;
	const figure = item.strength
		? count(item.strength.sets, 'set')
		: distance !== null
			? distanceWords(distance, units)
			: item.sessionRpe !== null
				? `RPE ${item.sessionRpe}`
				: null;
	const date = shortDate(localDay(new Date(item.startedAt), timeZone));
	return {
		id: item.id,
		tone: DISCIPLINE_INFO[item.discipline].tone,
		title: item.title,
		meta: seconds !== null ? `${date} · ${durationWords(seconds)}` : date,
		figure
	};
}

export const rowsOf = (page: WorkoutPage, context: Context) =>
	page.workouts.map((item) => rowView(item, context));

const SET_MARKS = (set: CanonicalSet) =>
	[
		set.isSkipped && 'Skipped',
		set.isExtra && 'Extra set',
		set.missedReps > 0 && `${set.missedReps} missed`
	].filter(Boolean) as string[];

const PAIN_ACTION_WORDS: Record<PainAction, string> = {
	stopped: 'Stopped the exercise',
	substituted: 'Switched to a gentler option',
	ended_workout: 'Ended the workout'
};

function timeOf(at: Date, timeZone: string) {
	return new Intl.DateTimeFormat('en-GB', {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).format(at);
}

/** The detail of one workout, in words. */
export function detailView(detail: WorkoutDetail, { timeZone }: Context): WorkoutDetailView {
	const { workout: canonical, summary, planned } = detail;
	const { workout, exercises: catalogue } = canonical;
	const units = summary.units;
	const name = (id: string) => catalogue[id]?.name ?? 'Exercise';
	const weight = (kg: number) => formatWeight(kg, units.weight);
	const live = <R extends { deletedAt: string | null }>(rows: R[]) =>
		rows.filter((row) => row.deletedAt === null);
	const started = new Date(workout.startedAt);
	const kind =
		workout.kind === 'other' && canonical.other
			? OTHER_SESSION_KIND_LABEL[canonical.other.kind]
			: DISCIPLINE_INFO[workout.discipline].short;

	// Each slot's sets under the exercise they name, in slot then set order.
	const groups = new Map<string, CanonicalSet[]>();
	const sets = live(canonical.sets).toSorted(
		(a, b) => a.position - b.position || a.setIndex - b.setIndex
	);
	for (const set of sets) {
		const key = `${set.position}:${set.exerciseId}`;
		groups.set(key, [...(groups.get(key) ?? []), set]);
	}
	const exercises = [...groups].map(([key, group]): ExerciseView => {
		const id = group[0]!.exerciseId;
		const e1rm = summary.exercises.find((e) => e.exerciseId === id)?.best?.e1rm;
		return {
			key,
			exerciseId: id,
			name: name(id),
			best: e1rm ? `Estimated 1RM · ${weight(e1rm.value)}` : null,
			sets: group.map((set) => ({
				key: set.id,
				label: set.isWarmup ? 'Warm-up' : `Set ${set.setIndex}`,
				value: set.isSkipped ? 'Not done' : setValues(set),
				rpe: set.rpe !== null && !set.isSkipped ? `RPE ${set.rpe}` : null,
				mark: SET_MARKS(set).join(' · ') || null
			}))
		};
	});

	const run = summary.run;
	const other = summary.other;
	const stats: [string, string | null][] = [
		[
			'Duration',
			known(
				summary.durationSeconds ??
					run?.durationSeconds ??
					(other ? other.durationMinutes * 60 : null),
				durationWords
			)
		],
		['Working sets', workout.kind === 'strength' ? String(summary.sets.done) : null],
		['Volume', known(summary.volume, weight)],
		['Distance', known(run?.distanceMetres, (m) => distanceWords(m, units))],
		['Pace', known(run?.pace, (s) => `${formatDuration(s)} /${units.distance}`)],
		['Avg HR', known(run?.avgHr, (hr) => `${hr} bpm`)],
		['Session RPE', known(summary.sessionRpe ?? other?.rpe ?? canonical.run?.rpe, String)],
		['Load', known(summary.sessionLoad, (load) => `${load} AU`)]
	];

	const lines = (planned: NonNullable<WorkoutDetail['planned']>) => {
		const strength = planned.exercises.map((e) => {
			const value =
				e.state === 'missed'
					? 'Missed'
					: e.state === 'skipped' || e.state === 'stopped'
						? `${e.state === 'skipped' ? 'Skipped' : 'Stopped'} · ${count(e.done, 'set')} done`
						: e.performedId && e.performedId !== e.exerciseId
							? `Done as ${name(e.performedId)} · ${count(e.done, 'set')}`
							: `${e.done} of ${count(e.sets, 'set')}`;
			return { key: `p${e.position}`, label: e.name, value };
		});
		const added = planned.added.map((a) => ({
			key: `a${a.position}`,
			label: name(a.exerciseId),
			value: `Added · ${count(a.done, 'set')}`
		}));
		const session = planned.other
			? [
					{
						key: 'other',
						label: OTHER_SESSION_KIND_LABEL[planned.other.kind],
						value: [
							`${planned.other.durationMinutes} min`,
							planned.other.targetRpe !== null && `RPE ${planned.other.targetRpe}`
						]
							.filter(Boolean)
							.join(' · ')
					}
				]
			: planned.run
				? [
						{
							key: 'run',
							label: 'Run',
							value: count(expandSegments(planned.run.segments).length, 'segment')
						}
					]
				: [];
		return [...strength, ...added, ...session];
	};

	return {
		id: workout.id,
		tone: DISCIPLINE_INFO[workout.discipline].tone,
		title: workout.title,
		eyebrow: `${kind} · ${longDate(localDay(started, timeZone))} · ${timeOf(started, timeZone)}`,
		stats: stats.flatMap(([label, value]) => (value === null ? [] : [{ label, value }])),
		prs: summary.prs.map(({ name: exercise, label, reps, kind, value, previous }) => {
			const amount = (n: number) => (kind === 'most_reps' ? count(n, 'rep') : weight(n));
			const what = reps !== null ? `${label} (${count(reps, 'rep')})` : label;
			return `${exercise} · ${what} ${amount(value)}, was ${amount(previous)}`;
		}),
		exercises,
		substitutions: live(canonical.substitutions).map(
			(s) =>
				`${name(s.fromExerciseId)} → ${name(s.toExerciseId)} · ${SUBSTITUTION_REASON_LABEL[s.reason]}`
		),
		pain: live(canonical.pain).map((p) => ({
			key: p.id,
			title: [
				name(p.exerciseId),
				p.area && BODY_AREA_LABEL[p.area],
				p.severity && SEVERITY_INFO[p.severity].label,
				PAIN_ACTION_WORDS[p.action]
			]
				.filter(Boolean)
				.join(' · '),
			note: p.note
		})),
		segments: (canonical.run?.segments ?? [])
			.toSorted((a, b) => a.position - b.position)
			.map((s) => ({
				key: s.id,
				label: `${s.position}. ${RUN_SEGMENT_KIND_LABEL[s.kind]}`,
				value:
					[
						s.distanceMetres !== null && distanceWords(s.distanceMetres, units),
						s.durationSeconds !== null && formatDuration(s.durationSeconds),
						s.paceSecondsPerKm !== null && paceWords(s.paceSecondsPerKm, units),
						s.avgHr !== null && `${s.avgHr} bpm`,
						s.rpe !== null && `RPE ${s.rpe}`
					]
						.filter(Boolean)
						.join(' · ') || 'Not recorded'
			})),
		metrics: (other?.metrics ?? []).map((m) => ({
			key: m.key,
			label: m.label,
			value:
				typeof m.value === 'boolean'
					? m.value
						? 'Yes'
						: 'No'
					: `${m.value}${m.unit ? ` ${m.unit}` : ''}`
		})),
		notes: [
			...new Set([workout.notes, canonical.run?.notes, canonical.other?.notes].filter(Boolean))
		] as string[],
		planned: planned ? { title: planned.title, lines: lines(planned) } : null
	};
}

export async function loadWorkoutHistory(
	ownerId: string,
	{ id, before, origin }: WorkoutHistoryRequest,
	{ db, errorsDb }: WorkoutHistoryDeps = {}
): Promise<WorkoutHistoryData> {
	if (id !== undefined && !isUuid(id)) error(404, 'Not found');
	try {
		const profile = await getAthleteProfile(ownerId, { db });
		const context: Context = {
			units: { weight: profile.weightUnit, distance: profile.distanceUnit },
			timeZone: profile.timeZone
		};
		const cursor = before !== null && isUuid(before) ? before : undefined;
		const page = await listWorkouts(ownerId, { before: cursor }, { db });
		const detail = id === undefined ? null : await getWorkoutDetail(ownerId, id, { db });
		if (id !== undefined && !detail) error(404, 'Not found');
		return {
			state: 'ready',
			rows: rowsOf(page, context),
			next: page.next,
			empty: cursor === undefined && page.workouts.length === 0,
			detail: detail && detailView(detail, context)
		};
	} catch (err) {
		if (isHttpError(err)) throw err;
		await recordServerError(
			{ error: err, kind: 'load', status: 500, ...origin, context: { load: 'workout-history' } },
			{ db: errorsDb }
		);
		return { state: 'error' };
	}
}
