/**
 * Today's streamed plan (src/routes/(app)/today/plan.server.ts) on real Postgres: the week with
 * today's sessions, Up next across weeks, a rest day naming the next session, 'Starts Monday'
 * before week 1, and 'Nothing planned yet' once the first block is over, offering its review
 * (none mid-week while sessions remain; a failed prompt read leaves the plan). When the database
 * cannot be reached it never rejects: {failed: true}, and the failure recorded as a server error.
 * - It reads the plan and its week together, each on its own connection, so the cases run on the
 *   shared pool (withCommitted), never in one transaction.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { workouts } from '../../../src/lib/server/db';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import {
	createProgramFromPlan,
	getCurrentProgram,
	getProgramVersion,
	skipSession,
	type CurrentProgram,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import {
	programFixture,
	type ProgramFixture
} from '../../../src/lib/server/test-support/program-fixtures';
import { loadTodayPlan, type TodayPlanView } from '../../../src/routes/(app)/today/plan.server';
import type { Executor } from '../../../src/lib/server/db/types';
import { unreachableDb, watchPool, withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { logStrength } from './fixtures/history';

/** A Thursday. */
const TODAY = '2026-11-05';
const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/today',
	routeId: '/(app)/today',
	appVersion: '0.1.0+test'
});

async function seeded(db: Executor, fixture: ProgramFixture, monday: string) {
	const owner = await makeOwner(db);
	await createProgramFromPlan(
		owner,
		programFixture(fixture, { monday, today: TODAY }),
		{ source: 'rules' },
		{ db }
	);
	return owner;
}

/** The plan as Today reads it: from the program loadTodayProgram found. */
async function viewOf(db: Executor, owner: string) {
	const program = await getCurrentProgram(owner, TODAY, { db });
	if (!program) throw new Error('no active program');
	const view = await loadTodayPlan(owner, { today: TODAY, program, origin: origin() }, { db });
	if (view.failed) throw new Error('the plan failed to load');
	return view;
}

type View = Extract<TodayPlanView, { failed: false }>;
/** A program in its first block, as the plan needs it when no read can reach the database. */
const ACTIVE = {
	notStarted: false,
	blockComplete: false,
	firstPlannedDay: TODAY
} as CurrentProgram;
const titles = (cards: { title: string }[]) => cards.map((c) => c.title);
const dayOf = (view: View, date: string) => view.week!.days.find((d) => d.date === date)!;

describe('Today’s plan', () => {
	it('shows the week with today selected, today’s sessions, and Up next from next week', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'today', '2026-11-02');
			const view = await viewOf(db, owner);
			expect(view).toMatchObject({ starts: null, complete: null });
			expect(view.week).toMatchObject({ label: 'Week 1', today: TODAY, selected: TODAY });
			expect(view.week!.strip.map((d) => d.dots.length)).toEqual([0, 0, 1, 2, 0, 0, 0]);
			const today = dayOf(view, TODAY);
			expect(today).toMatchObject({ heading: 'Thursday 5 November', rest: null });
			expect(titles(today.cards)).toEqual(['Full body', 'Muay Thai class']);
			expect(today.cards.map((c) => c.baseline)).toEqual([true, false]);
			// Nothing else this week, so Up next crosses into week 2, in date order.
			expect(view.upNext.map((c) => [c.title, c.when])).toEqual([
				['Full body', 'Monday'],
				['Muay Thai class', 'Tuesday'],
				['Intervals', 'Wednesday']
			]);
			// A rest day later this week names the next session, from next week.
			expect(dayOf(view, '2026-11-07').rest).toBe(
				'Recovery is part of the plan. Next: Full body, Monday.'
			);

			// Skipping today's strength session shows it skipped, and Up next is unchanged.
			await skipSession(
				owner,
				{ sessionLineage: today.cards[0]!.lineage },
				{ version: 1, today: TODAY },
				{ db }
			);
			const after = await viewOf(db, owner);
			expect(dayOf(after, TODAY).cards.map((c) => [c.title, c.statusWords])).toEqual([
				['Full body', 'Skipped'],
				['Muay Thai class', null]
			]);
			expect(after.upNext).toEqual(view.upNext);
		});
	});

	it('offers each of today’s sessions Start workout, and Done · View to the workout once done', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const plan = programFixture('today', { monday: '2026-11-02', today: TODAY });
			const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const v1 = await getProgramVersion(owner, programId, 1, { db });
			const sessions = v1.blocks[0]!.weeks[0]!.sessions as StoredSession[];
			const fullBody = sessions.find((s) => s.date === TODAY)!;
			const planned = { sessionId: fullBody.id, lineageId: fullBody.lineage, programId };
			const startedAt = new Date(`${TODAY}T17:00:00Z`);
			const { workoutId } = await logStrength(db, owner, { startedAt, planned }, []);
			const [row] = await db
				.select({ clientId: workouts.clientId })
				.from(workouts)
				.where(eq(workouts.id, workoutId));

			const view = await viewOf(db, owner);
			const [done, muayThai] = dayOf(view, TODAY).cards;
			expect(done).toMatchObject({ title: 'Full body', status: 'completed' });
			expect(done!.start).toEqual({
				id: 'done-workout',
				label: 'Done · View',
				href: `/progress/workouts/${row!.clientId}`,
				icon: 'check'
			});
			expect(muayThai!.start).toEqual({
				id: 'start-workout',
				label: 'Start workout',
				href: `/workout?start=${muayThai!.lineage}`,
				icon: 'play'
			});
			// Only today's sessions: not another day's, nor Up next.
			const others = view.week!.days.filter((d) => d.date !== TODAY).flatMap((d) => d.cards);
			expect([...others, ...view.upNext].map((c) => c.start)).toEqual(
				[...others, ...view.upNext].map(() => null)
			);
			expect(view.upNext).toHaveLength(3);
		});
	});

	it('reads the plan and the week it shows together, each on its own connection', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'today', '2026-11-02');
			const program = (await getCurrentProgram(owner, TODAY, { db }))!;
			const pool = watchPool();
			const view = await loadTodayPlan(
				owner,
				{ today: TODAY, program, origin: origin() },
				{ db }
			).finally(pool.stop);
			expect(view).toMatchObject({ failed: false, week: { label: 'Week 1', today: TODAY } });
			expect(pool.peak()).toBeGreaterThan(1);
		});
	});

	it('on a rest day, names the next session', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'today-rest', '2026-11-02');
			const view = await viewOf(db, owner);
			const today = dayOf(view, TODAY);
			expect(today.cards).toEqual([]);
			expect(today.rest).toBe('Recovery is part of the plan. Next: Intervals, tomorrow.');
			expect(view.upNext[0]).toMatchObject({ title: 'Intervals', when: 'Tomorrow' });
		});
	});

	it('before week 1, says when it starts and shows week 1 from its first day', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'hybrid', '2026-11-09');
			const view = await viewOf(db, owner);
			expect(view.starts).toEqual({
				title: 'Starts Monday',
				description: 'Week 1 begins Monday 9 November. First up: Full body.'
			});
			expect(view.week).toMatchObject({ label: 'Week 1', today: null, selected: '2026-11-09' });
			expect(titles(dayOf(view, '2026-11-09').cards)).toEqual(['Full body']);
			expect(view.upNext[0]).toMatchObject({ title: 'Full body', when: 'Monday' });
		});
	});

	it('once the first block is over, nothing is planned yet and Up next is empty', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'one-week', '2026-10-26');
			const view = await viewOf(db, owner);
			expect(view).toEqual({
				failed: false,
				week: null,
				starts: null,
				complete: {
					title: 'Nothing planned yet',
					description:
						'You trained through every planned week, Mon 26 Oct – Sun 1 Nov. Your next block is planned from how this one went.'
				},
				upNext: [],
				// The block is over and has no review: Today offers it (review-prompt.server.ts).
				review: expect.objectContaining({
					kind: 'cycle',
					state: 'due',
					title: 'Block complete — review it and plan the next',
					create: expect.objectContaining({ action: '/progress/reviews?/createCycle' })
				})
			});
		});
	});

	it('offers no review mid-week while sessions remain, in a program that started this week', async () => {
		await withRollback(async (db) => {
			const owner = await seeded(db, 'today', '2026-11-02');
			expect((await viewOf(db, owner)).review).toBeNull();
		});
	});

	it('a failed review prompt read is recorded, and the plan shows without it', async () => {
		await withRollback(async (db) => {
			const owner = await seeded(db, 'today', '2026-11-02');
			const request = origin();
			const program = (await getCurrentProgram(owner, TODAY, { db }))!;
			const view = await loadTodayPlan(
				owner,
				{ today: TODAY, program, origin: request },
				{
					db,
					errorsDb: db,
					prompt: async () => {
						throw new Error('lock timeout');
					}
				}
			);
			expect(view).toMatchObject({ failed: false, review: null });
			expect(view.failed || view.week).toBeTruthy();
			const recorded = await findErrorsByRequestId(request.requestId, { db });
			expect(recorded).toHaveLength(1);
			expect(recorded[0]).toMatchObject({
				kind: 'streamed',
				context: expect.objectContaining({ load: 'todayReviewPrompt' })
			});
		});
	});

	it('fails soft when the database cannot be reached, and records the failure', async () => {
		const broken = unreachableDb();
		try {
			await withRollback(async (tx) => {
				const request = origin();
				const view = await loadTodayPlan(
					crypto.randomUUID(),
					{ today: TODAY, program: ACTIVE, origin: request },
					{ db: broken.db, errorsDb: tx }
				);
				expect(view).toEqual({ failed: true });
				const recorded = await findErrorsByRequestId(request.requestId, { db: tx });
				expect(recorded).toHaveLength(1);
				expect(recorded[0]).toMatchObject({
					kind: 'streamed',
					status: 500,
					path: '/today',
					context: expect.objectContaining({ load: 'todayPlan' })
				});
			});
		} finally {
			await broken.close();
		}
	});
});
