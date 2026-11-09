import { describe, expect, it } from 'vitest';
import { sessionLoads } from '../../analytics/workload';
import { factTime, HISTORIES, runFact, setFact, workoutFact } from '../periodisation/histories';
import { fromLogged } from './from-facts';
import { systemLoads } from './systems';

const DAY = '2026-11-09';

const set = (id: string, exercise: string, rpe: number | null, over = {}) =>
	setFact({ id, workoutId: 'lift', exercise, rpe, performedAt: factTime(DAY), ...over });

describe('fromLogged', () => {
	it('splits a strength workout’s live working sets by region, heavy at RPE 8 on a compound lift', () => {
		const [session] = fromLogged({
			workouts: [workoutFact({ id: 'lift', sessionType: 'strength', startedAt: factTime(DAY) })],
			sets: [
				set('s1', 'back_squat', 8),
				set('s2', 'back_squat', 8.5),
				set('s3', 'back_squat', 7),
				set('s4', 'back_squat', 6), // not hard
				set('s5', 'back_squat', 9, { isWarmup: true }),
				set('s6', 'back_squat', 9, { isSkipped: true }),
				set('s7', 'back_squat', 9, { deletedAt: new Date('2026-11-10T00:00:00Z') }),
				set('s8', 'lying_leg_curl', 9), // hard, but not a compound lift
				set('s9', 'bench_press', null), // no RPE: hard by M3's rule, never heavy
				set('s10', 'unknown_lift', 9)
			],
			runs: [],
			timeZone: 'UTC'
		});
		expect(session).toMatchObject({
			kind: 'strength',
			source: 'logged',
			workoutId: 'lift',
			plannedLineage: 'lineage-lift',
			sets: { lower: { hard: 4, heavy: 2 }, upper: { hard: 1, heavy: 0 } }
		});
	});

	it('has M6’s minutes, RPE and day for every workout, so its basis is M6’s load', () => {
		const h = HISTORIES.steady();
		const facts = [
			...h.workouts,
			workoutFact({
				id: 'late',
				sessionType: 'conditioning',
				startedAt: new Date('2026-11-09T23:30:00Z'),
				sessionRpe: null,
				durationSeconds: null,
				other: { kind: 'conditioning', durationMinutes: 40, rpe: 6, metrics: [] }
			})
		];
		const m6 = sessionLoads(facts, 'Asia/Tokyo');
		const ours = fromLogged({ ...h, workouts: facts, timeZone: 'Asia/Tokyo' });
		ours.forEach((session, i) => {
			expect(session.date).toBe(m6[i]!.date);
			expect(systemLoads(session).basis).toBe(m6[i]!.load);
		});
		expect(ours.at(-1)).toMatchObject({ date: '2026-11-10', minutes: 40, rpe: 6 });
	});

	it('reads a run’s intervals and length, and a Muay Thai session’s format and rounds', () => {
		const h = HISTORIES.hardCampWeek();
		const fartlek = workoutFact({
			id: 'fartlek',
			sessionType: 'easy_run',
			startedAt: factTime(DAY),
			discipline: 'running',
			durationSeconds: 95 * 60,
			run: { durationSeconds: 95 * 60, rpe: 6 }
		});
		const segment = {
			kind: 'interval' as const,
			distanceMetres: 400,
			durationSeconds: 90,
			avgHr: null
		};
		const [run, ...combat] = fromLogged({
			workouts: [fartlek, ...h.workouts],
			sets: [],
			runs: [
				runFact({
					workout: 'fartlek',
					startedAt: factTime(DAY),
					sessionType: 'easy_run',
					metres: 16_000,
					segments: [segment]
				})
			],
			timeZone: 'UTC'
		});
		expect(run).toMatchObject({ kind: 'run', metres: 16_000, intervals: true, long: true });
		expect(combat.map((s) => s.kind === 'other' && [s.format, s.rounds])).toEqual([
			['sparring', 8],
			['pad_work', 6]
		]);
	});

	it('numbers each day’s workouts by start time, whatever order they come in', () => {
		const at = (minutes: number) => factTime(DAY, minutes);
		const sessions = fromLogged({
			workouts: [
				workoutFact({ id: 'pm', sessionType: 'strength', startedAt: at(600) }),
				workoutFact({ id: 'am', sessionType: 'strength', startedAt: at(0) }),
				workoutFact({ id: 'next', sessionType: 'strength', startedAt: factTime('2026-11-10') })
			],
			sets: [],
			runs: [],
			timeZone: 'UTC'
		});
		expect(sessions.map((s) => [s.workoutId, s.orderInDay])).toEqual([
			['pm', 2],
			['am', 1],
			['next', 1]
		]);
	});
});
