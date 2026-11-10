import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../../exercises/index';
import type { TrainingProfile } from '../../profile/types';
import { periodisedWeekTargetsSchema } from '../../training/schemas';
import { validate } from '../../validation';
import { planFirstBlock } from '../blocks';
import { DecisionLog } from '../decisions';
import { buildProgrammingInput } from '../input';
import { doseBand, maintenanceDoses } from '../priority/doses';
import { chooseSplit } from '../splits';
import { maintenanceWeeks } from './maintenance';
import { M7_SCENARIOS, m7Day } from './scenarios';

const inputOf = (profile: TrainingProfile) =>
	buildProgrammingInput(profile, { catalogue: CATALOGUE });
const START = m7Day(1, 0);

describe('the maintenance block', () => {
	it("holds offSeason's goals at their doses, every week a maintenance week that validates", () => {
		const input = inputOf(M7_SCENARIOS.offSeason());
		const doses = maintenanceDoses(input, START);
		const block = maintenanceWeeks(doses, { weeks: 6, level: 'intermediate' });

		expect(block.phase).toBe('maintenance');
		expect(block.goalRefs).toEqual(input.refs.goals);
		expect(doses.map((d) => [d.goal.title, d.stream, d.leader])).toEqual([
			['Keep strength', 'strength', null],
			['Keep running fitness', 'runs', null]
		]);
		expect(block.weeks).toHaveLength(6);
		const band = doseBand(chooseSplit(input, 2), null, 'maintenance');
		for (const week of block.weeks) {
			expect(week).toMatchObject({ kind: 'maintenance', phase: 'maintenance' });
			expect(week.targets).toEqual({
				rpeCap: 8,
				volumeFactor: 1,
				loadStep: 0,
				runVolumeFactor: 0.65,
				maintenance: ['strength', 'runs'],
				setsPerGroup: { min: band[0], max: band[1], step: 0 }
			});
			expect(validate(periodisedWeekTargetsSchema, week.targets)).toEqual({
				ok: true,
				data: week.targets
			});
		}
	});

	it('stays within 4–8 weeks and never schedules a deload', () => {
		const doses = maintenanceDoses(inputOf(M7_SCENARIOS.offSeason()), START);
		const lengths = [0, 1, 3, 4, 5, 8, 9, 20].map(
			(weeks) => maintenanceWeeks(doses, { weeks, level: 'new' }).weeks.length
		);
		expect(lengths).toEqual([4, 4, 4, 4, 5, 8, 8, 8]);
		for (const level of ['new', 'novice', 'intermediate', 'advanced'] as const) {
			const kinds = maintenanceWeeks(doses, { weeks: 8, level }).weeks.map((w) => w.kind);
			expect(new Set(kinds)).toEqual(new Set(['maintenance']));
		}
		expect(() => maintenanceWeeks(doses, { weeks: Number.NaN, level: 'new' })).toThrow(RangeError);
	});

	it('leaves the hard-set band off when no lifting goal is dosed', () => {
		const profile = M7_SCENARIOS.offSeason();
		profile.goals = profile.goals.filter((g) => g.title === 'Keep running fitness');
		const block = maintenanceWeeks(maintenanceDoses(inputOf(profile), START), {
			weeks: 4,
			level: 'novice'
		});
		expect(block.weeks[0]!.targets.maintenance).toEqual(['runs']);
		expect(block.weeks[0]!.targets).not.toHaveProperty('setsPerGroup');
	});

	it("matches M3's all-goals-paused block: phase maintenance, the paused goals' refs", () => {
		const input = inputOf(M7_SCENARIOS.allPaused());
		expect(input.maintenance).toBe(true);
		const [m3] = planFirstBlock(input, START, new DecisionLog());
		const block = maintenanceWeeks(maintenanceDoses(input, START), {
			weeks: 4,
			level: 'intermediate'
		});
		expect(block.phase).toBe(m3!.phase);
		expect(block.goalRefs).toEqual(m3!.goalRefs);
		expect(block.goalRefs).toEqual(input.refs.paused);
		expect(block.goalRefs).toHaveLength(2);
	});
});
