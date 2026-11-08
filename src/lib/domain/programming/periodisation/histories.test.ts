import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, mondayOf } from '../../calendar';
import { acuteChronicRatio } from '../../load';
import { weeklyRunning } from '../../analytics/running';
import * as strength from '../../analytics/strength';
import * as workload from '../../analytics/workload';
import { catalogueByKey } from '../../exercises/index';
import { composeWeeklyReview } from '../review/weekly';
import type { ReviewExercise } from '../review/weekly';
import { LOWER_BODY_PATTERNS } from '../rules/results';
import { HISTORIES } from './histories';
import type { FactHistory, HistoryKey } from './histories';
import { m7Day } from './scenarios';

const KEYS = Object.keys(HISTORIES) as HistoryKey[];

const exercisesOf = (h: FactHistory) =>
	new Map<string, ReviewExercise>(
		[...new Set(h.sets.map((s) => s.exercise))].map((key) => {
			const entry = catalogueByKey.get(key);
			if (!entry) throw new Error(`Not in the catalogue: ${key}`);
			return [key, { ...entry, name: entry.name }];
		})
	);

/** The history's last week reviewed by M6, as it reads the facts its loader gives. */
function review(h: FactHistory) {
	return composeWeeklyReview({
		weekStartsOn: h.lastWeek,
		today: addDays(h.lastWeek, 7),
		timeZone: h.timeZone,
		unit: 'kg',
		distanceUnit: 'km',
		week: { kind: 'accumulation', sessions: [] },
		next: { state: 'planned', kind: 'accumulation' },
		completedLineages: new Set(h.workouts.flatMap((w) => w.plannedLineage ?? [])),
		workouts: h.workouts,
		sets: h.sets,
		runs: h.runs,
		recovery: h.recovery,
		prescriptions: h.prescriptions,
		exercises: exercisesOf(h),
		targets: { band: null, volumeFactor: 1, planned: null, label: 'No target' },
		digest: {
			facts: h.sets.map((s) => ({ kind: 'set', id: s.id, updatedAt: s.performedAt })),
			workouts: h.workouts.map((w) => ({ id: w.id, status: 'completed' }))
		}
	});
}

/** The history's days, first workout to last Sunday, as M6's daily loads. */
function dailyLoads(h: FactHistory) {
	const loads = workload.sessionLoads(h.workouts, h.timeZone);
	const first = loads.map((l) => l.date).sort()[0]!;
	return workload.dailyLoads(loads, first, addDays(h.lastWeek, 6));
}

/** The history's complete weeks, and the week after it in progress. */
const window = (h: FactHistory) => ({
	weeks: {
		from: h.firstWeek,
		to: addDays(h.lastWeek, 6),
		count: daysBetween(h.firstWeek, h.lastWeek) / 7 + 1
	},
	inProgress: { weekStart: addDays(h.lastWeek, 7), through: addDays(h.lastWeek, 7), days: 1 }
});

describe('HISTORIES', () => {
	it.each(KEYS)('%s is deterministic and a fresh copy on every call', (key) => {
		const first = HISTORIES[key]();
		expect(HISTORIES[key]()).toEqual(first);
		first.workouts.length = 0;
		expect(HISTORIES[key]().workouts.length).toBeGreaterThan(0);
	});

	it.each(KEYS)('%s ends in week 0 by default, and moves whole weeks with endWeek', (key) => {
		const h = HISTORIES[key]();
		expect(h.lastWeek).toBe(m7Day(0, 0));
		const days = [
			...h.workouts.map((w) => w.startedAt),
			...h.sets.map((s) => s.performedAt),
			...h.runs.map((r) => r.startedAt)
		].map((at) => at.toISOString().slice(0, 10));
		days.push(...h.recovery.map((r) => r.notedOn), ...h.prescriptions.map((p) => p.day));
		for (const day of days) {
			expect(day >= h.firstWeek && day <= addDays(h.lastWeek, 6)).toBe(true);
			expect(mondayOf(day) <= h.lastWeek).toBe(true);
		}
		const later = HISTORIES[key](5);
		expect(later.lastWeek).toBe(m7Day(5, 0));
		expect(later.workouts.map((w) => w.startedAt.getTime() - 35 * 86_400_000)).toEqual(
			h.workouts.map((w) => w.startedAt.getTime())
		);
	});

	it.each(KEYS)("%s has M6's fact shapes: every row reads through M6's functions", (key) => {
		const h = HISTORIES[key]();
		const ids = new Set(h.workouts.map((w) => w.id));
		expect(ids.size).toBe(h.workouts.length);
		// Every session has a known load: an RPE and a duration.
		expect(workload.sessionLoads(h.workouts, h.timeZone).every((l) => l.load !== null)).toBe(true);
		// Every set, run and prescription belongs to a workout of the history.
		for (const set of h.sets) expect(ids).toContain(set.workoutId);
		for (const r of h.runs) expect(ids).toContain(r.workout);
		for (const p of h.prescriptions) expect(ids).toContain(p.workoutId);
		// Every lift has an e1RM per session from M4's rules.
		const exercises = exercisesOf(h);
		for (const [key, sets] of Map.groupBy(h.sets, (s) => s.exercise))
			expect(strength.e1rmSeries(sets, exercises.get(key)!, h.timeZone).length).toBe(
				new Set(sets.map((s) => s.workoutId)).size
			);
		expect(() => review(h)).not.toThrow();
	});
});

describe("M6's fatigue verdict pins each history's intent", () => {
	it('reads the steady weeks as no fatigue', () => {
		expect(review(HISTORIES.steady()).snapshot.fatigue).toEqual({ level: 'none', reasons: [] });
	});

	it('reads the declining weeks as high: real e1RM declines, RPE creep, soreness and short sleep', () => {
		const { fatigue } = review(HISTORIES.declining()).snapshot;
		expect(fatigue.level).toBe('high');
		expect(fatigue.reasons).toEqual([
			'You have been sore (4 of 5)',
			'You have slept 5.9 hours a night',
			'The same loads feel 0.7 RPE harder',
			'2 lifts are declining while feeling harder'
		]);
	});

	it('reads the overreaching run as at least watch, from its monotony', () => {
		const { fatigue } = review(HISTORIES.overreachingRun()).snapshot;
		expect(['watch', 'high']).toContain(fatigue.level);
		expect(fatigue.reasons[0]).toMatch(/^Your training days have been very alike/);
	});
});

describe('what each history holds', () => {
	it('declines squat and bench at equal loads over the last three weeks', () => {
		const h = HISTORIES.declining();
		const exercises = exercisesOf(h);
		for (const lift of ['back_squat', 'bench_press']) {
			const sets = h.sets.filter((s) => s.exercise === lift);
			expect(new Set(sets.map((s) => s.weight)).size).toBe(1);
			const e1rm = strength.e1rmSeries(sets, exercises.get(lift)!, h.timeZone).map((p) => p.value);
			const [steady, ...falling] = e1rm.slice(2);
			expect(falling).toHaveLength(3);
			expect(falling[0]!).toBeLessThan(steady!);
			expect(falling[1]!).toBeLessThan(falling[0]!);
			expect(falling[2]!).toBeLessThan(falling[1]!);
		}
	});

	it('raises the overreaching mileage 35 % in two weeks', () => {
		const h = HISTORIES.overreachingRun();
		const km = weeklyRunning(h.runs, window(h), 'km', h.timeZone).weeks.map((w) => w.distance);
		expect(km).toEqual([40, 40, 40, 40, 47, 54]);
		expect(km.at(-1)! / km.at(-3)!).toBeCloseTo(1.35, 2);
	});

	it('holds hard sparring on Monday and pads on Wednesday in the camp week', () => {
		const h = HISTORIES.hardCampWeek();
		expect(h.workouts.map((w) => [w.startedAt.getUTCDay(), w.other?.kind, w.sessionRpe])).toEqual([
			[1, 'sparring', 9],
			[3, 'pad_work', 7]
		]);
	});

	it('runs 60 km with 18 lower-body hard sets in the big run week', () => {
		const h = HISTORIES.bigRunWeek();
		expect(h.runs.reduce((sum, r) => sum + r.metres!, 0)).toBe(60_000);
		const exercises = exercisesOf(h);
		const lower = h.sets.filter(
			(s) =>
				LOWER_BODY_PATTERNS.includes(exercises.get(s.exercise)!.pattern) &&
				s.rpe !== null &&
				s.rpe >= 7
		);
		const week = strength.weeklyHardSets(h.sets, exercises, h.timeZone, window(h))[0]!;
		expect(lower).toHaveLength(18);
		expect(week.sets).toBe(18);
	});

	it("logs 20 days in the short history, where M1's ratio is still null", () => {
		const h = HISTORIES.shortHistory();
		const days = dailyLoads(h);
		expect(days).toHaveLength(20);
		expect(acuteChronicRatio(days.map((d) => d.load ?? 0))).toBeNull();
		expect(workload.acwr(days)).toBeNull();
		// A full steady history is long enough to read.
		expect(workload.acwr(dailyLoads(HISTORIES.steady()))).not.toBeNull();
	});
});
