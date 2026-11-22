/**
 * The season on Train's plan sheet (m7/39, train/road.server.ts) on real Postgres, from the
 * periodisation-road fixtures seeded as the spec seeds them:
 * - multiGoal, M7-built: every block of the road in its season's words, the fight leading the
 *   camp with the marathon secondary and the rest held, the events pinned, and as many lanes in
 *   each block as Train's open-goal count reserves, so the swap moves nothing
 * - M3's hybrid with no mode decisions: its roles worked out from its goals, and said so
 * - offSeason: maintenance blocks, every goal held, no pin
 * - a road read that fails is recorded as a streamed error (part 'road') and answers null
 * Every read runs one query at a time on one client (the setup's busy-client guard).
 */
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../src/lib/server/db/types';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import {
	DERIVED_MODES_NOTE,
	getRoadView
} from '../../../src/lib/server/services/periodisation/road-view';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { loadTrainRoad } from '../../../src/routes/(app)/train/road.server';
import { loadTrainWeek } from '../../../src/routes/(app)/train/week.server';
import { unreachableDb, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const NOW = new Date('2026-11-11T12:00:00Z');
const origin = (requestId = crypto.randomUUID()) => ({
	...{ requestId, method: 'GET', path: '/train' },
	...{ routeId: '/(app)/train', appVersion: '0.1.0+test' }
});

/** `fixture` seeded for a new owner: the owner, Train's week data and its season. */
async function seeded(db: Executor, fixture: string) {
	const owner = await makeOwner(db);
	const { today } = await seedAnalyticsFixture(
		owner,
		fixture,
		{ timeZone: 'UTC', now: NOW },
		{ db }
	);
	const week = await loadTrainWeek(owner, { now: NOW, week: null, origin: origin() }, { db });
	if (week.state !== 'program') throw new Error(`expected a program, got ${week.state}`);
	const season = await loadTrainRoad(owner, { today, origin: origin() }, { db });
	if (!season) throw new Error('expected a season');
	return { owner, today, week, season };
}

const lanes = (block: { lanes: { goal: string; role: string }[] }) =>
	block.lanes.map((l) => `${l.goal} · ${l.role}`);

describe('Train’s season', () => {
	it('an M7-built multiGoal road: the camp led by the fight, both events pinned, the lanes reserved', async () => {
		await withRollback(async (db) => {
			const { owner, today, week, season } = await seeded(db, 'periodisation-road');
			const road = (await getRoadView(owner, today, { db }))!;
			expect(season.blocks.map((b) => b.label)).toEqual(road.blocks.map((b) => b.label));
			expect(season.blocks.map((b) => b.label).slice(0, 2)).toEqual(['Fight camp', 'Recovery']);
			// Each over the timeline block that starts on its day.
			expect(season.blocks.map((b) => b.key)).toEqual(week.plan.map((b) => b.key));
			expect(lanes(season.blocks[0]!)).toEqual([
				'Muay Thai fight · leads',
				'Marathon · secondary',
				'Build muscle · maintenance',
				'Keep strength · maintenance'
			]);
			expect(season.blocks.map((b) => b.tone)).toContain('taper');
			expect(season.note).toBeNull();
			expect(season.legend).toMatch(/^◆ Muay Thai fight · .+ ◆ Marathon · /);
			expect(season.marks.filter((m) => m.kind === 'pin')).toHaveLength(2);
			expect(season.marks.filter((m) => m.kind === 'now')).toHaveLength(1);
			// The room the sheet holds while the season streams is every lane it then shows.
			expect(week.openGoals).toBe(4);
			const widest = Math.max(...season.blocks.map((b) => b.lanes.length));
			expect(widest).toBe(week.openGoals);
		});
	});

	it('a program built before M7: its roles worked out from its goals, and labelled so', async () => {
		await withRollback(async (db) => {
			const { week, season } = await seeded(db, 'periodisation-road-m3');
			expect(season.note).toBe(DERIVED_MODES_NOTE);
			expect(season.blocks[0]!.lanes[0]).toMatchObject({ goal: 'Marathon', lead: true });
			expect(Math.max(...season.blocks.map((b) => b.lanes.length))).toBe(week.openGoals);
		});
	});

	it('an off-season: maintenance blocks with every goal held, and no pin', async () => {
		await withRollback(async (db) => {
			const { season } = await seeded(db, 'periodisation-road-off-season');
			expect(season.blocks.map((b) => b.tone)).toContain('maintenance');
			const held = season.blocks.find((b) => b.tone === 'maintenance')!;
			expect(lanes(held)).toEqual([
				'Keep strength · maintenance',
				'Keep running fitness · maintenance'
			]);
			expect(season.legend).toBe('');
			expect(season.marks.some((m) => m.kind === 'pin')).toBe(false);
		});
	});

	it('a road read that fails is recorded and answers null: the sheet keeps M3’s timeline', async () => {
		const broken = unreachableDb();
		try {
			await withRollback(async (tx) => {
				const request = origin();
				const season = await loadTrainRoad(
					crypto.randomUUID(),
					{ today: '2026-11-11', origin: request },
					{ db: broken.db, errorsDb: tx }
				);
				expect(season).toBeNull();
				const recorded = await findErrorsByRequestId(request.requestId, { db: tx });
				expect(recorded).toHaveLength(1);
				expect(recorded[0]).toMatchObject({
					kind: 'streamed',
					status: 500,
					path: '/train',
					context: expect.objectContaining({ load: 'train', part: 'road' })
				});
			});
		} finally {
			await broken.close();
		}
	});
});
