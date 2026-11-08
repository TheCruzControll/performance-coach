import { describe, expect, it } from 'vitest';
import { addDays } from '../../calendar';
import type { IsoDate } from '../../calendar';
import { CATALOGUE } from '../../exercises/index';
import type { TrainingProfile } from '../../profile/types';
import { decisionPlanSchema } from '../../training/schemas';
import { validate } from '../../validation';
import { DecisionLog } from '../decisions';
import { buildProgrammingInput } from '../input';
import type { ProgrammingInput } from '../input';
import { M7_SCENARIOS, m7Day } from '../periodisation/scenarios';
import type { M7ScenarioKey } from '../periodisation/scenarios';
import { ALL_PAUSED, RANK_WEIGHTS } from '../rules/priority';
import { RULE_BY_ID } from '../rules/registry/index';
import {
	effectivePriorities,
	eventKindOf,
	leaderOn,
	PRIORITY_RULE_KEYS,
	priorityFacts,
	tradeoffSentence,
	UNRANKED_SESSION_WEIGHT,
	weightOfSession,
	winner
} from './weights';
import type { GoalPriority } from './weights';

const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

const FIGHT_ON = m7Day(10, 5);
const MARATHON_ON = m7Day(24, 6);

/** multiGoal with each goal's rank and event date changed by title. */
function multiGoal(over: Record<string, { priority?: number; eventDate?: IsoDate }> = {}) {
	const profile = M7_SCENARIOS.multiGoal();
	profile.goals = profile.goals.map((g) => ({ ...g, ...over[g.title] }));
	return inputOf(profile);
}

const byTitle = (priorities: readonly GoalPriority[]) =>
	Object.fromEntries(priorities.map((p) => [p.title, p]));
const modes = (priorities: readonly GoalPriority[]) =>
	Object.fromEntries(priorities.map((p) => [p.title, p.mode]));

describe('who leads', () => {
	it('goes by rank alone when no event is near', () => {
		const off = effectivePriorities(inputOf(M7_SCENARIOS.offSeason()), m7Day(1, 0));
		expect(off.map((p) => [p.title, p.rank, p.weight, p.mode, p.rule])).toEqual([
			['Keep strength', 0, 1, 'primary', 'priority.rank_weights'],
			['Keep running fitness', 1, 0.6, 'secondary', 'priority.secondary_share']
		]);
		expect(off[0]!.why).toBe(
			'Keep strength is your top-ranked goal, and no goal’s event is inside its lead window.'
		);

		// The fight is ten weeks out: outside its 8-week window, so rank still orders them.
		const s1 = effectivePriorities(multiGoal(), m7Day(1, 0));
		expect(s1.map((p) => [p.title, p.weight, p.inWindow])).toEqual([
			['Muay Thai fight', 1, false],
			['Marathon', 0.6, false],
			['Build muscle', 0.4, false],
			['Keep strength', 0.25, false]
		]);
		expect(s1[0]!.rule).toBe('priority.rank_weights');
	});

	it('puts a fight ranked 2 four weeks out ahead of a marathon ranked 1 twenty weeks out', () => {
		const on = addDays(FIGHT_ON, -28);
		const marathonOn = addDays(on, 20 * 7);
		const input = multiGoal({
			'Muay Thai fight': { priority: 2 },
			Marathon: { priority: 1, eventDate: marathonOn }
		});
		const [first, second] = effectivePriorities(input, on);
		expect(first).toMatchObject({
			title: 'Muay Thai fight',
			priority: 2,
			rank: 0,
			weight: 1,
			eventKind: 'fight',
			weeksToEvent: 4,
			inWindow: true,
			mode: 'primary',
			rule: 'priority.lead'
		});
		expect(second).toMatchObject({ title: 'Marathon', weeksToEvent: 20, inWindow: false });
		expect(first!.why).toBe(
			`Muay Thai fight on ${FIGHT_ON} is 4 weeks away, inside its 8-week lead window, so it leads Marathon, ranked higher but 20 weeks from its event on ${marathonOn}, outside its 16-week lead window.`
		);
		expect(leaderOn(input, on)?.title).toBe('Muay Thai fight');

		// The promotion's reason is a decision evidence string, so it must pass the plan contract whole.
		const resolved = priorityFacts([first!, second!], on, addDays(on, 27))!;
		expect(resolved.facts.reason).toBe(first!.why);
		const decision = new DecisionLog().add(
			'priority_resolved',
			resolved.ruleKey,
			['blocks.0'],
			resolved.facts
		);
		expect(validate(decisionPlanSchema, decision).ok).toBe(true);
	});

	it('returns to rank order once the fight has passed', () => {
		const input = multiGoal({
			'Muay Thai fight': { priority: 2 },
			Marathon: { priority: 1, eventDate: addDays(FIGHT_ON, 20 * 7) }
		});
		const before = effectivePriorities(input, FIGHT_ON);
		expect(before[0]).toMatchObject({ title: 'Muay Thai fight', weeksToEvent: 0 });

		const after = effectivePriorities(input, addDays(FIGHT_ON, 1));
		expect(after.map((p) => p.title)).toEqual([
			'Marathon',
			'Muay Thai fight',
			'Build muscle',
			'Keep strength'
		]);
		expect(after[0]!.rule).toBe('priority.rank_weights');
		expect(after[1]).toMatchObject({ inWindow: false, weeksToEvent: -1 });
		expect(after[0]!.why).toContain(`Muay Thai fight’s event on ${FIGHT_ON} has passed.`);
	});

	it('resolves two in-window events by rank, whichever is sooner', () => {
		const on = addDays(MARATHON_ON, -10 * 7);
		const fightOn = addDays(on, 4 * 7);
		const both = (fight: number, marathon: number) =>
			effectivePriorities(
				multiGoal({
					'Muay Thai fight': { priority: fight, eventDate: fightOn },
					Marathon: { priority: marathon }
				}),
				on
			);
		const marathonFirst = both(2, 1);
		expect(marathonFirst.slice(0, 2).map((p) => [p.title, p.inWindow, p.rule])).toEqual([
			['Marathon', true, 'priority.lead'],
			['Muay Thai fight', true, 'priority.secondary_share']
		]);
		expect(marathonFirst[0]!.why).toBe(
			`Marathon on ${MARATHON_ON} is 10 weeks away, inside its 16-week lead window, as is Muay Thai fight on ${fightOn}, and you rank Marathon higher.`
		);
		expect(
			both(1, 2)
				.map((p) => p.title)
				.slice(0, 2)
		).toEqual(['Muay Thai fight', 'Marathon']);
	});

	it('picks the same winner as the ranking, in either argument order', () => {
		const input = multiGoal({ 'Muay Thai fight': { priority: 2 }, Marathon: { priority: 1 } });
		const [fight, marathon] = [
			input.goals.find((g) => g.title === 'Muay Thai fight')!,
			input.goals.find((g) => g.title === 'Marathon')!
		];
		const camp = addDays(FIGHT_ON, -28);
		expect(winner(fight, marathon, camp)).toBe(fight);
		expect(winner(marathon, fight, camp)).toBe(fight);
		expect(winner(fight, marathon, addDays(FIGHT_ON, 1))).toBe(marathon);
		expect(winner(marathon, fight, m7Day(1, 0))).toBe(marathon);
	});

	it('names each event’s kind, for its lead window', () => {
		const kind = (title: string, disciplines: string[], eventType: string | null = title) =>
			eventKindOf({
				title,
				disciplines: disciplines as never,
				eventType,
				eventDate: '2027-01-01'
			});
		expect(kind('Muay Thai fight', ['muay_thai'])).toBe('fight');
		expect(kind('Grading', ['muay_thai'])).toBe('other');
		expect(kind('Marathon', ['distance_running'])).toBe('marathon');
		expect(kind('Half marathon', ['distance_running'])).toBe('half');
		expect(kind('City race', ['distance_running'], null)).toBe('marathon');
		expect(kind('Powerlifting meet', ['powerlifting'])).toBe('meet');
		expect(kind('Parkrun', ['running'])).toBe('other');
		expect(
			eventKindOf({ title: 'Fight', disciplines: ['muay_thai'], eventType: null, eventDate: null })
		).toBeNull();
	});
});

describe('modes', () => {
	it('S1 in fight camp: the fight leads, the marathon is secondary, and the rest are held', () => {
		const camp = effectivePriorities(multiGoal(), m7Day(6, 0));
		expect(modes(camp)).toEqual({
			'Muay Thai fight': 'primary',
			Marathon: 'secondary',
			'Build muscle': 'maintenance',
			'Keep strength': 'maintenance'
		});
		const goal = byTitle(camp);
		expect(goal['Build muscle']).toMatchObject({ rule: 'priority.conflicts' });
		expect(goal['Build muscle']!.why).toMatch(
			/^Build muscle is held at maintenance while Muay Thai fight leads: Fight camp’s sparring/
		);
		expect(goal['Keep strength']).toMatchObject({ rule: 'priority.secondary_share' });
		expect(goal['Keep strength']!.why).toBe(
			'Keep strength is held at maintenance while Muay Thai fight leads: fourth in line, its weight of 0.25 is under half the leader’s.'
		);
		expect(goal.Marathon!.why).toBe(
			'Marathon trains alongside Muay Thai fight as a secondary goal: second in line, its weight of 0.6 is at least half the leader’s, and the two do not conflict.'
		);
		// The block's phase decides it too, before the window opens.
		const early = byTitle(effectivePriorities(multiGoal(), m7Day(1, 0), { phase: 'fight_camp' }));
		expect(early['Build muscle']!.rule).toBe('priority.conflicts');
	});

	it('holds strength at maintenance in a marathon peak and taper (S5, S11), not in its build', () => {
		const strengthIn = (key: M7ScenarioKey, title: string, phase?: 'marathon_peak') =>
			byTitle(effectivePriorities(inputOf(M7_SCENARIOS[key]()), m7Day(1, 0), { phase }))[title]!;
		for (const [key, title] of [
			['marathonTaper', 'Keep strength'],
			['runnerLifter', 'Get stronger']
		] as const) {
			expect(strengthIn(key, title, 'marathon_peak'), key).toMatchObject({
				mode: 'maintenance',
				rule: 'priority.conflicts'
			});
			expect(strengthIn(key, title, 'marathon_peak').why).toContain(
				'Peak mileage and the taper need fresh legs'
			);
			// With no phase known, the build's strength keeps its place as secondary.
			expect(strengthIn(key, title).mode, key).toBe('secondary');
		}
		const taper = effectivePriorities(inputOf(M7_SCENARIOS.marathonTaper()), m7Day(2, 0), {
			phase: 'marathon_taper'
		});
		expect(modes(taper)).toEqual({ Marathon: 'primary', 'Keep strength': 'maintenance' });
	});

	it('holds hypertrophy at maintenance before the meet (S12), and lets it train after', () => {
		const input = inputOf(M7_SCENARIOS.meetPrep());
		const prep = byTitle(effectivePriorities(input, m7Day(3, 0)));
		expect(prep['Powerlifting meet']).toMatchObject({ mode: 'primary', inWindow: true });
		expect(prep['Build muscle']).toMatchObject({ mode: 'maintenance', rule: 'priority.conflicts' });
		expect(prep['Build muscle']!.why).toContain('Meet prep trains the competition lifts');

		const after = byTitle(effectivePriorities(input, m7Day(11, 0)));
		expect(after['Build muscle']!.mode).toBe('secondary');
	});
});

describe('paused goals', () => {
	it('keeps every goal at maintenance with no leader when all are paused, as M3 plans it', () => {
		const input = inputOf(M7_SCENARIOS.allPaused());
		expect(input.maintenance).toBe(true);
		const priorities = effectivePriorities(input, m7Day(1, 0));
		expect(priorities.map((p) => p.goalId)).toEqual(input.refs.paused);
		for (const p of priorities) {
			expect(p).toMatchObject({ mode: 'maintenance', rule: 'priority.all_paused' });
			expect(p.why).toBe(ALL_PAUSED.reason);
		}
		expect(ALL_PAUSED.reason).toBe('Every goal is paused, so each is kept at maintenance.');
		expect(leaderOn(input, m7Day(1, 0))).toBeNull();
		expect(priorityFacts(priorities, m7Day(1, 0), m7Day(4, 6))).toBeNull();
	});

	it('leaves one paused goal out among active ones', () => {
		const profile = M7_SCENARIOS.multiGoal();
		const paused = profile.goals.find((g) => g.title === 'Keep strength')!;
		paused.status = 'paused';
		const input = inputOf(profile);
		const priorities = effectivePriorities(input, m7Day(6, 0));
		expect(priorities.map((p) => p.title)).toEqual(['Muay Thai fight', 'Marathon', 'Build muscle']);
		expect(priorities.map((p) => p.goalId)).not.toContain(paused.id);
		expect(priorities.map((p) => p.goalId).sort()).toEqual([...input.refs.goals].sort());
	});
});

describe('weights and words', () => {
	it('weighs a session by the heaviest goal that trains it', () => {
		const camp = effectivePriorities(multiGoal(), m7Day(6, 0));
		expect(weightOfSession({ discipline: 'muay_thai' }, camp)).toBe(1);
		expect(weightOfSession({ discipline: 'running' }, camp)).toBe(0.6);
		expect(weightOfSession({ discipline: 'hypertrophy' }, camp)).toBe(0.4);
		expect(weightOfSession({ discipline: 'athletic' }, camp)).toBe(UNRANKED_SESSION_WEIGHT);
		expect(UNRANKED_SESSION_WEIGHT).toBe(RANK_WEIGHTS.at(-1));
	});

	it('states a kept trade-off naming both goals, and refuses one the wrong way round', () => {
		const [fight, marathon] = effectivePriorities(multiGoal(), m7Day(6, 0));
		expect(tradeoffSentence(fight!, marathon!, 'Hard sparring the day before the long run.')).toBe(
			'Hard sparring the day before the long run: kept, because Muay Thai fight ranks ahead of Marathon on this date, so Marathon gives way.'
		);
		expect(() => tradeoffSentence(marathon!, fight!, 'Hard sparring')).toThrow(RangeError);
	});

	it('gives priority_resolved facts that render a stored decision', () => {
		const camp = effectivePriorities(multiGoal(), m7Day(6, 0));
		const resolved = priorityFacts(camp, m7Day(6, 0), m7Day(10, 6))!;
		expect(resolved.ruleKey).toBe('priority.lead');
		expect(resolved.facts.modes).toBe(
			'Marathon trains alongside as secondary. Build muscle and Keep strength are held at maintenance.'
		);
		const log = new DecisionLog();
		const decision = log.add('priority_resolved', resolved.ruleKey, ['blocks.0'], resolved.facts);
		expect(validate(decisionPlanSchema, decision).ok).toBe(true);
		expect(decision.why).toBe(
			`Muay Thai fight leads from ${m7Day(6, 0)} to ${m7Day(10, 6)}. ${camp[0]!.why} ${resolved.facts.modes}`
		);

		const alone = effectivePriorities(inputOf(M7_SCENARIOS.hypertrophyBlock()), m7Day(1, 0));
		expect(priorityFacts(alone, m7Day(1, 0), m7Day(4, 6))?.facts.modes).toBe(
			'It is your only open goal.'
		);
	});

	it('cites only registered priority rules', () => {
		for (const key of Object.values(PRIORITY_RULE_KEYS)) {
			expect(RULE_BY_ID.get(key), key).toMatchObject({ area: 'priority', status: 'active' });
		}
	});
});

/** Every scenario on a spread of dates, with and without a phase. */
const CASES = (Object.keys(M7_SCENARIOS) as M7ScenarioKey[]).flatMap((key) =>
	[0, 3, 6, 9, 11, 20, 23, 25, 45].flatMap((week) =>
		[undefined, 'fight_camp', 'marathon_peak', 'realization'].map(
			(phase) => [key, week, phase as 'fight_camp' | undefined] as const
		)
	)
);

/** The same input with its goals (and their refs) in another order. */
function shuffled(input: ProgrammingInput, order: (n: number) => number[]): ProgrammingInput {
	const goals = input.maintenance ? 'paused' : 'goals';
	const idx = order(input[goals].length);
	return {
		...input,
		[goals]: idx.map((i) => input[goals][i]!),
		refs: { ...input.refs, [goals]: idx.map((i) => input.refs[goals][i]!) }
	};
}

describe('every verdict', () => {
	it.each(CASES)(
		'%s, week %i, phase %s: complete sentences, independent of goal order',
		(key, week, phase) => {
			const input = inputOf(M7_SCENARIOS[key]());
			const on = m7Day(week, 2);
			const priorities = effectivePriorities(input, on, { phase });
			expect(priorities.length).toBe((input.maintenance ? input.paused : input.goals).length);
			expect(priorities.filter((p) => p.mode === 'primary').length).toBe(input.maintenance ? 0 : 1);
			for (const p of priorities) {
				expect(p.why).toMatch(/^[A-Z].*\.$/);
				expect(p.why).not.toMatch(/\{|\}|undefined|null|NaN|\s{2}/);
				expect(p.why.length).toBeLessThanOrEqual(200);
				if (!input.maintenance) expect(p.why).toContain(p.title);
			}
			const reversed = (n: number) => [...Array(n).keys()].reverse();
			const rotated = (n: number) => [...Array(n).keys()].map((i) => (i + 1) % n);
			expect(effectivePriorities(shuffled(input, reversed), on, { phase })).toEqual(priorities);
			expect(effectivePriorities(shuffled(input, rotated), on, { phase })).toEqual(priorities);
			expect(effectivePriorities(input, on, { phase })).toEqual(priorities);
		}
	);

	it('orders goals of equal rank the same way whatever order they come in', () => {
		const input = multiGoal({ Marathon: { priority: 3 } });
		const on = m7Day(1, 0);
		expect(
			effectivePriorities(
				shuffled(input, (n) => [...Array(n).keys()].reverse()),
				on
			)
		).toEqual(effectivePriorities(input, on));
	});
});
