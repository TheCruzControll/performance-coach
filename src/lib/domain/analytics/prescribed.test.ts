import { describe, expect, it, vi } from 'vitest';
import type { IsoDate } from '../calendar';
import type { SetPrescription } from '../training/types';
import type { SetRole } from '../training/vocabulary';
import {
	COMPLETED_SHARE,
	CONSISTENCY,
	consistency,
	exposure,
	matchPrescription,
	RPE_WITHIN,
	rpeDeviationSummary,
	sessionCompletion
} from './prescribed';
import type { ActualSet, Exposure, MatchContext, PlannedLines, SetMatch } from './prescribed';

const SQUAT = 'ex-squat';
const LEG_PRESS = 'ex-leg-press';
const SQUAT_LINEAGE = 'lineage-squat';
const KG: MatchContext = { unit: 'kg' };

/** A prescription line: `sets` × 5 reps, RPE-based, unless told otherwise. */
const line = (
	role: SetRole,
	sets: number,
	more: Partial<SetPrescription> = {}
): SetPrescription => ({
	role,
	sets,
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
	restSeconds: null,
	tempo: null,
	notes: null,
	...more
});

/** A working set of back squat logged against its planned exercise: 100 kg × 5, no RPE. */
const set = (setIndex: number, more: Partial<ActualSet> = {}): ActualSet => ({
	plannedLineage: SQUAT_LINEAGE,
	exerciseId: SQUAT,
	setIndex,
	reps: 5,
	seconds: null,
	metres: null,
	weight: 100,
	assistance: null,
	unit: 'kg',
	rpe: null,
	missedReps: 0,
	isWarmup: false,
	isExtra: false,
	isSkipped: false,
	...more
});

const squat = (lines: SetPrescription[]): PlannedLines => ({
	lineage: SQUAT_LINEAGE,
	exerciseId: SQUAT,
	lines
});

/** Each row as [setIndex, status, the line it took, the logged set's weight]. */
const rows = (sets: SetMatch[]) =>
	sets.map((m) => [m.setIndex, m.status, m.target?.line ?? null, m.actual?.weight ?? null]);

/** One back squat session of working sets at a target RPE, one set per logged RPE. */
function session(day: IsoDate, rpes: (number | null)[], target = 8, more: Partial<ActualSet> = {}) {
	const lines = [line('working', rpes.length, { targetRpe: target })];
	const sets = rpes.map((rpe, i) => set(i + 1, { rpe, ...more }));
	return exposure(matchPrescription(squat(lines), sets, KG), day);
}

describe('matchPrescription', () => {
	it('maps a top set and three back-offs in order, whatever order the sets arrive in', () => {
		const lines = [
			line('top', 1, { targetRpe: 7 }),
			line('back_off', 3, { loadKind: 'from_e1rm', loadValue: 0.8 })
		];
		const sets = [
			set(3, { weight: 100 }),
			set(1, { weight: 110, rpe: 8 }),
			set(4, { weight: 97.5 }),
			set(2, { weight: 102.5 })
		];
		const e1rmKg = vi.fn(() => 125);
		const match = matchPrescription(squat(lines), sets, { unit: 'kg', e1rmKg });

		expect(match.lineage).toBe(SQUAT_LINEAGE);
		expect(rows(match.sets)).toEqual([
			[1, 'done', 1, 110],
			[2, 'done', 2, 102.5],
			[3, 'done', 2, 100],
			[4, 'done', 2, 97.5]
		]);
		expect(match.sets.map((m) => m.target?.role)).toEqual([
			'top',
			'back_off',
			'back_off',
			'back_off'
		]);
		// The top set is picked by RPE, so it has no fixed load; the back-offs are 0.8 × 125 kg.
		expect(match.sets.map((m) => m.target?.kg)).toEqual([null, 100, 100, 100]);
		expect(match.sets.map((m) => m.rpeDeviation)).toEqual([1, null, null, null]);
		// The resolver is asked about the from_e1rm line only.
		expect(e1rmKg).toHaveBeenCalledTimes(1);
		expect(e1rmKg).toHaveBeenCalledWith(lines[1]);
	});

	it('fixes a load only where the prescription does: never a from_e1rm one without a resolver', () => {
		const kg = (l: SetPrescription, context: MatchContext = KG) =>
			matchPrescription(squat([l]), [], context).sets[0]!.target!.kg;
		const absolute = { loadKind: 'absolute', loadValue: 100, loadUnit: 'kg' } as const;
		const lbs = { loadKind: 'absolute', loadValue: 225, loadUnit: 'lb' } as const;
		const percent = {
			loadKind: 'percent_1rm',
			loadValue: 0.8,
			loadBasis: 'measured',
			reference1rm: 140,
			reference1rmUnit: 'kg'
		} as const;

		expect(kg(line('working', 1, absolute))).toBe(100);
		// What the owner saw: 225 lb for an owner in lb, exactly 102.06 kg; plates in kg otherwise.
		expect(kg(line('working', 1, lbs), { unit: 'lb' })).toBeCloseTo(102.0583, 4);
		expect(kg(line('working', 1, lbs))).toBe(102.5);
		// 0.8 × the 140 kg reference, on 2.5 kg plates.
		expect(kg(line('working', 1, percent))).toBe(112.5);
		expect(kg(line('working', 1, { loadKind: 'from_e1rm', loadValue: 0.8 }))).toBeNull();
		expect(
			kg(line('working', 1, { loadKind: 'from_e1rm', loadValue: 0.8 }), {
				unit: 'kg',
				e1rmKg: () => null
			})
		).toBeNull();
		expect(kg(line('working', 1, { targetRpe: 8 }))).toBeNull();
	});

	it('maps ramps to warm-up lines, and never lets a set of the other kind take a line', () => {
		const lines = [
			line('ramp', 2, { repsMin: 3, repsMax: 3 }),
			line('working', 3, { targetRpe: 8 })
		];
		const sets = [
			set(1, { isWarmup: true, weight: 60, reps: 3 }),
			set(2, { isWarmup: true, weight: 80, reps: 3 }),
			set(3, { rpe: 8 }),
			set(4, { rpe: 8 }),
			set(5, { rpe: 8.5 })
		];
		const match = matchPrescription(squat(lines), sets, KG);
		expect(rows(match.sets)).toEqual([
			[1, 'done', 1, 60],
			[2, 'done', 1, 80],
			[3, 'done', 2, 100],
			[4, 'done', 2, 100],
			[5, 'done', 2, 100]
		]);
		expect(match.sets.map((m) => m.target?.warmUp)).toEqual([true, true, false, false, false]);

		// A working set at a ramp's index, and a warm-up at a working line's: both lines stay missing.
		const crossed = matchPrescription(
			squat(lines),
			[set(1, { weight: 60 }), set(3, { isWarmup: true, weight: 70 })],
			KG
		);
		expect(rows(crossed.sets)).toEqual([
			[1, 'missing', 1, null],
			[1, 'extra', null, 60],
			[2, 'missing', 1, null],
			[3, 'missing', 2, null],
			[3, 'extra', null, 70],
			[4, 'missing', 2, null],
			[5, 'missing', 2, null]
		]);
	});

	it('flags extra and skipped sets', () => {
		const sets = [
			set(1, { weight: 100 }),
			// The same index again, as a second device may log it: the first in order keeps the line.
			set(1, { weight: 90 }),
			set(2, { isSkipped: true, weight: null, reps: null }),
			set(3, { weight: 100 }),
			set(4, { isExtra: true, weight: 80 })
		];
		const match = matchPrescription(squat([line('working', 3)]), sets, KG);
		expect(rows(match.sets)).toEqual([
			[1, 'done', 1, 100],
			[1, 'extra', null, 90],
			[2, 'skipped', 1, null],
			[3, 'done', 1, 100],
			[4, 'extra', null, 80]
		]);
		const skipped = match.sets[2]!;
		expect([skipped.rpeDeviation, skipped.repsShort, skipped.hit]).toEqual([null, null, null]);

		// A skip carries no kind (M4's set.skip stores isWarmup false): it takes a ramp line too.
		const ramp = matchPrescription(
			squat([line('ramp', 1, { repsMin: 3, repsMax: 3 }), line('working', 1)]),
			[set(1, { isSkipped: true, weight: null, reps: null }), set(2)],
			KG
		);
		expect(rows(ramp.sets)).toEqual([
			[1, 'skipped', 1, null],
			[2, 'done', 2, 100]
		]);

		// A set the device marked extra never takes a line, even at a planned index.
		const marked = matchPrescription(squat([line('working', 2)]), [set(2, { isExtra: true })], KG);
		expect(rows(marked.sets)).toEqual([
			[1, 'missing', 1, null],
			[2, 'missing', 1, null],
			[2, 'extra', null, 100]
		]);
	});

	it('leaves lines missing when fewer sets were logged', () => {
		const match = matchPrescription(
			squat([line('working', 3, { targetRpe: 8 })]),
			[set(1, { rpe: 8 })],
			KG
		);
		expect(rows(match.sets)).toEqual([
			[1, 'done', 1, 100],
			[2, 'missing', 1, null],
			[3, 'missing', 1, null]
		]);
		expect(match.sets.map((m) => [m.rpeDeviation, m.repsShort, m.hit])).toEqual([
			[0, 0, true],
			[null, null, null],
			[null, null, null]
		]);
	});

	it('gives a null deviation, never 0, when either RPE is missing', () => {
		const deviation = (target: number | null, rpe: number | null) =>
			matchPrescription(squat([line('working', 1, { targetRpe: target })]), [set(1, { rpe })], KG)
				.sets[0]!.rpeDeviation;
		expect(deviation(8, null)).toBeNull();
		expect(deviation(null, 8)).toBeNull();
		expect(deviation(null, null)).toBeNull();
		expect(deviation(8, 8)).toBe(0);
		expect(deviation(8, 9.5)).toBe(1.5);
		expect(deviation(8, 7)).toBe(-1);
	});

	it('compares seconds on a timed line, and reps against the bottom of a range', () => {
		const plank = squat([line('working', 3, { repsMin: null, repsMax: null, seconds: 45 })]);
		const held = (seconds: number) => set(0, { reps: null, seconds, weight: null });
		const timed = matchPrescription(
			plank,
			[50, 45, 40].map((s, i) => ({ ...held(s), setIndex: i + 1 })),
			KG
		);
		expect(timed.sets.map((m) => [m.hit, m.repsShort])).toEqual([
			[true, null],
			[true, null],
			[false, null]
		]);

		const range = squat([line('working', 3, { repsMin: 6, repsMax: 10 })]);
		const reps = matchPrescription(
			range,
			[set(1, { reps: 10 }), set(2, { reps: 6 }), set(3, { reps: 4, missedReps: 1 })],
			KG
		);
		expect(reps.sets.map((m) => [m.hit, m.repsShort])).toEqual([
			[true, 0],
			[true, 0],
			[false, 2]
		]);
	});

	it('matches each superset lineage with its own sets only', () => {
		const pull = { lineage: 'lineage-pull', exerciseId: 'ex-pull' };
		const plank = { lineage: 'lineage-plank', exerciseId: 'ex-plank' };
		const a = (i: number) =>
			set(i, { exerciseId: pull.exerciseId, plannedLineage: pull.lineage, reps: 8 });
		const b = (i: number) =>
			set(i, {
				exerciseId: plank.exerciseId,
				plannedLineage: plank.lineage,
				reps: null,
				seconds: 45,
				weight: null
			});
		// A1, A2, A1, A2...: performed in rounds, with an added exercise's set in between.
		const sets = [a(1), b(1), a(2), b(2), set(1, { plannedLineage: null }), a(3), b(3)];

		const pulls = matchPrescription(
			{ ...pull, lines: [line('working', 3, { repsMin: 6, repsMax: 10 })] },
			sets,
			KG
		);
		const planks = matchPrescription(
			{ ...plank, lines: [line('working', 3, { repsMin: null, repsMax: null, seconds: 45 })] },
			sets,
			KG
		);
		expect(pulls.sets.map((m) => [m.status, m.actual?.exerciseId])).toEqual([
			['done', 'ex-pull'],
			['done', 'ex-pull'],
			['done', 'ex-pull']
		]);
		expect(planks.sets.map((m) => [m.status, m.actual?.exerciseId, m.hit])).toEqual([
			['done', 'ex-plank', true],
			['done', 'ex-plank', true],
			['done', 'ex-plank', true]
		]);
	});

	it('compares a substituted exercise against nothing, while its sets still fill the slots', () => {
		const lines = [
			line('working', 3, { targetRpe: 8, loadKind: 'absolute', loadValue: 100, loadUnit: 'kg' })
		];
		const sets = [1, 2, 3].map((i) =>
			set(i, { exerciseId: LEG_PRESS, weight: 180, reps: 3, rpe: 9, missedReps: 2 })
		);
		const match = matchPrescription(squat(lines), sets, KG);
		expect(match.sets.map((m) => [m.status, m.substitute])).toEqual([
			['done', true],
			['done', true],
			['done', true]
		]);
		expect(match.sets.map((m) => [m.rpeDeviation, m.repsShort, m.hit])).toEqual([
			[null, null, null],
			[null, null, null],
			[null, null, null]
		]);

		const swapped = exposure(match, '2026-11-02');
		expect(swapped).toMatchObject({
			substituted: true,
			sets: { prescribed: 3, completed: 3, extra: 0 },
			missedReps: 0,
			rpeDeviations: [],
			meanRpeDeviation: null,
			topSet: null,
			kg: null,
			hit: null
		});
		expect(
			sessionCompletion({ date: '2026-11-02', status: 'planned' }, [match], '2026-11-06')
		).toEqual({ status: 'completed', prescribed: 3, completed: 3 });
	});

	it('counts a set role it does not know as working (pinned)', () => {
		const unknown = 'cluster' as SetRole;
		const lines = [line(unknown, 2, { targetRpe: 8 })];
		const match = matchPrescription(
			squat(lines),
			[set(1, { rpe: 9 }), set(2, { isWarmup: true, weight: 50 })],
			KG
		);
		expect(match.sets.map((m) => [m.setIndex, m.status, m.target?.warmUp ?? null])).toEqual([
			[1, 'done', false],
			[2, 'missing', false],
			[2, 'extra', null]
		]);
		expect(exposure(match, '2026-11-02').sets).toEqual({ prescribed: 2, completed: 1, extra: 0 });
	});
});

describe('exposure', () => {
	it('sums one planned exercise in one workout: sets, missed reps, RPE, the top set and its load', () => {
		const lines = [
			line('ramp', 1, { repsMin: 3, repsMax: 3, targetRpe: 5 }),
			line('top', 1, { targetRpe: 8 }),
			line('back_off', 3, { targetRpe: 7 })
		];
		const sets = [
			set(1, { isWarmup: true, weight: 60, reps: 3, rpe: 7 }),
			set(2, { weight: 110, rpe: 9 }),
			set(3, { weight: 100, rpe: 7 }),
			// Short of the 5 by one, with that rep attempted and missed.
			set(4, { weight: 100, reps: 4, missedReps: 1, rpe: 8 }),
			// Short by two, nothing logged as missed: the shortfall still counts.
			set(5, { weight: 100, reps: 3, rpe: 8.5 }),
			set(6, { isExtra: true, weight: 90, rpe: 6 })
		];
		const day = '2026-11-04';
		const result = exposure(matchPrescription(squat(lines), sets, KG), day);
		expect(result).toMatchObject({
			day,
			lineage: SQUAT_LINEAGE,
			exerciseId: SQUAT,
			substituted: false,
			// The ramp is not part of the prescribed work; the extra set is counted apart.
			sets: { prescribed: 4, completed: 4, extra: 1 },
			missedReps: 3,
			// The warm-up's +2 is left out.
			rpeDeviations: [1, 0, 1, 1.5],
			rpeTargets: [8, 7, 7, 7],
			meanRpeDeviation: 0.875,
			kg: 110,
			hit: false
		});
		expect(result.topSet?.setIndex).toBe(2);
		expect(result.topSet?.target?.rpe).toBe(8);
		expect(result.topSet?.actual?.rpe).toBe(9);
	});

	it('takes the heaviest working set as the top set when no line is one', () => {
		const sets = [
			set(1, { weight: 100 }),
			set(2, { weight: 230, unit: 'lb', reps: 5 }),
			set(3, { weight: 100, reps: 6 })
		];
		const result = exposure(matchPrescription(squat([line('working', 3)]), sets, KG), '2026-11-04');
		expect(result.topSet?.setIndex).toBe(2);
		expect(result.kg).toBeCloseTo(104.326, 3);
		expect(result.hit).toBe(true);
		expect(result.meanRpeDeviation).toBeNull();

		// A planned top set that was not done is still the top set: its target against nothing.
		const missed = exposure(
			matchPrescription(
				squat([line('top', 1, { targetRpe: 8 }), line('back_off', 2)]),
				[set(2)],
				KG
			),
			'2026-11-04'
		);
		expect([missed.topSet?.setIndex, missed.topSet?.status, missed.kg, missed.hit]).toEqual([
			1,
			'missing',
			null,
			false
		]);
	});
});

describe('consistency', () => {
	it('needs two exposures with an RPE: one is too few', () => {
		expect(consistency([session('2026-11-02', [6, 6])]).verdict).toBe('too_few');
		expect(consistency([]).verdict).toBe('too_few');
	});

	it('with two exposures, both must agree', () => {
		const below = [session('2026-10-26', [7, 7]), session('2026-11-02', [6.5, 7.5])];
		expect(consistency(below).verdict).toBe('below');
		const mixed = [session('2026-10-26', [7, 7]), session('2026-11-02', [7.5, 7.5])];
		expect(consistency(mixed).verdict).toBe('within');
	});

	it('with three, 2 of the 3 decide, at a mean of exactly 1.0 and over', () => {
		const three = (a: number, b: number, c: number) =>
			consistency([
				session('2026-10-19', [8 + a]),
				session('2026-10-26', [8 + b]),
				session('2026-11-02', [8 + c])
			]).verdict;
		expect(three(-1, 0, -1.5)).toBe('below');
		expect(three(1, 1.5, 0)).toBe('above');
		expect(three(-1, 1, 0)).toBe('within');
		expect(three(-0.5, -0.5, -1)).toBe('within');
		expect(three(0.5, 1, 0.5)).toBe('within');
		expect(CONSISTENCY).toEqual({ window: 3, rpe: 1, agree: 2 });
	});

	it('reads the last three exposures by day, of the lift itself, and lists those with missed reps', () => {
		const old = session('2026-10-12', [6]);
		const recent = [
			session('2026-10-19', [7]),
			session('2026-10-26', [8], 8, { reps: 4, missedReps: 1 }),
			session('2026-11-02', [8])
		];
		const swapped = exposure(
			matchPrescription(
				squat([line('working', 1, { targetRpe: 8 })]),
				[set(1, { exerciseId: LEG_PRESS, rpe: 6 })],
				KG
			),
			'2026-11-04'
		);
		// Given newest first, with a substitute's session last: neither changes the window.
		const result = consistency([...recent, old, swapped].reverse());
		expect(result.verdict).toBe('within');
		expect(result.exposures.map((e) => e.day)).toEqual(['2026-10-19', '2026-10-26', '2026-11-02']);
		expect(result.missed.map((e) => e.day)).toEqual(['2026-10-26']);
		// A wider window reaches the old exposure: 2 of the last 4 are below.
		expect(consistency([old, ...recent], 4).verdict).toBe('below');
	});

	it('counts only exposures with an RPE toward the two that must agree', () => {
		const noRpe = [session('2026-10-19', [null]), session('2026-10-26', [null])];
		expect(consistency([...noRpe, session('2026-11-02', [6])]).verdict).toBe('too_few');
	});

	it('refuses a window that is not a positive whole number', () => {
		expect(() => consistency([], 0)).toThrow(RangeError);
		expect(() => consistency([], 2.5)).toThrow(RangeError);
	});
});

describe('rpeDeviationSummary', () => {
	it('gives the mean, the mean absolute deviation and the share within ±0.5, overall, by lift and week', () => {
		const bench = (day: IsoDate, rpes: number[]) =>
			exposure(
				matchPrescription(
					{
						lineage: 'lineage-bench',
						exerciseId: 'ex-bench',
						lines: [line('working', rpes.length, { targetRpe: 8 })]
					},
					rpes.map((rpe, i) =>
						set(i + 1, { plannedLineage: 'lineage-bench', exerciseId: 'ex-bench', rpe })
					),
					KG
				),
				day
			);
		const exposures: Exposure[] = [
			session('2026-11-02', [7.5, 6.5]),
			bench('2026-10-28', [8.5]),
			session('2026-10-28', [9, 8]),
			// A substitute's session compares against nothing and is left out.
			exposure(
				matchPrescription(
					squat([line('working', 1, { targetRpe: 8 })]),
					[set(1, { exerciseId: LEG_PRESS, rpe: 10 })],
					KG
				),
				'2026-11-03'
			)
		];
		const summary = rpeDeviationSummary(exposures);
		// Deviations +1, 0, +0.5 (week of 26 October) and −0.5, −1.5 (week of 2 November).
		expect(summary.overall).toEqual({
			count: 5,
			mean: -0.1,
			meanAbsolute: 0.7,
			within: 3,
			withinShare: 0.6
		});
		expect(summary.byExercise).toEqual({
			[SQUAT]: { count: 4, mean: -0.25, meanAbsolute: 0.75, within: 2, withinShare: 0.5 },
			'ex-bench': { count: 1, mean: 0.5, meanAbsolute: 0.5, within: 1, withinShare: 1 }
		});
		expect(summary.byWeek).toEqual({
			'2026-10-26': { count: 3, mean: 0.5, meanAbsolute: 0.5, within: 2, withinShare: 0.666667 },
			'2026-11-02': { count: 2, mean: -1, meanAbsolute: 1, within: 1, withinShare: 0.5 }
		});
		// Weeks come oldest first.
		expect(Object.keys(summary.byWeek)).toEqual(['2026-10-26', '2026-11-02']);
		expect(RPE_WITHIN).toBe(0.5);
	});

	it('has nothing to summarise without RPEs', () => {
		const empty = { count: 0, mean: null, meanAbsolute: null, within: 0, withinShare: null };
		expect(rpeDeviationSummary([])).toEqual({ overall: empty, byExercise: {}, byWeek: {} });
		expect(rpeDeviationSummary([session('2026-11-02', [null])]).byExercise).toEqual({
			[SQUAT]: empty
		});
		// A substitute's session alone gives the planned lift no entry at all.
		const swapped = exposure(
			matchPrescription(
				squat([line('working', 1, { targetRpe: 8 })]),
				[set(1, { exerciseId: LEG_PRESS, rpe: 9 })],
				KG
			),
			'2026-11-02'
		);
		expect(rpeDeviationSummary([swapped])).toEqual({ overall: empty, byExercise: {}, byWeek: {} });
	});
});

describe('sessionCompletion', () => {
	const TODAY = '2026-11-04';
	const planned = { date: '2026-11-02', status: 'planned' } as const;
	/** A workout of one exercise: five working sets, `done` of them logged, the rest skipped. */
	const workout = (done: number) => [
		matchPrescription(
			squat([line('ramp', 2), line('working', 5)]),
			[1, 2, 3, 4, 5].map((i) => set(i + 2, { isSkipped: i > done })),
			KG
		)
	];

	it('is completed at the share of prescribed working sets and partial just under it', () => {
		expect(COMPLETED_SHARE).toBe(0.8);
		// The two ramp sets were never logged: warm-ups are not the prescribed work.
		expect(sessionCompletion(planned, workout(5), TODAY)).toEqual({
			status: 'completed',
			prescribed: 5,
			completed: 5
		});
		expect(sessionCompletion(planned, workout(4), TODAY).status).toBe('completed');
		expect(sessionCompletion(planned, workout(3), TODAY)).toEqual({
			status: 'partial',
			prescribed: 5,
			completed: 3
		});
		expect(sessionCompletion(planned, workout(0), TODAY).status).toBe('partial');
	});

	it('counts every planned exercise of the workout, and an exercise with no sets as not done', () => {
		const lines = [line('working', 5)];
		const squats = matchPrescription(
			squat(lines),
			[1, 2, 3, 4, 5].map((i) => set(i)),
			KG
		);
		const untouched = matchPrescription({ lineage: 'l-row', exerciseId: 'ex-row', lines }, [], KG);
		expect(sessionCompletion(planned, [squats, untouched], TODAY)).toEqual({
			status: 'partial',
			prescribed: 10,
			completed: 5
		});
	});

	it('is completed for a completed session with no prescribed sets, such as a run', () => {
		expect(sessionCompletion(planned, [], TODAY)).toEqual({
			status: 'completed',
			prescribed: 0,
			completed: 0
		});
	});

	it('without a completed workout: skipped by choice, missed once past, pending until then', () => {
		const none = (date: IsoDate, status: 'planned' | 'skipped' | 'moved') =>
			sessionCompletion({ date, status }, null, TODAY).status;
		expect(none('2026-11-02', 'skipped')).toBe('skipped');
		expect(none('2026-11-06', 'skipped')).toBe('skipped');
		expect(none('2026-11-03', 'planned')).toBe('missed');
		expect(none('2026-11-03', 'moved')).toBe('missed');
		expect(none(TODAY, 'planned')).toBe('pending');
		expect(none('2026-11-05', 'moved')).toBe('pending');
		// A completed workout wins over a stored skip, as M3's program reads derive it.
		expect(sessionCompletion({ ...planned, status: 'skipped' }, workout(5), TODAY).status).toBe(
			'completed'
		);
	});
});
