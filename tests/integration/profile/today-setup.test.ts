/**
 * Today's setup card (src/routes/(app)/today/setup.server.ts) on real Postgres: until onboarding
 * is complete it says how many of the steps that apply are finished and where Continue resumes;
 * once it is complete there is no card. When the database cannot be reached it fails soft: null,
 * and the failure recorded as a server error.
 */
import { describe, expect, it } from 'vitest';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import {
	advanceOnboarding,
	completeOnboarding,
	createGoal,
	deleteGoal,
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

	it('is gone once onboarding is complete', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await createGoal(owner, generalGoal(), { db });
			const schedule = { daysPerWeek: 4, availableDays: [], preferredTimes: [], commitments: [] };
			await saveSchedule(owner, schedule, { db });
			await completeOnboarding(owner, { db });
			expect(await loadTodaySetup(owner, origin(), { db })).toEqual({ complete: true });
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
