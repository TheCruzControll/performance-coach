import { describe, expect, it } from 'vitest';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import type { StrengthBaseline } from '../profile/types';
import { bestE1rm, hardSets, setE1rm } from '../training/metrics';
import { cleanFloat, convertWeight } from '../units';
import { volumeLoad } from '../load';
import { createMutation } from '../workout/mutations';
import type { Mutation, MutationInput, MutationOf, MutationType } from '../workout/mutations';
import { project } from '../workout/project';
import { strengthTable } from '../workout/reducers/tables';
import { bestsOf, summarizeWorkout } from '../workout/summary';
import type { PriorBests } from '../workout/summary';
import type { LoggedSet, WorkoutView } from '../workout/types';
import { periodWindow } from './periods';
import { totalOf } from './series';
import {
	BASELINE_LABEL,
	e1rmSeries,
	KEY_LIFTS_MAX,
	keyLifts,
	measuredMaxes,
	muscleGroupWeeks,
	prTimeline,
	rpeSummary,
	topSets,
	weeklyHardSets,
	weeklyRpe,
	weeklyTonnage
} from './strength';
import type { GroupTargets, StrengthExercise, StrengthFact } from './strength';

const TZ = 'America/Los_Angeles';
// Today is Wednesday 11 November 2026: the 4w window is 12 October to 8 November, and the week in
// progress runs from Monday 9 November to today.
const TODAY = '2026-11-11';
const WINDOW = periodWindow(TODAY, '4w', null);
const WEEKS = ['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'];

const SQUAT: StrengthExercise = {
	measure: 'reps',
	loadType: 'external',
	primaryMuscles: ['quads', 'glutes'],
	secondaryMuscles: ['adductors', 'lower_back'],
	baselineLift: 'back_squat'
};
const ROW: StrengthExercise = {
	measure: 'reps',
	loadType: 'external',
	primaryMuscles: ['upper_back', 'lats'],
	secondaryMuscles: ['rear_delts', 'biceps', 'lower_back', 'forearms'],
	baselineLift: null
};
const PULL_UP: StrengthExercise = {
	measure: 'reps',
	loadType: 'bodyweight',
	primaryMuscles: ['lats', 'upper_back'],
	secondaryMuscles: ['biceps', 'rear_delts', 'forearms'],
	baselineLift: null
};
const PLANK: StrengthExercise = {
	measure: 'time',
	loadType: 'bodyweight',
	primaryMuscles: ['abs'],
	secondaryMuscles: ['obliques'],
	baselineLift: null
};
const EXERCISES = new Map([
	['back_squat', SQUAT],
	['barbell_row', ROW],
	['pull_up', PULL_UP],
	['plank', PLANK]
]);

/** Midday in Los Angeles on `day`. */
const noon = (day: string) => new Date(`${day}T19:00:00Z`);

let ids = 0;
function set(day: string, fields: Partial<StrengthFact> = {}): StrengthFact {
	return {
		exercise: 'back_squat',
		weight: 100,
		unit: 'kg',
		reps: 5,
		rpe: null,
		isWarmup: false,
		isSkipped: false,
		performedAt: noon(day),
		seconds: null,
		metres: null,
		assistance: null,
		missedReps: 0,
		isExtra: false,
		id: `s${++ids}`,
		workoutId: `w-${day}`,
		plannedLineage: null,
		setIndex: 1,
		deletedAt: null,
		...fields
	};
}

describe('units and which sets count', () => {
	it('converts lb to kg through M1’s exact factor', () => {
		const lifted = set('2026-11-02', { weight: 225, unit: 'lb' });
		const kg = convertWeight(225, 'lb', 'kg');
		expect(kg).toBe(102.05828325);

		const [point] = e1rmSeries([lifted], SQUAT, TZ);
		expect(point!.value).toBe(setE1rm(lifted)!.value);
		expect(point!.value).toBeCloseTo(116.941783, 6); // (w × 7/6 + w × 36/32) ÷ 2
		expect(topSets([lifted], SQUAT, TZ)[0]!.kg).toBe(102.058283);
		const tonnage = weeklyTonnage([lifted], EXERCISES, TZ, WINDOW);
		expect(tonnage.find((p) => p.at === '2026-11-02')!.value).toBe(510.291416);
		expect(cleanFloat(volumeLoad([{ weight: kg, reps: 5 }]))).toBe(510.291416);
	});

	it('never counts a warm-up, a skipped or a deleted set', () => {
		const day = '2026-11-02';
		const facts = [
			set(day, { weight: 140, isWarmup: true }),
			set(day, { weight: 150, isSkipped: true, reps: null }),
			set(day, { weight: 160, deletedAt: noon(day) }),
			set(day, { weight: 100, rpe: 8 })
		];
		expect(e1rmSeries(facts, SQUAT, TZ).map((p) => p.setId)).toEqual([facts[3]!.id]);
		expect(topSets(facts, SQUAT, TZ)[0]).toMatchObject({ kg: 100, reps: 5 });
		const week = (points: { at?: string; weekStart?: string }[]) =>
			points.find((p) => (p.at ?? p.weekStart) === day);
		expect(week(weeklyTonnage(facts, EXERCISES, TZ, WINDOW))).toMatchObject({ value: 500 });
		expect(week(weeklyHardSets(facts, EXERCISES, TZ, WINDOW))).toMatchObject({ sets: 1 });
		expect(rpeSummary(facts)).toEqual({ mean: 8, sets: 1, rated: 1, share: 1 });

		// A later 5 × 100 ties the working set; the deleted and warm-up sets beat nothing.
		const later = [
			set('2026-11-04', { weight: 200, deletedAt: noon('2026-11-04') }),
			set('2026-11-04', { weight: 180, isWarmup: true }),
			set('2026-11-04')
		];
		expect(prTimeline([...facts, ...later], SQUAT, TZ)).toEqual([]);
	});
});

describe('e1rmSeries and measuredMaxes', () => {
	const sessions = [
		[
			set('2026-10-12', { reps: 5, weight: 100, rpe: 8 }),
			set('2026-10-12', { reps: 3, weight: 110, rpe: 9 }),
			set('2026-10-12', { reps: 8, weight: 90, rpe: null })
		],
		[
			set('2026-10-15', { reps: 1, weight: 130, rpe: 10 }),
			set('2026-10-15', { reps: 5, weight: 105, rpe: 5 }) // under RPE 6: no estimate
		]
	];

	it('gives each session M3’s bestE1rm, with its method and confidence', () => {
		const points = e1rmSeries(sessions.flat(), SQUAT, TZ);
		expect(points).toHaveLength(2);
		points.forEach((point, i) => {
			const best = bestE1rm(sessions[i]!)!;
			expect(point).toEqual({
				kind: 'estimated',
				value: best.value,
				method: best.method,
				confidence: best.confidence,
				workoutId: sessions[i]![0]!.workoutId,
				on: ['2026-10-12', '2026-10-15'][i],
				setId: best.set.id
			});
		});
	});

	it('never gives a measured point, even for a single at RPE 10', () => {
		const points = e1rmSeries(sessions.flat(), SQUAT, TZ);
		expect(points[1]).toMatchObject({ value: 130, method: 'rpe-table' });
		expect(points.every((p) => p.kind === 'estimated')).toBe(true);
	});

	it('has no point for a bodyweight or a timed exercise', () => {
		const pullUps = [set('2026-10-12', { exercise: 'pull_up', weight: 10, reps: 6, rpe: 8 })];
		expect(e1rmSeries(pullUps, PULL_UP, TZ)).toEqual([]);
	});

	it('refuses two exercises’ sets', () => {
		const mixed = [set('2026-10-12'), set('2026-10-12', { exercise: 'barbell_row' })];
		expect(() => e1rmSeries(mixed, SQUAT, TZ)).toThrow(RangeError);
	});

	it('keeps the profile’s 1RMs apart, labelled by their kind', () => {
		const baseline = (fields: Partial<StrengthBaseline>): StrengthBaseline => ({
			id: 'b1',
			lift: 'back_squat',
			customLabel: null,
			kind: 'measured',
			source: 'tested',
			value: 140,
			unit: 'kg',
			achievedOn: '2026-09-01',
			setWeight: null,
			setReps: null,
			setRpe: null,
			method: null,
			confidence: null,
			notes: null,
			recordedAt: new Date('2026-09-02T00:00:00Z'),
			...fields
		});
		const maxes = measuredMaxes([
			baseline({}),
			baseline({
				id: 'b2',
				lift: 'bench_press',
				kind: 'estimated',
				source: 'set',
				value: 225,
				unit: 'lb',
				achievedOn: null,
				method: 'rpe-table',
				confidence: 'high'
			})
		]);
		expect(maxes).toEqual([
			{
				id: 'b1',
				lift: 'back_squat',
				customLabel: null,
				kind: 'measured',
				source: 'tested',
				method: null,
				confidence: null,
				on: '2026-09-01',
				kg: 140,
				label: 'Measured'
			},
			{
				id: 'b2',
				lift: 'bench_press',
				customLabel: null,
				kind: 'estimated',
				source: 'set',
				method: 'rpe-table',
				confidence: 'high',
				on: null,
				kg: 102.05828325,
				label: 'Estimated · from your profile'
			}
		]);
		expect(BASELINE_LABEL.estimated).toBe('Estimated · from your profile');
	});
});

describe('topSets', () => {
	it('takes the heaviest working set, and the reps at the load used most', () => {
		const day = '2026-10-19';
		const facts = [
			set(day, { weight: 60, reps: 10, isWarmup: true }),
			set(day, { weight: 120, reps: 3 }),
			set(day, { weight: 100, reps: 6 }),
			set(day, { weight: 100, reps: 8 }),
			set(day, { weight: 100, reps: 7 })
		];
		expect(topSets(facts, SQUAT, TZ)).toEqual([
			{
				workoutId: `w-${day}`,
				on: day,
				set: facts[1],
				kg: 120,
				reps: 3,
				workingLoad: { kg: 100, sets: 3, reps: 8 }
			}
		]);
	});

	it('breaks a tie for the load used most toward the heavier', () => {
		const day = '2026-10-19';
		const facts = [set(day, { weight: 100, reps: 5 }), set(day, { weight: 105, reps: 3 })];
		expect(topSets(facts, SQUAT, TZ)[0]!.workingLoad).toEqual({ kg: 105, sets: 1, reps: 3 });
	});
});

describe('prTimeline', () => {
	it('5 × 100, 5 × 100, 5 × 102.5, then 6 × 100: a baseline, a tie, then PRs', () => {
		const facts = [
			set('2026-10-12'),
			set('2026-10-14'),
			set('2026-10-16', { weight: 102.5 }),
			set('2026-10-19', { weight: 100, reps: 6 })
		];
		const prs = prTimeline(facts, SQUAT, TZ);
		const brief = prs.map(({ on, kind, reps, value, previous }) => ({
			on,
			kind,
			reps,
			value: cleanFloat(value),
			previous: { ...previous, value: cleanFloat(previous.value) }
		}));
		const first = { on: '2026-10-12', workoutId: 'w-2026-10-12' };
		const third = { on: '2026-10-16', workoutId: 'w-2026-10-16' };
		expect(brief).toEqual([
			// 5 × 102.5: e1RM (102.5 × 7/6 + 102.5 × 36/32) ÷ 2 over 100's, the 5-rep max, the volume.
			{
				on: '2026-10-16',
				kind: 'e1rm',
				reps: null,
				value: 117.447917,
				previous: { ...first, value: 114.583333 }
			},
			{
				on: '2026-10-16',
				kind: 'rep_max',
				reps: 5,
				value: 102.5,
				previous: { ...first, value: 100 }
			},
			{
				on: '2026-10-16',
				kind: 'volume',
				reps: null,
				value: 512.5,
				previous: { ...first, value: 500 }
			},
			// 6 × 100: (120 + 3,600 ÷ 31) ÷ 2 beats 117.45; the 6-rep max starts here, as in M4.
			{
				on: '2026-10-19',
				kind: 'e1rm',
				reps: null,
				value: 118.064516,
				previous: { ...third, value: 117.447917 }
			},
			{
				on: '2026-10-19',
				kind: 'volume',
				reps: null,
				value: 600,
				previous: { ...third, value: 512.5 }
			}
		]);
		expect(prs.map((pr) => pr.label)).toEqual([
			'Estimated 1RM',
			'Rep max',
			'Session volume',
			'Estimated 1RM',
			'Session volume'
		]);
		expect(prs.map((pr) => pr.estimated)).toEqual([true, false, false, true, false]);
		expect(prs[0]!.setId).toBe(facts[2]!.id);
		expect(prs[2]!.setId).toBeNull();
	});

	it('is strict: the same load in lb ties, and only more volume is a volume PR', () => {
		const facts = [
			...[1, 2, 3].map(() => set('2026-10-12', { rpe: 8 })),
			// 220.462262185 lb is 100.00000000006 kg: the same load, within noise.
			...[1, 2, 3, 4].map(() => set('2026-10-19', { weight: 220.462262185, unit: 'lb', rpe: 8 }))
		];
		const prs = prTimeline(facts, SQUAT, TZ);
		expect(prs.map((pr) => pr.kind)).toEqual(['volume']);
		expect(cleanFloat(prs[0]!.value)).toBe(2000);
		expect(prs[0]!.previous.value).toBe(1500);
	});

	it('gives a bodyweight exercise most-reps PRs from unweighted sets, and volume from added weight', () => {
		const pullUp = (day: string, weight: number | null, reps: number) =>
			set(day, { exercise: 'pull_up', weight, reps });
		const facts = [
			pullUp('2026-10-12', null, 8),
			// 12 reps with 20 kg added compete for no most-reps PR; its 240 kg starts the volume record.
			pullUp('2026-10-19', null, 10),
			pullUp('2026-10-19', 20, 12),
			pullUp('2026-10-26', 20, 13)
		];
		const prs = prTimeline(facts, PULL_UP, TZ);
		expect(prs.map(({ on, kind, value, previous }) => [on, kind, value, previous.value])).toEqual([
			['2026-10-19', 'most_reps', 10, 8],
			['2026-10-26', 'volume', 260, 240]
		]);
	});

	it('agrees with M4’s finish summary on every workout', () => {
		const kit = workoutDayKits({ date: '2026-10-12' }).strength;
		const squat = kit.exercises[0]!;
		const pullUp = kit.exercises[3]!;
		const sessions: [string, [typeof squat, Partial<LoggedSet>][]][] = [
			[
				'2026-10-12',
				[
					[squat, { weight: 100, reps: 5, rpe: 8 }],
					[squat, { weight: 100, reps: 5, rpe: 8 }],
					[pullUp, { weight: null, reps: 8, rpe: 8 }]
				]
			],
			[
				'2026-10-14',
				[
					[squat, { weight: 110, reps: 3, rpe: 9 }],
					[squat, { weight: 100, reps: 5, rpe: 7 }],
					[pullUp, { weight: null, reps: 10, rpe: 9 }]
				]
			],
			[
				'2026-10-16',
				[
					[squat, { weight: 105, reps: 5, rpe: 8 }],
					[squat, { weight: 232.5, unit: 'lb', reps: 3, rpe: 8.5 }],
					[pullUp, { weight: null, reps: 10, rpe: 8 }],
					[pullUp, { weight: 10, reps: 6, rpe: 8 }]
				]
			]
		];
		const views = sessions.map(([day, logs], n) =>
			viewOf(kit, `00000000-0000-4000-8000-0000000000c${n}`, day, logs)
		);
		const facts = views.flatMap(factsOf);
		const ruled = views[0]!.exercises;

		const fromM4 = views.flatMap((view, n) => {
			const earlier = views.slice(0, n).flatMap(factsOf);
			const prior: Record<string, ReturnType<typeof bestsOf> | null> = {};
			for (const id of Object.keys(view.exercises)) {
				const theirs = earlier.filter((s) => s.exercise === id);
				prior[id] = theirs.length ? bestsOf(theirs, view.exercises[id]!) : null;
			}
			return summarizeWorkout(view, prior as PriorBests, { weight: 'kg', distance: 'km' }).prs.map(
				(pr) => ({
					workoutId: view.workout.id,
					exercise: pr.exerciseId,
					kind: pr.kind,
					reps: pr.reps,
					value: pr.value,
					previous: pr.previous
				})
			);
		});
		const fromTimeline = [squat, pullUp].flatMap(({ exercise: { id } }) =>
			prTimeline(
				facts.filter((s) => s.exercise === id),
				ruled[id]!,
				TZ
			)
				.filter((pr) => pr.kind !== 'volume')
				.map((pr) => ({
					workoutId: pr.workoutId,
					exercise: id,
					kind: pr.kind,
					reps: pr.reps,
					value: cleanFloat(pr.value),
					previous: cleanFloat(pr.previous.value)
				}))
		);
		const order = (prs: typeof fromTimeline) =>
			[...prs].sort((a, b) =>
				`${a.workoutId}${a.exercise}${a.kind}${a.reps}`.localeCompare(
					`${b.workoutId}${b.exercise}${b.kind}${b.reps}`
				)
			);
		expect(fromTimeline.length).toBeGreaterThanOrEqual(3);
		expect(order(fromTimeline)).toEqual(order(fromM4));
	});
});

describe('weekly tonnage, hard sets and muscle groups', () => {
	// The worked example of the README: 3 hard rows and a hard squat set in the week of 2 November.
	const week = '2026-11-02';
	const facts = [
		...[1, 2, 3].map(() => set(week, { exercise: 'barbell_row', weight: 80, reps: 8, rpe: 8 })),
		set(week, { rpe: 7 }),
		set(week, { rpe: 6 }), // not hard
		set(week, { exercise: 'plank', weight: null, reps: null, seconds: 60, rpe: null }), // hard, no tonnage
		set('2026-10-12', { exercise: 'pull_up', weight: null, reps: 10, rpe: 9 })
	];

	it('adds M1’s volumeLoad through M4’s volumeOf, every complete week then the week so far', () => {
		const points = weeklyTonnage(facts, EXERCISES, TZ, WINDOW);
		expect(points.map((p) => p.at)).toEqual([...WEEKS, '2026-11-09']);
		expect(points.map((p) => p.inProgress)).toEqual([false, false, false, false, true]);
		const rows = volumeLoad([1, 2, 3].map(() => ({ weight: 80, reps: 8 })));
		const squats = volumeLoad([
			{ weight: 100, reps: 5 },
			{ weight: 100, reps: 5 }
		]);
		// An unweighted pull-up counts 0 kg; a plank counts nothing.
		expect(points.map((p) => p.value)).toEqual([0, 0, 0, rows + squats, 0]);
		expect(rows + squats).toBe(2920);
	});

	it('counts hard sets as M3’s hardSets does', () => {
		const weeks = weeklyHardSets(facts, EXERCISES, TZ, WINDOW);
		const m3 = hardSets(facts, EXERCISES, TZ);
		const byWeek = new Map(m3.map((w) => [w.weekStart, w]));
		for (const w of weeks) {
			expect(w.muscles).toEqual(byWeek.get(w.weekStart)?.muscles ?? {});
			expect(w.groups).toEqual(byWeek.get(w.weekStart)?.groups ?? {});
		}
		expect(weeks.map((w) => w.sets)).toEqual([1, 0, 0, 5, 0]);
		expect(weeks.at(-1)).toMatchObject({ weekStart: '2026-11-09', inProgress: true });
		// 1.0 for each primary muscle, 0.5 for each secondary, each group once at its best credit.
		expect(weeks[3]!.groups).toEqual({
			back: 3.5,
			shoulders: 1.5,
			biceps: 1.5,
			forearms: 1.5,
			core: 1,
			hips: 1,
			quads: 1
		});
		expect(weeks[3]!.muscles).toMatchObject({
			lats: 3,
			upper_back: 3,
			rear_delts: 1.5,
			lower_back: 2
		});
	});

	it('reads each group against its range, both ends included', () => {
		const targets = new Map<string, GroupTargets>([
			[week, { chest: [10, 20], back: [3.5, 10], biceps: [0, 1], hips: [1.5, 4], quads: [0.5, 1] }]
		]);
		const weeks = muscleGroupWeeks(weeklyHardSets(facts, EXERCISES, TZ, WINDOW), targets);
		expect(weeks[3]!.groups.map(({ group, sets, status }) => [group, sets, status])).toEqual([
			['chest', 0, 'below'],
			['back', 3.5, 'within'], // at the low edge
			['shoulders', 1.5, 'no_target'],
			['biceps', 1.5, 'above'],
			['forearms', 1.5, 'no_target'],
			['core', 1, 'no_target'],
			['hips', 1, 'below'],
			['quads', 1, 'within'] // at the high edge
		]);
		expect(weeks[0]!.groups).toEqual([
			{ group: 'back', sets: 1, target: null, status: 'no_target' },
			{ group: 'shoulders', sets: 0.5, target: null, status: 'no_target' },
			{ group: 'biceps', sets: 0.5, target: null, status: 'no_target' },
			{ group: 'forearms', sets: 0.5, target: null, status: 'no_target' }
		]);
		expect(weeks.at(-1)).toEqual({ weekStart: '2026-11-09', inProgress: true, groups: [] });
		const backwards = new Map<string, GroupTargets>([[week, { back: [10, 3] }]]);
		expect(() => muscleGroupWeeks(weeklyHardSets(facts, EXERCISES, TZ, WINDOW), backwards)).toThrow(
			RangeError
		);
	});

	it('throws for a set whose exercise it does not know', () => {
		const unknown = [set(week, { exercise: 'zercher_squat' })];
		expect(() => weeklyTonnage(unknown, EXERCISES, TZ, WINDOW)).toThrow(RangeError);
		expect(() => weeklyHardSets(unknown, EXERCISES, TZ, WINDOW)).toThrow(RangeError);
	});
});

describe('the owner’s calendar and the week in progress', () => {
	it('keeps a Sunday-evening set in Los Angeles in its week', () => {
		// 20:00 on Sunday 8 November in Los Angeles is 04:00 on Monday 9 November in UTC.
		const sunday = set('2026-11-08', { performedAt: new Date('2026-11-09T04:00:00Z'), rpe: 8 });
		const points = weeklyTonnage([sunday], EXERCISES, TZ, WINDOW);
		expect(points.at(-2)).toEqual({ at: '2026-11-02', value: 500, inProgress: false });
		expect(points.at(-1)).toEqual({ at: '2026-11-09', value: 0, inProgress: true });
		expect(weeklyHardSets([sunday], EXERCISES, TZ, WINDOW).at(-2)!.sets).toBe(1);
		expect(weeklyRpe([sunday], TZ, WINDOW).at(-2)!.value).toBe(8);
		expect(e1rmSeries([sunday], SQUAT, TZ)[0]!.on).toBe('2026-11-08');
	});

	it('flags the week in progress on a Wednesday, and lists Tuesday’s PR', () => {
		const facts = [set('2026-11-02'), set('2026-11-10', { weight: 105 })];
		const points = weeklyTonnage(facts, EXERCISES, TZ, WINDOW);
		expect(points.at(-1)).toEqual({ at: '2026-11-09', value: 525, inProgress: true });
		expect(totalOf(points)).toBe(500);
		expect(weeklyHardSets(facts, EXERCISES, TZ, WINDOW).at(-1)).toMatchObject({
			inProgress: true,
			sets: 1
		});
		const prs = prTimeline(facts, SQUAT, TZ);
		expect(prs.map((pr) => [pr.on, pr.kind])).toEqual([
			['2026-11-10', 'e1rm'],
			['2026-11-10', 'rep_max'],
			['2026-11-10', 'volume']
		]);
	});
});

describe('RPE', () => {
	it('averages the working sets that have an RPE, and says how many do', () => {
		const facts = [
			set('2026-10-12', { rpe: 7 }),
			set('2026-10-12', { rpe: 8.5 }),
			set('2026-10-12', { rpe: null }),
			set('2026-10-12', { rpe: 9, isWarmup: true }),
			set('2026-10-19', { rpe: 9 })
		];
		expect(rpeSummary(facts)).toEqual({ mean: 8.166667, sets: 4, rated: 3, share: 0.75 });
		expect(rpeSummary([])).toEqual({ mean: null, sets: 0, rated: 0, share: null });
		expect(weeklyRpe(facts, TZ, WINDOW).map((p) => p.value)).toEqual([7.75, 9, null, null, null]);
	});
});

describe('keyLifts', () => {
	it('puts profile lifts first, then the most trained, at most six', () => {
		const others = ['a', 'b', 'c', 'd', 'e', 'f'];
		const exercises = new Map<
			string,
			Pick<StrengthExercise, 'measure' | 'loadType' | 'baselineLift'>
		>([
			['back_squat', SQUAT],
			['pull_up', PULL_UP],
			...others.map((id) => [id, { ...ROW, baselineLift: null }] as const)
		]);
		const facts = [
			set('2026-10-12'), // the squat once
			...others.flatMap((id, i) =>
				Array.from({ length: i + 1 }, (_, n) => set(`2026-10-${13 + n}`, { exercise: id }))
			),
			...[1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
				set(`2026-10-${10 + n}`, { exercise: 'pull_up', weight: null })
			)
		];
		const lifts = keyLifts(facts, exercises);
		expect(lifts).toHaveLength(KEY_LIFTS_MAX);
		expect(lifts.map((l) => [l.exercise, l.sessions])).toEqual([
			['back_squat', 1],
			['f', 6],
			['e', 5],
			['d', 4],
			['c', 3],
			['b', 2]
		]);
		expect(lifts[0]!.baselineLift).toBe('back_squat');
	});
});

// ---- M4's views, for the summary agreement ---------------------------------------------------

type Kit = ReturnType<typeof workoutDayKits>['strength'];

function viewOf(
	kit: Kit,
	workoutId: string,
	day: string,
	logs: [Kit['exercises'][number], Partial<LoggedSet>][]
): WorkoutView {
	let second = 0;
	let n = 0;
	const fresh = () => `${workoutId}-m${++n}`;
	const make = <T extends MutationType>(
		type: T,
		input: Omit<MutationInput<T>, 'workoutId' | 'at'>
	): MutationOf<T> =>
		createMutation(
			type,
			{ workoutId, at: new Date(noon(day).getTime() + 1000 * ++second).toISOString(), ...input },
			fresh
		);
	const indexes = new Map<number, number>();
	const pending: Mutation[] = [
		make('workout.start', {
			entityId: workoutId,
			payload: {
				kind: kit.kind,
				title: kit.title,
				sessionType: kit.sessionType,
				discipline: kit.discipline,
				plannedSessionId: kit.plannedSessionId,
				plannedLineage: kit.plannedLineage,
				programId: kit.programId
			}
		}),
		...logs.map(([planned, fields]) => {
			const setIndex = (indexes.get(planned.position) ?? 0) + 1;
			indexes.set(planned.position, setIndex);
			return make('set.log', {
				entityId: fresh(),
				payload: {
					position: planned.position,
					plannedLineage: planned.plannedLineage,
					setIndex,
					exerciseId: planned.exercise.id,
					reps: 5,
					seconds: null,
					metres: null,
					weight: 100,
					assistance: null,
					unit: 'kg',
					rpe: 8,
					missedReps: 0,
					isWarmup: false,
					isExtra: false,
					...fields
				}
			});
		})
	];
	return project(strengthTable, { workoutId, kit, canonical: null, pending })!;
}

function factsOf(view: WorkoutView): StrengthFact[] {
	return view.slots.flatMap((slot) =>
		slot.sets.map((s) => ({
			exercise: s.exerciseId,
			weight: s.weight,
			unit: s.unit,
			reps: s.reps,
			rpe: s.rpe,
			isWarmup: s.isWarmup,
			isSkipped: s.isSkipped,
			performedAt: new Date(s.performedAt),
			seconds: s.seconds,
			metres: s.metres,
			assistance: s.assistance,
			missedReps: s.missedReps,
			isExtra: s.isExtra,
			id: s.id,
			workoutId: view.workout.id,
			plannedLineage: s.plannedLineage,
			setIndex: s.setIndex,
			deletedAt: null
		}))
	);
}
