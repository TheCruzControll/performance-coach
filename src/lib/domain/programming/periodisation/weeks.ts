/**
 * The PRD §5 weeks (m7/03 week-evaluation): small weeks of sessions on fixed dates, in the week of
 * SCENARIO_START (Monday 9 November 2026), that every M7 judge is tested against. The first three
 * are the conflicts PRD §5 names; the rest show a prefer finding, a clean hybrid week and the two
 * ways a plan keeps a conflict on purpose. Never edited: a test that needs a variant builds one
 * from these in its own file. Each call returns fresh copies.
 */
import { addDays } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import type { RunSegmentKind, SessionIntensity, SessionType } from '../../training/vocabulary.ts';
import type { EvaluatedSession } from '../evaluate/week.ts';
import type { InterferenceSession } from '../interference.ts';
import { SCENARIO_START } from '../scenarios.ts';

/** Day `day` of the week: 0 Monday … 6 Sunday. */
export const weekDay = (day: number): IsoDate => addDays(SCENARIO_START, day);

type Base = Pick<
	InterferenceSession,
	| 'date'
	| 'timeOfDay'
	| 'orderInDay'
	| 'type'
	| 'title'
	| 'discipline'
	| 'intensity'
	| 'estMinutes'
	| 'source'
> &
	Pick<EvaluatedSession, 'lineage' | 'status' | 'movedFrom'>;
type Over = Partial<Base>;

const base = (day: number, title: string, type: SessionType, over: Over): Base => ({
	date: weekDay(day),
	timeOfDay: null,
	orderInDay: 1,
	type,
	title,
	discipline: 'strength',
	intensity: 'moderate',
	estMinutes: 60,
	source: 'generator',
	lineage: title.toLowerCase().replaceAll(' ', '-'),
	status: 'planned',
	...over
});

const lifts = (...lines: [key: string, sets: number, rpe: number][]) =>
	lines.map(([key, sets, targetRpe]) => ({
		exercise: { key },
		sets: [{ role: 'working', sets, targetRpe, loadKind: 'rpe_based', loadValue: null } as const]
	}));

const strength = (
	day: number,
	title: string,
	exercises: ReturnType<typeof lifts>,
	over: Over = {}
): EvaluatedSession => ({ kind: 'strength', ...base(day, title, 'strength', over), exercises });

const run = (
	day: number,
	title: string,
	type: SessionType,
	segments: RunSegmentKind[],
	intensity: SessionIntensity,
	estMinutes: number
): EvaluatedSession => ({
	kind: 'run',
	...base(day, title, type, { discipline: 'running', intensity, estMinutes }),
	segments: segments.map((kind) => ({ kind }))
});

/** A class the owner attends: a commitment, hard and in the evening unless `over` says otherwise. */
const commitment = (
	day: number,
	title: string,
	type: SessionType,
	kind: 'sparring' | 'technical' | 'class',
	over: Over
): EvaluatedSession => ({
	kind: 'other',
	...base(day, title, type, {
		intensity: 'hard',
		estMinutes: 90,
		source: 'commitment',
		timeOfDay: 'evening',
		...over
	}),
	details: { kind }
});

/** Heavy squats: back squat 4 × 5 at RPE 8, then Romanian deadlifts, in a hard session. */
const lowerA = (day: number, over: Over = {}) =>
	strength(day, 'Lower A', lifts(['back_squat', 4, 8], ['romanian_deadlift', 3, 7]), {
		intensity: 'hard',
		...over
	});
/** Heavy bench and rows, hard. */
const upperA = (day: number) =>
	strength(day, 'Upper A', lifts(['bench_press', 4, 8], ['pull_up', 3, 7]), { intensity: 'hard' });
/** High-volume legs at moderate loads: 11 hard sets, none of them heavy. */
const legVolume = (day: number) =>
	strength(
		day,
		'Legs volume',
		lifts(['leg_press', 4, 7], ['walking_lunge', 3, 7], ['leg_extension', 4, 7])
	);
const sparring = (day: number) =>
	commitment(day, 'Muay Thai sparring', 'muay_thai', 'sparring', { discipline: 'muay_thai' });
const technique = (day: number) =>
	commitment(day, 'Muay Thai technique', 'muay_thai', 'technical', {
		discipline: 'muay_thai',
		intensity: 'easy'
	});
const longRun = (day: number) => run(day, 'Long run', 'long_run', ['long'], 'moderate', 100);
const easyRun = (day: number) => run(day, 'Easy run', 'easy_run', ['easy'], 'easy', 40);
const intervals = (day: number) =>
	run(day, 'Intervals', 'interval_run', ['warm_up', 'interval', 'cool_down'], 'hard', 50);
const tempoRun = (day: number) =>
	run(day, 'Tempo run', 'tempo_run', ['warm_up', 'tempo', 'cool_down'], 'hard', 40);

/** The weeks, by name. */
export const PRD_WEEKS = {
	/** S2: heavy squats on Monday, hard sparring on Tuesday evening. */
	squat_before_sparring: () => [lowerA(0), sparring(1), easyRun(3)],
	/** S3: high-volume legs on Friday, the long run on Saturday. */
	legs_before_long_run: () => [easyRun(1), legVolume(4), longRun(5)],
	/** S4: hard sparring on Tuesday evening, intervals on Wednesday. */
	intervals_after_demanding: () => [sparring(1), intervals(2), easyRun(4)],
	/** A tempo run on Monday, heavy upper body on Tuesday: advice only, when the week has room. */
	hard_days_back_to_back: () => [tempoRun(0), upperA(1), easyRun(3)],
	/** Strength, runs and Muay Thai, every hard day apart: nothing to find. */
	clean_hybrid_week: () => [
		lowerA(0),
		easyRun(1),
		sparring(2),
		technique(3),
		upperA(4),
		easyRun(5),
		longRun(6)
	],
	/** The owner moved Lower A from Monday to Thursday, the day before Friday's sparring. */
	owner_moved_conflict: () => [
		lowerA(3, { status: 'moved', movedFrom: weekDay(0) }),
		sparring(4),
		easyRun(1)
	],
	/** A hard strength class on Tuesday, then the running club's intervals on Wednesday. */
	commitments_only_clash: () => [
		commitment(1, 'Strength class', 'strength_class', 'class', {}),
		commitment(2, 'Running club', 'custom', 'class', { discipline: 'running' })
	]
} satisfies Record<string, () => EvaluatedSession[]>;

export type PrdWeek = keyof typeof PRD_WEEKS;
