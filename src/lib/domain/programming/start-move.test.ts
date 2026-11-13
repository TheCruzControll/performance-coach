/**
 * start-move.ts: the starts a move offers (this week from today, then whole weeks from the next
 * Mondays), when a start can no longer move, and, through the generator, that a moved start keeps
 * every week on a Monday and every dated event on its date, its taper just before it.
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
	choiceOf,
	currentChoice,
	eventsSkipped,
	MOVE_WEEKS_AHEAD,
	moveRefusal,
	sameStart,
	startChoices,
	startWords
} from './start-move';

const WEDNESDAY = '2026-11-11';
const MONDAY = '2026-11-16';

describe('the starts a move offers', () => {
	it('on a Wednesday: this week from today, then the next Mondays, each a whole week', () => {
		const choices = startChoices(WEDNESDAY);
		expect(choices[0]).toEqual({
			value: 'this_week',
			startsOn: '2026-11-09',
			firstPlannedDay: WEDNESDAY
		});
		const mondays = choices.slice(1);
		expect(mondays).toHaveLength(MOVE_WEEKS_AHEAD);
		mondays.forEach((c, i) => {
			const monday = addDays(MONDAY, 7 * i);
			expect(c).toEqual({ value: monday, startsOn: monday, firstPlannedDay: monday });
		});
	});

	it('on a Monday: today is the first Monday, and this week is the same start, so not offered twice', () => {
		const choices = startChoices(MONDAY);
		expect(choices.map((c) => c.value)).toEqual(
			Array.from({ length: MOVE_WEEKS_AHEAD }, (_, i) => addDays(MONDAY, 7 * i))
		);
	});

	it('offers this week only while a part first week is allowed', () => {
		expect(startChoices(WEDNESDAY, { partialFirstWeek: false })[0]!.value).toBe(MONDAY);
	});

	it('starts week 1 on a Monday every time, with its first planned day inside it', () => {
		for (let day = 0; day < 7; day++) {
			const today = addDays('2026-12-28', day); // across a new year
			for (const c of startChoices(today)) {
				expect(mondayOf(c.startsOn)).toBe(c.startsOn);
				expect(c.firstPlannedDay >= c.startsOn && c.firstPlannedDay <= addDays(c.startsOn, 6)).toBe(
					true
				);
				expect(c.firstPlannedDay >= today).toBe(true);
			}
		}
	});

	it('takes only a value it offers: never a past Monday, another weekday or one past the window', () => {
		expect(choiceOf('this_week', WEDNESDAY)?.firstPlannedDay).toBe(WEDNESDAY);
		expect(choiceOf(MONDAY, WEDNESDAY)?.startsOn).toBe(MONDAY);
		expect(choiceOf('2026-11-09', WEDNESDAY)).toBeNull(); // this week's Monday has passed
		expect(choiceOf('2026-11-17', WEDNESDAY)).toBeNull(); // a Tuesday
		expect(choiceOf(addDays(MONDAY, 7 * MOVE_WEEKS_AHEAD), WEDNESDAY)).toBeNull();
		expect(choiceOf('this_week', MONDAY)).toBeNull();
		for (const junk of [undefined, null, 5, '', 'next_monday', {}]) {
			expect(choiceOf(junk, WEDNESDAY)).toBeNull();
		}
	});

	it('finds the choice that keeps the current start, if today offers it', () => {
		const next = { startsOn: MONDAY, firstPlannedDay: MONDAY };
		expect(currentChoice(next, WEDNESDAY)?.value).toBe(MONDAY);
		const fromToday = { startsOn: '2026-11-09', firstPlannedDay: WEDNESDAY };
		expect(currentChoice(fromToday, WEDNESDAY)?.value).toBe('this_week');
		// Built yesterday for 'this week': tomorrow it has started, so no choice keeps it.
		const yesterday = { startsOn: '2026-11-09', firstPlannedDay: '2026-11-10' };
		expect(currentChoice(yesterday, WEDNESDAY)).toBeNull();
		expect(sameStart(next, { ...next })).toBe(true);
		expect(sameStart(next, fromToday)).toBe(false);
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
	const events = [
		{ title: 'Past', date: '2026-11-10' },
		{ title: 'Soon', date: '2026-11-21' },
		{ title: 'Later', date: '2026-12-12' }
	];
	it('names the events from today on before the new first planned day', () => {
		const start = (monday: string) => ({ startsOn: monday, firstPlannedDay: monday });
		expect(eventsSkipped(start(MONDAY), WEDNESDAY, events)).toEqual([]);
		expect(eventsSkipped(start('2026-11-23'), WEDNESDAY, events).map((e) => e.title)).toEqual([
			'Soon'
		]);
		expect(eventsSkipped(start('2026-12-14'), WEDNESDAY, events).map((e) => e.title)).toEqual([
			'Soon',
			'Later'
		]);
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
	const taperWeek = (p: ProgramPlan) => weeks(p).find((w) => w.kind === 'taper');

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
			'build',
			'taper'
		]);
		expect(after.blocks[0]!.weeks.map((w) => w.kind)).toEqual([
			'baseline',
			'build',
			'build',
			'taper'
		]);
		// The same week, the one holding the fight, tapers in both: never shifted past it.
		expect(taperWeek(before)).toMatchObject({ startsOn: scenarioDay(5, 0) });
		expect(taperWeek(after)).toMatchObject({ startsOn: scenarioDay(5, 0) });
		expect(after.blocks[0]!.endsOn).toBe(scenarioDay(5, 6));
		expect(taperWeek(after)!.startsOn <= FIGHT && FIGHT <= taperWeek(after)!.endsOn).toBe(true);
		// The outline still ends on race day.
		expect(after.blocks.at(-1)!.endsOn).toBe(RACE);
	});

	it('past the fight, it is no longer planned for: the marathon leads, and the outline ends on race day', () => {
		const after = plan(SCENARIOS.journey(), scenarioDay(6, 0));
		expectMondayWeeks(after);
		expect(after.blocks[0]!.phase).toBe('marathon_base');
		expect(after.blocks.some((b) => b.name.includes('Fight'))).toBe(false);
		expect(after.blocks.at(-1)!.endsOn).toBe(RACE);
		expect(after.decisions.some((d) => d.summary === 'Taper before Fight')).toBe(false);
	});

	it('from today this week: week 1 runs Monday to Sunday, with nothing planned before today', () => {
		const p = plan(SCENARIOS.hybrid(), SCENARIO_START, scenarioDay(1, 2));
		expectMondayWeeks(p);
		expect(weeks(p)[0]!.sessions.length).toBeGreaterThan(0);
		expect(p.blocks.at(-1)!.endsOn).toBe(RACE);
	});
});
