/**
 * timefit.ts and the timefit stage: a session's minutes are its warm-up plus each set's work and
 * rest; an over-long strength session loses accessories first, then back-off sets, never a top
 * set, and says so; other sessions and runs are shortened to the session length, while long runs
 * and commitments are left as they are; sessions trimmed alike share one decision, whose account
 * of a hard cut is clipped to what a decision may hold.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import { WEEKDAYS } from '../profile/catalog';
import type {
	OtherSessionPlan,
	PlannedExercisePlan,
	RunSessionPlan,
	SessionPlan,
	SetPrescription,
	StrengthSessionPlan,
	WeekPlan
} from '../training/types';
import { programPlanSchema } from '../training/schemas';
import { validate } from '../validation';
import { DecisionLog } from './decisions';
import { generateProgram } from './generate';
import { buildProgrammingInput } from './input';
import { SCENARIO_START, SCENARIOS } from './scenarios';
import type { Draft } from './stage';
import { timefit } from './stages/timefit';
import { estimateMinutes, fitSession, fitWeek } from './timefit';

const input = buildProgrammingInput(SCENARIOS.minimal(), { catalogue: CATALOGUE });
const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };

function set(over: Partial<SetPrescription>): SetPrescription {
	return {
		role: 'working',
		sets: 3,
		repsMin: null,
		repsMax: null,
		seconds: null,
		metres: null,
		targetRpe: 7,
		loadKind: 'rpe_based',
		loadValue: null,
		loadUnit: null,
		loadBasis: null,
		reference1rm: null,
		reference1rmUnit: null,
		restSeconds: 60,
		tempo: null,
		notes: null,
		...over
	};
}

const exercise = (key: string, sets: SetPrescription[]): PlannedExercisePlan => ({
	exercise: { key },
	baselineLift: null,
	superset: null,
	substitutedFrom: null,
	substitutionReason: null,
	instructions: null,
	notes: null,
	sets
});

const base = {
	date: SCENARIO_START,
	timeOfDay: null,
	orderInDay: 1,
	discipline: 'strength',
	customDiscipline: null,
	intensity: 'moderate',
	estLoad: 0,
	targetRpe: 7,
	source: 'generator',
	commitmentRef: null,
	instructions: null,
	notes: null
} as const;

const strength = (exercises: PlannedExercisePlan[]): StrengthSessionPlan => ({
	...base,
	kind: 'strength',
	type: 'strength',
	title: 'Full body A',
	estMinutes: 0,
	exercises
});

/** A main lift: a top set of 5 and three back-offs, each with 150 s rest (170 s a set). */
const main = (key: string) =>
	exercise(key, [
		set({ role: 'top', sets: 1, repsMin: 5, repsMax: 5, restSeconds: 150 }),
		set({ role: 'back_off', sets: 3, repsMin: 5, repsMax: 5, restSeconds: 150 })
	]);

/** 59 minutes: two main lifts, two secondaries, then two accessories. */
const LONG = strength([
	main('back_squat'),
	main('bench_press'),
	exercise('seated_cable_row', [set({ repsMin: 8, repsMax: 8, restSeconds: 90 })]),
	exercise('split_squat', [set({ repsMin: 8, repsMax: 8, restSeconds: 90 })]),
	exercise('plank', [set({ seconds: 45 })]),
	exercise('face_pull', [set({ repsMin: 12, repsMax: 20 })])
]);

const keys = (s: StrengthSessionPlan) =>
	s.exercises.map((e) => ('key' in e.exercise ? e.exercise.key : ''));
const backOffs = (s: StrengthSessionPlan, key: string) =>
	s.exercises
		.find((e) => 'key' in e.exercise && e.exercise.key === key)
		?.sets.filter((l) => l.role === 'back_off')
		.reduce((n, l) => n + l.sets, 0);
const tops = (s: StrengthSessionPlan) =>
	s.exercises.flatMap((e) => e.sets.filter((l) => l.role === 'top'));

describe('estimateMinutes', () => {
	it('adds the warm-up and each set’s work and rest, a unilateral set done per side', () => {
		const session = strength([
			// (5 × 4 s + 180) + 2 × (5 × 4 s + 120) = 480 s
			exercise('back_squat', [
				set({ role: 'top', sets: 1, repsMin: 5, repsMax: 5, restSeconds: 180 }),
				set({ role: 'back_off', sets: 2, repsMin: 5, repsMax: 5, restSeconds: 120 })
			]),
			// 2 × (10 reps × 4 s × 2 sides + 60) = 280 s; the range's top end counts
			exercise('split_squat', [set({ sets: 2, repsMin: 6, repsMax: 10, restSeconds: 60 })]),
			// 2 × (30 + 30) = 120 s
			exercise('plank', [set({ sets: 2, seconds: 30, restSeconds: 30 })]),
			// 40 m at 1 s a metre, no rest
			exercise('farmers_carry', [set({ sets: 1, metres: 40, restSeconds: null })])
		]);
		// 600 s of warm-up + 920 s = 1520 s, rounded up to 26 min
		expect(estimateMinutes(session, input)).toBe(26);
		expect(estimateMinutes(strength([]), input)).toBe(10);
		expect(estimateMinutes(LONG, input)).toBe(59);
	});
});

describe('fitSession', () => {
	it('fits a 45-minute session by losing accessories first, then back-offs, never a top set', () => {
		const { session, estimate, after, trimmed } = fitSession(LONG, input, 45);
		expect([estimate, after]).toEqual([59, 44]);
		expect(estimateMinutes(session, input)).toBeLessThanOrEqual(45);
		expect(keys(session)).toEqual(['back_squat', 'bench_press', 'seated_cable_row', 'split_squat']);
		expect([backOffs(session, 'back_squat'), backOffs(session, 'bench_press')]).toEqual([3, 2]);
		expect(tops(session)).toHaveLength(2);
		expect(trimmed).toBe(
			'Face pull and Plank came out, and 1 back-off set came off Bench press; every top set stays'
		);
		expect(session).toMatchObject({ estMinutes: 44, estLoad: 44 * 7 });
		// The session it was given is left as it was.
		expect(keys(LONG)).toHaveLength(6);
		expect(backOffs(LONG, 'bench_press')).toBe(3);
	});

	it('takes every back-off before any other exercise, then the others, last first', () => {
		const { session, after, trimmed } = fitSession(LONG, input, 20);
		expect(keys(session)).toEqual(['back_squat', 'bench_press']);
		expect(session.exercises.flatMap((e) => e.sets.map((l) => l.role))).toEqual(['top', 'top']);
		expect(after).toBe(16);
		expect(trimmed).toBe(
			'Face pull, Plank, Split squat and Seated cable row came out, and 6 back-off sets came off Bench press and Back squat; every top set stays'
		);
	});

	it('keeps the top sets even when they alone run over, and says how long it still takes', () => {
		const { session, after } = fitSession(LONG, input, 10);
		expect(tops(session)).toHaveLength(2);
		expect(after).toBe(16);
	});

	it('leaves a session that fits as it is, with its estimate brought up to date', () => {
		const { session, trimmed, estimate, after } = fitSession(LONG, input, 90);
		expect(trimmed).toBeNull();
		expect([estimate, after]).toEqual([59, 59]);
		expect(session).toEqual({ ...LONG, estMinutes: 59, estLoad: 59 * 7 });
	});
});

const other = (over: Partial<OtherSessionPlan>): OtherSessionPlan => ({
	...base,
	kind: 'other',
	type: 'mobility',
	discipline: 'athletic',
	title: 'Mobility',
	estMinutes: 90,
	details: { kind: 'mobility', durationMinutes: 90, targetRpe: 4, metrics: [], notes: null },
	...over
});

const run = (over: Partial<RunSessionPlan>): RunSessionPlan => ({
	...base,
	kind: 'run',
	type: 'easy_run',
	discipline: 'running',
	title: 'Easy run',
	estMinutes: 80,
	segments: [
		{
			kind: 'warm_up',
			repeatGroup: null,
			repeats: null,
			distanceMetres: null,
			durationSeconds: 600,
			paceMinSecondsPerKm: null,
			paceMaxSecondsPerKm: null,
			hrZone: null,
			targetRpe: 3
		},
		{
			kind: 'easy',
			repeatGroup: null,
			repeats: null,
			distanceMetres: 10_001,
			durationSeconds: null,
			paceMinSecondsPerKm: 330,
			paceMaxSecondsPerKm: 360,
			hrZone: 2,
			targetRpe: 4
		}
	],
	...over
});

const week = (sessions: SessionPlan[]): WeekPlan => ({
	kind: 'baseline',
	startsOn: SCENARIO_START,
	endsOn: '2026-11-15',
	targets: { rpeCap: 7, volumeFactor: 1, loadStep: 0, runVolumeFactor: 1 },
	sessions
});

describe('fitWeek', () => {
	const class90 = other({
		source: 'commitment',
		commitmentRef: '00000000-0000-4000-8000-000000000200',
		type: 'muay_thai',
		title: 'Muay Thai class',
		discipline: 'muay_thai'
	});
	const longRun = run({ type: 'long_run', title: 'Long run', estMinutes: 120 });

	it('leaves long runs and commitments as they are, and fits every other session', () => {
		const sessions = [class90, longRun, other({}), run({}), LONG];
		const { week: fitted, trims } = fitWeek(week(sessions), input);
		expect(fitted.sessions[0]).toBe(class90);
		expect(fitted.sessions[1]).toBe(longRun);
		expect(fitted.sessions[2]).toMatchObject({
			estMinutes: 60,
			estLoad: 60 * 7,
			details: { durationMinutes: 60 }
		});
		// 60 of 80 minutes: every part is three quarters as long, rounded down.
		const easy = fitted.sessions[3] as RunSessionPlan;
		expect(easy.estMinutes).toBe(60);
		expect(easy.segments.map((s) => [s.durationSeconds, s.distanceMetres])).toEqual([
			[450, null],
			[null, 7500]
		]);
		expect((fitted.sessions[4] as StrengthSessionPlan).estMinutes).toBe(59);
		expect(trims).toEqual([
			{
				index: 2,
				facts: { session: 'Mobility', minutes: 60, estimate: 90, after: 60, trimmed: 'it is cut' }
			},
			{
				index: 3,
				facts: {
					session: 'Easy run',
					minutes: 60,
					estimate: 80,
					after: 60,
					trimmed: 'every part of it is shortened alike'
				}
			}
		]);
	});

	it('leaves sessions that fit untouched', () => {
		const short = other({ estMinutes: 30, details: { ...other({}).details, durationMinutes: 30 } });
		const { week: fitted, trims } = fitWeek(week([short, run({ estMinutes: 45 })]), input);
		expect(fitted.sessions[0]).toBe(short);
		expect(trims).toEqual([]);
	});
});

describe('the timefit stage', () => {
	const context = () => ({ input, options: OPTIONS, log: new DecisionLog() });
	const draft = (weeks: WeekPlan[]): Draft => ({
		demand: null,
		blocks: [
			{
				phase: 'accumulation',
				name: 'Accumulation',
				startsOn: SCENARIO_START,
				endsOn: '2026-12-13',
				outline: false,
				goalRefs: [],
				progression: {},
				weeks
			}
		]
	});

	it('writes one time_trimmed decision for the sessions trimmed alike, naming each of them', () => {
		const ctx = context();
		const fitted = timefit(draft([week([other({}), LONG]), week([LONG, other({})])]), ctx);
		expect((fitted.blocks[0]!.weeks[1]!.sessions[1] as OtherSessionPlan).estMinutes).toBe(60);
		expect(ctx.log.list()).toEqual([
			expect.objectContaining({
				kind: 'time_trimmed',
				ruleKey: 'timefit.session_minutes',
				summary: 'Mobility trimmed to about 60 min',
				why: 'Mobility came to about 90 min, more than your 60-minute sessions allow, so it is cut. It now takes about 60 min.',
				refs: ['blocks.0.weeks.0.sessions.0', 'blocks.0.weeks.1.sessions.1']
			})
		]);
	});

	it('writes a trimmed strength session’s decision with what came out and its path', () => {
		const p = SCENARIOS.minimal();
		p.schedule.sessionMinutes = 45;
		const ctx = { ...context(), input: buildProgrammingInput(p, { catalogue: CATALOGUE }) };
		timefit(draft([week([run({ estMinutes: 30 }), LONG])]), ctx);
		expect(ctx.log.list()).toEqual([
			expect.objectContaining({
				kind: 'time_trimmed',
				refs: ['blocks.0.weeks.0.sessions.1'],
				evidence: {
					session: 'Full body A',
					minutes: 45,
					estimate: 59,
					after: 44,
					trimmed:
						'Face pull and Plank came out, and 1 back-off set came off Bench press; every top set stays'
				}
			})
		]);
	});

	it('keeps a hard cut’s account short enough for the plan the contract accepts', () => {
		const p = SCENARIOS.dumbbellsOnly();
		p.schedule = {
			...p.schedule,
			daysPerWeek: 4,
			availableDays: [...WEEKDAYS],
			sessionMinutes: 20
		};
		const plan = generateProgram(buildProgrammingInput(p, { catalogue: CATALOGUE }), OPTIONS);
		expect(validate(programPlanSchema, plan)).toEqual({ ok: true, data: plan });
		const trimmed = plan.decisions.flatMap((d) =>
			d.kind === 'time_trimmed' ? [String(d.evidence.trimmed)] : []
		);
		expect(trimmed.some((t) => t.endsWith('…'))).toBe(true);
	});

	it('splits a decision that would name more sessions than a decision may', () => {
		const ctx = context();
		const full = week(Array.from({ length: 21 }, () => other({})));
		timefit(draft([full, full, full]), ctx);
		expect(ctx.log.list().map((d) => d.refs.length)).toEqual([50, 13]);
	});

	it('writes nothing when every session fits', () => {
		const ctx = context();
		timefit(draft([week([LONG])]), ctx);
		expect(ctx.log.list()).toEqual([]);
	});
});
