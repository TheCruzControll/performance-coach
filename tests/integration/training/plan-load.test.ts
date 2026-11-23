/**
 * The whole plan's load (src/routes/(app)/train/plan/plan.server.ts) on real Postgres: the current
 * program's title, its length and last day, and one line per block with its weeks, the blocks
 * before the one holding today done, that one now, an outline's weeks read like any other's, and
 * every block done once the plan has ended. With no program it is 'none' (the page sends it to
 * Train). When the database cannot be reached the load fails soft: Train's designed error, and the
 * failure recorded as a server error.
 */
import { describe, expect, it } from 'vitest';
import type { IsoDate } from '../../../src/lib/domain/calendar';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import { createProgramFromPlan } from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { loadPlan, type PlanData } from '../../../src/routes/(app)/train/plan/plan.server';
import { unreachableDb, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** Week 1's Monday. The owner's profile is on UTC (M2's default), so `at` gives today exactly. */
const MONDAY = '2026-11-09';
const at = (day: IsoDate) => new Date(`${day}T12:00:00Z`);

const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/train/plan',
	routeId: '/(app)/train/plan',
	appVersion: '0.1.0+test'
});

/** The plan (fails the test for any other state). */
function shown(data: PlanData) {
	if (data.state !== 'plan') throw new Error(`expected the plan, got ${data.state}`);
	return data;
}

describe('the whole plan’s load', () => {
	it('lists each block as a line with its weeks: the one holding today now, an outline ahead', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			// A baseline week, then an outline of three weeks of accumulation.
			const fixture = programFixture('one-week', { monday: MONDAY, today: MONDAY });
			await createProgramFromPlan(owner, fixture, { source: 'rules' }, { db });

			const data = shown(
				await loadPlan(owner, { now: at('2026-11-11'), origin: origin() }, { db })
			);
			expect(data.title).toBe(fixture.title);
			expect(data.span).toBe('4 weeks, ending Sunday 6 December');
			expect(data.phases.map((p) => [p.name, p.weeks, p.state])).toEqual([
				['Baseline week', 'Week 1', 'now'],
				['Accumulation', 'Weeks 2 to 4', 'ahead']
			]);

			// In the outline's weeks, week 1's block is done; past the plan's last day, every one is.
			const later = shown(
				await loadPlan(owner, { now: at('2026-11-18'), origin: origin() }, { db })
			);
			expect(later.phases.map((p) => p.state)).toEqual(['done', 'now']);
			const ended = shown(
				await loadPlan(owner, { now: at('2026-12-07'), origin: origin() }, { db })
			);
			expect(ended.phases.map((p) => p.state)).toEqual(['done', 'done']);
		});
	});

	it('with no program, there is no plan to show', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(await loadPlan(owner, { now: at(MONDAY), origin: origin() }, { db })).toEqual({
				state: 'none'
			});
		});
	});

	it('fails soft when the database cannot be reached, and records the failure', async () => {
		const broken = unreachableDb();
		try {
			await withRollback(async (tx) => {
				const request = origin();
				const data = await loadPlan(
					crypto.randomUUID(),
					{ now: at(MONDAY), origin: request },
					{ db: broken.db, errorsDb: tx }
				);
				expect(data).toMatchObject({
					state: 'error',
					card: { id: 'train-error', title: 'Couldn’t load your plan' }
				});
				const recorded = await findErrorsByRequestId(request.requestId, { db: tx });
				expect(recorded).toHaveLength(1);
				expect(recorded[0]).toMatchObject({
					kind: 'load',
					status: 500,
					routeId: '/(app)/train/plan',
					context: expect.objectContaining({ load: 'plan' })
				});
			});
		} finally {
			await broken.close();
		}
	});
});
