import { describe, expect, it } from 'vitest';
import { staticRuleKeys } from '../../../../../scripts/rule-keys';
import type { IsoDate } from '../../calendar';
import { CATALOGUE } from '../../exercises/index';
import type { Goal, TrainingProfile } from '../../profile/types';
import { decisionPlanSchema } from '../../training/schemas';
import { validate } from '../../validation';
import { DecisionLog } from '../decisions';
import { generateProgram } from '../generate';
import { buildProgrammingInput } from '../input';
import { maintenanceDoses } from '../priority/doses';
import { RULE_BY_ID } from '../rules/registry/index';
import { OVERLAP } from '../rules/season';
import { M7_SCENARIOS, m7Day } from './scenarios';
import { seasonWindows } from './windows';
import type { SeasonWindow } from './windows';

const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

const FROM = m7Day(1, 0);

/** Each window as [kind, first Monday, weeks, leader]. */
const outline = (windows: readonly SeasonWindow[]) =>
	windows.map((w) => [w.kind, w.from, w.weeks, w.leader?.title ?? null]);

const modeOf = (w: SeasonWindow, title: string) => w.modes.find((m) => m.title === title)?.mode;

/** `profile` with another event goal, ranked `priority`, on `date`. */
function withRace(profile: TrainingProfile, priority: number, date: IsoDate): TrainingProfile {
	const race: Goal = {
		...profile.goals.find((g) => g.kind === 'event')!,
		id: '00000000-0000-4000-8007-000000000999',
		title: '10K race',
		disciplines: ['running'],
		eventType: '10K race',
		eventDate: date,
		priority
	};
	const goals = profile.goals.map((g) =>
		g.priority !== null && g.priority >= priority ? { ...g, priority: g.priority + 1 } : g
	);
	return { ...profile, goals: [...goals, race] };
}

describe('seasonWindows', () => {
	it('lays out PRD §2: fight camp, recovery, the marathon build, recovery, then the muscle fill', () => {
		const windows = seasonWindows(inputOf(M7_SCENARIOS.multiGoal()), FROM, m7Day(40, 6));
		expect(outline(windows)).toEqual([
			['event', m7Day(1, 0), 10, 'Muay Thai fight'],
			['recovery', m7Day(11, 0), 1, null],
			['event', m7Day(12, 0), 13, 'Marathon'],
			['recovery', m7Day(25, 0), 2, null],
			['fill', m7Day(27, 0), 14, 'Build muscle']
		]);
		const [camp, , build, , rest] = windows as [SeasonWindow, ...SeasonWindow[]];

		// Fight camp: the marathon trains alongside, muscle and strength are held at their doses.
		// The fight already leads, so the two weeks before its 8-week camp join it (LEAD_IN).
		expect(camp).toMatchObject({
			ruleKey: 'season.lead_in',
			why: expect.stringMatching(/from the first day/),
			blockType: 'fight_camp',
			phases: ['fight_camp'],
			to: m7Day(10, 6)
		});
		expect(camp.modes.map((m) => [m.title, m.mode])).toEqual([
			['Muay Thai fight', 'primary'],
			['Marathon', 'secondary'],
			['Build muscle', 'maintenance'],
			['Keep strength', 'maintenance']
		]);
		expect(camp.doses.map((d) => [d.goal.title, d.stream, d.leader?.title])).toEqual([
			['Build muscle', 'hypertrophy', 'Muay Thai fight'],
			['Keep strength', 'strength', 'Muay Thai fight']
		]);
		// The marathon's run-up opens in week 9: the fight, ranked higher, keeps those weeks.
		expect(camp.overlaps).toEqual([
			expect.objectContaining({
				title: 'Marathon',
				from: m7Day(9, 0),
				to: m7Day(10, 6),
				form: 'maintenance',
				taper: null,
				ruleKey: 'season.overlap'
			})
		]);
		expect(camp.overlaps[0]!.doses.map((d) => [d.stream, d.leader?.title])).toEqual([
			['runs', 'Muay Thai fight']
		]);

		// The marathon's build: strength and muscle held, the marathon's phases in full.
		expect(build).toMatchObject({
			blockType: 'marathon',
			phases: ['marathon_base', 'marathon_build', 'marathon_peak', 'marathon_taper'],
			to: m7Day(24, 6),
			event: { title: 'Marathon', kind: 'marathon', date: m7Day(24, 6) }
		});
		expect(modeOf(build!, 'Build muscle')).toBe('maintenance');
		expect(modeOf(build!, 'Keep strength')).toBe('maintenance');
		expect(build!.facts.priority).toMatchObject({ ruleKey: 'priority.lead' });

		// After the marathon: two recovery weeks, then Build muscle, the top undated goal, leads.
		expect(windows[3]).toMatchObject({ ruleKey: 'season.recovery', doses: [] });
		expect(rest).toMatchObject({ ruleKey: 'season.fill', blockType: 'hypertrophy' });
		// No later run-up closes the tail, so a horizon that cuts it short is not a short gap.
		const cut = seasonWindows(inputOf(M7_SCENARIOS.multiGoal()), FROM, m7Day(28, 6)).at(-1);
		expect(cut).toMatchObject({ kind: 'fill', weeks: 2, ruleKey: 'season.fill' });
	});

	it('plans no hypertrophy window before the meet (S12)', () => {
		const windows = seasonWindows(inputOf(M7_SCENARIOS.meetPrep()), FROM, m7Day(20, 6));
		const meetOn = m7Day(10, 5);
		expect(outline(windows)).toEqual([
			['event', m7Day(1, 0), 10, 'Powerlifting meet'],
			['fill', m7Day(11, 0), 10, 'Build muscle']
		]);
		expect(windows.filter((w) => w.blockType === 'hypertrophy' && w.from < meetOn)).toEqual([]);
		const [prep] = windows;
		expect(prep).toMatchObject({
			blockType: 'strength',
			phases: ['accumulation', 'intensification', 'realization', 'taper']
		});
		expect(prep!.modes.find((m) => m.title === 'Build muscle')).toMatchObject({
			mode: 'maintenance',
			why: expect.stringMatching(/Meet prep trains the competition lifts heavy/)
		});
		expect(windows[1]).toMatchObject({ blockType: 'hypertrophy', phases: ['hypertrophy'] });
	});

	it('runs a marathon alone up to race day, then recovery, then maintenance', () => {
		const profile = M7_SCENARIOS.runnerLifter();
		profile.goals = profile.goals.filter((g) => g.kind === 'event');
		const windows = seasonWindows(inputOf(profile), FROM, m7Day(24, 6));
		expect(outline(windows)).toEqual([
			['event', m7Day(1, 0), 16, 'Marathon'],
			['recovery', m7Day(17, 0), 2, null],
			['maintenance', m7Day(19, 0), 6, null]
		]);
		expect(windows[0]!.phases).toEqual([
			'marathon_base',
			'marathon_build',
			'marathon_peak',
			'marathon_taper'
		]);
		expect(windows[2]!.ruleKey).toBe('season.maintenance.no_building_goal');
	});

	it('resolves overlapping events by rank, with a mini-taper for the event inside', () => {
		const windows = seasonWindows(
			inputOf(withRace(M7_SCENARIOS.meetPrep(), 2, m7Day(7, 5))),
			FROM,
			m7Day(12, 6)
		);
		// The race's whole run-up falls inside the meet's: it has no window of its own.
		expect(outline(windows)).toEqual([
			['event', m7Day(1, 0), 10, 'Powerlifting meet'],
			['fill', m7Day(11, 0), 2, 'Build muscle']
		]);
		const [overlap] = windows[0]!.overlaps;
		expect(overlap).toMatchObject({
			title: '10K race',
			from: m7Day(2, 0),
			to: m7Day(7, 6),
			form: 'mini_taper',
			taper: { form: 'mini', days: { from: m7Day(7, 2), to: m7Day(7, 4) } }
		});
		expect(overlap!.taper!.days!.factor).toBe(OVERLAP.eventInside.factor);
	});

	it('never puts two tapers in one week: a race in the meet’s taper week is trained through', () => {
		const windows = seasonWindows(
			inputOf(withRace(M7_SCENARIOS.meetPrep(), 2, m7Day(10, 2))),
			FROM,
			m7Day(12, 6)
		);
		expect(windows[0]!.overlaps).toEqual([
			expect.objectContaining({ title: '10K race', form: 'train_through', taper: null })
		]);
	});

	it('trains through an event inside a higher-ranked run-up when its goal is held at maintenance', () => {
		const windows = seasonWindows(
			inputOf(withRace(M7_SCENARIOS.meetPrep(), 3, m7Day(7, 5))),
			FROM,
			m7Day(12, 6)
		);
		expect(modeOf(windows[0]!, '10K race')).toBe('maintenance');
		expect(windows[0]!.overlaps).toEqual([
			expect.objectContaining({ title: '10K race', form: 'train_through', taper: null })
		]);
	});

	it('trains through an event inside a higher-ranked event’s recovery week', () => {
		const windows = seasonWindows(
			inputOf(withRace(M7_SCENARIOS.multiGoal(), 9, m7Day(11, 5))),
			FROM,
			m7Day(14, 6)
		);
		const recovery = windows.find((w) => w.kind === 'recovery' && w.from === m7Day(11, 0))!;
		expect(recovery.overlaps.find((o) => o.title === '10K race')).toMatchObject({
			form: 'train_through',
			taper: null,
			why: expect.stringMatching(/a recovery’s weeks/)
		});
	});

	it('starts with the recovery of a fight the Saturday before the season starts', () => {
		const profile = M7_SCENARIOS.multiGoal();
		profile.goals = profile.goals.map((g) =>
			g.title === 'Muay Thai fight' ? { ...g, eventDate: m7Day(0, 5) } : g
		);
		const [first, second] = seasonWindows(inputOf(profile), FROM, m7Day(20, 6));
		expect(first).toMatchObject({
			kind: 'recovery',
			from: FROM,
			weeks: 1,
			event: { title: 'Muay Thai fight', date: m7Day(0, 5) }
		});
		expect(second).toMatchObject({ kind: 'fill', from: m7Day(2, 0) });
	});

	it('gives an event under 3 weeks away only a taper', () => {
		const profile = M7_SCENARIOS.multiGoal();
		profile.goals = profile.goals.map((g) =>
			g.title === 'Muay Thai fight' ? { ...g, eventDate: m7Day(2, 5) } : g
		);
		const [first] = seasonWindows(inputOf(profile), FROM, m7Day(4, 6));
		expect(first).toMatchObject({
			kind: 'event',
			weeks: 2,
			phases: ['taper'],
			leader: { title: 'Muay Thai fight' },
			why: expect.stringMatching(/only its taper is planned/)
		});
	});

	it('fills a season with no events, and holds an off-season of keep goals at maintenance', () => {
		const fill = seasonWindows(inputOf(M7_SCENARIOS.hypertrophyBlock()), FROM, m7Day(12, 6));
		expect(outline(fill)).toEqual([['fill', FROM, 12, 'Build muscle']]);
		expect(fill[0]).toMatchObject({ blockType: 'hypertrophy', doses: [], ruleKey: 'season.fill' });

		const input = inputOf(M7_SCENARIOS.offSeason());
		const off = seasonWindows(input, FROM, m7Day(12, 6));
		expect(outline(off)).toEqual([['maintenance', FROM, 12, null]]);
		expect(off[0]).toMatchObject({
			ruleKey: 'season.maintenance.no_building_goal',
			facts: { priority: null }
		});
		expect(off[0]!.doses).toEqual(maintenanceDoses(input, FROM));
		expect(off[0]!.modes.every((m) => m.mode === 'maintenance')).toBe(true);
	});

	it('turns a 3-week gap after a recovery into maintenance, and a 4-week one into a fill', () => {
		// multiGoal with the marathon's place taken by a 10K race.
		const fightThenRace = (raceWeek: number) => {
			const profile = M7_SCENARIOS.multiGoal();
			profile.goals = profile.goals.filter((g) => g.title !== 'Marathon');
			return withRace(profile, 2, m7Day(raceWeek, 5));
		};
		const gap = (raceWeek: number) =>
			seasonWindows(inputOf(fightThenRace(raceWeek)), FROM, m7Day(raceWeek, 6))
				.map((w) => [w.kind, w.weeks, w.ruleKey])
				.slice(1, 3);
		// The fight's recovery is week 11; the race's 6-week run-up starts in week 15 or 16.
		expect(gap(20)).toEqual([
			['recovery', 1, 'season.recovery'],
			['maintenance', 3, 'season.maintenance.short_gap']
		]);
		expect(gap(21)).toEqual([
			['recovery', 1, 'season.recovery'],
			['fill', 4, 'season.fill']
		]);
	});

	it('writes facts every decision template renders and the plan schema accepts', () => {
		const windows = seasonWindows(inputOf(M7_SCENARIOS.longSeason()), FROM, m7Day(52, 6));
		const log = new DecisionLog();
		for (const { facts } of windows) {
			if (facts.priority)
				log.add('priority_resolved', facts.priority.ruleKey, [], facts.priority.facts);
			log.add('block_type_chosen', facts.block.ruleKey, [], facts.block.facts);
			for (const dose of facts.doses) log.add('maintenance_dose', dose.ruleKey, [], dose.facts);
		}
		for (const decision of log.list()) {
			expect(validate(decisionPlanSchema, decision).ok, decision.why).toBe(true);
			expect(RULE_BY_ID.has(decision.ruleKey), decision.ruleKey).toBe(true);
		}
		expect(windows.map((w) => w.to).at(-1)).toBe(m7Day(52, 6));
	});

	it('cites only registered season, maintenance and priority rule keys', () => {
		const cited = [...staticRuleKeys(['src/lib/domain/programming/periodisation/windows.ts'])];
		expect(cited.length).toBeGreaterThan(5);
		for (const key of cited) {
			expect(['season', 'maintenance', 'priority'], key).toContain(RULE_BY_ID.get(key)?.area);
		}
	});
});

describe('seasonWindows with paused goals', () => {
	it('is one maintenance window over input.paused, with no leader, when every goal is paused', () => {
		const input = inputOf(M7_SCENARIOS.allPaused());
		const windows = seasonWindows(input, FROM, m7Day(12, 6));
		expect(windows).toHaveLength(1);
		const [held] = windows;
		expect(held).toMatchObject({
			kind: 'maintenance',
			from: FROM,
			to: m7Day(12, 6),
			leader: null,
			phases: ['maintenance'],
			ruleKey: 'season.maintenance.paused',
			facts: { priority: null }
		});
		expect(held!.goalRefs).toEqual(input.refs.paused);
		expect(held!.doses).toEqual(maintenanceDoses(input, FROM));
		expect(held!.facts.doses.map((d) => d.ruleKey)).toEqual([
			'maintenance.strength',
			'maintenance.runs'
		]);
		// M3 plans the same goals at phase maintenance.
		const m3 = generateProgram(input, { startsOn: FROM, firstPlannedDay: FROM }).blocks[0]!;
		expect(m3.phase).toBe('maintenance');
		expect(held!.goalRefs).toEqual(m3.goalRefs);
	});

	it('leaves a paused goal among active ones out of every window', () => {
		const profile = M7_SCENARIOS.multiGoal();
		const paused = profile.goals.find((g) => g.title === 'Keep strength')!;
		profile.goals = profile.goals.map((g) => (g === paused ? { ...g, status: 'paused' } : g));
		const windows = seasonWindows(inputOf(profile), FROM, m7Day(28, 6));
		expect(windows.length).toBeGreaterThan(1);
		for (const w of windows) {
			expect(w.goalRefs).not.toContain(paused.id);
			expect(w.modes.map((m) => m.title)).not.toContain('Keep strength');
			expect(w.doses.map((d) => d.goal.id)).not.toContain(paused.id);
		}
	});

	it('is deterministic, whatever order the goals come in', () => {
		const profile = M7_SCENARIOS.longSeason();
		const once = seasonWindows(inputOf(profile), FROM, m7Day(52, 6));
		const reversed = { ...profile, goals: [...profile.goals].reverse() };
		expect(seasonWindows(inputOf(reversed), FROM, m7Day(52, 6))).toEqual(once);
		expect(seasonWindows(inputOf(profile), FROM, m7Day(52, 6))).toEqual(once);
	});
});
