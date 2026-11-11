/**
 * generator-combat: generated Muay Thai follows the fight camp. A camp week's Muay Thai comes up to
 * its planned sessions with the classes counted, its hard sparring up to its planned number with
 * each hard class counted and none in the 7 days before the fight, its conditioning in 3-minute
 * rounds, and its fight week is technique and light pads. The commitments stay; a goal held at
 * maintenance gives the camp room only down to its dose, never a run. A Muay Thai goal that does
 * not lead keeps technique and pads, without sparring.
 */
import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, weekdayOf } from '../calendar';
import { CATALOGUE } from '../exercises/index';
import type { TrainingProfile } from '../profile/types';
import { plannedHardSets } from '../training/metrics';
import type { OtherSessionPlan, ProgramPlan, SessionPlan, WeekPlan } from '../training/types';
import { fromCommitmentIntensity } from '../training/vocabulary';
import { evaluateWeek } from './evaluate/week';
import { generateProgram } from './generate';
import { buildProgrammingInput } from './input';
import { demandOf } from './interference';
import { CAMP_CONDITIONING } from './other';
import { M7_SCENARIOS } from './periodisation/scenarios';
import { eventKindOf } from './priority/weights';
import { SPARRING_MAX } from './rules/concurrent';
import { CONDITIONING, FIGHT_WEEK, LAST_HARD_SPARRING } from './rules/fight-camp';
import { DOSES } from './rules/maintenance';
import { PLAN_BUDGET } from './rules/road';
import { MAJOR_GROUPS } from './rules/volume';
import { SCENARIO_START, SCENARIOS } from './scenarios';

const OPTIONS = { startsOn: SCENARIO_START, firstPlannedDay: SCENARIO_START };
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });
const MUSCLES = new Map(CATALOGUE.map((e) => [e.key, e]));

const generatedOther = (week: WeekPlan) =>
	week.sessions.filter(
		(s): s is OtherSessionPlan => s.kind === 'other' && s.source === 'generator'
	);
const formatsIn = (week: WeekPlan, kind: OtherSessionPlan['details']['kind']) =>
	generatedOther(week).filter((s) => s.details.kind === kind);
const classesIn = (week: WeekPlan) =>
	week.sessions.filter((s) => s.source === 'commitment' && s.discipline === 'muay_thai');
const metric = (s: OtherSessionPlan, key: string) =>
	s.details.metrics.find((m) => m.key === key)?.value;
const fightOf = (profile: TrainingProfile) =>
	profile.goals.find((g) => eventKindOf(g) === 'fight')!.eventDate!;

/** The two camps: the journey's (moderate classes) and multiGoal's (S1, hard classes). */
const CAMPS = [
	['journey', SCENARIOS.journey],
	['multiGoal', M7_SCENARIOS.multiGoal]
] as const;

function campOf(profile: () => TrainingProfile) {
	const plan = generateProgram(inputOf(profile()), OPTIONS);
	const block = plan.blocks[0]!;
	return { plan, block, weeks: block.weeks, fight: fightOf(profile()) };
}

describe.each(CAMPS)('%s’s fight camp', (_, profile) => {
	const { plan, block, weeks, fight } = campOf(profile);

	it('is the first block, every week with its combat targets', () => {
		expect(block.phase).toBe('fight_camp');
		expect(weeks.length).toBeGreaterThanOrEqual(5);
		for (const week of weeks) expect(week.targets.combat, week.startsOn).toBeDefined();
	});

	it('holds hard sparring, classes counted, to the week’s target and at most 2, none in the last 7 days', () => {
		const last = addDays(fight, -LAST_HARD_SPARRING.daysOut);
		for (const week of weeks) {
			const hardClasses = classesIn(week).filter((s) => demandOf(s).hardCombat).length;
			const sparring = formatsIn(week, 'sparring');
			const target = week.targets.combat!.hardSparring;
			expect(sparring.length + hardClasses, week.startsOn).toBeLessThanOrEqual(
				Math.max(target, hardClasses)
			);
			expect(sparring.length, week.startsOn).toBeLessThanOrEqual(SPARRING_MAX);
			for (const s of sparring) {
				expect(s.date <= last, `${s.date} sparring, fight on ${fight}`).toBe(true);
				expect(metric(s, 'rounds')).toBe(week.targets.combat!.sparringRounds);
			}
		}
	});

	it('plans conditioning in 3-minute rounds in the weeks that ask for rounds, and only those', () => {
		const asking = weeks.filter((w) => w.targets.combat!.conditioningRounds > 0);
		expect(asking.length).toBeGreaterThan(1);
		for (const week of weeks) {
			const rounds = week.targets.combat!.conditioningRounds;
			const conditioning = formatsIn(week, 'conditioning');
			if (!rounds) {
				expect(conditioning, week.startsOn).toEqual([]);
				continue;
			}
			expect(conditioning.length, week.startsOn).toBeGreaterThan(0);
			expect(conditioning.length).toBeLessThanOrEqual(CONDITIONING.sessions);
			for (const s of conditioning) {
				expect(s).toMatchObject({ type: 'conditioning', discipline: 'muay_thai' });
				expect(metric(s, 'rounds')).toBe(rounds);
				expect(metric(s, 'round_length')).toBe(CONDITIONING.roundMinutes);
				expect(s.estMinutes).toBe(
					CAMP_CONDITIONING.warmUpMinutes + rounds * CONDITIONING.roundMinutes
				);
			}
		}
		// The middle weeks: neither the first week nor the fight week.
		expect(asking.every((w) => w !== weeks[0] && w !== weeks.at(-1))).toBe(true);
	});

	it('makes the fight week technical: technique and light pads only, no sparring or conditioning', () => {
		const fightWeek = weeks.at(-1)!;
		expect(fightWeek.kind).toBe('event');
		expect(daysBetween(fightWeek.startsOn, fight)).toBeLessThan(7);
		const sessions = generatedOther(fightWeek).filter((s) => s.type !== 'mobility');
		expect(sessions.length).toBeGreaterThan(0);
		for (const s of sessions) {
			expect(FIGHT_WEEK.formats as readonly string[]).toContain(s.details.kind);
			expect(s.targetRpe).toBeLessThanOrEqual(FIGHT_WEEK.rpe);
			expect(s.estMinutes).toBeLessThanOrEqual(FIGHT_WEEK.minutes);
		}
	});

	it('keeps the commitments as they are, and counts them toward the week’s Muay Thai', () => {
		const told = inputOf(profile()).commitments;
		for (const week of weeks) {
			const classes = classesIn(week);
			expect(
				classes.map((s) => [weekdayOf(s.date), s.timeOfDay, s.estMinutes, s.intensity]),
				week.startsOn
			).toEqual(
				told.flatMap((c) =>
					c.days.map((day) => [
						day,
						c.timeOfDay,
						c.durationMinutes,
						fromCommitmentIntensity(c.intensity)
					])
				)
			);
			const muayThai = generatedOther(week).filter((s) => s.type === 'muay_thai');
			expect(muayThai.length + classes.length, week.startsOn).toBeLessThanOrEqual(
				Math.max(week.targets.combat!.sessions, classes.length)
			);
		}
	});

	it('passes the evaluator’s sparring_cap and event_protection in every camp week', () => {
		const input = inputOf(profile());
		const events = input.goals.flatMap((goal, i) => {
			const kind = eventKindOf(goal);
			return kind && goal.eventDate
				? [{ date: goal.eventDate, kind, title: goal.title, goalId: input.refs.goals[i]! }]
				: [];
		});
		for (const week of weeks) {
			const { findings } = evaluateWeek(week.sessions, {
				context: { events, week: { kind: week.kind, phase: block.phase, targets: week.targets } }
			});
			const rules = findings.map((f) => f.rule);
			expect(rules, week.startsOn).not.toContain('sparring_cap');
			expect(rules, week.startsOn).not.toContain('event_protection');
		}
	});

	it('gives the camp room from strength held at maintenance down to its dose, never from a run', () => {
		const taken = plan.decisions.filter((d) => d.ruleKey === 'generator.camp_room');
		for (const d of taken) {
			expect(d.kind).toBe('session_dropped');
			expect(String(d.evidence.session)).toMatch(/^Strength /);
		}
		for (const week of weeks) {
			const lifts = week.sessions.filter((s) => s.kind === 'strength');
			expect(lifts.length, week.startsOn).toBeGreaterThanOrEqual(DOSES.strength.sessions.min);
		}
	});

	it('is the same plan every run', () => {
		expect(JSON.stringify(campOf(profile).plan)).toBe(JSON.stringify(plan));
	});
});

describe('the journey’s camp, with moderate classes', () => {
	it('plans its own hard sparring, since no class counts toward it', () => {
		const { weeks } = campOf(SCENARIOS.journey);
		const sparring = weeks.map((w) => formatsIn(w, 'sparring').length);
		expect(sparring.slice(0, -1).every((n) => n > 0)).toBe(true);
		expect(sparring.at(-1)).toBe(0);
	});
});

describe('a camp with no classes', () => {
	it('places the fight week’s technique and pads before the fight, never on its day', () => {
		const profile = () => {
			const p = SCENARIOS.journey();
			p.goals = [p.goals[0]!, { ...p.goals[2]!, priority: 2 }];
			p.schedule = { ...p.schedule, daysPerWeek: 6, commitments: [] };
			const updatedAt = p.profile.updatedAt;
			p.muayThai = { sessionsPerWeek: 3, sparringPerWeek: 1, fights: 0, notes: null, updatedAt };
			return p;
		};
		const { weeks, fight } = campOf(profile);
		const muayThai = generatedOther(weeks.at(-1)!).filter((s) => s.type === 'muay_thai');
		expect(muayThai.length).toBeGreaterThan(0);
		expect(muayThai.map((s) => s.date).filter((d) => d >= fight)).toEqual([]);
	});
});

describe('multiGoal’s camp (S1)', () => {
	const { plan, weeks } = campOf(M7_SCENARIOS.multiGoal);

	it('plans no sparring of its own: the two hard classes a week are its sparring', () => {
		for (const week of weeks) {
			expect(classesIn(week).filter((s) => demandOf(s).hardCombat)).toHaveLength(2);
			expect(formatsIn(week, 'sparring'), week.startsOn).toEqual([]);
		}
	});

	it('takes Strength B for its conditioning, with one decision for the block', () => {
		const taken = plan.decisions.filter((d) => d.ruleKey === 'generator.camp_room');
		expect(taken).toEqual([
			expect.objectContaining({
				kind: 'session_dropped',
				evidence: expect.objectContaining({ session: 'Strength B' })
			})
		]);
		expect(taken[0]!.refs.length).toBeGreaterThan(1);
	});

	it('keeps every week’s long run, held running goal and all', () => {
		for (const week of weeks) {
			expect(
				week.sessions.some((s) => s.kind === 'run' && s.type === 'long_run'),
				week.startsOn
			).toBe(true);
		}
	});

	it('holds build muscle at maintenance through the camp, with its decision', () => {
		expect(
			plan.decisions.find(
				(d) => d.kind === 'maintenance_dose' && d.evidence.goal === 'Build muscle'
			)
		).toMatchObject({ refs: ['blocks.0'], evidence: { leader: 'Muay Thai fight' } });
		const [, most] = DOSES.hypertrophy.hardSets;
		for (const week of weeks) {
			expect(week.targets.maintenance, week.startsOn).toContain('strength');
			const sets = plannedHardSets(week, MUSCLES).groups;
			for (const group of Object.keys(MAJOR_GROUPS) as (keyof typeof MAJOR_GROUPS)[]) {
				expect(sets[group] ?? 0, `${week.startsOn} ${group}`).toBeLessThanOrEqual(most);
			}
			for (const s of week.sessions) {
				if (s.kind !== 'strength') continue;
				for (const e of s.exercises) {
					for (const line of e.sets) {
						expect(line.targetRpe ?? 0, s.date).toBeLessThanOrEqual(DOSES.strength.topSetRpeCap);
					}
				}
			}
		}
	});
});

describe('a Muay Thai goal that does not lead', () => {
	it('keeps technique and pads, with no sparring, though the owner spars', () => {
		// journeyHybrid on every day without its classes, so it generates two Muay Thai sessions a week.
		const profile = M7_SCENARIOS.journeyHybrid();
		profile.schedule.commitments = [];
		profile.schedule.daysPerWeek = 7;
		profile.schedule.availableDays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
		const updatedAt = profile.profile.updatedAt;
		profile.muayThai = {
			sessionsPerWeek: 3,
			sparringPerWeek: 2,
			fights: 0,
			notes: null,
			updatedAt
		};
		const plan = generateProgram(inputOf(profile), OPTIONS);
		const muayThai = plan.blocks[0]!.weeks.flatMap((w) =>
			generatedOther(w).filter((s) => s.type === 'muay_thai')
		);
		expect(muayThai.length).toBeGreaterThan(plan.blocks[0]!.weeks.length);
		for (const s of muayThai) expect(['technical', 'pad_work']).toContain(s.details.kind);
		expect(muayThai.map((s) => s.details.kind)).toContain('pad_work');
	});

	it('leaves the journey profile’s weeks with no generated sparring or conditioning', () => {
		const plan: ProgramPlan = generateProgram(inputOf(M7_SCENARIOS.journeyHybrid()), OPTIONS);
		const camp = (s: SessionPlan) =>
			s.kind === 'other' && ['sparring', 'conditioning'].includes(s.details.kind);
		expect(plan.blocks[0]!.weeks.flatMap((w) => w.sessions).filter(camp)).toEqual([]);
	});
});

describe('the plan budget', () => {
	it('keeps longSeason, whose first block is a fight camp, within PLAN_BUDGET', () => {
		const plan = generateProgram(inputOf(M7_SCENARIOS.longSeason()), OPTIONS);
		expect(plan.blocks[0]!.phase).toBe('fight_camp');
		expect(plan.blocks.length).toBeLessThanOrEqual(PLAN_BUDGET.blocks);
		expect(plan.decisions.length).toBeLessThanOrEqual(PLAN_BUDGET.decisions);
	});
});
