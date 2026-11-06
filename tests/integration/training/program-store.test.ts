/**
 * The program store on real Postgres (src/lib/server/services/programs, ADR 0010): a ProgramPlan
 * stored as program version 1 in one transaction and a fixed number of statements, validated at
 * the boundary, with its exercises resolved to library rows and its decisions to lineages, and
 * read back whole. This is the brief's chain: profile → program → version → block → week →
 * retrieve, with strength, running and Muay Thai in one week.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { programPlanSchema } from '../../../src/lib/domain/training/schemas';
import type { ProgramPlan, StrengthSessionPlan } from '../../../src/lib/domain/training/types';
import { validate } from '../../../src/lib/domain/validation';
import {
	exercises,
	plannedExercises,
	plannedRunSegments,
	plannedSessionDetails,
	programs,
	programVersions,
	setPrescriptions,
	type Executor
} from '../../../src/lib/server/db';
import {
	createCustomExercise,
	resolveKeys
} from '../../../src/lib/server/services/exercises/index';
import { createGoal, saveSchedule } from '../../../src/lib/server/services/profile';
import {
	createProgramFromPlan,
	getProgramVersion,
	ProgramExistsError,
	type CreatedProgram,
	type ProgramOrigin,
	type ProgramVersion
} from '../../../src/lib/server/services/programs/index';
import {
	ConflictError,
	TrainingInputError,
	TrainingNotFoundError
} from '../../../src/lib/server/services/training/shared';
import {
	PROGRAM_FIXTURES,
	programFixture,
	type ProgramFixture
} from '../../../src/lib/server/test-support/program-fixtures';
import { holdTransaction, lockWaiters, withCommitted, withRollback } from '../helpers';
import { clock, generalGoal, makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const TODAY = '2026-11-11';
const fixture = (name: ProgramFixture) => programFixture(name, { monday: MONDAY, today: TODAY });

const ORIGIN: ProgramOrigin = {
	source: 'rules',
	generator: 'perfo-programming/1',
	fingerprint: '0123456789abcdef',
	digest: 'fedcba9876543210',
	snapshot: { daysPerWeek: 4, goals: [] }
};

/** Every table a stored program writes to. */
const TREE_TABLES = [
	'programs',
	'program_versions',
	'program_blocks',
	'program_version_blocks',
	'program_weeks',
	'program_version_weeks',
	'planned_sessions',
	'planned_exercises',
	'set_prescriptions',
	'planned_run_segments',
	'planned_session_details',
	'programming_decisions'
];

async function counts(db: Executor) {
	const result: Record<string, number> = {};
	for (const table of TREE_TABLES) {
		const { rows } = await db.execute<{ n: number }>(
			sql`select count(*)::int as n from ${sql.identifier(table)}`
		);
		result[table] = rows[0]!.n;
	}
	return result;
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

async function inputErrors(promise: Promise<unknown>) {
	const error = await refusal(promise);
	expect(error).toBeInstanceOf(TrainingInputError);
	return (error as TrainingInputError).errors;
}

const ROW_ONLY = new Set(['id', 'lineage', 'status', 'movedFrom']);

/** Plain data without the keys only a stored row has. */
function withoutRowKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutRowKeys);
	if (value && typeof value === 'object' && !(value instanceof Date)) {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => !ROW_ONLY.has(key))
				.map(([key, field]) => [key, withoutRowKeys(field)])
		);
	}
	return value;
}

const sessionsOf = (stored: ProgramVersion) =>
	stored.blocks.flatMap((b) => b.weeks.flatMap((w) => w.sessions));

/** A stored version as the plan it was stored from, once every session reads as planned. */
function asPlan(stored: ProgramVersion): Omit<ProgramPlan, 'decisions'> {
	for (const session of sessionsOf(stored)) {
		expect(session).toMatchObject({ status: 'planned', movedFrom: null });
	}
	const { title, startsOn, firstPlannedDay, blocks } = stored;
	return {
		title,
		startsOn,
		firstPlannedDay,
		blocks: withoutRowKeys(blocks) as ProgramPlan['blocks']
	};
}

const treeOf = ({ decisions: _, ...plan }: ProgramPlan) => plan;

/** The lineage of the node a plan path names, in the stored tree. */
function lineageAt(stored: ProgramVersion, path: string): string {
	const parts = path.split('.');
	let node: unknown = stored;
	for (let i = 0; i < parts.length; i += 2) {
		node = (node as Record<string, unknown[]>)[parts[i]!]![Number(parts[i + 1])];
	}
	return (node as { lineage: string }).lineage;
}

async function store(db: Executor, owner: string, plan: ProgramPlan, origin = ORIGIN) {
	const created = await createProgramFromPlan(owner, plan, origin, { db });
	return { created, stored: await getProgramVersion(owner, created.programId, 1, { db }) };
}

describe('storing a program plan as version 1', () => {
	it('runs the brief chain: profile → program → version 1 → blocks and weeks → read back', async () => {
		await withRollback(async (db) => {
			const time = clock('2026-11-06T09:00:00Z');
			const owner = await makeOwner(db);
			const goal = await createGoal(owner, generalGoal(), { db });
			const schedule = await saveSchedule(
				owner,
				{
					daysPerWeek: 4,
					availableDays: ['mon', 'tue', 'wed', 'thu'],
					preferredTimes: ['morning', 'evening'],
					sessionMinutes: 60,
					constraints: null,
					commitments: [
						{
							discipline: 'muay_thai',
							label: 'Muay Thai class',
							days: ['tue', 'thu'],
							timeOfDay: 'evening',
							durationMinutes: 90,
							intensity: 'hard',
							notes: null
						}
					]
				},
				{ db }
			);
			const plan = programFixture('hybrid', {
				monday: MONDAY,
				today: TODAY,
				goalRefs: [goal.id],
				commitmentRef: schedule.commitments[0]!.id
			});

			const created = await createProgramFromPlan(owner, plan, ORIGIN, { db, now: time.now });
			expect(created).toEqual({
				programId: expect.any(String),
				versionId: expect.any(String),
				created: true
			});
			const [head] = await db.select().from(programs).where(eq(programs.ownerId, owner));
			expect(head).toMatchObject({
				id: created.programId,
				title: plan.title,
				status: 'active',
				currentVersionId: created.versionId,
				createdAt: time.now()
			});

			const stored = await getProgramVersion(owner, created.programId, 1, { db });
			expect(stored).toMatchObject({ programId: created.programId, status: 'active' });
			expect(stored.version).toEqual({
				id: created.versionId,
				number: 1,
				createdBy: 'rules',
				summary: 'Your first program',
				createdAt: time.now(),
				current: true,
				parentVersionId: null,
				generator: ORIGIN.generator,
				inputFingerprint: ORIGIN.fingerprint,
				catalogueDigest: ORIGIN.digest,
				inputSnapshot: ORIGIN.snapshot
			});
			expect(stored.blocks.map((b) => [b.phase, b.weeks.length])).toEqual([
				['baseline', 1],
				['accumulation', 4]
			]);
			// Every field of every block, week, session, exercise, set, segment and detail.
			expect(asPlan(stored)).toEqual(treeOf(plan));
			expect(stored.blocks[0]!.goalRefs).toEqual([goal.id]);
			expect(sessionsOf(stored).filter((s) => s.source === 'commitment')).toHaveLength(10);
		});
	});

	it('keeps strength, an interval run and a Muay Thai class in one week, each in its own rows', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { stored } = await store(db, owner, fixture('hybrid'));
			const [strength, tuesdayClass, intervals, easy, thursdayClass] =
				stored.blocks[0]!.weeks[0]!.sessions;

			expect([strength, tuesdayClass, intervals, easy, thursdayClass].map((s) => s!.kind)).toEqual([
				'strength',
				'other',
				'run',
				'run',
				'other'
			]);
			expect([easy!.date, easy!.orderInDay, easy!.timeOfDay]).toEqual([
				addDays(MONDAY, 3),
				1,
				'morning'
			]);
			expect(thursdayClass).toMatchObject({
				date: addDays(MONDAY, 3),
				orderInDay: 2,
				timeOfDay: 'evening'
			});

			const lifts = await db
				.select({
					id: plannedExercises.id,
					position: plannedExercises.position,
					key: exercises.key
				})
				.from(plannedExercises)
				.innerJoin(exercises, eq(exercises.id, plannedExercises.exerciseId))
				.where(eq(plannedExercises.sessionId, strength!.id))
				.orderBy(plannedExercises.position);
			expect(lifts.map((l) => [l.position, l.key])).toEqual([
				[1, 'power_clean'],
				[2, 'back_squat'],
				[3, 'bench_press'],
				[4, 'barbell_row']
			]);
			const squatSets = await db
				.select({ position: setPrescriptions.position, role: setPrescriptions.role })
				.from(setPrescriptions)
				.where(eq(setPrescriptions.plannedExerciseId, lifts[1]!.id))
				.orderBy(setPrescriptions.position);
			expect(squatSets).toEqual([
				{ position: 1, role: 'top' },
				{ position: 2, role: 'back_off' }
			]);

			const segments = await db
				.select()
				.from(plannedRunSegments)
				.where(eq(plannedRunSegments.sessionId, intervals!.id))
				.orderBy(plannedRunSegments.position);
			expect(segments.map((s) => [s.position, s.kind, s.repeatGroup, s.repeats])).toEqual([
				[1, 'warm_up', null, null],
				[2, 'interval', 1, 6],
				[3, 'recovery', 1, 6],
				[4, 'cool_down', null, null]
			]);

			const [details] = await db
				.select()
				.from(plannedSessionDetails)
				.where(eq(plannedSessionDetails.sessionId, thursdayClass!.id));
			expect(details).toMatchObject({ kind: 'class', durationMinutes: 90, targetRpe: 7 });
			expect(details!.metrics.map((m) => m.key)).toEqual([
				'rounds',
				'round_length',
				'sparring',
				'focus'
			]);
		});
	});

	it('stores each decision with the lineages of what its plan paths name', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const plan = fixture('hybrid');
			const { created, stored } = await store(db, owner, plan);

			expect(stored.decisions).toEqual(
				plan.decisions.map(({ refs, ...decision }) => ({
					...decision,
					id: expect.any(Number),
					affected: refs.map((ref) => lineageAt(stored, ref)),
					createdAt: expect.any(Date)
				}))
			);
			// Paths reach every depth: a block, a session and a strength exercise.
			const affected = stored.decisions.flatMap((d) => d.affected);
			const exercise = stored.blocks[0]!.weeks[0]!.sessions[0] as {
				exercises: { lineage: string }[];
			};
			expect(affected).toEqual(
				expect.arrayContaining([
					stored.blocks[1]!.lineage,
					stored.blocks[0]!.weeks[0]!.sessions[4]!.lineage,
					exercise.exercises[0]!.lineage
				])
			);
			// Lineages are each node's own.
			const lineages = stored.blocks.flatMap((b) => [
				b.lineage,
				...b.weeks.flatMap((w) => [
					w.lineage,
					...w.sessions.flatMap((s) => [
						s.lineage,
						...(s.kind === 'strength' ? s.exercises.map((e) => e.lineage) : [])
					])
				])
			]);
			expect(new Set(lineages).size).toBe(lineages.length);
			const rows = await db.execute<{ version_id: string; program_id: string }>(
				sql`select version_id, program_id from programming_decisions where program_id = ${created.programId}`
			);
			expect(rows.rows).toHaveLength(plan.decisions.length);
			expect(new Set(rows.rows.map((r) => r.version_id))).toEqual(new Set([created.versionId]));
		});
	});
});

describe('the store validates its own input', () => {
	it('refuses an invalid plan with field errors at dotted paths, and writes nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const before = await counts(db);

			const rpe11 = fixture('hybrid');
			const strength = rpe11.blocks[0]!.weeks[0]!.sessions[0] as StrengthSessionPlan;
			strength.exercises[1]!.sets[0]!.targetRpe = 11;
			expect(await inputErrors(createProgramFromPlan(owner, rpe11, ORIGIN, { db }))).toEqual({
				'blocks.0.weeks.0.sessions.0.exercises.1.sets.0.targetRpe': 'RPE 5 to 10, in half steps'
			});

			const outside = fixture('hybrid');
			outside.blocks[0]!.weeks[0]!.sessions[2]!.date = addDays(MONDAY, 7);
			expect(await inputErrors(createProgramFromPlan(owner, outside, ORIGIN, { db }))).toEqual({
				'blocks.0.weeks.0.sessions.2.date': 'In its week'
			});

			expect(await counts(db)).toEqual(before);
		});
	});

	it("refuses exercises outside the owner's library at their paths, and writes nothing", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const theirs = await createCustomExercise(crypto.randomUUID(), sandbag, { db });
			const [benchRow] = (await resolveKeys(['bench_press'], { db })).values();
			const before = await counts(db);

			const plan = fixture('hybrid');
			const strength = plan.blocks[1]!.weeks[2]!.sessions[0] as StrengthSessionPlan;
			strength.exercises[0]!.exercise = { key: 'no_such_lift' };
			strength.exercises[2]!.exercise = { customId: theirs.id };
			// A catalogue row by id is not one of the owner's own.
			strength.exercises[3]!.exercise = { customId: benchRow!.id };
			strength.exercises[3]!.substitutedFrom = { key: 'barbell_curl_of_doom' };
			strength.exercises[3]!.substitutionReason = 'equipment_unavailable';

			const at = 'blocks.1.weeks.2.sessions.0.exercises';
			expect(await inputErrors(createProgramFromPlan(owner, plan, ORIGIN, { db }))).toEqual({
				[`${at}.0.exercise`]: 'Not in your exercise library',
				[`${at}.2.exercise`]: 'Not in your exercise library',
				[`${at}.3.exercise`]: 'Not in your exercise library',
				[`${at}.3.substitutedFrom`]: 'Not in your exercise library'
			});
			expect(await counts(db)).toEqual(before);
		});
	});

	it("resolves a retired catalogue key and the owner's own exercises, swaps included", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const own = await createCustomExercise(owner, sandbag, { db });
			// Another preview's seed retired it: a stored program still resolves it.
			await db
				.update(exercises)
				.set({ retiredAt: new Date() })
				.where(eq(exercises.key, 'barbell_row'));

			const plan = fixture('one-week');
			const strength = plan.blocks[0]!.weeks[0]!.sessions[0] as StrengthSessionPlan;
			strength.exercises[2]!.exercise = { customId: own.id };
			strength.exercises[2]!.substitutedFrom = { key: 'bench_press' };
			strength.exercises[2]!.substitutionReason = 'equipment_unavailable';
			const { stored } = await store(db, owner, plan);

			expect(asPlan(stored)).toEqual(treeOf(plan));
			const rows = await db
				.select({
					exerciseId: plannedExercises.exerciseId,
					from: plannedExercises.substitutedFromExerciseId
				})
				.from(plannedExercises)
				.where(
					and(
						eq(plannedExercises.sessionId, sessionsOf(stored)[0]!.id),
						inArray(plannedExercises.position, [3, 4])
					)
				)
				.orderBy(plannedExercises.position);
			const keys = await resolveKeys(['barbell_row', 'bench_press'], { db });
			expect(rows).toEqual([
				{ exerciseId: own.id, from: keys.get('bench_press')!.id },
				{ exerciseId: keys.get('barbell_row')!.id, from: null }
			]);
		});
	});
});

describe('reading a version', () => {
	it('shows another owner nothing, and a malformed or unknown version is not found', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { created } = await store(db, owner, fixture('one-week'));
			const notFound = async (ownerId: string, programId: string, number: number) =>
				expect(await refusal(getProgramVersion(ownerId, programId, number, { db }))).toBeInstanceOf(
					TrainingNotFoundError
				);

			await notFound(crypto.randomUUID(), created.programId, 1);
			await notFound(owner, created.programId, 2);
			await notFound(owner, created.programId, 0);
			await notFound(owner, created.programId, 1.5);
			await notFound(owner, created.programId, 2 ** 31);
			await notFound(owner, 'not-a-uuid', 1);
			await notFound(owner, crypto.randomUUID(), 1);
		});
	});
});

describe('one active program per owner', () => {
	it('refuses a second build, unless it repeats the stored one before any revision', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const first = await createProgramFromPlan(owner, fixture('hybrid'), ORIGIN, { db });
			const stored = await counts(db);

			// A double tap or a retried request: the same fingerprint returns the program as it is.
			expect(await createProgramFromPlan(owner, fixture('hybrid'), ORIGIN, { db })).toEqual({
				...first,
				created: false
			});
			expect(await counts(db)).toEqual(stored);

			const exists = async (origin: ProgramOrigin) => {
				const error = await refusal(
					createProgramFromPlan(owner, fixture('one-week'), origin, { db })
				);
				expect(error).toBeInstanceOf(ProgramExistsError);
				expect(error).toBeInstanceOf(ConflictError);
				expect(error).toMatchObject({ reason: 'program_exists', programId: first.programId });
			};
			await exists({ ...ORIGIN, fingerprint: 'another-profile' });
			await exists({ source: 'owner' });

			// Once revised, even the same build is a second program.
			const [v2] = await db
				.insert(programVersions)
				.values({
					programId: first.programId,
					number: 2,
					parentVersionId: first.versionId,
					createdBy: 'owner',
					summary: 'Moved a session',
					startsOn: MONDAY,
					firstPlannedDay: MONDAY
				})
				.returning();
			await db
				.update(programs)
				.set({ currentVersionId: v2!.id })
				.where(eq(programs.id, first.programId));
			await exists(ORIGIN);
			expect(await counts(db)).toEqual({
				...stored,
				program_versions: stored.program_versions! + 1
			});

			// An archived program no longer counts.
			await db
				.update(programs)
				.set({ status: 'archived', archivedAt: new Date() })
				.where(eq(programs.id, first.programId));
			const next = await createProgramFromPlan(owner, fixture('one-week'), ORIGIN, { db });
			expect(next).toMatchObject({ created: true });
			expect(next.programId).not.toBe(first.programId);
		});
	});

	it('never takes a plan without a fingerprint for a repeat, as for a fixture', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const first = await createProgramFromPlan(
				owner,
				fixture('today'),
				{ source: 'owner' },
				{ db }
			);
			const error = await refusal(
				createProgramFromPlan(owner, fixture('today'), { source: 'owner' }, { db })
			);
			expect(error).toMatchObject({ name: 'ProgramExistsError', programId: first.programId });
		});
	});

	it('serialises two builds of the same plan on separate connections: the second returns the first', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			let first: CreatedProgram | undefined;
			const held = await holdTransaction(async (tx) => {
				first = await createProgramFromPlan(owner, fixture('one-week'), ORIGIN, { db: tx });
			});
			const second = createProgramFromPlan(owner, fixture('one-week'), ORIGIN, { db });
			await lockWaiters(1);
			await held.commit();

			expect(await second).toEqual({ ...first, created: false });
			const rows = await db.select().from(programs).where(eq(programs.ownerId, owner));
			expect(rows).toHaveLength(1);
		});
	});
});

/** Every statement the pg driver sends while `work` runs. */
async function statements(work: () => Promise<unknown>): Promise<number> {
	const spy = vi.spyOn(pg.Client.prototype, 'query');
	try {
		await work();
		return spy.mock.calls.length;
	} finally {
		spy.mockRestore();
	}
}

describe('bulk writes', () => {
	it('stores a five-week plan in the same few statements as a one-week plan', async () => {
		const sent: Record<string, number> = {};
		const rows: Record<string, number> = {};
		for (const name of ['hybrid', 'one-week'] as const) {
			await withRollback(async (db) => {
				const owner = await makeOwner(db);
				const before = await counts(db);
				sent[name] = await statements(() =>
					createProgramFromPlan(owner, fixture(name), ORIGIN, { db })
				);
				const after = await counts(db);
				rows[name] = TREE_TABLES.reduce((n, table) => n + after[table]! - before[table]!, 0);
			});
		}
		// Five weeks are over a hundred rows, yet one multi-row insert per table.
		expect(rows.hybrid).toBeGreaterThan(100);
		expect(rows.hybrid).toBeGreaterThan(3 * rows['one-week']!);
		expect(sent.hybrid).toBe(sent['one-week']);
		expect(sent.hybrid).toBeLessThanOrEqual(20);
	});
});

describe('the program fixtures', () => {
	it('each passes programPlanSchema unchanged and stores as it is', async () => {
		for (const name of PROGRAM_FIXTURES) {
			const plan = fixture(name);
			expect(validate(programPlanSchema, plan), name).toEqual({ ok: true, data: plan });
			await withRollback(async (db) => {
				const owner = await makeOwner(db);
				const { stored } = await store(db, owner, plan);
				expect(asPlan(stored), name).toEqual(treeOf(plan));
			});
		}
	});

	it('plans today, or a rest day, around any weekday of week 1, and the week after', () => {
		for (let day = 0; day < 7; day++) {
			const today = addDays(MONDAY, day);
			for (const name of ['today', 'today-rest'] as const) {
				const plan = programFixture(name, { monday: MONDAY, today });
				expect(validate(programPlanSchema, plan).ok, `${name} on ${today}`).toBe(true);
				const [week1, week2] = plan.blocks.flatMap((b) => b.weeks);
				const onToday = week1!.sessions.filter((s) => s.date === today);
				expect(onToday.map((s) => s.kind)).toEqual(name === 'today' ? ['strength', 'other'] : []);
				expect(week2!.sessions.length).toBeGreaterThan(0);
			}
		}
		expect(() => programFixture('today', { monday: MONDAY, today: addDays(MONDAY, 7) })).toThrow(
			RangeError
		);
		expect(() => programFixture('hybrid', { monday: TODAY, today: TODAY })).toThrow(RangeError);
	});

	it('leaves the outline weeks of one-week without sessions', () => {
		const [planned, outline] = fixture('one-week').blocks;
		expect(planned!.weeks).toHaveLength(1);
		expect(outline).toMatchObject({ outline: true });
		expect(outline!.weeks.map((w) => w.sessions)).toEqual([[], [], []]);
	});
});

/** One of the owner's own: a strongman lift that neither catalogue part has. */
const sandbag = {
	name: 'Sandbag shouldering',
	pattern: 'hinge',
	primaryMuscles: ['glutes', 'hamstrings'],
	measure: 'reps',
	loadType: 'external'
};
