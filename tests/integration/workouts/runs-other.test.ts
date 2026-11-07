/**
 * run.log, run.segment and other.log through the sync dispatcher (services/workouts/sync.ts) on
 * real Postgres: runs with their segments and Muay Thai classes with their metrics, applied
 * exactly once, and corrections made after the first send stored, each audited once.
 *
 * Batches go through applySyncBatch as the endpoint calls it, with a test transaction as its db.
 */
import { and, count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	createMutation,
	type MutationPayloads,
	type SyncResult
} from '../../../src/lib/domain/workout/index';
import { toMetres } from '../../../src/lib/domain/units';
import {
	otherSessionRecords,
	runRecords,
	runRecordSegments,
	trainingAudit,
	workouts,
	type Executor
} from '../../../src/lib/server/db';
import {
	createProgramFromPlan,
	getProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { applySyncBatch } from '../../../src/lib/server/services/workouts/sync';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** An instant on Tuesday 10 November 2026, `minute` minutes after 07:00 UTC. */
const at = (minute = 0) => new Date(Date.UTC(2026, 10, 10, 7, minute)).toISOString();
const deviceId = () => crypto.randomUUID();

const sync = (db: Executor, owner: string, mutations: readonly unknown[]) =>
	applySyncBatch(owner, JSON.parse(JSON.stringify(mutations)) as Record<string, unknown>[], {
		db
	});

const statuses = (results: readonly SyncResult[]) => results.map((r) => r.status);

const START = {
	run: {
		kind: 'run',
		title: 'Intervals',
		sessionType: 'interval_run',
		discipline: 'running'
	},
	other: {
		kind: 'other',
		title: 'Muay Thai class',
		sessionType: 'muay_thai',
		discipline: 'muay_thai'
	}
} as const;

/** The owner's started workout of `kind`: its client id. */
async function started(db: Executor, owner: string, kind: keyof typeof START) {
	const workoutId = deviceId();
	const start = createMutation('workout.start', {
		workoutId,
		at: at(),
		payload: { ...START[kind], plannedSessionId: null, plannedLineage: null, programId: null }
	});
	const { results } = await sync(db, owner, [start]);
	expect(statuses(results)).toEqual(['applied']);
	return workoutId;
}

type Segment = MutationPayloads['run.segment'];
const SEGMENT = { distanceMetres: null, durationSeconds: null, avgHr: null, rpe: null } as const;

/** A segment's first send (id === entityId). */
const segmentAdd = (workoutId: string, payload: Segment, minute = 10) =>
	createMutation('run.segment', { workoutId, at: at(minute), payload });

/** A later send of a segment: a fresh id, the segment's client id as entityId. */
const segmentEdit = (workoutId: string, entityId: string, payload: Segment, minute = 30) =>
	createMutation('run.segment', { workoutId, entityId, at: at(minute), payload });

const runLog = (workoutId: string, payload: MutationPayloads['run.log'], minute = 40) =>
	createMutation('run.log', { workoutId, at: at(minute), payload });

const MUAY_THAI = {
	kind: 'class',
	durationMinutes: 60,
	rpe: 8,
	metrics: [
		{ key: 'rounds', label: 'Rounds', unit: null, value: 6 },
		{ key: 'sparred', label: 'Sparred', unit: null, value: true }
	],
	notes: 'Teeps and clinch'
} as const satisfies MutationPayloads['other.log'];

const otherLog = (workoutId: string, payload: MutationPayloads['other.log'], minute = 70) =>
	createMutation('other.log', { workoutId, at: at(minute), payload });

async function workoutRowId(db: Executor, clientId: string) {
	const [row] = await db
		.select({ id: workouts.id })
		.from(workouts)
		.where(eq(workouts.clientId, clientId));
	return row!.id;
}

const auditCount = async (db: Executor, table: string, rowId: string | number) => {
	const [row] = await db
		.select({ n: count() })
		.from(trainingAudit)
		.where(and(eq(trainingAudit.tableName, table), eq(trainingAudit.rowId, String(rowId))));
	return row!.n;
};

async function segmentRow(db: Executor, clientMutationId: string) {
	const [row] = await db
		.select()
		.from(runRecordSegments)
		.where(eq(runRecordSegments.clientMutationId, clientMutationId));
	return row!;
}

const canonicalOf = (results: readonly SyncResult[]) =>
	results.findLast((r) => r.canonical)!.canonical!;

/** A warm-up, 6 × (400 m + 90 s recovery) and a cool-down, in the order the device sends them. */
function intervalSession(workoutId: string) {
	const pieces: Segment[] = [
		{ ...SEGMENT, position: 1, kind: 'warm_up', distanceMetres: 2000, durationSeconds: 720 }
	];
	for (let rep = 0; rep < 6; rep++) {
		pieces.push(
			{
				...SEGMENT,
				position: 2 + rep * 2,
				kind: 'interval',
				distanceMetres: 400,
				durationSeconds: 90,
				rpe: 9
			},
			{ ...SEGMENT, position: 3 + rep * 2, kind: 'recovery', durationSeconds: 90 }
		);
	}
	pieces.push({
		...SEGMENT,
		position: 14,
		kind: 'cool_down',
		distanceMetres: 1500,
		durationSeconds: 600
	});
	return pieces.map((payload, i) => segmentAdd(workoutId, payload, 10 + i));
}

describe('run.log and run.segment', () => {
	it('a warm-up, 6 × (400 m + 90 s) and a cool-down round-trip in order, with pace', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const workout = await started(db, owner, 'run');
			const segments = intervalSession(workout);

			const { results } = await sync(db, owner, [
				...segments,
				runLog(workout, { distanceMetres: 7300, durationSeconds: 2400, avgHr: 162, rpe: 8 })
			]);

			expect(new Set(statuses(results))).toEqual(new Set(['applied']));
			const run = canonicalOf(results).run!;
			expect(run.segments.map((s) => [s.id, s.position, s.kind])).toEqual(
				segments.map((m) => [m.entityId, m.payload.position, m.payload.kind])
			);
			const intervals = run.segments.filter((s) => s.kind === 'interval');
			expect(intervals).toHaveLength(6);
			// 90 s for 400 m is 3:45 per km.
			for (const s of intervals) expect(s.paceSecondsPerKm).toBeCloseTo(225, 6);
			expect(run.segments.find((s) => s.kind === 'recovery')).toMatchObject({
				distanceMetres: null,
				durationSeconds: 90,
				paceSecondsPerKm: null
			});
			expect(run).toMatchObject({ distanceMetres: 7300, durationSeconds: 2400, avgHr: 162 });
			expect(run.paceSecondsPerKm).toBeCloseTo(2400 / 7.3, 6);
		});
	});

	it('5 mi is stored as 8046.72 m', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const workout = await started(db, owner, 'run');

			const { results } = await sync(db, owner, [
				runLog(workout, { distanceMetres: toMetres(5, 'mi'), durationSeconds: 2700 })
			]);

			expect(statuses(results)).toEqual(['applied']);
			const [row] = await db
				.select({ distanceMetres: runRecords.distanceMetres })
				.from(runRecords)
				.where(eq(runRecords.workoutId, await workoutRowId(db, workout)));
			expect(row!.distanceMetres).toBe(8046.72);
			expect(canonicalOf(results).run!.distanceMetres).toBe(8046.72);
		});
	});

	it('a converted distance finer than a millimetre is stored to the millimetre (3.1 mi)', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const workout = await started(db, owner, 'run');
			const metres = toMetres(3.1, 'mi');
			expect(metres).toBeCloseTo(4988.9664, 6);
			const first = segmentAdd(workout, {
				...SEGMENT,
				position: 1,
				kind: 'easy',
				distanceMetres: metres
			});

			const { results } = await sync(db, owner, [
				first,
				runLog(workout, { distanceMetres: metres })
			]);

			expect(statuses(results)).toEqual(['applied', 'applied']);
			const run = canonicalOf(results).run!;
			expect(run.distanceMetres).toBe(4988.966);
			expect(run.segments[0]!.distanceMetres).toBe(4988.966);
		});
	});

	it('a first segment before any run.log makes the run’s record with empty totals; a later run.log sets them', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const workout = await started(db, owner, 'run');
			const id = await workoutRowId(db, workout);
			const first = segmentAdd(workout, {
				...SEGMENT,
				position: 1,
				kind: 'easy',
				distanceMetres: 5000,
				durationSeconds: 1800
			});

			const before = await sync(db, owner, [first]);
			expect(statuses(before.results)).toEqual(['applied']);
			expect(canonicalOf(before.results).run).toMatchObject({
				distanceMetres: null,
				durationSeconds: null,
				avgHr: null,
				rpe: null,
				notes: null,
				paceSecondsPerKm: null
			});

			const totals = runLog(workout, { distanceMetres: 5000, durationSeconds: 1800, rpe: 5 });
			const after = await sync(db, owner, [totals]);
			expect(statuses(after.results)).toEqual(['applied']);
			expect(canonicalOf(after.results).run).toMatchObject({
				distanceMetres: 5000,
				durationSeconds: 1800,
				rpe: 5,
				paceSecondsPerKm: 360
			});
			expect(canonicalOf(after.results).run!.segments.map((s) => s.id)).toEqual([first.id]);
			expect(await auditCount(db, 'run_records', id)).toBe(1);

			// A later run.log sets only what it carries, and keeps the rest.
			const note = runLog(workout, { notes: 'Felt easy' }, 45);
			const noted = await sync(db, owner, [note]);
			expect(canonicalOf(noted.results).run).toMatchObject({
				distanceMetres: 5000,
				durationSeconds: 1800,
				rpe: 5,
				notes: 'Felt easy'
			});
			expect(await auditCount(db, 'run_records', id)).toBe(2);

			// The same values under a new id change nothing and write no audit row.
			const again = await sync(db, owner, [runLog(workout, { rpe: 5, notes: 'Felt easy' }, 46)]);
			expect(statuses(again.results)).toEqual(['applied']);
			expect(await auditCount(db, 'run_records', id)).toBe(2);
		});
	});

	it('a segment edited after it synced is stored once with one audit row; replays and identical edits write nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const workout = await started(db, owner, 'run');
			const rep = { ...SEGMENT, position: 1, kind: 'interval', distanceMetres: 400 } as const;
			const first = segmentAdd(workout, { ...rep, durationSeconds: 90 });
			await sync(db, owner, [first]);
			const stored = await segmentRow(db, first.entityId);

			const fix = segmentEdit(workout, first.entityId, { ...rep, durationSeconds: 84, rpe: 9 });
			const fixed = await sync(db, owner, [fix]);

			expect(statuses(fixed.results)).toEqual(['applied']);
			expect(await segmentRow(db, first.entityId)).toMatchObject({
				durationSeconds: 84,
				rpe: 9,
				paceSecondsPerKm: 210
			});
			expect(await auditCount(db, 'run_record_segments', stored.id)).toBe(1);

			// The same edit replayed is a duplicate and writes nothing.
			const replay = await sync(db, owner, [fix]);
			expect(statuses(replay.results)).toEqual(['duplicate']);
			// An identical edit under a new id applies, but changes nothing.
			const same = segmentEdit(workout, first.entityId, fix.payload, 31);
			const unchanged = await sync(db, owner, [same]);
			expect(statuses(unchanged.results)).toEqual(['applied']);
			expect(await auditCount(db, 'run_record_segments', stored.id)).toBe(1);
			// And the first send replayed never undoes the correction.
			expect(statuses((await sync(db, owner, [first])).results)).toEqual(['duplicate']);
			expect(await segmentRow(db, first.entityId)).toMatchObject({ durationSeconds: 84 });
			expect(canonicalOf(unchanged.results).run!.segments).toEqual([
				expect.objectContaining({ id: first.entityId, durationSeconds: 84, rpe: 9 })
			]);
		});
	});

	it('an edit of a segment that has not arrived is deferred, then applies after its create', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const workout = await started(db, owner, 'run');
			const rep = { ...SEGMENT, position: 1, kind: 'tempo', distanceMetres: 3000 } as const;
			const first = segmentAdd(workout, { ...rep, durationSeconds: 780 });
			const fix = segmentEdit(workout, first.entityId, { ...rep, durationSeconds: 760 });

			const early = await sync(db, owner, [fix]);
			expect(early.results).toEqual([{ id: fix.id, status: 'deferred', code: 'missing' }]);

			const later = await sync(db, owner, [first, fix]);
			expect(statuses(later.results)).toEqual(['applied', 'applied']);
			expect(await segmentRow(db, first.entityId)).toMatchObject({ durationSeconds: 760 });
		});
	});

	it('finish after run.log completes the run', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const workout = await started(db, owner, 'run');
			const finish = createMutation('workout.finish', {
				workoutId: workout,
				at: at(60),
				payload: { sessionRpe: 7 }
			});

			const { results } = await sync(db, owner, [
				runLog(workout, { distanceMetres: 10000, durationSeconds: 3000 }),
				finish
			]);

			expect(statuses(results)).toEqual(['applied', 'applied']);
			const canonical = canonicalOf(results);
			expect(canonical.workout.status).toBe('completed');
			expect(canonical.run).toMatchObject({ distanceMetres: 10000, paceSecondsPerKm: 300 });
		});
	});

	it('a run.log in a strength workout is refused at its workout', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const workoutId = deviceId();
			const start = createMutation('workout.start', {
				workoutId,
				at: at(),
				payload: {
					kind: 'strength',
					title: 'Lower body',
					sessionType: 'strength',
					discipline: 'strength',
					plannedSessionId: null,
					plannedLineage: null,
					programId: null
				}
			});
			const log = runLog(workoutId, { distanceMetres: 5000 });

			const { results } = await sync(db, owner, [start, log]);

			expect(results[1]).toMatchObject({ status: 'rejected', code: 'invalid' });
			expect(Object.keys(results[1]!.errors!)).toEqual(['workoutId']);
		});
	});
});

describe('other.log', () => {
	it('a Muay Thai class round-trips; a second other.log updates the one record with one audit row', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const workout = await started(db, owner, 'other');
			const id = await workoutRowId(db, workout);

			const logged = await sync(db, owner, [otherLog(workout, MUAY_THAI)]);
			expect(statuses(logged.results)).toEqual(['applied']);
			expect(canonicalOf(logged.results).other).toEqual(MUAY_THAI);

			const rounds7 = otherLog(
				workout,
				{ ...MUAY_THAI, metrics: [{ ...MUAY_THAI.metrics[0], value: 7 }, MUAY_THAI.metrics[1]] },
				80
			);
			const edited = await sync(db, owner, [rounds7]);
			expect(statuses(edited.results)).toEqual(['applied']);
			const rows = await db
				.select()
				.from(otherSessionRecords)
				.where(eq(otherSessionRecords.workoutId, id));
			expect(rows).toHaveLength(1);
			expect(rows[0]!.metrics).toEqual(rounds7.payload.metrics);
			expect(await auditCount(db, 'other_session_records', id)).toBe(1);

			// A replay is a duplicate; the same values again under a new id change nothing.
			expect(statuses((await sync(db, owner, [rounds7])).results)).toEqual(['duplicate']);
			const same = await sync(db, owner, [otherLog(workout, rounds7.payload, 81)]);
			expect(statuses(same.results)).toEqual(['applied']);
			expect(await auditCount(db, 'other_session_records', id)).toBe(1);
			expect(canonicalOf(same.results).other!.metrics[0]!.value).toBe(7);
		});
	});

	it("a planned class takes only its plan's metrics, typed as the plan types them", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const plan = programFixture('hybrid', { monday: '2026-11-09', today: '2026-11-09' });
			const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const version = await getProgramVersion(owner, programId, 1, { db });
			const planned = version.blocks[0]!.weeks[0]!.sessions.find((s) => s.kind === 'other')!;
			const workout = deviceId();
			const start = createMutation('workout.start', {
				workoutId: workout,
				at: at(),
				payload: {
					...START.other,
					plannedSessionId: planned.id,
					plannedLineage: planned.lineage,
					programId
				}
			});
			const rounds = { key: 'rounds', label: 'Rounds', unit: null, value: 6 };
			const kicks = otherLog(workout, { ...MUAY_THAI, metrics: [rounds, MUAY_THAI.metrics[1]] });
			const asText = otherLog(workout, { ...MUAY_THAI, metrics: [{ ...rounds, value: '6' }] }, 71);
			const fits = otherLog(workout, { ...MUAY_THAI, metrics: [{ ...rounds, value: 7 }] }, 72);

			// Each in its own batch: a refusal holds back the workout's later mutations in one.
			const results: SyncResult[] = [];
			for (const m of [start, kicks, asText, fits])
				results.push(...(await sync(db, owner, [m])).results);

			// 'sparred' is the ad-hoc class's own key (the round trip above); this plan lacks it.
			expect(results.map((r) => [r.status, Object.keys(r.errors ?? {})])).toEqual([
				['applied', []],
				['rejected', ['payload.metrics.1.key']],
				['rejected', ['payload.metrics.0.value']],
				['applied', []]
			]);
			expect(canonicalOf(results).other!.metrics).toEqual([{ ...rounds, value: 7 }]);
		});
	});

	it.each([
		{
			name: 'a key that is not snake_case',
			metrics: [{ key: 'Rounds!', label: 'Rounds', unit: null, value: 6 }],
			path: 'payload.metrics.0.key'
		},
		{
			name: 'the same key twice',
			metrics: [
				{ key: 'rounds', label: 'Rounds', unit: null, value: 6 },
				{ key: 'rounds', label: 'Rounds', unit: null, value: 7 }
			],
			path: 'payload.metrics.1.key'
		},
		{
			name: 'a value that is a list',
			metrics: [{ key: 'rounds', label: 'Rounds', unit: null, value: [6] }],
			path: 'payload.metrics.0.value'
		}
	])('bad metrics are refused at their dotted path: $name', async ({ metrics, path }) => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const workout = await started(db, owner, 'other');
			const bad = otherLog(workout, { ...MUAY_THAI, metrics } as never);

			const { results } = await sync(db, owner, [bad]);

			expect(results[0]).toMatchObject({ status: 'rejected', code: 'invalid' });
			expect(Object.keys(results[0]!.errors!)).toContain(path);
			const rows = await db
				.select()
				.from(otherSessionRecords)
				.where(eq(otherSessionRecords.workoutId, await workoutRowId(db, workout)));
			expect(rows).toEqual([]);
		});
	});
});

it('the canonical read includes the run, its segments and the class', async () => {
	await withRollback(async (db) => {
		const owner = await makeOwner(db);
		const run = await started(db, owner, 'run');
		const session = await started(db, owner, 'other');
		const [warmUp, ...rest] = intervalSession(run);

		const { results } = await sync(db, owner, [
			warmUp,
			runLog(run, { distanceMetres: 2000, notes: 'Short one' }),
			otherLog(session, MUAY_THAI)
		]);

		expect(rest).toHaveLength(13);
		expect(statuses(results)).toEqual(['applied', 'applied', 'applied']);
		expect(results[0]!.canonical).toBeUndefined();
		expect(results[1]!.canonical!.run).toEqual({
			distanceMetres: 2000,
			durationSeconds: null,
			avgHr: null,
			rpe: null,
			notes: 'Short one',
			paceSecondsPerKm: null,
			segments: [
				{
					id: warmUp!.entityId,
					position: 1,
					kind: 'warm_up',
					distanceMetres: 2000,
					durationSeconds: 720,
					avgHr: null,
					rpe: null,
					paceSecondsPerKm: 360
				}
			]
		});
		expect(results[1]!.canonical!.other).toBeNull();
		expect(results[2]!.canonical!.other).toEqual(MUAY_THAI);
		expect(results[2]!.canonical!.run).toBeNull();
	});
});
