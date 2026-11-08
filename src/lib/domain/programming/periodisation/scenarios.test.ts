import { describe, expect, it } from 'vitest';
import { daysBetween } from '../../calendar';
import { CATALOGUE } from '../../exercises/index';
import {
	baselinesSchema,
	basicsSchema,
	equipmentSchema,
	experienceSchema,
	goalSchema,
	injuriesSchema,
	scheduleSchema,
	specificsSchema
} from '../../profile/schemas';
import type { TrainingProfile } from '../../profile/types';
import { programPlanSchema } from '../../training/schemas';
import { validate } from '../../validation';
import { buildProgrammingInput, generateProgram } from '../index';
import { weeksToEvent } from '../input';
import { SCENARIO_START, SCENARIOS } from '../scenarios';
import { COVERAGE_IDS, NAMED_CASES, PRD_EXAMPLES } from './coverage';
import { HISTORY_COVERAGE } from './histories';
import { LONG_SEASON_WEEKS, M7_SCENARIOS, m7Day, SCENARIO_COVERAGE } from './scenarios';
import type { M7ScenarioKey } from './scenarios';

const KEYS = Object.keys(M7_SCENARIOS) as M7ScenarioKey[];
const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

/** Each onboarding step's form as M2 validates it, filled from `profile`. */
function forms(p: TrainingProfile) {
	return {
		basics: validate(basicsSchema, p.profile),
		...Object.fromEntries(p.goals.map((g) => [`goal ${g.title}`, validate(goalSchema, g)])),
		experience: validate(experienceSchema, { entries: p.experience }),
		baselines: validate(baselinesSchema, {
			unknown: p.profile.baselinesUnknown,
			lifts: p.baselines
		}),
		specifics: validate(specificsSchema, { running: p.running, muayThai: p.muayThai }),
		equipment: validate(equipmentSchema, p.equipment),
		injuries: validate(injuriesSchema, { injuries: p.injuries }),
		schedule: validate(scheduleSchema, p.schedule)
	};
}

/** The week (from 1) each event lands in, by goal title: the profiles' stated intent. */
const EVENT_WEEKS: Record<M7ScenarioKey, Record<string, number>> = {
	multiGoal: { 'Muay Thai fight': 10, Marathon: 24 },
	hybridSwap: { Marathon: 20 },
	marathonTaper: { Marathon: 3 },
	hypertrophyBlock: {},
	meetPrep: { 'Powerlifting meet': 10 },
	runnerLifter: { Marathon: 16 },
	longSeason: { 'Muay Thai fight': 8, 'Powerlifting meet': 22, Marathon: 44 },
	offSeason: {},
	allPaused: {},
	journeyHybrid: { Marathon: 20 }
};

/** Each profile's goals by rank, as title and discipline. */
const RANKED: Record<M7ScenarioKey, string[]> = {
	multiGoal: ['Muay Thai fight', 'Marathon', 'Build muscle', 'Keep strength'],
	hybridSwap: ['Stay strong', 'Marathon', 'Muay Thai'],
	marathonTaper: ['Marathon', 'Keep strength'],
	hypertrophyBlock: ['Build muscle'],
	meetPrep: ['Powerlifting meet', 'Build muscle'],
	runnerLifter: ['Marathon', 'Get stronger'],
	longSeason: ['Muay Thai fight', 'Marathon', 'Powerlifting meet', 'Build muscle', 'Keep strength'],
	offSeason: ['Keep strength', 'Keep running fitness'],
	allPaused: [],
	journeyHybrid: ['Marathon', 'Keep strength', 'Muay Thai']
};

describe('M7_SCENARIOS', () => {
	it.each(KEYS)('%s passes every M2 onboarding form', (key) => {
		for (const [form, result] of Object.entries(forms(M7_SCENARIOS[key]())))
			expect({ form, ok: result.ok }).toEqual({ form, ok: true });
	});

	it.each(KEYS)('%s builds a programming input with its goals in rank order', (key) => {
		const input = inputOf(M7_SCENARIOS[key]());
		expect(input.goals.map((g) => g.title)).toEqual(RANKED[key]);
	});

	it.each(KEYS)("%s generates a plan M3's schema accepts", (key) => {
		const plan = generateProgram(inputOf(M7_SCENARIOS[key]()), {
			startsOn: SCENARIO_START,
			firstPlannedDay: SCENARIO_START
		});
		const checked = validate(programPlanSchema, plan);
		expect(checked.ok ? [] : checked.errors).toEqual([]);
		expect(plan.blocks.length).toBeGreaterThan(0);
	});

	it.each(KEYS)('%s puts each event in its intended week', (key) => {
		const profile = M7_SCENARIOS[key]();
		const events = Object.fromEntries(
			profile.goals.flatMap((g) => (g.eventDate ? [[g.title, g.eventDate]] : []))
		);
		const weeks = Object.fromEntries(
			Object.entries(events).map(([title, date]) => [
				title,
				Math.floor(daysBetween(SCENARIO_START, date) / 7) + 1
			])
		);
		expect(weeks).toEqual(EVENT_WEEKS[key]);
		// The generator reads the same weeks: whole weeks from week 1's Monday.
		for (const goal of inputOf(profile).goals.filter((g) => g.eventDate))
			expect(weeksToEvent(goal, SCENARIO_START)).toBe(EVENT_WEEKS[key][goal.title]! - 1);
	});

	it('dates m7Day from SCENARIO_START: week 1 is the plan, week 0 the week before', () => {
		expect(m7Day(1, 0)).toBe(SCENARIO_START);
		expect(m7Day(0, 0)).toBe('2026-11-02');
		expect(m7Day(10, 5)).toBe('2027-01-16');
	});

	it('runs the longest season over its 52 weeks', () => {
		const ends = M7_SCENARIOS.longSeason().goals.map((g) => g.eventDate ?? g.targetDate);
		const last = ends
			.filter((d) => d !== null)
			.sort()
			.at(-1)!;
		expect(LONG_SEASON_WEEKS).toBe(52);
		expect(last).toBe(m7Day(52, 6));
	});

	it("gives allPaused M3's all-goals-paused input: maintenance, no goals, every goal paused", () => {
		const profile = M7_SCENARIOS.allPaused();
		const input = inputOf(profile);
		expect(input.maintenance).toBe(true);
		expect(input.goals).toEqual([]);
		expect(input.paused.map((g) => g.title)).toEqual(RANKED.offSeason);
		expect(input.refs.paused).toEqual(profile.goals.map((g) => g.id));
		// The same goals active plan without maintenance.
		expect(inputOf(M7_SCENARIOS.offSeason()).maintenance).toBe(false);
	});

	it('gives the journey every 1RM blank, hard classes Tue and Thu evenings and 5 days of 75 minutes', () => {
		const input = inputOf(M7_SCENARIOS.journeyHybrid());
		expect(Object.values(input.baselines).every((b) => b === null)).toBe(true);
		expect(input.commitments).toEqual([
			expect.objectContaining({
				discipline: 'muay_thai',
				days: ['tue', 'thu'],
				timeOfDay: 'evening',
				intensity: 'hard'
			})
		]);
		expect([input.daysPerWeek, input.sessionMinutes]).toEqual([5, 75]);
	});

	it("swaps M3's hybrid priorities and fills only the measures M2's goal form requires", () => {
		const { goals: swapped, ...rest } = M7_SCENARIOS.hybridSwap();
		const { goals: original, ...same } = SCENARIOS.hybrid();
		expect(rest).toEqual(same);
		const apart = (g: TrainingProfile['goals'][number]) => ({ ...g, priority: 0, measure: null });
		expect(swapped.map(apart)).toEqual(original.map(apart));
		expect(swapped.map((g) => g.priority)).toEqual([2, 1, 3]);
		expect(swapped.map((g) => g.measure !== null)).toEqual([false, true, true]);
	});

	it.each(KEYS)('%s returns a fresh copy on every call', (key) => {
		const first = M7_SCENARIOS[key]();
		first.goals.length = 0;
		first.schedule.commitments.push(first.schedule.commitments[0]!);
		expect(M7_SCENARIOS[key]()).not.toEqual(first);
		expect(M7_SCENARIOS[key]()).toEqual(M7_SCENARIOS[key]());
	});

	it('shares no nested arrays or Dates between calls or scenarios', () => {
		const pristine = structuredClone(KEYS.map((key) => M7_SCENARIOS[key]()));
		for (const key of KEYS) {
			const p = M7_SCENARIOS[key]();
			p.schedule.availableDays.length = 0;
			p.schedule.preferredTimes.length = 0;
			for (const g of p.goals) g.createdAt.setTime(0);
			p.experience[0]?.updatedAt.setTime(0);
		}
		expect(KEYS.map((key) => M7_SCENARIOS[key]())).toEqual(pristine);
	});
});

describe('coverage', () => {
	it('names S1–S12 with their PRD sentences, then the named cases', () => {
		expect(COVERAGE_IDS).toEqual([
			...Array.from({ length: 12 }, (_, i) => `S${i + 1}`),
			'budget',
			'maintenance',
			'paused',
			'journey'
		]);
		for (const example of Object.values(PRD_EXAMPLES)) expect(example.prd).toMatch(/\S.*\.$/);
		for (const words of Object.values(NAMED_CASES)) expect(words).toMatch(/\S.*\.$/);
	});

	it('has every fixture name coverage ids, and every id a fixture', () => {
		const named = [...Object.values(SCENARIO_COVERAGE), ...Object.values(HISTORY_COVERAGE)];
		for (const ids of named) {
			expect(ids.length).toBeGreaterThan(0);
			for (const id of ids) expect(COVERAGE_IDS).toContain(id);
		}
		expect(new Set(named.flat())).toEqual(new Set(COVERAGE_IDS));
		expect(Object.keys(SCENARIO_COVERAGE).sort()).toEqual([...KEYS].sort());
	});
});
