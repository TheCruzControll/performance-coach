/**
 * Today's streamed plan (src/routes/(app)/today/plan.server.ts) on real Postgres: the week with
 * today's sessions, Up next across weeks, a rest day naming the next session, 'Starts Monday'
 * before week 1, and 'Nothing planned yet' once the first block is over. When the database
 * cannot be reached it never rejects: {failed: true}, and the failure recorded as a server error.
 */
import { describe, expect, it } from 'vitest';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import {
	createProgramFromPlan,
	skipSession
} from '../../../src/lib/server/services/programs/index';
import {
	programFixture,
	type ProgramFixture
} from '../../../src/lib/server/test-support/program-fixtures';
import { loadTodayPlan, type TodayPlanView } from '../../../src/routes/(app)/today/plan.server';
import type { Executor } from '../../../src/lib/server/db/types';
import { unreachableDb, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

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

async function viewOf(db: Executor, owner: string) {
	const view = await loadTodayPlan(owner, { today: TODAY, origin: origin() }, { db });
	if (view.failed) throw new Error('the plan failed to load');
	return view;
}

type View = Extract<TodayPlanView, { failed: false }>;
const titles = (cards: { title: string }[]) => cards.map((c) => c.title);
const dayOf = (view: View, date: string) => view.week!.days.find((d) => d.date === date)!;

describe('Today’s plan', () => {
	it('shows the week with today selected, today’s sessions, and Up next from next week', async () => {
		await withRollback(async (db) => {
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

	it('on a rest day, names the next session', async () => {
		await withRollback(async (db) => {
			const owner = await seeded(db, 'today-rest', '2026-11-02');
			const view = await viewOf(db, owner);
			const today = dayOf(view, TODAY);
			expect(today.cards).toEqual([]);
			expect(today.rest).toBe('Recovery is part of the plan. Next: Intervals, tomorrow.');
			expect(view.upNext[0]).toMatchObject({ title: 'Intervals', when: 'Tomorrow' });
		});
	});

	it('before week 1, says when it starts and shows week 1 from its first day', async () => {
		await withRollback(async (db) => {
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
		await withRollback(async (db) => {
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
				upNext: []
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
					{ today: TODAY, origin: request },
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
