import { describe, expect, it } from 'vitest';
import { addDays } from '../calendar';
import {
	adherenceByDiscipline,
	adherenceByWeekday,
	NO_RATE,
	OFTEN_MISSED,
	outcomeOf,
	periodAdherence,
	trainingTime,
	weekAdherence,
	weeklySessions
} from './adherence';
import type { AdherenceFacts, LoggedWorkout, PlannedSession } from './adherence';
import { periodWindow } from './periods';

// Today is a Wednesday. The four complete weeks before it, Monday first:
const TODAY = '2026-11-04';
const THIS_MONDAY = '2026-11-02';
const LAST_MONDAY = '2026-10-26';
const LAST_SUNDAY = '2026-11-01';
const NEXT_MONDAY = '2026-11-09';
/** The Mondays of the 4w window, oldest first. */
const WEEKS = ['2026-10-05', '2026-10-12', '2026-10-19', LAST_MONDAY] as const;
const WINDOW = periodWindow(TODAY, '4w', null);

/** A day of last week: 0 is Monday 26 October, 6 is Sunday 1 November. */
const lastWeek = (day: number) => addDays(LAST_MONDAY, day);

function planned(
	lineage: string,
	date: string,
	more: Partial<PlannedSession> = {}
): PlannedSession {
	return { lineage, date, status: 'planned', movedFrom: null, discipline: 'strength', ...more };
}

function logged(id: string, date: string, more: Partial<LoggedWorkout> = {}): LoggedWorkout {
	return {
		id,
		date,
		title: 'Lower A',
		discipline: 'strength',
		plannedLineage: null,
		durationSeconds: 3600,
		...more
	};
}

function facts(
	sessions: PlannedSession[],
	completed: string[] = [],
	workouts: LoggedWorkout[] = []
): AdherenceFacts {
	return { planned: sessions, completed: new Set(completed), workouts };
}

describe('outcomeOf', () => {
	const done = new Set(['done']);

	it('is completed by lineage, by a status M3 already derived, and over a stored skip', () => {
		expect(outcomeOf(planned('done', lastWeek(0)), done, TODAY)).toBe('completed');
		expect(outcomeOf(planned('x', lastWeek(0), { status: 'completed' }), done, TODAY)).toBe(
			'completed'
		);
		expect(outcomeOf(planned('done', lastWeek(0), { status: 'skipped' }), done, TODAY)).toBe(
			'completed'
		);
	});

	it('is skipped by the owner’s choice, before its day too', () => {
		expect(outcomeOf(planned('x', lastWeek(1), { status: 'skipped' }), done, TODAY)).toBe(
			'skipped'
		);
		expect(outcomeOf(planned('x', '2026-11-06', { status: 'skipped' }), done, TODAY)).toBe(
			'skipped'
		);
	});

	it('is missed once its day has passed, and pending today and after', () => {
		expect(outcomeOf(planned('x', '2026-11-03'), done, TODAY)).toBe('missed');
		expect(outcomeOf(planned('x', TODAY), done, TODAY)).toBe('pending');
		expect(outcomeOf(planned('x', '2026-11-05'), done, TODAY)).toBe('pending');
		expect(outcomeOf(planned('x', '2026-11-03', { status: 'moved' }), done, TODAY)).toBe('missed');
	});
});

describe('weekAdherence', () => {
	it('keeps skipped and missed apart, both due, and rates completed over completed, skipped and missed', () => {
		const week = weekAdherence(
			LAST_MONDAY,
			facts(
				[
					planned('a', lastWeek(0)),
					planned('b', lastWeek(1), { status: 'skipped' }),
					planned('c', lastWeek(3)),
					planned('d', lastWeek(5), { status: 'completed' })
				],
				['a']
			),
			TODAY
		);
		expect(week).toEqual({
			weekStart: LAST_MONDAY,
			through: LAST_SUNDAY,
			inProgress: false,
			planned: 4,
			completed: 2,
			skipped: 1,
			missed: 1,
			pending: 0,
			moved: 0,
			extra: 0,
			pct: 50,
			noRate: null
		});
	});

	it('gives future days no due: a later week is all pending, with no rate yet', () => {
		const sessions = [planned('a', NEXT_MONDAY), planned('b', '2026-11-11')];
		const week = weekAdherence(NEXT_MONDAY, facts(sessions), TODAY);
		expect(week).toMatchObject({ planned: 2, pending: 2, missed: 0, inProgress: false });
		expect(week.pct).toBeNull();
		expect(week.noRate).toBe('nothing_due');
		expect(NO_RATE.nothing_due).toBe('Nothing due yet');
	});

	it('counts the week in progress only through today: today and later are pending, flagged so', () => {
		const sessions = [
			planned('mon', THIS_MONDAY),
			planned('tue', '2026-11-03'),
			planned('wed', TODAY),
			planned('fri', '2026-11-06')
		];
		const week = weekAdherence(THIS_MONDAY, facts(sessions, ['mon']), TODAY);
		expect(week).toMatchObject({
			weekStart: THIS_MONDAY,
			through: TODAY,
			inProgress: true,
			planned: 4,
			completed: 1,
			missed: 1,
			pending: 2,
			pct: 50
		});
	});

	it('counts a session moved across a week boundary on its new day only', () => {
		const moved = planned('m', THIS_MONDAY, { status: 'moved', movedFrom: LAST_SUNDAY });
		const all = facts([planned('a', lastWeek(2)), moved], ['a', 'm']);
		expect(weekAdherence(LAST_MONDAY, all, TODAY)).toMatchObject({
			planned: 1,
			completed: 1,
			moved: 0
		});
		expect(weekAdherence(THIS_MONDAY, all, TODAY)).toMatchObject({
			planned: 1,
			completed: 1,
			moved: 1
		});
	});

	it('counts a session completed, then edited in a later version, once, on the later version’s day', () => {
		// Version 1 planned it on Tuesday and it was logged then; version 2 (an edit) moved it to
		// Thursday. Both versions' rows are given, oldest first, and it was logged twice.
		const v1 = planned('l', lastWeek(1));
		const v2 = planned('l', lastWeek(3), { status: 'moved', movedFrom: lastWeek(1) });
		const workouts = [
			logged('w1', lastWeek(1), { plannedLineage: 'l' }),
			logged('w2', lastWeek(3), { plannedLineage: 'l' })
		];
		const all = facts([v1, v2], ['l'], workouts);
		expect(weekAdherence(LAST_MONDAY, all, TODAY)).toMatchObject({
			planned: 1,
			completed: 1,
			missed: 0,
			extra: 0,
			pct: 100
		});
		const byDay = adherenceByWeekday(all, WINDOW.weeks, TODAY);
		expect(byDay.find((d) => d.weekday === 'tue')!.planned).toBe(0);
		expect(byDay.find((d) => d.weekday === 'thu')).toMatchObject({ planned: 1, completed: 1 });
	});

	it('counts off-plan workouts as extra, outside the rate, and never a planned session logged late', () => {
		const sunday = planned('sun', LAST_SUNDAY);
		const workouts = [
			logged('late', THIS_MONDAY, { plannedLineage: 'sun' }),
			logged('x1', '2026-11-03', { discipline: 'running', title: 'Easy run' }),
			logged('x2', lastWeek(2))
		];
		const all = facts([sunday, planned('mon', THIS_MONDAY)], ['sun', 'mon'], workouts);
		expect(weekAdherence(LAST_MONDAY, all, TODAY)).toMatchObject({
			planned: 1,
			completed: 1,
			extra: 1,
			pct: 100
		});
		expect(weekAdherence(THIS_MONDAY, all, TODAY)).toMatchObject({
			planned: 1,
			completed: 1,
			extra: 1,
			pct: 100
		});
	});

	it('gives no rate without a plan, “No plan for this period”, extras still counted', () => {
		const week = weekAdherence(LAST_MONDAY, facts([], [], [logged('x', lastWeek(4))]), TODAY);
		expect(week).toMatchObject({
			planned: 0,
			completed: 0,
			extra: 1,
			pct: null,
			noRate: 'no_plan'
		});
		expect(NO_RATE.no_plan).toBe('No plan for this period');
	});

	it('refuses a week that does not start on a Monday', () => {
		expect(() => weekAdherence(TODAY, facts([]), TODAY)).toThrow(RangeError);
	});
});

describe('periodAdherence', () => {
	it('rates the complete weeks together, by their counts, with the week in progress apart', () => {
		const sessions = [
			planned('a', WEEKS[2]),
			planned('b', WEEKS[3]),
			planned('c', lastWeek(2)),
			planned('d', lastWeek(4), { status: 'skipped' }),
			planned('e', THIS_MONDAY),
			planned('f', '2026-11-03')
		];
		const period = periodAdherence(facts(sessions, ['a', 'b', 'e']), WINDOW);
		expect(period.weeks.map((w) => w.weekStart)).toEqual(WEEKS);
		expect(period.weeks.map((w) => w.pct)).toEqual([null, null, 100, 33.333333]);
		expect(period.weeks.every((w) => !w.inProgress)).toBe(true);
		// 2 of 4 due sessions, not the mean of 100 % and 33 %; this week's 1 of 2 is not in it.
		expect(period.total).toMatchObject({
			planned: 4,
			completed: 2,
			skipped: 1,
			missed: 1,
			pct: 50
		});
		expect(period.inProgress).toMatchObject({
			weekStart: THIS_MONDAY,
			inProgress: true,
			completed: 1,
			missed: 1,
			pct: 50
		});
	});

	it('for a new owner in their first week has no complete weeks and no rate', () => {
		const first = periodWindow(TODAY, 'all', THIS_MONDAY);
		const period = periodAdherence(facts([planned('e', THIS_MONDAY)], ['e']), first);
		expect(period.weeks).toEqual([]);
		expect(period.total).toMatchObject({ planned: 0, pct: null, noRate: 'no_plan', extra: 0 });
		expect(period.inProgress).toMatchObject({ planned: 1, completed: 1, pct: 100 });
	});
});

describe('breakdowns', () => {
	it('by discipline, over the complete weeks only, in the catalogue’s order', () => {
		const sessions = [
			planned('r1', WEEKS[0], { discipline: 'running' }),
			planned('r2', WEEKS[1], { discipline: 'running' }),
			planned('s1', WEEKS[0]),
			planned('s2', WEEKS[1], { status: 'skipped' }),
			planned('s3', WEEKS[2]),
			planned('mt', THIS_MONDAY, { discipline: 'muay_thai' })
		];
		const rows = adherenceByDiscipline(facts(sessions, ['r1', 's1', 's3']), WINDOW.weeks, TODAY);
		expect(rows.map((r) => r.discipline)).toEqual(['strength', 'running']);
		expect(rows[0]).toMatchObject({
			planned: 3,
			completed: 2,
			skipped: 1,
			missed: 0,
			pct: 66.666667
		});
		expect(rows[1]).toMatchObject({ planned: 2, completed: 1, missed: 1, pct: 50 });
	});

	it(`by weekday, Monday first, flags a day missed ${OFTEN_MISSED} times or more, never for skips`, () => {
		expect(OFTEN_MISSED).toBe(3);
		const sessions = WEEKS.flatMap((monday, i) => [
			planned(`tue${i}`, addDays(monday, 1)),
			planned(`thu${i}`, addDays(monday, 3)),
			planned(`fri${i}`, addDays(monday, 4), { status: 'skipped' })
		]);
		// Tuesday done once of four, Thursday done twice: missed 3 and 2 times. Fridays all skipped.
		const done = ['tue0', 'thu0', 'thu1'];
		const days = adherenceByWeekday(facts(sessions, done), WINDOW.weeks, TODAY);
		expect(days.map((d) => d.weekday)).toEqual(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
		const day = (weekday: string) => days.find((d) => d.weekday === weekday)!;
		expect(day('tue')).toMatchObject({ planned: 4, missed: 3, oftenMissed: true, pct: 25 });
		expect(day('thu')).toMatchObject({ planned: 4, missed: 2, oftenMissed: false, pct: 50 });
		expect(day('fri')).toMatchObject({ skipped: 4, missed: 0, oftenMissed: false, pct: 0 });
		expect(day('mon')).toMatchObject({
			planned: 0,
			pct: null,
			noRate: 'no_plan',
			oftenMissed: false
		});
	});
});

describe('weeklySessions', () => {
	it('counts every completed workout, planned or not, by week and discipline, the week in progress apart', () => {
		const workouts = [
			logged('a', WEEKS[0]),
			logged('b', WEEKS[0], { discipline: 'running', plannedLineage: 'r' }),
			logged('c', lastWeek(6), { discipline: 'muay_thai' }),
			logged('d', THIS_MONDAY),
			logged('old', '2026-09-28')
		];
		const sessions = weeklySessions(workouts, WINDOW);
		expect(sessions.weeks).toEqual([
			{
				weekStart: WEEKS[0],
				inProgress: false,
				sessions: 2,
				byDiscipline: { strength: 1, running: 1 }
			},
			{ weekStart: WEEKS[1], inProgress: false, sessions: 0, byDiscipline: {} },
			{ weekStart: WEEKS[2], inProgress: false, sessions: 0, byDiscipline: {} },
			{ weekStart: WEEKS[3], inProgress: false, sessions: 1, byDiscipline: { muay_thai: 1 } }
		]);
		expect(sessions.inProgress).toEqual({
			weekStart: THIS_MONDAY,
			inProgress: true,
			sessions: 1,
			byDiscipline: { strength: 1 }
		});
		expect(sessions.total).toEqual({
			sessions: 3,
			byDiscipline: { strength: 1, running: 1, muay_thai: 1 }
		});
	});
});

describe('trainingTime', () => {
	it('names and counts a session with no duration, never taking it as 0', () => {
		const pads = logged('pads', lastWeek(1), {
			discipline: 'muay_thai',
			title: 'Muay Thai pads',
			durationSeconds: null
		});
		const upperB = logged('c', WEEKS[1], { title: 'Upper B', durationSeconds: null });
		const workouts = [
			logged('a', lastWeek(0), { durationSeconds: 3600 }),
			pads,
			logged('b', WEEKS[2], { discipline: 'running', durationSeconds: 1800 }),
			upperB,
			logged('d', THIS_MONDAY, { durationSeconds: 2700 })
		];
		const time = trainingTime(workouts, WINDOW);
		const untimed = (w: LoggedWorkout) => ({
			id: w.id,
			title: w.title,
			date: w.date,
			discipline: w.discipline
		});
		expect(time.weeks).toEqual([
			{ weekStart: WEEKS[0], inProgress: false, seconds: 0, byDiscipline: {}, untimed: [] },
			{
				weekStart: WEEKS[1],
				inProgress: false,
				seconds: null,
				byDiscipline: { strength: null },
				untimed: [untimed(upperB)]
			},
			{
				weekStart: WEEKS[2],
				inProgress: false,
				seconds: 1800,
				byDiscipline: { running: 1800 },
				untimed: []
			},
			{
				weekStart: WEEKS[3],
				inProgress: false,
				seconds: 3600,
				byDiscipline: { strength: 3600, muay_thai: null },
				untimed: [untimed(pads)]
			}
		]);
		expect(time.inProgress).toMatchObject({
			weekStart: THIS_MONDAY,
			inProgress: true,
			seconds: 2700
		});
		expect(time.total).toEqual({
			seconds: 5400,
			byDiscipline: { strength: 3600, running: 1800, muay_thai: null },
			untimed: [untimed(upperB), untimed(pads)]
		});
	});
});
