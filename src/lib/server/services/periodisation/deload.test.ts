/**
 * periodisation/deload.ts's pure half: which week a review's deload targets, and assessDeload over
 * what a weekly review already holds (its snapshot, its context's load days and its plan's weeks),
 * on M7's declining and steady histories (S7) composed by M6's own composeWeeklyReview. The
 * proposal itself runs on Postgres (tests/integration/periodisation/reactive-deload.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '../../../domain/calendar';
import { catalogueByKey } from '../../../domain/exercises/index';
import { loadModel } from '../../../domain/programming/load/fatigue';
import { fromLogged } from '../../../domain/programming/load/from-facts';
import type { CalendarWeek } from '../../../domain/programming/periodisation/deload';
import { HISTORIES, type FactHistory } from '../../../domain/programming/periodisation/histories';
import type { WeeklyReviewSnapshot } from '../../../domain/programming/review/snapshot';
import {
	composeWeeklyReview,
	type ReviewExercise
} from '../../../domain/programming/review/weekly';
import type { WeekKind } from '../../../domain/training/vocabulary';
import {
	assessDeload,
	deloadReasons,
	deloadTargetWeek,
	easyPaceOf,
	liftTrendsOf,
	OVERLOAD_TRIGGER,
	REACTIVE_DELOAD
} from './deload';

const exercisesOf = (h: FactHistory) =>
	new Map<string, ReviewExercise>(
		[...new Set(h.sets.map((s) => s.exercise))].map((key) => {
			const entry = catalogueByKey.get(key)!;
			return [key, { ...entry, name: entry.name }];
		})
	);

/** The history's last week reviewed the Monday after it, as createWeeklyReview composes it. */
function reviewed(h: FactHistory) {
	const today = addDays(h.lastWeek, 7);
	const { snapshot } = composeWeeklyReview({
		weekStartsOn: h.lastWeek,
		today,
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
		digest: { facts: [], workouts: [] }
	});
	const days = loadModel({
		planned: [],
		logged: fromLogged({ ...h, timeZone: 'UTC' }),
		from: h.firstWeek,
		to: addDays(h.lastWeek, 6),
		today
	});
	return {
		snapshot,
		today,
		context: { load: { days } } as Parameters<typeof assessDeload>[1]['context']
	};
}

/** The plan's weeks around the target week: two before it, it, and two after, all accumulation. */
const calendarOf = (
	target: IsoDate,
	kinds: Partial<Record<number, WeekKind>> = {}
): CalendarWeek[] =>
	[-2, -1, 0, 1, 2].map((n) => ({
		startsOn: addDays(target, 7 * n),
		kind: kinds[n] ?? 'accumulation'
	}));

describe('deloadTargetWeek', () => {
	const at = (more: Partial<WeeklyReviewSnapshot>) =>
		({
			weekStartsOn: '2026-11-09',
			next: { weekStartsOn: '2026-11-16', state: 'planned', kind: 'accumulation' },
			noProposal: null,
			...more
		}) as WeeklyReviewSnapshot;

	it("targets M6's next week, even when the review is made on or after its Monday", () => {
		expect(deloadTargetWeek(at({}), '2026-11-16')).toBe('2026-11-16');
		expect(deloadTargetWeek(at({}), '2026-11-19')).toBe('2026-11-16');
	});

	it('targets the week holding today once next week has ended (a late review)', () => {
		expect(deloadTargetWeek(at({ noProposal: 'late' }), '2026-11-25')).toBe('2026-11-23');
	});

	it("leaves a boundary or a week with no program to M6's path", () => {
		const outline = { weekStartsOn: '2026-11-16', state: 'outline' as const, kind: null };
		expect(
			deloadTargetWeek(at({ next: outline, noProposal: 'boundary' }), '2026-11-17')
		).toBeNull();
		expect(deloadTargetWeek(at({ noProposal: 'no_program' }), '2026-11-17')).toBeNull();
	});
});

describe('assessDeload over a weekly review (S7)', () => {
	it('is on by the owner decision', () => {
		expect(REACTIVE_DELOAD).toBe(true);
	});

	it("reads the declining history's lifts and fatigue from the snapshot, and deloads naming each signal", () => {
		const { snapshot, today, context } = reviewed(HISTORIES.declining());
		expect(
			liftTrendsOf(snapshot)
				.filter((l) => l.trend?.verdict === 'real_trend' && l.trend.direction === 'down')
				.map((l) => l.name)
				.sort()
		).toEqual(['Back squat', 'Bench press']);
		const need = assessDeload(
			{ today, snapshot, targetWeek: today },
			{ context, calendar: calendarOf(today) }
		);
		expect(need.action).toBe('deload');
		expect(need.week).toBe(today);
		expect(need.evidence).toMatchObject({ trigger: 'fatigue_high', decliningLifts: 2 });
		expect(need.reasons).toEqual([
			'You have been sore (4 of 5)',
			'You have slept 5.9 hours a night',
			'The same loads feel 0.7 RPE harder',
			'2 lifts are declining while feeling harder',
			'Bench press and Back squat: estimated 1RM really declining'
		]);
	});

	it('never deloads on overload alone while OVERLOAD_TRIGGER is off (owner decision)', () => {
		expect(OVERLOAD_TRIGGER).toBe(false);
		const { snapshot, today, context } = reviewed(HISTORIES.steady());
		const overloaded = context.load.days.map((d) => ({
			...d,
			systems: { ...d.systems, lower: { ...d.systems.lower, level: 'overloaded' as const } }
		}));
		const need = assessDeload(
			{ today, snapshot, targetWeek: today },
			{ context: { load: { ...context.load, days: overloaded } }, calendar: calendarOf(today) }
		);
		expect(need.action).toBe('none');
		expect(need.evidence).not.toHaveProperty('overloadedSystem');
	});

	it('deloads nothing on the steady history', () => {
		const { snapshot, today, context } = reviewed(HISTORIES.steady());
		expect(liftTrendsOf(snapshot).every((l) => l.trend === null)).toBe(true);
		const need = assessDeload(
			{ today, snapshot, targetWeek: today },
			{ context, calendar: calendarOf(today) }
		);
		expect(need.action).toBe('none');
	});

	it.each(['deload', 'taper', 'event', 'recovery'] as const)(
		"keeps M6's path when the target week is already a %s week",
		(kind) => {
			const { snapshot, today, context } = reviewed(HISTORIES.declining());
			const calendar = calendarOf(today, { 0: kind });
			expect(
				assessDeload({ today, snapshot, targetWeek: today }, { context, calendar }).action
			).toBe('already_light');
		}
	);

	it.each([1, 2])("keeps M6's path when a planned light week starts %i week(s) after it", (n) => {
		const { snapshot, today, context } = reviewed(HISTORIES.declining());
		const calendar = calendarOf(today, { [n]: 'taper' });
		expect(assessDeload({ today, snapshot, targetWeek: today }, { context, calendar }).action).toBe(
			'hold_for_planned'
		);
	});

	it('reduces volume instead when a deload ended 10 days before the target week', () => {
		const { snapshot, today, context } = reviewed(HISTORIES.declining());
		// The week two before the target ends on its Sunday, 8 days before; one ending 10 days
		// before starts 16 days before the target's Monday.
		const calendar: CalendarWeek[] = [
			{ startsOn: addDays(today, -16), kind: 'deload' },
			...calendarOf(today).slice(2)
		];
		const need = assessDeload({ today, snapshot, targetWeek: today }, { context, calendar });
		expect(need.action).toBe('reduce_volume');
		expect(need.blockedBy?.guard).toBe('recent_deload');
	});

	it('may deload a cutback week, light for running only', () => {
		const { snapshot, today, context } = reviewed(HISTORIES.declining());
		const calendar = calendarOf(today, { 0: 'cutback' });
		expect(assessDeload({ today, snapshot, targetWeek: today }, { context, calendar }).action).toBe(
			'deload'
		);
	});

	it('reads no easy pace without two weeks of easy runs', () => {
		const { snapshot } = reviewed(HISTORIES.declining());
		expect(easyPaceOf({ ...snapshot, brief: { ...snapshot.brief, findings: [] } })).toBeNull();
	});
});

describe('deloadReasons', () => {
	it('keeps at most 5 reasons of at most 160 characters, trimmed and never empty', () => {
		const reasons = deloadReasons([' Sore ', '', 'x'.repeat(200), 'a', 'b', 'c', 'd']);
		expect(reasons).toHaveLength(5);
		expect(reasons[0]).toBe('Sore');
		expect(reasons[1]).toHaveLength(160);
		expect(reasons[1]!.endsWith('…')).toBe(true);
		expect(reasons.slice(2)).toEqual(['a', 'b', 'c']);
	});
});
