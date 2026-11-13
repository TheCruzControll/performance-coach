/**
 * The evaluation context (services/periodisation/context.ts) on real Postgres:
 * - its logged load, through M6's facts, for the twelve-weeks history logged through M3's
 *   services: each day's total equals a SQL oracle and M6's dailyLoads, with abandoned,
 *   in-progress, soft-deleted and another owner's workouts left out; a custom exercise's traits
 *   come from the owner's library; a session planned before today and never logged is named missed
 * - its range is capped at 49 days, its facts are read once per request, and a caller's facts
 *   loader adds no fact query
 * - a stalled read, under the one-query guard: on the pool Postgres cancels it at the statement
 *   timeout and the connection is released; inside a caller's transaction the savepoint ends it
 *   and the transaction carries on to its commit
 * - on Train: a hard sparring session logged on Monday makes Tuesday's heavy squats a
 *   residual-fatigue finding with the scheduler's fix, and a failing facts read is recorded while
 *   the week still renders with checkWeek's findings
 */
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { dailyLoads, sessionLoads } from '../../../src/lib/domain/analytics/workload';
import { addDays } from '../../../src/lib/domain/calendar';
import { getDb, type Executor } from '../../../src/lib/server/db';
import {
	createAnalyticsRepository,
	type AnalyticsRepository
} from '../../../src/lib/server/db/repositories/analytics';
import { createProgramsRepository } from '../../../src/lib/server/db/repositories/programs';
import { createFactsLoader } from '../../../src/lib/server/services/analytics/facts';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import { createCustomExercise } from '../../../src/lib/server/services/exercises/index';
import {
	createContextCache,
	evaluationContext,
	HISTORY_DAYS,
	type ContextReader
} from '../../../src/lib/server/services/periodisation/context';
import { getAthleteProfile } from '../../../src/lib/server/services/profile/index';
import { createProgramFromPlan } from '../../../src/lib/server/services/programs/index';
import {
	finishWorkout,
	logOtherSession,
	logSet,
	startWorkout
} from '../../../src/lib/server/services/training/log';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import {
	FIXTURE_WEEKS,
	type PeriodisationWeekResult
} from '../../../src/lib/server/test-support/analytics-fixtures/periodisation-week';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { loadTrainWeek } from '../../../src/routes/(app)/train/week.server';
import { takeOverlaps } from '../one-query-per-client';
import { withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';

/** Wednesday 11 November 2026, noon, on UTC: this week starts Monday 9 November. */
const NOW = new Date('2026-11-11T12:00:00Z');
const TODAY = '2026-11-11';
const MONDAY = '2026-11-09';
const FROM = addDays(MONDAY, -HISTORY_DAYS);
/** Real-data reads on a loaded CI runner: far above the 300 ms default, which the stalls test. */
const SLOW_OK = 10_000;

const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/train',
	routeId: '/(app)/train',
	appVersion: '0.1.0+test'
});

/** An owner whose profile row exists, as it does for anyone with a program (the build reads it). */
async function ownerWithProfile(db: Executor) {
	const owner = await makeOwner(db);
	await getAthleteProfile(owner, { db });
	return owner;
}

/** The id of the owner's current version, as getWeekEvaluation reads it. */
async function versionId(db: Executor, owner: string) {
	return (await createProgramsRepository(db).currentProgram(owner))!.version.id;
}

/** The analytics reads on `db`, each call counted by name. */
function counted(db: Executor) {
	const calls: Record<string, number> = {};
	const ranges: { start: Date; end: Date }[] = [];
	const real = createAnalyticsRepository(db);
	const repository = new Proxy(real, {
		get(target, key: string) {
			const value = Reflect.get(target, key) as unknown;
			if (typeof value !== 'function') return value;
			return (...args: unknown[]) => {
				calls[key] = (calls[key] ?? 0) + 1;
				if (key === 'sessions') ranges.push(args[1] as { start: Date; end: Date });
				return Reflect.apply(value, target, args);
			};
		}
	}) as AnalyticsRepository;
	const total = () => Object.values(calls).reduce((sum, n) => sum + n, 0);
	return { repository, calls, ranges, total };
}

/** A completed workout logged through M3's services, started at `at`. */
async function logged(
	db: Executor,
	owner: string,
	at: Date,
	what: { kind: 'strength' | 'other'; discipline: string; sessionType: string; title: string },
	finish: { durationSeconds: number; sessionRpe: number },
	during: (clientId: string) => Promise<unknown> = async () => undefined
) {
	const clientId = crypto.randomUUID();
	const { workout } = await startWorkout(
		owner,
		{ clientId, ...what, plannedSessionId: null, startedAt: at.toISOString() },
		{ db }
	);
	await during(clientId);
	const finishedAt = new Date(at.getTime() + finish.durationSeconds * 1000).toISOString();
	await finishWorkout(owner, clientId, { status: 'completed', finishedAt, ...finish }, { db });
	return workout.id;
}

async function twelveWeeks(db: Executor) {
	const owner = await makeOwner(db);
	const seeded = await seedAnalyticsFixture(
		owner,
		'twelve-weeks',
		{ timeZone: 'UTC', now: NOW },
		{ db }
	);
	return {
		owner,
		seeded,
		at: { versionId: await versionId(db, owner), weekStartsOn: MONDAY, today: TODAY }
	};
}

describe('the logged load', () => {
	it('each day’s total equals a SQL oracle and M6’s dailyLoads; discarded and other owners’ workouts never count', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, at } = await twelveWeeks(db);
			// Another owner's hard session yesterday.
			const other = await makeSecondOwner(db);
			const theirs = await logged(
				db,
				other,
				new Date('2026-11-10T07:00:00Z'),
				{ kind: 'other', discipline: 'muay_thai', sessionType: 'muay_thai', title: 'Theirs' },
				{ durationSeconds: 7200, sessionRpe: 10 }
			);

			const context = (await evaluationContext(owner, at, { db, statementTimeoutMs: SLOW_OK }))!;
			expect(context).not.toBeNull();
			const days = context.load.days.filter((d) => d.date <= TODAY);
			expect(days.map((d) => d.date)).toEqual(
				Array.from({ length: HISTORY_DAYS + 3 }, (_, i) => addDays(FROM, i))
			);

			// The oracle: completed, undeleted workouts of this owner, minutes × RPE as M6 reads them.
			const { rows } = await db.execute<{ day: string; load: number }>(sql`
				select to_char(w.started_at at time zone 'UTC', 'YYYY-MM-DD') as day,
					sum(coalesce(w.duration_s, r.duration_s, o.duration_minutes * 60) / 60.0
						* coalesce(w.session_rpe, r.rpe, o.rpe))::float8 as load
				from workouts w
				left join run_records r on r.workout_id = w.id
				left join other_session_records o on o.workout_id = w.id
				where w.owner_id = ${owner} and w.status = 'completed' and w.deleted_at is null
					and w.started_at >= ${FROM}::date and w.started_at < ${addDays(TODAY, 1)}::date
				group by 1`);
			const oracle = new Map(rows.map((r) => [r.day, r.load]));
			expect(oracle.size).toBeGreaterThan(10);
			for (const day of days) expect(day.total, day.date).toBeCloseTo(oracle.get(day.date) ?? 0, 6);

			const facts = createFactsLoader(db, owner, { from: FROM, to: TODAY, timeZone: 'UTC' });
			const m6 = dailyLoads(sessionLoads(await facts.sessions(), 'UTC'), FROM, TODAY);
			// M6 rounds its loads to six places (cleanFloat).
			days.forEach((d, i) => expect(d.total, d.date).toBeCloseTo(m6[i]!.load!, 6));

			const ids = context.load.logged.map((l) => l.workoutId);
			const { abandoned, deleted, inProgress } = seeded.workouts;
			expect(ids).not.toContain(abandoned);
			expect(ids).not.toContain(deleted);
			expect(ids).not.toContain(inProgress);
			expect(ids).not.toContain(theirs);
		});
	});

	it('a custom exercise’s traits come from the owner’s library', async () => {
		await withRollback(async (db) => {
			const owner = await ownerWithProfile(db);
			await createProgramFromPlan(
				owner,
				programFixture('one-week', { monday: MONDAY, today: TODAY }),
				{ source: 'rules' },
				{ db }
			);
			const squat = await createCustomExercise(
				owner,
				{
					name: 'Garage rack squat',
					pattern: 'squat',
					primaryMuscles: ['quads'],
					measure: 'reps',
					loadType: 'external',
					tags: ['compound']
				},
				{ db }
			);
			const at = new Date('2026-11-10T07:00:00Z');
			const workout = await logged(
				db,
				owner,
				at,
				{ kind: 'strength', discipline: 'strength', sessionType: 'strength', title: 'Garage' },
				{ durationSeconds: 3600, sessionRpe: 8 },
				async (workoutClientId) => {
					for (const setIndex of [1, 2, 3]) {
						await logSet(
							owner,
							{
								...{ clientMutationId: crypto.randomUUID(), workoutClientId },
								...{ exerciseId: squat.id, plannedExerciseLineageId: null },
								...{ exercisePosition: 1, setIndex, weight: 120, unit: 'kg', reps: 5 },
								...{ missedReps: 0, rpe: 8.5, seconds: null, metres: null },
								...{ isExtra: false, isSkipped: false, isWarmup: false },
								performedAt: new Date(at.getTime() + setIndex * 300_000).toISOString()
							},
							{ db }
						);
					}
				}
			);
			const context = (await evaluationContext(
				owner,
				{ versionId: await versionId(db, owner), weekStartsOn: MONDAY, today: TODAY },
				{ db, statementTimeoutMs: SLOW_OK }
			))!;
			expect(context.load.logged.find((l) => l.workoutId === workout)).toMatchObject({
				kind: 'strength',
				sets: { lower: { hard: 3, heavy: 3 }, upper: { hard: 0, heavy: 0 } }
			});
		});
	});
});

describe('the planned load', () => {
	it('reads the whole range: a session planned before today and never logged is named missed', async () => {
		await withRollback(async (db) => {
			const owner = await ownerWithProfile(db);
			const plan = programFixture('one-week', { monday: MONDAY, today: TODAY });
			const monday = plan.blocks[0]!.weeks[0]!.sessions.find((s) => s.date === MONDAY)!;
			await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const context = (await evaluationContext(
				owner,
				{ versionId: await versionId(db, owner), weekStartsOn: MONDAY, today: TODAY },
				{ db, statementTimeoutMs: SLOW_OK }
			))!;
			expect(context.load.days.find((d) => d.date === MONDAY)).toMatchObject({
				source: 'missed',
				missed: [monday.title]
			});
		});
	});
});

describe('reads', () => {
	it('cap the range, read the facts once per request, and reuse a caller’s loader', async () => {
		await withRollback(async (db) => {
			const { owner, at } = await twelveWeeks(db);
			const count = counted(db);
			const contexts = createContextCache(owner, {
				db,
				repository: count.repository,
				statementTimeoutMs: SLOW_OK
			});
			const first = await contexts.get(at);
			expect(first).not.toBeNull();
			// Read in a savepoint of this transaction, rolled back to: its settings went with it.
			const { rows } = await db.execute<{ timeout: string; readOnly: string }>(
				sql`select current_setting('statement_timeout') as timeout,
					current_setting('transaction_read_only') as "readOnly"`
			);
			expect(rows[0]).toEqual({ timeout: '0', readOnly: 'off' });
			expect(count.calls.sessions).toBe(1);
			const [range] = count.ranges;
			// 45 days through today, plus the time-zone slack either side: within the 49-day cap.
			const hours = (range!.end.getTime() - range!.start.getTime()) / 3_600_000;
			expect(hours).toBeLessThanOrEqual(49 * 24 + 28);
			expect(first!.load.days).toHaveLength(HISTORY_DAYS + 7);
			const reads = count.total();

			// The same week again: the same context, and no read at all.
			expect(await contexts.get(at)).toBe(first);
			expect(count.total()).toBe(reads);

			// A caller's loader, already read: the context adds no fact query.
			const mine = counted(db);
			const facts = createFactsLoader(
				db,
				owner,
				{ from: FROM, to: TODAY, timeZone: 'UTC' },
				{ repository: mine.repository }
			);
			await facts.sessions();
			await facts.sets();
			await facts.runs();
			const before = mine.total();
			const own = counted(db);
			const reused = await evaluationContext(owner, at, {
				db,
				facts,
				repository: own.repository,
				statementTimeoutMs: SLOW_OK
			});
			expect(mine.total()).toBe(before);
			expect(own.total()).toBe(0);
			expect(reused!.load.logged.map((l) => l.workoutId)).toEqual(
				first!.load.logged.map((l) => l.workoutId)
			);
		});
	});
});

describe('a stalled read', () => {
	const stall: ContextReader = async (db) => {
		await db.execute(sql`select pg_sleep(1)`);
		return null;
	};
	const AT = { versionId: crypto.randomUUID(), weekStartsOn: MONDAY, today: TODAY };
	const OWNER = '00000000-0000-4000-8000-000000000000';

	it('on the pool: Postgres cancels it, the context is null and recorded, and the connection is released', async () => {
		const db = getDb();
		const { requestId } = origin();
		try {
			const started = performance.now();
			const context = await evaluationContext(OWNER, AT, {
				db,
				reader: stall,
				origin: origin(requestId)
			});
			const elapsed = performance.now() - started;
			expect(context).toBeNull();
			// pg_sleep(1) would take a second: the 300 ms statement timeout ended it.
			expect(elapsed).toBeLessThan(900);
			const [row] = await findErrorsByRequestId(requestId, { db });
			expect(row?.context).toMatchObject({ part: 'evaluation-context', code: '57014' });
			const pool = (db as unknown as { $client: pg.Pool }).$client;
			expect(pool.waitingCount).toBe(0);
			expect(pool.idleCount).toBe(pool.totalCount);
			expect(takeOverlaps()).toEqual([]);
		} finally {
			await db.execute(sql`delete from app_errors where request_id = ${requestId}`);
		}
	});

	it('inside a transaction: null, then the transaction’s next query and its commit succeed', async () => {
		const db = getDb();
		const { requestId } = origin();
		try {
			const settings = await db.transaction(async (tx) => {
				const context = await evaluationContext(OWNER, AT, {
					db: tx,
					reader: stall,
					origin: origin(requestId)
				});
				expect(context).toBeNull();
				// The savepoint took its settings with it: read-write, with no statement timeout.
				const { rows } = await tx.execute<{ timeout: string; readOnly: string }>(
					sql`select current_setting('statement_timeout') as timeout,
						current_setting('transaction_read_only') as "readOnly"`
				);
				return rows[0];
			});
			expect(settings).toEqual({ timeout: '0', readOnly: 'off' });
			// The error row was written in that transaction, and its commit kept it.
			const [row] = await findErrorsByRequestId(requestId, { db });
			expect(row?.context).toMatchObject({ part: 'evaluation-context', code: '57014' });
			expect(takeOverlaps()).toEqual([]);
		} finally {
			await db.execute(sql`delete from app_errors where request_id = ${requestId}`);
		}
	});
});

describe('on Train', () => {
	it('hard sparring logged on Monday makes Tuesday’s heavy squats a residual-fatigue finding, with the fix', async () => {
		await withRollback(async (db) => {
			const owner = await ownerWithProfile(db);
			const tuesday = '2026-11-10';
			const plan = programFixture('one-week', { monday: MONDAY, today: MONDAY });
			const week = plan.blocks[0]!.weeks[0]!;
			const lifts = week.sessions[0]!;
			if (lifts.kind !== 'strength') throw new Error('expected Monday’s strength session');
			// Tuesday's lifts with the back squat at RPE 8: heavy lower body. Nothing else that week.
			lifts.exercises[1]!.sets = lifts.exercises[1]!.sets.map((s) => ({ ...s, targetRpe: 8 }));
			week.sessions = [{ ...lifts, date: tuesday, title: 'Lower A' }];
			await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			await logged(
				db,
				owner,
				new Date('2026-11-09T18:00:00Z'),
				{ kind: 'other', discipline: 'muay_thai', sessionType: 'muay_thai', title: 'Sparring' },
				{ durationSeconds: 7200, sessionRpe: 9.5 },
				(workoutClientId) =>
					logOtherSession(
						owner,
						{
							workoutClientId,
							...{ kind: 'sparring', durationMinutes: 120, rpe: 9.5, metrics: [], notes: null }
						},
						{ db }
					)
			);
			const data = await loadTrainWeek(
				owner,
				{ now: new Date('2026-11-10T06:00:00Z'), week: null, origin: origin() },
				{ db, errorsDb: db, periodisation: { context: { statementTimeoutMs: SLOW_OK } } }
			);
			if (data.state !== 'program') throw new Error(`expected a program, got ${data.state}`);
			const card = data.days.flatMap((d) => d.cards).find((c) => c.title === 'Lower A' && c.note);
			expect(card?.note).toMatchObject({
				label: 'Heads-up',
				text: expect.stringMatching(/^Heads-up · A hard session on an overloaded system · /),
				why: expect.stringMatching(/Moving Lower A to \w+day clears this\.$/)
			});
		});
	});

	it('still renders when the facts loader fails: recorded, judged by checkWeek alone', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const seeded = (await seedAnalyticsFixture(
				owner,
				'periodisation-week',
				{ timeZone: 'UTC', now: NOW },
				{ db }
			)) as unknown as PeriodisationWeekResult;
			const failing = new Proxy(createAnalyticsRepository(db), {
				get: () => () => Promise.reject(new Error('facts unavailable'))
			}) as AnalyticsRepository;
			const { requestId } = origin();
			const data = await loadTrainWeek(
				owner,
				{ now: NOW, week: String(FIXTURE_WEEKS.moved), origin: origin(requestId) },
				{ db, errorsDb: db, periodisation: { context: { repository: failing } } }
			);
			if (data.state !== 'program') throw new Error(`expected a program, got ${data.state}`);
			// checkWeek's finding on the owner's move, without the scheduler's fix.
			expect(data.weekLine).toBe('1 heads-up this week');
			const note = data.days
				.flatMap((d) => d.cards)
				.find((c) => c.lineage === seeded.lineages.moved)?.note;
			expect(note?.why).toMatch(/You moved Lower A here from Friday\.$/);
			const errors = await findErrorsByRequestId(requestId, { db });
			expect(errors.map((e) => e.context)).toEqual([
				expect.objectContaining({ part: 'evaluation-context' })
			]);
		});
	});
});
