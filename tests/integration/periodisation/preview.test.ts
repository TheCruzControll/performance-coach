/**
 * A re-plan's preview (services/periodisation/preview.ts) on real Postgres:
 * - a priority swap on M3's hybrid (S8): the phases change from the Monday, the leader and its
 *   doses swap, and every row names its week; a block, a taper and a deload each preview by their
 *   own mechanism, and a deload made on Thursday lists Thursday to Sunday only
 * - the fingerprint is stable across calls, changes after a profile edit and not after a logged
 *   set; loads start from the latest e1RM
 * - refused: no_program (another owner's program included), block_complete and nothing_ahead
 * - transactions: inside an open transaction on a pool of one connection it completes and never
 *   touches the app's pool; with the context's reads stalled inside a transaction, under the
 *   one-query guard, it completes with checkWeek's scores and an app_errors row, and the
 *   transaction commits
 */
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import * as strength from '../../../src/lib/domain/analytics/strength';
import { addDays } from '../../../src/lib/domain/calendar';
import { scenarioDay } from '../../../src/lib/domain/programming/scenarios';
import type { ReplanDirective } from '../../../src/lib/domain/training/replan';
import { cleanFloat } from '../../../src/lib/domain/units';
import { createDatabase, createPool, getDb, type Executor } from '../../../src/lib/server/db';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import { getExercisesByIds, resolveKeys } from '../../../src/lib/server/services/exercises/index';
import type { ContextReader } from '../../../src/lib/server/services/periodisation/context';
import {
	previewReplan,
	SCORED_WEEKS,
	type PreviewDeps,
	type ReplanPreview
} from '../../../src/lib/server/services/periodisation/preview';
import {
	completeOnboarding,
	createGoal,
	reorderGoals,
	saveBaselines,
	saveEquipment,
	saveExperience,
	saveSchedule,
	saveSpecifics
} from '../../../src/lib/server/services/profile';
import { buildProgram, previewProgram } from '../../../src/lib/server/services/programming/index';
import { getProgramVersion } from '../../../src/lib/server/services/programs/index';
import { finishWorkout, logSet, startWorkout } from '../../../src/lib/server/services/training/log';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import type { ReviewFixtureResult } from '../../../src/lib/server/test-support/analytics-fixtures/reviews';
import { takeOverlaps } from '../one-query-per-client';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';

/** The hybrid is built on Thursday 5 Nov from Monday 9 Nov; week 3 starts Monday 23 Nov. */
const BUILT_ON = '2026-11-05';
const WEEK_3 = scenarioDay(3, 0);
/** The review fixtures' day: Wednesday 18 Nov in Los Angeles (block-end's block ends Sunday). */
const TZ = 'America/Los_Angeles';
const WEDNESDAY = '2026-11-18';
const NEXT_MONDAY = '2026-11-23';
/** Real reads on a loaded CI runner: far above the context's 300 ms default. */
const SLOW_OK = 10_000;

const PRIORITIES: ReplanDirective = { kind: 'priorities', cause: 'reorder' };

const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'POST',
	path: '/profile/goals',
	routeId: '/(app)/profile/[section]',
	appVersion: '0.1.0+test'
});

const general = (title: string, disciplines: string[]) => ({
	...{ kind: 'general', title, disciplines, focus: title },
	measure: 'Train every planned week'
});

/** SCENARIOS.hybrid through M2's services, built from Monday 9 Nov: a marathon first. */
async function hybridOwner(db: Executor) {
	const owner = await makeOwner(db);
	const deps = { db };
	const marathon = await createGoal(
		owner,
		{
			...{ kind: 'event', title: 'Marathon', disciplines: ['distance_running'] },
			...{ eventType: 'Marathon', eventDate: scenarioDay(20, 6) }
		},
		deps
	);
	const strong = await createGoal(owner, general('Stay strong', ['strength']), deps);
	const thai = await createGoal(owner, general('Muay Thai', ['muay_thai']), deps);
	const entries = ['distance_running', 'strength', 'muay_thai'].map((discipline) => ({
		discipline,
		level: 'intermediate'
	}));
	await saveExperience(owner, { entries }, deps);
	const lift = (name: string, source: string, value: number) => ({
		...{ lift: name, source, value },
		unit: 'kg'
	});
	await saveBaselines(
		owner,
		{
			unknown: false,
			lifts: [lift('back_squat', 'tested', 140), lift('bench_press', 'estimate', 100)]
		},
		deps
	);
	await saveSpecifics(
		owner,
		{
			running: {
				...{ unit: 'km', weeklyDistance: 30, runsPerWeek: 4, longestRun: 18 },
				...{ easyPaceSeconds: 330, races: [] }
			},
			muayThai: null
		},
		deps
	);
	await saveEquipment(owner, { gymType: 'commercial', equipment: [], homeEquipment: [] }, deps);
	await saveSchedule(owner, hybridSchedule(75), deps);
	await completeOnboarding(owner, deps);
	const preview = await previewProgram(owner, { today: BUILT_ON, start: 'next_monday' }, deps);
	const built = await buildProgram(
		owner,
		{
			...{ today: BUILT_ON, start: 'next_monday', startsOn: preview.startsOn },
			...{ firstPlannedDay: preview.firstPlannedDay, fingerprint: preview.fingerprint },
			digest: preview.digest
		},
		deps
	);
	const ids = { marathon: marathon.id, strong: strong.id, thai: thai.id };
	return { owner, programId: built.programId, ...ids };
}

const hybridSchedule = (sessionMinutes: number) => ({
	...{ daysPerWeek: 5, availableDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
	...{ preferredTimes: ['morning', 'evening'], sessionMinutes, constraints: null },
	commitments: [
		{
			...{ discipline: 'muay_thai', label: 'Muay Thai class', days: ['tue', 'thu'] },
			...{ timeOfDay: 'evening', durationMinutes: 90, intensity: 'hard' }
		}
	]
});

type Seeded = ReviewFixtureResult & { exercises: Record<string, string> };

/** A review fixture seeded on `today` in Los Angeles. */
async function reviewFixture(db: Executor, name: string, today = WEDNESDAY) {
	const owner = await makeOwner(db);
	const now = atLocal(today, '12:00', TZ);
	const seeded = (await seedAnalyticsFixture(
		owner,
		name,
		{ timeZone: TZ, now },
		{ db }
	)) as unknown as Seeded;
	return { owner, seeded };
}

/** The preview, failing the test on a refusal. */
async function preview(
	owner: string,
	today: string,
	directive: ReplanDirective,
	deps: PreviewDeps
): Promise<ReplanPreview> {
	const shown = await previewReplan(
		owner,
		{ today, directive },
		{ statementTimeoutMs: SLOW_OK, ...deps }
	);
	if ('refusal' in shown) throw new Error(`Refused: ${shown.refusal}: ${shown.why}`);
	return shown;
}

/** The refusal's reason, or null when it previewed. */
async function refusalOf(owner: string, today: string, directive: ReplanDirective, db: Executor) {
	const shown = await previewReplan(owner, { today, directive }, { db });
	return 'refusal' in shown ? shown.refusal : null;
}

/** The first goal leading in the decisions' priority_resolved evidence. */
const leaderOf = (decisions: readonly { kind: string; evidence: Record<string, unknown> }[]) =>
	decisions.find((d) => d.kind === 'priority_resolved' && d.evidence.mode === 'primary')?.evidence
		.goalRef;

/** A strength workout off the plan with three back-squat sets, logged at `at`. */
async function squatsAt(db: Executor, owner: string, at: Date, weight: number) {
	const squat = (await resolveKeys(['back_squat'], { db })).get('back_squat')!;
	const workoutClientId = crypto.randomUUID();
	await startWorkout(
		owner,
		{
			...{ clientId: workoutClientId, kind: 'strength', discipline: 'strength' },
			...{ sessionType: 'strength', title: 'Extra squats', plannedSessionId: null },
			startedAt: at.toISOString()
		},
		{ db }
	);
	for (const setIndex of [1, 2, 3]) {
		await logSet(
			owner,
			{
				...{ clientMutationId: crypto.randomUUID(), workoutClientId },
				...{ exerciseId: squat.id, plannedExerciseLineageId: null },
				...{ exercisePosition: 1, setIndex, weight, unit: 'kg', reps: 5 },
				...{ missedReps: 0, rpe: 8, seconds: null, metres: null },
				...{ isExtra: false, isSkipped: false, isWarmup: false },
				performedAt: new Date(at.getTime() + setIndex * 300_000).toISOString()
			},
			{ db }
		);
	}
	const finishedAt = new Date(at.getTime() + 3_600_000).toISOString();
	const done = { status: 'completed', finishedAt, durationSeconds: 3600, sessionRpe: 8 };
	await finishWorkout(owner, workoutClientId, done, { db });
}

/** Every call and connection the app's own pool is asked for, from now until `stop()`. */
function watchAppPool() {
	const pool = (getDb() as unknown as { $client: pg.Pool }).$client;
	const { query, connect } = pool;
	let calls = 0;
	pool.query = function (this: pg.Pool, ...args: unknown[]) {
		calls++;
		return Reflect.apply(query, this, args) as unknown;
	} as typeof query;
	pool.connect = function (this: pg.Pool, ...args: unknown[]) {
		calls++;
		return Reflect.apply(connect, this, args) as unknown;
	} as typeof connect;
	return {
		calls: () => calls,
		stop: () => Object.assign(pool, { query, connect })
	};
}

describe('a priority swap on the hybrid (S8)', () => {
	it('changes the phases from the Monday, swaps the leader and its doses, and names each week', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			await reorderGoals(h.owner, { ids: [h.strong, h.marathon, h.thai] }, { db });
			const shown = await preview(h.owner, WEEK_3, PRIORITIES, { db });

			expect(shown).toMatchObject({ mechanism: 'regenerate', from: WEEK_3, baseVersionNumber: 1 });
			const current = await getProgramVersion(h.owner, h.programId, 1, { db });
			expect(leaderOf(current.decisions)).toBe(h.marathon);
			expect(leaderOf(shown.replan.decisions)).toBe(h.strong);
			const { blocks } = shown.replan.plan;
			expect(blocks[1]!.startsOn).toBe(WEEK_3);
			// Nothing before the Monday changes: the block across it is cut there.
			expect(blocks[0]).toMatchObject({
				startsOn: current.blocks[0]!.startsOn,
				endsOn: addDays(WEEK_3, -1)
			});
			// The doses swap with the leader: the marathon now trains alongside as secondary.
			const modes = (decisions: readonly { kind: string; evidence: Record<string, unknown> }[]) =>
				String(
					decisions.find((d) => d.kind === 'priority_resolved' && d.evidence.mode === 'primary')
						?.evidence.modes
				);
			expect(modes(current.decisions)).toMatch(/^Stay strong trains/);
			expect(modes(shown.replan.decisions)).toMatch(/^Marathon trains alongside as secondary/);

			expect(shown.weeks.length).toBeGreaterThan(0);
			expect(shown.weeks[0]!.weekStart).toBe(WEEK_3);
			// The phases change: a block of another phase, and other week kinds, from the Monday.
			const rows = shown.weeks.flatMap((w) => w.rows);
			const phase = rows.find((r) => r.kind === 'block')!;
			expect(phase.before).not.toBe(phase.after);
			expect(rows.find((r) => r.kind === 'week')).toMatchObject({
				line: expect.stringMatching(/^Week of 23 Nov · Week /)
			});
			for (const week of shown.weeks) {
				expect(week.label).toMatch(/^Week of \d{1,2} [A-Z][a-z]{2}$/);
				for (const row of week.rows) expect(row.line.startsWith(`${week.label} · `)).toBe(true);
			}
			expect(shown.summaryLines.length).toBeGreaterThan(0);
			expect(shown.summaryLines.length).toBeLessThanOrEqual(3);

			// The first changed weeks, judged with the context, before and after.
			expect(shown.judged).toBe('context');
			expect(shown.scores.map((s) => s.weekStart)).toEqual(
				shown.weeks.slice(0, SCORED_WEEKS).map((w) => w.weekStart)
			);
			for (const s of shown.scores) {
				expect(s.before).toBeGreaterThanOrEqual(0);
				expect(s.after).toBeLessThanOrEqual(100);
			}
			expect(shown.scoreBefore).toBe(Math.min(...shown.scores.map((s) => s.before)));
			expect(shown.scoreAfter).toBe(Math.min(...shown.scores.map((s) => s.after)));
			expect(shown.ahead).toBeUndefined();
		});
	});
});

describe('each directive by its mechanism', () => {
	it('a maintenance block regenerates from the Monday', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const block: ReplanDirective = { kind: 'block', phase: 'maintenance', weeks: 4 };
			const shown = await preview(h.owner, WEEK_3, block, { db });
			expect(shown).toMatchObject({ mechanism: 'regenerate', from: WEEK_3 });
			const planned = shown.replan.plan.blocks.find((b) => b.startsOn === WEEK_3)!;
			expect(planned).toMatchObject({ phase: 'maintenance', endsOn: addDays(WEEK_3, 27) });
			expect(shown.weeks.length).toBeGreaterThan(0);
		});
	});

	it('a taper for a race inside the outline splices a taper block ending on its day', async () => {
		await withRollback(async (db) => {
			const { owner } = await reviewFixture(db, 'block-end');
			// Sunday of the outline's third week; the plan was made before the race was added.
			const raceOn = addDays(NEXT_MONDAY, 20);
			const race = await createGoal(
				owner,
				{
					...{ kind: 'event', title: '10K', disciplines: ['running'] },
					...{ eventType: '10K race', eventDate: raceOn }
				},
				{ db }
			);
			const taper: ReplanDirective = { kind: 'taper', goalRef: race.id, form: 'full' };
			const shown = await preview(owner, WEDNESDAY, taper, { db });
			expect(shown.mechanism).toBe('splice');
			const block = shown.replan.plan.blocks.find((b) => b.phase === 'taper')!;
			expect(block.startsOn <= raceOn && block.endsOn >= raceOn).toBe(true);
			expect(block.startsOn >= NEXT_MONDAY).toBe(true);
			expect(shown.weeks.every((w) => w.weekStart >= NEXT_MONDAY)).toBe(true);
		});
	});

	it('a deload made on Thursday changes and lists Thursday to Sunday only', async () => {
		await withRollback(async (db) => {
			const thursday = '2026-11-19';
			const { owner, seeded } = await reviewFixture(db, 'week-complete', thursday);
			if (seeded.review.kind !== 'weekly') throw new Error('a weekly fixture');
			const monday = seeded.review.nextWeekStartsOn;
			// Wednesday's run missed (its workout deleted): past, so a deload leaves it as it was.
			await db.execute(
				sql`update workouts set deleted_at = now() where owner_id = ${owner}
					and started_at >= ${atLocal(addDays(monday, 2), '00:00', TZ)}
					and started_at < ${atLocal(thursday, '00:00', TZ)}`
			);
			const deload: ReplanDirective = {
				...{ kind: 'deload', week: monday, trigger: 'owner' },
				reasons: ['Legs heavy since Tuesday']
			};
			const shown = await preview(owner, thursday, deload, { db });
			expect(shown).toMatchObject({ mechanism: 'in_place', from: monday });
			const sunday = addDays(monday, 6);
			expect(shown.ahead!.map((s) => [s.date, s.title])).toEqual([
				[thursday, 'Strength B'],
				[addDays(monday, 4), 'Sparring'],
				[addDays(monday, 5), 'Long run']
			]);
			const rows = shown.weeks.flatMap((w) => w.rows);
			expect(rows.length).toBeGreaterThan(0);
			for (const row of rows) {
				if (row.date !== null) expect(row.date >= thursday && row.date <= sunday).toBe(true);
			}
			const week = shown.replan.weeks[0]!;
			expect(week.kind).toBe('deload');
			const version = await getProgramVersion(owner, seeded.programId!, 1, { db });
			const before = version.blocks[0]!.weeks.find((w) => w.startsOn === monday)!;
			const early = (s: { date: string }) => s.date < thursday;
			const strip = ({ date, title, kind }: { date: string; title: string; kind: string }) => ({
				...{ date, title, kind }
			});
			expect(week.sessions.filter(early).map(strip)).toEqual(
				before.sessions.filter(early).map(strip)
			);
		});
	});
});

describe('the fingerprint and the actuals', () => {
	it('is stable, changes after a profile edit and not after a logged set', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const first = await preview(h.owner, WEEK_3, PRIORITIES, { db });
			const again = await preview(h.owner, WEEK_3, PRIORITIES, { db });
			expect(first.fingerprint).toMatch(/^[0-9a-f]{16}$/);
			expect([again.fingerprint, again.shapeDigest]).toEqual([
				first.fingerprint,
				first.shapeDigest
			]);

			// A heavier squat logged last week: the plan is made from it, the proposal still holds.
			await squatsAt(db, h.owner, new Date('2026-11-18T15:00:00Z'), 150);
			const logged = await preview(h.owner, WEEK_3, PRIORITIES, { db });
			expect(logged.input.baselines.back_squat).toMatchObject({ kind: 'estimated' });
			expect(first.input.baselines.back_squat).toEqual({ kg: 140, kind: 'measured' });
			expect([logged.fingerprint, logged.shapeDigest]).toEqual([
				first.fingerprint,
				first.shapeDigest
			]);

			await saveSchedule(h.owner, hybridSchedule(60), { db });
			const edited = await preview(h.owner, WEEK_3, PRIORITIES, { db });
			expect(edited.fingerprint).not.toBe(first.fingerprint);
		});
	});

	it('starts the new block’s loads from the latest e1RM', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await reviewFixture(db, 'block-end');
			const shown = await preview(owner, WEDNESDAY, PRIORITIES, { db });
			expect(shown).toMatchObject({ mechanism: 'regenerate', from: NEXT_MONDAY });

			// The squat's latest e1RM, from its SQL rows as M6 reads them.
			const id = seeded.exercises.back_squat!;
			const { rows } = await db.execute<Record<string, unknown>>(
				sql`select r.id::text as id, r.workout_id as "workoutId", r.exercise_id as exercise,
						r.set_index as "setIndex", r.weight::float as weight, r.unit, r.reps,
						r.missed_reps as "missedReps", r.rpe::float as rpe, r.is_warmup as "isWarmup",
						r.is_extra as "isExtra", r.is_skipped as "isSkipped", r.performed_at as "performedAt"
					from set_records r where r.owner_id = ${owner}
						and r.exercise_id = ${id} and r.deleted_at is null`
			);
			const def = (await getExercisesByIds(owner, [id], { db })).get(id)!;
			const facts = rows.map((s) => ({
				...s,
				performedAt: new Date(s.performedAt as string),
				deletedAt: null
			})) as unknown as strength.StrengthFact[];
			const e1rm = cleanFloat(strength.e1rmSeries(facts, def, TZ).at(-1)!.value, 1);

			expect(shown.input.baselines.back_squat).toEqual({ kg: e1rm, kind: 'estimated' });
			expect(shown.assumptions).toContainEqual(
				expect.objectContaining({ rule: 'e1rm_baseline', field: 'baselines.back_squat' })
			);
			const planned = shown.replan.plan.blocks.find((b) => b.startsOn === NEXT_MONDAY)!;
			const squats = planned.weeks
				.flatMap((w) => w.sessions)
				.flatMap((s) => (s.kind === 'strength' ? s.exercises : []))
				.filter((e) => 'key' in e.exercise && e.exercise.key === 'back_squat')
				.flatMap((e) => e.sets);
			expect(squats.length).toBeGreaterThan(0);
			expect(squats.some((l) => l.loadBasis === 'estimated' && l.reference1rm === e1rm)).toBe(true);
		});
	});
});

describe('refusals', () => {
	it('no_program, for an owner with none and for another owner’s plan', async () => {
		await withRollback(async (db) => {
			const { owner } = await reviewFixture(db, 'week-complete');
			const other = await makeSecondOwner(db);
			expect(await refusalOf(other, WEDNESDAY, PRIORITIES, db)).toBe('no_program');
			const deload: ReplanDirective = {
				...{ kind: 'deload', week: '2026-11-16', trigger: 'owner' },
				reasons: []
			};
			expect(await refusalOf(other, WEDNESDAY, deload, db)).toBe('no_program');
			// The owner's own plan previews.
			expect(await refusalOf(owner, WEDNESDAY, deload, db)).toBeNull();
		});
	});

	it('block_complete once every planned week is over', async () => {
		await withRollback(async (db) => {
			const { owner } = await reviewFixture(db, 'block-end-late');
			const shown = await previewReplan(owner, { today: WEDNESDAY, directive: PRIORITIES }, { db });
			expect(shown).toMatchObject({ refusal: 'block_complete', why: expect.any(String) });
		});
	});

	it('nothing_ahead for a week already over', async () => {
		await withRollback(async (db) => {
			const h = await hybridOwner(db);
			const past: ReplanDirective = {
				...{ kind: 'deload', week: scenarioDay(1, 0), trigger: 'owner' },
				reasons: []
			};
			expect(await refusalOf(h.owner, WEEK_3, past, db)).toBe('nothing_ahead');
		});
	});
});

describe('inside a transaction', () => {
	it('completes on a pool of one connection and never asks the app’s pool for one', async () => {
		const pool = createPool(process.env.DATABASE_URL!, { max: 1, connectionTimeoutMs: 2_000 });
		const solo = createDatabase(pool);
		const ROLLBACK = new Error('rollback');
		try {
			await solo
				.transaction(async (tx) => {
					const { owner } = await reviewFixture(tx, 'block-end');
					const watch = watchAppPool();
					try {
						const shown = await preview(owner, WEDNESDAY, PRIORITIES, { db: tx });
						expect(shown.judged).toBe('context');
						expect(shown.weeks.length).toBeGreaterThan(0);
					} finally {
						watch.stop();
					}
					expect(watch.calls()).toBe(0);
					throw ROLLBACK;
				})
				.catch((error: unknown) => {
					if (error !== ROLLBACK) throw error;
				});
			expect(takeOverlaps()).toEqual([]);
		} finally {
			await pool.end();
		}
	});

	it('with the context’s reads stalled: checkWeek’s scores, an app_errors row, and the commit', async () => {
		const stall: ContextReader = async (db) => {
			await db.execute(sql`select pg_sleep(1)`);
			return null;
		};
		const { requestId } = origin();
		try {
			await withCommitted(async (db) => {
				const { owner } = await reviewFixture(db, 'block-end');
				const unread: ContextReader = async () => null;
				const plain = await preview(owner, WEDNESDAY, PRIORITIES, { db, reader: unread });
				const shown = await db.transaction(async (tx) => {
					const stalled = await previewReplan(
						owner,
						{ today: WEDNESDAY, directive: PRIORITIES },
						{ db: tx, reader: stall, origin: origin(requestId) }
					);
					// The transaction carries on after the cancelled read.
					await tx.execute(sql`select 1`);
					return stalled;
				});
				if ('refusal' in shown) throw new Error(`Refused: ${shown.refusal}`);
				expect(shown.judged).toBe('checkWeek');
				expect(shown.scores.length).toBeGreaterThan(0);
				expect(shown.scores).toEqual(plain.scores);
				expect(shown.fingerprint).toBe(plain.fingerprint);
				// One recorded failure: the second week is judged without waiting again.
				const errors = await findErrorsByRequestId(requestId, { db });
				expect(errors.map((e) => e.context)).toEqual([
					expect.objectContaining({ part: 'evaluation-context', code: '57014' })
				]);
				expect(takeOverlaps()).toEqual([]);
			});
		} finally {
			await getDb().execute(sql`delete from app_errors where request_id = ${requestId}`);
		}
	});
});
