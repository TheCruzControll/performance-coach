import { describe, expect, it } from 'vitest';
import type { IsoDate } from '../../calendar';
import { CATALOGUE } from '../../exercises/index';
import type { TrainingProfile } from '../../profile/types';
import { buildProgrammingInput } from '../input';
import { M7_SCENARIOS, m7Day } from '../periodisation/scenarios';
import { DOSES } from '../rules/maintenance';
import { HARD_SET_RANGES } from '../rules/volume';
import { chooseSplit } from '../splits';
import { hardSetBand } from '../volume';
import { doseBand, dosesByBlock, dosesFor, maintenanceDoses } from './doses';
import type { GoalDose } from './doses';
import { effectivePriorities } from './weights';

const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });

/** The fight is in week 10: week 5 is inside its 8-week window, the marathon (week 24) is not. */
const IN_FIGHT_WINDOW = m7Day(5, 0);
/** The Monday after the fight: the marathon is 13 weeks out, inside its 16-week window. */
const AFTER_FIGHT = m7Day(11, 0);

const dosesOn = (profile: TrainingProfile, on: IsoDate) => {
	const input = inputOf(profile);
	return dosesFor(effectivePriorities(input, on), input);
};
const pairs = (doses: readonly GoalDose[]) =>
	doses.map((d) => [d.goal.title, d.stream, d.leader?.title ?? null]);

describe('maintenance doses', () => {
	it('in the fight window doses build muscle and keep strength, not the marathon or the fight', () => {
		const input = inputOf(M7_SCENARIOS.multiGoal());
		const priorities = effectivePriorities(input, IN_FIGHT_WINDOW);
		expect(priorities.map((p) => [p.title, p.mode])).toEqual([
			['Muay Thai fight', 'primary'],
			['Marathon', 'secondary'],
			['Build muscle', 'maintenance'],
			['Keep strength', 'maintenance']
		]);
		const doses = dosesFor(priorities, input);
		expect(pairs(doses)).toEqual([
			['Build muscle', 'hypertrophy', 'Muay Thai fight'],
			['Keep strength', 'strength', 'Muay Thai fight']
		]);
		// Both are M3's maintenance split, with only the top-set cap added.
		for (const { dose } of doses) {
			expect(dose).toMatchObject({
				sessions: { min: 1, max: 2 },
				layout: 'maintenance',
				setsPerSlot: 2,
				hardSets: [4, 10],
				topSetRpeCap: 8,
				words: '1–2 Keep sessions, 4–10 hard sets a group, top sets at RPE 8 at most'
			});
		}
	});

	it('after the fight, the marathon leads, and strength and muscle stay dosed', () => {
		const doses = dosesOn(M7_SCENARIOS.multiGoal(), AFTER_FIGHT);
		expect(pairs(doses)).toEqual([
			['Build muscle', 'hypertrophy', 'Marathon'],
			['Keep strength', 'strength', 'Marathon']
		]);
	});

	it('doses a held run goal from its recent volume and longest run', () => {
		// Keep running fitness ranked third of three is held: 0.4 is under half the leader's weight.
		const profile = M7_SCENARIOS.offSeason();
		profile.goals = [
			...profile.goals,
			{
				...profile.goals[0]!,
				id: '00000000-0000-4000-8007-000000000999',
				title: 'Lift more',
				priority: 2
			}
		].map((g) => (g.title === 'Keep running fitness' ? { ...g, priority: 3 } : g));
		const [runs] = dosesOn(profile, m7Day(1, 0));
		expect(runs).toMatchObject({ stream: 'runs', goal: { title: 'Keep running fitness' } });
		// offSeason runs 25 km a week, its longest 12 km: 60–70 % is 15–17.5 km, the long run held.
		expect(runs!.dose).toEqual({
			stream: 'runs',
			sessions: { min: 2, max: 3 },
			weeklyMetres: [15_000, 17_500],
			longRunMetres: 12_000,
			qualityRunsMax: 1,
			words:
				'2–3 runs at 60–70 % of your recent volume (15 km to 17.5 km), 1 quality run at most, the long run held at 12 km'
		});
	});

	it('gives a single goal no doses, and never a dose under one session', () => {
		expect(dosesOn(M7_SCENARIOS.hypertrophyBlock(), m7Day(1, 0))).toEqual([]);
		for (const { sessions } of Object.values(DOSES)) {
			expect(sessions.min).toBeGreaterThanOrEqual(1);
			expect(sessions.max).toBeGreaterThanOrEqual(sessions.min);
		}
		const every = [
			...maintenanceDoses(inputOf(M7_SCENARIOS.longSeason()), m7Day(1, 0)),
			...maintenanceDoses(inputOf(M7_SCENARIOS.journeyHybrid()), m7Day(1, 0))
		];
		expect(new Set(every.map((d) => d.stream))).toEqual(
			new Set(['muay_thai', 'runs', 'strength', 'hypertrophy'])
		);
		for (const { dose } of every) expect(dose.sessions.min).toBeGreaterThanOrEqual(1);
	});

	it('names both goals in every reason, and is deterministic whatever order the goals come in', () => {
		for (const on of [IN_FIGHT_WINDOW, AFTER_FIGHT]) {
			const doses = dosesOn(M7_SCENARIOS.multiGoal(), on);
			for (const d of doses) {
				expect(d.reason).toContain(d.goal.title);
				expect(d.reason).toContain(d.leader!.title);
				expect(d.reason.endsWith(DOSES[d.stream].why)).toBe(true);
			}
			const reversed = M7_SCENARIOS.multiGoal();
			reversed.goals.reverse();
			expect(dosesOn(reversed, on)).toEqual(doses);
		}
	});

	it('holds every paused goal at its dose with no leader, as M3 plans them', () => {
		const input = inputOf(M7_SCENARIOS.allPaused());
		const doses = maintenanceDoses(input, m7Day(1, 0));
		expect(pairs(doses)).toEqual([
			['Keep strength', 'strength', null],
			['Keep running fitness', 'runs', null]
		]);
		expect(doses[0]!.reason).toMatch(/^Every goal is paused/);
	});
});

describe('doses by block', () => {
	it('changes doses only at block boundaries', () => {
		const input = inputOf(M7_SCENARIOS.multiGoal());
		// The fight camp runs past the fight; the doses stay the camp's until the next block.
		const camp = { phase: 'fight_camp', startsOn: m7Day(7, 0), endsOn: m7Day(12, 6) } as const;
		const build = {
			phase: 'marathon_build',
			startsOn: m7Day(13, 0),
			endsOn: m7Day(16, 6)
		} as const;
		const keep = { phase: 'maintenance', startsOn: m7Day(17, 0), endsOn: m7Day(20, 6) } as const;
		const [a, b, c] = dosesByBlock(input, [camp, build, keep]);

		const campStart = dosesFor(
			effectivePriorities(input, camp.startsOn, { phase: 'fight_camp' }),
			input
		);
		const campEnd = dosesFor(
			effectivePriorities(input, camp.endsOn, { phase: 'fight_camp' }),
			input
		);
		expect(a).toEqual({ startsOn: camp.startsOn, endsOn: camp.endsOn, doses: campStart });
		expect(pairs(campEnd)).not.toEqual(pairs(campStart));
		expect(pairs(b!.doses)).toEqual([
			['Build muscle', 'hypertrophy', 'Marathon'],
			['Keep strength', 'strength', 'Marathon']
		]);
		// A maintenance block holds every goal, the leaders too.
		expect(pairs(c!.doses).map(([title, stream]) => [title, stream])).toEqual([
			['Marathon', 'runs'],
			['Muay Thai fight', 'muay_thai'],
			['Build muscle', 'hypertrophy'],
			['Keep strength', 'strength']
		]);
		expect(c!.doses.every((d) => d.leader === null)).toBe(true);
	});
});

describe('doseBand', () => {
	const offSeason = inputOf(M7_SCENARIOS.offSeason());
	const strengthSplit = chooseSplit(offSeason, 2);
	const hypertrophySplit = chooseSplit(inputOf(M7_SCENARIOS.hypertrophyBlock()), 4);
	const maintenanceSplit = chooseSplit(inputOf(M7_SCENARIOS.allPaused()), 2);

	it("gives maintenance the maintenance split's band, read live", () => {
		expect(maintenanceSplit.maintenance).toBe(true);
		const band = hardSetBand(maintenanceSplit, null).sets;
		expect(band).toEqual([4, 10]);
		expect(band).toEqual(HARD_SET_RANGES.maintenance.sets);
		for (const split of [strengthSplit, hypertrophySplit, maintenanceSplit]) {
			expect(doseBand(split, null, 'maintenance')).toEqual(band);
		}
	});

	it('gives a secondary goal the lower half of its own style’s band', () => {
		expect(doseBand(strengthSplit, null, 'secondary')).toEqual([8, 11]);
		expect(doseBand(hypertrophySplit, null, 'secondary')).toEqual([10, 15]);
		// Its own style even where M3 chose maintenance: multiGoal's split is for hypertrophy.
		const held = chooseSplit(inputOf(M7_SCENARIOS.multiGoal()), 2);
		expect(held.maintenance).toBe(true);
		expect(doseBand(held, null, 'secondary')).toEqual([10, 15]);
		// Derived from HARD_SET_RANGES: [lo, lo + half the width].
		const [lo, hi] = HARD_SET_RANGES.strength.sets;
		expect(doseBand(strengthSplit, 'cut', 'secondary')).toEqual([lo, lo + (hi - lo) / 2]);
	});

	it('leaves a primary goal’s band as hardSetBand gives it', () => {
		for (const split of [strengthSplit, hypertrophySplit, maintenanceSplit]) {
			for (const phase of [null, 'cut', 'bulk'] as const) {
				expect(doseBand(split, phase, 'primary')).toEqual(hardSetBand(split, phase).sets);
			}
		}
		expect(doseBand(hypertrophySplit, null, 'primary')).toEqual([10, 20]);
	});
});
