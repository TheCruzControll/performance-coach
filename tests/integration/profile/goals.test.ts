/**
 * Goals through the services on real Postgres: event and general goals, several at once, an
 * explicit and contiguous priority ranking, status changes and the change history (PRD §2).
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	createGoal,
	deleteGoal,
	goalHistory,
	listGoals,
	ProfileNotFoundError,
	reorderGoals,
	setGoalStatus,
	updateGoal
} from '../../../src/lib/server/services/profile';
import { withRollback } from '../helpers';
import { clock, eventGoal, fieldErrors, generalGoal, makeOwner } from './fixtures';

describe('goals', () => {
	it('stores an event goal and a general goal with their own fields, ranked in order', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const fight = await createGoal(owner, eventGoal(), { db, source: 'onboarding' });
			const strength = await createGoal(owner, generalGoal(), { db });

			expect(fight).toMatchObject({
				kind: 'event',
				status: 'active',
				priority: 1,
				eventType: 'Muay Thai fight',
				eventDate: '2027-03-14',
				weightClass: '-71 kg',
				targetPerformance: 'Win, stay composed for 3 rounds',
				requirements: 'Make weight the day before',
				focus: null,
				measure: null
			});
			expect(strength).toMatchObject({
				kind: 'general',
				priority: 2,
				focus: 'Hold squat and deadlift while fight camp runs',
				measure: 'Top sets at RPE 8 stay within 5%',
				eventDate: null
			});

			const goals = await listGoals(owner, { db });
			expect(goals.map((g) => [g.title, g.priority])).toEqual([
				['First Muay Thai fight', 1],
				['Keep my strength', 2]
			]);
			const history = await goalHistory(owner, { db });
			expect(history.map((e) => [e.change, e.source])).toEqual(
				expect.arrayContaining([
					['created', 'onboarding'],
					['created', 'profile']
				])
			);
		});
	});

	it('supports several concurrent goals across disciplines', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await createGoal(owner, eventGoal(), { db });
			await createGoal(owner, generalGoal(), { db });
			await createGoal(
				owner,
				eventGoal({
					title: 'Valencia marathon',
					disciplines: ['distance_running'],
					eventType: 'Marathon',
					eventDate: '2027-12-05',
					weightClass: null,
					targetPerformance: 'Sub 3:30'
				}),
				{ db }
			);
			await createGoal(
				owner,
				generalGoal({
					title: 'Build muscle',
					disciplines: ['hypertrophy'],
					focus: 'Upper-body size',
					measure: 'Arm and chest measurements monthly'
				}),
				{ db }
			);
			const goals = await listGoals(owner, { db });
			expect(goals.map((g) => g.priority)).toEqual([1, 2, 3, 4]);
			expect(goals.flatMap((g) => g.disciplines)).toEqual([
				'muay_thai',
				'strength',
				'distance_running',
				'hypertrophy'
			]);
		});
	});

	it('refuses incomplete goals with messages for each field', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(
				await fieldErrors(createGoal(owner, eventGoal({ eventDate: '', eventType: ' ' }), { db }))
			).toMatchObject({ eventDate: 'Pick the event date', eventType: 'What kind of event is it?' });
			expect(
				await fieldErrors(createGoal(owner, generalGoal({ measure: undefined }), { db }))
			).toMatchObject({ measure: 'How will you know it’s working?' });
			expect(
				await fieldErrors(createGoal(owner, generalGoal({ disciplines: [] }), { db }))
			).toMatchObject({ disciplines: 'Pick at least one discipline' });
			expect(
				await fieldErrors(createGoal(owner, generalGoal({ disciplines: ['custom'] }), { db }))
			).toMatchObject({ customDiscipline: 'Name your custom discipline' });
			expect(
				await fieldErrors(createGoal(owner, { ...generalGoal(), kind: 'someday' }, { db }))
			).toHaveProperty('kind');
			expect(await listGoals(owner, { db })).toEqual([]);
		});
	});

	it('reorders priorities, persists the ranking and records who moved what', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const a = await createGoal(owner, eventGoal(), { db });
			const b = await createGoal(owner, generalGoal(), { db });
			const c = await createGoal(owner, generalGoal({ title: 'Run a sub-20 5K' }), { db });

			const reordered = await reorderGoals(owner, { ids: [c.id, a.id, b.id] }, { db });
			expect(reordered.map((g) => [g.id, g.priority])).toEqual([
				[c.id, 1],
				[a.id, 2],
				[b.id, 3]
			]);
			// Read back from the database, not the return value.
			const stored = await db.execute<{ id: string; priority: number }>(
				sql`select id, priority from training_goals where owner_id = ${owner} order by priority`
			);
			expect(stored.rows.map((r) => r.id)).toEqual([c.id, a.id, b.id]);

			const moves = (await goalHistory(owner, { db })).filter((e) => e.change === 'reprioritized');
			expect(moves).toHaveLength(3);
			expect(moves.find((e) => e.goalId === c.id)?.snapshot).toMatchObject({ priority: 1 });
		});
	});

	it('refuses a ranking that leaves out, repeats or invents a goal', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const a = await createGoal(owner, eventGoal(), { db });
			const b = await createGoal(owner, generalGoal(), { db });
			expect(await fieldErrors(reorderGoals(owner, { ids: [a.id] }, { db }))).toEqual({
				ids: 'Rank every open goal exactly once'
			});
			expect(await fieldErrors(reorderGoals(owner, { ids: [a.id, a.id] }, { db }))).toHaveProperty(
				'ids'
			);
			expect(
				await fieldErrors(reorderGoals(owner, { ids: [a.id, crypto.randomUUID()] }, { db }))
			).toHaveProperty('ids');
			expect((await listGoals(owner, { db })).map((g) => g.id)).toEqual([a.id, b.id]);
		});
	});

	it('edits a goal, switching its kind clears the other kind’s fields', async () => {
		await withRollback(async (db) => {
			const time = clock();
			const owner = await makeOwner(db);
			const goal = await createGoal(owner, eventGoal(), { db, now: time.now });
			time.advanceDays(3);
			const edited = await updateGoal(
				owner,
				goal.id,
				generalGoal({ title: 'Fight-ready conditioning', disciplines: ['muay_thai', 'athletic'] }),
				{ db, now: time.now }
			);
			expect(edited).toMatchObject({
				id: goal.id,
				kind: 'general',
				title: 'Fight-ready conditioning',
				disciplines: ['muay_thai', 'athletic'],
				priority: 1,
				eventDate: null,
				eventType: null,
				weightClass: null
			});
			expect(edited.updatedAt.getTime()).toBeGreaterThan(edited.createdAt.getTime());
			const [last] = await goalHistory(owner, { db });
			expect(last).toMatchObject({ change: 'updated', goalId: goal.id });
		});
	});

	it('achieved and dropped goals leave the ranking; the rest close ranks; reopening goes last', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const a = await createGoal(owner, eventGoal(), { db });
			const b = await createGoal(owner, generalGoal(), { db });
			const c = await createGoal(owner, generalGoal({ title: 'Third' }), { db });

			const achieved = await setGoalStatus(owner, a.id, { status: 'achieved' }, { db });
			expect(achieved).toMatchObject({ status: 'achieved', priority: null });
			expect((await listGoals(owner, { db })).map((g) => [g.id, g.priority])).toEqual([
				[b.id, 1],
				[c.id, 2],
				[a.id, null]
			]);

			const paused = await setGoalStatus(owner, c.id, { status: 'paused' }, { db });
			expect(paused).toMatchObject({ status: 'paused', priority: 2 });

			const reopened = await setGoalStatus(owner, a.id, { status: 'active' }, { db });
			expect(reopened.priority).toBe(3);
			expect(
				await fieldErrors(setGoalStatus(owner, a.id, { status: 'won' }, { db }))
			).toHaveProperty('status');
		});
	});

	it('deleting a goal keeps its history and closes the gap in the ranking', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const a = await createGoal(owner, eventGoal(), { db });
			const b = await createGoal(owner, generalGoal(), { db });
			await deleteGoal(owner, a.id, { db });
			expect((await listGoals(owner, { db })).map((g) => [g.id, g.priority])).toEqual([[b.id, 1]]);
			const history = await goalHistory(owner, { db });
			expect(history.find((e) => e.change === 'deleted')).toMatchObject({
				goalId: a.id,
				snapshot: expect.objectContaining({ title: 'First Muay Thai fight' })
			});
		});
	});

	it('never touches another owner’s goal', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const goal = await createGoal(owner, eventGoal(), { db });
			// One owner today, but a service never trusts a goal id on its own.
			const stranger = crypto.randomUUID();
			await expect(updateGoal(stranger, goal.id, generalGoal(), { db })).rejects.toThrow(
				'goal not found'
			);
			await expect(deleteGoal(stranger, goal.id, { db })).rejects.toThrow('goal not found');
		});
	});

	it('answers a malformed goal id as not found, never with a database error', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const goal = await createGoal(owner, eventGoal(), { db });
			// Route params and the coach's tool calls (M5) pass ids through as given.
			for (const bad of ['', 'abc', `${goal.id}x`]) {
				await expect(updateGoal(owner, bad, generalGoal(), { db })).rejects.toBeInstanceOf(
					ProfileNotFoundError
				);
				await expect(
					setGoalStatus(owner, bad, { status: 'paused' }, { db })
				).rejects.toBeInstanceOf(ProfileNotFoundError);
				await expect(deleteGoal(owner, bad, { db })).rejects.toBeInstanceOf(ProfileNotFoundError);
			}
			expect(await listGoals(owner, { db })).toMatchObject([{ id: goal.id, status: 'active' }]);
		});
	});

	it('the database itself refuses a ranked closed goal or an event without a date', async () => {
		const attempt = (insert: (owner: string) => ReturnType<typeof sql>) =>
			withRollback(async (db) => {
				const owner = await makeOwner(db);
				return db.execute(insert(owner)).catch((e: unknown) => e);
			});
		const constraint = (e: unknown) => (e as { cause?: { constraint?: string } }).cause?.constraint;
		const closedButRanked = await attempt(
			(owner) =>
				sql`insert into training_goals (owner_id, kind, title, disciplines, status, priority, focus)
					values (${owner}, 'general', 'x', '{strength}', 'achieved', 1, 'y')`
		);
		const eventWithoutDate = await attempt(
			(owner) =>
				sql`insert into training_goals (owner_id, kind, title, disciplines, priority, event_type)
					values (${owner}, 'event', 'x', '{strength}', 1, 'Meet')`
		);
		expect([closedButRanked, eventWithoutDate].map(constraint)).toEqual([
			'training_goals_priority_ck',
			'training_goals_event_ck'
		]);
	});
});
