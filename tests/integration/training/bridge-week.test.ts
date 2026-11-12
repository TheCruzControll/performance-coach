/**
 * A bridge week between blocks (M6 bridge-week-states) on real Postgres, from the bridge-week
 * fixture: three unplanned weeks after Base, this week the last, and Build from next Monday.
 * Train, its plan timeline, History and Today each show the bridge as a deliberate gap with the
 * day the next block starts, never seven rest days, and Train lists what was logged in it as
 * off-plan. A Base week and Build's first week read as they always have.
 *
 * Today is forced to a Wednesday and a Monday in Los Angeles; the seeds run inside the test's
 * transaction, so the integration setup also proves each load sends one query at a time. Today's
 * case runs on the shared pool (withCommitted): it reads the plan and its week together, each on
 * its own connection.
 */
import { describe, expect, it } from 'vitest';
import type { IsoDate } from '../../../src/lib/domain/calendar';
import type { Executor } from '../../../src/lib/server/db';
import {
	getCurrentProgram,
	getTrainingWeek
} from '../../../src/lib/server/services/programs/index';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import type { BridgeFixtureResult } from '../../../src/lib/server/test-support/analytics-fixtures/bridge-week';
import { loadTodayPlan } from '../../../src/routes/(app)/today/plan.server';
import { loadHistory } from '../../../src/routes/(app)/train/history/[[version]]/history.server';
import { loadTrainWeek, type TrainWeekData } from '../../../src/routes/(app)/train/week.server';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const MONDAY = '2026-11-16';
const WEDNESDAY = '2026-11-18';
/** Build's first day, and its first week in the program (Base from Mon 5 Oct, then 3 + 4 weeks). */
const NEXT_MONDAY = '2026-11-23';
const BUILD_WEEK = 8;

const origin = (path: string) => ({
	requestId: crypto.randomUUID(),
	method: 'GET',
	path,
	routeId: `/(app)${path}`,
	appVersion: '0.1.0+test'
});

async function seeded(db: Executor, today: IsoDate) {
	const owner = await makeOwner(db);
	const now = atLocal(today, '12:00', TZ);
	const seed = await seedAnalyticsFixture(owner, 'bridge-week', { timeZone: TZ, now }, { db });
	return { owner, now, seed: seed as typeof seed & BridgeFixtureResult };
}

/** Train's program view (fails the test for any other state). */
async function train(db: Executor, owner: string, now: Date, week: string | null = null) {
	const data: TrainWeekData = await loadTrainWeek(
		owner,
		{ now, week, origin: origin('/train') },
		{ db }
	);
	if (data.state !== 'program') throw new Error(`expected a program, got ${data.state}`);
	return data;
}

describe('a bridge week', () => {
	it('is read with the day its next block starts; a Base week is not', async () => {
		await withRollback(async (db) => {
			const { owner, seed } = await seeded(db, WEDNESDAY);
			expect(seed.nextBlock).toEqual({ startsOn: NEXT_MONDAY, week: BUILD_WEEK });
			const bridge = await getTrainingWeek(owner, { date: WEDNESDAY }, {}, { db });
			expect(bridge).toMatchObject({ planned: true, kind: 'unplanned' });
			expect(bridge!.planned && bridge!.days.flatMap((d) => d.sessions)).toEqual([]);
			expect(bridge).toMatchObject({ nextBlockStartsOn: NEXT_MONDAY });
			const base = await getTrainingWeek(owner, { date: '2026-10-28' }, {}, { db });
			expect(base).toMatchObject({ planned: true, blockName: 'Base' });
			expect(base).not.toHaveProperty('nextBlockStartsOn');
		});
	});

	it.each([WEDNESDAY, MONDAY])(
		'Train shows it as a gap with the next block’s start and the off-plan run (today %s)',
		async (today) => {
			await withRollback(async (db) => {
				const { owner, now } = await seeded(db, today);
				const view = await train(db, owner, now);
				expect(view.card).toMatchObject({
					id: 'train-bridge',
					title: 'Unplanned week · between blocks',
					next: { title: 'See your next block', subtitle: 'Build · Week 8', to: { week: 8 } }
				});
				expect(view.card!.description).toMatch(/^Your next block starts Mon 23 Nov\./);
				// Never seven rest days.
				expect(view.strip).toEqual([]);
				expect(view.days).toEqual([]);
				const day = today === MONDAY ? 'Mon 16 Nov' : 'Wed 18 Nov';
				expect(view.offPlan).toEqual([
					{
						id: expect.any(String),
						title: 'Easy run',
						status: 'completed',
						statusWords: 'Off-plan',
						line: `${day} · 30 min`,
						tone: 'running'
					}
				]);
			});
		}
	);

	it('Train’s next week is Build’s first, with its sessions and nothing off-plan', async () => {
		await withRollback(async (db) => {
			const { owner, now } = await seeded(db, WEDNESDAY);
			const view = await train(db, owner, now, String(BUILD_WEEK));
			expect(view.card).toBeNull();
			expect(view.offPlan).toEqual([]);
			expect(view.position).toBe('Build · Week 8 of 11');
			expect(view.days[0]!.cards.map((c) => c.title)).toEqual(['Strength A']);
		});
	});

	it('the plan timeline labels the bridge with its length', async () => {
		await withRollback(async (db) => {
			const { owner, now } = await seeded(db, WEDNESDAY);
			const { plan } = await train(db, owner, now);
			expect(plan.map((b) => [b.name, b.span, b.bridge])).toEqual([
				['Base', 'Mon 5 Oct – Sun 1 Nov · 4 weeks', false],
				['Between blocks · 3 weeks', 'Mon 2 Nov – Sun 22 Nov · Nothing planned', true],
				['Build', 'Mon 23 Nov – Sun 20 Dec · 4 weeks', false]
			]);
			expect(plan[1]).toMatchObject({ phase: null, current: true, outline: false });
		});
	});

	it('History’s version shows the same state for the week', async () => {
		await withRollback(async (db) => {
			const { owner, now } = await seeded(db, WEDNESDAY);
			const data = await loadHistory(
				owner,
				{ version: '2', before: null, now, origin: origin('/train/history/2') },
				{ db }
			);
			if (data.state !== 'version') throw new Error(`expected a version, got ${data.state}`);
			expect(data.week.label).toBe('Between blocks · Week 7');
			expect(data.week.bridge).toMatchObject({
				id: 'history-bridge',
				title: 'Unplanned week · between blocks'
			});
			expect(data.week.bridge!.description).toMatch(/^The next block starts Mon 23 Nov\./);
		});
	});

	it('Today names the next block’s start in place of the week, and Up next is Build', async () => {
		await withCommitted(async (db) => {
			const { owner } = await seeded(db, WEDNESDAY);
			const program = (await getCurrentProgram(owner, WEDNESDAY, { db }))!;
			const view = await loadTodayPlan(
				owner,
				{ today: WEDNESDAY, program, origin: origin('/today') },
				{ db }
			);
			if (view.failed) throw new Error('the plan failed to load');
			expect(view.week).toBeNull();
			expect(view.bridge).toMatchObject({ title: 'Between blocks' });
			expect(view.bridge!.description).toMatch(/^Your next block starts Mon 23 Nov\./);
			expect(view.upNext[0]).toMatchObject({ title: 'Strength A', when: 'Monday' });
		});
	});
});
