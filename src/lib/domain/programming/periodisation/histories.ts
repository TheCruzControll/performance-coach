/**
 * M7's logged-training histories (periodisation-scenarios): the facts M6's loaders give (completed
 * workouts, strength sets, runs, recovery notes and the prescriptions the sets were logged
 * against), in M6's own shapes, so the load model, the reactive deload and the weekly review read
 * them as they read the database. Every row is built through a builder that fills defaults, so a
 * field M6 adds is one edit here and none in a history. Later tests import them and never edit
 * them. Each call returns a fresh copy.
 *
 * A history's last week is week `endWeek` of m7Day (0 by default: the week before a scenario plan
 * starts), its earlier weeks before it. Times are 07:00 UTC on the day, plus minutes.
 */
import { addDays } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import type { RunFact } from '../../analytics/running.ts';
import type { StrengthFact } from '../../analytics/strength.ts';
import type { RecoveryEntry } from '../../analytics/workload.ts';
import type { SetPrescription } from '../../training/types.ts';
import type { OtherSessionKind, SessionType } from '../../training/vocabulary.ts';
import type { PrescribedExercise, ReviewWorkout } from '../review/weekly.ts';
import type { CoverageId } from './coverage.ts';
import { m7Day } from './scenarios.ts';

/** One history's facts, in M6's shapes, with the Mondays of its first and last weeks. */
export interface FactHistory {
	timeZone: 'UTC';
	firstWeek: IsoDate;
	lastWeek: IsoDate;
	workouts: ReviewWorkout[];
	sets: StrengthFact[];
	runs: RunFact[];
	recovery: RecoveryEntry[];
	prescriptions: PrescribedExercise[];
}

/** 07:00 UTC on `date`, plus `minutes`. */
export const factTime = (date: IsoDate, minutes = 0) =>
	new Date(Date.parse(`${date}T07:00:00Z`) + minutes * 60_000);

// ---- Row builders: each fills every field it is not given --------------------------------------

export const workoutFact = (
	row: Pick<ReviewWorkout, 'id' | 'sessionType' | 'startedAt'> & Partial<ReviewWorkout>
): ReviewWorkout => ({
	title: row.id,
	durationSeconds: 3600,
	sessionRpe: 7,
	run: null,
	other: null,
	discipline: 'strength',
	plannedLineage: `lineage-${row.id}`,
	...row
});

export const setFact = (
	row: Pick<StrengthFact, 'id' | 'workoutId' | 'exercise' | 'performedAt'> & Partial<StrengthFact>
): StrengthFact => ({
	plannedLineage: null,
	setIndex: 1,
	weight: null,
	unit: 'kg',
	reps: 5,
	rpe: null,
	seconds: null,
	metres: null,
	assistance: null,
	missedReps: 0,
	isWarmup: false,
	isSkipped: false,
	isExtra: false,
	deletedAt: null,
	...row
});

export const runFact = (
	row: Pick<RunFact, 'workout' | 'startedAt' | 'sessionType'> & Partial<RunFact>
): RunFact => ({ metres: null, seconds: null, avgHr: null, rpe: null, segments: [], ...row });

export const recoveryFact = (
	row: Pick<RecoveryEntry, 'id' | 'notedOn'> & Partial<RecoveryEntry>
): RecoveryEntry => ({
	sleepHours: null,
	soreness: null,
	energy: null,
	stress: null,
	note: null,
	...row
});

/** A working line of `sets` × `reps` at RPE `targetRpe`, loaded by RPE. */
export const workingLine = (sets: number, reps: number, targetRpe: number): SetPrescription => ({
	role: 'working',
	sets,
	repsMin: reps,
	repsMax: reps,
	seconds: null,
	metres: null,
	targetRpe,
	loadKind: 'rpe_based',
	loadValue: null,
	loadUnit: null,
	loadBasis: null,
	reference1rm: null,
	reference1rmUnit: null,
	restSeconds: null,
	tempo: null,
	notes: null
});

// ---- Session builders --------------------------------------------------------------------------

const empty = (firstWeek: IsoDate, lastWeek: IsoDate): FactHistory => ({
	timeZone: 'UTC',
	firstWeek,
	lastWeek,
	workouts: [],
	sets: [],
	runs: [],
	recovery: [],
	prescriptions: []
});

/** The planned target RPE of every lift in these histories. */
const TARGET_RPE = 8;

/**
 * `exercise` in workout `id` on `date`: one set of `reps` at `kg` per RPE in `rpes`, logged
 * against a line of that many sets at TARGET_RPE. The workout is added with its first lift.
 */
function lift(
	h: FactHistory,
	id: string,
	date: IsoDate,
	exercise: string,
	kg: number,
	rpes: readonly number[],
	reps = 5
) {
	if (!h.workouts.some((w) => w.id === id))
		h.workouts.push(workoutFact({ id, sessionType: 'strength', startedAt: factTime(date) }));
	const lineage = `lineage-${id}:${exercise}`;
	rpes.forEach((rpe, i) =>
		h.sets.push(
			setFact({
				id: `${id}:${exercise}:${i + 1}`,
				workoutId: id,
				exercise,
				plannedLineage: lineage,
				setIndex: i + 1,
				weight: kg,
				reps,
				rpe,
				performedAt: factTime(date, h.sets.filter((s) => s.workoutId === id).length + 1)
			})
		)
	);
	h.prescriptions.push({
		lineage,
		exerciseId: exercise,
		lines: [workingLine(rpes.length, reps, TARGET_RPE)],
		workoutId: id,
		day: date
	});
}

function run(
	h: FactHistory,
	id: string,
	date: IsoDate,
	type: SessionType,
	km: number,
	{ pace = 330, rpe = 5 }: { pace?: number; rpe?: number } = {}
) {
	const seconds = Math.round(km * pace);
	h.workouts.push(
		workoutFact({
			id,
			sessionType: type,
			startedAt: factTime(date),
			discipline: 'running',
			durationSeconds: seconds,
			sessionRpe: null,
			run: { durationSeconds: seconds, rpe }
		})
	);
	h.runs.push(
		runFact({
			workout: id,
			startedAt: factTime(date),
			sessionType: type,
			metres: km * 1000,
			seconds,
			rpe
		})
	);
}

function muayThai(
	h: FactHistory,
	id: string,
	date: IsoDate,
	kind: OtherSessionKind,
	{ minutes = 60, rpe = 6, rounds = 6 } = {}
) {
	const key = kind === 'sparring' ? 'sparring_rounds' : 'rounds';
	h.workouts.push(
		workoutFact({
			id,
			sessionType: 'muay_thai',
			startedAt: factTime(date, 11 * 60),
			discipline: 'muay_thai',
			durationSeconds: minutes * 60,
			sessionRpe: rpe,
			other: {
				kind,
				durationMinutes: minutes,
				rpe,
				metrics: [{ key, label: 'Rounds', unit: null, value: rounds }]
			}
		})
	);
}

function note(h: FactHistory, date: IsoDate, row: Partial<RecoveryEntry>) {
	h.recovery.push(recoveryFact({ id: `note-${date}`, notedOn: date, ...row }));
}

/** Rested: 7.5 hours of sleep, soreness 2 of 5, good energy, low stress. */
const RESTED = { sleepHours: 7.5, soreness: 2, energy: 4, stress: 2 } as const;
/** Squat and bench, five sets of five, the RPE of each set. */
const STEADY_SETS = [7, 7, 7.5, 7.5, 8] as const;

/**
 * The usual week from `monday`: squat and bench on Monday (STEADY_SETS unless told), an easy run
 * on Tuesday, pads on Thursday, deadlift on Friday, a long run on Saturday, notes on Monday and
 * Thursday.
 */
function usualWeek(
	h: FactHistory,
	monday: IsoDate,
	{ sets = STEADY_SETS as readonly number[], recovery = RESTED as Partial<RecoveryEntry> } = {}
) {
	const day = (n: number) => addDays(monday, n);
	lift(h, `${monday}-mon`, day(0), 'back_squat', 120, sets);
	lift(h, `${monday}-mon`, day(0), 'bench_press', 85, sets);
	run(h, `${monday}-tue`, day(1), 'easy_run', 8);
	muayThai(h, `${monday}-thu`, day(3), 'pad_work');
	lift(h, `${monday}-fri`, day(4), 'deadlift', 140, [7, 7, 7.5]);
	run(h, `${monday}-sat`, day(5), 'long_run', 14, { pace: 345 });
	note(h, day(0), recovery);
	note(h, day(3), recovery);
}

/** `weeks` Mondays ending on week `endWeek`'s, oldest first. */
const mondays = (weeks: number, endWeek: number) =>
	Array.from({ length: weeks }, (_, i) => m7Day(endWeek - weeks + 1 + i, 0));

const history = (weeks: number, endWeek: number) => {
	const list = mondays(weeks, endWeek);
	return { list, h: empty(list[0]!, list.at(-1)!) };
};

// ---- The histories -------------------------------------------------------------------------------

/** The weeks of steady training, and of the declining history's steady start. */
export const STEADY_WEEKS = 6;

/**
 * The declining weeks' squat and bench sets at the same 120 and 85 kg: each week's easiest set
 * half an RPE harder (the e1RM falls week on week), and the mean RPE 0.7 higher in the last week
 * than in the first (8.0, 8.4, 8.7): RPE creep at equal loads.
 */
export const DECLINING_SETS = [
	[7.5, 8, 8, 8, 8.5],
	[8, 8, 8.5, 8.5, 9],
	[8.5, 8.5, 8.5, 8.5, 9.5]
] as const;

/** The declining weeks' recovery: sore (4 of 5) on 5.9 hours of sleep. */
export const DECLINING_RECOVERY = { sleepHours: 5.9, soreness: 4, energy: 2, stress: 3 } as const;

/**
 * The overreaching history's runs, Monday to Sunday (km; 0 for rest): four weeks of 40 km, then
 * +35 % in two weeks to 54 km, the last with no rest day.
 */
export const OVERREACHING_RUNS = [
	...Array.from({ length: 4 }, () => [0, 8, 8, 10, 0, 14, 0]),
	[0, 8, 8, 10, 7, 14, 0],
	[6, 8, 8, 8, 6, 12, 6]
] as const;

export const HISTORIES = {
	/** Six usual weeks: the same loads at the same RPE, rested. */
	steady: (endWeek = 0) => {
		const { list, h } = history(STEADY_WEEKS, endWeek);
		for (const monday of list) usualWeek(h, monday);
		return h;
	},
	/**
	 * S7: three usual weeks, then three where squat and bench feel harder at the same loads
	 * (DECLINING_SETS) and the owner sleeps 5.9 hours and is sore (DECLINING_RECOVERY).
	 */
	declining: (endWeek = 0) => {
		const { list, h } = history(STEADY_WEEKS, endWeek);
		list.forEach((monday, i) => {
			const declining = DECLINING_SETS[i - (STEADY_WEEKS - DECLINING_SETS.length)];
			usualWeek(h, monday, declining ? { sets: declining, recovery: DECLINING_RECOVERY } : {});
		});
		return h;
	},
	/** S9: a runner's weeks rising from 40 to 54 km in two (OVERREACHING_RUNS), easy except Saturday's long run. */
	overreachingRun: (endWeek = 0) => {
		const { list, h } = history(OVERREACHING_RUNS.length, endWeek);
		list.forEach((monday, w) =>
			OVERREACHING_RUNS[w]!.forEach((km, d) => {
				const type = d === 5 ? 'long_run' : 'easy_run';
				if (km > 0) run(h, `${monday}-${d}`, addDays(monday, d), type, km);
			})
		);
		return h;
	},
	/** S10: one fight-camp week: 8 rounds of hard sparring on Monday, pads on Wednesday. */
	hardCampWeek: (endWeek = 0) => {
		const { list, h } = history(1, endWeek);
		const day = (n: number) => addDays(list[0]!, n);
		muayThai(h, `${list[0]}-mon`, day(0), 'sparring', { minutes: 90, rpe: 9, rounds: 8 });
		muayThai(h, `${list[0]}-wed`, day(2), 'pad_work', { minutes: 60, rpe: 7, rounds: 6 });
		return h;
	},
	/** S9: one week of 60 km of running with 18 lower-body hard sets. */
	bigRunWeek: (endWeek = 0) => {
		const { list, h } = history(1, endWeek);
		const day = (n: number) => addDays(list[0]!, n);
		const id = `${list[0]}`;
		lift(h, `${id}-mon`, day(0), 'back_squat', 120, [8, 8, 8, 8, 8, 8]);
		lift(h, `${id}-mon`, day(0), 'bulgarian_split_squat', 30, [8, 8, 8], 8);
		lift(h, `${id}-thu`, day(3), 'romanian_deadlift', 110, [8, 8, 8, 8, 8, 8], 6);
		lift(h, `${id}-thu`, day(3), 'leg_press', 180, [8, 8, 8], 10);
		run(h, `${id}-tue`, day(1), 'tempo_run', 12, { pace: 290, rpe: 7 });
		run(h, `${id}-wed`, day(2), 'easy_run', 10);
		run(h, `${id}-fri`, day(4), 'easy_run', 8);
		run(h, `${id}-sat`, day(5), 'long_run', 24, { pace: 345, rpe: 6 });
		run(h, `${id}-sun`, day(6), 'recovery_run', 6, { pace: 360, rpe: 3 });
		return h;
	},
	/** The window where M1's acute:chronic ratio is still null: 20 days of usual training. */
	shortHistory: (endWeek = 0) => {
		const { list, h } = history(3, endWeek);
		for (const monday of list) usualWeek(h, monday);
		// Logged from the first week's Tuesday: 20 days to the last Sunday.
		const first = addDays(list[0]!, 1);
		const before = new Set(
			h.workouts.filter((w) => factTime(first) > w.startedAt).map((w) => w.id)
		);
		return {
			...h,
			workouts: h.workouts.filter((w) => !before.has(w.id)),
			sets: h.sets.filter((s) => !before.has(s.workoutId)),
			prescriptions: h.prescriptions.filter((p) => !before.has(p.workoutId)),
			recovery: h.recovery.filter((r) => r.notedOn >= first)
		};
	}
} satisfies Record<string, (endWeek?: number) => FactHistory>;

export type HistoryKey = keyof typeof HISTORIES;

/** What each history covers (coverage.ts): steady is S7's contrast, shortHistory S10's load model. */
export const HISTORY_COVERAGE = {
	steady: ['S7'],
	declining: ['S7'],
	overreachingRun: ['S9'],
	hardCampWeek: ['S10'],
	bigRunWeek: ['S9'],
	shortHistory: ['S10']
} as const satisfies Record<HistoryKey, readonly CoverageId[]>;
