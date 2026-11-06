/**
 * Program reads on real Postgres (src/lib/server/services/programs/read.ts): the current program,
 * a week by date or by index, one session by lineage and today's plan, as Train, Today, the
 * session screen and the coach's tools read them. Every read takes its dates explicitly, reads
 * the current version unless asked for another, and derives 'completed' from logged workouts
 * without touching the planned rows.
 */
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import type { ProfileDistanceUnit } from '../../../src/lib/domain/profile/types';
import { describeSession } from '../../../src/lib/domain/training/describe';
import type {
	ProgramPlan,
	RunSegment,
	SessionPlan,
	SessionView
} from '../../../src/lib/domain/training/types';
import {
	createProfileRepository,
	plannedSessionDetails,
	plannedSessions,
	programs,
	programVersionBlocks,
	programVersions,
	programVersionWeeks,
	programWeeks,
	workouts,
	type Executor,
	type WorkoutStatus
} from '../../../src/lib/server/db';
import {
	createProgramFromPlan,
	getCurrentProgram,
	getPlannedSession,
	getProgramVersion,
	getTodayPlan,
	getTrainingWeek,
	UP_NEXT_LIMIT,
	type ProgramVersion,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import {
	TrainingInputError,
	TrainingNotFoundError
} from '../../../src/lib/server/services/training/shared';
import {
	programFixture,
	type ProgramFixture
} from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** Week 1's Monday; the hybrid fixture plans five weeks from it, to Sunday 13 December. */
const MONDAY = '2026-11-09';
const day = (n: number) => addDays(MONDAY, n);
const WEDNESDAY = day(2);
const SUNDAY = day(6);

/** Store a fixture as the owner's program; `today` places the 'today' fixtures. */
async function store(db: Executor, owner: string, name: ProgramFixture, today = WEDNESDAY) {
	return storePlan(db, owner, programFixture(name, { monday: MONDAY, today }));
}

async function storePlan(db: Executor, owner: string, plan: ProgramPlan) {
	const created = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
	const stored = await getProgramVersion(owner, created.programId, 1, { db });
	return { plan, created, stored };
}

const weekOf = (stored: ProgramVersion, block: number, week: number) =>
	stored.blocks[block]!.weeks[week]!;

/** The error a call was refused with (fails the test if it was not refused). */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!error) throw new Error('expected the call to be refused');
	return error;
}

const NAMES = new Map(CATALOGUE.map((e) => [e.key, e.name]));

/** What describe.ts says for a planned session, with the catalogue's names. */
const lineOf = (session: SessionPlan, distanceUnit: ProfileDistanceUnit = 'km') =>
	describeSession(session, {
		distanceUnit,
		exerciseName: (ref) => ('key' in ref ? NAMES.get(ref.key)! : 'custom')
	});

/** A session view in short: its date, title and status. */
const brief = (s: Pick<SessionView, 'date' | 'title' | 'status'>) => [s.date, s.title, s.status];

/** Log a workout against a stored session, straight into the table (M4 writes it later). */
async function logWorkout(
	db: Executor,
	owner: string,
	programId: string,
	session: StoredSession,
	status: WorkoutStatus,
	{ deleted = false } = {}
) {
	const startedAt = new Date(`${session.date}T07:00:00Z`);
	await db.insert(workouts).values({
		ownerId: owner,
		clientId: crypto.randomUUID(),
		kind: session.kind,
		discipline: session.discipline,
		sessionType: session.type,
		title: session.title,
		plannedSessionId: session.id,
		plannedLineageId: session.lineage,
		programId,
		status,
		startedAt,
		finishedAt: status === 'in_progress' ? null : new Date(startedAt.getTime() + 3_600_000),
		deletedAt: deleted ? new Date(startedAt.getTime() + 7_200_000) : null
	});
}

/**
 * Version 2 by hand, as copy-on-write writes it (ADR 0010; reviseProgram comes in m3/29): every
 * block and every week but week 1 shared, and week 1 copied with only its Tuesday class, moved to
 * Wednesday. The class keeps its lineage; the copy has new row ids.
 */
async function moveClassByHand(db: Executor, programId: string, stored: ProgramVersion) {
	const v1 = stored.version.id;
	const week = weekOf(stored, 0, 0);
	const tuesdayClass = week.sessions[1]!;
	const [v2] = await db
		.insert(programVersions)
		.values({
			programId,
			number: 2,
			parentVersionId: v1,
			createdBy: 'owner',
			summary: 'Moved Muay Thai to Wednesday',
			startsOn: MONDAY,
			firstPlannedDay: MONDAY
		})
		.returning();
	const versionId = v2!.id;
	const blocks = await db
		.select()
		.from(programVersionBlocks)
		.where(eq(programVersionBlocks.versionId, v1));
	await db.insert(programVersionBlocks).values(blocks.map((b) => ({ ...b, versionId })));
	const [weekRow] = await db.select().from(programWeeks).where(eq(programWeeks.id, week.id));
	const weekCopy = { ...weekRow!, id: crypto.randomUUID() };
	await db.insert(programWeeks).values(weekCopy);
	const weeks = await db
		.select()
		.from(programVersionWeeks)
		.where(eq(programVersionWeeks.versionId, v1));
	await db
		.insert(programVersionWeeks)
		.values([
			...weeks.filter((w) => w.weekId !== week.id).map((w) => ({ ...w, versionId })),
			{ versionId, weekId: weekCopy.id }
		]);
	const [sessionRow] = await db
		.select()
		.from(plannedSessions)
		.where(eq(plannedSessions.id, tuesdayClass.id));
	const sessionCopy = {
		...sessionRow!,
		id: crypto.randomUUID(),
		weekId: weekCopy.id,
		scheduledOn: WEDNESDAY,
		status: 'moved' as const,
		movedFrom: sessionRow!.scheduledOn
	};
	await db.insert(plannedSessions).values(sessionCopy);
	const [details] = await db
		.select()
		.from(plannedSessionDetails)
		.where(eq(plannedSessionDetails.sessionId, tuesdayClass.id));
	await db.insert(plannedSessionDetails).values({ ...details!, sessionId: sessionCopy.id });
	await db.update(programs).set({ currentVersionId: versionId }).where(eq(programs.id, programId));
	return { tuesdayClass, copyId: sessionCopy.id };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('the current program', () => {
	it('gives its blocks, planned weeks and where today falls, from an explicit today', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { plan, created, stored } = await store(db, owner, 'hybrid');

			const program = await getCurrentProgram(owner, WEDNESDAY, { db });
			expect(program).toEqual({
				id: created.programId,
				title: plan.title,
				startsOn: MONDAY,
				firstPlannedDay: MONDAY,
				version: {
					number: 1,
					createdAt: stored.version.createdAt,
					createdBy: 'rules',
					summary: 'Your first program',
					current: true
				},
				lastPlannedDay: '2026-12-13',
				plannedWeeks: 5,
				blocks: [
					{
						lineage: stored.blocks[0]!.lineage,
						phase: 'baseline',
						name: 'Baseline week',
						startsOn: MONDAY,
						endsOn: SUNDAY,
						outline: false,
						goalRefs: plan.blocks[0]!.goalRefs,
						plannedWeeks: 1
					},
					{
						lineage: stored.blocks[1]!.lineage,
						phase: 'accumulation',
						name: 'Accumulation',
						startsOn: day(7),
						endsOn: '2026-12-13',
						outline: false,
						goalRefs: plan.blocks[1]!.goalRefs,
						plannedWeeks: 4
					}
				],
				currentWeek: 1,
				baseline: true,
				notStarted: false,
				blockComplete: false
			});

			expect(await getCurrentProgram(owner, day(17), { db })).toMatchObject({
				currentWeek: 3,
				baseline: false,
				notStarted: false,
				blockComplete: false
			});
			// Before the start: week 1 is the one coming, and the program has not started yet.
			expect(await getCurrentProgram(owner, day(-4), { db })).toMatchObject({
				currentWeek: 1,
				baseline: true,
				notStarted: true,
				blockComplete: false
			});
			expect(await getCurrentProgram(owner, '2026-12-13', { db })).toMatchObject({
				currentWeek: 5,
				blockComplete: false
			});
			expect(await getCurrentProgram(owner, '2026-12-14', { db })).toMatchObject({
				currentWeek: null,
				baseline: false,
				blockComplete: true
			});
		});
	});

	it('counts only planned weeks: outline blocks are dates and a phase', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await store(db, owner, 'one-week');

			const program = await getCurrentProgram(owner, day(9), { db });
			expect(program).toMatchObject({
				lastPlannedDay: SUNDAY,
				plannedWeeks: 1,
				currentWeek: null,
				blockComplete: true
			});
			expect(program!.blocks.map((b) => [b.phase, b.outline, b.plannedWeeks, b.endsOn])).toEqual([
				['baseline', false, 1, SUNDAY],
				['accumulation', true, 0, day(27)]
			]);
		});
	});

	it('refuses a today that is not a calendar date', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await store(db, owner, 'hybrid');
			for (const today of ['2026-02-30', 'today', '']) {
				const error = await refusal(getCurrentProgram(owner, today, { db }));
				expect(error).toBeInstanceOf(TrainingInputError);
				expect((error as TrainingInputError).errors).toHaveProperty('today');
			}
			expect(await refusal(getTodayPlan(owner, '2026-13-01', { db }))).toBeInstanceOf(
				TrainingInputError
			);
		});
	});
});

describe('a training week', () => {
	it('reads a week by date and by index, Monday to Sunday, in the version current now', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { plan, stored } = await store(db, owner, 'hybrid');
			const week2 = weekOf(stored, 1, 0);

			const byDate = await getTrainingWeek(owner, { date: day(9) }, {}, { db });
			expect(byDate).toMatchObject({
				planned: true,
				lineage: week2.lineage,
				number: 2,
				kind: 'accumulation',
				phase: 'accumulation',
				blockName: 'Accumulation',
				startsOn: day(7),
				endsOn: day(13),
				targets: plan.blocks[1]!.weeks[0]!.targets,
				version: { number: 1, current: true }
			});
			expect(byDate).not.toHaveProperty('programStartsOn');
			if (!byDate?.planned) throw new Error('expected a planned week');
			expect(byDate.days.map((d) => [d.date, d.weekday, d.sessions.map((s) => s.title)])).toEqual([
				[day(7), 'mon', ['Full body']],
				[day(8), 'tue', ['Muay Thai class']],
				[day(9), 'wed', ['Intervals']],
				[day(10), 'thu', ['Easy run', 'Muay Thai class']],
				[day(11), 'fri', []],
				[day(12), 'sat', []],
				[day(13), 'sun', []]
			]);
			const thursday = byDate.days[3]!.sessions;
			expect(thursday.map((s) => [s.orderInDay, s.timeOfDay, s.kind])).toEqual([
				[1, 'morning', 'run'],
				[2, 'evening', 'other']
			]);
			expect(thursday[1]).toEqual({
				lineage: week2.sessions[4]!.lineage,
				kind: 'other',
				date: day(10),
				timeOfDay: 'evening',
				orderInDay: 2,
				type: 'muay_thai',
				title: 'Muay Thai class',
				discipline: 'muay_thai',
				customDiscipline: null,
				intensity: 'hard',
				estMinutes: 90,
				targetRpe: 7,
				source: 'commitment',
				status: 'planned',
				movedFrom: null,
				line: 'Muay Thai class · 90 min · Evening'
			});

			// Weeks count from the block's first: the program's week 2 is block 2's week 1.
			expect(await getTrainingWeek(owner, { block: 2, week: 1 }, {}, { db })).toEqual(byDate);
			expect(await getTrainingWeek(owner, { block: 1, week: 2 }, {}, { db })).toEqual(byDate);
			expect(await getTrainingWeek(owner, { date: day(13) }, {}, { db })).toEqual(byDate);
			expect(await getTrainingWeek(owner, { block: 2, week: 4 }, {}, { db })).toMatchObject({
				planned: true,
				number: 5,
				kind: 'deload',
				startsOn: day(28)
			});
		});
	});

	it('gives week 1 with the day the program starts for a date before the start', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { stored } = await store(db, owner, 'hybrid');
			const week1 = await getTrainingWeek(owner, { date: MONDAY }, {}, { db });
			expect(week1).toMatchObject({
				planned: true,
				lineage: weekOf(stored, 0, 0).lineage,
				number: 1,
				kind: 'baseline',
				phase: 'baseline'
			});
			expect(week1).not.toHaveProperty('programStartsOn');

			const before = await getTrainingWeek(owner, { date: day(-10) }, {}, { db });
			expect(before).toEqual({ ...week1, programStartsOn: MONDAY });
		});
	});

	it('gives planned: false beyond the planned weeks, with the outline phase there', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await store(db, owner, 'one-week');
			const version = { number: 1, current: true };

			// The outline block runs from 16 November to 6 December.
			expect(await getTrainingWeek(owner, { block: 2, week: 2 }, {}, { db })).toMatchObject({
				planned: false,
				phase: 'accumulation',
				startsOn: day(14),
				endsOn: day(20),
				version
			});
			expect(await getTrainingWeek(owner, { block: 1, week: 3 }, {}, { db })).toMatchObject({
				planned: false,
				phase: 'accumulation',
				startsOn: day(14)
			});
			expect(await getTrainingWeek(owner, { date: day(10) }, {}, { db })).toMatchObject({
				planned: false,
				phase: 'accumulation',
				startsOn: day(7),
				endsOn: day(13)
			});
			// Past the outline too: nothing is known about that week.
			const far = await getTrainingWeek(owner, { block: 1, week: 99 }, {}, { db });
			expect(far).toEqual({
				planned: false,
				phase: null,
				startsOn: day(7 * 98),
				endsOn: day(7 * 98 + 6),
				version: expect.objectContaining(version)
			});
			expect(await getTrainingWeek(owner, { date: '2027-01-01' }, {}, { db })).toMatchObject({
				planned: false,
				phase: null,
				startsOn: '2026-12-28'
			});
		});
	});

	it('refuses a malformed date or index, and a block the program does not have', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await store(db, owner, 'hybrid');
			const invalid = [
				{ date: '2026-02-30' },
				{ date: 'next week' },
				{ block: 0, week: 1 },
				{ block: 1, week: 0 },
				{ block: 1.5, week: 1 },
				{ block: 1, week: Number.NaN },
				{ block: 1, week: 10_000 }
			];
			for (const at of invalid) {
				expect(await refusal(getTrainingWeek(owner, at, {}, { db }))).toBeInstanceOf(
					TrainingInputError
				);
			}
			expect(
				await refusal(getTrainingWeek(owner, { block: 3, week: 1 }, {}, { db }))
			).toBeInstanceOf(TrainingNotFoundError);
		});
	});

	it('says each session in describe.ts words, in the owner’s distance unit', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const profiles = createProfileRepository(db);
			await profiles.ensureProfile(owner);
			await profiles.updateProfile(owner, { distanceUnit: 'mi' }, new Date('2026-11-01'));
			const plan = programFixture('hybrid', { monday: MONDAY, today: WEDNESDAY });
			// Week 1's easy run given in distance only, so its line reads in the owner's unit.
			const easy = plan.blocks[0]!.weeks[0]!.sessions[3]!;
			if (easy.kind !== 'run') throw new Error('expected the easy run');
			const tenMiles: RunSegment = { ...easy.segments[0]!, durationSeconds: null };
			easy.segments = [{ ...tenMiles, distanceMetres: 16_093 }];
			await storePlan(db, owner, plan);

			const week = await getTrainingWeek(owner, { date: MONDAY }, {}, { db });
			if (!week?.planned) throw new Error('expected a planned week');
			const lines = week.days.flatMap((d) => d.sessions.map((s) => s.line));
			expect(lines).toEqual(plan.blocks[0]!.weeks[0]!.sessions.map((s) => lineOf(s, 'mi')));
			expect(lines).toEqual([
				'Power clean · Back squat · Bench press · +1 more · Morning',
				'Muay Thai class · 90 min · Evening',
				'45 min intervals · Morning',
				'10 mi easy run · Morning',
				'Muay Thai class · 90 min · Evening'
			]);
		});
	});
});

describe('one planned session', () => {
	it('reads a session by lineage with its prescriptions, segments or details', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { plan, stored } = await store(db, owner, 'hybrid');
			const week = weekOf(stored, 0, 0);
			const [strength, tuesdayClass, intervals] = week.sessions;
			const planned = plan.blocks[0]!.weeks[0]!.sessions;
			const context = {
				week: {
					lineage: week.lineage,
					kind: 'baseline',
					phase: 'baseline',
					blockName: 'Baseline week',
					startsOn: MONDAY,
					endsOn: SUNDAY
				},
				version: { number: 1, current: true },
				inCurrentVersion: true
			};

			const lifts = await getPlannedSession(owner, strength!.lineage, {}, { db });
			expect(lifts).toMatchObject({
				...context,
				id: strength!.id,
				lineage: strength!.lineage,
				kind: 'strength',
				date: MONDAY,
				title: 'Full body',
				status: 'planned',
				line: lineOf(planned[0]!),
				estLoad: planned[0]!.estLoad,
				instructions: null
			});
			if (
				lifts.kind !== 'strength' ||
				strength!.kind !== 'strength' ||
				planned[0]!.kind !== 'strength'
			) {
				throw new Error('expected strength');
			}
			expect(lifts.exercises.map((e) => e.name)).toEqual([
				'Power clean',
				'Back squat',
				'Bench press',
				'Barbell row'
			]);
			expect(lifts.exercises.map((e) => [e.id, e.lineage, e.exercise])).toEqual(
				strength!.exercises.map((e) => [e.id, e.lineage, e.exercise])
			);
			expect(lifts.exercises.map((e) => e.sets)).toEqual(planned[0]!.exercises.map((e) => e.sets));
			expect(lifts.exercises[1]).toMatchObject({
				name: 'Back squat',
				baselineLift: 'back_squat',
				instructions: 'Record weight, reps and RPE for every set.'
			});

			const run = await getPlannedSession(owner, intervals!.lineage, {}, { db });
			expect(run).toMatchObject({ ...context, kind: 'run', line: '45 min intervals · Morning' });
			if (run.kind !== 'run' || planned[2]!.kind !== 'run') throw new Error('expected a run');
			expect(run.segments).toEqual(planned[2]!.segments);

			const fight = await getPlannedSession(owner, tuesdayClass!.lineage, {}, { db });
			expect(fight).toMatchObject({ ...context, kind: 'other', timeOfDay: 'evening' });
			if (fight.kind !== 'other' || planned[1]!.kind !== 'other') {
				throw new Error('expected a class');
			}
			expect(fight.details).toEqual(planned[1]!.details);
		});
	});

	it('finds nothing for a malformed or unknown lineage', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { stored } = await store(db, owner, 'hybrid');
			const strength = weekOf(stored, 0, 0).sessions[0]!;
			if (strength.kind !== 'strength') throw new Error('expected strength');
			const notSessions = [
				'not-a-uuid',
				'',
				crypto.randomUUID(),
				stored.blocks[0]!.lineage,
				weekOf(stored, 0, 0).lineage,
				strength.exercises[0]!.lineage
			];
			for (const lineage of notSessions) {
				expect(await refusal(getPlannedSession(owner, lineage, {}, { db }))).toBeInstanceOf(
					TrainingNotFoundError
				);
			}
		});
	});
});

describe('today', () => {
	it('lists a training day’s sessions, then the next ones across the week boundary', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { plan } = await store(db, owner, 'today', WEDNESDAY);

			const today = await getTodayPlan(owner, WEDNESDAY, { db });
			expect(today).toEqual({
				sessions: [
					expect.objectContaining({ date: WEDNESDAY, title: 'Full body', orderInDay: 1 }),
					expect.objectContaining({ date: WEDNESDAY, title: 'Muay Thai class', orderInDay: 2 })
				],
				upNext: [
					expect.objectContaining({ date: day(7), title: 'Full body' }),
					expect.objectContaining({ date: day(8), title: 'Muay Thai class' }),
					expect.objectContaining({ date: day(9), title: 'Intervals' })
				],
				blockComplete: false
			});
			expect(today!.upNext).toHaveLength(UP_NEXT_LIMIT);
			expect(today!.sessions.map((s) => s.line)).toEqual(
				plan.blocks[0]!.weeks[0]!.sessions.filter((s) => s.date === WEDNESDAY).map((s) => lineOf(s))
			);

			// The clock plays no part: only the today it is given.
			vi.useFakeTimers({ now: new Date('2031-06-01T12:00:00Z'), toFake: ['Date'] });
			expect(await getTodayPlan(owner, WEDNESDAY, { db })).toEqual(today);
		});
	});

	it('shows nothing today on a rest day, and what comes next', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await store(db, owner, 'today-rest', WEDNESDAY);
			const today = await getTodayPlan(owner, WEDNESDAY, { db });
			expect(today).toMatchObject({ sessions: [], blockComplete: false });
			expect(today!.upNext.map(brief)).toEqual([
				[day(3), 'Intervals', 'planned'],
				[day(7), 'Full body', 'planned'],
				[day(8), 'Muay Thai class', 'planned']
			]);
		});
	});

	it('takes up next from next week on a Sunday', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await store(db, owner, 'today-rest', SUNDAY);
			const today = await getTodayPlan(owner, SUNDAY, { db });
			expect(today).toMatchObject({ sessions: [], blockComplete: false });
			expect(today!.upNext.map(brief)).toEqual([
				[day(7), 'Full body', 'planned'],
				[day(8), 'Muay Thai class', 'planned'],
				[day(9), 'Intervals', 'planned']
			]);
		});
	});

	it('names the first planned day before the start, with week 1 up next', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await store(db, owner, 'hybrid');
			const today = await getTodayPlan(owner, day(-3), { db });
			expect(today).toMatchObject({ sessions: [], startsOn: MONDAY, blockComplete: false });
			expect(today!.upNext.map(brief)).toEqual([
				[MONDAY, 'Full body', 'planned'],
				[day(1), 'Muay Thai class', 'planned'],
				[day(2), 'Intervals', 'planned']
			]);
		});
	});

	it('is complete after the one-week fixture’s week, with nothing up next', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await store(db, owner, 'one-week');
			// Its last planned day is not yet complete.
			expect(await getTodayPlan(owner, SUNDAY, { db })).toEqual({
				sessions: [],
				upNext: [],
				blockComplete: false
			});
			for (const today of [day(7), day(9), '2027-02-01']) {
				expect(await getTodayPlan(owner, today, { db })).toEqual({
					sessions: [],
					upNext: [],
					blockComplete: true
				});
			}
		});
	});
});

describe('completed sessions', () => {
	it('reads completed from a completed workout, leaving the planned row as it was', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { created, stored } = await store(db, owner, 'hybrid');
			const [strength, tuesdayClass, intervals, easy] = weekOf(stored, 0, 0).sessions;
			const plannedRow = async () =>
				(await db.select().from(plannedSessions).where(eq(plannedSessions.id, strength!.id)))[0];
			const before = await plannedRow();

			await logWorkout(db, owner, created.programId, strength!, 'completed');
			// None of these completes its session.
			await logWorkout(db, owner, created.programId, tuesdayClass!, 'in_progress');
			await logWorkout(db, owner, created.programId, intervals!, 'abandoned');
			await logWorkout(db, owner, created.programId, easy!, 'completed', { deleted: true });

			const week = await getTrainingWeek(owner, { date: MONDAY }, {}, { db });
			if (!week?.planned) throw new Error('expected a planned week');
			expect(week.days.flatMap((d) => d.sessions.map(brief))).toEqual([
				[MONDAY, 'Full body', 'completed'],
				[day(1), 'Muay Thai class', 'planned'],
				[day(2), 'Intervals', 'planned'],
				[day(3), 'Easy run', 'planned'],
				[day(3), 'Muay Thai class', 'planned']
			]);
			expect(await getPlannedSession(owner, strength!.lineage, {}, { db })).toMatchObject({
				status: 'completed'
			});
			expect((await getTodayPlan(owner, MONDAY, { db }))!.sessions.map(brief)).toEqual([
				[MONDAY, 'Full body', 'completed']
			]);
			expect(await plannedRow()).toEqual(before);
			expect(before).toMatchObject({ status: 'planned' });
		});
	});
});

describe('versions', () => {
	it('reads the current version unless another is asked for', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { created, stored } = await store(db, owner, 'hybrid');
			const strength = weekOf(stored, 0, 0).sessions[0]!;
			const { tuesdayClass, copyId } = await moveClassByHand(db, created.programId, stored);
			// Logged against version 1's row: completed goes by lineage, so it holds in version 2.
			await logWorkout(db, owner, created.programId, tuesdayClass, 'completed');

			expect(await getCurrentProgram(owner, WEDNESDAY, { db })).toMatchObject({
				version: { number: 2, current: true, createdBy: 'owner' }
			});
			const current = await getTrainingWeek(owner, { date: MONDAY }, {}, { db });
			expect(current).toMatchObject({ planned: true, version: { number: 2, current: true } });
			if (!current?.planned) throw new Error('expected a planned week');
			expect(current.days.flatMap((d) => d.sessions.map(brief))).toEqual([
				[WEDNESDAY, 'Muay Thai class', 'completed']
			]);
			expect(current.days[2]!.sessions[0]).toMatchObject({ movedFrom: day(1) });

			const first = await getTrainingWeek(owner, { date: MONDAY }, { version: 1 }, { db });
			expect(first).toMatchObject({ planned: true, version: { number: 1, current: false } });
			if (!first?.planned) throw new Error('expected a planned week');
			expect(first.days.flatMap((d) => d.sessions.map(brief))).toEqual([
				[MONDAY, 'Full body', 'planned'],
				[day(1), 'Muay Thai class', 'completed'],
				[day(2), 'Intervals', 'planned'],
				[day(3), 'Easy run', 'planned'],
				[day(3), 'Muay Thai class', 'planned']
			]);

			// Week 2 is shared by both versions.
			const { version: _v2, ...week2 } = (await getTrainingWeek(
				owner,
				{ date: day(7) },
				{},
				{ db }
			))!;
			const { version: _v1, ...week2v1 } = (await getTrainingWeek(
				owner,
				{ date: day(7) },
				{ version: 1 },
				{ db }
			))!;
			expect(week2).toEqual(week2v1);

			expect(await getPlannedSession(owner, tuesdayClass.lineage, {}, { db })).toMatchObject({
				id: copyId,
				date: WEDNESDAY,
				status: 'completed',
				movedFrom: day(1),
				version: { number: 2, current: true },
				inCurrentVersion: true
			});
			expect(
				await getPlannedSession(owner, tuesdayClass.lineage, { version: 1 }, { db })
			).toMatchObject({
				id: tuesdayClass.id,
				date: day(1),
				status: 'completed',
				movedFrom: null,
				version: { number: 1, current: false },
				inCurrentVersion: true
			});
			// Version 2 left the strength session out: version 1 still shows it, saying so.
			expect(
				await getPlannedSession(owner, strength.lineage, { version: 1 }, { db })
			).toMatchObject({ id: strength.id, version: { current: false }, inCurrentVersion: false });
			expect(await refusal(getPlannedSession(owner, strength.lineage, {}, { db }))).toBeInstanceOf(
				TrainingNotFoundError
			);

			for (const version of [3, 0, 1.5, 2 ** 31]) {
				expect(
					await refusal(getTrainingWeek(owner, { date: MONDAY }, { version }, { db }))
				).toBeInstanceOf(TrainingNotFoundError);
				expect(
					await refusal(getPlannedSession(owner, tuesdayClass.lineage, { version }, { db }))
				).toBeInstanceOf(TrainingNotFoundError);
			}
		});
	});
});

describe('owners', () => {
	it('shows another owner nothing, and an archived program is no longer current', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { created, stored } = await store(db, owner, 'hybrid');
			const lineage = weekOf(stored, 0, 0).sessions[0]!.lineage;
			const nothing = async (ownerId: string) => {
				expect(await getCurrentProgram(ownerId, WEDNESDAY, { db })).toBeNull();
				expect(await getTrainingWeek(ownerId, { date: MONDAY }, {}, { db })).toBeNull();
				expect(await getTodayPlan(ownerId, MONDAY, { db })).toBeNull();
				expect(await refusal(getPlannedSession(ownerId, lineage, {}, { db }))).toBeInstanceOf(
					TrainingNotFoundError
				);
				expect(
					await refusal(getTrainingWeek(ownerId, { date: MONDAY }, { version: 1 }, { db }))
				).toBeInstanceOf(TrainingNotFoundError);
			};

			await nothing(crypto.randomUUID());
			expect(await getCurrentProgram(owner, WEDNESDAY, { db })).not.toBeNull();

			await db
				.update(programs)
				.set({ status: 'archived', archivedAt: new Date('2026-11-20') })
				.where(and(eq(programs.id, created.programId), eq(programs.ownerId, owner)));
			await nothing(owner);
		});
	});
});
