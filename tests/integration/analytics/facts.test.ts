/**
 * The facts loader (src/lib/server/services/analytics/facts.ts) on the M6 dataset: which rows
 * count, on which day, from which version, and how often and how the database is asked.
 * - Only completed, undeleted workouts count, in every kind.
 * - Rows are kept by the owner's calendar day, and prescriptions are the version's each workout
 *   was logged under.
 * - Each kind is read once per window, one query at a time, timed as 'analytics'.
 * Each test seeds the dataset in its own transaction, so the integration setup also proves the
 * loader and the seed send one query at a time.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays, mondayOf } from '../../../src/lib/domain/calendar';
import { localDay } from '../../../src/lib/domain/dates';
import type { Executor } from '../../../src/lib/server/db';
import { ANALYTICS_INDEXES, segmentFacts } from '../../../src/lib/server/db/queries/analytics';
import {
	createAnalyticsRepository,
	type AnalyticsRepository
} from '../../../src/lib/server/db/repositories/analytics';
import { createContext, runWithContext } from '../../../src/lib/server/observability/context';
import {
	createFactsLoader,
	windowsOf,
	type FactsRange
} from '../../../src/lib/server/services/analytics/facts';
import { getProgramVersion } from '../../../src/lib/server/services/programs/index';
import { MAX_RANGE_DAYS } from '../../../src/lib/server/services/training/history';
import { withRollback } from '../helpers';
import {
	LAST_DAY,
	seedDataset,
	TZ,
	WEEK_ONE,
	WEEKS,
	weekOf,
	type Dataset
} from './fixtures/dataset';

const ALL: FactsRange = { from: WEEK_ONE, to: LAST_DAY, timeZone: TZ };

/** Every kind the loader gives, read at once. */
async function everything(loader: ReturnType<typeof createFactsLoader>) {
	const [sets, sessions, runs, planned, recovery, prescriptions, first] = await Promise.all([
		loader.sets(),
		loader.sessions(),
		loader.runs(),
		loader.planned(),
		loader.recovery(),
		loader.prescriptions(),
		loader.firstActivity()
	]);
	return { sets, sessions, runs, planned, recovery, prescriptions, first };
}

/** The repository with each method's calls counted, and the most ever running at once. */
function counting(db: Executor) {
	const repo = createAnalyticsRepository(db);
	const calls: Record<string, number> = {};
	let running = 0;
	const seen = { most: 0 };
	const wrapped = Object.fromEntries(
		Object.entries(repo).map(([name, method]) => [
			name,
			async (...args: unknown[]) => {
				calls[name] = (calls[name] ?? 0) + 1;
				seen.most = Math.max(seen.most, ++running);
				try {
					return await (method as (...a: unknown[]) => Promise<unknown>)(...args);
				} finally {
					running -= 1;
				}
			}
		])
	) as AnalyticsRepository;
	return { repository: wrapped, calls, seen };
}

const discarded = (data: Dataset) => [
	data.workouts.abandoned,
	data.workouts.inProgress,
	data.workouts.deleted,
	data.workouts.abandonedRun
];

describe('which rows count', () => {
	it("are the owner's own, from completed and undeleted workouts only, in every kind", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const facts = await everything(createFactsLoader(db, data.owner, ALL));
			const workoutIds = new Set([
				...facts.sets.map((s) => s.workoutId),
				...facts.sessions.map((s) => s.id),
				...facts.runs.map((r) => r.workout),
				...facts.planned.workouts.map((w) => w.id)
			]);
			for (const id of [...discarded(data), ...data.workouts.other]) {
				expect(workoutIds.has(id)).toBe(false);
			}
			// The discarded workouts' live sets are heavy enough to show if they were counted.
			expect(Math.max(...facts.sets.map((s) => s.weight ?? 0))).toBe(190);
			expect(facts.planned.completed.has(data.sessions.abandoned)).toBe(false);
			expect(facts.recovery).toHaveLength(WEEKS);
			expect(facts.first).toBe(WEEK_ONE);

			const theirs = await everything(createFactsLoader(db, data.other, ALL));
			expect(theirs.sessions.map((s) => s.id).sort()).toEqual([...data.workouts.other].sort());
			expect(theirs.sets.every((s) => s.workoutId === data.workouts.other[0])).toBe(true);
			expect(theirs.runs.map((r) => r.workout)).toEqual([data.workouts.other[1]]);
			expect(theirs.planned.planned).toEqual([]);
			expect(theirs.recovery).toHaveLength(1);
		});
	});

	it('leaves out deleted sets and keeps warm-up, extra, skipped and edited ones flagged', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const sets = await createFactsLoader(db, data.owner, ALL).sets();
			const byId = new Map(sets.map((s) => [s.id, s]));
			expect(byId.has(data.sets.deleted)).toBe(false);
			expect(byId.get(data.sets.extra)).toMatchObject({ isExtra: true });
			expect(byId.get(data.sets.skipped)).toMatchObject({ isSkipped: true });
			expect(byId.get(data.sets.edited)).toMatchObject({ weight: 85, rpe: 9 });
			expect(sets.filter((s) => s.isWarmup).length).toBeGreaterThan(0);
			expect(sets.every((s) => s.deletedAt === null)).toBe(true);
			const bench = sets.find((s) => s.exerciseId === data.exercises.bench_press)!;
			expect(bench.primaryMuscles).toContain('chest');
			expect(bench.plannedLineage).not.toBeNull();
		});
	});

	it('keeps a Sunday 23:30 set in its week, though UTC dates it on the Monday', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const sunday = addDays(weekOf(4), 6);
			const weekFour = { from: weekOf(4), to: sunday, timeZone: TZ };
			const weekFive = { from: weekOf(5), to: addDays(weekOf(5), 6), timeZone: TZ };
			const inFour = await createFactsLoader(db, data.owner, weekFour).sets();
			const set = inFour.find((s) => s.id === data.sets.sundayNight)!;
			expect(localDay(set.performedAt, TZ)).toBe(sunday);
			expect(set.performedAt.toISOString().slice(0, 10)).toBe(weekOf(5));
			const inFive = await createFactsLoader(db, data.owner, weekFive).sets();
			expect(inFive.some((s) => s.id === data.sets.sundayNight)).toBe(false);
			const sessions = await createFactsLoader(db, data.owner, weekFour).sessions();
			expect(sessions.find((s) => s.id === data.workouts.sundayNight)?.date).toBe(sunday);
		});
	});
});

describe('plans and prescriptions', () => {
	it("matches a set logged under version 1 to version 1's lines after version 2 changed them", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const loader = createFactsLoader(db, data.owner, ALL);
			const logged = (await loader.sessions()).find((s) => s.id === data.workouts.underV1)!;
			expect(logged.plannedSessionId).toBe(data.sessions.underV1Row);
			const lines = (await loader.prescriptions()).get(data.sessions.underV1Row)!;
			const bench = lines.find((p) => p.lineage === data.adjustedBench)!;
			expect(bench.exerciseId).toBe(data.exercises.bench_press);
			expect(bench.lines.map((l) => [l.role, l.sets, l.targetRpe])).toEqual([['working', 3, 8]]);

			const v2 = await getProgramVersion(data.owner, data.programs.a, 2, { db });
			const now = v2.blocks
				.flatMap((b) => b.weeks.flatMap((w) => w.sessions))
				.find((s) => s.lineage === data.sessions.underV1)!;
			expect(now.id).not.toBe(data.sessions.underV1Row);
			const adjusted = now.kind === 'strength' ? now.exercises[1]! : null;
			expect(adjusted!.sets[0]!.sets).toBe(4);
			// The sets carry the planned exercise's lineage, which both versions share.
			const sets = (await loader.sets()).filter((s) => s.workoutId === data.workouts.underV1);
			expect(sets.filter((s) => s.plannedLineage === data.adjustedBench)).toHaveLength(3);
		});
	});

	it('gives the planned sessions of both programs in every week, completion by lineage', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const { planned, completed } = await createFactsLoader(db, data.owner, ALL).planned();
			const weeks = Map.groupBy(planned, (s) => mondayOf(s.date));
			expect([...weeks.keys()].sort()).toEqual(
				Array.from({ length: WEEKS }, (_, i) => weekOf(i + 1))
			);
			for (const sessions of weeks.values()) expect(sessions).toHaveLength(6);
			expect(planned.find((s) => s.lineage === data.sessions.skipped)?.status).toBe('skipped');
			expect(completed.has(data.sessions.missed)).toBe(false);
			// Logged under version 1's row, planned now as version 2's copy: completed by lineage.
			expect(completed.has(data.sessions.underV1)).toBe(true);
			const done = planned.filter((s) => completed.has(s.lineage));
			// Every planned session but the skipped, the missed and the abandoned one.
			expect(done).toHaveLength(6 * WEEKS - 3);
		});
	});

	it('gives each run its record and its segments in order, km and mile runs alike', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const runs = await createFactsLoader(db, data.owner, ALL).runs();
			const intervals = runs.find((r) => r.sessionType === 'interval_run')!;
			expect(intervals.segments.map((s) => s.kind)).toEqual([
				...['warm_up', 'interval', 'recovery', 'interval', 'recovery', 'interval'],
				...['recovery', 'interval', 'cool_down']
			]);
			const tempo = runs.find((r) => r.sessionType === 'tempo_run')!;
			expect(tempo.segments.map((s) => s.distanceMetres)).toEqual([1609.344, 4828.032, 1609.344]);
			expect(tempo.metres).toBeCloseTo(8046.72, 6);
			for (const run of runs) {
				const total = run.segments.reduce((sum, s) => sum + s.distanceMetres!, 0);
				expect(total).toBeCloseTo(run.metres!, 6);
			}
		});
	});

	it('gives no segments of discarded workouts, even when asked for them by id', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const runs = await createFactsLoader(db, data.owner, ALL).runs();
			const tempo = runs.find((r) => r.sessionType === 'tempo_run')!;
			const rows = await segmentFacts(db, data.owner, [...discarded(data), tempo.workout]);
			expect(rows.map((r) => [r.workoutId, r.position])).toEqual(
				tempo.segments.map((_, i) => [tempo.workout, i + 1])
			);
		});
	});
});

describe('reading', () => {
	it("reads 'all' over 800 days in two windows, with the same rows as one read", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const range = { from: addDays(LAST_DAY, -799), to: LAST_DAY, timeZone: TZ };
			const windows = windowsOf(range.from, range.to);
			expect(windows).toEqual([
				{ from: range.from, to: addDays(range.from, MAX_RANGE_DAYS - 1) },
				{ from: addDays(range.from, MAX_RANGE_DAYS), to: LAST_DAY }
			]);
			const { repository, calls } = counting(db);
			const loader = createFactsLoader(db, data.owner, range, { repository });
			const facts = await everything(loader);

			// One read over the whole range, straight from the repository.
			const repo = createAnalyticsRepository(db);
			const whole = {
				start: new Date(`${range.from}T00:00:00Z`),
				end: new Date(`${addDays(LAST_DAY, 1)}T14:00:00Z`)
			};
			expect(facts.sets).toEqual(await repo.sets(data.owner, whole));
			const sessions = await repo.sessions(data.owner, whole);
			expect(facts.sessions.map(({ date: _d, ...s }) => s)).toEqual(sessions);
			expect(facts.recovery).toEqual(await repo.recovery(data.owner, range.from, range.to));
			const planned = await repo.planned(data.owner, range.from, range.to);
			expect(facts.planned.planned).toEqual(planned.planned);
			expect(facts.planned.completed).toEqual(planned.completed);
			expect(calls).toEqual({
				sets: 2,
				sessions: 2,
				segments: 2,
				prescriptions: 2,
				planned: 2,
				recovery: 2,
				firstActivity: 1
			});
		});
	});

	it('reads each kind once, one query at a time, and times it in Server-Timing', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const { repository, calls, seen } = counting(db);
			const loader = createFactsLoader(db, data.owner, ALL, { repository });
			const ctx = createContext('facts-test');
			const first = await runWithContext(ctx, () => everything(loader));
			const again = await runWithContext(ctx, () => everything(loader));
			expect(again).toEqual(first);
			expect(Object.values(calls).every((n) => n === 1)).toBe(true);
			expect(Object.keys(calls).sort()).toEqual([
				'firstActivity',
				'planned',
				'prescriptions',
				'recovery',
				'segments',
				'sessions',
				'sets'
			]);
			expect(seen.most).toBe(1);
			expect(ctx.timings.get('analytics')?.count).toBe(7);

			const [baselines, races] = await Promise.all([loader.baselines(), loader.races()]);
			expect(baselines.find((b) => b.lift === 'bench_press')).toMatchObject({
				kind: 'measured',
				value: 100
			});
			expect(races).toMatchObject([{ distance: '10k', timeSeconds: 2880 }]);
		});
	});
});

describe('indexes', () => {
	it('names an index that exists for every fact query', async () => {
		await withRollback(async (db) => {
			const { rows } = await db.execute<{ indexname: string }>(
				sql`select indexname from pg_indexes where schemaname = current_schema()`
			);
			const existing = new Set(rows.map((r) => r.indexname));
			expect(Object.keys(ANALYTICS_INDEXES).sort()).toEqual([
				'plannedFacts',
				'prescriptionFacts',
				'segmentFacts',
				'sessionFacts',
				'setFacts'
			]);
			const named = Object.values(ANALYTICS_INDEXES).flatMap((v) =>
				typeof v === 'string' ? [v] : Object.values(v)
			);
			for (const name of named) expect(existing, name).toContain(name);
		});
	});
});
