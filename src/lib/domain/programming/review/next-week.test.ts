import { describe, expect, it } from 'vitest';
import { addDays } from '../../calendar';
import type { IsoDate } from '../../calendar';
import type { Exposure } from '../../analytics/prescribed';
import { PAYLOAD_SCHEMAS, programOpSchema } from '../../coach/proposals';
import type { ProgramOp } from '../../coach/proposals';
import { catalogueByKey } from '../../exercises/index';
import { adjustRunSegmentSchema, adjustSetSchema, moveSessionSchema } from '../../training/edits';
import { setPrescriptionSchema } from '../../training/schemas';
import type { RunSegment, SetPrescription } from '../../training/types';
import type { WeekKind } from '../../training/vocabulary';
import { validate } from '../../validation';
import { evaluateWeek } from '../evaluate/week';
import { checkWeek } from '../interference';
import { loadModel } from '../load/fatigue';
import type { ModelLogged } from '../load/fatigue';
import { fromPlanned } from '../load/systems';
import type { ReviewEvaluation } from './evaluation';
import {
	DELOAD_INSTEAD,
	LIGHT_RUNNING_KINDS,
	LIGHT_WEEK_KINDS,
	MAX_NEXT_WEEK_OPS,
	proposeNextWeek,
	stillAhead
} from './next-week';
import type { NextSession, NextWeek, NextWeekContext, NextWeekExercise } from './next-week';
import type { WeeklyReviewSnapshot } from './snapshot';

/** The reviewed week is Monday 2 Nov 2026; next week runs Monday 9 to Sunday 15 Nov. */
const REVIEWED = '2026-11-02';
const NEXT = '2026-11-09';
const day = (n: number) => addDays(NEXT, n);
let ids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

const line = (more: Partial<SetPrescription> = {}): SetPrescription => ({
	role: 'working',
	sets: 3,
	repsMin: 5,
	repsMax: 5,
	seconds: null,
	metres: null,
	targetRpe: 8,
	loadKind: 'absolute',
	loadValue: 100,
	loadUnit: 'kg',
	loadBasis: null,
	reference1rm: null,
	reference1rmUnit: null,
	restSeconds: null,
	tempo: null,
	notes: null,
	...more
});

const base = (date: IsoDate) => ({
	lineage: uuid(),
	status: 'planned' as const,
	date,
	timeOfDay: null,
	orderInDay: 1,
	discipline: 'strength' as const,
	customDiscipline: null,
	intensity: 'moderate' as const,
	estMinutes: 60,
	estLoad: 420,
	targetRpe: 7,
	source: 'generator' as const,
	commitmentRef: null,
	instructions: null,
	notes: null
});

type Planned = Extract<NextSession, { kind: 'strength' }>['exercises'][number];
const planned = (
	key: string,
	sets: SetPrescription[],
	baselineLift: Planned['baselineLift'] = null
): Planned => ({
	lineage: uuid(),
	exercise: { key },
	baselineLift,
	superset: null,
	substitutedFrom: null,
	substitutionReason: null,
	instructions: null,
	notes: null,
	sets
});

const strength = (date: IsoDate, exercises: Planned[], more: Partial<NextSession> = {}) =>
	({
		...base(date),
		kind: 'strength',
		type: 'strength',
		title: 'Upper',
		exercises,
		...more
	}) as NextSession;

const segment = (kind: RunSegment['kind'], distanceMetres: number): RunSegment => ({
	kind,
	repeatGroup: null,
	repeats: null,
	distanceMetres,
	durationSeconds: null,
	paceMinSecondsPerKm: null,
	paceMaxSecondsPerKm: null,
	hrZone: null,
	targetRpe: null
});

const run = (date: IsoDate, type: 'easy_run' | 'long_run', segments: RunSegment[]) =>
	({
		...base(date),
		discipline: 'running',
		kind: 'run',
		type,
		title: type === 'long_run' ? 'Long run' : 'Easy run',
		segments
	}) as NextSession;

const muayThai = (date: IsoDate) =>
	({
		...base(date),
		discipline: 'muay_thai',
		kind: 'other',
		type: 'muay_thai',
		title: 'Sparring',
		intensity: 'hard',
		source: 'commitment',
		details: { kind: 'sparring', durationMinutes: 60, targetRpe: 8, metrics: [], notes: null }
	}) as NextSession;

const week = (sessions: NextSession[], kind: WeekKind = 'accumulation'): NextWeek => ({
	startsOn: NEXT,
	state: 'planned',
	kind,
	sessions
});

const snapshot = (more: Partial<WeeklyReviewSnapshot> = {}): WeeklyReviewSnapshot => ({
	version: 1,
	weekStartsOn: REVIEWED,
	computedOn: NEXT,
	timeZone: 'America/Los_Angeles',
	analyticsVersion: 1,
	inputsDigest: '0123456789abcdef',
	adherence: { planned: 4, completed: 4, skipped: 0, missed: 0, pct: 100 },
	fatigue: { level: 'none', reasons: [] },
	next: { weekStartsOn: NEXT, state: 'planned', kind: 'accumulation' },
	noProposal: null,
	brief: { kind: 'weekly', from: REVIEWED, to: addDays(REVIEWED, 6), summary: '', findings: [] },
	...more
});
const HIGH = {
	fatigue: {
		level: 'high' as const,
		reasons: ['You have been sore (4 of 5)', 'You have slept 6 hours a night']
	}
};

/** One session of `exerciseId` on `date`, with every working set at `deviation` from target. */
const exposure = (exerciseId: string, date: IsoDate, deviation: number): Exposure => ({
	day: date,
	lineage: uuid(),
	exerciseId,
	substituted: false,
	sets: { prescribed: 3, completed: 3, extra: 0 },
	missedReps: 0,
	rpeDeviations: [deviation, deviation, deviation],
	rpeTargets: [8, 8, 8],
	meanRpeDeviation: deviation,
	topSet: null,
	kg: 100,
	hit: true
});
/** Three sessions in the reviewed week's last days, each about 1.5 RPE easier than prescribed. */
const easier = (exerciseId: string) =>
	[-12, -10, -8].map((n) => exposure(exerciseId, addDays(NEXT, n), -1.5));

const catalogue = (key: string): NextWeekExercise => catalogueByKey.get(key)!;
const EXERCISES = new Map(
	['bench_press', 'back_squat', 'push_up', 'plank'].map((k) => [k, catalogue(k)] as const)
);

const ctx = (more: Partial<NextWeekContext> = {}): NextWeekContext => ({
	today: NEXT,
	unit: 'kg',
	exercises: EXERCISES,
	workouts: [],
	sessionMinutes: 600,
	// Five minutes a set: enough to tell an added set from none.
	estimateMinutes: ({ exercises }) =>
		exercises.reduce((sum, e) => sum + e.sets.reduce((n, l) => n + l.sets * 5, 0), 0),
	running: null,
	...more
});

const fields = (op: ProgramOp) => {
	const {
		op: _kind,
		sessionLineage: _s,
		reason: _r,
		...rest
	} = op as ProgramOp & {
		reason?: string;
	};
	return rest;
};

describe('proposeNextWeek: strength', () => {
	it('adds 2.5 % to a lift below target in all 3 sessions, with its why and a 1.25 kg half step', () => {
		const bench = planned('bench_press', [line()], 'bench_press');
		const session = strength(day(1), [bench]);
		const out = proposeNextWeek(week([session]), snapshot(), easier('bench_press'), ctx());

		expect(out.notProposed).toEqual([]);
		const [a] = out.adjustments;
		expect(out.adjustments).toHaveLength(1);
		expect(a).toMatchObject({
			kind: 'load',
			lineage: bench.lineage,
			sessionDate: day(1),
			before: { loadValue: 100 },
			after: { loadValue: 102.5 },
			significant: false
		});
		expect(a!.op).toEqual(a!.options.proposed);
		expect(a!.op).toMatchObject({
			op: 'adjust_set',
			sessionLineage: session.lineage,
			plannedExerciseLineage: bench.lineage,
			position: 1,
			loadValue: 102.5
		});
		expect(a!.why).toContain('easier than prescribed in 3 of the last 3 sessions');
		expect((a!.op as { reason: string }).reason).toBe(a!.why);
		expect(a!.options.half_step).toMatchObject({ op: 'adjust_set', loadValue: 101.25 });
	});

	it("moves each load in the line's own kind: a share of a 1RM, or an RPE", () => {
		const share = line({
			loadKind: 'percent_1rm',
			loadValue: 0.7,
			loadUnit: null,
			loadBasis: 'measured',
			reference1rm: 140,
			reference1rmUnit: 'kg'
		});
		const byRpe = line({ loadKind: 'rpe_based', loadValue: null, loadUnit: null, targetRpe: 7 });
		const bench = planned('bench_press', [share, byRpe], 'bench_press');
		const out = proposeNextWeek(
			week([strength(day(1), [bench])]),
			snapshot(),
			easier('bench_press'),
			ctx()
		);

		expect(out.adjustments.map((a) => [a.kind, a.before, a.after])).toEqual([
			['load', { loadValue: 0.7 }, { loadValue: 0.7143 }],
			['rpe', { targetRpe: 7 }, { targetRpe: 7.5 }]
		]);
	});

	/** A main slot M3 fills without a baseline lift (hypertrophy's barbell row). */
	const row = (sets: SetPrescription[]) => planned('barbell_row', sets, null);

	it('deloads only the main lifts when fatigue is high on a normal week', () => {
		const bench = planned(
			'bench_press',
			[line({ role: 'top', sets: 1 }), line({ role: 'back_off', sets: 4 })],
			'bench_press'
		);
		const rows = row([line({ role: 'top', sets: 1 }), line({ role: 'back_off', sets: 4 })]);
		const pushUps = planned('push_up', [
			line({ loadKind: 'rpe_based', loadValue: null, loadUnit: null, sets: 3, targetRpe: 8 })
		]);
		const exposures = [...easier('bench_press'), ...easier('push_up')];
		const out = proposeNextWeek(
			week([strength(day(1), [bench, pushUps]), strength(day(2), [rows])]),
			snapshot(HIGH),
			exposures,
			ctx()
		);

		expect(out.adjustments.map((a) => [a.kind, a.lineage, fields(a.op)])).toEqual([
			[
				'deload',
				bench.lineage,
				{ plannedExerciseLineage: bench.lineage, position: 1, targetRpe: 6 }
			],
			[
				'deload',
				bench.lineage,
				{ plannedExerciseLineage: bench.lineage, position: 2, sets: 2, targetRpe: 6 }
			],
			['deload', rows.lineage, { plannedExerciseLineage: rows.lineage, position: 1, targetRpe: 6 }],
			[
				'deload',
				rows.lineage,
				{ plannedExerciseLineage: rows.lineage, position: 2, sets: 2, targetRpe: 6 }
			]
		]);
		expect(out.adjustments[1]!.options.half_step).toMatchObject({ sets: 3, targetRpe: 7 });
		expect(out.adjustments[0]!.why).toContain('You have been sore');
		expect(out.cycleFlag).toBeUndefined();
	});

	it('only caps RPE, and flags the cycle review, when fatigue is high before a planned deload', () => {
		const bench = planned(
			'bench_press',
			[
				line({ role: 'top', sets: 1, targetRpe: 7 }),
				line({ role: 'back_off', sets: 2, targetRpe: 6 })
			],
			'bench_press'
		);
		const rows = row([line({ role: 'top', sets: 1, targetRpe: 8 })]);
		const out = proposeNextWeek(
			week([strength(day(1), [bench]), strength(day(2), [rows])], 'deload'),
			snapshot({ ...HIGH, next: { weekStartsOn: NEXT, state: 'planned', kind: 'deload' } }),
			easier('bench_press'),
			ctx()
		);

		expect(out.adjustments.map((a) => fields(a.op))).toEqual([
			{ plannedExerciseLineage: bench.lineage, position: 1, targetRpe: 6 },
			{ plannedExerciseLineage: rows.lineage, position: 1, targetRpe: 6 }
		]);
		expect(out.adjustments[0]!.why).toContain('already a deload week');
		expect(out.cycleFlag).toContain('deload week');
		expect(out.notProposed).toEqual([]);
	});

	it("lists a hold's seconds as not proposed: M3's set edit cannot change them", () => {
		const plank = planned('plank', [
			line({
				repsMin: null,
				repsMax: null,
				seconds: 30,
				loadKind: 'rpe_based',
				loadValue: null,
				loadUnit: null
			})
		]);
		const out = proposeNextWeek(
			week([strength(day(1), [plank])]),
			snapshot(),
			easier('plank'),
			ctx()
		);

		expect(out.adjustments).toEqual([]);
		expect(out.notProposed).toMatchObject([
			{ kind: 'seconds', lineage: plank.lineage, reason: 'not_expressible' }
		]);
	});

	it('does not propose an added set that takes the session past its length', () => {
		const pushUps = planned('push_up', [
			line({
				loadKind: 'rpe_based',
				loadValue: null,
				loadUnit: null,
				repsMin: 20,
				repsMax: 20,
				sets: 12
			})
		]);
		const session = strength(day(1), [pushUps]);
		const tight = proposeNextWeek(
			week([session]),
			snapshot(),
			easier('push_up'),
			ctx({ sessionMinutes: 60 })
		);
		expect(tight.adjustments).toEqual([]);
		expect(tight.notProposed).toMatchObject([
			{ kind: 'sets', reason: 'session_minutes', words: expect.stringContaining('65 minutes') }
		]);

		const roomy = proposeNextWeek(
			week([session]),
			snapshot(),
			easier('push_up'),
			ctx({ sessionMinutes: 65 })
		);
		expect(roomy.adjustments.map((a) => fields(a.op))).toEqual([
			{ plannedExerciseLineage: pushUps.lineage, position: 1, sets: 13 }
		]);
	});

	it(`lists the change after the ${MAX_NEXT_WEEK_OPS}th as not proposed`, () => {
		const lifts = Array.from({ length: 13 }, () => planned('bench_press', [line()], 'bench_press'));
		const out = proposeNextWeek(
			week([strength(day(1), lifts)]),
			snapshot(),
			easier('bench_press'),
			ctx()
		);

		expect(out.adjustments).toHaveLength(12);
		expect(out.notProposed).toHaveLength(1);
		expect(out.notProposed[0]).toMatchObject({ kind: 'load', reason: 'over_limit' });
		const all = [...out.adjustments.map((a) => a.lineage), out.notProposed[0]!.lineage];
		expect(new Set(all)).toEqual(new Set(lifts.map((l) => l.lineage)));
	});
});

describe('proposeNextWeek: running', () => {
	it("caps next week's distance at 10 % over last week's, from the easy distance", () => {
		const runs = [
			run(day(1), 'easy_run', [segment('easy', 10_000)]),
			run(day(3), 'easy_run', [segment('easy', 8_000)]),
			run(day(6), 'long_run', [segment('long', 10_000)])
		];
		const last = { prescribed: 10_000, completed: true, rpe: 5, targetRpe: 5 };
		const out = proposeNextWeek(
			week(runs),
			snapshot(),
			[],
			ctx({ running: { previousPlanned: 20_000, actual: 20_000, lastLongRun: last } })
		);

		expect(
			out.adjustments.every((a) => a.kind === 'distance' && a.op.op === 'adjust_run_segment')
		).toBe(true);
		const after = new Map(
			out.adjustments.map((a) => [a.lineage, a.after.distanceMetres as number])
		);
		const total = runs.reduce(
			(sum, r) =>
				sum +
				(after.get(r.lineage) ?? (r as { segments: RunSegment[] }).segments[0]!.distanceMetres!),
			0
		);
		expect(total).toBeLessThanOrEqual(22_000);
		expect(total).toBeGreaterThan(21_000);
		expect(out.adjustments[0]!.why).toContain('at most 10 %');
	});

	it('repeats a missed long run before it steps up', () => {
		const long = run(day(6), 'long_run', [segment('warm_up', 1_000), segment('long', 17_000)]);
		const last = { prescribed: 16_000, completed: false, rpe: null, targetRpe: 5 };
		const out = proposeNextWeek(
			week([run(day(2), 'easy_run', [segment('easy', 8_000)]), long]),
			snapshot(),
			[],
			ctx({ running: { previousPlanned: 30_000, actual: 30_000, lastLongRun: last } })
		);

		expect(out.adjustments).toHaveLength(1);
		expect(out.adjustments[0]).toMatchObject({
			kind: 'long_run',
			lineage: long.lineage,
			before: { distanceMetres: 17_000 },
			after: { distanceMetres: 15_000 },
			op: {
				op: 'adjust_run_segment',
				sessionLineage: long.lineage,
				position: 2,
				distanceMetres: 15_000
			},
			options: { half_step: { distanceMetres: 16_000 } }
		});
		expect(out.adjustments[0]!.why).toContain('was missed, so it is repeated');
	});

	it('lists the cap as not proposed when the repeated long run leaves too little easy distance', () => {
		const easy = run(day(2), 'easy_run', [segment('easy', 8_000)]);
		const long = run(day(6), 'long_run', [segment('long', 18_000)]);
		const last = { prescribed: 16_000, completed: false, rpe: null, targetRpe: 5 };
		const out = proposeNextWeek(
			week([easy, long]),
			snapshot(),
			[],
			ctx({ running: { previousPlanned: 10_000, actual: 10_000, lastLongRun: last } })
		);

		// 26 km planned, 2 km off the long run, and the easy 8 km cannot give the 13 km left.
		expect(out.adjustments.map((a) => [a.kind, a.after])).toEqual([
			['long_run', { distanceMetres: 16_000 }]
		]);
		expect(out.notProposed).toMatchObject([
			{ kind: 'distance', reason: 'not_expressible', words: expect.stringContaining('13 km') }
		]);
	});
});

describe("proposeNextWeek: M7's light weeks and deload", () => {
	const mainBench = () =>
		planned(
			'bench_press',
			[line({ role: 'top', sets: 1 }), line({ role: 'back_off', sets: 4 })],
			'bench_press'
		);
	const missedLong = { prescribed: 16_000, completed: false, rpe: null, targetRpe: 5 };
	const running = { previousPlanned: 30_000, actual: 30_000, lastLongRun: missedLong };

	it('treats deload, taper, event and recovery weeks as light, and a cutback as light for running only', () => {
		expect([...LIGHT_WEEK_KINDS].sort()).toEqual(['deload', 'event', 'recovery', 'taper']);
		expect(LIGHT_RUNNING_KINDS).toEqual(['cutback']);
	});

	it.each(['deload', 'taper', 'event', 'recovery'] as const)(
		'gives a %s week only an RPE cap on high fatigue, and flags the cycle review',
		(kind) => {
			const bench = mainBench();
			const out = proposeNextWeek(
				week([strength(day(1), [bench])], kind),
				snapshot({ ...HIGH, next: { weekStartsOn: NEXT, state: 'planned', kind } }),
				easier('bench_press'),
				ctx()
			);
			expect(out.adjustments.map((a) => [a.kind, fields(a.op)])).toEqual([
				['deload', { plannedExerciseLineage: bench.lineage, position: 1, targetRpe: 6 }],
				['deload', { plannedExerciseLineage: bench.lineage, position: 2, targetRpe: 6 }]
			]);
			expect(out.cycleFlag).toContain(`${kind} week`);
		}
	);

	it('gives a recovery week no progression when fatigue is low', () => {
		const out = proposeNextWeek(
			week([strength(day(1), [planned('bench_press', [line()], 'bench_press')])], 'recovery'),
			snapshot({ next: { weekStartsOn: NEXT, state: 'planned', kind: 'recovery' } }),
			easier('bench_press'),
			ctx()
		);
		expect(out.adjustments).toEqual([]);
	});

	it('gives a cutback week its strength changes but no running change: no cap, no repeated long run', () => {
		const sessions = () => [
			strength(day(1), [planned('bench_press', [line()], 'bench_press')]),
			run(day(2), 'easy_run', [segment('easy', 8_000)]),
			run(day(6), 'long_run', [segment('warm_up', 1_000), segment('long', 17_000)])
		];
		const kinds = (kind: WeekKind) =>
			proposeNextWeek(
				week(sessions(), kind),
				snapshot({ next: { weekStartsOn: NEXT, state: 'planned', kind } }),
				easier('bench_press'),
				ctx({ running })
			).adjustments.map((a) => a.kind);

		expect(kinds('accumulation')).toEqual(['long_run', 'load']);
		expect(kinds('cutback')).toEqual(['load']);
	});

	it("proposes no ops for a week deloaded instead, listing every other change as not proposed ('deload')", () => {
		const bench = mainBench();
		const pushUps = planned('push_up', [
			line({ loadKind: 'rpe_based', loadValue: null, loadUnit: null, sets: 3, targetRpe: 8 })
		]);
		const long = run(day(6), 'long_run', [segment('warm_up', 1_000), segment('long', 17_000)]);
		const sessions = [strength(day(1), [bench, pushUps]), long];
		const inputs = [snapshot(HIGH), [...easier('push_up')]] as const;

		const m6 = proposeNextWeek(week(sessions), ...inputs, ctx({ running }));
		expect(new Set(m6.adjustments.map((a) => a.kind))).toEqual(new Set(['deload', 'long_run']));

		const out = proposeNextWeek(week(sessions), ...inputs, ctx({ running, deload: true }));
		expect(out.adjustments).toEqual([]);
		expect(out.boundary).toBe('deload');
		expect(out.cycleFlag).toBeUndefined();
		// M6's own deload of the main lifts is replaced, not listed; the long run waits for the deload.
		expect(out.notProposed).toEqual([
			{
				...{ id: m6.adjustments.find((a) => a.kind === 'long_run')!.id, kind: 'long_run' },
				...{ lineage: long.lineage, sessionDate: day(6), reason: 'deload', words: DELOAD_INSTEAD },
				why: expect.stringContaining('was missed')
			}
		]);
	});

	it('is still late, with no ops, for a deloaded week that has ended', () => {
		const out = proposeNextWeek(
			week([strength(day(1), [mainBench()])]),
			snapshot(HIGH),
			[],
			ctx({ today: addDays(NEXT, 8), deload: true })
		);
		expect(out).toMatchObject({ adjustments: [], notProposed: [], late: true });
	});
});

describe('proposeNextWeek: conflicts', () => {
	it('moves a generated session away from a hard Muay Thai commitment the day after heavy legs', () => {
		const squat = planned(
			'back_squat',
			[line({ role: 'top', sets: 1, targetRpe: 8.5 })],
			'back_squat'
		);
		const legs = strength(day(1), [squat], { title: 'Legs', intensity: 'hard' });
		const sessions = [legs, muayThai(day(2))];
		expect(checkWeek(sessions).map((v) => [v.rule, v.severity])).toEqual([
			['heavy_lower_before_hard', 'avoid'],
			['hard_days_apart', 'prefer']
		]);

		const out = proposeNextWeek(week(sessions), snapshot(), [], ctx());

		expect(out.adjustments).toHaveLength(1);
		const [move] = out.adjustments;
		expect(move).toMatchObject({
			kind: 'move',
			lineage: legs.lineage,
			before: { date: day(1) },
			after: { date: day(0) },
			op: { op: 'move', sessionLineage: legs.lineage, toDate: day(0) },
			options: { half_step: null }
		});
		const moved = sessions.map((s) => (s === legs ? { ...s, date: day(0) } : s));
		expect(checkWeek(moved)).toEqual([]);
		expect(move!.why).toContain('Heavy lower body the day before hard Muay Thai');
	});

	it('skips the nearest day when checkWeek finds the move breaks a rule there', () => {
		const squat = planned(
			'back_squat',
			[line({ role: 'top', sets: 1, targetRpe: 8.5 })],
			'back_squat'
		);
		const legs = strength(day(1), [squat], { title: 'Legs', intensity: 'hard' });
		const club = {
			...run(day(3), 'easy_run', [segment('easy', 8_000)]),
			title: 'Run club',
			type: 'interval_run',
			intensity: 'hard',
			source: 'commitment'
		} as NextSession;
		const sessions = [legs, muayThai(day(2)), club];
		const on = (n: number) =>
			checkWeek(sessions.map((s) => (s === legs ? { ...s, date: day(n), orderInDay: 2 } : s)));
		// On Wednesday, the nearest day left, Legs joins the very demanding day before the run club.
		expect(on(2).map((v) => v.sessions.map((s) => s.title))).toEqual([
			['Sparring', 'Legs', 'Run club']
		]);

		const out = proposeNextWeek(week(sessions), snapshot(), [], ctx({ today: day(1) }));
		expect(out.adjustments.map((a) => [a.kind, a.after])).toEqual([['move', { date: day(3) }]]);
	});
});

describe("proposeNextWeek with M7's evaluation", () => {
	const FROM = addDays(NEXT, -49);
	const WEEKDAY: Record<IsoDate, string> = Object.fromEntries(
		['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, n) => [
			day(n),
			d
		])
	);
	const squat = (rpe: number) =>
		planned('back_squat', [line({ role: 'top', sets: 1, targetRpe: rpe })], 'back_squat');
	const legsOn = (date: IsoDate, rpe = 8.5) =>
		strength(date, [squat(rpe)], { title: 'Legs', intensity: rpe >= 8 ? 'hard' : 'moderate' });

	/**
	 * The review's evaluation: six weeks planned like next week (legs Tuesday, sparring Wednesday),
	 * the typical hard sessions the model judges against, and `logged` sessions; nothing else
	 * logged, so the planned weeks before today count nothing.
	 */
	function evaluation(logged: ModelLogged[] = []): ReviewEvaluation {
		const planned = [1, 2, 3, 4, 5, 6].flatMap((n) => [
			legsOn(addDays(NEXT, 1 - 7 * n)),
			muayThai(addDays(NEXT, 2 - 7 * n))
		]);
		const to = addDays(NEXT, -1);
		const days = loadModel({ planned, logged, from: FROM, to, today: NEXT });
		return {
			load: { from: FROM, days, planned, logged },
			priorities: [],
			weekKind: 'accumulation',
			events: []
		};
	}

	/** Two and a half hours of hard sparring logged on the reviewed week's Sunday. */
	const sundaySparring = (): ModelLogged => ({
		...fromPlanned({
			...muayThai(addDays(NEXT, -1)),
			estMinutes: 150,
			targetRpe: 9.5
		} as NextSession),
		intensity: null,
		source: 'logged',
		plannedLineage: null
	});

	/** Next week judged as Train judges it: the load continuing from the reviewed week. */
	const judged = (sessions: NextSession[], e: ReviewEvaluation) =>
		evaluateWeek(sessions, {
			today: NEXT,
			context: {
				load: {
					days: loadModel({
						planned: [...e.load.planned, ...sessions],
						logged: e.load.logged,
						from: FROM,
						to: day(6),
						today: NEXT
					}),
					logged: e.load.logged
				},
				priorities: [],
				week: { kind: 'accumulation' },
				events: []
			}
		});

	it('never moves a session to the day after a logged hard session: repairWeek’s move clears the conflict', () => {
		const legs = legsOn(day(1));
		const sessions = [legs, muayThai(day(2))];
		const e = evaluation([sundaySparring()]);
		// checkWeek alone takes Legs to Monday, the nearest day, the day after Sunday's sparring.
		const m6 = proposeNextWeek(week(sessions), snapshot(), [], ctx());
		expect(m6.adjustments.map((a) => a.after)).toEqual([{ date: day(0) }]);
		const onMonday = sessions.map((s) => (s === legs ? { ...s, date: day(0) } : s));
		expect(judged(onMonday, e).findings.map((f) => f.rule)).toContain(
			'concurrent.residual_fatigue_before_hard'
		);

		const out = proposeNextWeek(week(sessions), snapshot(), [], ctx({ evaluation: e }));

		expect(out.adjustments).toHaveLength(1);
		const [move] = out.adjustments;
		expect(move).toMatchObject({
			kind: 'move',
			lineage: legs.lineage,
			before: { date: day(1) },
			op: { op: 'move', sessionLineage: legs.lineage },
			evidence: { rule: 'placement.heavy_lower_before_hard', severity: 'avoid' },
			options: { half_step: null }
		});
		const to = (move!.op as { toDate: IsoDate }).toDate;
		expect(to).not.toBe(day(0));
		expect(move!.why).toBe(
			`Heavy lower body the day before hard Muay Thai: Legs on Tuesday, then Sparring on Wednesday. Moving Legs to ${WEEKDAY[to]} clears this.`
		);
		const after = judged(
			sessions.map((s) => (s === legs ? { ...s, date: to } : s)),
			e
		);
		const named = (f: { sessions: { lineage?: string }[] }) =>
			f.sessions.some((s) => s.lineage === legs.lineage);
		expect(after.findings.filter((f) => f.severity === 'avoid' && named(f))).toEqual([]);
		expect(
			judged(sessions, e).findings.filter((f) => f.severity === 'avoid' && named(f))
		).not.toEqual([]);
	});

	it('does not propose a change that adds an avoid finding, and says which', () => {
		const byRpe = line({ loadKind: 'rpe_based', loadValue: null, loadUnit: null, targetRpe: 7.5 });
		const legs = strength(day(1), [planned('back_squat', [byRpe], 'back_squat')], {
			title: 'Legs'
		});
		const sessions = [legs, muayThai(day(2))];
		const exposures = easier('back_squat');
		// Without the evaluation, RPE 7.5 to 8 is proposed: a heavy squat the day before sparring.
		const m6 = proposeNextWeek(week(sessions), snapshot(), exposures, ctx());
		expect(m6.adjustments.map((a) => [a.kind, a.after])).toEqual([['rpe', { targetRpe: 8 }]]);

		const out = proposeNextWeek(
			week(sessions),
			snapshot(),
			exposures,
			ctx({ evaluation: evaluation() })
		);

		expect(out.adjustments).toEqual([]);
		expect(out.notProposed).toEqual([
			{
				id: m6.adjustments[0]!.id,
				kind: 'rpe',
				lineage: m6.adjustments[0]!.lineage,
				sessionDate: day(1),
				why: m6.adjustments[0]!.why,
				reason: 'conflict',
				words: 'Heavy lower body the day before hard Muay Thai'
			}
		]);
	});

	it('keeps every change that adds no avoid finding, as checkWeek’s path does', () => {
		const bench = planned('bench_press', [line()], 'bench_press');
		const sessions = [strength(day(1), [bench])];
		const args = [week(sessions), snapshot(), easier('bench_press')] as const;
		const out = proposeNextWeek(...args, ctx({ evaluation: evaluation() }));
		expect(out).toEqual(proposeNextWeek(...args, ctx()));
		expect(out.adjustments).toHaveLength(1);
	});
});

describe('proposeNextWeek: timing and boundaries', () => {
	const benchWeek = () => {
		const sessions = [0, 1, 2, 4].map((n) =>
			strength(day(n), [planned('bench_press', [line()], 'bench_press')])
		);
		return { sessions, next: week(sessions) };
	};

	it("created on next week's Wednesday leaves Monday and Tuesday untouched", () => {
		const { sessions, next } = benchWeek();
		const out = proposeNextWeek(next, snapshot(), easier('bench_press'), ctx({ today: day(2) }));

		expect(out.adjustments.map((a) => a.sessionDate)).toEqual([day(2), day(4)]);
		expect(out.adjustments.map((a) => a.op.sessionLineage)).toEqual([
			sessions[2]!.lineage,
			sessions[3]!.lineage
		]);
	});

	it('leaves a session with a workout, a skipped one and a commitment untouched', () => {
		const { sessions } = benchWeek();
		const [started, skipped, commitment] = sessions;
		const out = proposeNextWeek(
			week([
				started!,
				{ ...skipped!, status: 'skipped' },
				{ ...commitment!, source: 'commitment' },
				sessions[3]!
			]),
			snapshot(),
			easier('bench_press'),
			ctx({ workouts: [{ plannedLineage: started!.lineage }] })
		);
		expect(out.adjustments.map((a) => a.op.sessionLineage)).toEqual([sessions[3]!.lineage]);
	});

	it('stillAhead on Thursday drops Monday to Wednesday and a started Thursday session', () => {
		const { sessions, next } = benchWeek();
		const thursday = strength(day(3), [planned('bench_press', [line()], 'bench_press')]);
		const friday = sessions[3]!;
		const all = proposeNextWeek(
			{ ...next, sessions: [...sessions, thursday] },
			snapshot(),
			easier('bench_press'),
			ctx()
		).adjustments;
		expect(all.map((a) => a.sessionDate)).toEqual([day(0), day(1), day(2), day(3), day(4)]);
		const move = {
			sessionDate: day(4),
			op: { op: 'move', sessionLineage: friday.lineage, toDate: day(2) } as ProgramOp
		};

		const kept = stillAhead([...all, move], day(3), [{ plannedLineage: thursday.lineage }]);
		expect(kept.map((a) => a.op.sessionLineage)).toEqual([friday.lineage]);
		expect(kept).toEqual([all[4]]);
	});

	it('is late, with no ops, when created after next week ended', () => {
		const { next } = benchWeek();
		const out = proposeNextWeek(next, snapshot(), easier('bench_press'), ctx({ today: day(7) }));
		expect(out).toMatchObject({ adjustments: [], notProposed: [], late: true });
		expect(out.reason).toContain('ended');
		// Its last day is still in time.
		const sunday = proposeNextWeek(
			{ ...next, sessions: [strength(day(6), [planned('bench_press', [line()], 'bench_press')])] },
			snapshot(),
			easier('bench_press'),
			ctx({ today: day(6) })
		);
		expect(sunday.late).toBeUndefined();
		expect(sunday.adjustments).toHaveLength(1);
	});

	it.each(['outline', 'new_block', 'unplanned'] as const)(
		'hands a %s next week to the cycle review',
		(state) => {
			const { next } = benchWeek();
			const out = proposeNextWeek(
				{ ...next, state },
				snapshot({ next: { weekStartsOn: NEXT, state, kind: null } }),
				easier('bench_press'),
				ctx()
			);
			expect(out).toMatchObject({ adjustments: [], notProposed: [], boundary: 'cycle' });
			expect(out.reason).toContain('cycle review');
		}
	);

	it('refuses a week that is not the one after the reviewed week', () => {
		const { next } = benchWeek();
		expect(() => proposeNextWeek({ ...next, startsOn: day(7) }, snapshot(), [], ctx())).toThrow(
			RangeError
		);
	});
});

describe('proposeNextWeek: the ops', () => {
	/** Every kind at once: loads, a deload-free week with runs and a conflict. */
	function everything(order: (list: NextSession[]) => NextSession[] = (l) => l) {
		const bench = planned(
			'bench_press',
			[line({ role: 'top', sets: 1 }), line({ role: 'back_off' })],
			'bench_press'
		);
		const squat = planned(
			'back_squat',
			[line({ role: 'top', sets: 1, targetRpe: 8.5 })],
			'back_squat'
		);
		const sessions = [
			strength(day(1), [squat], { title: 'Legs', intensity: 'hard' }),
			muayThai(day(2)),
			strength(day(3), [bench]),
			run(day(4), 'easy_run', [segment('easy', 12_000)]),
			run(day(6), 'long_run', [segment('long', 18_000)])
		];
		const last = { prescribed: 16_000, completed: false, rpe: null, targetRpe: 5 };
		return proposeNextWeek(
			week(order(sessions)),
			snapshot(),
			[...easier('bench_press'), ...easier('back_squat')],
			ctx({ running: { previousPlanned: 25_000, actual: 25_000, lastLongRun: last } })
		);
	}

	it("passes M3's edit schemas and M5's op and payload schemas, as proposed and at a half step", () => {
		const out = everything();
		expect(new Set(out.adjustments.map((a) => a.kind))).toEqual(
			new Set(['load', 'distance', 'long_run', 'move'])
		);
		const M3 = {
			adjust_set: adjustSetSchema,
			adjust_run_segment: adjustRunSegmentSchema,
			move: moveSessionSchema
		};
		for (const a of out.adjustments) {
			for (const op of [a.options.proposed, a.options.half_step]) {
				if (op === null) continue;
				const { op: kind, ...edit } = op;
				expect(validate(M3[kind as keyof typeof M3], edit).ok, `${a.id} ${kind}`).toBe(true);
				expect(validate(programOpSchema, op).ok).toBe(true);
			}
			if (a.op.op === 'adjust_set') {
				const bench = (a.after.loadValue ?? 0) as number;
				expect(validate(setPrescriptionSchema, line({ loadValue: bench })).ok).toBe(true);
			}
		}
		const payload = { ops: out.adjustments.map((a) => a.op) };
		expect(validate(PAYLOAD_SCHEMAS.program_adjustment, payload).ok).toBe(true);
	});

	it('is deterministic: the same week in any order gives the same result', () => {
		const first = everything();
		ids = 1000;
		const again = everything();
		ids = 1000;
		const reversed = everything((l) => [...l].reverse());
		expect(JSON.stringify(reversed)).toBe(JSON.stringify(again));
		expect(first.adjustments.map((a) => [a.kind, a.sessionDate, a.after])).toEqual(
			again.adjustments.map((a) => [a.kind, a.sessionDate, a.after])
		);
	});
});
