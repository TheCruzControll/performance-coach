/**
 * The review fixtures (src/lib/server/test-support/analytics-fixtures/reviews.ts) on real
 * Postgres: each scenario holds what its header claims, counted in SQL, with today forced to a
 * Monday, a Wednesday and a Sunday; a seed repeats exactly once reset and is refused on top of
 * training data; and each seeds in under 3 s.
 *
 * Dates are counted from the owner's today in Los Angeles. The seeds run inside the test's
 * transaction, so the integration setup also proves they send one query at a time.
 */
import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { addDays, daysBetween } from '../../../src/lib/domain/calendar';
import type { Executor } from '../../../src/lib/server/db';
import * as profileSchema from '../../../src/lib/server/db/schema/profile';
import {
	AnalyticsSeedConflictError,
	FIXTURES,
	seedAnalyticsFixture
} from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import type { ReviewFixtureResult } from '../../../src/lib/server/test-support/analytics-fixtures/reviews';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
/** A Monday, a Wednesday and a Sunday of one week (Pacific Standard Time). */
const MONDAY = '2026-11-16';
const WEDNESDAY = '2026-11-18';
const SUNDAY = '2026-11-22';
const DAYS = [MONDAY, WEDNESDAY, SUNDAY] as const;
const SCENARIOS = [
	'week-almost-complete',
	'week-complete',
	'week-late',
	'next-week-deload',
	'block-end',
	'block-end-late'
] as const;
type Scenario = (typeof SCENARIOS)[number];

type Seeded = ReviewFixtureResult & { today: string; weekStart: string };

const nowOn = (today: string) => atLocal(today, '12:00', TZ);
const seed = async (db: Executor, owner: string, fixture: string, today: string) =>
	(await seedAnalyticsFixture(
		owner,
		fixture,
		{ timeZone: TZ, now: nowOn(today) },
		{ db }
	)) as unknown as Seeded;

type Session = {
	day: string;
	title: string;
	lineage: string;
	order: number;
	weekKind: string;
	block: string;
	logged: boolean;
};

/** The current version's planned sessions, by day, each with whether a completed, undeleted
 * workout carries its lineage. */
async function sessions(db: Executor, owner: string): Promise<Session[]> {
	const { rows } = await db.execute<Session>(
		sql`select to_char(s.scheduled_on, 'YYYY-MM-DD') as day, s.title, s.lineage_id::text as lineage,
				s.order_in_day as order, w.kind as "weekKind", b.name as block,
				exists (select 1 from workouts x where x.planned_lineage_id = s.lineage_id
					and x.status = 'completed' and x.deleted_at is null) as logged
			from programs p
			join program_version_weeks vw on vw.version_id = p.current_version_id
			join program_weeks w on w.id = vw.week_id
			join program_blocks b on b.id = w.block_id
			join planned_sessions s on s.week_id = w.id
			where p.owner_id = ${owner} order by s.scheduled_on, s.order_in_day`
	);
	return rows;
}

/** The current version's blocks, in order. */
async function blocks(db: Executor, owner: string) {
	const { rows } = await db.execute<{
		name: string;
		lineage: string;
		startsOn: string;
		endsOn: string;
		outline: boolean;
		weeks: number;
	}>(
		sql`select b.name, b.lineage_id::text as lineage, to_char(b.starts_on, 'YYYY-MM-DD') as "startsOn",
				to_char(b.ends_on, 'YYYY-MM-DD') as "endsOn", b.outline,
				(select count(*)::int from program_weeks w join program_version_weeks vw on vw.week_id = w.id
					where w.block_id = b.id and vw.version_id = p.current_version_id) as weeks
			from programs p
			join program_version_blocks vb on vb.version_id = p.current_version_id
			join program_blocks b on b.id = vb.block_id
			where p.owner_id = ${owner} order by b.starts_on`
	);
	return rows;
}

/** Bench working sets as logged, with their prescribed RPE, by the local day of the workout. */
async function benchSets(db: Executor, owner: string) {
	const { rows } = await db.execute<{ day: string; workout: string; rpe: number; target: number }>(
		sql`select to_char((w.started_at at time zone ${TZ})::date, 'YYYY-MM-DD') as day,
				w.id::text as workout, s.rpe::float8 as rpe, ps.target_rpe::float8 as target
			from set_records s
			join workouts w on w.id = s.workout_id
			join exercises e on e.id = s.exercise_id
			join planned_exercises pe on pe.lineage_id = s.planned_exercise_lineage_id
				and pe.session_id = w.planned_session_id
			join set_prescriptions ps on ps.planned_exercise_id = pe.id
			where s.owner_id = ${owner} and e.key = 'bench_press' and s.deleted_at is null`
	);
	return rows;
}

/** A workout's local day, session RPE and what its Muay Thai record holds. */
async function workout(db: Executor, id: string) {
	const { rows } = await db.execute<{ day: string; rpe: number; title: string; metrics: unknown }>(
		sql`select to_char((w.started_at at time zone ${TZ})::date, 'YYYY-MM-DD') as day,
				w.session_rpe::float8 as rpe, w.title, o.metrics
			from workouts w left join other_session_records o on o.workout_id = w.id where w.id = ${id}`
	);
	return rows[0]!;
}

const inWeek = (monday: string) => (s: Session) => s.day >= monday && s.day <= addDays(monday, 6);

/** The hard week: bench at RPE 7 against 8 in its two strength sessions, 8 elsewhere; sparring at
 * RPE 9 (6 rounds) on its Friday, and the long run the next day. */
async function holdsHardWeek(db: Executor, owner: string, seeded: Seeded, monday: string) {
	const bench = await benchSets(db, owner);
	const hard = bench.filter((s) => s.day >= monday && s.day <= addDays(monday, 6));
	expect(hard).toHaveLength(6);
	expect(new Set(hard.map((s) => s.workout)).size).toBe(2);
	expect(hard.every((s) => s.rpe === 7 && s.target === 8)).toBe(true);
	expect(bench.filter((s) => !hard.includes(s)).every((s) => s.rpe === s.target)).toBe(true);
	const sparring = await workout(db, seeded.workouts.sparring!);
	const longRun = await workout(db, seeded.workouts.longRun!);
	expect(sparring).toMatchObject({ day: addDays(monday, 4), rpe: 9, title: 'Sparring' });
	expect(sparring.metrics).toEqual([
		{ key: 'sparring_rounds', label: 'Sparring rounds', unit: null, value: 6 }
	]);
	expect(longRun).toMatchObject({ day: addDays(monday, 5), title: 'Long run' });
}

/** What each scenario claims, for any `today` in the week of MONDAY. */
const CLAIMS: Record<
	Scenario,
	(db: Executor, owner: string, seeded: Seeded, today: string) => Promise<void>
> = {
	'week-almost-complete': async (db, owner, seeded, today) => {
		expect(seeded.review).toEqual({
			kind: 'weekly',
			weekStartsOn: MONDAY,
			nextWeekStartsOn: addDays(MONDAY, 7)
		});
		const week = (await sessions(db, owner)).filter(inWeek(MONDAY));
		expect(week.every((s) => s.day <= today)).toBe(true);
		const todays = week.filter((s) => s.day === today);
		expect(todays.map((s) => [s.title, s.logged])).toEqual([
			['Strength C', true],
			['Easy run', false]
		]);
		expect(week.filter((s) => !s.logged).map((s) => s.lineage)).toEqual([seeded.lineages.pending]);
		expect((await blocks(db, owner)).at(-1)).toMatchObject({
			outline: true,
			startsOn: addDays(MONDAY, 7)
		});
	},
	'week-complete': async (db, owner, seeded, today) => {
		const reviewed = addDays(MONDAY, -7);
		expect(seeded.review).toEqual({
			kind: 'weekly',
			weekStartsOn: reviewed,
			nextWeekStartsOn: MONDAY
		});
		const all = await sessions(db, owner);
		const week = all.filter(inWeek(reviewed));
		expect(week).toHaveLength(6);
		expect(week.every((s) => s.logged)).toBe(true);
		await holdsHardWeek(db, owner, seeded, reviewed);
		// Next week (this one) is planned in full: none of it from today on is logged yet.
		const next = all.filter(inWeek(MONDAY));
		expect(next).toHaveLength(6);
		expect(next.every((s) => s.weekKind === 'accumulation')).toBe(true);
		expect(next.filter((s) => s.day >= today).every((s) => !s.logged)).toBe(true);
	},
	'week-late': async (db, owner, seeded, today) => {
		const reviewed = addDays(MONDAY, -14);
		expect(seeded.review).toEqual({
			kind: 'weekly',
			weekStartsOn: reviewed,
			nextWeekStartsOn: addDays(MONDAY, -7)
		});
		const ago = daysBetween(addDays(reviewed, 6), today);
		expect(ago).toBeGreaterThanOrEqual(8);
		expect(ago).toBeLessThanOrEqual(14);
		const all = await sessions(db, owner);
		expect(all.filter(inWeek(reviewed)).every((s) => s.logged)).toBe(true);
		expect(all.filter(inWeek(addDays(MONDAY, -7))).every((s) => s.logged)).toBe(true);
		await holdsHardWeek(db, owner, seeded, reviewed);
	},
	'next-week-deload': async (db, owner, seeded) => {
		expect(seeded.review).toMatchObject({ weekStartsOn: addDays(MONDAY, -7) });
		const all = await sessions(db, owner);
		expect(new Set(all.filter(inWeek(MONDAY)).map((s) => s.weekKind))).toEqual(new Set(['deload']));
		expect(new Set(all.filter(inWeek(addDays(MONDAY, -7))).map((s) => s.weekKind))).toEqual(
			new Set(['accumulation'])
		);
		await holdsHardWeek(db, owner, seeded, addDays(MONDAY, -7));
	},
	'block-end': async (db, owner, seeded, today) => {
		const [base, outline, ...rest] = await blocks(db, owner);
		expect(rest).toEqual([]);
		expect(base).toMatchObject({
			name: 'Base',
			startsOn: addDays(MONDAY, -21),
			endsOn: addDays(MONDAY, 6),
			outline: false,
			weeks: 4
		});
		expect(outline).toMatchObject({ startsOn: addDays(MONDAY, 7), outline: true, weeks: 4 });
		expect(seeded.review).toEqual({
			kind: 'cycle',
			blockLineageId: base!.lineage,
			blockStartsOn: base!.startsOn,
			blockEndsOn: base!.endsOn
		});
		const all = await sessions(db, owner);
		expect(all.every((s) => s.block === 'Base' && s.logged && s.day <= today)).toBe(true);
		expect(all.filter((s) => s.day === today).map((s) => s.title)).toEqual([
			'Strength C',
			'Easy run'
		]);
	},
	'block-end-late': async (db, owner, seeded) => {
		const all = await blocks(db, owner);
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ startsOn: addDays(MONDAY, -42), endsOn: addDays(SUNDAY, -21) });
		expect(seeded.review).toEqual({
			kind: 'cycle',
			blockLineageId: all[0]!.lineage,
			blockStartsOn: addDays(MONDAY, -42),
			blockEndsOn: addDays(SUNDAY, -21)
		});
		const planned = await sessions(db, owner);
		expect(planned).toHaveLength(24);
		expect(planned.every((s) => s.logged)).toBe(true);
	}
};

/** Everything a fixture logged, without ids or timestamps of writing: equal for equal seeds. */
async function content(db: Executor, owner: string) {
	const { rows } = await db.execute(
		sql`select w.title, w.status, w.started_at, w.finished_at, w.duration_s, w.session_rpe,
				(select json_agg(json_build_array(s.weight, s.reps, s.rpe, s.performed_at)
					order by s.performed_at) from set_records s where s.workout_id = w.id) as sets,
				r.distance_m, r.duration_s as run_s, o.metrics
			from workouts w
			left join run_records r on r.workout_id = w.id
			left join other_session_records o on o.workout_id = w.id
			where w.owner_id = ${owner} order by w.started_at, w.title`
	);
	return rows;
}

/** As e2e/review-support.ts resetReviews: every M3+ root (TRUNCATE, test code only) and the
 * owner's profile rows. */
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

describe('the review fixtures', () => {
	it('are all in the analytics registry', () => {
		expect(Object.keys(FIXTURES)).toEqual(expect.arrayContaining([...SCENARIOS]));
	});

	const cases = SCENARIOS.flatMap((scenario) => DAYS.map((today) => [scenario, today] as const));
	it.each(cases)('%s holds what it claims with today forced to %s', async (scenario, today) => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const seeded = await seed(db, owner, scenario, today);
			expect(seeded).toMatchObject({ today, weekStart: MONDAY, fixture: scenario });
			// Everything planned before today is logged, and nothing is logged after now.
			const all = await sessions(db, owner);
			expect(all.filter((s) => s.day < today && !s.logged)).toEqual([]);
			const { rows } = await db.execute<{ n: number }>(
				sql`select count(*)::int as n from workouts
					where owner_id = ${owner} and (started_at > ${nowOn(today)} or finished_at > ${nowOn(today)})`
			);
			expect(rows[0]!.n).toBe(0);
			await CLAIMS[scenario](db, owner, seeded, today);
		});
	});
});

describe('seeding again', () => {
	it.each(SCENARIOS)('%s repeats exactly once reset, and is refused on top', async (scenario) => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner, scenario, WEDNESDAY);
			const first = await content(db, owner);
			expect(first.length).toBeGreaterThan(10);

			await expect(seed(db, owner, scenario, WEDNESDAY)).rejects.toBeInstanceOf(
				AnalyticsSeedConflictError
			);
			expect(await content(db, owner)).toEqual(first);

			await reset(db, owner);
			await seed(db, owner, scenario, WEDNESDAY);
			expect(await content(db, owner)).toEqual(first);
		});
	});
});

describe('speed', () => {
	it.each(SCENARIOS)('seeds %s in under 3 s', async (scenario) => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const started = performance.now();
			await seed(db, owner, scenario, SUNDAY);
			expect(performance.now() - started).toBeLessThan(3000);
		});
	});
});
