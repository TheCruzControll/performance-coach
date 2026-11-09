import { describe, expect, it } from 'vitest';
import { addDays } from '../calendar';
import type { RaceResult } from '../profile/types';
import type { RunSegmentKind, SessionType } from '../training/vocabulary';
import { cleanFloat, toMetres } from '../units';
import { runTotals, segmentPace } from '../workout/run';
import { periodWindow } from './periods';
import {
	bestEfforts,
	EFFORT_TOLERANCE,
	heartRateByType,
	HR_MIN_RUNS,
	longRuns,
	paceByType,
	plannedMetres,
	plannedMileage,
	runFrequency,
	runPace,
	weeklyRunning,
	wholeRun
} from './running';
import type { PlannedRun, RunFact, RunFactSegment } from './running';
import type { RunSegment } from '../training/types';

// Today is a Wednesday. The four complete weeks before it, Monday first:
const TODAY = '2026-11-04';
const THIS_MONDAY = '2026-11-02';
const LAST_MONDAY = '2026-10-26';
const WEEKS = ['2026-10-05', '2026-10-12', '2026-10-19', LAST_MONDAY] as const;
const WINDOW = periodWindow(TODAY, '4w', null);
const UTC = 'UTC';

/** A run at 08:00 UTC on `day`, 5 km in 25 minutes unless told otherwise. */
function run(workout: string, day: string, more: Partial<RunFact> = {}): RunFact {
	return {
		workout,
		startedAt: new Date(`${day}T08:00:00Z`),
		sessionType: 'easy_run',
		metres: 5000,
		seconds: 1500,
		avgHr: null,
		rpe: null,
		segments: [],
		...more
	};
}

const seg = (
	kind: RunSegmentKind,
	distanceMetres: number | null,
	durationSeconds: number | null,
	avgHr: number | null = null
): RunFactSegment => ({ kind, distanceMetres, durationSeconds, avgHr });

/** The parity test's own statement of which segments show a type's pace. */
const PARTS: Partial<Record<SessionType, RunSegmentKind>> = {
	tempo_run: 'tempo',
	interval_run: 'interval'
};

const week = <T extends { weekStart: string }>(weeks: readonly T[], monday: string) =>
	weeks.find((w) => w.weekStart === monday)!;

describe('weeklyRunning', () => {
	it('adds miles as exact metres and gives the week in the unit asked for', () => {
		const runs = [
			run('a', LAST_MONDAY, { metres: toMetres(5, 'mi') }),
			run('b', addDays(LAST_MONDAY, 2), { metres: toMetres(3.1, 'mi') })
		];
		const { weeks } = weeklyRunning(runs, WINDOW, 'mi', UTC);
		const last = week(weeks, LAST_MONDAY);
		expect(last.metres).toBe(13035.6864);
		expect(last.distance).toBe(8.1);
		expect(weeklyRunning(runs, WINDOW, 'km', UTC).weeks.at(-1)!.distance).toBe(13.035686);
	});

	it('zero-fills the weeks with no run and counts runs, time and the longest run', () => {
		const runs = [
			run('a', '2026-10-12', { metres: 8000, seconds: 2700 }),
			run('b', '2026-10-14', { metres: 12000, seconds: 4000 }),
			run('c', '2026-10-16', { metres: null, seconds: 1200 })
		];
		const { weeks, points } = weeklyRunning(runs, WINDOW, 'km', UTC);
		expect(weeks.map((w) => w.weekStart)).toEqual(WEEKS);
		expect(week(weeks, '2026-10-12')).toMatchObject({
			metres: 20000,
			runs: 3,
			seconds: 7900,
			longestMetres: 12000,
			inProgress: false
		});
		expect(week(weeks, '2026-10-05')).toMatchObject({
			metres: 0,
			runs: 0,
			seconds: 0,
			longestMetres: null
		});
		expect(points.map((p) => p.value)).toEqual([0, 20000, 0, 0, 0]);
	});

	it('takes a total the record lacks from the runTotals of its segments', () => {
		const segments = [seg('warm_up', 1000, 360), seg('easy', 6000, 1980)];
		const fact = run('a', LAST_MONDAY, { metres: null, seconds: null, segments });
		expect(wholeRun(fact)).toEqual({ ...runTotals(segments), avgHr: null });
		expect(weeklyRunning([fact], WINDOW, 'km', UTC).weeks.at(-1)).toMatchObject({
			metres: 7000,
			seconds: 2340
		});
	});

	it('keeps a Sunday-evening run in its own week, and flags the week in progress apart', () => {
		const LA = 'America/Los_Angeles';
		// 20:00 on Sunday 1 November in Los Angeles is already Monday 2 November in UTC.
		const sunday = run('sun', '2026-11-01', { startedAt: new Date('2026-11-02T04:00:00Z') });
		const today = run('wed', TODAY, { startedAt: new Date('2026-11-04T15:00:00Z'), metres: 3000 });
		const weekly = weeklyRunning([sunday, today], WINDOW, 'km', LA);
		expect(week(weekly.weeks, LAST_MONDAY).metres).toBe(5000);
		expect(weekly.inProgress).toMatchObject({
			weekStart: THIS_MONDAY,
			inProgress: true,
			metres: 3000,
			runs: 1
		});
		expect(weekly.weeks.every((w) => !w.inProgress)).toBe(true);
		expect(weekly.points.at(-1)).toEqual({ at: THIS_MONDAY, value: 3000, inProgress: true });
		// In UTC the same run falls in the week in progress.
		expect(weeklyRunning([sunday], WINDOW, 'km', UTC).inProgress.metres).toBe(5000);
	});

	it('leaves out runs outside the window', () => {
		const runs = [run('old', '2026-09-28'), run('in', '2026-10-05')];
		const { weeks, inProgress } = weeklyRunning(runs, WINDOW, 'km', UTC);
		expect(weeks.reduce((sum, w) => sum + w.runs, 0) + inProgress.runs).toBe(1);
	});
});

describe('runFrequency', () => {
	it('gives runs per week over the complete weeks, by type, with the week in progress apart', () => {
		const runs = [
			run('a', '2026-10-05'),
			run('b', '2026-10-06', { sessionType: 'tempo_run' }),
			run('c', '2026-10-20', { sessionType: 'long_run' }),
			run('d', LAST_MONDAY),
			run('e', addDays(LAST_MONDAY, 3)),
			run('f', addDays(LAST_MONDAY, 5), { sessionType: 'interval_run' }),
			run('g', THIS_MONDAY)
		];
		expect(runFrequency(runs, WINDOW, UTC)).toEqual({
			runs: 6,
			perWeek: 1.5,
			byType: { easy_run: 3, long_run: 1, tempo_run: 1, interval_run: 1 },
			inProgress: 1
		});
	});

	it('has no average week without a complete week', () => {
		const first = periodWindow(TODAY, 'all', THIS_MONDAY);
		expect(runFrequency([run('g', THIS_MONDAY)], first, UTC)).toMatchObject({
			runs: 0,
			perWeek: null,
			inProgress: 1
		});
	});
});

describe('runPace', () => {
	it('takes interval pace from the interval segments only, weighted by distance', () => {
		const fact = run('i', LAST_MONDAY, {
			sessionType: 'interval_run',
			metres: 7400,
			seconds: 2400,
			segments: [
				seg('warm_up', 2000, 720),
				seg('interval', 800, 160),
				seg('recovery', 200, 90),
				seg('interval', 400, 100),
				seg('recovery', 200, 90),
				seg('interval', null, 60),
				seg('cool_down', 2000, 760)
			]
		});
		const pace = runPace(fact)!;
		expect(pace).toMatchObject({ basis: 'interval', distanceMetres: 1200, durationSeconds: 260 });
		expect(pace.paceSecondsPerKm).toBe(
			segmentPace({ distanceMetres: 1200, durationSeconds: 260 }, 'km')
		);
		// The mean of the two reps' paces (200 and 250 s/km) would be 225: distance weighs them.
		expect(pace.paceSecondsPerKm).toBeCloseTo(216.667, 3);
	});

	it('leaves out intervals with no timed interval segment, never falling back to the whole run', () => {
		const fact = run('i', LAST_MONDAY, {
			sessionType: 'interval_run',
			segments: [seg('warm_up', 2000, 720), seg('interval', null, 120)]
		});
		expect(runPace(fact)).toBeNull();
	});

	it('takes tempo pace from the tempo segments, otherwise from the whole run', () => {
		const segments = [
			seg('warm_up', 2000, 720),
			seg('tempo', 5000, 1250),
			seg('cool_down', 1000, 380)
		];
		const withTempo = run('t', LAST_MONDAY, {
			sessionType: 'tempo_run',
			metres: 8000,
			seconds: 2350,
			segments
		});
		expect(runPace(withTempo)).toMatchObject({
			basis: 'tempo',
			distanceMetres: 5000,
			paceSecondsPerKm: 250
		});
		const without = run('t2', LAST_MONDAY, {
			sessionType: 'tempo_run',
			metres: 8000,
			seconds: 2400
		});
		expect(runPace(without)).toMatchObject({
			basis: 'whole',
			distanceMetres: 8000,
			paceSecondsPerKm: 300
		});
	});

	it('changes pace only for tempo and interval segments of their own run types', () => {
		const segments = [seg('tempo', 2000, 480), seg('interval', 400, 80), seg('steady', 2600, 840)];
		for (const sessionType of ['easy_run', 'recovery_run', 'long_run', 'custom'] as SessionType[]) {
			const fact = run('x', LAST_MONDAY, { sessionType, metres: 5000, seconds: 1400, segments });
			expect(runPace(fact)).toMatchObject({ basis: 'whole', paceSecondsPerKm: 280 });
		}
		// A tempo run's steady and interval segments do not count as tempo.
		const tempo = run('t', LAST_MONDAY, {
			sessionType: 'tempo_run',
			metres: 5000,
			seconds: 1400,
			segments
		});
		expect(runPace(tempo)).toMatchObject({
			basis: 'tempo',
			distanceMetres: 2000,
			paceSecondsPerKm: 240
		});
		const steady = run('s', LAST_MONDAY, {
			sessionType: 'interval_run',
			segments: [seg('steady', 2000, 600), seg('tempo', 2000, 480)]
		});
		expect(runPace(steady)).toBeNull();
	});

	it('leaves out a run without a distance or a time', () => {
		expect(runPace(run('a', LAST_MONDAY, { metres: null }))).toBeNull();
		expect(runPace(run('b', LAST_MONDAY, { seconds: null }))).toBeNull();
	});
});

describe('paceByType', () => {
	it('gives each type its runs, a weekly pace with gaps and the period pace, pooled by distance', () => {
		const runs = [
			run('a', '2026-10-05', { metres: 10000, seconds: 3000 }),
			run('b', '2026-10-07', { metres: 5000, seconds: 1800 }),
			run('c', '2026-10-19', { metres: 5000, seconds: 1450 }),
			run('d', THIS_MONDAY, { metres: 4000, seconds: 1160 }),
			run('l', '2026-10-25', { sessionType: 'long_run', metres: 20000, seconds: 6600 })
		];
		const byType = paceByType(runs, WINDOW, UTC);
		expect(byType.map((t) => t.sessionType)).toEqual(['easy_run', 'long_run']);
		const easy = byType[0]!;
		expect(easy.runs.map((r) => r.workout)).toEqual(['a', 'b', 'c', 'd']);
		expect(easy.points).toEqual([
			{ at: '2026-10-05', value: 320, inProgress: false },
			{ at: '2026-10-12', value: null, inProgress: false },
			{ at: '2026-10-19', value: 290, inProgress: false },
			{ at: LAST_MONDAY, value: null, inProgress: false },
			{ at: THIS_MONDAY, value: 290, inProgress: true }
		]);
		// 6250 s over 20 km, the week in progress left out.
		expect(easy.period).toBe(segmentPace({ distanceMetres: 20000, durationSeconds: 6250 }, 'km'));
		expect(byType[1]!.period).toBe(330);
	});

	it('computes every pace input with M4’s segmentPace and runTotals, across 40 mixed runs', () => {
		const types: SessionType[] = [
			'easy_run',
			'recovery_run',
			'long_run',
			'tempo_run',
			'interval_run'
		];
		const kinds: RunSegmentKind[] = [
			'warm_up',
			'easy',
			'steady',
			'tempo',
			'interval',
			'recovery',
			'long',
			'cool_down'
		];
		const runs = Array.from({ length: 40 }, (_, i): RunFact => {
			const segments = Array.from({ length: i % 7 }, (_, j) =>
				seg(
					kinds[(i * 3 + j * 5) % kinds.length]!,
					(i + j) % 9 === 0 ? null : 397 + 113 * ((i * j + 7) % 11) + (j % 3) * 0.25,
					(i + 2 * j) % 10 === 0 ? null : 71 + 37 * ((i + j) % 13)
				)
			);
			return run(`r${i}`, addDays('2026-10-05', i % 30), {
				sessionType: types[i % types.length]!,
				metres: i % 6 === 0 ? null : 3000 + 997 * (i % 17) + 0.5 * (i % 3),
				seconds: i % 8 === 0 ? null : 900 + 311 * (i % 19),
				segments
			});
		});
		const inputs = paceByType(runs, WINDOW, UTC).flatMap((t) => t.runs);
		const byWorkout = new Map(inputs.map((input) => [input.workout, input]));
		let parts = 0;
		for (const fact of runs) {
			const kind = PARTS[fact.sessionType];
			const timed = fact.segments.filter(
				(s) => s.kind === kind && s.distanceMetres !== null && s.durationSeconds !== null
			);
			const whole = {
				distanceMetres: fact.metres ?? runTotals(fact.segments).distanceMetres,
				durationSeconds: fact.seconds ?? runTotals(fact.segments).durationSeconds
			};
			const amounts =
				timed.length > 0 ? runTotals(timed) : fact.sessionType === 'interval_run' ? null : whole;
			const expected = amounts && segmentPace(amounts, 'km');
			const input = byWorkout.get(fact.workout);
			if (expected === null) {
				expect(input, fact.workout).toBeUndefined();
				continue;
			}
			if (timed.length > 0) parts += 1;
			expect(input, fact.workout).toBeDefined();
			expect(input!.distanceMetres).toBe(amounts!.distanceMetres);
			expect(input!.durationSeconds).toBe(amounts!.durationSeconds);
			expect(input!.paceSecondsPerKm).toBe(expected);
		}
		expect(byWorkout.size).toBeGreaterThan(25);
		expect(parts).toBeGreaterThan(3);
	});
});

describe('longRuns', () => {
	it('takes a long_run session, otherwise the longest run at 1.5 × the week’s mean', () => {
		const runs = [
			// Week 1: the long_run session wins over a longer easy run.
			run('ls', '2026-10-11', { sessionType: 'long_run', metres: 14000 }),
			run('e1', '2026-10-06', { metres: 15000 }),
			// Week 2: 16 km against a mean of 10 km (16 + 7 + 7) ÷ 3 is 1.6 × the mean.
			run('l2', '2026-10-18', { metres: 16000 }),
			run('e2', '2026-10-13', { metres: 7000 }),
			run('e3', '2026-10-15', { metres: 7000 }),
			// Week 3: 12 km against a mean of 9 km is only 1.33 ×.
			run('l3', '2026-10-25', { metres: 12000 }),
			run('e4', '2026-10-20', { metres: 6000 }),
			// Week 4: one run alone is never 1.5 × its own mean.
			run('l4', '2026-11-01', { metres: 18000 })
		];
		const weeks = longRuns(runs, WINDOW, UTC);
		expect(weeks.map((w) => [w.run?.workout ?? null, w.found])).toEqual([
			['ls', 'long_run_session'],
			['l2', 'longest_run'],
			[null, null],
			[null, null],
			[null, null]
		]);
		expect(weeks.at(-1)!.inProgress).toBe(true);
	});

	it('flags a long run more than 10 % longer than the one before, across a week without one', () => {
		const long = (workout: string, day: string, metres: number): RunFact =>
			run(workout, day, { sessionType: 'long_run', metres });
		const weeks = longRuns(
			[
				long('a', '2026-10-11', 10000),
				long('b', '2026-10-18', 11000),
				long('d', '2026-11-01', 12101)
			],
			WINDOW,
			UTC
		);
		expect(weeks.map((w) => [w.previousMetres, w.changePct, w.jump])).toEqual([
			[null, null, false],
			[10000, 10, false],
			[11000, null, false],
			[11000, 10.009091, true],
			[12101, null, false]
		]);
	});
});

describe('bestEfforts', () => {
	const at5k = (workout: string, metres: number, seconds = 1500) =>
		run(workout, LAST_MONDAY, { metres, seconds });

	it('counts runs within ±2 % of a standard distance, edges included', () => {
		expect(EFFORT_TOLERANCE).toBe(0.02);
		const efforts = bestEfforts(
			[
				at5k('low', 4900),
				at5k('high', 5100),
				at5k('under', 4899.9),
				at5k('over', 5100.1),
				at5k('half', cleanFloat(21097.5 * 0.98), 6000),
				at5k('marathon', 43038.9, 12600)
			],
			[]
		);
		const ids = Object.fromEntries(efforts.map((d) => [d.distance, d.efforts.map((e) => e.id)]));
		expect(ids).toEqual({
			'5k': ['low', 'high'],
			'10k': [],
			half_marathon: ['half'],
			marathon: ['marathon']
		});
	});

	it('labels the fastest logged effort by pace best effort, and M2’s race results reported', () => {
		const races: RaceResult[] = [
			{
				id: 'race-1',
				distance: '5k',
				customDistance: null,
				distanceMetres: 5000,
				timeSeconds: 1320,
				racedOn: '2026-05-10',
				eventName: 'Spring 5K'
			},
			{
				id: 'race-2',
				distance: 'other',
				customDistance: 5,
				distanceMetres: 5000,
				timeSeconds: 1300,
				racedOn: null,
				eventName: null
			}
		];
		// 4.9 km in 24:30 (300 s/km) is slower than 5.1 km in 25:00 (294.1 s/km), though shorter.
		const [fiveK, tenK] = bestEfforts([at5k('short', 4900, 1470), at5k('long', 5100, 1500)], races);
		expect(fiveK!.efforts.map((e) => [e.id, e.label, e.kind])).toEqual([
			['short', 'effort', 'measured'],
			['long', 'best_effort', 'measured']
		]);
		expect(fiveK!.best!.id).toBe('long');
		expect(fiveK!.reported).toEqual([
			{
				id: 'race-1',
				label: 'reported',
				kind: 'reported',
				on: '2026-05-10',
				distanceMetres: 5000,
				durationSeconds: 1320,
				paceSecondsPerKm: 264,
				eventName: 'Spring 5K'
			}
		]);
		expect(tenK).toMatchObject({ distance: '10k', label: '10K', metres: 10000, best: null });
	});
});

describe('heartRateByType', () => {
	const withHr = (workout: string, day: string, avgHr: number, seconds = 1800) =>
		run(workout, day, { avgHr, seconds });

	it('shows a type’s heart rate only once HR_MIN_RUNS of its runs in the period carry one', () => {
		expect(HR_MIN_RUNS).toBe(4);
		const three = [
			withHr('a', '2026-10-05', 140),
			withHr('b', '2026-10-12', 150),
			withHr('c', '2026-10-19', 145),
			run('none', '2026-10-20'),
			// The week in progress is not part of the period.
			withHr('now', THIS_MONDAY, 160)
		];
		expect(heartRateByType(three, WINDOW, UTC)).toEqual([
			{
				sessionType: 'easy_run',
				tracked: 3,
				availability: { ready: false, have: 3, need: 4, unit: 'runs' },
				avgHr: null
			}
		]);
		const four = [...three, withHr('d', LAST_MONDAY, 160, 3600)];
		// Time-weighted, as M4's runTotals weighs segments: (140 + 150 + 145) × 30 + 160 × 60 over 180 minutes.
		expect(heartRateByType(four, WINDOW, UTC)).toEqual([
			{ sessionType: 'easy_run', tracked: 4, availability: { ready: true }, avgHr: 151 }
		]);
	});

	it('lists nothing when heart rate was never tracked, and reads it from segments when the record has none', () => {
		expect(heartRateByType([run('a', LAST_MONDAY)], WINDOW, UTC)).toEqual([]);
		const segments = [seg('easy', 5000, 1500, 150)];
		const runs = WEEKS.map((monday, i) =>
			run(`s${i}`, monday, { sessionType: 'tempo_run', segments })
		);
		expect(heartRateByType(runs, WINDOW, UTC)).toMatchObject([
			{ sessionType: 'tempo_run', tracked: 4, avgHr: 150 }
		]);
	});
});

describe('planned mileage', () => {
	const planSeg = (kind: RunSegmentKind, over: Partial<RunSegment> = {}): RunSegment => ({
		...{ kind, repeatGroup: null, repeats: null, distanceMetres: null, durationSeconds: null },
		...{ paceMinSecondsPerKm: null, paceMaxSecondsPerKm: null, hrZone: null, targetRpe: null },
		...over
	});
	const reps = { repeatGroup: 1, repeats: 4 };
	const intervals = [
		planSeg('warm_up', { distanceMetres: 2000 }),
		planSeg('interval', { ...reps, distanceMetres: 800 }),
		planSeg('recovery', { ...reps, distanceMetres: 200 }),
		planSeg('cool_down', { distanceMetres: 1500 })
	];
	const planned = (
		lineage: string,
		date: string,
		segments: RunSegment[],
		more = {}
	): PlannedRun => ({
		...{ lineage, date, status: 'planned', segments },
		...more
	});

	it('counts each repeat of a group and gives none for a run planned by time', () => {
		expect(plannedMetres(intervals)).toBe(2000 + 4 * (800 + 200) + 1500);
		expect(plannedMetres([planSeg('long', { distanceMetres: 18000 })])).toBe(18000);
		const timedRecoveries = intervals.map((s) =>
			s.kind === 'recovery' ? { ...s, distanceMetres: null, durationSeconds: 90 } : s
		);
		expect(plannedMetres(timedRecoveries)).toBeNull();
		expect(plannedMetres([])).toBeNull();
	});

	it('adds each week by the day a run is planned on, skipped sessions and timed runs left out', () => {
		const long = [planSeg('long', { distanceMetres: 16000 })];
		const timed = [planSeg('easy', { durationSeconds: 1800 })];
		const weeks = plannedMileage(
			[
				planned('a', WEEKS[2], intervals),
				planned('b', addDays(WEEKS[2], 6), long),
				planned('c', addDays(WEEKS[2], 3), long, { status: 'skipped' }),
				planned('d', LAST_MONDAY, timed),
				planned('e', TODAY, long, { status: 'moved' }),
				planned('f', addDays(TODAY, 7), long)
			],
			WINDOW
		);
		expect(weeks.map((w) => w.weekStart)).toEqual([...WEEKS, THIS_MONDAY]);
		expect(week(weeks, WEEKS[0])).toEqual({
			weekStart: WEEKS[0],
			inProgress: false,
			metres: null,
			byTime: 0
		});
		expect(week(weeks, WEEKS[2])).toMatchObject({ metres: 7500 + 16000, byTime: 0 });
		expect(week(weeks, LAST_MONDAY)).toMatchObject({ metres: null, byTime: 1 });
		expect(week(weeks, THIS_MONDAY)).toMatchObject({ inProgress: true, metres: 16000 });
	});
});
