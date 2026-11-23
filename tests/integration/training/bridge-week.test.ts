/**
 * A bridge week between blocks (M6 bridge-week-states) on real Postgres, from the bridge-week
 * fixture: three unplanned weeks after Base, this week the last, and Build from next Monday.
 * Train, the whole plan and Today each show the bridge as a deliberate gap with the day the next
 * block starts, never seven rest days, and Train lists what was logged in it as off-plan; History
 * says the week was not planned before the change that made the bridge. A Base week and Build's
 * first week read as they always have.
 *
 * Today is forced to a Wednesday and a Monday in Los Angeles; the seeds run inside the test's
 * transaction, so the integration setup also proves each load sends one query at a time.
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
import {
	loadHistory,
	NOT_PLANNED_BEFORE
} from '../../../src/routes/(app)/train/history/[[version]]/history.server';
import { loadPlan } from '../../../src/routes/(app)/train/plan/plan.server';
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
					title: 'Free week',
					next: { title: 'See the next block', to: { week: 8 }, style: 'row' },
					bare: false
				});
				expect(view.card!.description).toBe(
					'Build starts Monday 23 November. Train as you like, and what you log counts as off plan.'
				);
				expect(view.position).toBe('Between blocks');
				// Never seven rest days.
				expect(view.lines).toEqual([]);
				// Nothing to add to: no day of a bridge week takes a session.
				expect(view.addable).toEqual([]);
				const [day, date] =
					today === MONDAY ? ['Mon', 'Monday 16 November'] : ['Wed', 'Wednesday 18 November'];
				expect(view.offPlan).toEqual([
					{
						date: today,
						day,
						title: 'Easy run',
						when: 'today',
						end: { text: '30 min' },
						name: `${date}, Easy run, 30 min`
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
			expect(view.position).toBe('Week 8 of 11 · Build');
			expect(view.lines[0]).toMatchObject({ day: 'Mon', title: 'Strength A' });
		});
	});

	it('the whole plan names the bridge with its length, as its current phase', async () => {
		await withRollback(async (db) => {
			const { owner, now } = await seeded(db, WEDNESDAY);
			const plan = await loadPlan(owner, { now, origin: origin('/train/plan') }, { db });
			if (plan.state !== 'plan') throw new Error(`expected the plan, got ${plan.state}`);
			expect(plan.span).toBe('11 weeks, ending Sunday 20 December');
			expect(plan.phases.map((p) => [p.name, p.weeks, p.state])).toEqual([
				['Base', 'Weeks 1 to 4', 'done'],
				['Between blocks · 3 weeks', 'Weeks 5 to 7', 'now'],
				['Build', 'Weeks 8 to 11', 'ahead']
			]);
		});
	});

	// The bridge came with version 2, the late review's next block, which names no dated session:
	// the week it touched is this one, where version 1 had nothing planned (Base ended three weeks
	// ago). The week before that change is not planned, never Base's week 1.
	it('History’s change that made the bridge says the week was not planned before it', async () => {
		await withRollback(async (db) => {
			const { owner, now } = await seeded(db, WEDNESDAY);
			const before = await getTrainingWeek(owner, { date: WEDNESDAY }, { version: 1 }, { db });
			expect(before).toMatchObject({ planned: false, startsOn: MONDAY });
			const data = await loadHistory(
				owner,
				{ version: '2', before: null, week: true, now, origin: origin('/train/history/2') },
				{ db }
			);
			if (data.state !== 'version') throw new Error(`expected a version, got ${data.state}`);
			expect(data.week).toEqual({
				label: 'Week of Mon 16 Nov',
				version: 1,
				older: true,
				lines: [],
				notPlanned: NOT_PLANNED_BEFORE
			});
		});
	});

	// Today reads the plan and its week together, each on its own connection: on the shared pool.
	it('Today names the next block’s start in place of the week, and Up next is Build', async () => {
		await withCommitted(async (db) => {
			const { owner } = await seeded(db, WEDNESDAY);
			const program = await getCurrentProgram(owner, WEDNESDAY, { db });
			if (!program) throw new Error('no active program');
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
