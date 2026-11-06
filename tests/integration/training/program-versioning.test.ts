/**
 * Program versioning on real Postgres (src/lib/server/services/programs/revise.ts, ADR 0010): an
 * edit writes version n + 1 by copy-on-write. Only the affected weeks' subtrees are copied (new
 * ids, the same lineages, the edit's changes written into the copies); every other week is
 * shared; the head moves by compare-and-set; one decision records what, why and who. Nothing
 * reachable from an older version ever changes, and history pages newest first.
 */
import { eq, sql, type SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import {
	programmingDecisions,
	programVersions,
	programVersionWeeks,
	workouts,
	type Executor
} from '../../../src/lib/server/db';
import {
	createProgramFromPlan,
	FIRST_VERSION_SUMMARY,
	getProgramVersion,
	getTrainingWeek,
	getVersionHistory,
	getVersionWeek,
	HISTORY_PAGE_SIZE,
	reviseProgram,
	type CopyChanges,
	type ProgramVersion,
	type Revision,
	type StoredSession,
	type StoredWeek,
	type WeekCopies
} from '../../../src/lib/server/services/programs/index';
import {
	ConflictError,
	ProgramConflictError,
	TrainingInputError,
	TrainingNotFoundError
} from '../../../src/lib/server/services/training/shared';
import {
	programFixture,
	type ProgramFixture
} from '../../../src/lib/server/test-support/program-fixtures';
import { holdTransaction, lockWaiters, withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** Week 1's Monday; the hybrid fixture plans five weeks from it. */
const MONDAY = '2026-11-09';
const day = (n: number) => addDays(MONDAY, n);

async function store(db: Executor, owner: string, name: ProgramFixture = 'hybrid') {
	const plan = programFixture(name, { monday: MONDAY, today: day(2) });
	const created = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
	const v1 = await getProgramVersion(owner, created.programId, 1, { db });
	return {
		programId: created.programId,
		v1,
		week1: v1.blocks[0]!.weeks[0]!,
		week2: v1.blocks[1]!.weeks[0]!
	};
}

/** A week's sessions by kind of day: the fixture's Monday strength, Tuesday class and so on. */
function sessionsOf(week: StoredWeek) {
	const [strength, tuesdayClass, intervals, easyRun, thursdayClass] = week.sessions as [
		StoredSession & { kind: 'strength' },
		StoredSession,
		StoredSession,
		StoredSession,
		StoredSession
	];
	return { strength, tuesdayClass, intervals, easyRun, thursdayClass };
}

/** A revision of `week` on version `base` that writes `changes` into its copy. */
function revision(
	week: StoredWeek,
	base: number,
	changes: CopyChanges,
	affected: string[],
	over: Partial<Revision> = {}
): Revision {
	return {
		baseVersionNumber: base,
		weekLineages: [week.lineage],
		apply: async () => changes,
		decision: {
			kind: 'session_moved',
			summary: `Edit on version ${base}`,
			why: `You changed it on version ${base}. No reason given.`,
			affected
		},
		...over
	};
}

/** Move a week's Tuesday class to Wednesday evening, after the intervals. */
function moveClass(week: StoredWeek, base = 1, over: Partial<Revision> = {}) {
	const { tuesdayClass } = sessionsOf(week);
	return revision(
		week,
		base,
		{
			sessions: {
				[tuesdayClass.lineage]: {
					scheduledOn: addDays(tuesdayClass.date, 1),
					orderInDay: 2,
					status: 'moved',
					movedFrom: tuesdayClass.date
				}
			}
		},
		[tuesdayClass.lineage],
		over
	);
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

/** Every program table, each with the rows of it that version `v` reaches. */
const sessionsIn = (v: string) =>
	sql`select s.id from planned_sessions s join program_version_weeks m on m.week_id = s.week_id where m.version_id = ${v}`;
const REACHABLE: Record<string, (v: string) => SQL> = {
	program_versions: (v) => sql`id = ${v}`,
	program_version_blocks: (v) => sql`version_id = ${v}`,
	program_blocks: (v) =>
		sql`id in (select block_id from program_version_blocks where version_id = ${v})`,
	program_version_weeks: (v) => sql`version_id = ${v}`,
	program_weeks: (v) =>
		sql`id in (select week_id from program_version_weeks where version_id = ${v})`,
	planned_sessions: (v) => sql`id in (${sessionsIn(v)})`,
	planned_exercises: (v) => sql`session_id in (${sessionsIn(v)})`,
	set_prescriptions: (v) =>
		sql`planned_exercise_id in (select id from planned_exercises where session_id in (${sessionsIn(v)}))`,
	planned_run_segments: (v) => sql`session_id in (${sessionsIn(v)})`,
	planned_session_details: (v) => sql`session_id in (${sessionsIn(v)})`,
	programming_decisions: (v) => sql`version_id = ${v}`
};

/** Every row version `v` reaches, as JSON, table by table, in a stable order. */
async function snapshot(db: Executor, v: string) {
	const result: Record<string, unknown[]> = {};
	for (const [table, where] of Object.entries(REACHABLE)) {
		const { rows } = await db.execute<{ rows: unknown[] }>(
			sql`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]') as rows
				from ${sql.identifier(table)} t where ${where(v)}`
		);
		result[table] = rows[0]!.rows;
	}
	return result;
}

async function counts(db: Executor) {
	const result: Record<string, number> = {};
	for (const table of Object.keys(REACHABLE)) {
		const { rows } = await db.execute<{ n: number }>(
			sql`select count(*)::int as n from ${sql.identifier(table)}`
		);
		result[table] = rows[0]!.n;
	}
	return result;
}

const delta = (after: Record<string, number>, before: Record<string, number>) =>
	Object.fromEntries(Object.entries(after).map(([table, n]) => [table, n - before[table]!]));

/** The stored tree without its row ids, which every copy renews (lineages stay). */
function withoutIds(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutIds);
	if (value && typeof value === 'object' && !(value instanceof Date)) {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== 'id')
				.map(([key, field]) => [key, withoutIds(field)])
		);
	}
	return value;
}

/** Version `v1` as an older version reads: the same, no longer current. */
const asOlder = (v1: ProgramVersion): ProgramVersion => ({
	...v1,
	version: { ...v1.version, current: false }
});

async function logWorkout(db: Executor, owner: string, programId: string, s: StoredSession) {
	const startedAt = new Date(`${s.date}T07:00:00Z`);
	await db.insert(workouts).values({
		ownerId: owner,
		clientId: crypto.randomUUID(),
		kind: s.kind,
		discipline: s.discipline,
		sessionType: s.type,
		title: s.title,
		plannedSessionId: s.id,
		plannedLineageId: s.lineage,
		programId,
		status: 'completed',
		startedAt,
		finishedAt: new Date(startedAt.getTime() + 3_600_000)
	});
}

const NAMES = new Map(CATALOGUE.map((e) => [e.key, e.name]));

describe('reviseProgram', () => {
	it('never overwrites: everything version 1 reaches is unchanged after three revisions', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1, week1, week2 } = await store(db, owner);
			const before = await snapshot(db, v1.version.id);
			for (const rows of Object.values(before)) expect(rows.length).toBeGreaterThan(0);
			const weekBefore = await getVersionWeek(owner, 1, { date: MONDAY }, { db });

			await reviseProgram(owner, moveClass(week1, 1), { db });
			const { strength } = sessionsOf(week2);
			await reviseProgram(
				owner,
				revision(week2, 2, { sessions: { [strength.lineage]: { notes: 'Belt on' } } }, [
					strength.lineage
				]),
				{ db }
			);
			const { intervals } = sessionsOf(week1);
			await reviseProgram(
				owner,
				revision(
					week1,
					3,
					{ segments: { [intervals.lineage]: { 2: { paceMinSecondsPerKm: 230 } } } },
					[intervals.lineage]
				),
				{ db }
			);

			expect(await snapshot(db, v1.version.id)).toEqual(before);
			expect(await getProgramVersion(owner, programId, 1, { db })).toEqual(asOlder(v1));
			expect(await getVersionWeek(owner, 1, { date: MONDAY }, { db })).toEqual({
				...weekBefore,
				version: { ...weekBefore!.version, current: false }
			});
			expect(await getVersionWeek(owner, 1, { block: 1, week: 1 }, { db })).toEqual(
				await getVersionWeek(owner, 1, { date: MONDAY }, { db })
			);
			// The current version has all three edits.
			const week = await getTrainingWeek(owner, { date: MONDAY }, {}, { db });
			expect(week?.version.number).toBe(4);
			expect(week?.planned && week.days[2]!.sessions.map((s) => [s.title, s.status])).toEqual([
				['Intervals', 'planned'],
				['Muay Thai class', 'moved']
			]);
		});
	});

	it("copies only the affected week's subtree and shares every other week", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1, week1 } = await store(db, owner);
			const weekRows = v1.blocks.flatMap((b) => b.weeks);
			const sessions = week1.sessions;
			const exercises = sessions.flatMap((s) => (s.kind === 'strength' ? s.exercises : []));
			const before = await counts(db);
			let copies: WeekCopies | undefined;

			const revised = await reviseProgram(
				owner,
				moveClass(week1, 1, {
					apply: async (c, tx) => {
						copies = c;
						expect(tx).not.toBe(db);
						return moveClass(week1).apply(c, tx);
					}
				}),
				{ db }
			);
			const added = delta(await counts(db), before);

			expect(revised).toEqual({ programId, versionId: copies!.versionId, number: 2 });
			// One assertion per table: a table the copy forgets fails here.
			expect(added.program_versions).toBe(1);
			expect(added.program_version_blocks).toBe(v1.blocks.length);
			expect(added.program_blocks).toBe(0);
			expect(added.program_version_weeks).toBe(weekRows.length);
			expect(added.program_weeks).toBe(1);
			expect(added.planned_sessions).toBe(sessions.length);
			expect(added.planned_exercises).toBe(exercises.length);
			expect(added.set_prescriptions).toBe(exercises.flatMap((e) => e.sets).length);
			expect(added.planned_run_segments).toBe(
				sessions.flatMap((s) => (s.kind === 'run' ? s.segments : [])).length
			);
			expect(added.planned_session_details).toBe(sessions.filter((s) => s.kind === 'other').length);
			expect(added.programming_decisions).toBe(1);

			// What apply was told: each copied row's base id and its copy's, by lineage.
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			const copied = v2.blocks[0]!.weeks[0]!;
			expect(copies!.baseVersionId).toBe(v1.version.id);
			expect(copies!.weeks).toEqual(new Map([[week1.lineage, { from: week1.id, to: copied.id }]]));
			const copyOf = (lineage: string) => copied.sessions.find((s) => s.lineage === lineage)!;
			expect(copies!.sessions).toEqual(
				new Map(sessions.map((s) => [s.lineage, { from: s.id, to: copyOf(s.lineage).id }]))
			);
			expect([...copies!.exercises.keys()]).toEqual(exercises.map((e) => e.lineage));

			// The copy: new ids, the same lineages and content, the edit written into it.
			const ids = (week: StoredWeek) => [
				week.id,
				...week.sessions.flatMap((s) => [
					s.id,
					...(s.kind === 'strength' ? s.exercises.map((e) => e.id) : [])
				])
			];
			expect(ids(copied).filter((id) => ids(week1).includes(id))).toEqual([]);
			const { tuesdayClass } = sessionsOf(week1);
			const edited = week1.sessions.map((s) =>
				s.lineage === tuesdayClass.lineage
					? { ...s, date: day(2), orderInDay: 2, status: 'moved' as const, movedFrom: day(1) }
					: s
			);
			const byDay = (a: StoredSession, b: StoredSession) =>
				a.date.localeCompare(b.date) || a.orderInDay - b.orderInDay;
			expect(withoutIds(copied)).toEqual(withoutIds({ ...week1, sessions: edited.sort(byDay) }));
			// Every other block and week is shared: the same rows, ids included.
			expect(v2.blocks.slice(1)).toEqual(v1.blocks.slice(1));
			const members = await db
				.select({ weekId: programVersionWeeks.weekId })
				.from(programVersionWeeks)
				.where(eq(programVersionWeeks.versionId, revised.versionId));
			expect(members.map((m) => m.weekId).sort()).toEqual(
				[copied.id, ...weekRows.slice(1).map((w) => w.id)].sort()
			);
		});
	});

	it('writes its changes into every child table of the copy, and the base keeps its values', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1, week1 } = await store(db, owner);
			const { strength, tuesdayClass, intervals } = sessionsOf(week1);
			const [powerClean, backSquat] = strength.exercises;

			await reviseProgram(
				owner,
				revision(
					week1,
					1,
					{
						sessions: { [tuesdayClass.lineage]: { estMinutes: 60, estLoad: 360 } },
						details: { [tuesdayClass.lineage]: { durationMinutes: 60, targetRpe: 6 } },
						segments: {
							[intervals.lineage]: { 2: { paceMinSecondsPerKm: 230, paceMaxSecondsPerKm: 245 } }
						},
						exercises: { [powerClean!.lineage]: { instructions: null, notes: 'Belt on' } },
						sets: { [backSquat!.lineage]: { 1: { targetRpe: 7.5 }, 2: { sets: 3 } } }
					},
					[tuesdayClass.lineage, intervals.lineage, powerClean!.lineage, backSquat!.lineage]
				),
				{ db }
			);

			const v2 = await getProgramVersion(owner, programId, 2, { db });
			const expected = structuredClone(week1);
			const { strength: lift, tuesdayClass: cls, intervals: run } = sessionsOf(expected);
			if (cls.kind !== 'other' || run.kind !== 'run') throw new Error('the fixture changed');
			Object.assign(cls, { estMinutes: 60, estLoad: 360 });
			Object.assign(cls.details, { durationMinutes: 60, targetRpe: 6 });
			Object.assign(run.segments[1]!, { paceMinSecondsPerKm: 230, paceMaxSecondsPerKm: 245 });
			const lifts = lift.exercises;
			Object.assign(lifts[0]!, { instructions: null, notes: 'Belt on' });
			Object.assign(lifts[1]!.sets[0]!, { targetRpe: 7.5 });
			Object.assign(lifts[1]!.sets[1]!, { sets: 3 });
			expect(withoutIds(v2.blocks[0]!.weeks[0])).toEqual(withoutIds(expected));
			expect(await getProgramVersion(owner, programId, 1, { db })).toEqual(asOlder(v1));
		});
	});

	it('is refused on a stale base, before apply runs, and writes nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { week1 } = await store(db, owner);
			await reviseProgram(owner, moveClass(week1, 1), { db });
			const before = await counts(db);

			for (const base of [1, 3]) {
				const apply = vi.fn(async () => ({}));
				const error = await refusal(
					reviseProgram(owner, moveClass(week1, base, { apply }), { db })
				);
				expect(error).toBeInstanceOf(ProgramConflictError);
				expect(error).toBeInstanceOf(ConflictError);
				expect((error as ProgramConflictError).reason).toBe('version');
				expect(apply).not.toHaveBeenCalled();
			}
			expect(await counts(db)).toEqual(before);
		});
	});

	it('writes nothing when apply fails or names a row outside the weeks it copies', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { week1, week2 } = await store(db, owner);
			const before = await counts(db);
			const failing = moveClass(week1, 1, {
				apply: async () => {
					throw new Error('the edit failed');
				}
			});
			await expect(reviseProgram(owner, failing, { db })).rejects.toThrow('the edit failed');
			const elsewhere = sessionsOf(week2).strength;
			const outside = revision(week1, 1, { sessions: { [elsewhere.lineage]: { notes: 'x' } } }, []);
			await expect(reviseProgram(owner, outside, { db })).rejects.toThrow(/outside the weeks/);
			const set = revision(
				week1,
				1,
				{ sets: { [elsewhere.exercises[0]!.lineage]: { 1: { sets: 2 } } } },
				[]
			);
			await expect(reviseProgram(owner, set, { db })).rejects.toThrow(/outside the weeks/);
			expect(await counts(db)).toEqual(before);
		});
	});

	it('keeps a session with a completed workout completed in the new version', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, week1 } = await store(db, owner);
			const { strength } = sessionsOf(week1);
			await logWorkout(db, owner, programId, strength);

			await reviseProgram(
				owner,
				revision(week1, 1, { sessions: { [strength.lineage]: { notes: 'Belt on' } } }, [
					strength.lineage
				]),
				{ db }
			);

			const week = await getTrainingWeek(owner, { date: MONDAY }, {}, { db });
			expect(week?.version.number).toBe(2);
			expect(week?.planned && week.days[0]!.sessions.map((s) => [s.lineage, s.status])).toEqual([
				[strength.lineage, 'completed']
			]);
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			expect(v2.blocks[0]!.weeks[0]!.sessions[0]).toMatchObject({
				lineage: strength.lineage,
				notes: 'Belt on'
			});
			expect(v2.blocks[0]!.weeks[0]!.sessions[0]!.id).not.toBe(strength.id);
		});
	});

	it('writes one decision with its version and lineages, and a version by its author', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { programId, v1, week1 } = await store(db, owner);
			const { tuesdayClass } = sessionsOf(week1);
			const at = new Date('2026-11-10T08:00:00Z');

			const { versionId } = await reviseProgram(owner, moveClass(week1, 1), {
				db,
				now: () => at,
				source: 'coach'
			});

			const decisions = await db
				.select()
				.from(programmingDecisions)
				.where(eq(programmingDecisions.versionId, versionId));
			expect(decisions).toEqual([
				{
					id: expect.any(Number),
					programId,
					versionId,
					kind: 'session_moved',
					ruleKey: null,
					summary: 'Edit on version 1',
					why: 'You changed it on version 1. No reason given.',
					decidedBy: 'coach',
					affected: [tuesdayClass.lineage],
					evidence: {},
					createdAt: at
				}
			]);
			const [version] = await db
				.select()
				.from(programVersions)
				.where(eq(programVersions.id, versionId));
			expect(version).toEqual({
				id: versionId,
				programId,
				number: 2,
				parentVersionId: v1.version.id,
				createdBy: 'coach',
				summary: 'Edit on version 1',
				generator: null,
				inputFingerprint: null,
				catalogueDigest: null,
				inputSnapshot: null,
				startsOn: v1.startsOn,
				firstPlannedDay: v1.firstPlannedDay,
				createdAt: at
			});
		});
	});

	it('refuses an unknown program, week or decision without writing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const nowhere = revision({ lineage: crypto.randomUUID() } as StoredWeek, 1, {}, []);
			expect(await refusal(reviseProgram(owner, nowhere, { db }))).toBeInstanceOf(
				TrainingNotFoundError
			);

			const { week1 } = await store(db, owner);
			const before = await counts(db);
			const unknownWeek = { ...moveClass(week1), weekLineages: [crypto.randomUUID()] };
			expect(await refusal(reviseProgram(owner, unknownWeek, { db }))).toBeInstanceOf(
				TrainingNotFoundError
			);
			const errors = async (over: Partial<Revision>) => {
				const error = await refusal(reviseProgram(owner, { ...moveClass(week1), ...over }, { db }));
				expect(error).toBeInstanceOf(TrainingInputError);
				return Object.keys((error as TrainingInputError).errors);
			};
			expect(await errors({ weekLineages: [] })).toEqual(['weekLineages']);
			const decision = moveClass(week1).decision;
			expect(await errors({ decision: { ...decision, why: '  ' } })).toEqual(['why']);
			expect(await errors({ decision: { ...decision, kind: 'renamed' as never } })).toEqual([
				'kind'
			]);
			expect(await errors({ decision: { ...decision, affected: ['week 1'] } })).toEqual([
				'affected.0'
			]);
			expect(await refusal(reviseProgram(owner, moveClass(week1, 0), { db }))).toBeInstanceOf(
				TrainingNotFoundError
			);
			expect(await counts(db)).toEqual(before);
		});
	});

	it('lets exactly one of two concurrent revisions of the same base succeed', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const { programId, week1 } = await store(db, owner);
			const held = await holdTransaction((tx) =>
				reviseProgram(owner, moveClass(week1), { db: tx })
			);
			const second = reviseProgram(owner, moveClass(week1), { db }).then(
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
			const decisions = await db
				.select({ versionId: programmingDecisions.versionId })
				.from(programmingDecisions)
				.innerJoin(programVersions, eq(programVersions.id, programmingDecisions.versionId))
				.where(eq(programVersions.number, 2));
			expect(decisions).toHaveLength(1);
		});
	});

	it('copies every table that hangs off a week, and nothing logged', async () => {
		await withRollback(async (db) => {
			// A table added under a week, session or planned exercise must join the copy, or this fails.
			const { rows } = await db.execute<{ child: string; parent: string }>(
				sql`select conrelid::regclass::text as child, confrelid::regclass::text as parent
					from pg_constraint where contype = 'f'
					and confrelid in ('program_weeks'::regclass, 'planned_sessions'::regclass, 'planned_exercises'::regclass)
					order by 1, 2`
			);
			expect(rows).toEqual([
				{ child: 'planned_exercises', parent: 'planned_sessions' },
				{ child: 'planned_run_segments', parent: 'planned_sessions' },
				{ child: 'planned_session_details', parent: 'planned_sessions' },
				{ child: 'planned_sessions', parent: 'program_weeks' },
				{ child: 'program_version_weeks', parent: 'program_weeks' },
				{ child: 'set_prescriptions', parent: 'planned_exercises' },
				// Logged training names the session it was logged from; it is never copied.
				{ child: 'workouts', parent: 'planned_sessions' }
			]);
		});
	});
});

describe('getVersionHistory', () => {
	it('lists versions newest first, with their author, summary and decisions', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(await getVersionHistory(owner, {}, { db })).toBeNull();
			const { week1, week2 } = await store(db, owner);
			const { tuesdayClass, thursdayClass, strength } = sessionsOf(week1);
			await reviseProgram(owner, moveClass(week1, 1), { db });
			const lift = sessionsOf(week2).strength;
			const bench = lift.exercises[2]!;
			await reviseProgram(
				owner,
				revision(week2, 2, { exercises: { [bench.lineage]: { notes: 'Pause each rep' } } }, [
					lift.lineage,
					bench.lineage
				]),
				{ db, source: 'coach' }
			);

			const history = await getVersionHistory(owner, {}, { db });
			expect(history?.nextCursor).toBeNull();
			expect(history?.versions.map((v) => [v.number, v.createdBy, v.summary, v.current])).toEqual([
				[3, 'coach', 'Edit on version 2', true],
				[2, 'owner', 'Edit on version 1', false],
				[1, 'rules', FIRST_VERSION_SUMMARY, false]
			]);
			const [v3, v2, v1] = history!.versions;
			expect(v3!.decisions).toEqual([
				{
					id: expect.any(String),
					version: 3,
					createdAt: expect.any(Date),
					kind: 'session_moved',
					ruleKey: null,
					summary: 'Edit on version 2',
					why: 'You changed it on version 2. No reason given.',
					decidedBy: 'coach',
					affected: [
						{ lineage: lift.lineage, title: 'Full body', date: lift.date },
						{ lineage: bench.lineage, title: NAMES.get('bench_press'), date: lift.date }
					]
				}
			]);
			// Resolved in the decision's own version: the class is on Wednesday in version 2.
			expect(v2!.decisions.map((d) => [d.why, d.affected])).toEqual([
				[
					'You changed it on version 1. No reason given.',
					[{ lineage: tuesdayClass.lineage, title: 'Muay Thai class', date: day(2) }]
				]
			]);
			expect(v1!.decisions.map((d) => [d.kind, d.version, d.why.length > 0])).toEqual(
				[
					'program_purpose',
					'block_structure',
					'commitment_placed',
					'exercise_selected',
					'default_assumed'
				].map((kind) => [kind, 1, true])
			);
			expect(v1!.decisions.map((d) => d.affected)).toEqual([
				[],
				[],
				[
					{ lineage: tuesdayClass.lineage, title: 'Muay Thai class', date: day(1) },
					{ lineage: thursdayClass.lineage, title: 'Muay Thai class', date: day(3) }
				],
				[
					{ lineage: strength.exercises[0]!.lineage, title: NAMES.get('power_clean'), date: MONDAY }
				],
				[]
			]);
		});
	});

	it(`pages ${HISTORY_PAGE_SIZE} at a time: 25 versions are 20 and then 5, with no gaps`, async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { week1 } = await store(db, owner, 'one-week');
			const { strength } = sessionsOf(week1);
			for (let base = 1; base < 25; base++) {
				const notes = { sessions: { [strength.lineage]: { notes: `Edit ${base}` } } };
				await reviseProgram(owner, revision(week1, base, notes, [strength.lineage]), { db });
			}

			const first = await getVersionHistory(owner, {}, { db });
			expect(HISTORY_PAGE_SIZE).toBe(20);
			expect(first!.versions.map((v) => v.number)).toEqual(
				Array.from({ length: 20 }, (_, i) => 25 - i)
			);
			expect(first!.nextCursor).toBe(6);
			const second = await getVersionHistory(owner, { before: first!.nextCursor! }, { db });
			expect(second!.versions.map((v) => v.number)).toEqual([5, 4, 3, 2, 1]);
			expect(second!.nextCursor).toBeNull();
			expect(second!.versions.map((v) => v.current)).toEqual([false, false, false, false, false]);
			expect(await getVersionHistory(owner, { before: 1 }, { db })).toEqual({
				versions: [],
				nextCursor: null
			});
			for (const before of [0, 2.5, -1]) {
				const error = await refusal(getVersionHistory(owner, { before }, { db }));
				expect(error).toBeInstanceOf(TrainingInputError);
			}
		});
	});
});

describe('getVersionWeek', () => {
	it('reads a week of any version, and refuses an unknown one', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			// With no active program, no version of it exists.
			expect(await refusal(getVersionWeek(owner, 1, { date: MONDAY }, { db }))).toBeInstanceOf(
				TrainingNotFoundError
			);
			const { week1 } = await store(db, owner);
			await reviseProgram(owner, moveClass(week1, 1), { db });

			const v1 = await getVersionWeek(owner, 1, { date: MONDAY }, { db });
			const v2 = await getVersionWeek(owner, 2, { block: 1, week: 1 }, { db });
			expect(v1?.planned && v1.days[1]!.sessions.map((s) => s.title)).toEqual(['Muay Thai class']);
			expect(v2?.planned && v2.days[1]!.sessions).toEqual([]);
			expect([v1?.version.current, v2?.version.current]).toEqual([false, true]);
			for (const number of [3, 0, 1.5]) {
				expect(
					await refusal(getVersionWeek(owner, number, { date: MONDAY }, { db }))
				).toBeInstanceOf(TrainingNotFoundError);
			}
		});
	});
});
