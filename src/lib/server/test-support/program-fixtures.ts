/**
 * Program plans for the integration tests and the e2e fixture route (m3/27), stored through
 * createProgramFromPlan as a generated plan is. Each starts on a given Monday and uses keys from
 * both catalogue parts; each passes programPlanSchema (program-store.test.ts).
 *
 * - hybrid: five planned weeks (a baseline week, then an accumulation block ending in a deload).
 *   Every week has a strength session (a power clean in the power slot, a back-squat top set with
 *   back-offs, bench and row), Muay Thai evening classes on Tuesday and Thursday, intervals on
 *   Wednesday, an easy run on Thursday morning and three rest days.
 * - today / today-rest: two planned weeks. Today, which must fall in week 1, has a strength
 *   session and a Muay Thai class, or nothing; week 2 is planned, so 'up next' crosses a week
 *   boundary on any weekday.
 * - one-week: one planned week, then an outline block whose weeks have no sessions.
 * - workout-day: the shared kit fixture's program (tests/fixtures/workout-day.ts). Today, which
 *   must fall in week 1: a baseline strength session (back squat top set and back-offs, leg
 *   press, Romanian deadlift, then an A1 pull-up / A2 plank superset), an interval run and a
 *   Muay Thai class. Week 2 repeats the strength session a week later.
 */
import { addDays, daysBetween, mondayOf, type IsoDate } from '../../domain/calendar';
import type {
	BlockPlan,
	DecisionPlan,
	OtherSessionPlan,
	PlannedExercisePlan,
	ProgramPlan,
	RunSegment,
	SessionPlan,
	SetPrescription,
	WeekPlan,
	WeekTargets
} from '../../domain/training/types';
import type { Phase, WeekKind } from '../../domain/training/vocabulary';

export const PROGRAM_FIXTURES = [
	'hybrid',
	'today',
	'today-rest',
	'one-week',
	'workout-day'
] as const;
export type ProgramFixture = (typeof PROGRAM_FIXTURES)[number];

/** Stand-ins for the M2 rows a plan refers to by uuid (no foreign key) when a test has none. */
export const FIXTURE_GOAL = 'f1a7e000-0000-4000-8000-000000000001';
export const FIXTURE_COMMITMENT = 'f1a7e000-0000-4000-8000-000000000002';

export interface FixtureOptions {
	/** The Monday of week 1. */
	monday: IsoDate;
	/** The owner's today: the 'today' fixtures plan around it; the others ignore it. */
	today: IsoDate;
	goalRefs?: string[];
	/** The Muay Thai classes' commitment. */
	commitmentRef?: string;
}

const set = (over: Partial<SetPrescription>): SetPrescription => ({
	role: 'working',
	sets: 3,
	repsMin: 5,
	repsMax: 5,
	seconds: null,
	metres: null,
	targetRpe: 7,
	loadKind: 'rpe_based',
	loadValue: null,
	loadUnit: null,
	loadBasis: null,
	reference1rm: null,
	reference1rmUnit: null,
	restSeconds: 120,
	tempo: null,
	notes: null,
	...over
});

const lift = (
	key: string,
	sets: SetPrescription[],
	over: Partial<PlannedExercisePlan> = {}
): PlannedExercisePlan => ({
	exercise: { key },
	baselineLift: null,
	superset: null,
	substitutedFrom: null,
	substitutionReason: null,
	instructions: null,
	notes: null,
	sets,
	...over
});

const segment = (kind: RunSegment['kind'], over: Partial<RunSegment>): RunSegment => ({
	kind,
	repeatGroup: null,
	repeats: null,
	distanceMetres: null,
	durationSeconds: null,
	paceMinSecondsPerKm: null,
	paceMaxSecondsPerKm: null,
	hrZone: null,
	targetRpe: null,
	...over
});

const base = (date: IsoDate, minutes: number, rpe: number) => ({
	date,
	timeOfDay: 'morning' as const,
	orderInDay: 1,
	customDiscipline: null,
	estMinutes: minutes,
	estLoad: minutes * rpe,
	targetRpe: rpe,
	source: 'generator' as const,
	commitmentRef: null,
	instructions: null,
	notes: null
});

/** A fraction of a 1RM that grows 2.5 % a week, kept to three decimals. */
const step = (from: number, n: number) => Math.round((from + 0.025 * n) * 1000) / 1000;

/** Week `n` (0 = the baseline week): RPE-based in week 1, then from the estimates it gives. */
function strength(date: IsoDate, n: number, rpe: number): SessionPlan {
	const top = { role: 'top', sets: 1, targetRpe: rpe, restSeconds: 180 } as const;
	const squat =
		n === 0 ? set(top) : set({ ...top, loadKind: 'from_e1rm', loadValue: step(0.8, n) });
	return {
		...base(date, 60, rpe),
		kind: 'strength',
		type: 'strength',
		title: 'Full body',
		discipline: 'strength',
		intensity: 'moderate',
		exercises: [
			lift('power_clean', [set({ sets: 4, repsMin: 3, repsMax: 3 })], {
				instructions: 'Fast and crisp: end the set when the bar slows.'
			}),
			lift(
				'back_squat',
				[squat, set({ role: 'back_off', sets: 2, loadKind: 'from_e1rm', loadValue: 0.72 })],
				{ baselineLift: 'back_squat', instructions: 'Record weight, reps and RPE for every set.' }
			),
			lift(
				'bench_press',
				[
					set({
						targetRpe: rpe,
						loadKind: 'percent_1rm',
						loadValue: step(0.7, n),
						loadBasis: 'measured',
						reference1rm: 100,
						reference1rmUnit: 'kg'
					})
				],
				{ baselineLift: 'bench_press' }
			),
			lift('barbell_row', [set({ repsMin: 8, repsMax: 10, restSeconds: 90, tempo: '2010' })])
		]
	};
}

function intervals(date: IsoDate): SessionPlan {
	const repeat = { repeatGroup: 1, repeats: 6 };
	return {
		...base(date, 45, 7),
		kind: 'run',
		type: 'interval_run',
		title: 'Intervals',
		discipline: 'running',
		intensity: 'hard',
		segments: [
			segment('warm_up', { durationSeconds: 600, targetRpe: 3 }),
			segment('interval', {
				...repeat,
				distanceMetres: 400,
				paceMinSecondsPerKm: 225,
				paceMaxSecondsPerKm: 240
			}),
			segment('recovery', { ...repeat, durationSeconds: 90, targetRpe: 2 }),
			segment('cool_down', { durationSeconds: 600, hrZone: 2 })
		]
	};
}

function easyRun(date: IsoDate): SessionPlan {
	return {
		...base(date, 30, 4),
		kind: 'run',
		type: 'easy_run',
		title: 'Easy run',
		discipline: 'running',
		intensity: 'easy',
		segments: [segment('easy', { durationSeconds: 1800, hrZone: 2, targetRpe: 4 })]
	};
}

function muayThai(date: IsoDate, orderInDay: number, commitmentRef: string): SessionPlan {
	return {
		...base(date, 90, 7),
		kind: 'other',
		timeOfDay: 'evening',
		orderInDay,
		type: 'muay_thai',
		title: 'Muay Thai class',
		discipline: 'muay_thai',
		intensity: 'hard',
		source: 'commitment',
		commitmentRef,
		details: {
			kind: 'class',
			durationMinutes: 90,
			targetRpe: 7,
			metrics: [
				{ key: 'rounds', label: 'Rounds', unit: null, value: 6 },
				{ key: 'round_length', label: 'Round length', unit: 'min', value: 3 },
				{ key: 'sparring', label: 'Sparring', unit: null, value: false },
				{ key: 'focus', label: 'Focus', unit: null, value: 'Teeps and checks' }
			],
			notes: null
		}
	};
}

/** workout-day's strength session: what the shared kit fixture's strength kit runs. */
function lowerBodyAndPull(date: IsoDate): SessionPlan {
	const none = { repsMin: null, repsMax: null };
	return {
		...base(date, 60, 7),
		kind: 'strength',
		type: 'strength',
		title: 'Lower body & pull',
		discipline: 'strength',
		intensity: 'moderate',
		exercises: [
			lift(
				'back_squat',
				[
					set({ role: 'top', sets: 1, restSeconds: 180 }),
					set({
						role: 'back_off',
						targetRpe: null,
						loadKind: 'from_e1rm',
						loadValue: 0.8,
						restSeconds: 180
					})
				],
				{ baselineLift: 'back_squat' }
			),
			lift('leg_press', [set({ repsMin: 10, repsMax: 10 })]),
			lift('romanian_deadlift', [set({ repsMin: 8, repsMax: 8 })]),
			// A1/A2: no rest inside a round, 90 s after each.
			lift('pull_up', [set({ repsMin: 6, repsMax: 10, targetRpe: 8, restSeconds: 0 })], {
				superset: 1
			}),
			lift('plank', [set({ ...none, seconds: 45, restSeconds: 90 })], { superset: 1 })
		]
	};
}

/** workout-day's run: 10 min warm-up, 6 × (400 m + 90 s), 10 min cool-down. */
function workoutDayRun(date: IsoDate): SessionPlan {
	const repeat = { repeatGroup: 1, repeats: 6 };
	return {
		...base(date, 45, 7),
		kind: 'run',
		orderInDay: 2,
		type: 'interval_run',
		title: 'Intervals',
		discipline: 'running',
		intensity: 'hard',
		segments: [
			segment('warm_up', { durationSeconds: 600, hrZone: 2 }),
			segment('interval', {
				...repeat,
				distanceMetres: 400,
				paceMinSecondsPerKm: 225,
				paceMaxSecondsPerKm: 240
			}),
			segment('recovery', { ...repeat, durationSeconds: 90 }),
			segment('cool_down', { durationSeconds: 600, hrZone: 2 })
		]
	};
}

/** workout-day's class: 90 minutes at RPE 7, logging rounds and whether you sparred. */
function workoutDayClass(date: IsoDate, commitmentRef: string): SessionPlan {
	return {
		...(muayThai(date, 3, commitmentRef) as OtherSessionPlan),
		details: {
			kind: 'class',
			durationMinutes: 90,
			targetRpe: 7,
			metrics: [
				{ key: 'rounds', label: 'Rounds', unit: null, value: 6 },
				{ key: 'sparred', label: 'Sparred', unit: null, value: false }
			],
			notes: null
		}
	};
}

const TARGETS: Record<'baseline' | 'accumulation' | 'deload', (n: number) => WeekTargets> = {
	baseline: () => ({ rpeCap: 7, volumeFactor: 1, loadStep: 0, runVolumeFactor: 1 }),
	accumulation: (n) => ({
		rpeCap: 7 + n / 2,
		volumeFactor: 1,
		loadStep: 0.025,
		runVolumeFactor: 1
	}),
	deload: () => ({ rpeCap: 7, volumeFactor: 0.6, loadStep: -0.1, runVolumeFactor: 0.7 })
};

const week = (
	startsOn: IsoDate,
	kind: WeekKind,
	targets: WeekTargets,
	sessions: SessionPlan[] = []
): WeekPlan => ({ kind, startsOn, endsOn: addDays(startsOn, 6), targets, sessions });

/** The hybrid week starting on `monday`, the program's week `n`. */
function hybridWeek(monday: IsoDate, n: number, kind: keyof typeof TARGETS, mt: string) {
	const targets = TARGETS[kind](n);
	const day = (d: number) => addDays(monday, d);
	return week(monday, kind, targets, [
		strength(day(0), n, targets.rpeCap),
		muayThai(day(1), 1, mt),
		intervals(day(2)),
		easyRun(day(3)),
		muayThai(day(3), 2, mt)
	]);
}

const block = (
	phase: Phase,
	name: string,
	weeks: WeekPlan[],
	goalRefs: string[],
	outline = false
): BlockPlan => ({
	phase,
	name,
	startsOn: weeks[0]!.startsOn,
	endsOn: weeks.at(-1)!.endsOn,
	outline,
	goalRefs,
	progression: outline ? {} : { rpeStepPerWeek: 0.5, rpeCap: 8.5 },
	weeks
});

const decision = (over: Partial<DecisionPlan>): DecisionPlan => ({
	kind: 'program_purpose',
	ruleKey: 'blocks.baseline_first',
	summary: 'Week 1 establishes your baselines',
	why: 'Your working weights are not known yet, so week 1 finds them before the load builds.',
	decidedBy: 'rules',
	refs: ['blocks.0'],
	evidence: {},
	...over
});

const HYBRID_DECISIONS: DecisionPlan[] = [
	decision({}),
	decision({
		kind: 'block_structure',
		ruleKey: 'blocks.default',
		summary: 'A baseline week, then three accumulation weeks and a deload',
		refs: ['blocks.0', 'blocks.1'],
		evidence: { weeks: 5 }
	}),
	decision({
		kind: 'commitment_placed',
		ruleKey: 'commitments.fixed_first',
		summary: 'Muay Thai stays on Tuesday and Thursday evenings',
		why: 'Your classes are fixed, so they were placed before anything else.',
		refs: ['blocks.0.weeks.0.sessions.1', 'blocks.0.weeks.0.sessions.4'],
		evidence: { days: 'tue, thu' }
	}),
	decision({
		kind: 'exercise_selected',
		ruleKey: 'strength.power_slot',
		summary: 'Power clean opens the session',
		why: 'Explosive work comes first, while you are fresh.',
		refs: ['blocks.0.weeks.0.sessions.0.exercises.0'],
		evidence: { pattern: 'olympic' }
	}),
	decision({
		kind: 'default_assumed',
		ruleKey: 'defaults.session_minutes',
		summary: 'Sessions last up to 60 minutes',
		why: 'You have not said how long a session can be yet: set it in Profile → Schedule.',
		refs: [],
		evidence: { sessionMinutes: 60, assumed: true }
	})
];

/** A fixture plan; RangeError when `monday` is not a Monday, or today is outside a 'today' week 1. */
export function programFixture(name: ProgramFixture, options: FixtureOptions): ProgramPlan {
	const { monday, today, goalRefs = [FIXTURE_GOAL], commitmentRef = FIXTURE_COMMITMENT } = options;
	if (mondayOf(monday) !== monday) throw new RangeError(`${monday} is not a Monday`);
	const plan = (title: string, blocks: BlockPlan[], decisions = [decision({})]): ProgramPlan => ({
		title,
		startsOn: monday,
		firstPlannedDay: monday,
		blocks,
		decisions
	});
	const next = addDays(monday, 7);
	switch (name) {
		case 'hybrid': {
			const weeks = [1, 2, 3, 4].map((n) =>
				hybridWeek(addDays(monday, 7 * n), n, n < 4 ? 'accumulation' : 'deload', commitmentRef)
			);
			return plan(
				'Strength, running and Muay Thai',
				[
					block(
						'baseline',
						'Baseline week',
						[hybridWeek(monday, 0, 'baseline', commitmentRef)],
						goalRefs
					),
					block('accumulation', 'Accumulation', weeks, goalRefs)
				],
				HYBRID_DECISIONS
			);
		}
		case 'today':
		case 'today-rest': {
			const offset = daysBetween(monday, today);
			if (offset < 0 || offset > 6)
				throw new RangeError(`${today} is not in the week of ${monday}`);
			const sessions = [
				...(offset > 0 ? [easyRun(addDays(today, -1))] : []),
				...(name === 'today'
					? [strength(today, 0, 7), muayThai(today, 2, commitmentRef)]
					: offset < 6
						? [intervals(addDays(today, 1))]
						: [])
			];
			return plan(`Fixture: ${name}`, [
				block(
					'baseline',
					'Baseline week',
					[week(monday, 'baseline', TARGETS.baseline(0), sessions)],
					goalRefs
				),
				block(
					'accumulation',
					'Accumulation',
					[hybridWeek(next, 1, 'accumulation', commitmentRef)],
					goalRefs
				)
			]);
		}
		case 'workout-day': {
			const offset = daysBetween(monday, today);
			if (offset < 0 || offset > 6)
				throw new RangeError(`${today} is not in the week of ${monday}`);
			const sessions = [
				lowerBodyAndPull(today),
				workoutDayRun(today),
				workoutDayClass(today, commitmentRef)
			];
			return plan('Fixture: workout day', [
				block(
					'baseline',
					'Baseline week',
					[week(monday, 'baseline', TARGETS.baseline(0), sessions)],
					goalRefs
				),
				block(
					'accumulation',
					'Accumulation',
					[
						week(next, 'accumulation', TARGETS.accumulation(1), [
							lowerBodyAndPull(addDays(today, 7))
						])
					],
					goalRefs
				)
			]);
		}
		case 'one-week': {
			const outline = [0, 1, 2].map((n) =>
				week(addDays(next, 7 * n), 'accumulation', TARGETS.accumulation(n + 1))
			);
			return plan('Fixture: one planned week', [
				block(
					'baseline',
					'Baseline week',
					[hybridWeek(monday, 0, 'baseline', commitmentRef)],
					goalRefs
				),
				block('accumulation', 'Accumulation', outline, goalRefs, true)
			]);
		}
	}
}
