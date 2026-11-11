/**
 * The Strength view's closed-week rollups (services/analytics/strength-weeks.ts) on the M6
 * dataset: the database marks every week a write may change stale, a sync that touches a counted
 * workout writes the closed weeks again, and the dashboards read a week from its rollup only where
 * it gives what the facts give, to the byte.
 */
import { stringify } from 'devalue';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PERIODS } from '../../../src/lib/domain/analytics/period-names';
import { addDays, type IsoDate } from '../../../src/lib/domain/calendar';
import { createMutation, type MutationPayloads } from '../../../src/lib/domain/workout/index';
import {
	setRecords,
	strengthWeekRollups,
	workouts,
	type Executor
} from '../../../src/lib/server/db';
import {
	createAnalyticsRepository,
	type AnalyticsRepository
} from '../../../src/lib/server/db/repositories/analytics';
import { createStrengthWeeksRepository } from '../../../src/lib/server/db/repositories/strength-weeks';
import type { InstantRange } from '../../../src/lib/server/db/queries/history';
import { getProgressOverview } from '../../../src/lib/server/services/analytics/overview';
import { getStrengthDashboard } from '../../../src/lib/server/services/analytics/strength';
import { refreshStrengthWeeks } from '../../../src/lib/server/services/analytics/strength-weeks';
import { applySyncBatch } from '../../../src/lib/server/services/workouts/sync';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { withRollback } from '../helpers';
import { seedDataset, TODAY, TZ, WEEK_ONE, weekOf, type Dataset } from './fixtures/dataset';

/** Noon on TODAY (week 17's Wednesday): weeks 1 to 16 are closed. */
const NOW = atLocal(TODAY, '12:00', TZ);
const CLOSED = 16;

type Row = {
	week: IsoDate;
	generation: number;
	written: boolean;
	split: boolean;
	tonnage: number | null;
};

/** The owner's rollups, oldest first. */
async function rows(db: Executor, owner: string): Promise<Row[]> {
	const { rows } = await db.execute<Row>(sql`
		select week_start::text as week, generation, written_at is not null as written, split,
			(digest -> 'week' ->> 1)::float8 as tonnage
		from strength_week_rollups where owner_id = ${owner} order by week_start`);
	return rows;
}
const row = async (db: Executor, owner: string, week: IsoDate) =>
	(await rows(db, owner)).find((r) => r.week === week);

/** Every period's Strength dashboard and overview, devalue'd as the page data is. */
async function pages(db: Executor, owner: string, today: IsoDate = TODAY): Promise<string[]> {
	const out: string[] = [];
	for (const period of PERIODS) {
		out.push(stringify(await getStrengthDashboard(db, owner, { period, today })));
		out.push(stringify(await getProgressOverview(db, owner, { period, today })));
	}
	return out;
}

/** The analytics repository, recording the range of every sets read. */
function recording(db: Executor) {
	const repository = createAnalyticsRepository(db);
	const ranges: InstantRange[] = [];
	const wrapped: AnalyticsRepository = {
		...repository,
		sets: (owner, range) => {
			ranges.push(range);
			return repository.sets(owner, range);
		}
	};
	return { repository: wrapped, ranges };
}

/** The first counted set of week `n`'s Wednesday, and its workout. */
async function aSetIn(db: Executor, owner: string, n: number) {
	const { rows: found } = await db.execute<{ id: string; workout: string }>(sql`
		select s.id::text as id, s.workout_id as workout from set_records s
		join workouts w on w.id = s.workout_id
		where s.owner_id = ${owner} and w.status = 'completed' and s.deleted_at is null
			and s.performed_at >= ${atLocal(addDays(weekOf(n), 2), '00:00', TZ)}
			and s.performed_at < ${atLocal(addDays(weekOf(n), 3), '00:00', TZ)}
		order by s.performed_at limit 1`);
	return found[0]!;
}

async function seeded(db: Executor): Promise<Dataset> {
	const data = await seedDataset(db);
	expect(await refreshStrengthWeeks(db, data.owner, NOW)).toBe(CLOSED);
	return data;
}

describe('marking weeks stale', () => {
	it('marks the weeks an insert, an edit or a status change may alter, and only those', async () => {
		await withRollback(async (db) => {
			const { owner, exercises } = await seedDataset(db);
			// The seed's inserts marked every week of the history.
			const inserted = (await rows(db, owner)).filter(
				(r) => r.week >= WEEK_ONE && r.week <= weekOf(CLOSED)
			);
			expect(inserted.map((r) => [r.written, r.generation > 0])).toEqual(
				Array.from({ length: CLOSED }, () => [false, true])
			);
			expect(await refreshStrengthWeeks(db, owner, NOW)).toBe(CLOSED);
			const all = await rows(db, owner);
			// The weeks of the history, each written; the stale marks around it (a day either side of
			// each instant) never are.
			const history = all.filter((r) => r.week >= WEEK_ONE && r.week <= weekOf(CLOSED));
			expect(all.filter((r) => r.written)).toEqual(history);
			expect(history.map((r) => [r.written, r.split])).toEqual(
				Array.from({ length: CLOSED }, () => [true, false])
			);
			const before = new Map(all.map((r) => [r.week, r.generation]));
			const marked = async () =>
				(await rows(db, owner))
					.filter((r) => r.generation !== before.get(r.week))
					.map((r) => r.week);

			// A Wednesday set's weight: its week, and its workout's (the same).
			const set = await aSetIn(db, owner, 10);
			await db
				.update(setRecords)
				.set({ weight: 61 })
				.where(eq(setRecords.id, Number(set.id)));
			expect(await marked()).toEqual([weekOf(10)]);
			expect(await row(db, owner, weekOf(10))).toMatchObject({ written: false, tonnage: null });

			// An update that changes nothing marks nothing.
			for (const r of await rows(db, owner)) before.set(r.week, r.generation);
			await db
				.update(setRecords)
				.set({ weight: 61 })
				.where(eq(setRecords.id, Number(set.id)));
			expect(await marked()).toEqual([]);

			// Moving a set to another week marks both.
			await db
				.update(setRecords)
				.set({ performedAt: atLocal(addDays(weekOf(12), 2), '18:00', TZ) })
				.where(eq(setRecords.id, Number(set.id)));
			expect(await marked()).toEqual([weekOf(10), weekOf(12)]);

			// A workout abandoned after the fact: the weeks of its start and of its sets.
			for (const r of await rows(db, owner)) before.set(r.week, r.generation);
			const other = await aSetIn(db, owner, 3);
			await db.update(workouts).set({ status: 'abandoned' }).where(eq(workouts.id, other.workout));
			expect(await marked()).toEqual([weekOf(3)]);

			// An exercise whose muscles change: every week of the owner's.
			for (const r of await rows(db, owner)) before.set(r.week, r.generation);
			await db.execute(
				sql`update exercises set secondary_muscles = array['forearms'] where id = ${exercises.barbell_row}`
			);
			expect(await marked()).toEqual([...before.keys()]);
		});
	});
});

describe('reading the rollups', () => {
	it('gives every period the facts’ figures, to the byte, reading only the last two weeks’ sets', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const facts = await pages(db, data.owner);
			expect(await refreshStrengthWeeks(db, data.owner, NOW)).toBe(CLOSED);
			expect(await pages(db, data.owner)).toEqual(facts);

			// Every closed week before last week comes from its rollup.
			const { repository, ranges } = recording(db);
			await getStrengthDashboard(db, data.owner, { period: 'all', today: TODAY }, { repository });
			const lastMonday = atLocal(weekOf(CLOSED), '00:00', TZ).getTime();
			expect(ranges.length).toBe(1);
			expect(ranges[0]!.start.getTime()).toBeGreaterThan(lastMonday - 24 * 3_600_000);

			// Each week stale in turn, alone or with its neighbours, gives the same pages.
			for (const stale of [[weekOf(1)], [weekOf(5), weekOf(6)], [weekOf(14)]]) {
				await db
					.update(strengthWeekRollups)
					.set({ writtenAt: null, digest: null, generation: sql`generation + 1` })
					.where(
						and(
							eq(strengthWeekRollups.ownerId, data.owner),
							sql`${strengthWeekRollups.weekStart} = any(${sql.param(stale)}::date[])`
						)
					);
				expect(await pages(db, data.owner)).toEqual(facts);
				expect(await refreshStrengthWeeks(db, data.owner, NOW)).toBe(stale.length);
			}
		});
	});

	it('sums a week holding a workout run past Sunday midnight with its neighbour, never alone', async () => {
		await withRollback(async (db) => {
			const data = await seeded(db);
			// Week 9's Sunday, 23:40 to 00:20 on week 10's Monday.
			const sunday = addDays(weekOf(9), 6);
			const [late] = await db
				.insert(workouts)
				.values({
					ownerId: data.owner,
					clientId: crypto.randomUUID(),
					kind: 'strength',
					discipline: 'strength',
					sessionType: 'strength',
					title: 'Late arms',
					status: 'completed',
					startedAt: atLocal(sunday, '23:40', TZ),
					finishedAt: atLocal(addDays(sunday, 1), '00:30', TZ)
				})
				.returning({ id: workouts.id });
			const curl = (at: Date, setIndex: number) => ({
				ownerId: data.owner,
				workoutId: late!.id,
				clientMutationId: crypto.randomUUID(),
				exerciseId: data.exercises.dumbbell_curl,
				exercisePosition: 1,
				setIndex,
				weight: 20,
				unit: 'kg' as const,
				reps: 10,
				rpe: 9,
				performedAt: at
			});
			await db
				.insert(setRecords)
				.values([
					curl(atLocal(sunday, '23:45', TZ), 1),
					curl(atLocal(addDays(sunday, 1), '00:15', TZ), 2)
				]);
			const facts = await pages(db, data.owner);

			expect(await refreshStrengthWeeks(db, data.owner, NOW)).toBe(2);
			expect(await row(db, data.owner, weekOf(9))).toMatchObject({ written: true, split: true });
			expect(await row(db, data.owner, weekOf(10))).toMatchObject({ written: true, split: true });
			expect(await pages(db, data.owner)).toEqual(facts);

			// Week 10 summed again on its own (marked stale alone) is still split: kept whole, it would
			// hold Monday's set as a session of its own.
			await db
				.update(strengthWeekRollups)
				.set({ writtenAt: null, digest: null, generation: sql`generation + 1` })
				.where(
					and(
						eq(strengthWeekRollups.ownerId, data.owner),
						eq(strengthWeekRollups.weekStart, weekOf(10))
					)
				);
			expect(await refreshStrengthWeeks(db, data.owner, NOW)).toBe(1);
			expect(await row(db, data.owner, weekOf(10))).toMatchObject({ written: true, split: true });
			expect(await pages(db, data.owner)).toEqual(facts);
		});
	});

	it('reads every week from the facts once the time zone changes, until the next write', async () => {
		await withRollback(async (db) => {
			const data = await seeded(db);
			await db.execute(
				sql`update athlete_profiles set time_zone = 'Pacific/Auckland' where owner_id = ${data.owner}`
			);
			const facts = await pages(db, data.owner);
			const { repository, ranges } = recording(db);
			await getStrengthDashboard(db, data.owner, { period: 'all', today: TODAY }, { repository });
			expect(ranges[0]!.start.getTime()).toBeLessThan(atLocal(weekOf(2), '00:00', TZ).getTime());

			expect(await refreshStrengthWeeks(db, data.owner, NOW)).toBe(CLOSED);
			expect(await pages(db, data.owner)).toEqual(facts);
		});
	});
});

describe('writing the rollups', () => {
	it('never lands a week marked stale after its facts were read; the next write does', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const set = await aSetIn(db, data.owner, 7);
			// A sync edits a week-7 set right after the refresh read the facts.
			const repository = createAnalyticsRepository(db);
			let edited = false;
			const racing: AnalyticsRepository = {
				...repository,
				sets: async (owner, range) => {
					const read = await repository.sets(owner, range);
					if (!edited) {
						edited = true;
						await db
							.update(setRecords)
							.set({ reps: 1 })
							.where(eq(setRecords.id, Number(set.id)));
					}
					return read;
				}
			};
			expect(await refreshStrengthWeeks(db, data.owner, NOW, { repository: racing })).toBe(
				CLOSED - 1
			);
			expect(await row(db, data.owner, weekOf(7))).toMatchObject({ written: false });
			expect(await row(db, data.owner, weekOf(8))).toMatchObject({ written: true });

			expect(await refreshStrengthWeeks(db, data.owner, NOW)).toBe(1);
			const facts = await pages(db, data.owner);
			await db
				.update(strengthWeekRollups)
				.set({ writtenAt: null, digest: null })
				.where(eq(strengthWeekRollups.ownerId, data.owner));
			expect(await pages(db, data.owner)).toEqual(facts);
		});
	});

	it('writes again the past week a sync logs, edits or deletes a set of, with its new figures', async () => {
		await withRollback(async (db) => {
			const data = await seeded(db);
			const sync = (mutations: unknown[]) =>
				applySyncBatch(data.owner, JSON.parse(JSON.stringify(mutations)), { db, now: () => NOW });
			// A forgotten Friday workout of week 12, logged and finished after the fact.
			const workoutId = crypto.randomUUID();
			const friday = addDays(weekOf(12), 4);
			const at = (time: string) => atLocal(friday, time, TZ).toISOString();
			const done: MutationPayloads['set.edit'] = {
				...{ reps: 10, seconds: null, metres: null, weight: 30, assistance: null, unit: 'kg' },
				...{ rpe: 8, missedReps: 0, isWarmup: false, isExtra: false }
			};
			const log = createMutation('set.log', {
				workoutId,
				at: at('18:10'),
				payload: {
					position: 1,
					plannedLineage: null,
					setIndex: 1,
					exerciseId: data.exercises.dumbbell_curl,
					...done
				}
			});
			const before = (await row(db, data.owner, weekOf(12)))!.tonnage!;
			const { results } = await sync([
				createMutation('workout.start', {
					workoutId,
					at: at('18:00'),
					payload: {
						...{ kind: 'strength', title: 'Arms', sessionType: 'strength', discipline: 'strength' },
						...{ plannedSessionId: null, plannedLineage: null, programId: null }
					}
				}),
				log,
				createMutation('workout.finish', { workoutId, at: at('18:30'), payload: {} })
			]);
			expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
			expect(await row(db, data.owner, weekOf(12))).toMatchObject({
				written: true,
				tonnage: before + 300
			});

			await sync([
				createMutation('set.edit', {
					workoutId,
					entityId: log.id,
					at: at('19:00'),
					payload: { ...done, weight: 40 }
				})
			]);
			expect(await row(db, data.owner, weekOf(12))).toMatchObject({
				written: true,
				tonnage: before + 400
			});

			await sync([
				createMutation('set.delete', { workoutId, entityId: log.id, at: at('19:05'), payload: {} })
			]);
			expect(await row(db, data.owner, weekOf(12))).toMatchObject({
				written: true,
				tonnage: before
			});
			expect(
				(await rows(db, data.owner)).filter(
					(r) => r.week >= WEEK_ONE && r.week < weekOf(17) && !r.written
				)
			).toEqual([]);
		});
	});

	it('writes nothing before the first activity or for the week in progress, and nothing twice', async () => {
		await withRollback(async (db) => {
			const data = await seeded(db);
			expect(await refreshStrengthWeeks(db, data.owner, NOW)).toBe(0);
			expect(await refreshStrengthWeeks(db, data.other, atLocal(WEEK_ONE, '12:00', TZ))).toBe(0);
			const written = (await rows(db, data.owner)).filter((r) => r.written).map((r) => r.week);
			expect(written).toEqual(Array.from({ length: CLOSED }, (_, i) => weekOf(i + 1)));
			const later = await createStrengthWeeksRepository(db).rows(
				data.owner,
				weekOf(17),
				weekOf(30)
			);
			expect(later.filter((r) => r.writtenAt !== null)).toEqual([]);
		});
	});
});
