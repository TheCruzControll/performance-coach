import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as z from 'zod/mini';
import { addDays } from '../calendar';
import { validate } from '../validation';
import {
	customExerciseSchema,
	customMetricsSchema,
	decisionPlanSchema,
	exerciseRefSchema,
	otherDetailsSchema,
	PARTIAL_FIRST_WEEK,
	plannedExerciseSchema,
	programPlanSchema,
	runSegmentSchema,
	runSegmentsSchema,
	sessionPlanSchema,
	setPrescriptionSchema
} from './schemas';
import type {
	CustomExercise,
	CustomMetric,
	DecisionPlan,
	ExerciseRef,
	OtherDetails,
	OtherSessionPlan,
	PlannedExercisePlan,
	ProgramPlan,
	RunSegment,
	RunSessionPlan,
	SessionPlan,
	SetPrescription,
	StrengthSessionPlan,
	WeekPlan
} from './types';

const MONDAY = '2026-11-09';
const GOAL = 'a1b2c3d4-0000-4000-8000-000000000001';
const COMMITMENT = 'c0ffee00-0000-4000-8000-000000000002';
const CUSTOM_ROW = 'e0e0e0e0-0000-4000-8000-000000000003';

const set = (over: Partial<SetPrescription> = {}): SetPrescription => ({
	role: 'working',
	sets: 3,
	repsMin: 5,
	repsMax: 5,
	seconds: null,
	metres: null,
	targetRpe: null,
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

const exercise = (
	ref: ExerciseRef,
	sets: SetPrescription[],
	over: Partial<PlannedExercisePlan> = {}
): PlannedExercisePlan => ({
	exercise: ref,
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

const base = {
	timeOfDay: null,
	orderInDay: 1,
	customDiscipline: null,
	source: 'generator',
	commitmentRef: null,
	instructions: null,
	notes: null
} as const;

/**
 * A minimal hybrid plan: an interval run, a Muay Thai class (a commitment) and a full-body
 * strength session in a baseline week, then an outline accumulation block.
 */
function hybridPlan(): ProgramPlan {
	const intervals: RunSessionPlan = {
		...base,
		kind: 'run',
		date: MONDAY,
		timeOfDay: 'morning',
		type: 'interval_run',
		title: 'Intervals',
		discipline: 'running',
		intensity: 'hard',
		estMinutes: 45,
		estLoad: 315,
		targetRpe: 7,
		instructions: 'Even pace on every rep.',
		segments: [
			segment('warm_up', { durationSeconds: 600, targetRpe: 3 }),
			segment('interval', {
				repeatGroup: 1,
				repeats: 6,
				distanceMetres: 400,
				paceMinSecondsPerKm: 225,
				paceMaxSecondsPerKm: 240
			}),
			segment('recovery', { repeatGroup: 1, repeats: 6, durationSeconds: 90, targetRpe: 2 }),
			segment('cool_down', { durationSeconds: 600, hrZone: 2 })
		]
	};
	const muayThai: OtherSessionPlan = {
		...base,
		kind: 'other',
		date: addDays(MONDAY, 1),
		timeOfDay: 'evening',
		type: 'muay_thai',
		title: 'Muay Thai class',
		discipline: 'muay_thai',
		intensity: 'hard',
		estMinutes: 90,
		estLoad: 630,
		targetRpe: 7,
		source: 'commitment',
		commitmentRef: COMMITMENT,
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
	const strength: StrengthSessionPlan = {
		...base,
		kind: 'strength',
		date: addDays(MONDAY, 3),
		timeOfDay: 'evening',
		type: 'strength',
		title: 'Full body A',
		discipline: 'strength',
		intensity: 'moderate',
		estMinutes: 60,
		estLoad: 420,
		targetRpe: 7,
		exercises: [
			exercise(
				{ key: 'back_squat' },
				[
					set({ role: 'top', sets: 1, targetRpe: 7, restSeconds: 180 }),
					set({ role: 'back_off', sets: 2, loadKind: 'from_e1rm', loadValue: 0.72 })
				],
				{ baselineLift: 'back_squat', instructions: 'Record weight, reps and RPE for every set.' }
			),
			exercise(
				{ key: 'bench_press' },
				[
					set({
						loadKind: 'percent_1rm',
						loadValue: 0.7,
						loadBasis: 'measured',
						reference1rm: 100,
						reference1rmUnit: 'kg',
						targetRpe: 7,
						restSeconds: 180
					})
				],
				{ baselineLift: 'bench_press' }
			),
			exercise(
				{ customId: CUSTOM_ROW },
				[
					set({
						repsMin: 10,
						repsMax: 12,
						loadKind: 'absolute',
						loadValue: 30,
						loadUnit: 'kg',
						restSeconds: 90,
						tempo: '3010'
					})
				],
				{ superset: 1 }
			),
			exercise(
				{ key: 'plank' },
				[set({ repsMin: null, repsMax: null, seconds: 45, targetRpe: 7, restSeconds: 60 })],
				{ superset: 1 }
			)
		]
	};
	const week: WeekPlan = {
		kind: 'baseline',
		startsOn: MONDAY,
		endsOn: addDays(MONDAY, 6),
		targets: { rpeCap: 7, volumeFactor: 1, loadStep: 0, runVolumeFactor: 1 },
		sessions: [intervals, muayThai, strength]
	};
	const decision = (over: Partial<DecisionPlan>): DecisionPlan => ({
		kind: 'block_structure',
		ruleKey: 'blocks.default',
		summary: 'A baseline week, then three accumulation weeks',
		why: 'Week 1 finds your working weights before the load builds.',
		decidedBy: 'rules',
		refs: ['blocks.0', 'blocks.1'],
		evidence: { weeks: 4 },
		...over
	});
	return {
		title: 'First block',
		startsOn: MONDAY,
		firstPlannedDay: MONDAY,
		blocks: [
			{
				phase: 'baseline',
				name: 'Baseline week',
				startsOn: MONDAY,
				endsOn: addDays(MONDAY, 6),
				outline: false,
				goalRefs: [GOAL],
				progression: { rpeStepPerWeek: 0.5, rpeCap: 8.5 },
				weeks: [week]
			},
			{
				phase: 'accumulation',
				name: 'Accumulation',
				startsOn: addDays(MONDAY, 7),
				endsOn: addDays(MONDAY, 27),
				outline: true,
				goalRefs: [GOAL],
				progression: {},
				weeks: []
			}
		],
		decisions: [
			decision({}),
			decision({
				kind: 'load_basis',
				ruleKey: 'loads.unknown_1rm',
				summary: 'Back squat works up to a set of 5 @ RPE 7',
				why: 'Your squat 1RM is not known yet, so week 1 estimates it.',
				refs: ['blocks.0.weeks.0.sessions.2.exercises.0'],
				evidence: { squat1rmKnown: false, method: 'rpe-table' }
			}),
			decision({
				kind: 'commitment_placed',
				ruleKey: 'commitments.fixed',
				summary: 'Muay Thai stays on Tuesday evening',
				why: 'It is your class: everything else is planned around it.',
				refs: ['blocks.0.weeks.0.sessions.1'],
				evidence: {}
			})
		]
	};
}

const session = (plan: ProgramPlan, i: number) => plan.blocks[0]!.weeks[0]!.sessions[i]!;
const run = (plan: ProgramPlan) => session(plan, 0) as RunSessionPlan;
const muayThai = (plan: ProgramPlan) => session(plan, 1) as OtherSessionPlan;
const strength = (plan: ProgramPlan) => session(plan, 2) as StrengthSessionPlan;
const sets = (plan: ProgramPlan, e: number) => strength(plan).exercises[e]!.sets;

/** The errors validate() reports for `input`, or a test failure when it passes. */
function errorsOf(schema: z.ZodMiniType, input: unknown) {
	const result = validate(schema, input);
	if (result.ok) throw new Error('expected the input to be refused');
	return result.errors;
}

const W = 'blocks.0.weeks.0';
const EX = `${W}.sessions.2.exercises`;
const SEG = `${W}.sessions.0.segments`;
const DETAILS = `${W}.sessions.1.details`;

/** [what is wrong, the change, every path that reports it]. */
type Case = [string, (plan: ProgramPlan) => void, string[]];

const prescriptionCases: Case[] = [
	[
		'from_e1rm without a fraction',
		(p) => void (sets(p, 0)[1]!.loadValue = null),
		[`${EX}.0.sets.1.loadValue`]
	],
	[
		'from_e1rm above 100 %',
		(p) => void (sets(p, 0)[1]!.loadValue = 1.1),
		[`${EX}.0.sets.1.loadValue`]
	],
	[
		'percent_1rm below 30 %',
		(p) => void (sets(p, 1)[0]!.loadValue = 0.2),
		[`${EX}.1.sets.0.loadValue`]
	],
	[
		'percent_1rm without a basis',
		(p) => void (sets(p, 1)[0]!.loadBasis = null),
		[`${EX}.1.sets.0.loadBasis`]
	],
	[
		'percent_1rm without a 1RM snapshot',
		(p) => void (sets(p, 1)[0]!.reference1rm = null),
		[`${EX}.1.sets.0.reference1rm`]
	],
	[
		'percent_1rm without the snapshot unit',
		(p) => void (sets(p, 1)[0]!.reference1rmUnit = null),
		[`${EX}.1.sets.0.reference1rmUnit`]
	],
	[
		'a 1RM snapshot out of range',
		(p) => void (sets(p, 1)[0]!.reference1rm = 900),
		[`${EX}.1.sets.0.reference1rm`]
	],
	[
		'absolute without a unit',
		(p) => void (sets(p, 2)[0]!.loadUnit = null),
		[`${EX}.2.sets.0.loadUnit`]
	],
	[
		'absolute without a weight',
		(p) => void (sets(p, 2)[0]!.loadValue = null),
		[`${EX}.2.sets.0.loadValue`]
	],
	[
		'absolute out of the weight range',
		(p) => void (sets(p, 2)[0]!.loadValue = 600),
		[`${EX}.2.sets.0.loadValue`]
	],
	[
		'rpe_based without a target RPE',
		(p) => void (sets(p, 0)[0]!.targetRpe = null),
		[`${EX}.0.sets.0.targetRpe`]
	],
	[
		'rpe_based with a load',
		(p) => void (sets(p, 0)[0]!.loadValue = 100),
		[`${EX}.0.sets.0.loadValue`]
	],
	[
		'absolute with a basis',
		(p) => void (sets(p, 2)[0]!.loadBasis = 'measured'),
		[`${EX}.2.sets.0.loadBasis`]
	],
	[
		'from_e1rm with a unit',
		(p) => void (sets(p, 0)[1]!.loadUnit = 'kg'),
		[`${EX}.0.sets.1.loadUnit`]
	],
	['0 sets', (p) => void (sets(p, 0)[0]!.sets = 0), [`${EX}.0.sets.0.sets`]],
	['21 sets', (p) => void (sets(p, 0)[0]!.sets = 21), [`${EX}.0.sets.0.sets`]],
	['RPE 11', (p) => void (sets(p, 0)[0]!.targetRpe = 11), [`${EX}.0.sets.0.targetRpe`]],
	['RPE 4.5', (p) => void (sets(p, 0)[0]!.targetRpe = 4.5), [`${EX}.0.sets.0.targetRpe`]],
	[
		'RPE off the half steps',
		(p) => void (sets(p, 0)[0]!.targetRpe = 7.25),
		[`${EX}.0.sets.0.targetRpe`]
	],
	[
		'no measure',
		(p) => void Object.assign(sets(p, 0)[0]!, { repsMin: null, repsMax: null }),
		[`${EX}.0.sets.0.repsMin`]
	],
	['reps and seconds', (p) => void (sets(p, 0)[0]!.seconds = 30), [`${EX}.0.sets.0.seconds`]],
	['seconds and metres', (p) => void (sets(p, 3)[0]!.metres = 20), [`${EX}.3.sets.0.metres`]],
	['reps high to low', (p) => void (sets(p, 2)[0]!.repsMin = 15), [`${EX}.2.sets.0.repsMax`]],
	['half a rep range', (p) => void (sets(p, 2)[0]!.repsMax = null), [`${EX}.2.sets.0.repsMax`]],
	[
		'rest over 15 minutes',
		(p) => void (sets(p, 0)[0]!.restSeconds = 901),
		[`${EX}.0.sets.0.restSeconds`]
	],
	['negative rest', (p) => void (sets(p, 0)[0]!.restSeconds = -1), [`${EX}.0.sets.0.restSeconds`]],
	[
		'a tempo that is not one',
		(p) => void (sets(p, 2)[0]!.tempo = 'slow'),
		[`${EX}.2.sets.0.tempo`]
	],
	[
		'an unknown set role',
		(p) => void ((sets(p, 0)[0] as { role: string }).role = 'drop'),
		[`${EX}.0.sets.0.role`]
	],
	[
		'percentages with no baseline lift',
		(p) => void (strength(p).exercises[1]!.baselineLift = null),
		[`${EX}.1.baselineLift`]
	],
	[
		'a substitution with no reason',
		(p) => void (strength(p).exercises[2]!.substitutedFrom = { key: 'barbell_row' }),
		[`${EX}.2.substitutionReason`]
	],
	['an exercise with no sets', (p) => void (strength(p).exercises[0]!.sets = []), [`${EX}.0.sets`]],
	[
		'a malformed catalogue key',
		(p) => void (strength(p).exercises[0]!.exercise = { key: 'Back Squat' }),
		[`${EX}.0.exercise.key`]
	],
	[
		'both a key and a custom id',
		(p) =>
			void (strength(p).exercises[0]!.exercise = {
				key: 'back_squat',
				customId: CUSTOM_ROW
			} as ExerciseRef),
		[`${EX}.0.exercise`]
	],
	['a superset of 11', (p) => void (strength(p).exercises[2]!.superset = 11), [`${EX}.2.superset`]]
];

const runAndOtherCases: Case[] = [
	[
		'a segment with neither distance nor duration',
		(p) => void (run(p).segments[0]!.durationSeconds = null),
		[`${SEG}.0.distanceMetres`]
	],
	[
		'repeats with no group',
		(p) => void (run(p).segments[3]!.repeats = 4),
		[`${SEG}.3.repeatGroup`]
	],
	[
		'a group with no repeats',
		(p) => void (run(p).segments[3]!.repeatGroup = 2),
		[`${SEG}.3.repeats`]
	],
	[
		'a group split by another segment',
		(p) => void run(p).segments.splice(2, 0, segment('steady', { durationSeconds: 60 })),
		[`${SEG}.3.repeatGroup`]
	],
	[
		'a group repeating unevenly',
		(p) => void (run(p).segments[2]!.repeats = 5),
		[`${SEG}.2.repeats`]
	],
	[
		'a pace range slow to fast',
		(p) => void (run(p).segments[1]!.paceMinSecondsPerKm = 250),
		[`${SEG}.1.paceMaxSecondsPerKm`]
	],
	[
		'half a pace range',
		(p) => void (run(p).segments[1]!.paceMaxSecondsPerKm = null),
		[`${SEG}.1.paceMaxSecondsPerKm`]
	],
	[
		'heart-rate zone 6',
		(p) => void ((run(p).segments[3] as { hrZone: number }).hrZone = 6),
		[`${SEG}.3.hrZone`]
	],
	['a run with no segments', (p) => void (run(p).segments = []), [`${SEG}`]],
	[
		'a metric listed twice',
		(p) => void (muayThai(p).details.metrics[1]!.key = 'rounds'),
		[`${DETAILS}.metrics.1.key`]
	],
	[
		'a metric key that is not a slug',
		(p) => void (muayThai(p).details.metrics[0]!.key = 'Rounds'),
		[`${DETAILS}.metrics.0.key`]
	],
	[
		'a metric label over 40 characters',
		(p) => void (muayThai(p).details.metrics[0]!.label = 'x'.repeat(41)),
		[`${DETAILS}.metrics.0.label`]
	],
	[
		'a metric unit over 12 characters',
		(p) => void (muayThai(p).details.metrics[1]!.unit = 'x'.repeat(13)),
		[`${DETAILS}.metrics.1.unit`]
	],
	[
		'a text metric over 80 characters',
		(p) => void (muayThai(p).details.metrics[3]!.value = 'x'.repeat(81)),
		[`${DETAILS}.metrics.3.value`]
	],
	[
		'a metric that is an object',
		(p) => void ((muayThai(p).details.metrics[0] as { value: unknown }).value = { n: 6 }),
		[`${DETAILS}.metrics.0.value`]
	],
	[
		'21 metrics',
		(p) =>
			void (muayThai(p).details.metrics = Array.from({ length: 21 }, (_, i): CustomMetric => ({
				key: `m${i}`,
				label: 'M',
				unit: null,
				value: i
			}))),
		[`${DETAILS}.metrics`]
	],
	[
		'a 5-minute class',
		(p) => void (muayThai(p).details.durationMinutes = 5),
		[`${DETAILS}.durationMinutes`]
	]
];

const sessionCases: Case[] = [
	[
		'a commitment session without its commitment',
		(p) => void (muayThai(p).commitmentRef = null),
		[`${W}.sessions.1.commitmentRef`]
	],
	[
		'a generated session naming a commitment',
		(p) => void (run(p).commitmentRef = COMMITMENT),
		[`${W}.sessions.0.commitmentRef`]
	],
	[
		'a custom discipline with no name',
		(p) => void (strength(p).discipline = 'custom'),
		[`${W}.sessions.2.customDiscipline`]
	],
	[
		'an unknown session kind',
		(p) => void ((run(p) as { kind: string }).kind = 'swim'),
		[`${W}.sessions.0.kind`]
	],
	[
		'a strength session with no exercises',
		(p) => void (strength(p).exercises = []),
		[`${W}.sessions.2.exercises`]
	],
	[
		'a session outside its week',
		(p) => void (strength(p).date = addDays(MONDAY, 7)),
		[`${W}.sessions.2.date`]
	],
	[
		'two sessions in one place in the day',
		(p) => void (muayThai(p).date = MONDAY),
		[`${W}.sessions.1.orderInDay`]
	],
	[
		'a session before the first planned day',
		(p) => void (p.firstPlannedDay = addDays(MONDAY, 1)),
		[`${W}.sessions.0.date`]
	],
	['a session RPE of 0', (p) => void (run(p).targetRpe = 0), [`${W}.sessions.0.targetRpe`]]
];

/** A second planned block after the outline one: one week with nothing in it. */
const plannedAfterOutline = (p: ProgramPlan) => {
	const startsOn = addDays(MONDAY, 28);
	const week = { ...p.blocks[0]!.weeks[0]!, startsOn, endsOn: addDays(startsOn, 6), sessions: [] };
	p.blocks.push({ ...p.blocks[0]!, startsOn, endsOn: addDays(startsOn, 6), weeks: [week] });
};

/** The outline block's three weeks, the first holding a session. */
const outlineWeekWithSession = (p: ProgramPlan) => {
	const block = p.blocks[1]!;
	block.weeks = [0, 1, 2].map((w): WeekPlan => ({
		...p.blocks[0]!.weeks[0]!,
		kind: 'accumulation',
		startsOn: addDays(block.startsOn, 7 * w),
		endsOn: addDays(block.startsOn, 7 * w + 6),
		sessions: []
	}));
	block.weeks[0]!.sessions = [{ ...run(p), date: block.startsOn }];
};

const planCases: Case[] = [
	[
		'a start that is not a Monday',
		(p) => void (p.startsOn = addDays(MONDAY, 1)),
		['startsOn', 'firstPlannedDay', 'blocks.0.startsOn']
	],
	[
		'a first planned day before the start',
		(p) => void (p.firstPlannedDay = addDays(MONDAY, -1)),
		['firstPlannedDay']
	],
	[
		'a first planned day after week 1',
		(p) => void (p.firstPlannedDay = addDays(MONDAY, 7)),
		['firstPlannedDay', `${W}.sessions.0.date`, `${W}.sessions.1.date`, `${W}.sessions.2.date`]
	],
	['a plan with no blocks', (p) => void ((p.blocks = []), (p.decisions = [])), ['blocks']],
	[
		'a gap between blocks',
		(p) => void (p.blocks[1]!.startsOn = addDays(MONDAY, 14)),
		['blocks.1.startsOn']
	],
	[
		'a block ending on a Saturday',
		(p) => void (p.blocks[1]!.endsOn = addDays(MONDAY, 26)),
		['blocks.1.endsOn']
	],
	[
		'an outline first block',
		(p) => void (p.blocks[0]!.outline = true),
		['blocks.0.outline', `${W}.sessions`]
	],
	['a planned block after the outline', plannedAfterOutline, ['blocks.2.outline']],
	['a planned block with no weeks', (p) => void (p.blocks[1]!.outline = false), ['blocks.1.weeks']],
	[
		'weeks that do not fill their block',
		(p) =>
			void ((p.blocks[0]!.endsOn = addDays(MONDAY, 13)),
			(p.blocks[1]!.startsOn = addDays(MONDAY, 14))),
		['blocks.0.weeks']
	],
	[
		'a week starting on the wrong day',
		(p) => void (p.blocks[0]!.weeks[0]!.startsOn = addDays(MONDAY, 1)),
		[`${W}.startsOn`, `${W}.endsOn`, `${W}.sessions.0.date`]
	],
	[
		'a week ending on the wrong day',
		(p) => void (p.blocks[0]!.weeks[0]!.endsOn = addDays(MONDAY, 7)),
		[`${W}.endsOn`]
	],
	['an outline week with a session', outlineWeekWithSession, ['blocks.1.weeks.0.sessions']],
	[
		'a week RPE cap of 4',
		(p) => void (p.blocks[0]!.weeks[0]!.targets.rpeCap = 4),
		[`${W}.targets.rpeCap`]
	],
	[
		'a goal ref that is not a uuid',
		(p) => void (p.blocks[0]!.goalRefs = ['goal-1']),
		['blocks.0.goalRefs.0']
	],
	[
		'a goal served twice',
		(p) => void (p.blocks[0]!.goalRefs = [GOAL, GOAL]),
		['blocks.0.goalRefs']
	],
	[
		'a progression value that is not a number',
		(p) => void ((p.blocks[0]!.progression as Record<string, unknown>).rpeCap = 'high'),
		['blocks.0.progression.rpeCap']
	],
	[
		'a decision about a session that does not exist',
		(p) => void (p.decisions[2]!.refs = [`${W}.sessions.9`]),
		['decisions.2.refs.0']
	],
	[
		'a decision about an exercise of a run',
		(p) => void (p.decisions[2]!.refs = [`${W}.sessions.0.exercises.0`]),
		['decisions.2.refs.0']
	],
	[
		'a decision about a block that does not exist',
		(p) => void (p.decisions[0]!.refs = ['blocks.0', 'blocks.2']),
		['decisions.0.refs.1']
	],
	[
		'a ref that is not a plan path',
		(p) => void (p.decisions[0]!.refs = ['weeks.0']),
		['decisions.0.refs.0']
	],
	[
		'a ref with a leading zero',
		(p) => void (p.decisions[0]!.refs = ['blocks.01']),
		['decisions.0.refs.0']
	],
	['a decision with no why', (p) => void (p.decisions[0]!.why = '  '), ['decisions.0.why']],
	[
		'an unknown decision kind',
		(p) => void ((p.decisions[0] as { kind: string }).kind = 'vibes'),
		['decisions.0.kind']
	],
	[
		'a rule key that is not dotted snake_case',
		(p) => void (p.decisions[0]!.ruleKey = 'Blocks Default'),
		['decisions.0.ruleKey']
	],
	[
		'an evidence name that is not camelCase',
		(p) => void (p.decisions[0]!.evidence = { 'squat 1rm': 180 }),
		['decisions.0.evidence.squat 1rm']
	]
];

describe('programPlanSchema', () => {
	it('passes the minimal hybrid plan unchanged', () => {
		const plan = hybridPlan();
		expect(validate(programPlanSchema, plan)).toEqual({ ok: true, data: plan });
	});

	it("passes a 'This week' start whose week 1 begins mid-week", () => {
		expect(PARTIAL_FIRST_WEEK).toBe(true);
		const plan = hybridPlan();
		plan.firstPlannedDay = addDays(MONDAY, 1);
		plan.blocks[0]!.weeks[0]!.sessions.shift();
		plan.decisions[1]!.refs = ['blocks.0.weeks.0.sessions.1.exercises.0'];
		plan.decisions[2]!.refs = ['blocks.0.weeks.0.sessions.0'];
		expect(validate(programPlanSchema, plan).ok).toBe(true);
	});

	it('trims text and refuses blank text', () => {
		const plan = hybridPlan();
		plan.title = '  First block  ';
		const result = validate(programPlanSchema, plan);
		expect(result.ok && result.data.title).toBe('First block');
		plan.title = ' ';
		expect(errorsOf(programPlanSchema, plan)).toEqual({ title: 'Required' });
	});

	describe.each([
		['set prescriptions and exercises', prescriptionCases],
		['run segments and other-session details', runAndOtherCases],
		['sessions', sessionCases],
		['blocks, weeks and decisions', planCases]
	])('refuses, at the dotted path, bad %s:', (_, cases) => {
		it.each(cases)('%s', (_, change, paths) => {
			const plan = hybridPlan();
			change(plan);
			const errors = errorsOf(programPlanSchema, plan);
			expect(Object.keys(errors).sort()).toEqual([...paths].sort());
		});
	});

	it('reports owner-readable messages', () => {
		const plan = hybridPlan();
		sets(plan, 1)[0]!.loadBasis = null;
		sets(plan, 0)[1]!.loadValue = 1.5;
		expect(errorsOf(programPlanSchema, plan)).toEqual({
			[`${EX}.1.sets.0.loadBasis`]: 'Is the 1RM measured or estimated?',
			[`${EX}.0.sets.1.loadValue`]: 'Between 30 % and 100 % of a 1RM'
		});
	});
});

describe('the part schemas, as edits use them', () => {
	it('validate one prescription with paths relative to it', () => {
		const prescription = set({ loadKind: 'absolute', loadValue: 60, loadUnit: 'lb' });
		expect(validate(setPrescriptionSchema, prescription)).toEqual({ ok: true, data: prescription });
		expect(errorsOf(setPrescriptionSchema, { ...prescription, loadUnit: null })).toEqual({
			loadUnit: 'Pick kg or lb'
		});
		expect(errorsOf(setPrescriptionSchema, { ...prescription, loadValue: 1 })).toEqual({
			loadValue: 'Between 2 and 1100 lb'
		});
	});

	it('validate one run segment, and a run’s segments together', () => {
		const rep = segment('interval', { repeatGroup: 1, repeats: 6, distanceMetres: 400 });
		expect(validate(runSegmentSchema, rep).ok).toBe(true);
		expect(errorsOf(runSegmentSchema, { ...rep, distanceMetres: null })).toEqual({
			distanceMetres: 'Give a distance or a duration'
		});
		expect(errorsOf(runSegmentsSchema, [rep, { ...rep, repeats: 8 }])).toEqual({
			'1.repeats': 'A repeat group’s segments repeat alike'
		});
	});

	it('validate other-session details and their metrics', () => {
		const details: OtherDetails = {
			kind: 'technical',
			durationMinutes: 60,
			targetRpe: 6,
			metrics: [],
			notes: null
		};
		expect(validate(otherDetailsSchema, details)).toEqual({ ok: true, data: details });
		const twice = [
			{ key: 'rounds', label: 'Rounds', unit: null, value: 5 },
			{ key: 'rounds', label: 'Rounds again', unit: null, value: true }
		];
		expect(errorsOf(customMetricsSchema, twice)).toEqual({ '1.key': 'Each metric once' });
	});

	it('take an exercise by catalogue key or by custom id, never both', () => {
		expect(validate(exerciseRefSchema, { key: 'back_squat' }).ok).toBe(true);
		expect(validate(exerciseRefSchema, { customId: CUSTOM_ROW }).ok).toBe(true);
		expect(validate(exerciseRefSchema, {}).ok).toBe(false);
		expect(validate(exerciseRefSchema, { customId: 'row' }).ok).toBe(false);
	});
});

describe('customExerciseSchema', () => {
	const minimal = {
		name: 'Landmine press',
		pattern: 'vertical_push',
		primaryMuscles: ['front_delts'],
		measure: 'reps',
		loadType: 'external'
	};

	it('fills what the owner did not say with plain defaults', () => {
		expect(validate(customExerciseSchema, minimal)).toEqual({
			ok: true,
			data: {
				...minimal,
				aliases: [],
				secondaryMuscles: [],
				equipment: [],
				substitutionGroup: null,
				skillLevel: 'beginner',
				repMin: null,
				repMax: null,
				defaultSeconds: null,
				unilateral: false,
				tags: [],
				disciplines: []
			}
		});
	});

	it.each([
		['no primary muscle', { primaryMuscles: [] }, 'primaryMuscles'],
		[
			'a muscle both primary and secondary',
			{ secondaryMuscles: ['front_delts'] },
			'secondaryMuscles'
		],
		['an alias listed twice', { aliases: ['Landmine', 'Landmine'] }, 'aliases'],
		[
			'reps on a timed exercise',
			{ measure: 'time', repMin: 8, repMax: 8, defaultSeconds: 30 },
			'repMin'
		],
		['half a rep range', { repMin: 8 }, 'repMax'],
		['reps high to low', { repMin: 12, repMax: 8 }, 'repMax'],
		['seconds on a reps exercise', { defaultSeconds: 30 }, 'defaultSeconds'],
		['a timed exercise without seconds', { measure: 'time' }, 'defaultSeconds'],
		['a group that is not a key', { substitutionGroup: 'Vertical push' }, 'substitutionGroup'],
		['a blank name', { name: '  ' }, 'name']
	])('refuses %s', (_, change, path) => {
		expect(Object.keys(errorsOf(customExerciseSchema, { ...minimal, ...change }))).toEqual([path]);
	});
});

describe('the schemas and the contract types', () => {
	it('agree: each part of the plan passes its own schema, whose type is exactly the part’s', () => {
		const plan = hybridPlan();
		const parts: [z.ZodMiniType, unknown][] = [
			[sessionPlanSchema, strength(plan)],
			[plannedExerciseSchema, strength(plan).exercises[0]],
			[setPrescriptionSchema, sets(plan, 1)[0]],
			[runSegmentSchema, run(plan).segments[1]],
			[runSegmentsSchema, run(plan).segments],
			[otherDetailsSchema, muayThai(plan).details],
			[customMetricsSchema, muayThai(plan).details.metrics],
			[exerciseRefSchema, strength(plan).exercises[2]!.exercise],
			[decisionPlanSchema, plan.decisions[1]]
		];
		for (const [schema, part] of parts)
			expect(validate(schema, part)).toEqual({ ok: true, data: part });

		// Compile-time: pnpm check fails when a schema and its type drift apart.
		type Out<S extends z.ZodMiniType> = z.output<S>;
		expectTypeOf<Out<typeof programPlanSchema>>().toEqualTypeOf<ProgramPlan>();
		expectTypeOf<z.input<typeof programPlanSchema>>().toEqualTypeOf<ProgramPlan>();
		expectTypeOf<Out<typeof sessionPlanSchema>>().toEqualTypeOf<SessionPlan>();
		expectTypeOf<Out<typeof plannedExerciseSchema>>().toEqualTypeOf<PlannedExercisePlan>();
		expectTypeOf<Out<typeof setPrescriptionSchema>>().toEqualTypeOf<SetPrescription>();
		expectTypeOf<Out<typeof runSegmentSchema>>().toEqualTypeOf<RunSegment>();
		expectTypeOf<Out<typeof otherDetailsSchema>>().toEqualTypeOf<OtherDetails>();
		expectTypeOf<Out<typeof customMetricsSchema>>().toEqualTypeOf<CustomMetric[]>();
		expectTypeOf<Out<typeof exerciseRefSchema>>().toEqualTypeOf<ExerciseRef>();
		expectTypeOf<Out<typeof decisionPlanSchema>>().toEqualTypeOf<DecisionPlan>();
		// The catalogue's fields without key and lift; the catalogue's lists are read-only.
		expectTypeOf<Out<typeof customExerciseSchema>>().toExtend<CustomExercise>();
		expectTypeOf<keyof Out<typeof customExerciseSchema>>().toEqualTypeOf<keyof CustomExercise>();
	});
});
