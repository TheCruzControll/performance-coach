/**
 * Muscle-group targets (src/lib/server/services/analytics/targets.ts) on the M6 dataset: each
 * week's range comes from the input that generated its block, scaled by its volume factor, beside
 * the week's planned hard sets; today's profile never rewrites a past week.
 */
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import {
	exerciseRefKey,
	plannedHardSets,
	type ExerciseMuscles
} from '../../../src/lib/domain/training/metrics';
import type { WeekPlan } from '../../../src/lib/domain/training/types';
import {
	defaultLabel,
	getMuscleTargets,
	NO_STORED_TARGET,
	STORED_TARGET,
	type WeekTarget
} from '../../../src/lib/server/services/analytics/targets';
import { listGoals, saveBody, updateGoal } from '../../../src/lib/server/services/profile/index';
import {
	createProgramFromPlan,
	getProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { LAST_DAY, seedDataset, WEEK_ONE, weekOf } from './fixtures/dataset';

const MUSCLES = new Map<string, ExerciseMuscles>(
	CATALOGUE.map((e) => [exerciseRefKey({ key: e.key }), e])
);

const byWeek = (weeks: WeekTarget[]) => new Map(weeks.map((w) => [w.weekStart, w]));

describe('muscle-group targets', () => {
	it("judge each week by its block's stored input, scaled by the week's volume factor", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const weeks = byWeek(
				await getMuscleTargets(data.owner, { from: WEEK_ONE, to: LAST_DAY }, { db })
			);
			expect(weeks.size).toBe(16);

			// Program A was built on a cut: four fifths of 10–20.
			for (const n of [1, 2, 3, 4, 5, 6]) {
				expect(weeks.get(weekOf(n))).toMatchObject({
					source: 'block',
					label: STORED_TARGET,
					programId: data.programs.a,
					volumeFactor: 1,
					band: 'the 8–16 that suits building muscle on a cut'
				});
				expect(weeks.get(weekOf(n))!.targets.chest).toEqual([8, 16]);
			}
			// Program B, no phase: 10–20 at full volume, 6–12 in B1's 0.6 deload.
			for (const n of [7, 8, 9, 10, 12, 16]) {
				expect(weeks.get(weekOf(n))!.programId).toBe(data.programs.b);
				expect(weeks.get(weekOf(n))!.targets.chest).toEqual([10, 20]);
			}
			const deload = weeks.get(weekOf(11))!;
			expect(deload).toMatchObject({ volumeFactor: 0.6, source: 'block' });
			expect(deload.targets).toMatchObject({ chest: [6, 12], quads: [6, 12], back: [6, 12] });
			// Major groups only: the curls' biceps sets are planned, with no target.
			expect(deload.planned!.groups.biceps).toBeGreaterThan(0);
			expect(deload.targets.biceps).toBeUndefined();
			expect(Object.keys(deload.targets).sort()).toEqual([
				'back',
				'chest',
				'hamstrings',
				'hips',
				'quads',
				'shoulders'
			]);
		});
	});

	it("draw the planned line as plannedHardSets of the current version's week", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const weeks = byWeek(
				await getMuscleTargets(data.owner, { from: WEEK_ONE, to: LAST_DAY }, { db })
			);
			const a = await getProgramVersion(data.owner, data.programs.a, 2, { db });
			const b = await getProgramVersion(data.owner, data.programs.b, 2, { db });
			for (const week of [...a.blocks, ...b.blocks].flatMap((block) => block.weeks)) {
				if (week.startsOn > LAST_DAY) continue;
				const expected = plannedHardSets(week as unknown as WeekPlan, MUSCLES);
				expect(weeks.get(week.startsOn)!.planned).toEqual(expected);
			}
			// Version 2's week 3 benches 4 working sets; the weeks around it 3.
			expect(weeks.get(weekOf(2))!.planned!.groups.chest).toBe(3);
			expect(weeks.get(weekOf(3))!.planned!.groups.chest).toBe(4);
		});
	});

	it("keep past weeks' targets when today's goal turns to strength and the phase to bulk", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const range = { from: addDays(WEEK_ONE, -7), to: LAST_DAY };
			const before = await getMuscleTargets(data.owner, range, { db });
			expect(before[0]).toMatchObject({
				source: 'default',
				label: defaultLabel('hypertrophy'),
				programId: null,
				planned: null,
				volumeFactor: 1
			});
			expect(before[0]!.targets.chest).toEqual([10, 20]);

			const [goal] = await listGoals(data.owner, { db });
			await updateGoal(
				data.owner,
				goal!.id,
				{
					kind: 'general',
					title: 'Get stronger',
					disciplines: ['strength'],
					focus: 'Squat, bench and deadlift',
					measure: 'Top sets week on week'
				},
				{ db }
			);
			await saveBody(
				data.owner,
				{ weightUnit: 'kg', bodyWeight: 84, nutritionPhase: 'bulk' },
				{ db }
			);

			const after = await getMuscleTargets(data.owner, range, { db });
			// The week no program plans follows today's profile; every program week stays.
			expect(after[0]).toMatchObject({ label: defaultLabel('strength') });
			expect(after[0]!.targets.chest).toEqual([8, 14]);
			expect(after.slice(1)).toEqual(before.slice(1));
		});
	});

	it("read an edit version's block from its generated ancestor's input", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const v2 = await getProgramVersion(data.owner, data.programs.b, 2, { db });
			expect(v2.version).toMatchObject({ current: true, generator: null, inputSnapshot: null });
			const weeks = await getMuscleTargets(data.owner, { from: weekOf(12), to: LAST_DAY }, { db });
			expect(weeks).toHaveLength(5);
			for (const week of weeks) {
				expect(week).toMatchObject({ source: 'block', programId: data.programs.b });
				expect(week.targets.hamstrings).toEqual([10, 20]);
			}
		});
	});

	it('show only the planned line for a program no generator built', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const monday = '2026-11-02';
			const plan = programFixture('hybrid', { monday, today: monday });
			const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const weeks = await getMuscleTargets(owner, { from: monday, to: addDays(monday, 6) }, { db });
			expect(weeks).toEqual([
				{
					...{ weekStart: monday, source: 'none', label: NO_STORED_TARGET, programId },
					...{ volumeFactor: 1, targets: {}, band: null },
					blockLineage: expect.any(String),
					planned: expect.objectContaining({ weekStart: monday })
				}
			]);
			expect(Object.keys(weeks[0]!.planned!.groups).length).toBeGreaterThan(0);
		});
	});
});
