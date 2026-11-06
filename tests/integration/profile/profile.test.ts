/**
 * The athlete profile, body weight history, onboarding progress and the full training profile
 * read model, through the services on real Postgres.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ONBOARDING_STEPS, STEP_INFO } from '../../../src/lib/domain/profile/onboarding';
import {
	advanceOnboarding,
	completeOnboarding,
	createGoal,
	getAthleteProfile,
	getBody,
	getOnboarding,
	getProfileOverview,
	getTrainingProfile,
	rememberOnboardingStep,
	saveBaselines,
	saveBasics,
	saveBody,
	saveEquipment,
	saveExercisePreferences,
	saveExperience,
	saveInjuries,
	saveSchedule,
	saveSpecifics
} from '../../../src/lib/server/services/profile';
import { withRollback } from '../helpers';
import { clock, eventGoal, fieldErrors, generalGoal, makeOwner } from './fixtures';

describe('athlete profile', () => {
	it('starts from the owner’s name with kg/km, then saves name and units', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db, 'Niko Cruz');
			expect(await getAthleteProfile(owner, { db })).toMatchObject({
				name: 'Niko Cruz',
				weightUnit: 'kg',
				distanceUnit: 'km',
				baselinesUnknown: false,
				onboarding: { current: null, completed: [], skipped: [], completedAt: null }
			});
			const saved = await saveBasics(
				owner,
				{ name: '  Niko ', weightUnit: 'lb', distanceUnit: 'mi' },
				{ db }
			);
			expect(saved).toMatchObject({ name: 'Niko', weightUnit: 'lb', distanceUnit: 'mi' });
			expect(
				await fieldErrors(
					saveBasics(owner, { name: '', weightUnit: 'stone', distanceUnit: 'km' }, { db })
				)
			).toEqual({ name: 'Tell your coach what to call you', weightUnit: 'Pick kg or lb' });
		});
	});

	it('records body weight as dated history with the nutrition phase and target', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-01T08:00:00Z');
			const owner = await makeOwner(db);
			const first = await saveBody(
				owner,
				{
					birthYear: 1994,
					weightUnit: 'kg',
					bodyWeight: 74.6,
					nutritionPhase: 'cut',
					targetWeight: 71,
					targetDate: '2027-03-13'
				},
				{ db, now: time.now, source: 'onboarding' }
			);
			expect(first.profile).toMatchObject({
				birthYear: 1994,
				nutritionPhase: 'cut',
				targetWeight: 71,
				targetDate: '2027-03-13'
			});
			expect(first.bodyWeight).toEqual([
				{
					id: expect.any(Number),
					value: 74.6,
					unit: 'kg',
					measuredOn: '2026-11-01',
					source: 'onboarding'
				}
			]);

			// Same day again replaces that day's entry; a later day adds to the history.
			await saveBody(
				owner,
				{ ...first.profile, weightUnit: 'kg', bodyWeight: 74.4 },
				{ db, now: time.now, source: 'onboarding' }
			);
			time.advanceDays(7);
			const later = await saveBody(
				owner,
				{ weightUnit: 'kg', bodyWeight: 73.9, nutritionPhase: 'cut', targetWeight: 71 },
				{ db, now: time.now }
			);
			expect(later.bodyWeight.map((w) => [w.measuredOn, w.value])).toEqual([
				['2026-11-08', 73.9],
				['2026-11-01', 74.4]
			]);
			// Leaving the weight blank never deletes history.
			await saveBody(
				owner,
				{ weightUnit: 'kg', bodyWeight: null, nutritionPhase: null },
				{ db, now: time.now }
			);
			expect((await getBody(owner, { db })).bodyWeight).toHaveLength(2);
		});
	});

	it('dates body weight by the owner’s local day, not the UTC one', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveBasics(
				owner,
				{ name: 'Niko', weightUnit: 'kg', distanceUnit: 'km', timeZone: 'America/Los_Angeles' },
				{ db }
			);
			const at = (instant: string) => ({ db, now: () => new Date(instant) });
			const body = { weightUnit: 'kg', nutritionPhase: null };
			// 15:30 and 18:30 on 5 November in Los Angeles: two UTC days, one local day.
			await saveBody(owner, { ...body, bodyWeight: 74.6 }, at('2026-11-05T23:30:00Z'));
			const evening = await saveBody(
				owner,
				{ ...body, bodyWeight: 74.2 },
				at('2026-11-06T02:30:00Z')
			);
			expect(evening.bodyWeight.map((w) => [w.measuredOn, w.value])).toEqual([
				['2026-11-05', 74.2]
			]);
			// Local midnight starts the next day.
			const morning = await saveBody(
				owner,
				{ ...body, bodyWeight: 74 },
				at('2026-11-06T08:30:00Z')
			);
			expect(morning.bodyWeight.map((w) => [w.measuredOn, w.value])).toEqual([
				['2026-11-06', 74],
				['2026-11-05', 74.2]
			]);
		});
	});

	it('saves the owner’s time zone and keeps it when a save leaves it out', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const basics = { name: 'Niko', weightUnit: 'kg', distanceUnit: 'km' };
			expect((await getAthleteProfile(owner, { db })).timeZone).toBe('UTC');
			const saved = await saveBasics(owner, { ...basics, timeZone: 'america/los_angeles' }, { db });
			expect(saved.timeZone).toBe('America/Los_Angeles');
			expect((await saveBasics(owner, basics, { db })).timeZone).toBe('America/Los_Angeles');
			for (const timeZone of ['Mars/Olympus', '+05:30', '', null]) {
				expect(await fieldErrors(saveBasics(owner, { ...basics, timeZone }, { db }))).toEqual({
					timeZone: 'Pick your time zone'
				});
			}
			expect((await getAthleteProfile(owner, { db })).timeZone).toBe('America/Los_Angeles');
		});
	});

	it('stores a blank target date (an empty date input) as no date', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const body = { weightUnit: 'kg', nutritionPhase: 'cut', targetWeight: 71 };
			await saveBody(owner, { ...body, targetDate: '2027-03-13' }, { db });
			const cleared = await saveBody(owner, { ...body, targetDate: '' }, { db });
			expect(cleared.profile.targetDate).toBeNull();
			const stored = await db.execute<{ target_date: string | null }>(
				sql`select target_date from athlete_profiles where owner_id = ${owner}`
			);
			expect(stored.rows).toEqual([{ target_date: null }]);
		});
	});

	it('refuses implausible body data', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const year = new Date().getFullYear();
			expect(
				await fieldErrors(
					saveBody(
						owner,
						{
							birthYear: year,
							weightUnit: 'lb',
							bodyWeight: 20,
							nutritionPhase: 'feast',
							targetDate: '2027-02-30'
						},
						{ db }
					)
				)
			).toMatchObject({
				birthYear: `A year between ${year - 100} and ${year - 10}`,
				bodyWeight: 'Between 55 and 770 lb',
				nutritionPhase: 'Pick a phase',
				targetDate: 'Use a real date'
			});
		});
	});
});

describe('onboarding progress', () => {
	it('adds the running/Muay Thai step only when those disciplines are in play', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const before = await getOnboarding(owner, { db });
			expect(before).toMatchObject({ resume: 'welcome', complete: false, fraction: 0 });
			expect(before.steps).not.toContain('specifics');

			await createGoal(owner, generalGoal(), { db });
			expect((await getOnboarding(owner, { db })).steps).not.toContain('specifics');
			await createGoal(owner, eventGoal(), { db });
			expect((await getOnboarding(owner, { db })).steps).toEqual([
				'welcome',
				'goals',
				'experience',
				'strength',
				'specifics',
				'equipment',
				'injuries',
				'exercises',
				'schedule',
				'body',
				'review'
			]);
		});
	});

	it('remembers where to resume, completed and skipped steps', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(await advanceOnboarding(owner, { step: 'welcome', action: 'complete' }, { db })).toBe(
				'goals'
			);
			await createGoal(owner, generalGoal(), { db });
			expect(await advanceOnboarding(owner, { step: 'goals', action: 'complete' }, { db })).toBe(
				'experience'
			);
			expect(
				await advanceOnboarding(owner, { step: 'experience', action: 'complete' }, { db })
			).toBe('strength');
			// No running or Muay Thai: strength → equipment.
			expect(await advanceOnboarding(owner, { step: 'strength', action: 'skip' }, { db })).toBe(
				'equipment'
			);
			const state = await getOnboarding(owner, { db });
			expect(state.progress).toMatchObject({
				current: 'equipment',
				completed: ['welcome', 'goals', 'experience'],
				skipped: ['strength']
			});
			expect(state.resume).toBe('equipment');
			expect(state.fraction).toBeCloseTo(4 / 9);

			await rememberOnboardingStep(owner, 'goals', { db });
			expect((await getOnboarding(owner, { db })).resume).toBe('goals');
		});
	});

	it('refuses unknown steps and actions, and skipping a step that is not optional', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			// Form posts and coach tool calls arrive untyped.
			const advance = (step: string, action: string) =>
				advanceOnboarding(owner, { step, action } as never, { db });
			expect(await fieldErrors(advance('goals', 'finish'))).toEqual({ action: 'Unknown action' });
			for (const step of ONBOARDING_STEPS.filter((s) => !STEP_INFO[s].optional)) {
				expect(await fieldErrors(advance(step, 'skip'))).toEqual({
					step: 'This step can’t be skipped'
				});
			}
			expect(
				await fieldErrors(rememberOnboardingStep(owner, 'not-a-step' as never, { db }))
			).toEqual({ step: 'Unknown step' });
			expect((await getOnboarding(owner, { db })).progress).toMatchObject({
				current: null,
				completed: [],
				skipped: []
			});

			expect(await advance('strength', 'skip')).toBe('equipment');
			expect((await getOnboarding(owner, { db })).progress.skipped).toEqual(['strength']);
		});
	});

	it('completes only with a goal and a schedule — every 1RM may stay blank', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(await fieldErrors(completeOnboarding(owner, { db }))).toEqual({
				goals: 'Add at least one goal',
				schedule: 'Tell your coach how many days you can train'
			});
			await createGoal(owner, generalGoal(), { db });
			await saveSchedule(
				owner,
				{ daysPerWeek: 4, availableDays: [], preferredTimes: [], commitments: [] },
				{ db }
			);
			await saveBaselines(owner, { unknown: true, lifts: [] }, { db });
			const at = await completeOnboarding(owner, { db });
			expect(at).toBeInstanceOf(Date);
			const overview = await getProfileOverview(owner, { db });
			expect(overview.onboarding).toMatchObject({ complete: true, fraction: 1 });
			expect(overview.goals.map((g) => g.title)).toEqual(['Keep my strength']);
			expect(overview.schedule.daysPerWeek).toBe(4);
		});
	});
});

describe('the full training profile', () => {
	it('returns every section the services saved', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveBasics(owner, { name: 'Niko', weightUnit: 'kg', distanceUnit: 'km' }, { db });
			await createGoal(owner, eventGoal(), { db });
			await createGoal(owner, generalGoal(), { db });
			await saveExperience(
				owner,
				{ entries: [{ discipline: 'muay_thai', level: 'novice' }] },
				{ db }
			);
			await saveBaselines(owner, { unknown: true, lifts: [] }, { db });
			await saveSpecifics(owner, { running: null, muayThai: { sessionsPerWeek: 3 } }, { db });
			await saveEquipment(
				owner,
				{ gymType: 'home', equipment: ['barbell'], homeEquipment: [] },
				{ db }
			);
			await saveInjuries(
				owner,
				{
					injuries: [
						{ bodyArea: 'wrist_hand', side: 'right', severity: 'mild', avoid: [], active: true }
					]
				},
				{ db }
			);
			await saveExercisePreferences(
				owner,
				{ items: [{ exercise: 'Burpees', sentiment: 'dislike' }] },
				{ db }
			);
			await saveSchedule(
				owner,
				{
					daysPerWeek: 4,
					availableDays: ['mon', 'tue', 'thu', 'sat'],
					preferredTimes: ['morning'],
					commitments: []
				},
				{ db }
			);
			await saveBody(
				owner,
				{ weightUnit: 'kg', bodyWeight: 75, nutritionPhase: 'maintenance' },
				{ db }
			);

			const profile = await getTrainingProfile(owner, { db });
			expect(profile.profile).toMatchObject({
				name: 'Niko',
				baselinesUnknown: true,
				nutritionPhase: 'maintenance'
			});
			expect(profile.goals.map((g) => g.priority)).toEqual([1, 2]);
			expect(profile.experience).toHaveLength(1);
			expect(profile.baselines).toEqual([]);
			expect(profile.running).toBeNull();
			expect(profile.muayThai).toMatchObject({ sessionsPerWeek: 3 });
			expect(profile.equipment).toMatchObject({ gymType: 'home' });
			expect(profile.injuries).toHaveLength(1);
			expect(profile.exercises).toHaveLength(1);
			expect(profile.schedule.availableDays).toHaveLength(4);
			expect(profile.bodyWeight[0]).toMatchObject({ value: 75 });

			const tables = await db.execute<{ n: number }>(
				sql`select count(*)::int as n from athlete_profiles where owner_id = ${owner}`
			);
			expect(tables.rows[0]).toEqual({ n: 1 });
		});
	});
});
