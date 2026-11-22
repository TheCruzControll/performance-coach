/**
 * Today's 'This week' (src/lib/server/services/analytics/week.ts, and the route's fail-soft
 * week.server.ts) on the M6 dataset: sessions, training load and distance from Monday through
 * today against the same days of last week, as independent SQL over completed, undeleted
 * workouts counts them, and exactly as the General and Running views' 'this week so far' lines
 * do, so Today and Progress never disagree. An owner with nothing logged reads logged: false; an
 * unreachable database resolves to {failed: true} with the failure recorded.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import type { Executor } from '../../../src/lib/server/db';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import { getGeneralDashboard } from '../../../src/lib/server/services/analytics/general';
import { getRunningDashboard } from '../../../src/lib/server/services/analytics/running';
import { getWeekSoFar } from '../../../src/lib/server/services/analytics/week';
import { loadTodayWeek } from '../../../src/routes/(app)/today/week.server';
import { unreachableDb, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { seedDataset, TODAY, TZ, weekOf } from './fixtures/dataset';

/** Wednesday of week 16: Monday to Wednesday against week 15's. */
const MIDWEEK = addDays(weekOf(16), 2);

/** Counted workouts on the owner's days `from`–`to`: how many, and their minutes × RPE. */
async function counted(db: Executor, owner: string, from: string, to: string) {
	const { rows } = await db.execute<{ sessions: number; load: number | null }>(sql`
		select count(*)::int as sessions,
			sum(coalesce(w.duration_s, r.duration_s, o.duration_minutes * 60)::float8 / 60
				* coalesce(w.session_rpe, r.rpe, o.rpe)::float8)::float8 as load
		from workouts w
		left join run_records r on r.workout_id = w.id
		left join other_session_records o on o.workout_id = w.id
		where w.owner_id = ${owner} and w.status = 'completed' and w.deleted_at is null
			and (w.started_at at time zone ${TZ})::date between ${from}::date and ${to}::date`);
	return rows[0]!;
}

const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/today',
	routeId: '/(app)/today',
	appVersion: '0.1.0+test'
});

describe('the week so far', () => {
	it('counts Monday to today against the same days last week, as SQL and Progress do', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const week = await getWeekSoFar(data.owner, { today: MIDWEEK }, { db });
			expect(week.week).toEqual({ weekStart: weekOf(16), through: MIDWEEK, days: 3 });
			expect(week.lastWeek).toEqual({ from: weekOf(15), through: addDays(MIDWEEK, -7), days: 3 });
			expect(week.logged).toBe(true);

			const now = await counted(db, data.owner, weekOf(16), MIDWEEK);
			const before = await counted(db, data.owner, weekOf(15), addDays(MIDWEEK, -7));
			// Strength A, intervals, Muay Thai and Strength B each week.
			expect(now.sessions).toBe(4);
			expect(week.sessions).toMatchObject({ value: now.sessions, lastWeek: before.sessions });
			expect(week.load.value).toBeCloseTo(now.load!, 6);
			expect(week.load.lastWeek).toBeCloseTo(before.load!, 6);
			expect(week.distance.value).toBeGreaterThan(0);

			// The dashboards' own week-so-far lines, on the same day.
			const query = { period: '4w', today: MIDWEEK } as const;
			const general = await getGeneralDashboard(db, data.owner, query);
			const running = await getRunningDashboard(db, data.owner, query);
			const line = (so: { value: number | null; lastWeek: number | null } | null) => ({
				value: so?.value,
				lastWeek: so?.lastWeek
			});
			expect(line(week.sessions)).toEqual(line(general.figures.sessions.soFar));
			expect(line(week.load)).toEqual(line(general.figures.srpe_load.soFar));
			expect(line(week.distance)).toEqual(line(running.mileage.soFar));
		});
	});

	it('reads an empty week as nothing yet once there is a history, and logged only after it', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			// The dataset ends with week 16: week 17 is empty, week 16's same days were not.
			const empty = await getWeekSoFar(data.owner, { today: TODAY }, { db });
			expect(empty.logged).toBe(true);
			expect(empty.sessions.value).toBeNull();
			expect(empty.sessions.lastWeek).toBe(4);

			const fresh = await makeOwner(db, 'New owner');
			const none = await getWeekSoFar(fresh, { today: TODAY }, { db });
			expect(none.logged).toBe(false);
			expect([none.sessions.value, none.load.value, none.distance.value]).toEqual([
				null,
				null,
				null
			]);
		});
	});

	it('Today’s load composes the tiles in words, and never rejects', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const view = await loadTodayWeek(
				data.owner,
				{ today: TODAY, origin: origin() },
				{ db, errorsDb: db }
			);
			expect(view).toMatchObject({
				failed: false,
				tiles: [
					{ id: 'sessions', value: '0' },
					{ id: 'load', value: '0' },
					{ id: 'distance', value: '0', unit: 'km' }
				]
			});
			if (view.failed) throw new Error('the week failed to load');
			expect(view.against).toMatch(/^By Wednesday last week: 4 sessions, training load [\d,]+, /);
		});

		const broken = unreachableDb();
		try {
			await withRollback(async (tx) => {
				const request = origin();
				const view = await loadTodayWeek(
					crypto.randomUUID(),
					{ today: TODAY, origin: request },
					{ db: broken.db, errorsDb: tx }
				);
				expect(view).toEqual({ failed: true });
				const recorded = await findErrorsByRequestId(request.requestId, { db: tx });
				expect(recorded).toHaveLength(1);
				expect(recorded[0]).toMatchObject({ kind: 'streamed', context: { load: 'todayWeek' } });
			});
		} finally {
			await broken.close();
		}
	});
});
