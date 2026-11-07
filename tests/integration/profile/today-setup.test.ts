/**
 * Today's setup card (src/routes/(app)/today/setup.server.ts) on real Postgres: until onboarding
 * is complete it says how many of the steps that apply are finished and where Continue resumes;
 * once it is complete there is no card, and the open goals by rank and the week's shape take its
 * place. When the database cannot be reached it fails soft: null,
 * and the failure recorded as a server error.
 */
import { describe, expect, it } from 'vitest';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import {
	advanceOnboarding,
	completeOnboarding,
	createGoal,
	deleteGoal,
	getSchedule,
	reorderGoals,
	saveSchedule
} from '../../../src/lib/server/services/profile/index';
import { loadTodaySetup } from '../../../src/routes/(app)/today/setup.server';
import { unreachableDb, withRollback } from '../helpers';
import { eventGoal, generalGoal, makeOwner } from '../profile/fixtures';

const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/today',
	routeId: '/(app)/today',
	appVersion: '0.1.0+test'
});

describe('Today’s setup card', () => {
	it('starts at the welcome with nothing done, out of the steps an empty profile has', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			// No goal yet: no running or Muay Thai, so no specifics step (10 of the 11).
			expect(await loadTodaySetup(owner, origin(), { db })).toEqual({
				complete: false,
				done: 0,
				total: 10,
				next: 'welcome'
			});
		});
	});

	it('counts finished steps, skipped ones too, and resumes at the furthest step advanced', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await advanceOnboarding(owner, { step: 'welcome', action: 'complete' }, { db });
			// A fight brings the specifics step: one more step applies.
			await createGoal(owner, eventGoal(), { db });
			await advanceOnboarding(owner, { step: 'goals', action: 'complete' }, { db });
			expect(await loadTodaySetup(owner, origin(), { db })).toEqual({
				complete: false,
				done: 2,
				total: 11,
				next: 'experience'
			});
			await advanceOnboarding(owner, { step: 'experience', action: 'complete' }, { db });
			await advanceOnboarding(owner, { step: 'strength', action: 'skip' }, { db });
			expect(await loadTodaySetup(owner, origin(), { db })).toEqual({
				complete: false,
				done: 4,
				total: 11,
				next: 'specifics'
			});
		});
	});

	it('leaves out a finished step that no longer applies', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const fight = await createGoal(owner, eventGoal(), { db });
			await advanceOnboarding(owner, { step: 'specifics', action: 'skip' }, { db });
			const withFight = await loadTodaySetup(owner, origin(), { db });
			expect(withFight).toMatchObject({ done: 1, total: 11 });
			// The fight goes (deleted, so no discipline is left): specifics no longer applies, and
			// neither the count nor the total keep it.
			await deleteGoal(owner, fight.id, { db });
			expect(await loadTodaySetup(owner, origin(), { db })).toEqual({
				complete: false,
				done: 0,
				total: 10,
				next: 'equipment'
			});
		});
	});

	it('is gone once onboarding is complete: the summary takes its place', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const goal = await createGoal(owner, generalGoal(), { db });
			const schedule = { daysPerWeek: 4, availableDays: [], preferredTimes: [], commitments: [] };
			await saveSchedule(owner, schedule, { db });
			await completeOnboarding(owner, { db });
			expect(await loadTodaySetup(owner, origin(), { db })).toEqual({
				complete: true,
				goals: [
					{
						id: goal.id,
						title: 'Keep my strength',
						date: null,
						paused: false,
						disciplines: [{ name: 'Strength', tone: 'strength' }]
					}
				],
				week: {
					summary: '4 days a week',
					available: null,
					commitments: [],
					days: Array.from({ length: 7 }, () => ({ available: false, booked: [] }))
				}
			});
		});
	});

	it('summarises the open goals by rank and the shape of the week', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const fight = await createGoal(owner, eventGoal(), { db });
			const climb = await createGoal(
				owner,
				generalGoal({
					title: 'Climb V5',
					disciplines: ['custom', 'strength'],
					customDiscipline: 'Bouldering',
					targetDate: '2027-06-30',
					// Paused goals keep their rank, and Today marks them.
					status: 'paused'
				}),
				{ db }
			);
			const marathon = await createGoal(
				owner,
				eventGoal({
					title: 'Valencia marathon',
					disciplines: ['distance_running'],
					eventType: 'Marathon',
					eventDate: '2027-12-05',
					weightClass: null
				}),
				{ db }
			);
			// Achieved goals hold no rank, so Today leaves them out.
			await createGoal(owner, generalGoal({ title: 'Old squat goal', status: 'achieved' }), { db });
			await reorderGoals(owner, { ids: [marathon.id, fight.id, climb.id] }, { db });
			await saveSchedule(
				owner,
				{
					daysPerWeek: 4,
					availableDays: ['sat', 'mon', 'tue', 'thu'],
					preferredTimes: ['evening'],
					sessionMinutes: 60,
					commitments: [
						{
							discipline: 'muay_thai',
							label: 'Muay Thai class',
							days: ['thu', 'tue'],
							timeOfDay: 'evening',
							durationMinutes: 90,
							intensity: 'hard'
						}
					]
				},
				{ db }
			);
			await completeOnboarding(owner, { db });

			const setup = await loadTodaySetup(owner, origin(), { db });
			if (!setup?.complete) throw new Error('expected the summary');
			expect(setup.goals).toEqual([
				{
					id: marathon.id,
					title: 'Valencia marathon',
					date: '2027-12-05',
					paused: false,
					disciplines: [{ name: 'Half / marathon', tone: 'running' }]
				},
				{
					id: fight.id,
					title: 'First Muay Thai fight',
					date: '2027-03-14',
					paused: false,
					disciplines: [{ name: 'Muay Thai', tone: 'combat' }]
				},
				{
					id: climb.id,
					title: 'Climb V5',
					date: '2027-06-30',
					paused: true,
					disciplines: [
						{ name: 'Bouldering', tone: 'conditioning' },
						{ name: 'Strength', tone: 'strength' }
					]
				}
			]);
			const [klass] = (await getSchedule(owner, { db })).commitments;
			const booked = [{ label: 'Muay Thai class', tone: 'combat' }];
			expect(setup.week).toEqual({
				summary: '4 days a week · 60 min sessions · evening',
				available: 'Mon, Tue, Thu, Sat',
				commitments: [
					{
						id: klass!.id,
						label: 'Muay Thai class',
						when: 'Tue, Thu · evening · 90 min · hard',
						tone: 'combat'
					}
				],
				days: [
					{ available: true, booked: [] },
					{ available: true, booked },
					{ available: false, booked: [] },
					{ available: true, booked },
					{ available: false, booked: [] },
					{ available: true, booked: [] },
					{ available: false, booked: [] }
				]
			});
		});
	});

	it('fails soft when the database cannot be reached, and records the failure', async () => {
		const broken = unreachableDb();
		try {
			await withRollback(async (tx) => {
				const request = origin();
				const setup = await loadTodaySetup(crypto.randomUUID(), request, {
					db: broken.db,
					errorsDb: tx
				});
				expect(setup).toBeNull();
				const recorded = await findErrorsByRequestId(request.requestId, { db: tx });
				expect(recorded).toHaveLength(1);
				expect(recorded[0]).toMatchObject({
					kind: 'load',
					status: 500,
					method: 'GET',
					path: '/today',
					routeId: '/(app)/today',
					appVersion: '0.1.0+test',
					context: expect.objectContaining({ load: 'todaySetup' })
				});
			});
		} finally {
			await broken.close();
		}
	});
});
