/**
 * Storing a re-plan on real Postgres (src/lib/server/services/programs/replan.ts): a regenerate or
 * a taper's splice is version N + 1 with everything before `from` kept, a block running across it
 * cut on the Sunday before under its lineage, and after a taper every later block shared; a
 * deload copies one week in place through reviseProgram. Version N and its workouts never change.
 *
 * Version 1 runs from Monday 2 November 2026 with a Monday strength session and a Wednesday run
 * each week: block A (two weeks), block B (three weeks from 16 November), then outline C (three
 * weeks from 7 December). The splice program's B runs five weeks, then a planned C and outline D.
 */
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '../../../src/lib/domain/calendar';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import { buildProgrammingInput } from '../../../src/lib/domain/programming/input';
import { REPLAN_GENERATOR_ID } from '../../../src/lib/domain/programming/rules/replan';
import { SCENARIOS } from '../../../src/lib/domain/programming/scenarios';
import { chooseSplit } from '../../../src/lib/domain/programming/splits';
import { hardSetBand } from '../../../src/lib/domain/programming/volume';
import { programPlanSchema } from '../../../src/lib/domain/training/schemas';
import type {
	BlockPlan,
	DecisionPlan,
	ProgramPlan,
	SessionPlan,
	WeekPlan
} from '../../../src/lib/domain/training/types';
import { programVersions, workouts, type Executor } from '../../../src/lib/server/db';
import {
	getMuscleTargets,
	STORED_TARGET
} from '../../../src/lib/server/services/analytics/targets';
import {
	createProgramFromPlan,
	getProgramVersion,
	getTrainingWeek,
	getVersionHistory,
	reviseProgram,
	type ProgramVersion,
	type StoredBlock,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import {
	reviseDeload,
	storeReplan,
	type DeloadRevision,
	type ReplanStorage
} from '../../../src/lib/server/services/programs/replan';
import { reviewableBlock } from '../../../src/lib/server/services/reviews/cycle';
import {
	ProgramConflictError,
	TrainingInputError,
	TrainingNotFoundError
} from '../../../src/lib/server/services/training/shared';
import { holdTransaction, lockWaiters, withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-02';
const day = (n: number) => addDays(MONDAY, n);
const TARGETS = { rpeCap: 8, volumeFactor: 1, loadStep: 0.025, runVolumeFactor: 1 };

// ---- the plan -------------------------------------------------------------------------------

const common = (date: IsoDate) => ({
	date,
	timeOfDay: 'morning' as const,
	orderInDay: 1,
	customDiscipline: null,
	estMinutes: 45,
	estLoad: 300,
	targetRpe: 7,
	source: 'generator' as const,
	commitmentRef: null,
	instructions: null,
	notes: null
});

const squatDay = (date: IsoDate): SessionPlan => ({
	...common(date),
	kind: 'strength',
	type: 'strength',
	title: 'Squat day',
	discipline: 'strength',
	intensity: 'moderate',
	exercises: (['back_squat', 'bench_press'] as const).map((key) => ({
		exercise: { key },
		baselineLift: null,
		superset: null,
		substitutedFrom: null,
		substitutionReason: null,
		instructions: null,
		notes: null,
		sets: [
			{
				role: 'working' as const,
				sets: 3,
				repsMin: 5,
				repsMax: 5,
				seconds: null,
				metres: null,
				targetRpe: 7,
				loadKind: 'rpe_based' as const,
				loadValue: null,
				loadUnit: null,
				loadBasis: null,
				reference1rm: null,
				reference1rmUnit: null,
				restSeconds: 120,
				tempo: null,
				notes: null
			}
		]
	}))
});

const easyRun = (date: IsoDate): SessionPlan => ({
	...common(date),
	kind: 'run',
	type: 'easy_run',
	title: 'Easy run',
	discipline: 'running',
	intensity: 'easy',
	segments: [
		{
			kind: 'easy',
			repeatGroup: null,
			repeats: null,
			distanceMetres: null,
			durationSeconds: 1800,
			paceMinSecondsPerKm: null,
			paceMaxSecondsPerKm: null,
			hrZone: 2,
			targetRpe: 4
		}
	]
});

/** `weeks` planned weeks from `monday`: Monday strength and a Wednesday run. */
function plannedBlock(name: string, monday: IsoDate, weeks: number): BlockPlan {
	const list = Array.from({ length: weeks }, (_, w): WeekPlan => {
		const startsOn = addDays(monday, 7 * w);
		return {
			kind: 'accumulation',
			startsOn,
			endsOn: addDays(startsOn, 6),
			targets: TARGETS,
			sessions: [squatDay(startsOn), easyRun(addDays(startsOn, 2))]
		};
	});
	return {
		phase: 'accumulation',
		name,
		startsOn: monday,
		endsOn: addDays(monday, 7 * weeks - 1),
		outline: false,
		goalRefs: [],
		progression: { rpeStepPerWeek: 0.5 },
		weeks: list
	};
}

const outline = (name: string, monday: IsoDate, weeks: number): BlockPlan => ({
	phase: 'intensification',
	name,
	startsOn: monday,
	endsOn: addDays(monday, 7 * weeks - 1),
	outline: true,
	goalRefs: [],
	progression: {},
	weeks: []
});

const regenPlan = (): BlockPlan[] => [
	plannedBlock('Block A', MONDAY, 2),
	plannedBlock('Block B', day(14), 3),
	outline('Block C', day(35), 3)
];

/** B runs five weeks to 20 December, past the event on Saturday 12 December. */
const splicePlan = (): BlockPlan[] => [
	plannedBlock('Block A', MONDAY, 2),
	plannedBlock('Block B', day(14), 5),
	plannedBlock('Block C', day(49), 2),
	outline('Block D', day(63), 2)
];

const INPUT = buildProgrammingInput(SCENARIOS.beginner(), { catalogue: CATALOGUE });
const NEXT_INPUT = { ...INPUT, nutritionPhase: 'cut' as const };
const snapshot = (input: object) => input as Record<string, unknown>;

async function store(db: Executor, owner: string, blocks = regenPlan()) {
	const plan: ProgramPlan = {
		title: 'Get stronger',
		startsOn: MONDAY,
		firstPlannedDay: MONDAY,
		blocks,
		decisions: []
	};
	const origin = { source: 'rules' as const, generator: 'm3-test/1', snapshot: snapshot(INPUT) };
	const { programId } = await createProgramFromPlan(owner, plan, origin, { db });
	return { programId, v1: await getProgramVersion(owner, programId, 1, { db }) };
}

const replanned = (refs: string[]): DecisionPlan => ({
	kind: 'replanned',
	ruleKey: 'replan.regenerate',
	summary: 'Re-planned from 23 November',
	why: 'Your goal change re-planned from 23 November. The weeks before it stay as they were.',
	decidedBy: 'rules',
	refs,
	evidence: {}
});

/** A regenerate from Monday 23 November (day 21), on Wednesday 18 November: B is cut. */
function regenerate(over: Partial<ReplanStorage> = {}): ReplanStorage {
	return {
		mechanism: 'regenerate',
		baseVersionNumber: 1,
		today: day(16),
		from: day(21),
		blocks: [plannedBlock('Block N', day(21), 3)],
		outline: [outline('Block O', day(42), 2)],
		decisions: [replanned(['blocks.2'])],
		summary: 'Re-planned for your new priorities',
		createdBy: 'rules',
		origin: { fingerprint: 'fp-replan-1', digest: 'catalogue-1', snapshot: snapshot(NEXT_INPUT) },
		...over
	};
}

/** A full taper of 30 November to 13 December (days 28 to 41) spliced into B. */
function splice(over: Partial<ReplanStorage> = {}): ReplanStorage {
	return regenerate({
		mechanism: 'splice',
		from: day(28),
		blocks: [{ ...plannedBlock('Taper', day(28), 2), phase: 'taper' }],
		outline: [],
		decisions: [{ ...replanned(['blocks.2']), ruleKey: 'replan.splice' }],
		summary: 'A taper before your race',
		...over
	});
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!error) throw new Error('expected the call to be refused');
	return error;
}

const errorsOf = async (promise: Promise<unknown>) => {
	const error = await refusal(promise);
	expect(error).toBeInstanceOf(TrainingInputError);
	return (error as TrainingInputError).errors;
};

const PROGRAM_TABLES = [
	'programs',
	'program_versions',
	'program_version_blocks',
	'program_blocks',
	'program_version_weeks',
	'program_weeks',
	'planned_sessions',
	'planned_exercises',
	'set_prescriptions',
	'planned_run_segments',
	'planned_session_details',
	'programming_decisions'
];

async function writes(db: Executor) {
	const { rows } = await db.execute<{ table: string; ins: number; upd: number; del: number }>(
		sql`select relname as table, n_tup_ins::int as ins, n_tup_upd::int as upd, n_tup_del::int as del
			from pg_stat_xact_user_tables where relname in ${sql.raw(`('${PROGRAM_TABLES.join("','")}')`)}`
	);
	return new Map(rows.map((r) => [r.table, r]));
}

async function log(db: Executor, owner: string, programId: string, session: StoredSession) {
	const startedAt = new Date(`${session.date}T07:00:00Z`);
	const [row] = await db
		.insert(workouts)
		.values({
			ownerId: owner,
			clientId: crypto.randomUUID(),
			kind: 'strength',
			discipline: 'strength',
			sessionType: 'strength',
			title: session.title,
			plannedSessionId: session.id,
			plannedLineageId: session.lineage,
			programId,
			status: 'completed',
			startedAt,
			finishedAt: new Date(startedAt.getTime() + 3_600_000)
		})
		.returning();
	return row!;
}

const blocksOf = (v: ProgramVersion) =>
	v.blocks.map((b) => [b.name, b.outline, b.startsOn, b.endsOn, b.weeks.length]);
const weekIds = (v: ProgramVersion) => v.blocks.flatMap((b) => b.weeks.map((w) => w.id));
const lineages = (v: ProgramVersion) =>
	v.blocks.flatMap((b) => [b.lineage, ...b.weeks.map((w) => w.lineage)]);
/** A node without its row ids: what a copy keeps. */
const values = (week: StoredBlock['weeks'][number] | StoredSession) =>
	JSON.parse(JSON.stringify(week, (key, value) => (key === 'id' ? undefined : value)));

async function statusOn(owner: string, date: IsoDate, db: Executor) {
	const week = await getTrainingWeek(owner, { date }, {}, { db });
	if (!week?.planned) throw new Error(`no planned week on ${date}`);
	return week.days.find((d) => d.date === date)!.sessions.map((s) => s.status);
}

describe('storeReplan: regenerate', () => {
	it('keeps version 1, shares the earlier block, cuts the block across from under its lineage', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner);
			const [a, b] = v1.blocks as [StoredBlock, StoredBlock];
			const loggedA = await log(db, owner, programId, a.weeks[0]!.sessions[0]!);
			await log(db, owner, programId, b.weeks[0]!.sessions[0]!);

			const stored = await storeReplan(owner, regenerate(), { db });
			expect(stored).toMatchObject({ programId, number: 2 });

			const v1Again = await getProgramVersion(owner, programId, 1, { db });
			expect(v1Again).toEqual({ ...v1, version: { ...v1.version, current: false } });

			const v2 = await getProgramVersion(owner, programId, 2, { db });
			expect(blocksOf(v2)).toEqual([
				['Block A', false, MONDAY, day(13), 2],
				['Block B', false, day(14), day(20), 1],
				['Block N', false, day(21), day(41), 3],
				['Block O', true, day(42), day(55), 0]
			]);
			const [a2, b2, n2, o2] = v2.blocks as StoredBlock[];
			// A is shared row for row: the same block and weeks, with the same ids.
			expect(a2).toEqual(a);
			// B is cut on the Sunday before: a new row with its lineage, its first week copied whole.
			expect([b2!.lineage, b2!.id === b.id]).toEqual([b.lineage, false]);
			expect(values(b2!.weeks[0]!)).toEqual(values(b.weeks[0]!));
			// The new block and outline are new lineages.
			const old = new Set(lineages(v1));
			for (const lineage of lineages({ ...v2, blocks: [n2!, o2!] }))
				expect(old.has(lineage)).toBe(false);
			// Workouts logged earlier still read as completed, in A and in the cut B.
			expect(await statusOn(owner, MONDAY, db)).toEqual(['completed']);
			expect(await statusOn(owner, day(14), db)).toEqual(['completed']);
			expect(await db.select().from(workouts).where(eq(workouts.id, loggedA.id))).toEqual([
				loggedA
			]);
		});
	});

	it("stores REPLAN_GENERATOR_ID and the input, and the decisions as the rows' lineages", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner);
			const refs = [
				'blocks.0.weeks.1.sessions.1',
				'blocks.1.weeks.0',
				'blocks.2.weeks.0.sessions.0'
			];
			const decisions = [
				replanned(['blocks.2']),
				{ ...replanned(refs), kind: 'block_type_chosen' as const }
			];
			const { versionId } = await storeReplan(owner, regenerate({ decisions }), { db });
			const [row] = await db
				.select()
				.from(programVersions)
				.where(eq(programVersions.id, versionId));
			expect(row).toMatchObject({
				generator: REPLAN_GENERATOR_ID,
				inputFingerprint: 'fp-replan-1',
				catalogueDigest: 'catalogue-1',
				inputSnapshot: JSON.parse(JSON.stringify(NEXT_INPUT)),
				createdBy: 'rules',
				summary: 'Re-planned for your new priorities'
			});
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			const n = v2.blocks[2]!;
			expect(v2.decisions.map((d) => [d.kind, d.affected])).toEqual([
				['replanned', [n.lineage]],
				[
					'block_type_chosen',
					[
						v1.blocks[0]!.weeks[1]!.sessions[1]!.lineage,
						v1.blocks[1]!.weeks[0]!.lineage,
						n.weeks[0]!.sessions[0]!.lineage
					]
				]
			]);
		});
	});

	it('leaves out a block starting on from: never a zero-week block', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner);
			await storeReplan(
				owner,
				regenerate({
					today: day(9),
					from: day(14),
					blocks: [plannedBlock('Block N', day(14), 4)],
					decisions: [replanned(['blocks.1'])]
				}),
				{ db }
			);
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			expect(blocksOf(v2)).toEqual([
				['Block A', false, MONDAY, day(13), 2],
				['Block N', false, day(14), day(41), 4],
				['Block O', true, day(42), day(55), 0]
			]);
			expect(v2.blocks.map((b) => b.lineage)).not.toContain(v1.blocks[1]!.lineage);
			expect(programPlanSchema.safeParse({ ...v2, decisions: [] }).success).toBe(true);
		});
	});

	it("from the program's start shares no weeks, and the plan starts on from", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner);
			await storeReplan(
				owner,
				regenerate({
					today: day(-3),
					from: MONDAY,
					blocks: [plannedBlock('Block N', MONDAY, 3)],
					outline: [outline('Block O', day(21), 2)],
					decisions: [replanned(['blocks.0'])]
				}),
				{ db }
			);
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			expect(v2.startsOn).toBe(MONDAY);
			expect(blocksOf(v2)).toEqual([
				['Block N', false, MONDAY, day(20), 3],
				['Block O', true, day(21), day(34), 0]
			]);
			const before = new Set(weekIds(v1));
			expect(weekIds(v2).filter((id) => before.has(id))).toEqual([]);
		});
	});

	it('still reads a week by number when block 1 is cut or replaced (Train ?week=n)', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await store(db, owner);
			// A re-plan during block A cuts it, and the cut is the version's first block.
			await storeReplan(
				owner,
				regenerate({
					today: day(2),
					from: day(7),
					blocks: [plannedBlock('Block N', day(7), 3)],
					outline: [outline('Block O', day(28), 2)],
					decisions: [replanned(['blocks.1'])]
				}),
				{ db }
			);
			const weekOf = async (week: number) =>
				(await getTrainingWeek(owner, { block: 1, week }, {}, { db }))?.startsOn;
			expect([await weekOf(1), await weekOf(2)]).toEqual([MONDAY, day(7)]);
			// A re-plan from the program's start replaces every block.
			await storeReplan(
				owner,
				regenerate({
					baseVersionNumber: 2,
					today: day(-3),
					from: MONDAY,
					blocks: [plannedBlock('Block P', MONDAY, 3)],
					outline: [outline('Block Q', day(21), 2)],
					decisions: [replanned(['blocks.0'])]
				}),
				{ db }
			);
			expect(await weekOf(2)).toBe(day(7));
		});
	});
});

describe('storeReplan: splice', () => {
	it('shares every block after the taper, its weeks unchanged, and cuts B both sides', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner, splicePlan());
			await storeReplan(owner, splice(), { db });

			const v2 = await getProgramVersion(owner, programId, 2, { db });
			expect(blocksOf(v2)).toEqual([
				['Block A', false, MONDAY, day(13), 2],
				['Block B', false, day(14), day(27), 2],
				['Taper', false, day(28), day(41), 2],
				['Block B', false, day(42), day(48), 1],
				['Block C', false, day(49), day(62), 2],
				['Block D', true, day(63), day(76), 0]
			]);
			const [a, b, c, d] = v1.blocks as StoredBlock[];
			const [a2, head, , tail, c2, d2] = v2.blocks as StoredBlock[];
			// The blocks after the event are the same rows, weeks and all.
			expect([a2, c2, d2]).toEqual([a, c, d]);
			// B's head keeps its lineage; its tail after the event is a new block, its week copied.
			expect(head!.lineage).toBe(b!.lineage);
			expect(tail!.lineage).not.toBe(b!.lineage);
			expect(values(tail!.weeks[0]!)).toEqual(values(b!.weeks[4]!));
			expect(head!.weeks.map(values)).toEqual(b!.weeks.slice(0, 2).map(values));
		});
	});
});

describe('storeReplan: refusals and guards', () => {
	it('refuses a session before from, and a from not a Monday or in the week in progress', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await store(db, owner);
			const early = regenerate({ blocks: [plannedBlock('Block N', day(14), 4)] });
			expect(await errorsOf(storeReplan(owner, early, { db }))).toMatchObject({
				'blocks.0.weeks.0.sessions.0.date': `Squat day on ${day(14)} falls before the re-plan starts, ${day(21)}`,
				'blocks.0.weeks.0.sessions.1.date': `Easy run on ${day(16)} falls before the re-plan starts, ${day(21)}`
			});
			expect(await errorsOf(storeReplan(owner, regenerate({ from: day(22) }), { db }))).toEqual({
				from: 'Start on a Monday'
			});
			// On Wednesday 25 November this week's Monday is already in progress.
			const late = regenerate({ today: day(23) });
			expect(await errorsOf(storeReplan(owner, late, { db }))).toEqual({
				from: `Start on ${day(28)} or later`
			});
			expect((await getVersionHistory(owner, {}, { db }))!.versions).toHaveLength(1);
		});
	});

	it('refuses a from with a session logged or skipped on or after it', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner);
			const run = v1.blocks[1]!.weeks[1]!.sessions[1]!;
			await log(db, owner, programId, run);
			expect(await errorsOf(storeReplan(owner, regenerate(), { db }))).toEqual({
				from: `Easy run on ${day(23)} is logged or skipped: start after it`
			});
		});
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { v1 } = await store(db, owner);
			const squat = v1.blocks[1]!.weeks[2]!.sessions[0]!;
			await reviseProgram(
				owner,
				{
					baseVersionNumber: 1,
					weekLineages: [v1.blocks[1]!.weeks[2]!.lineage],
					apply: async () => ({ sessions: { [squat.lineage]: { status: 'skipped' } } }),
					decision: {
						kind: 'session_skipped',
						summary: 'Skipped',
						why: 'You skipped it.',
						affected: []
					}
				},
				{ db }
			);
			const skipped = regenerate({ baseVersionNumber: 2 });
			expect(await errorsOf(storeReplan(owner, skipped, { db }))).toEqual({
				from: `Squat day on ${day(28)} is logged or skipped: start after it`
			});
		});
	});

	it('writes nothing for a version programPlanSchema refuses', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await store(db, owner);
			const before = await writes(db);
			const gap = regenerate({ blocks: [plannedBlock('Block N', day(28), 2)] });
			expect(await errorsOf(storeReplan(owner, gap, { db }))).toMatchObject({
				'blocks.2.startsOn': `Start on ${day(21)}`
			});
			const first = regenerate({
				decisions: [{ ...replanned(['blocks.2']), kind: 'deload_triggered' }]
			});
			expect(await errorsOf(storeReplan(owner, first, { db }))).toEqual({
				'decisions.0.kind': 'Start with the replanned decision'
			});
			expect(await writes(db)).toEqual(before);
		});
	});

	it('refuses a stale base as a conflict', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { v1 } = await store(db, owner);
			const session = v1.blocks[1]!.weeks[2]!.sessions[0]!;
			await reviseProgram(
				owner,
				{
					baseVersionNumber: 1,
					weekLineages: [v1.blocks[1]!.weeks[2]!.lineage],
					apply: async () => ({ sessions: { [session.lineage]: { notes: 'Belt on' } } }),
					decision: { kind: 'session_moved', summary: 'A note', why: 'You added it.', affected: [] }
				},
				{ db }
			);
			expect(await refusal(storeReplan(owner, regenerate(), { db }))).toBeInstanceOf(
				ProgramConflictError
			);
			await storeReplan(owner, regenerate({ baseVersionNumber: 2 }), { db });
		});
	});

	it('lets exactly one of two concurrent re-plans of the same base succeed', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const { programId } = await store(db, owner);
			const held = await holdTransaction((tx) => storeReplan(owner, regenerate(), { db: tx }));
			const second = storeReplan(owner, regenerate(), { db }).then(
				() => null,
				(err: unknown) => err
			);
			await lockWaiters(1);
			await held.commit();
			expect(await second).toBeInstanceOf(ProgramConflictError);
			const versions = await db
				.select({ number: programVersions.number })
				.from(programVersions)
				.where(eq(programVersions.programId, programId));
			expect(versions.map((v) => v.number).sort()).toEqual([1, 2]);
		});
	});

	it('judges the new block by its input, and the cut block gets no cycle review', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner);
			await storeReplan(owner, regenerate(), { db });

			const split = chooseSplit(INPUT, 1);
			const [full, cut] = [hardSetBand(split, null), hardSetBand(split, 'cut')];
			const weeks = await getMuscleTargets(owner, { from: day(14), to: day(27) }, { db });
			expect(weeks.map((w) => [w.weekStart, w.label, w.band, w.blockLineage])).toEqual([
				[day(14), STORED_TARGET, full.band, v1.blocks[1]!.lineage],
				[
					day(21),
					STORED_TARGET,
					cut.band,
					(await getProgramVersion(owner, programId, 2, { db })).blocks[2]!.lineage
				]
			]);

			// On Tuesday 24 November B (cut on 22 November) has ended, but A is the block to review.
			expect(await reviewableBlock(owner, day(22), { db })).toEqual({
				programId,
				blockLineage: v1.blocks[0]!.lineage,
				reason: 'ended'
			});
		});
	});

	it('sends no UPDATE or DELETE to a guarded table: only the head moves', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await store(db, owner, splicePlan());
			const before = await writes(db);
			await storeReplan(owner, splice(), { db });
			const after = await writes(db);
			for (const table of PROGRAM_TABLES) {
				const [was, now] = [before.get(table), after.get(table)];
				expect([
					table,
					(now?.upd ?? 0) - (was?.upd ?? 0),
					(now?.del ?? 0) - (was?.del ?? 0)
				]).toEqual([table, table === 'programs' ? 1 : 0, 0]);
			}
		});
	});

	it("does not find another owner's program", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await store(db, owner);
			const error = await refusal(storeReplan(crypto.randomUUID(), regenerate(), { db }));
			expect(error).toBeInstanceOf(TrainingNotFoundError);
		});
	});
});

describe('reviseDeload', () => {
	/** B's first week (16 November) deloaded on its Monday: its Wednesday run eased. */
	function deload(v1: ProgramVersion, over: Partial<DeloadRevision> = {}): DeloadRevision {
		const run = v1.blocks[1]!.weeks[0]!.sessions[1]!;
		return {
			baseVersionNumber: 1,
			today: day(14),
			week: day(14),
			targets: { ...TARGETS, rpeCap: 7, volumeFactor: 0.6, runVolumeFactor: 0.6 },
			changes: {
				sessions: { [run.lineage]: { estMinutes: 30, targetRpe: 4 } },
				segments: { [run.lineage]: { 1: { durationSeconds: 1200 } } }
			},
			decisions: [
				{
					kind: 'deload_triggered',
					ruleKey: 'replan.in_place',
					summary: 'Deload in week 3',
					why: 'Fatigue is high. So week 3 becomes a deload.',
					affected: []
				},
				{
					kind: 'load_eased',
					ruleKey: 'replan.in_place',
					summary: 'Easy run eased to RPE 4',
					why: 'The deload eases it.',
					affected: [run.lineage]
				}
			],
			...over
		};
	}

	it('copies only the target week, as a deload, its logged session and later weeks kept', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner);
			const week = v1.blocks[1]!.weeks[0]!;
			const [squat, run] = week.sessions as [StoredSession, StoredSession];
			await log(db, owner, programId, squat);

			await reviseDeload(owner, deload(v1), { db, source: 'rules' });
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			const copied = v2.blocks[1]!.weeks[0]!;
			// Every other week is shared; the target week is a copy with its lineage.
			const ids = new Set(weekIds(v1));
			expect(weekIds(v2).filter((id) => !ids.has(id))).toEqual([copied.id]);
			expect(copied).toMatchObject({ lineage: week.lineage, kind: 'deload' });
			expect(copied.targets).toEqual(deload(v1).targets);
			// The Monday session done earlier is unchanged and keeps its workout link.
			expect(values(copied.sessions[0]!)).toEqual(values(squat));
			expect(await statusOn(owner, day(14), db)).toEqual(['completed']);
			const eased = copied.sessions[1]!;
			expect(eased).toMatchObject({ lineage: run.lineage, estMinutes: 30, targetRpe: 4 });
			expect(eased.kind === 'run' && eased.segments[0]!.durationSeconds).toBe(1200);
			expect(v2.blocks[1]!.weeks.slice(1)).toEqual(v1.blocks[1]!.weeks.slice(1));
			expect(v2.decisions.map((d) => [d.kind, d.affected])).toEqual([
				['deload_triggered', []],
				['load_eased', [run.lineage]]
			]);
		});
	});

	it('refuses a logged or passed session, and decisions that miss an eased session', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner);
			const [squat, run] = v1.blocks[1]!.weeks[0]!.sessions as [StoredSession, StoredSession];
			await log(db, owner, programId, squat);
			const before = await writes(db);

			const loggedChange = deload(v1, {
				changes: { sessions: { [squat.lineage]: { estMinutes: 30 } } },
				decisions: [
					deload(v1).decisions[0]!,
					{ ...deload(v1).decisions[1]!, affected: [squat.lineage] }
				]
			});
			expect(await errorsOf(reviseDeload(owner, loggedChange, { db }))).toEqual({
				[`changes.${squat.lineage}`]: 'Squat day is already logged'
			});
			expect(await errorsOf(reviseDeload(owner, deload(v1, { today: day(17) }), { db }))).toEqual({
				[`changes.${run.lineage}`]: `Easy run on ${day(16)} has passed`
			});
			const unnamed = deload(v1, { decisions: [deload(v1).decisions[0]!] });
			expect(await errorsOf(reviseDeload(owner, unnamed, { db }))).toEqual({
				decisions: 'One load_eased decision per eased session'
			});
			expect(await writes(db)).toEqual(before);
		});
	});
});
