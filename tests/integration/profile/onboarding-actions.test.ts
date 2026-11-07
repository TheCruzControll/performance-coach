/**
 * The onboarding steps' form actions (src/lib/server/forms/profile.ts: stepActions and
 * completeAction) on real Postgres, through the real services: Continue saves the step's section
 * as an onboarding change and moves on, Skip moves on only from an optional step, goals need
 * one open goal, Back and Finish later save without marking the step done, and Start coaching
 * needs a goal and a schedule.
 */
import { isActionFailure, isRedirect } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import type { OnboardingStep } from '../../../src/lib/domain/profile/onboarding';
import type { Executor } from '../../../src/lib/server/db';
import {
	completeAction,
	saveGoalAction,
	stepActions,
	type SaveSection
} from '../../../src/lib/server/forms/profile';
import {
	getEquipment,
	getOnboarding,
	getSpecifics,
	goalHistory,
	saveEquipment,
	saveSchedule,
	saveSpecifics
} from '../../../src/lib/server/services/profile';
import { withRollback } from '../helpers';
import { eventGoal, makeOwner } from './fixtures';

const href = (step: OnboardingStep) => `/onboarding/${step}`;
const equipment = { gymType: 'home', equipment: ['barbell'], homeEquipment: [] };

function session(ownerId: string): App.Locals {
	return {
		requestId: 'test',
		session: {
			id: crypto.randomUUID(),
			ownerId,
			ownerName: 'Niko',
			kind: 'owner',
			expiresAt: new Date(),
			reauthenticatedAt: null
		}
	};
}

function post(payload?: unknown, then?: 'back' | 'later'): Request {
	const body = new FormData();
	if (payload !== undefined) body.set('payload', JSON.stringify(payload));
	if (then) body.set('then', then);
	return new Request('http://localhost/onboarding/equipment?/save', { method: 'POST', body });
}

/** Where an action redirected to (fails the test if it returned instead). */
async function redirectedTo(promise: Promise<unknown>): Promise<string> {
	const err = await promise.then(
		(value) => {
			throw new Error(`expected a redirect, the action returned ${JSON.stringify(value)}`);
		},
		(e: unknown) => e
	);
	if (!isRedirect(err)) throw err;
	expect(err.status).toBe(303);
	return err.location;
}

/** A save running inside the test's transaction (the route passes only `source`). */
const within =
	(db: Executor, save: SaveSection): SaveSection =>
	(owner, payload, deps) =>
		save(owner, payload, { ...deps, db });

async function progress(owner: string, db: Executor) {
	const { progress } = await getOnboarding(owner, { db });
	return { current: progress.current, completed: progress.completed, skipped: progress.skipped };
}

describe('an onboarding step’s Continue', () => {
	it('saves the section, marks the step done and redirects to the next step', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { save } = stepActions('equipment', within(db, saveEquipment), href, { db });
			const to = await redirectedTo(save({ locals: session(owner), request: post(equipment) }));
			expect(to).toBe('/onboarding/injuries');
			expect(await getEquipment(owner, { db })).toMatchObject(equipment);
			expect(await progress(owner, db)).toEqual({
				current: 'injuries',
				completed: ['equipment'],
				skipped: []
			});
		});
	});

	it('returns the section’s field errors and neither saves nor moves on', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { save } = stepActions('equipment', within(db, saveEquipment), href, { db });
			const result = await save({
				locals: session(owner),
				request: post({ ...equipment, gymType: 'castle' })
			});
			expect(isActionFailure(result)).toBe(true);
			expect(result).toMatchObject({
				status: 400,
				data: { errors: { gymType: expect.any(String) } }
			});
			expect(await getEquipment(owner, { db })).toBeNull();
			expect(await progress(owner, db)).toEqual({ current: null, completed: [], skipped: [] });
		});
	});

	it('on goals, asks for a goal until one is open, then moves on', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { save } = stepActions('goals', undefined, href, { db });
			const result = await save({ locals: session(owner), request: post() });
			expect(result).toMatchObject({
				status: 400,
				data: { errors: { goals: 'Add at least one goal to continue.' } }
			});
			expect(await progress(owner, db)).toEqual({ current: null, completed: [], skipped: [] });

			await saveGoalAction(
				{ locals: session(owner), request: post(eventGoal()) },
				{ db, source: 'onboarding' }
			);
			const to = await redirectedTo(save({ locals: session(owner), request: post() }));
			// A Muay Thai goal brings the specifics step after strength; experience comes first.
			expect(to).toBe('/onboarding/experience');
			const history = await goalHistory(owner, { db });
			expect(history.map((e) => [e.change, e.source])).toEqual([['created', 'onboarding']]);
		});
	});
});

describe('an onboarding step’s Skip', () => {
	it('marks an optional step skipped and moves on without saving', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { skip } = stepActions('equipment', within(db, saveEquipment), href, { db });
			const to = await redirectedTo(skip({ locals: session(owner), request: post(equipment) }));
			expect(to).toBe('/onboarding/injuries');
			expect(await getEquipment(owner, { db })).toBeNull();
			expect(await progress(owner, db)).toEqual({
				current: 'injuries',
				completed: [],
				skipped: ['equipment']
			});
		});
	});

	it('is refused on a required step, and changes nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			for (const step of ['welcome', 'goals', 'experience', 'schedule', 'review'] as const) {
				const result = await stepActions(step, undefined, href, { db }).skip({
					locals: session(owner),
					request: post()
				});
				expect(result, step).toMatchObject({
					status: 400,
					data: { errors: { step: 'This step can’t be skipped' } }
				});
			}
			expect(await progress(owner, db)).toEqual({ current: null, completed: [], skipped: [] });
		});
	});
});

describe('leaving a step: Back and Finish later', () => {
	it('Back saves the section without marking the step done, and goes to the step before', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { save } = stepActions('equipment', within(db, saveEquipment), href, { db });
			const to = await redirectedTo(
				save({ locals: session(owner), request: post(equipment, 'back') })
			);
			// No running or Muay Thai: no specifics step, so strength comes before equipment.
			expect(to).toBe('/onboarding/strength');
			expect(await getEquipment(owner, { db })).toMatchObject(equipment);
			expect(await progress(owner, db)).toEqual({ current: null, completed: [], skipped: [] });
		});
	});

	it('Back from a step that no longer applies goes to the one before it in the full order', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			// The specifics step, open in a tab, after the last running or Muay Thai goal went.
			expect((await getOnboarding(owner, { db })).steps).not.toContain('specifics');
			const { save } = stepActions('specifics', within(db, saveSpecifics), href, { db });
			const specifics = { running: null, muayThai: { sessionsPerWeek: 3 } };
			const to = await redirectedTo(
				save({ locals: session(owner), request: post(specifics, 'back') })
			);
			expect(to).toBe('/onboarding/strength');
			expect((await getSpecifics(owner, { db })).muayThai).toMatchObject({ sessionsPerWeek: 3 });
			expect(await progress(owner, db)).toEqual({ current: null, completed: [], skipped: [] });
		});
	});

	it('Back from goals goes back without asking for a goal', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { save } = stepActions('goals', undefined, href, { db });
			const to = await redirectedTo(save({ locals: session(owner), request: post({}, 'back') }));
			expect(to).toBe('/onboarding/welcome');
			expect(await progress(owner, db)).toEqual({ current: null, completed: [], skipped: [] });
		});
	});

	it('Back with a section that does not validate saves nothing and stays', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { save } = stepActions('equipment', within(db, saveEquipment), href, { db });
			const result = await save({
				locals: session(owner),
				request: post({ ...equipment, gymType: 'castle' }, 'back')
			});
			expect(result).toMatchObject({
				status: 400,
				data: { errors: { gymType: expect.any(String) } }
			});
			expect(await getEquipment(owner, { db })).toBeNull();
		});
	});

	it('Finish later saves the section without marking the step done, and does not redirect', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { save } = stepActions('equipment', within(db, saveEquipment), href, { db });
			const result = await save({ locals: session(owner), request: post(equipment, 'later') });
			expect(result).toEqual({ saved: true });
			expect(await getEquipment(owner, { db })).toMatchObject(equipment);
			expect(await progress(owner, db)).toEqual({ current: null, completed: [], skipped: [] });
		});
	});
});

describe('the review step’s Start coaching', () => {
	it('needs an open goal and a schedule, then completes onboarding and goes to Today', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const start = () =>
				completeAction({ locals: session(owner), request: post() }, '/today', { db });
			expect(await start()).toMatchObject({
				status: 400,
				data: {
					errors: {
						goals: 'Add at least one goal',
						schedule: 'Tell your coach how many days you can train'
					}
				}
			});
			expect((await getOnboarding(owner, { db })).complete).toBe(false);

			await saveGoalAction(
				{ locals: session(owner), request: post(eventGoal()) },
				{ db, source: 'onboarding' }
			);
			await saveSchedule(
				owner,
				{ daysPerWeek: 4, availableDays: [], preferredTimes: [], commitments: [] },
				{ db }
			);
			expect(await redirectedTo(start())).toBe('/today');
			expect((await getOnboarding(owner, { db })).complete).toBe(true);
		});
	});
});
