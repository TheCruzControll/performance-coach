/**
 * The owner's weight goal through the services on real Postgres: setting a goal (its start at the
 * trend, its generated milestones, the phase it suggests), a new goal ending the old one into the
 * history, editing milestones, clearing the goal, the profile target kept in step with the goal
 * both ways, the nutrition phase, and owner scoping.
 */
import { describe, expect, it } from 'vitest';
import { createProfileRepository, createWeightRepository } from '../../../src/lib/server/db';
import {
	getAthleteProfile,
	ProfileNotFoundError,
	saveBasics
} from '../../../src/lib/server/services/profile';
import {
	clearWeightGoal,
	editMilestones,
	getWeightToday,
	logWeight,
	setNutritionPhase,
	setWeightGoal,
	syncWeightTarget
} from '../../../src/lib/server/services/weight';
import { withRollback } from '../helpers';
import { clock, fieldErrors, makeOwner, makeSecondOwner } from '../profile/fixtures';

const kg = (value: number, measuredOn: string) => ({ value, unit: 'kg', measuredOn });

/** A goal from 82.4 kg on 10 November, by 31 January: its milestones fall on 17 November (82) and 25 December (80). */
const GOAL = { targetWeight: 78, targetOn: '2027-01-31' };

describe('setting the weight goal', () => {
	it('starts at the trend today, generates its milestones and suggests a cut for a loss', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-10T08:00:00Z');
			const owner = await makeOwner(db);
			await logWeight(owner, kg(82.4, '2026-11-10'), { db, now: time.now });

			const { goal, phasePrompt } = await setWeightGoal(owner, GOAL, { db, now: time.now });
			expect(goal).toMatchObject({
				status: 'active',
				unit: 'kg',
				startOn: '2026-11-10',
				startWeight: 82.4,
				targetWeight: 78,
				targetOn: '2027-01-31',
				source: 'log',
				endedAt: null,
				endedReason: null
			});
			expect(phasePrompt).toBe('cut');

			const milestones = await createWeightRepository(db).listMilestones(owner, goal.id);
			expect(milestones.map((m) => [m.onDate, m.weight, m.source])).toEqual([
				['2026-11-17', 82, 'generated'],
				['2026-12-25', 80, 'generated']
			]);
		});
	});

	it('takes the unit from the profile when the owner leaves it out, and the lb default step', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-10T08:00:00Z');
			const owner = await makeOwner(db);
			await saveBasics(owner, { name: 'Niko', weightUnit: 'lb', distanceUnit: 'mi' }, { db });
			await logWeight(
				owner,
				{ value: 180, unit: 'lb', measuredOn: '2026-11-10' },
				{ db, now: time.now }
			);

			const { goal, phasePrompt } = await setWeightGoal(
				owner,
				{ targetWeight: 170, targetOn: '2027-01-31' },
				{ db, now: time.now }
			);
			expect(goal).toMatchObject({ unit: 'lb', startWeight: 180, targetWeight: 170 });
			expect(phasePrompt).toBe('cut');
			// Steps of 5 lb: the one multiple between 170 and 180, 175, on 21 December.
			const milestones = await createWeightRepository(db).listMilestones(owner, goal.id);
			expect(milestones.map((m) => [m.onDate, m.weight])).toEqual([['2026-12-21', 175]]);
		});
	});

	it('ends the active goal as replaced, and the old goal stays in the history', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-10T08:00:00Z');
			const owner = await makeOwner(db);
			await logWeight(owner, kg(82.4, '2026-11-10'), { db, now: time.now });
			const first = await setWeightGoal(owner, GOAL, { db, now: time.now });

			time.advanceDays(10);
			await logWeight(owner, kg(80.6, '2026-11-20'), { db, now: time.now });
			const second = await setWeightGoal(
				owner,
				{ targetWeight: 76, targetOn: '2027-03-31' },
				{ db, now: time.now }
			);
			// The new goal starts at today's trend, not at the first goal's start.
			const today = await getWeightToday(owner, '2026-11-20', { db });
			expect(second.goal.startWeight).toBe(today.trend);

			const repo = createWeightRepository(db);
			expect((await repo.getActiveGoal(owner))?.id).toBe(second.goal.id);
			const history = await repo.listGoals(owner);
			expect(history.map((g) => [g.id, g.status, g.endedReason])).toEqual([
				[second.goal.id, 'active', null],
				[first.goal.id, 'ended', 'replaced']
			]);
			expect(history[1]!.endedAt).toEqual(time.now());
			// The old goal keeps its milestones as history.
			expect(await repo.listMilestones(owner, first.goal.id)).toHaveLength(2);
		});
	});

	it('refuses what the owner can fix, at the field, and writes nothing', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-10T08:00:00Z');
			const owner = await makeOwner(db);
			const at = { db, now: time.now };

			// No weigh-in yet: nothing to start the goal from.
			expect(await fieldErrors(setWeightGoal(owner, GOAL, at))).toEqual({
				targetWeight: 'Log your weight first, so the goal has a start'
			});
			await logWeight(owner, kg(82.4, '2026-11-10'), at);

			expect(
				await fieldErrors(setWeightGoal(owner, { ...GOAL, targetOn: '2026-11-10' }, at))
			).toEqual({ targetOn: 'Pick a day after today' });
			expect(await fieldErrors(setWeightGoal(owner, { ...GOAL, targetWeight: 10 }, at))).toEqual({
				targetWeight: 'Between 25 and 350 kg'
			});
			expect(await fieldErrors(setWeightGoal(owner, { ...GOAL, step: 0.05 }, at))).toEqual({
				step: 'At least 0.1 kg between milestones'
			});
			expect(
				await fieldErrors(setWeightGoal(owner, { ...GOAL, unit: 'lb', step: 0.15 }, at))
			).toEqual({ step: 'At least 0.2 lb between milestones' });
			// Steps of 0.1 kg across 4.4 kg give 43 milestones: more than the 24 a goal may hold.
			expect(await fieldErrors(setWeightGoal(owner, { ...GOAL, step: 0.1 }, at))).toEqual({
				step: 'More than 24 milestones at this step: pick a larger one'
			});

			expect(await createWeightRepository(db).getActiveGoal(owner)).toBeNull();
		});
	});

	it('refuses a goal from another owner’s weigh-ins', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-10T08:00:00Z');
			const owner = await makeOwner(db);
			const other = await makeSecondOwner(db);
			await logWeight(other, kg(90, '2026-11-10'), { db, now: time.now });
			expect(await fieldErrors(setWeightGoal(owner, GOAL, { db, now: time.now }))).toEqual({
				targetWeight: 'Log your weight first, so the goal has a start'
			});
		});
	});
});

describe('the milestones', () => {
	it('edits the active goal’s milestones: edited rows are marked, rows the generator gives stay generated', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-10T08:00:00Z');
			const owner = await makeOwner(db);
			await logWeight(owner, kg(82.4, '2026-11-10'), { db, now: time.now });
			const { goal } = await setWeightGoal(owner, GOAL, { db, now: time.now });

			const edited = await editMilestones(
				owner,
				goal.id,
				{
					milestones: [
						{ day: '2026-12-20', weight: 79.5 },
						{ day: '2026-11-17', weight: 82 }
					]
				},
				{ db, now: time.now }
			);
			expect(edited.map((m) => [m.onDate, m.weight, m.source])).toEqual([
				['2026-11-17', 82, 'generated'],
				['2026-12-20', 79.5, 'edited']
			]);

			// 80 on 25 December is what the generator gives there, so it is generated again.
			const again = await editMilestones(
				owner,
				goal.id,
				{ milestones: [{ day: '2026-12-25', weight: 80 }] },
				{ db, now: time.now }
			);
			expect(again.map((m) => [m.onDate, m.weight, m.source])).toEqual([
				['2026-12-25', 80, 'generated']
			]);

			// An empty list removes them all.
			expect(
				await editMilestones(owner, goal.id, { milestones: [] }, { db, now: time.now })
			).toEqual([]);
		});
	});

	it('refuses a milestone outside the goal, a repeated day, a weight out of range or with three decimals', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-10T08:00:00Z');
			const owner = await makeOwner(db);
			await logWeight(owner, kg(82.4, '2026-11-10'), { db, now: time.now });
			const { goal } = await setWeightGoal(owner, GOAL, { db, now: time.now });
			const at = { db, now: time.now };
			const edit = (milestones: unknown) =>
				fieldErrors(editMilestones(owner, goal.id, { milestones }, at));

			expect(await edit([{ day: '2027-02-01', weight: 79 }])).toEqual({
				'milestones.0.day': 'Pick a day between the start and the goal day'
			});
			expect(await edit([{ day: '2026-11-10', weight: 79 }])).toEqual({
				'milestones.0.day': 'Pick a day between the start and the goal day'
			});
			expect(
				await edit([
					{ day: '2026-12-01', weight: 81 },
					{ day: '2026-12-01', weight: 80.5 }
				])
			).toEqual({ 'milestones.1.day': 'That day already has a milestone' });
			expect(await edit([{ day: '2026-12-01', weight: 10 }])).toEqual({
				'milestones.0.weight': 'Between 25 and 350 kg'
			});
			expect(await edit([{ day: '2026-12-01', weight: 79.555 }])).toEqual({
				'milestones.0.weight': 'Use at most 2 decimals'
			});
			// Nothing was written: the generated milestones stand.
			const repo = createWeightRepository(db);
			expect((await repo.listMilestones(owner, goal.id)).map((m) => m.source)).toEqual([
				'generated',
				'generated'
			]);
		});
	});

	it('edits only the active goal', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-10T08:00:00Z');
			const owner = await makeOwner(db);
			await logWeight(owner, kg(82.4, '2026-11-10'), { db, now: time.now });
			const first = await setWeightGoal(owner, GOAL, { db, now: time.now });
			time.advanceDays(1);
			await setWeightGoal(
				owner,
				{ targetWeight: 76, targetOn: '2027-03-31' },
				{ db, now: time.now }
			);

			await expect(
				editMilestones(owner, first.goal.id, { milestones: [] }, { db, now: time.now })
			).rejects.toBeInstanceOf(ProfileNotFoundError);
		});
	});
});

describe('clearing the goal', () => {
	it('ends the goal as cleared, keeps it in the history and clears the profile target', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-10T08:00:00Z');
			const owner = await makeOwner(db);
			await logWeight(owner, kg(82.4, '2026-11-10'), { db, now: time.now });
			const { goal } = await setWeightGoal(owner, GOAL, { db, now: time.now });

			const ended = await clearWeightGoal(owner, { db, now: time.now });
			expect(ended).toMatchObject({ id: goal.id, status: 'ended', endedReason: 'cleared' });
			const repo = createWeightRepository(db);
			expect(await repo.getActiveGoal(owner)).toBeNull();
			expect((await repo.listGoals(owner)).map((g) => g.endedReason)).toEqual(['cleared']);
			const profile = await createProfileRepository(db).getProfile(owner);
			expect(profile).toMatchObject({
				targetWeight: null,
				targetWeightUnit: null,
				targetDate: null
			});

			// With no goal left, clearing again ends nothing and is not an error.
			expect(await clearWeightGoal(owner, { db, now: time.now })).toBeNull();
		});
	});
});

describe('the profile target, kept in step with the goal', () => {
	it('sets the goal from a dated target, keeps it when the target is the same, and writes an undated target to the profile only', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-10T08:00:00Z');
			const owner = await makeOwner(db);
			await logWeight(owner, kg(82.4, '2026-11-10'), { db, now: time.now });
			const at = { db, now: time.now };
			const repo = createWeightRepository(db);
			const profiles = createProfileRepository(db);

			await syncWeightTarget(owner, { weight: 78, unit: 'kg', date: '2027-01-31' }, at);
			const first = await repo.getActiveGoal(owner);
			expect(first).toMatchObject({ targetWeight: 78, targetOn: '2027-01-31', startWeight: 82.4 });

			// The same target: the goal stands, with no new goal and no new start.
			await syncWeightTarget(owner, { weight: 78, unit: 'kg', date: '2027-01-31' }, at);
			expect((await repo.getActiveGoal(owner))?.id).toBe(first!.id);
			expect(await repo.listGoals(owner)).toHaveLength(1);

			// An undated target stays on the profile; the goal is left as it was.
			await syncWeightTarget(owner, { weight: 77, unit: 'kg', date: null }, at);
			expect(await profiles.getProfile(owner)).toMatchObject({
				targetWeight: 77,
				targetDate: null
			});
			expect(await repo.getActiveGoal(owner)).toMatchObject({
				id: first!.id,
				targetWeight: 78,
				targetOn: '2027-01-31'
			});

			// The dated target again writes the profile back to match the goal.
			await syncWeightTarget(owner, { weight: 78, unit: 'kg', date: '2027-01-31' }, at);
			expect(await profiles.getProfile(owner)).toMatchObject({
				targetWeight: 78,
				targetWeightUnit: 'kg',
				targetDate: '2027-01-31'
			});
			expect((await repo.getActiveGoal(owner))?.id).toBe(first!.id);

			// A different dated target starts a new goal, and the old one is replaced.
			time.advanceDays(1);
			await syncWeightTarget(owner, { weight: 76, unit: 'kg', date: '2027-03-31' }, at);
			const second = await repo.getActiveGoal(owner);
			expect(second).toMatchObject({ targetWeight: 76, targetOn: '2027-03-31' });
			expect(second!.id).not.toBe(first!.id);
			expect((await repo.listGoals(owner)).map((g) => g.endedReason)).toEqual([null, 'replaced']);

			// A cleared target clears the goal and the profile.
			await syncWeightTarget(owner, null, at);
			expect(await repo.getActiveGoal(owner)).toBeNull();
			expect(await profiles.getProfile(owner)).toMatchObject({
				targetWeight: null,
				targetWeightUnit: null,
				targetDate: null
			});
		});
	});

	it('refuses a dated target with no weigh-in to start from, and leaves the profile as it was', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const at = { db, now: clock('2026-11-10T08:00:00Z').now };
			expect(
				await fieldErrors(
					syncWeightTarget(owner, { weight: 78, unit: 'kg', date: '2027-01-31' }, at)
				)
			).toEqual({ targetWeight: 'Log your weight first, so the goal has a start' });
			expect(await getAthleteProfile(owner, { db })).toMatchObject({ targetWeight: null });
		});
	});

	it('sets the profile target in the goal’s unit when the target is given in lb', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-10T08:00:00Z');
			const owner = await makeOwner(db);
			await saveBasics(owner, { name: 'Niko', weightUnit: 'lb', distanceUnit: 'mi' }, { db });
			await logWeight(
				owner,
				{ value: 180, unit: 'lb', measuredOn: '2026-11-10' },
				{ db, now: time.now }
			);
			await syncWeightTarget(
				owner,
				{ weight: 170, unit: 'lb', date: '2027-01-31' },
				{ db, now: time.now }
			);
			expect(await getAthleteProfile(owner, { db })).toMatchObject({
				targetWeight: 170,
				targetDate: '2027-01-31'
			});
			expect(await createWeightRepository(db).getActiveGoal(owner)).toMatchObject({
				unit: 'lb',
				targetWeight: 170
			});
		});
	});
});

describe('the phase prompt and the nutrition phase', () => {
	it('suggests bulk for a gain, nothing for a maintain goal, and nothing once the phase matches', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-10T08:00:00Z');
			const owner = await makeOwner(db);
			await logWeight(owner, kg(82.4, '2026-11-10'), { db, now: time.now });
			const at = { db, now: time.now };

			expect(
				(await setWeightGoal(owner, { targetWeight: 86, targetOn: '2027-01-31' }, at)).phasePrompt
			).toBe('bulk');
			expect(
				(await setWeightGoal(owner, { targetWeight: 82.4, targetOn: '2027-01-31' }, at)).phasePrompt
			).toBeNull();

			await setNutritionPhase(owner, 'bulk', at);
			expect(
				(await setWeightGoal(owner, { targetWeight: 86, targetOn: '2027-01-31' }, at)).phasePrompt
			).toBeNull();
		});
	});

	it('setting a goal leaves the phase alone, and setting the phase changes only the phase', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-10T08:00:00Z');
			const owner = await makeOwner(db);
			await logWeight(owner, kg(82.4, '2026-11-10'), { db, now: time.now });
			const at = { db, now: time.now };
			const { goal } = await setWeightGoal(owner, GOAL, at);
			expect((await getAthleteProfile(owner, { db })).nutritionPhase).toBeNull();

			const before = await getAthleteProfile(owner, { db });
			const profile = await setNutritionPhase(owner, 'cut', at);
			expect(profile).toMatchObject({
				nutritionPhase: 'cut',
				name: before.name,
				weightUnit: before.weightUnit,
				targetWeight: GOAL.targetWeight,
				targetDate: GOAL.targetOn
			});
			expect((await createWeightRepository(db).getActiveGoal(owner))?.id).toBe(goal.id);

			await setNutritionPhase(owner, null, at);
			expect((await getAthleteProfile(owner, { db })).nutritionPhase).toBeNull();
		});
	});

	it('refuses a phase it does not know, and changes nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const at = { db, now: clock().now };
			expect(await fieldErrors(setNutritionPhase(owner, 'feast', at))).toEqual({
				nutritionPhase: 'Pick a phase'
			});
			expect((await getAthleteProfile(owner, { db })).nutritionPhase).toBeNull();
		});
	});
});

describe('owner scoping', () => {
	it('keeps another owner’s goal out of reach of every write', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-10T08:00:00Z');
			const owner = await makeOwner(db);
			await logWeight(owner, kg(82.4, '2026-11-10'), { db, now: time.now });
			const { goal } = await setWeightGoal(owner, GOAL, { db, now: time.now });

			const other = await makeSecondOwner(db);
			const at = { db, now: time.now };
			await expect(editMilestones(other, goal.id, { milestones: [] }, at)).rejects.toBeInstanceOf(
				ProfileNotFoundError
			);
			expect(await clearWeightGoal(other, at)).toBeNull();
			await setNutritionPhase(other, 'cut', at);

			const repo = createWeightRepository(db);
			expect(await repo.getActiveGoal(owner)).toMatchObject({ id: goal.id, status: 'active' });
			expect((await getAthleteProfile(owner, { db })).nutritionPhase).toBeNull();
		});
	});
});
