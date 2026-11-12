import { describe, expect, it } from 'vitest';
import { addDays, mondayOf } from '../calendar';
import { localDay } from '../dates';
import type { SetPrescription } from '../training/types';
import type { PlannedLines } from './prescribed';
import {
	e1rmSeries,
	prsOf,
	prTimeline,
	strengthSessions,
	weeklyHardSets,
	weeklyRpe,
	weeklyTonnage
} from './strength';
import type { StrengthExercise } from './strength';
import { DIGEST_VERSION, packWeek, strengthWeeks, unpackWeek } from './strength-weeks';
import type { PackedWeek, StrengthWeek, WeekFact, WeekParts } from './strength-weeks';

const TZ = 'America/Los_Angeles';
const MONDAYS = [
	'2026-09-28',
	'2026-10-05',
	'2026-10-12',
	'2026-10-19',
	'2026-10-26',
	'2026-11-02'
];

const EXERCISES = new Map<string, StrengthExercise>([
	[
		'squat',
		{
			measure: 'reps',
			loadType: 'external',
			primaryMuscles: ['quads', 'glutes'],
			secondaryMuscles: ['adductors', 'lower_back'],
			baselineLift: 'back_squat'
		}
	],
	[
		'row',
		{
			measure: 'reps',
			loadType: 'external',
			primaryMuscles: ['upper_back', 'lats'],
			secondaryMuscles: ['rear_delts', 'biceps'],
			baselineLift: null
		}
	],
	[
		'pull_up',
		{
			measure: 'reps',
			loadType: 'bodyweight',
			primaryMuscles: ['lats', 'upper_back'],
			secondaryMuscles: ['biceps'],
			baselineLift: null
		}
	]
]);

/** A small seeded generator (mulberry32), so a failing case can be replayed by its seed. */
function random(seed: number) {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

let ids = 0;
function fact(at: Date, workoutId: string, fields: Partial<WeekFact> = {}): WeekFact {
	return {
		id: String(++ids),
		workoutId,
		exercise: 'squat',
		exerciseId: 'squat',
		plannedLineage: null,
		setIndex: 1,
		weight: 100,
		unit: 'kg',
		reps: 5,
		rpe: null,
		isWarmup: false,
		isSkipped: false,
		isExtra: false,
		missedReps: 0,
		seconds: null,
		metres: null,
		assistance: null,
		performedAt: at,
		deletedAt: null,
		...fields
	} as WeekFact;
}

/**
 * Two years' worth of randomness in six weeks: workouts on random days and hours (late evenings
 * that run past midnight within the week included, never past a Sunday), each with random sets of
 * random exercises, loads in kg or lb, reps, RPE in half steps or none, warm-ups and skips, and
 * many near-ties, so records are beaten, tied and missed.
 */
function history(seed: number): WeekFact[] {
	const next = random(seed);
	const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
	const facts: WeekFact[] = [];
	for (const monday of MONDAYS) {
		for (let w = 0; w < 1 + Math.floor(next() * 4); w++) {
			const day = addDays(monday, Math.floor(next() * 6));
			// 06:00 to 23:00 in Los Angeles (UTC−7 in October, −8 in November).
			const start = Date.parse(`${day}T13:00:00Z`) + Math.floor(next() * 17) * 3_600_000;
			const workout = `w${seed}-${monday}-${w}`;
			let at = start;
			for (let i = 0; i < 2 + Math.floor(next() * 12); i++) {
				at += Math.floor(next() * 600_000);
				const exercise = pick(['squat', 'row', 'pull_up']);
				const unit = pick(['kg', 'kg', 'lb'] as const);
				facts.push(
					fact(new Date(at), workout, {
						exercise,
						exerciseId: exercise,
						unit,
						weight:
							exercise === 'pull_up' ? pick([null, 10]) : pick([60, 80, 100, 100, 102.5, 225]),
						reps: pick([1, 3, 5, 5, 8, 10, 12]),
						rpe: pick([null, 6, 7, 7.5, 8, 8.5, 9, 10]),
						isWarmup: next() < 0.15,
						isSkipped: next() < 0.05,
						setIndex: i + 1
					})
				);
			}
		}
	}
	return facts.sort((a, b) => a.performedAt.getTime() - b.performedAt.getTime());
}

const sessionsOf = (weeks: readonly StrengthWeek[], exercise: string) =>
	weeks
		.flatMap((week) => week.lifts.filter((l) => l.exercise === exercise))
		.flatMap((l) => l.sessions);

describe('strengthWeeks', () => {
	const seeds = Array.from({ length: 60 }, (_, i) => i + 1);

	it.each(seeds)('gives prTimeline and e1rmSeries back from its weeks (seed %i)', (seed) => {
		const facts = history(seed);
		const weeks = strengthWeeks(facts, EXERCISES, TZ, MONDAYS);
		for (const [id, exercise] of EXERCISES) {
			const sets = facts.filter((set) => set.exercise === id);
			// A week keeps only the bests that beat an earlier session's of that week: the records are
			// the same, each beating the same record before it.
			expect(prsOf(sessionsOf(weeks, id))).toEqual(prTimeline(sets, exercise, TZ));
			const points = sessionsOf(weeks, id).flatMap((s) => (s.point ? [s.point] : []));
			expect(points).toEqual(e1rmSeries(sets, exercise, TZ));
		}
	});

	it('keeps fewer bests than the sessions have, and the histories still hold records', () => {
		let kept = 0;
		let all = 0;
		let records = 0;
		for (const seed of seeds) {
			const facts = history(seed);
			const weeks = strengthWeeks(facts, EXERCISES, TZ, MONDAYS);
			for (const [id, exercise] of EXERCISES) {
				const sets = facts.filter((set) => set.exercise === id);
				kept += sessionsOf(weeks, id).reduce((n, s) => n + s.bests.length, 0);
				all += strengthSessions(sets, exercise, TZ).reduce((n, s) => n + s.bests.length, 0);
				records += prTimeline(sets, exercise, TZ).length;
			}
		}
		expect(kept).toBeLessThan(all);
		expect(records).toBeGreaterThan(seeds.length);
	});

	it.each(seeds)('gives the weekly tonnage, hard sets and RPE back (seed %i)', (seed) => {
		const facts = history(seed);
		const weeks = strengthWeeks(facts, EXERCISES, TZ, MONDAYS);
		const window = {
			weeks: { from: MONDAYS[0]!, to: addDays(MONDAYS.at(-2)!, 6), count: 5 },
			inProgress: { weekStart: MONDAYS.at(-1)!, through: addDays(MONDAYS.at(-1)!, 6), days: 7 }
		};
		expect(weeks.map((w) => w.tonnage ?? 0)).toEqual(
			weeklyTonnage(facts, EXERCISES, TZ, window).map((p) => p.value)
		);
		expect(weeks.map((w) => w.rpe)).toEqual(weeklyRpe(facts, TZ, window).map((p) => p.value));
		expect(
			weeks.map(({ hardSets }) => ({
				sets: hardSets?.sets ?? 0,
				muscles: hardSets?.muscles ?? {},
				groups: hardSets?.groups ?? {}
			}))
		).toEqual(
			weeklyHardSets(facts, EXERCISES, TZ, window).map(({ sets, muscles, groups }) => ({
				sets,
				muscles,
				groups
			}))
		);
	});

	it.each(seeds)('sums a week alone as it sums it among the others (seed %i)', (seed) => {
		const facts = history(seed);
		const together = strengthWeeks(facts, EXERCISES, TZ, MONDAYS);
		// No workout here runs into another week (the latest starts on a Saturday evening).
		const alone = MONDAYS.map(
			(monday) =>
				strengthWeeks(
					facts.filter((set) => weekOf(set) === monday),
					EXERCISES,
					TZ,
					[monday]
				)[0]!
		);
		expect(alone).toEqual(together);
	});

	it.each(seeds)(
		'works out a part the same whichever others it is asked with (seed %i)',
		(seed) => {
			const facts = history(seed);
			const all = strengthWeeks(facts, EXERCISES, TZ, MONDAYS);
			const only = (parts: WeekParts) => strengthWeeks(facts, EXERCISES, TZ, MONDAYS, parts);
			const figures = only({ detail: false, records: false });
			const detail = only({ figures: false, records: false });
			const records = only({ figures: false, detail: false });
			for (const [i, week] of all.entries()) {
				expect(figures[i]).toEqual({
					...week,
					...{ hardSets: null, rpe: null, rpes: [] },
					lifts: week.lifts.map((l) => ({
						...l,
						rpes: [],
						sessions: l.sessions.map((s) => ({ ...s, bests: [] }))
					}))
				});
				expect(detail[i]!.hardSets).toEqual(week.hardSets);
				expect(detail[i]!.rpes).toEqual(week.rpes);
				expect(detail[i]!.lifts.map((l) => l.rpes)).toEqual(week.lifts.map((l) => l.rpes));
				expect(records[i]!.tonnage).toBeNull();
				expect(records[i]!.lifts.map((l) => l.sessions)).toEqual(
					week.lifts.map((l) => l.sessions.map((s) => ({ ...s, point: null })))
				);
			}
		}
	);

	it.each(seeds)('stores a week and reads it back the same, key for key (seed %i)', (seed) => {
		const facts = history(seed);
		for (const week of strengthWeeks(facts, EXERCISES, TZ, MONDAYS)) {
			const stored = JSON.parse(JSON.stringify(packWeek(week))) as PackedWeek;
			expect(JSON.stringify(unpackWeek(week.weekStart, stored))).toBe(JSON.stringify(week));
		}
	});

	it('keeps a workout run past midnight on a Sunday one session, in the week it began', () => {
		// Sunday 1 November, 23:40 in Los Angeles, to Monday 2 November, 00:20.
		const late = [
			fact(new Date('2026-11-02T07:40:00Z'), 'late', { reps: 5, weight: 100 }),
			fact(new Date('2026-11-02T08:20:00Z'), 'late', { reps: 5, weight: 120, setIndex: 2 })
		];
		const [sunday, monday] = strengthWeeks(late, EXERCISES, TZ, ['2026-10-26', '2026-11-02']);
		expect(sunday!.lifts[0]!.sessions).toMatchObject([
			{ workoutId: 'late', on: '2026-11-01', lastOn: '2026-11-02', point: { setId: late[1]!.id } }
		]);
		// Monday's set counts in Monday's week, but its session is Sunday's.
		expect(monday!.tonnage).toBe(600);
		expect(monday!.lifts[0]!.sessions).toEqual([]);
		// Summed alone, each week would split it: the rollups never keep such a week.
		const [alone] = strengthWeeks(late.slice(1), EXERCISES, TZ, ['2026-11-02']);
		expect(alone!.lifts[0]!.sessions).toMatchObject([{ on: '2026-11-02' }]);
	});

	it('puts an exposure in the week its workout started, as the Strength view matches it', () => {
		const line: SetPrescription = {
			role: 'working',
			sets: 2,
			repsMin: 5,
			repsMax: 5,
			seconds: null,
			metres: null,
			targetRpe: 8,
			loadKind: 'rpe_based',
			loadValue: null,
			loadUnit: null,
			loadBasis: null,
			reference1rm: null,
			reference1rmUnit: null,
			restSeconds: null,
			tempo: null,
			notes: null
		} as SetPrescription;
		const planned: PlannedLines = { lineage: 'squat-line', exerciseId: 'squat', lines: [line] };
		const sets = [
			fact(new Date('2026-11-02T07:40:00Z'), 'late', { plannedLineage: 'squat-line', rpe: 9 }),
			fact(new Date('2026-11-02T08:20:00Z'), 'late', {
				plannedLineage: 'squat-line',
				rpe: 8.5,
				setIndex: 2
			})
		];
		const plan = {
			workouts: [{ id: 'late', kind: 'strength', plannedSessionId: 'session', date: '2026-11-01' }],
			prescriptions: new Map([['session', [planned]]]),
			unit: 'kg' as const
		};
		const [sunday, monday] = strengthWeeks(sets, EXERCISES, TZ, ['2026-10-26', '2026-11-02'], {
			plan
		});
		expect(sunday!.exposures).toEqual([
			{
				day: '2026-11-01',
				exerciseId: 'squat',
				substituted: false,
				rpeDeviations: [1, 0.5],
				rpeTargets: [8, 8]
			}
		]);
		expect(monday!.exposures).toEqual([]);
		expect(strengthWeeks(sets, EXERCISES, TZ, ['2026-10-26'])[0]!.exposures).toBeNull();
	});
});

describe('DIGEST_VERSION', () => {
	/**
	 * packWeek of one fixed week under each DIGEST_VERSION: warm-up, skipped, kg, lb and bodyweight
	 * sets, RPEs, records and an exposure, so a change to e1RM, records, load rules, hard sets or
	 * prescription matching changes it. Pin the new figures under the bumped version.
	 */
	const PINNED: Record<number, PackedWeek> = {
		1: {
			ids: ['a', 'b'],
			week: [
				1,
				2643.966266,
				{
					sets: 6,
					muscles: {
						quads: 3,
						glutes: 3,
						adductors: 1.5,
						lower_back: 1.5,
						upper_back: 3,
						lats: 3,
						rear_delts: 1,
						biceps: 1.5
					},
					groups: { quads: 3, hips: 3, back: 4.5, shoulders: 1, biceps: 1.5 }
				},
				8.2,
				[8, 9, 7.5, 9.5, 7]
			],
			lifts: [
				[
					'squat',
					[0, 1],
					1793282400000,
					true,
					[8, 9, 9.5],
					[
						[
							0,
							1,
							1,
							[123.30456226880393, 'rpe-table', 'medium', 's2'],
							[
								['e1rm', null, 123.30456226880393, 's2'],
								['rep_max', 5, 102.5, 's3'],
								['volume', null, 1012.5, null]
							]
						],
						[1, 3, 3, [115.76626240352812, 'rpe-table', 'high', 's6'], [['rep_max', 3, 105, 's6']]]
					]
				],
				[
					'row',
					[0, 1],
					1793283000000,
					true,
					[7],
					[
						[
							0,
							1,
							1,
							[114.58333333333334, 'formula-mean', 'medium', 's4'],
							[
								['e1rm', null, 114.58333333333334, 's4'],
								['rep_max', 5, 100, 's4'],
								['volume', null, 500, null]
							]
						],
						[
							1,
							3,
							3,
							[144.3540074257426, 'rpe-table', 'low', 's8'],
							[
								['e1rm', null, 144.3540074257426, 's8'],
								['rep_max', 8, 102.05828325, 's8'],
								['volume', null, 816.466266, null]
							]
						]
					]
				],
				[
					'pull_up',
					[0],
					1793150400000,
					false,
					[7.5],
					[[0, 1, 1, null, [['most_reps', null, 10, 's5']]]]
				]
			],
			exposures: [[1, 'squat', false, [0], [8]]]
		}
	};

	it('pins the packed figures of a fixed week, so a change to them bumps it', () => {
		// Tuesday 27 October, 18:00 in Los Angeles, and Thursday 29 October, 07:00.
		const tue = (minute: number) => new Date(Date.parse('2026-10-28T01:00:00Z') + minute * 60_000);
		const thu = (minute: number) => new Date(Date.parse('2026-10-29T14:00:00Z') + minute * 60_000);
		const squat = { plannedLineage: 'squat-line' };
		const sets = [
			fact(tue(0), 'a', { id: 's1', weight: 60, isWarmup: true }),
			fact(tue(5), 'a', { id: 's2', ...squat, setIndex: 2, rpe: 8 }),
			fact(tue(10), 'a', { id: 's3', ...squat, setIndex: 3, weight: 102.5, rpe: 9 }),
			fact(tue(15), 'a', { id: 's4', exercise: 'row', exerciseId: 'row', setIndex: 4 }),
			fact(tue(20), 'a', {
				...{ id: 's5', exercise: 'pull_up', exerciseId: 'pull_up', setIndex: 5 },
				...{ weight: null, reps: 10, rpe: 7.5 }
			}),
			fact(thu(0), 'b', { id: 's6', weight: 105, reps: 3, rpe: 9.5 }),
			fact(thu(5), 'b', { id: 's7', weight: 80, reps: 10, isSkipped: true, setIndex: 2 }),
			fact(thu(10), 'b', {
				...{ id: 's8', exercise: 'row', exerciseId: 'row', setIndex: 3 },
				...{ weight: 225, unit: 'lb', reps: 8, rpe: 7 }
			})
		];
		const line = { role: 'working', sets: 2, repsMin: 5, repsMax: 5, targetRpe: 8 };
		const planned: PlannedLines = {
			lineage: 'squat-line',
			exerciseId: 'squat',
			lines: [{ ...line, loadKind: 'rpe_based' } as SetPrescription]
		};
		const plan = {
			workouts: [
				{ id: 'a', kind: 'strength', plannedSessionId: 'session', date: '2026-10-27' },
				{ id: 'b', kind: 'strength', plannedSessionId: null, date: '2026-10-29' }
			],
			prescriptions: new Map([['session', [planned]]]),
			unit: 'kg' as const
		};
		const [week] = strengthWeeks(sets, EXERCISES, TZ, ['2026-10-26'], { plan });
		expect(
			JSON.parse(JSON.stringify(packWeek(week!))),
			'figures changed: bump DIGEST_VERSION and pin the new figures under it'
		).toEqual(PINNED[DIGEST_VERSION]);
	});
});

/** The Monday of a set's day in Los Angeles. */
const weekOf = (set: WeekFact) => mondayOf(localDay(set.performedAt, TZ));
