/**
 * Planning a later block on real Postgres (src/lib/server/services/programs/next-block.ts): the
 * outline block becomes planned in version N + 1, with any bridge and the shifted outline, the
 * whole version checked as one plan and nothing planned before the chosen first day. Version N,
 * its weeks and its workouts never change; the new version keeps the input that built the block.
 *
 * Version 1 runs from Monday 2 November 2026: block A, two planned weeks with a Monday strength
 * session and a Wednesday run, then outline B (four weeks from 16 November) and outline C (three
 * weeks from 14 December). The dates come from next-block/dates.ts, as the cycle review's do.
 */
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '../../../src/lib/domain/calendar';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import { buildProgrammingInput } from '../../../src/lib/domain/programming/input';
import { GENERATOR_ID } from '../../../src/lib/domain/programming/next-block/generate';
import {
	nextBlockDates,
	type NextBlockDates,
	type NextBlockStart
} from '../../../src/lib/domain/programming/next-block/dates';
import { chooseSplit } from '../../../src/lib/domain/programming/splits';
import { SCENARIOS } from '../../../src/lib/domain/programming/scenarios';
import { bridgeBlock } from '../../../src/lib/domain/programming/stages/next-shape';
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
	APPEND,
	createProgramFromPlan,
	getProgramVersion,
	getVersionHistory,
	planBlock,
	reviseProgram,
	type BlockPlanning,
	type ProgramVersion,
	type StoredBlock
} from '../../../src/lib/server/services/programs/index';
import {
	ProgramConflictError,
	TrainingInputError,
	TrainingNotFoundError
} from '../../../src/lib/server/services/training/shared';
import { withRollback } from '../helpers';
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

/** `weeks` planned weeks from `monday`: Monday strength and a Wednesday run, from `first` on. */
function plannedBlock(name: string, monday: IsoDate, weeks: number, first = monday): BlockPlan {
	const list = Array.from({ length: weeks }, (_, w): WeekPlan => {
		const startsOn = addDays(monday, 7 * w);
		const sessions = [squatDay(startsOn), easyRun(addDays(startsOn, 2))];
		return {
			kind: 'accumulation',
			startsOn,
			endsOn: addDays(startsOn, 6),
			targets: TARGETS,
			sessions: sessions.filter((s) => s.date >= first)
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

function programPlan(withOutline = true): ProgramPlan {
	return {
		title: 'Get stronger',
		startsOn: MONDAY,
		firstPlannedDay: MONDAY,
		blocks: [
			plannedBlock('Block A', MONDAY, 2),
			...(withOutline ? [outline('Block B', day(14), 4), outline('Block C', day(42), 3)] : [])
		],
		decisions: []
	};
}

/** The input a build stores; the next block's is the same profile on a cut. */
const INPUT = buildProgrammingInput(SCENARIOS.beginner(), { catalogue: CATALOGUE });
const NEXT_INPUT = { ...INPUT, nutritionPhase: 'cut' as const };
const snapshot = (input: object) => input as Record<string, unknown>;

async function store(db: Executor, owner: string, withOutline = true) {
	const origin = { source: 'rules' as const, generator: 'm3-test/1', snapshot: snapshot(INPUT) };
	const { programId } = await createProgramFromPlan(owner, programPlan(withOutline), origin, {
		db
	});
	return { programId, v1: await getProgramVersion(owner, programId, 1, { db }) };
}

/** next-block/dates.ts's dates for reviewing block A on `today`. */
function datesFor(v1: ProgramVersion, today: IsoDate, start: NextBlockStart): NextBlockDates {
	return nextBlockDates({
		blocks: v1.blocks,
		reviewedBlock: 0,
		today,
		start,
		events: [],
		weeks: 4
	});
}

const decision = (over: Partial<DecisionPlan>): DecisionPlan => ({
	kind: 'next_block_planned',
	ruleKey: 'next_block.planned',
	summary: 'Block B is planned',
	why: 'It is the build phase your plan outlined.',
	decidedBy: 'rules',
	refs: ['blocks.0'],
	evidence: {},
	...over
});

/** A planning of the outline block (or APPEND) on version 1 from `dates`, as the review stores it. */
function planning(
	v1: ProgramVersion,
	dates: NextBlockDates,
	over: Partial<BlockPlanning> = {}
): BlockPlanning {
	const [, b, ...rest] = v1.blocks;
	const { startsOn, weeks } = dates.block;
	return {
		baseVersionNumber: 1,
		blockLineage: b?.lineage ?? APPEND,
		...(dates.bridge && { bridge: bridgeBlock(dates.bridge) }),
		block: plannedBlock('Block B', startsOn, weeks, dates.firstPlannedDay),
		shifted: dates.shifted.map((d, i) => ({
			lineage: rest[i]!.lineage,
			startsOn: d.startsOn,
			endsOn: d.endsOn
		})),
		firstPlannedDay: dates.firstPlannedDay,
		decisions: [decision({}), decision({ refs: ['blocks.0.weeks.0.sessions.0'] })],
		createdBy: 'rules',
		summary: 'Block B planned from your results',
		origin: {
			generator: GENERATOR_ID,
			fingerprint: 'fp-next-1',
			digest: 'catalogue-1',
			snapshot: snapshot(NEXT_INPUT)
		},
		...over
	};
}

/** The error a call was refused with (fails the test if it was not refused). */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!error) throw new Error('expected the call to be refused');
	return error;
}

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

/** Rows inserted, updated and deleted in each program table so far in this transaction. */
async function writes(db: Executor) {
	const { rows } = await db.execute<{ table: string; ins: number; upd: number; del: number }>(
		sql`select relname as table, n_tup_ins::int as ins, n_tup_upd::int as upd, n_tup_del::int as del
			from pg_stat_xact_user_tables where relname in ${sql.raw(`('${PROGRAM_TABLES.join("','")}')`)}`
	);
	return new Map(rows.map((r) => [r.table, r]));
}

const blocksOf = (v: ProgramVersion) =>
	v.blocks.map((b) => [b.name, b.outline, b.startsOn, b.endsOn, b.weeks.length]);
const sessionDates = (b: StoredBlock) => b.weeks.flatMap((w) => w.sessions.map((s) => s.date));

describe('planBlock', () => {
	it('plans the outline block with its lineage, its weeks inside its dates, the rest shared', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner);
			const dates = datesFor(v1, day(13), 'this_week');
			const stored = await planBlock(owner, planning(v1, dates), { db });
			expect(stored).toMatchObject({ programId, number: 2 });

			const v2 = await getProgramVersion(owner, programId, 2, { db });
			expect(blocksOf(v2)).toEqual([
				['Block A', false, MONDAY, day(13), 2],
				['Block B', false, day(14), day(41), 4],
				['Block C', true, day(42), day(62), 0]
			]);
			const [a, b, c] = v2.blocks as [StoredBlock, StoredBlock, StoredBlock];
			// Block A is shared, row for row; B and C are new rows with their lineages.
			expect(a).toEqual(v1.blocks[0]);
			expect([b.lineage, c.lineage]).toEqual([v1.blocks[1]!.lineage, v1.blocks[2]!.lineage]);
			expect([b.id, c.id]).not.toContain(v1.blocks[1]!.id);
			for (const week of b.weeks) {
				expect(week.startsOn >= b.startsOn && week.endsOn <= b.endsOn).toBe(true);
				for (const s of week.sessions)
					expect(s.date >= week.startsOn && s.date <= week.endsOn).toBe(true);
			}
			expect(sessionDates(b)).toHaveLength(8);
			expect(v2.version).toMatchObject({ createdBy: 'rules', current: true });
			expect(v2.version.summary).toBe('Block B planned from your results');
		});
	});

	it("appends a block after the last when there is no outline left ('append')", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner, false);
			const dates = datesFor(v1, day(13), 'this_week');
			expect(dates.block.outline).toBeNull();
			await planBlock(owner, planning(v1, dates), { db });

			const v2 = await getProgramVersion(owner, programId, 2, { db });
			expect(blocksOf(v2)).toEqual([
				['Block A', false, MONDAY, day(13), 2],
				['Block B', false, day(14), day(41), 4]
			]);
			expect(v2.blocks[1]!.lineage).not.toBe(v2.blocks[0]!.lineage);
			const positions = await db.execute<{ position: number }>(
				sql`select b.position from program_blocks b join program_version_blocks m on m.block_id = b.id
					where m.version_id = ${v2.version.id} order by b.position`
			);
			expect(positions.rows.map((r) => r.position)).toEqual([1, 2]);
		});
	});

	it("plans a 13th block: a later version is not held to a first plan's 12", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId } = await store(db, owner, false);
			// Block A runs two weeks; each later cycle appends a one-week block after the last.
			for (let n = 1; n <= 12; n++) {
				const monday = day(7 + 7 * n);
				const block = plannedBlock(`Block ${n + 1}`, monday, 1);
				await planBlock(
					owner,
					{
						baseVersionNumber: n,
						blockLineage: APPEND,
						block,
						shifted: [],
						firstPlannedDay: monday,
						decisions: [],
						createdBy: 'rules',
						summary: `Block ${n + 1} planned`,
						origin: {}
					},
					{ db }
				);
			}
			const v13 = await getProgramVersion(owner, programId, 13, { db });
			expect(v13.blocks).toHaveLength(13);
			expect(v13.blocks.at(-1)).toMatchObject({ name: 'Block 13', startsOn: day(91) });
		});
	});

	it('stores a three-week-late plan as a bridge and the shifted outline, one valid version', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner);
			// Reviewed on Thursday 3 December, starting the Monday after: three weeks late.
			const dates = datesFor(v1, day(31), 'next_monday');
			expect(dates.bridge).toEqual({ startsOn: day(14), endsOn: day(34), weeks: 3 });
			await planBlock(owner, planning(v1, dates), { db });

			const v2 = await getProgramVersion(owner, programId, 2, { db });
			expect(blocksOf(v2)).toEqual([
				['Block A', false, MONDAY, day(13), 2],
				['Between blocks', false, day(14), day(34), 3],
				['Block B', false, day(35), day(62), 4],
				['Block C', true, day(63), day(83), 0]
			]);
			const bridge = v2.blocks[1]!;
			expect(bridge.phase).toBe('transition');
			expect(bridge.weeks.map((w) => [w.kind, w.sessions.length])).toEqual([
				['unplanned', 0],
				['unplanned', 0],
				['unplanned', 0]
			]);
			expect(v1.blocks.map((b) => b.lineage)).not.toContain(bridge.lineage);
			// The version read back is one plan programPlanSchema accepts.
			expect(programPlanSchema.safeParse({ ...v2, decisions: [] }).success).toBe(true);
		});
	});

	it("refuses a 'this week' plan from a Wednesday with a Monday session, before any write", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { v1 } = await store(db, owner);
			const wednesday = day(16);
			const dates = datesFor(v1, wednesday, 'this_week');
			expect(dates).toMatchObject({ firstPlannedDay: wednesday, block: { startsOn: day(14) } });
			const block = plannedBlock('Block B', day(14), 4);
			const before = await writes(db);

			const error = await refusal(planBlock(owner, planning(v1, dates, { block }), { db }));
			expect(error).toBeInstanceOf(TrainingInputError);
			expect((error as TrainingInputError).errors).toEqual({
				'block.weeks.0.sessions.0.date': `Squat day on ${day(14)} falls before the first planned day, ${wednesday}`
			});
			expect(await writes(db)).toEqual(before);
			// From Wednesday on, the same week is accepted.
			await planBlock(owner, planning(v1, dates), { db });
		});
	});

	it("refuses a gap or an overlap with checkPlan's message, before any write", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { v1 } = await store(db, owner);
			const dates = datesFor(v1, day(13), 'this_week');
			const before = await writes(db);

			const gap = planning(v1, dates, { block: plannedBlock('Block B', day(21), 3) });
			const late = await refusal(planBlock(owner, gap, { db }));
			expect((late as TrainingInputError).errors).toMatchObject({
				'blocks.1.startsOn': `Start on ${day(14)}`
			});

			const overlap = planning(v1, dates);
			overlap.shifted = [{ ...overlap.shifted[0]!, startsOn: day(35), endsOn: day(55) }];
			const early = await refusal(planBlock(owner, overlap, { db }));
			expect((early as TrainingInputError).errors).toEqual({
				'blocks.2.startsOn': `Start on ${day(42)}`
			});
			expect(await writes(db)).toEqual(before);
			expect((await getVersionHistory(owner, {}, { db }))!.versions).toHaveLength(1);
		});
	});

	it('stores its generator and input, and targets.ts judges that block by it', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner);
			const dates = datesFor(v1, day(13), 'this_week');
			const { versionId } = await planBlock(owner, planning(v1, dates), { db });

			const [row] = await db
				.select()
				.from(programVersions)
				.where(eq(programVersions.id, versionId));
			expect(row).toMatchObject({
				generator: GENERATOR_ID,
				inputFingerprint: 'fp-next-1',
				catalogueDigest: 'catalogue-1',
				inputSnapshot: JSON.parse(JSON.stringify(NEXT_INPUT))
			});

			const split = chooseSplit(INPUT, 1);
			const [full, cut] = [hardSetBand(split, null), hardSetBand(split, 'cut')];
			const weeks = await getMuscleTargets(owner, { from: MONDAY, to: day(20) }, { db });
			expect(weeks.map((w) => [w.weekStart, w.source, w.label, w.programId, w.band])).toEqual([
				[MONDAY, 'block', STORED_TARGET, programId, full.band],
				[day(7), 'block', STORED_TARGET, programId, full.band],
				[day(14), 'block', STORED_TARGET, programId, cut.band]
			]);
			expect(weeks[2]!.blockLineage).toBe(v1.blocks[1]!.lineage);
			expect(cut.band).not.toBe(full.band);
		});
	});

	it('leaves version 1 as it was, its workouts on their lineages, bridge weeks off-plan', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner);
			const monday = v1.blocks[0]!.weeks[0]!.sessions[0]!;
			const log = async (date: IsoDate, session: typeof monday | null) => {
				const startedAt = new Date(`${date}T07:00:00Z`);
				const [row] = await db
					.insert(workouts)
					.values({
						ownerId: owner,
						clientId: crypto.randomUUID(),
						kind: 'strength',
						discipline: 'strength',
						sessionType: 'strength',
						title: 'Squat day',
						plannedSessionId: session?.id ?? null,
						plannedLineageId: session?.lineage ?? null,
						programId: session ? programId : null,
						status: 'completed',
						startedAt,
						finishedAt: new Date(startedAt.getTime() + 3_600_000)
					})
					.returning();
				return row!;
			};
			const planned = await log(monday.date, monday);
			const offPlan = await log(day(16), null);

			await planBlock(owner, planning(v1, datesFor(v1, day(31), 'next_monday')), { db });

			const v1Again = await getProgramVersion(owner, programId, 1, { db });
			expect(v1Again).toEqual({ ...v1, version: { ...v1.version, current: false } });
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			const session = v2.blocks[0]!.weeks[0]!.sessions[0]!;
			expect([session.id, session.lineage]).toEqual([
				planned.plannedSessionId,
				planned.plannedLineageId
			]);
			const [bridge] = v2.blocks.filter((b) => b.phase === 'transition');
			expect(bridge!.weeks.some((w) => w.startsOn <= day(16) && w.endsOn >= day(16))).toBe(true);
			expect(sessionDates(bridge!)).toEqual([]);
			expect(await db.select().from(workouts).where(eq(workouts.ownerId, owner))).toEqual(
				expect.arrayContaining([planned, offPlan])
			);
		});
	});

	it("stores the decisions with the new rows' lineages", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1 } = await store(db, owner);
			const dates = datesFor(v1, day(31), 'next_monday');
			// A ref outside the new block is refused.
			const stray = planning(v1, dates, { decisions: [decision({ refs: ['blocks.1'] })] });
			const error = await refusal(planBlock(owner, stray, { db }));
			expect((error as TrainingInputError).errors).toEqual({
				'decisions.0.refs.0': 'Name a part of the new block'
			});
			await planBlock(owner, planning(v1, dates), { db });

			const v2 = await getProgramVersion(owner, programId, 2, { db });
			const block = v2.blocks.find((b) => b.name === 'Block B')!;
			const first = block.weeks[0]!.sessions[0]!;
			expect(v2.decisions.map((d) => [d.kind, d.ruleKey, d.decidedBy, d.affected])).toEqual([
				['next_block_planned', 'next_block.planned', 'rules', [v1.blocks[1]!.lineage]],
				['next_block_planned', 'next_block.planned', 'rules', [first.lineage]]
			]);
		});
	});

	it('refuses a stale base as a conflict', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { v1 } = await store(db, owner);
			const session = v1.blocks[0]!.weeks[1]!.sessions[0]!;
			await reviseProgram(
				owner,
				{
					baseVersionNumber: 1,
					weekLineages: [v1.blocks[0]!.weeks[1]!.lineage],
					apply: async () => ({ sessions: { [session.lineage]: { notes: 'Belt on' } } }),
					decision: {
						kind: 'session_moved',
						summary: 'A note',
						why: 'You added it.',
						affected: [session.lineage]
					}
				},
				{ db }
			);
			const dates = datesFor(v1, day(13), 'this_week');
			const error = await refusal(planBlock(owner, planning(v1, dates), { db }));
			expect(error).toBeInstanceOf(ProgramConflictError);
			// On the current version it plans.
			await planBlock(owner, planning(v1, dates, { baseVersionNumber: 2 }), { db });
		});
	});

	it('sends no UPDATE or DELETE to a guarded table: only the head moves', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { v1 } = await store(db, owner);
			const before = await writes(db);
			await planBlock(owner, planning(v1, datesFor(v1, day(31), 'next_monday')), { db });
			const after = await writes(db);
			for (const table of PROGRAM_TABLES) {
				const [was, now] = [before.get(table), after.get(table)];
				const updated = (now?.upd ?? 0) - (was?.upd ?? 0);
				expect([table, updated, (now?.del ?? 0) - (was?.del ?? 0)]).toEqual([
					table,
					table === 'programs' ? 1 : 0,
					0
				]);
			}
			expect(
				(after.get('planned_sessions')?.ins ?? 0) - (before.get('planned_sessions')?.ins ?? 0)
			).toBe(8);
		});
	});

	it("does not find another owner's program", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { v1 } = await store(db, owner);
			const stranger = crypto.randomUUID();
			const dates = datesFor(v1, day(13), 'this_week');
			const error = await refusal(planBlock(stranger, planning(v1, dates), { db }));
			expect(error).toBeInstanceOf(TrainingNotFoundError);
			expect((await getVersionHistory(owner, {}, { db }))!.versions).toHaveLength(1);
		});
	});
});
