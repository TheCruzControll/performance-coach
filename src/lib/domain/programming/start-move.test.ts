/**
 * start-move.ts: the days a start may fall on (any day from today to START_DAYS_AHEAD days ahead,
 * week 1 being that day's Monday-to-Sunday week), when a start can no longer move, and, through
 * the generator, that a moved start keeps every week on a Monday and every dated event on its
 * date, its taper just before it.
 */
import { describe, expect, it } from 'vitest';
import { addDays, mondayOf, weekdayOf } from '../calendar';
import { CATALOGUE } from '../exercises/index';
import type { TrainingProfile } from '../profile/types';
import type { ProgramPlan } from '../training/types';
import { generateProgram } from './generate';
import { buildProgrammingInput } from './input';
import { SCENARIO_START, SCENARIOS, scenarioDay } from './scenarios';
import {
	eventsAhead,
	latestStart,
	moveRefusal,
	sameStart,
	START_DAYS_AHEAD,
	startDay,
	startFrom,
	startWords
} from './start-move';

const WEDNESDAY = '2026-11-11';
const MONDAY = '2026-11-16';

describe('a start on any day from today to eight weeks ahead', () => {
	it('takes every day from today to latestStart: week 1 is that day’s week, planned from the day', () => {
		expect(latestStart(WEDNESDAY)).toBe(addDays(WEDNESDAY, START_DAYS_AHEAD));
		for (let d = 0; d <= START_DAYS_AHEAD; d++) {
			const day = addDays(WEDNESDAY, d);
			expect(startDay(day, WEDNESDAY), day).toEqual({
				startsOn: mondayOf(day),
				firstPlannedDay: day
			});
		}
	});

	it('starts week 1 on a Monday every time, with its first planned day inside it, across a new year', () => {
		for (let offset = 0; offset < 7; offset++) {
			const today = addDays('2026-12-28', offset);
			for (let d = 0; d <= START_DAYS_AHEAD; d++) {
				const day = addDays(today, d);
				const dates = startDay(day, today)!;
				expect(mondayOf(dates.startsOn)).toBe(dates.startsOn);
				expect(
					dates.firstPlannedDay >= dates.startsOn &&
						dates.firstPlannedDay <= addDays(dates.startsOn, 6)
				).toBe(true);
				expect(dates.firstPlannedDay).toBe(day);
			}
		}
	});

	it('refuses a day that has passed, one past the window, a name, or a value that is not a real date', () => {
		expect(startDay(addDays(WEDNESDAY, -1), WEDNESDAY)).toBeNull();
		expect(startDay(addDays(WEDNESDAY, START_DAYS_AHEAD + 1), WEDNESDAY)).toBeNull();
		for (const junk of ['this_week', 'next_monday', '2026-02-30', '', null, 42]) {
			expect(startDay(junk, WEDNESDAY), String(junk)).toBeNull();
		}
	});

	it('while PARTIAL_FIRST_WEEK is off, takes only a Monday', () => {
		const thursday = addDays(MONDAY, 3);
		expect(startDay(thursday, WEDNESDAY, { partialFirstWeek: false })).toBeNull();
		expect(startDay(MONDAY, WEDNESDAY, { partialFirstWeek: false })).toEqual(startFrom(MONDAY));
	});

	it('keeps the current start when it is the one asked for', () => {
		const next = { startsOn: MONDAY, firstPlannedDay: MONDAY };
		expect(sameStart(next, { ...next })).toBe(true);
		expect(sameStart(next, { startsOn: MONDAY, firstPlannedDay: '2026-11-17' })).toBe(false);
	});
});

describe('when a start can no longer move', () => {
	it('moves until its first planned day has passed, that day included', () => {
		expect(moveRefusal({ today: WEDNESDAY, firstPlannedDay: MONDAY, logged: false })).toBeNull();
		expect(moveRefusal({ today: MONDAY, firstPlannedDay: MONDAY, logged: false })).toBeNull();
		expect(moveRefusal({ today: '2026-11-17', firstPlannedDay: MONDAY, logged: false })).toBe(
			'started'
		);
	});

	it('stays once anything is logged against the program, even before its first planned day', () => {
		expect(moveRefusal({ today: WEDNESDAY, firstPlannedDay: MONDAY, logged: true })).toBe('logged');
		expect(moveRefusal({ today: MONDAY, firstPlannedDay: MONDAY, logged: true })).toBe('logged');
	});
});

describe('the events a start would leave out', () => {
	it('keeps the events from today to latestStart, inclusive, earliest first', () => {
		const events = [
			{ title: 'Late', date: latestStart(WEDNESDAY) },
			{ title: 'Beyond', date: addDays(latestStart(WEDNESDAY), 1) },
			{ title: 'Soon', date: '2026-11-21' },
			{ title: 'Today', date: WEDNESDAY },
			{ title: 'Past', date: '2026-11-10' }
		];
		expect(eventsAhead(WEDNESDAY, events).map((e) => e.title)).toEqual(['Today', 'Soon', 'Late']);
	});
});

it('words a start as History shows it', () => {
	expect(startWords(MONDAY)).toBe('Mon 16 Nov');
	expect(startWords('2027-01-04')).toBe('Mon 4 Jan');
	expect(startWords(WEDNESDAY)).toBe('Wed 11 Nov');
});

describe('a moved start, planned again', () => {
	const FIGHT = scenarioDay(5, 5); // Sat 12 Dec
	const RACE = scenarioDay(20, 6);
	const plan = (profile: TrainingProfile, startsOn: string, firstPlannedDay = startsOn) =>
		generateProgram(buildProgrammingInput(profile, { catalogue: CATALOGUE }), {
			startsOn,
			firstPlannedDay
		});
	const weeks = (p: ProgramPlan) => p.blocks.flatMap((b) => b.weeks);
	/** The fight camp's fight week, its taper (fight-camp.ts): the week holding the fight. */
	const fightWeek = (p: ProgramPlan) => weeks(p).find((w) => w.kind === 'event');
	/** The season runs past race day to its horizon; the marathon's taper ends on race day. */
	const raceTaper = (p: ProgramPlan) => p.blocks.find((b) => b.phase === 'marathon_taper');
	const tapers = (p: ProgramPlan) =>
		p.decisions.filter((d) => d.kind === 'taper_planned').map((d) => d.summary);

	/** Blocks run on from one another, each week Monday to Sunday, from week 1's Monday. */
	function expectMondayWeeks(p: ProgramPlan) {
		expect(p.blocks[0]!.startsOn).toBe(p.startsOn);
		p.blocks.forEach((b, i) => {
			expect(weekdayOf(b.startsOn)).toBe('mon');
			expect(weekdayOf(b.endsOn)).toBe('sun');
			if (i > 0) expect(b.startsOn).toBe(addDays(p.blocks[i - 1]!.endsOn, 1));
			b.weeks.forEach((w, n) => {
				expect(w.startsOn).toBe(addDays(b.startsOn, 7 * n));
				expect(w.endsOn).toBe(addDays(w.startsOn, 6));
			});
		});
		for (const s of weeks(p).flatMap((w) => w.sessions)) {
			expect(s.date >= p.firstPlannedDay).toBe(true);
		}
	}

	it('a week later, the fight keeps its date: the block is a week shorter and still tapers in its week', () => {
		const before = plan(SCENARIOS.journey(), SCENARIO_START);
		const after = plan(SCENARIOS.journey(), addDays(SCENARIO_START, 7));
		expectMondayWeeks(before);
		expectMondayWeeks(after);
		expect(before.blocks[0]!.weeks.map((w) => w.kind)).toEqual([
			'baseline',
			'build',
			'build',
			'peak',
			'event'
		]);
		expect(after.blocks[0]!.weeks.map((w) => w.kind)).toEqual([
			'baseline',
			'build',
			'peak',
			'event'
		]);
		// The same week, the one holding the fight, is the fight week in both: never shifted past it.
		expect(fightWeek(before)).toMatchObject({ startsOn: scenarioDay(5, 0) });
		expect(fightWeek(after)).toMatchObject({ startsOn: scenarioDay(5, 0) });
		expect(after.blocks[0]!.endsOn).toBe(scenarioDay(5, 6));
		expect(fightWeek(after)!.startsOn <= FIGHT && FIGHT <= fightWeek(after)!.endsOn).toBe(true);
		expect(tapers(after)).toEqual(tapers(before));
		expect(tapers(after)).toContain('Taper before Fight: 1 week');
		// The marathon still tapers to race day.
		expect(raceTaper(after)!.endsOn).toBe(RACE);
	});

	it('past the fight, it is no longer planned for: its recovery week, then the marathon leads to race day', () => {
		const after = plan(SCENARIOS.journey(), scenarioDay(6, 0));
		expectMondayWeeks(after);
		// A fight just before the start keeps only its recovery (windows.ts), then the marathon.
		expect(after.blocks.map((b) => b.phase).slice(0, 2)).toEqual(['recovery', 'marathon_base']);
		expect(after.blocks[0]!.weeks.map((w) => w.kind)).toEqual(['recovery']);
		expect(after.blocks.some((b) => b.phase === 'fight_camp' || b.name.includes('Fight'))).toBe(
			false
		);
		expect(raceTaper(after)!.endsOn).toBe(RACE);
		expect(tapers(after).some((s) => s.startsWith('Taper before Fight'))).toBe(false);
	});

	it('from today this week: week 1 runs Monday to Sunday, with nothing planned before today', () => {
		const p = plan(SCENARIOS.hybrid(), SCENARIO_START, scenarioDay(1, 2));
		expectMondayWeeks(p);
		expect(weeks(p)[0]!.sessions.length).toBeGreaterThan(0);
		expect(raceTaper(p)!.endsOn).toBe(RACE);
	});

	it('from a Thursday in the week after, via startFrom: week 1 is that Monday, planned from the Thursday', () => {
		const thursday = addDays(SCENARIO_START, 10); // a Thursday, in the week after the first Monday
		const { startsOn, firstPlannedDay } = startFrom(thursday);
		expect(startsOn).toBe(addDays(SCENARIO_START, 7));
		expect(firstPlannedDay).toBe(thursday);
		const p = plan(SCENARIOS.hybrid(), startsOn, firstPlannedDay);
		expectMondayWeeks(p);
		for (const w of weeks(p)) expect(weekdayOf(w.startsOn)).toBe('mon');
		expect(weeks(p)[0]!.startsOn).toBe(startsOn);
		expect(p.decisions.length).toBeGreaterThan(0);
		expect(raceTaper(p)!.endsOn).toBe(RACE);
	});
});
