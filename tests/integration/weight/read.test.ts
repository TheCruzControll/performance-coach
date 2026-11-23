/**
 * The reads behind the Weight view, Today's card and the coach's facts, on real Postgres: the
 * Progress window cuts the figures but not the history behind them, the goal and its history, the
 * owner's unit, and the empty case. Weigh-ins go in through logWeight; the goal through the
 * repository, since its service arrives with goals.ts.
 */
import { describe, expect, it } from 'vitest';
import { dailyTrend } from '../../../src/lib/domain/analytics/weight';
import { createWeightRepository, type Executor } from '../../../src/lib/server/db';
import { saveBasics } from '../../../src/lib/server/services/profile';
import {
	getWeightFacts,
	getWeightToday,
	getWeightView,
	logWeight,
	windowFrom
} from '../../../src/lib/server/services/weight';
import { withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';

const TODAY = '2026-11-22';
const NOW = () => new Date('2026-11-22T12:00:00Z');
const KG_PER_LB = 0.45359237;
const lb = (kg: number) => Math.round((kg / KG_PER_LB) * 100) / 100;

const WEIGH_INS: [string, number][] = [
	['2026-10-01', 84],
	['2026-10-20', 83],
	['2026-10-27', 82.5],
	['2026-11-03', 82],
	['2026-11-10', 81.5],
	['2026-11-16', 81],
	['2026-11-20', 80.6]
];

/** The weigh-ins above, logged through the service. */
async function seed(db: Executor, owner: string) {
	for (const [measuredOn, value] of WEIGH_INS) {
		await logWeight(owner, { value, unit: 'kg', measuredOn }, { db, now: NOW });
	}
}

/**
 * A goal from 84 kg on 1 October to 78 kg on 31 January, with two milestones; and, before it, an
 * ended goal (replaced) from the summer, so the history has both.
 */
async function goals(db: Executor, owner: string) {
	const repo = createWeightRepository(db);
	const old = await repo.insertGoal({
		ownerId: owner,
		unit: 'kg',
		startOn: '2026-06-01',
		startWeight: 88,
		targetOn: '2026-09-30',
		targetWeight: 85,
		source: 'log',
		createdAt: new Date('2026-05-31T09:00:00Z'),
		updatedAt: new Date('2026-05-31T09:00:00Z')
	});
	await repo.endActiveGoal(owner, 'replaced', new Date('2026-10-01T08:00:00Z'));
	const active = await repo.insertGoal({
		ownerId: owner,
		unit: 'kg',
		startOn: '2026-10-01',
		startWeight: 84,
		targetOn: '2027-01-31',
		targetWeight: 78,
		source: 'log',
		createdAt: new Date('2026-10-01T09:00:00Z'),
		updatedAt: new Date('2026-10-01T09:00:00Z')
	});
	await repo.replaceMilestones(
		owner,
		active.id,
		[
			{ onDate: '2026-11-01', weight: 82, source: 'generated' },
			{ onDate: '2026-12-15', weight: 80, source: 'generated' }
		],
		NOW()
	);
	return { old, active };
}

describe('the Weight view', () => {
	it('cuts the figures to a Progress period, and keeps the history behind them', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner);
			const view = await getWeightView(owner, '4w', TODAY, { db });
			expect(view.from).toBe('2026-10-19');
			expect(view.logBook.map((row) => row.day)).toEqual([
				'2026-11-20',
				'2026-11-16',
				'2026-11-10',
				'2026-11-03',
				'2026-10-27',
				'2026-10-20'
			]);
			// The first row in the window is measured against the weigh-in before it, outside it.
			expect(view.logBook.at(-1)).toMatchObject({ day: '2026-10-20', change: -1 });
			expect(view.stats.highest).toEqual({ day: '2026-10-20', weight: 83 });
			expect(view.stats.lowest).toEqual({ day: '2026-11-20', weight: 80.6 });
			expect(view.stats.latest).toEqual({ day: '2026-11-20', weight: 80.6 });
			expect(view.chart.weighIns.map((point) => point.day)).toEqual(
				view.logBook.map((row) => row.day).reverse()
			);
			// One bar per Monday week from the window's Monday; the week in progress is so far.
			expect(view.rateBars.map((bar) => bar.week)).toEqual([
				'2026-10-19',
				'2026-10-26',
				'2026-11-02',
				'2026-11-09',
				'2026-11-16'
			]);
			expect(view.rateBars.at(-1)).toMatchObject({ week: '2026-11-16', soFar: true });
		});
	});

	it('All has no first day and shows every weigh-in', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner);
			await goals(db, owner);
			const view = await getWeightView(owner, 'all', TODAY, { db });
			expect(view.from).toBeNull();
			expect(view.logBook).toHaveLength(WEIGH_INS.length);
			expect(view.stats.highest).toEqual({ day: '2026-10-01', weight: 84 });
			expect(view.goal?.startOn).toBe('2026-10-01');
			expect(view.chart.goalLine[0]).toEqual({ day: '2026-10-01', weight: 84 });
		});
	});

	it('draws the goal line from the window’s first day to the target day', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner);
			await goals(db, owner);
			const view = await getWeightView(owner, '4w', TODAY, { db });
			// 18 of the goal's 122 days have passed at the window's first day.
			expect(view.chart.goalLine).toEqual([
				{ day: '2026-10-19', weight: 83.11 },
				{ day: '2027-01-31', weight: 78 }
			]);
		});
	});

	it('reads the active goal with its status and milestones, and the goal history', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner);
			const { old, active } = await goals(db, owner);
			const view = await getWeightView(owner, '12w', TODAY, { db });
			expect(view.goal).toMatchObject({
				id: active.id,
				direction: 'loss',
				startWeight: 84,
				targetWeight: 78,
				targetOn: '2027-01-31'
			});
			expect(view.goal?.status.verdict).toMatch(/^(on_track|ahead|behind)$/);
			expect(view.goal?.milestones.map((m) => [m.day, m.weight])).toEqual([
				['2026-11-01', 82],
				['2026-12-15', 80]
			]);
			// The past milestone is missed: the trend on 1 November was 82.72, outside the 0.5 kg
			// tolerance around 82. The upcoming one is on track against its path today.
			expect(view.goal?.milestones.map((m) => m.status)).toEqual(['missed', 'on_track']);
			expect(view.goalHistory.map((g) => [g.id, g.status, g.endedReason])).toEqual([
				[active.id, 'active', null],
				[old.id, 'ended', 'replaced']
			]);
		});
	});

	it('shows the figures in the owner’s unit', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveBasics(owner, { name: 'Niko', weightUnit: 'lb', distanceUnit: 'km' }, { db });
			await seed(db, owner);
			await goals(db, owner);
			const view = await getWeightView(owner, 'all', TODAY, { db });
			expect(view.unit).toBe('lb');
			expect(view.stats.latest).toEqual({ day: '2026-11-20', weight: lb(80.6) });
			expect(view.goal).toMatchObject({ startWeight: lb(84), targetWeight: lb(78) });
			expect(view.goal?.milestones.map((m) => [m.day, m.weight])).toEqual([
				['2026-11-01', lb(82)],
				['2026-12-15', lb(80)]
			]);
		});
	});

	it('keeps one owner’s weigh-ins out of another’s figures', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner);
			const someoneElse = await makeSecondOwner(db);
			await logWeight(
				someoneElse,
				{ value: 150, unit: 'kg', measuredOn: '2026-11-20' },
				{ db, now: NOW }
			);
			const mine = await getWeightView(owner, 'all', TODAY, { db });
			expect(mine.logBook).toHaveLength(WEIGH_INS.length);
			expect(mine.stats.highest?.weight).toBe(84);
			const theirs = await getWeightView(someoneElse, 'all', TODAY, { db });
			expect(theirs.logBook.map((row) => row.weight)).toEqual([150]);
		});
	});

	it('maps a Progress period to its Monday, and All to no start', () => {
		expect(windowFrom('4w', TODAY)).toBe('2026-10-19');
		expect(windowFrom('12w', TODAY)).toBe('2026-08-24');
		expect(windowFrom('52w', TODAY)).toBe('2025-11-17');
		expect(windowFrom('all', TODAY)).toBeNull();
	});
});

describe('today and the coach’s facts', () => {
	it("today's card: the day's entry, the latest weigh-in, the trend and the verdict", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner);
			await goals(db, owner);
			const series = dailyTrend(
				WEIGH_INS.map(([measuredOn, value]) => ({ measuredOn, value, unit: 'kg' as const })),
				'kg'
			);
			const today = await getWeightToday(owner, TODAY, { db });
			expect(today).toMatchObject({
				unit: 'kg',
				entry: null,
				latest: { day: '2026-11-20', weight: 80.6 },
				stale: false
			});
			expect(today.trend).toBe(series.at(-1)!.trend);
			expect(today.verdict).toMatch(/^(on_track|ahead|behind)$/);

			const onThe20th = await getWeightToday(owner, '2026-11-20', { db });
			expect(onThe20th.entry).toMatchObject({ weight: 80.6, source: 'log' });
		});
	});

	it('the trend is stale once the last weigh-in is more than 7 days old', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner);
			expect(await getWeightToday(owner, '2026-11-27', { db })).toMatchObject({ stale: false });
			expect(await getWeightToday(owner, '2026-12-01', { db })).toMatchObject({
				stale: true,
				verdict: null
			});
		});
	});

	it('the coach’s facts: the 28-day rate, 30-day stats, the newest 14 rows and the goal', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner);
			await goals(db, owner);
			const facts = await getWeightFacts(owner, TODAY, { db });
			expect(facts.latest).toEqual({ day: '2026-11-20', weight: 80.6 });
			expect(facts.weeklyRate).toEqual(expect.any(Number));
			// The 30 days end today and start on 24 October: the 27 October weigh-in is the highest.
			expect(facts.stats.highest).toEqual({ day: '2026-10-27', weight: 82.5 });
			expect(facts.logBook).toHaveLength(WEIGH_INS.length);
			expect(facts.goal?.status.verdict).toMatch(/^(on_track|ahead|behind)$/);
		});
	});

	it('with no weigh-ins, everything reads empty', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const view = await getWeightView(owner, '4w', TODAY, { db });
			expect(view).toMatchObject({
				unit: 'kg',
				stats: {
					latest: null,
					trend: null,
					highest: null,
					lowest: null,
					change: null,
					weeklyRate: null
				},
				logBook: [],
				rateBars: [],
				chart: { weighIns: [], trend: [], goalLine: [] },
				goal: null,
				goalHistory: []
			});
			expect(await getWeightToday(owner, TODAY, { db })).toMatchObject({
				entry: null,
				latest: null,
				trend: null,
				verdict: null
			});
			expect(await getWeightFacts(owner, TODAY, { db })).toMatchObject({
				latest: null,
				trend: null,
				weeklyRate: null,
				logBook: [],
				goal: null
			});
		});
	});
});
