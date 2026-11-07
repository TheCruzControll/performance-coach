/**
 * The M6 dashboard fixtures (src/lib/server/test-support/analytics-fixtures) on real Postgres:
 * what each one stores, counted in SQL; that it holds on any weekday; that a seed is repeatable
 * and replaces what was there once reset; that it is fast enough for every spec to seed its
 * own; and that its route is closed unless test routes are enabled.
 *
 * Dates are counted from the owner's today in Los Angeles. The seeds run inside the test's
 * transaction, so the integration setup also proves they send one query at a time.
 */
import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import type { Executor } from '../../../src/lib/server/db';
import * as profileSchema from '../../../src/lib/server/db/schema/profile';
import { resetEnvCache } from '../../../src/lib/server/env';
import {
	AnalyticsSeedConflictError,
	FIXTURES,
	seedAnalyticsFixture
} from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { POST } from '../../../src/routes/api/test-support/analytics/+server';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
/** A Monday, a Wednesday and a Sunday of one week (Pacific Standard Time). */
const MONDAY = '2026-11-16';
const WEDNESDAY = '2026-11-18';
const SUNDAY = '2026-11-22';
/** Sessions each weekday has logged before it in the current week: Mon A; Tue run, class; … */
const DONE_BEFORE: Record<string, number> = { [MONDAY]: 0, [WEDNESDAY]: 3, [SUNDAY]: 6 };

const seed = (db: Executor, owner: string, fixture: string, today = WEDNESDAY) =>
	seedAnalyticsFixture(owner, fixture, { timeZone: TZ, now: atLocal(today, '12:00', TZ) }, { db });

/** One number from SQL. */
async function count(db: Executor, query: ReturnType<typeof sql>): Promise<number> {
	const { rows } = await db.execute<{ n: number }>(query);
	return Number(rows[0]!.n);
}

/** Completed, undeleted workouts by the Monday of their local week. */
async function completedByWeek(db: Executor, owner: string): Promise<Record<string, number>> {
	const { rows } = await db.execute<{ week: string; n: number }>(
		sql`select to_char(date_trunc('week', (started_at at time zone ${TZ})::date), 'YYYY-MM-DD') as week,
				count(*)::int as n
			from workouts where owner_id = ${owner} and status = 'completed' and deleted_at is null
			group by 1 order by 1`
	);
	return Object.fromEntries(rows.map((r) => [r.week, r.n]));
}

/** Everything a fixture logged, without ids or timestamps of writing: equal for equal seeds. */
async function content(db: Executor, owner: string) {
	const { rows } = await db.execute(
		sql`select w.title, w.status, w.deleted_at is not null as deleted, w.started_at, w.duration_s,
				w.session_rpe, w.planned_session_id is not null as planned,
				(select json_agg(json_build_array(s.weight, s.reps, s.rpe, s.is_warmup, s.performed_at)
					order by s.performed_at) from set_records s where s.workout_id = w.id) as sets,
				r.distance_m, r.duration_s as run_s, r.avg_hr, o.metrics
			from workouts w
			left join run_records r on r.workout_id = w.id
			left join other_session_records o on o.workout_id = w.id
			where w.owner_id = ${owner} order by w.started_at, w.title`
	);
	return rows;
}

/** As e2e/analytics-support.ts resetAnalytics: every M3+ root (TRUNCATE, test code only) and
 * the owner's profile rows. */
async function reset(db: Executor, owner: string) {
	await db.execute(
		sql`truncate programs, workouts, recovery_notes, training_audit, coach_proposals,
			weekly_reviews, cycle_reviews cascade`
	);
	for (const table of Object.values(profileSchema)) {
		if (!is(table, PgTable)) continue;
		await db.execute(
			sql`delete from ${sql.identifier(getTableName(table))} where owner_id = ${owner}`
		);
	}
}

describe('what each fixture holds', () => {
	it('lists every fixture this slice adds', () => {
		expect(Object.keys(FIXTURES)).toEqual(
			expect.arrayContaining(['new-user', 'first-week', 'twelve-weeks'])
		);
	});

	it('new-user: the basics only, with no program and nothing logged', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const seeded = await seed(db, owner, 'new-user');
			expect(seeded).toMatchObject({ today: WEDNESDAY, weekStart: MONDAY, programId: null });
			expect(
				await count(db, sql`select count(*) as n from programs where owner_id = ${owner}`)
			).toBe(0);
			expect(
				await count(db, sql`select count(*) as n from workouts where owner_id = ${owner}`)
			).toBe(0);
			const { rows } = await db.execute(
				sql`select time_zone, weight_unit, distance_unit from athlete_profiles where owner_id = ${owner}`
			);
			expect(rows).toEqual([{ time_zone: TZ, weight_unit: 'kg', distance_unit: 'km' }]);
		});
	});

	it('first-week: a program from this Monday, logged as planned up to yesterday', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const seeded = await seed(db, owner, 'first-week');
			expect(seeded.historyStart).toBe(MONDAY);
			const { rows } = await db.execute(
				sql`select to_char(pv.starts_on, 'YYYY-MM-DD') as starts_on, pv.generator is not null as generated,
						pv.input_snapshot is not null as snapshot
					from programs p join program_versions pv on pv.program_id = p.id where p.owner_id = ${owner}`
			);
			expect(rows).toEqual([{ starts_on: MONDAY, generated: true, snapshot: true }]);
			expect(await completedByWeek(db, owner)).toEqual({ [MONDAY]: 3 });
		});
	});

	it('twelve-weeks: the history its header describes', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const seeded = await seed(db, owner, 'twelve-weeks');
			const start = addDays(MONDAY, -84);
			expect(seeded.historyStart).toBe(start);
			const q = (query: ReturnType<typeof sql>) => count(db, query);
			const mine = sql`owner_id = ${owner}`;

			// The program: v1 from the plan with its stored input, v2 the skip, v3 the move.
			expect(
				await q(sql`select count(*) as n from program_versions pv join programs p on p.id = pv.program_id
					where p.owner_id = ${owner} and (pv.number = 1) = (pv.input_snapshot is not null)`)
			).toBe(3);
			const status = (s: string) =>
				q(sql`select count(*) as n from programs p
					join program_version_weeks vw on vw.version_id = p.current_version_id
					join planned_sessions s on s.week_id = vw.week_id
					where p.owner_id = ${owner} and s.status = ${s}`);
			expect(await status('skipped')).toBe(1);
			expect(await status('moved')).toBe(1);
			expect(await status('planned')).toBe(14 * 6 - 2);

			// Six sessions a week, but one skipped (week 6), an extra run (week 9), and week 10's
			// Strength B abandoned; this week's Monday and Tuesday by Wednesday.
			const weeks = await completedByWeek(db, owner);
			const expected = Object.fromEntries(
				Array.from({ length: 12 }, (_, i) => [
					addDays(start, 7 * i),
					[5, 8, 9].includes(i) ? (i === 8 ? 7 : 5) : 6
				])
			);
			expect(weeks).toEqual({ ...expected, [MONDAY]: 3 });

			// The three discarded workouts, each with live sets; and the off-plan run.
			const live = (w: string) =>
				q(
					sql`select count(*) as n from set_records where workout_id = ${w} and deleted_at is null`
				);
			const { abandoned, deleted, inProgress, offPlan } = seeded.workouts;
			expect(await live(abandoned!)).toBe(2);
			expect(await live(deleted!)).toBe(3);
			expect(await live(inProgress!)).toBe(2);
			const { rows } = await db.execute(
				sql`select status, deleted_at is not null as deleted, planned_session_id is null as off_plan
					from workouts where id in (${abandoned}, ${deleted}, ${inProgress}, ${offPlan}) order by started_at`
			);
			expect(rows).toEqual([
				{ status: 'completed', deleted: false, off_plan: true },
				{ status: 'abandoned', deleted: false, off_plan: false },
				{ status: 'completed', deleted: true, off_plan: true },
				{ status: 'in_progress', deleted: false, off_plan: true }
			]);

			// Runs: three a planned week less the skipped tempo, plus the off-plan run and this
			// Tuesday's intervals; heart rate on the long runs from week 5 and the intervals and
			// tempo runs from week 9. Muay Thai with rounds every week.
			expect(await q(sql`select count(*) as n from run_records where ${mine}`)).toBe(
				36 - 1 + 1 + 1
			);
			expect(
				await q(sql`select count(*) as n from run_records where ${mine} and avg_hr is not null`)
			).toBe(8 + 5 + 4);
			expect(
				await q(
					sql`select count(*) as n from run_record_segments where ${mine} and kind = 'interval'`
				)
			).toBe(13 * 4);
			expect(
				await q(sql`select count(*) as n from other_session_records where ${mine}
					and metrics @> '[{"key": "rounds"}]'`)
			).toBe(13);
			// Recovery notes, the race result and a measured bench on the profile.
			expect(await q(sql`select count(*) as n from recovery_notes where ${mine}`)).toBe(12);
			expect(await q(sql`select count(*) as n from race_results where ${mine}`)).toBe(1);
			expect(
				await q(sql`select count(*) as n from strength_baselines where ${mine}
					and lift = 'bench_press' and kind = 'measured' and superseded_at is null`)
			).toBe(1);
			// Every set was linked to its planned exercise when it had one.
			expect(
				await q(sql`select count(*) as n from set_records s join workouts w on w.id = s.workout_id
					where s.owner_id = ${owner} and (w.planned_session_id is null) <> (s.planned_exercise_lineage_id is null)`)
			).toBe(0);
		});
	});
});

describe('any weekday', () => {
	const cases = ['new-user', 'first-week', 'twelve-weeks'].flatMap((fixture) =>
		[MONDAY, WEDNESDAY, SUNDAY].map((today) => [fixture, today] as const)
	);
	it.each(cases)('%s holds with today forced to %s', async (fixture, today) => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const now = atLocal(today, '12:00', TZ);
			const seeded = await seed(db, owner, fixture, today);
			expect(seeded).toMatchObject({ today, weekStart: MONDAY });
			// This week: only what was planned before today; nothing after now.
			const weeks = await completedByWeek(db, owner);
			const done = fixture === 'new-user' ? 0 : DONE_BEFORE[today];
			expect(weeks[MONDAY] ?? 0).toBe(done);
			const after = (table: string, column: string) =>
				count(
					db,
					sql`select count(*) as n from ${sql.identifier(table)}
						where owner_id = ${owner} and ${sql.identifier(column)} > ${now}`
				);
			expect(await after('workouts', 'started_at')).toBe(0);
			expect(await after('workouts', 'finished_at')).toBe(0);
			expect(await after('set_records', 'performed_at')).toBe(0);
			const history = Object.keys(weeks).filter((week) => week < MONDAY);
			expect(history).toHaveLength(fixture === 'twelve-weeks' ? 12 : 0);
		});
	});
});

describe('seeding again', () => {
	it('is refused on top of training data, and repeats exactly once reset', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner, 'twelve-weeks');
			const first = await content(db, owner);
			expect(first.length).toBeGreaterThan(70);

			await expect(seed(db, owner, 'first-week')).rejects.toBeInstanceOf(
				AnalyticsSeedConflictError
			);
			expect(await content(db, owner)).toEqual(first);

			await reset(db, owner);
			const again = await seed(db, owner, 'twelve-weeks');
			expect(again.today).toBe(WEDNESDAY);
			expect(await content(db, owner)).toEqual(first);
		});
	});

	it('replaces the earlier history and profile once reset', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner, 'twelve-weeks');
			await reset(db, owner);
			await seed(db, owner, 'new-user', SUNDAY);
			const q = (table: string) =>
				count(
					db,
					sql`select count(*) as n from ${sql.identifier(table)} where owner_id = ${owner}`
				);
			for (const table of ['programs', 'workouts', 'set_records', 'recovery_notes']) {
				expect(await q(table), table).toBe(0);
			}
			for (const table of ['strength_baselines', 'race_results', 'training_goals']) {
				expect(await q(table), table).toBe(0);
			}
		});
	});
});

describe('speed', () => {
	it.each(['new-user', 'first-week', 'twelve-weeks'])('seeds %s in under 3 s', async (fixture) => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const started = performance.now();
			await seed(db, owner, fixture, SUNDAY);
			expect(performance.now() - started).toBeLessThan(3000);
		});
	});
});

describe('/api/test-support/analytics', () => {
	const before = process.env.ENABLE_TEST_ROUTES;
	afterEach(() => {
		if (before === undefined) delete process.env.ENABLE_TEST_ROUTES;
		else process.env.ENABLE_TEST_ROUTES = before;
		resetEnvCache();
	});

	it('is a 404 without ENABLE_TEST_ROUTES, before it reads the request or the session', async () => {
		process.env.ENABLE_TEST_ROUTES = 'false';
		resetEnvCache();
		const event = {
			locals: {},
			request: new Request('http://localhost/api/test-support/analytics', {
				method: 'POST',
				body: JSON.stringify({ fixture: 'twelve-weeks', timeZone: TZ })
			})
		};
		await expect(POST(event as never)).rejects.toMatchObject({ status: 404 });
	});
});
