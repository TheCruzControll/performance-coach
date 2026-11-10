import { describe, expect, it } from 'vitest';
import { addDays, daysBetween } from '../../calendar';
import type { IsoDate } from '../../calendar';
import { weekTargets } from '../rules/blocks';
import { CAMP_WEEKS, CONDITIONING, HARD_SPARRING, MUAY_THAI_SESSIONS } from '../rules/fight-camp';
import { DOSES } from '../rules/maintenance';
import { SCENARIO_START } from '../scenarios';
import { combatLoadOf, fightCampWeeks } from './fight-camp';
import type { FightCampInput, FightCampWeek } from './fight-camp';
import { BLOCK_WEEK_KINDS } from './kinds';

/** Monday `week` weeks after SCENARIO_START (Monday 9 November 2026), plus `day` days. */
const day = (week: number, d = 0): IsoDate => addDays(SCENARIO_START, 7 * week + d);

/** An intermediate who spars and has room for 6 sessions, fighting on a Saturday 9 weeks on. */
const input = (over: Partial<FightCampInput> = {}): FightCampInput => ({
	fightOn: day(9, 5),
	startsOn: SCENARIO_START,
	level: 'intermediate',
	spars: true,
	sessionsAvailable: 6,
	...over
});

const building = (weeks: FightCampWeek[]) => weeks.filter((w) => w.role !== 'fight');
const isRising = (xs: number[]) => xs.every((x, i) => i === 0 || x >= xs[i - 1]!);

/** A fight on each day of the week, Monday to Sunday, 9 weeks on. */
const FIGHT_DAYS = Array.from({ length: 7 }, (_, d) => day(9, d));

describe('fightCampWeeks', () => {
	it('builds hard sparring from 1 to 2 a week, never more, with rounds from 4 to 8', () => {
		const camp = fightCampWeeks(input());
		const sparring = building(camp).map((w) => w.targets.combat.hardSparring);
		const rounds = building(camp).map((w) => w.targets.combat.sparringRounds);
		expect(sparring).toEqual([1, 1, 1, 2, 2, 2]);
		expect(rounds).toEqual([4, 5, 6, 6, 7, 8]);
		expect(Math.max(...sparring)).toBeLessThanOrEqual(HARD_SPARRING.max);
		expect(isRising(sparring) && isRising(rounds)).toBe(true);
	});

	it.each(FIGHT_DAYS)('plans no hard sparring within 7 days of a fight on %s', (fightOn) => {
		for (const week of fightCampWeeks(input({ fightOn }))) {
			const { hardSparring } = week.targets.combat;
			if (week.hardSparringBy === null) {
				expect(hardSparring, week.startsOn).toBe(0);
				continue;
			}
			expect(hardSparring).toBeGreaterThan(0);
			expect(daysBetween(week.hardSparringBy, fightOn)).toBeGreaterThanOrEqual(7);
			expect(week.hardSparringBy >= week.startsOn && week.hardSparringBy <= week.endsOn).toBe(true);
			// Two hard sessions need a day between them inside the window.
			const days = daysBetween(week.startsOn, week.hardSparringBy) + 1;
			expect(hardSparring).toBeLessThanOrEqual(Math.ceil(days / 2));
		}
	});

	it('cuts the peak week’s sparring short when the fight’s 7 days reach into it', () => {
		// A Friday fight: its fight week starts 4 days out, so the peak week runs to 5 days out.
		const fightOn = day(9, 4);
		const peak = fightCampWeeks(input({ fightOn })).find((w) => w.role === 'sparring_peak')!;
		expect(peak.endsOn).toBe(addDays(fightOn, -5));
		expect(peak.hardSparringBy).toBe(addDays(fightOn, -7));
		expect(peak.targets.combat.hardSparring).toBe(2);
	});

	it('plans conditioning only in weeks 2 to n − 1, rising from 6 to 10 rounds', () => {
		const camp = fightCampWeeks(input());
		const rounds = camp.map((w) => w.targets.combat.conditioningRounds);
		expect(rounds).toEqual([0, 6, 7, 8, 9, 10, 0]);
		expect(camp.map((w) => w.conditioningSessions)).toEqual([0, 2, 2, 2, 2, 2, 0]);
		expect(CONDITIONING.roundMinutes).toBe(3);
	});

	it.each(FIGHT_DAYS)(
		'holds strength at maintenance, biased to power, with none in the last 4 days before %s',
		(fightOn) => {
			for (const week of fightCampWeeks(input({ fightOn }))) {
				expect(week.targets.maintenance).toEqual(['strength']);
				expect(week.targets.setsPerGroup).toEqual({ min: 4, max: 10, step: 0 });
				expect(week.targets.rpeCap).toBeLessThanOrEqual(DOSES.strength.topSetRpeCap);
				expect(week.strength.bias).toBe('power');
				expect(week.strength.sessions).toBeLessThanOrEqual(2);
				if (week.strength.lastOn === null) expect(week.strength.sessions).toBe(0);
				else expect(daysBetween(week.strength.lastOn, fightOn)).toBeGreaterThan(4);
			}
			const camp = building(fightCampWeeks(input({ fightOn }))).slice(0, -1);
			expect(camp.every((w) => w.strength.sessions === 2)).toBe(true);
		}
	);

	it('ends in a technical fight week: no hard sparring, no conditioning, little volume', () => {
		const camp = fightCampWeeks(input());
		const fight = camp.at(-1)!;
		expect(fight).toMatchObject({ role: 'fight', kind: 'event', hardSparringBy: null });
		expect(fight.targets.combat).toEqual({
			sessions: 3,
			hardSparring: 0,
			sparringRounds: 0,
			conditioningRounds: 0
		});
		expect(fight.targets.volumeFactor).toBe(weekTargets('event', 0).volumeFactor);
		expect(fight.targets.volumeFactor).toBeLessThan(camp[0]!.targets.volumeFactor);
		// A Saturday fight: the fight week is its own, and holds one strength session, on Monday.
		expect(fight.startsOn).toBe(day(9));
		expect(fight.strength).toEqual({ sessions: 1, bias: 'power', lastOn: day(9) });
	});

	it('plans a 4-week short camp that still peaks and then tapers', () => {
		const camp = fightCampWeeks(input({ startsOn: day(6) }));
		expect(camp.map((w) => w.role)).toEqual(['camp', 'camp', 'sparring_peak', 'fight']);
		expect(camp.map((w) => w.targets.combat.hardSparring)).toEqual([1, 2, 2, 0]);
		expect(camp.map((w) => w.targets.combat.conditioningRounds)).toEqual([0, 6, 10, 0]);
		const loads = camp.map(combatLoadOf);
		expect(loads[3]).toBeLessThan(loads[2]!);
		expect(loads[3]).toBeLessThan(loads[0]!);
	});

	it('plans no sparring for an owner who does not spar', () => {
		for (const week of fightCampWeeks(input({ spars: false }))) {
			expect(week.targets.combat).toMatchObject({ hardSparring: 0, sparringRounds: 0 });
			expect(week.hardSparringBy).toBeNull();
		}
		const sessions = fightCampWeeks(input({ spars: false })).map((w) => w.targets.combat.sessions);
		expect(sessions).toEqual([3, 3, 4, 4, 5, 5, 3]);
	});

	it('raises the load model’s combat load to the peak, then drops it in the fight week', () => {
		const loads = fightCampWeeks(input()).map(combatLoadOf);
		const build = loads.slice(0, -1);
		expect(isRising(build)).toBe(true);
		expect(build.at(-1)!).toBeGreaterThan(build[0]!);
		expect(loads.at(-1)!).toBeLessThan(build[0]!);
		// Sparring for 60 minutes plus its 4 rounds of 3 at RPE 8, then 60 minutes of pads at 7 and of
		// technique at 6, each at its combat share (Muay Thai's combat 1 and lower 0.2, plus
		// sparring's CNS 0.5 and pads' 0.2).
		expect(loads[0]).toBeCloseTo((8 * 72) / 1.7 + (7 * 60) / 1.4 + (6 * 60) / 1.2);
	});

	it('gives every week the kind BLOCK_WEEK_KINDS names for its role, in phase fight_camp', () => {
		const camp = fightCampWeeks(input());
		expect(camp.map((w) => w.role)).toEqual([
			'camp',
			'camp',
			'camp',
			'camp',
			'camp',
			'sparring_peak',
			'fight'
		]);
		for (const week of camp) {
			expect(week.kind).toBe(BLOCK_WEEK_KINDS.fight_camp[week.role]);
			expect(week.phase).toBe('fight_camp');
			expect(daysBetween(week.startsOn, week.endsOn)).toBe(6);
		}
		expect(camp.map((w) => w.kind)).toEqual([...Array(5).fill('build'), 'peak', 'event']);
	});

	it('keeps Muay Thai within the owner’s sessions, rising from 3 to 5', () => {
		const sessions = (n: number) =>
			fightCampWeeks(input({ sessionsAvailable: n })).map((w) => w.targets.combat.sessions);
		expect(sessions(6)).toEqual([3, 3, 4, 4, 5, 5, 3]);
		expect(sessions(4)).toEqual([3, 3, 4, 4, 4, 4, 3]);
		expect(sessions(1)).toEqual([1, 1, 1, 1, 1, 1, 1]);
		expect(MUAY_THAI_SESSIONS.ramp).toEqual({ from: 3, to: 5 });
		// One session a week leaves room for one hard spar at most.
		const one = fightCampWeeks(input({ sessionsAvailable: 1 }));
		expect(one.every((w) => w.targets.combat.hardSparring <= 1)).toBe(true);
	});

	it('runs 6–8 weeks by level, from the first Monday on or after the start, ending on the fight', () => {
		const length = (over: Partial<FightCampInput>) => fightCampWeeks(input(over)).length;
		expect(length({ level: 'new' })).toBe(6);
		expect(length({ level: 'novice' })).toBe(6);
		expect(length({ level: 'intermediate' })).toBe(7);
		expect(length({ level: 'advanced' })).toBe(8);
		expect(CAMP_WEEKS.full).toEqual({ min: 6, max: 8 });
		// The fight 9 weeks on leaves a full camp starting in week 3 for an intermediate.
		expect(fightCampWeeks(input())[0]!.startsOn).toBe(day(3));
		// A Wednesday start waits for the next Monday: 5 weeks to the fight week.
		const late = fightCampWeeks(input({ startsOn: day(4, 2) }));
		expect(late[0]!.startsOn).toBe(day(5));
		expect(late).toHaveLength(5);
	});

	it('refuses a camp of under 3 weeks, or a session count that is not a whole number from 1', () => {
		expect(fightCampWeeks(input({ startsOn: day(7) }))).toHaveLength(3);
		expect(() => fightCampWeeks(input({ startsOn: day(7, 1) }))).toThrow(RangeError);
		expect(() => fightCampWeeks(input({ startsOn: day(10) }))).toThrow(
			'A fight camp needs at least 3 weeks before the fight'
		);
		for (const sessionsAvailable of [0, 2.5, Number.NaN]) {
			expect(() => fightCampWeeks(input({ sessionsAvailable }))).toThrow(RangeError);
		}
	});
});
