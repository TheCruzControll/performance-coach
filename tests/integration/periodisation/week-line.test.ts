/**
 * The week-kind line (services/periodisation/week-line.ts, m7/38) on real Postgres, on a pinned
 * Wednesday, for the periodisation-week-kinds fixture (M7-built) and the periodisation-m3-weeks
 * fixture (M3-built):
 * - the order of reasons: the week's own M7 decision, then M3's event_taper or block_structure,
 *   then WEEK_KIND_WHY's default, a decision naming the week winning over one naming its block
 * - the pills' words, and the countdown to the race
 * - owner scoping: another owner's program has no line and no words
 * - Train's and Today's loads carry the line on a light week still ahead, and none on a normal
 *   or a past week; when the decisions cannot be read, each records the failure and renders
 *   without it.
 * Every read runs one query at a time on one client (the setup's busy-client guard fails the
 * test otherwise).
 */
import { gzipSync } from 'node:zlib';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { WEEK_KIND_WHY } from '../../../src/lib/domain/programming/periodisation/kinds';
import type { Executor } from '../../../src/lib/server/db';
import { programmingDecisions, programVersions } from '../../../src/lib/server/db/schema';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import {
	COUNTDOWN_DAYS,
	countdownOf,
	getWeekLine,
	type WeekLineAt
} from '../../../src/lib/server/services/periodisation/week-line';
import { listGoals } from '../../../src/lib/server/services/profile/index';
import {
	getCurrentProgram,
	getProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import {
	M3_WEEKS,
	type M3WeeksResult
} from '../../../src/lib/server/test-support/analytics-fixtures/periodisation-m3-weeks';
import {
	KIND_WEEKS,
	type WeekKindsResult
} from '../../../src/lib/server/test-support/analytics-fixtures/periodisation-week-kinds';
import { loadTodayPlan } from '../../../src/routes/(app)/today/plan.server';
import { loadTrainWeek, type TrainWeekData } from '../../../src/routes/(app)/train/week.server';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';

/** Wednesday 11 November 2026, noon, on UTC: this week starts Monday 9 November. */
const NOW = new Date('2026-11-11T12:00:00Z');
const TODAY = '2026-11-11';
/** What the line may add to Train's and to Today's page data, in gzip bytes (m7-plan: 0.1 KB). */
const PAGE_DATA_B = 0.1 * 1024;
/** gzip bytes of `data` as JSON, and without `keys`: what those keys add. */
function addedBy(data: object, keys: readonly string[]) {
	const without = Object.fromEntries(Object.entries(data).filter(([k]) => !keys.includes(k)));
	return gzipSync(JSON.stringify(data)).length - gzipSync(JSON.stringify(without)).length;
}

/** Both races are on Saturday 5 December. */
const RACE_IN = 'in 24 days';

const M7_DELOAD = 'Deload in week 2';
const M7_TAPER = 'Taper before 10K race: 1 week';
const M3_STRUCTURE = 'First block: baseline week, 3 accumulation weeks, deload week';
const M3_TAPER = 'Taper before 5K race';

async function seed<T>(db: Executor, fixture: string, owner?: string) {
	const ownerId = owner ?? (await makeOwner(db));
	const seeded = (await seedAnalyticsFixture(
		ownerId,
		fixture,
		{ timeZone: 'UTC', now: NOW },
		{ db }
	)) as unknown as T & { programId: string };
	const goals = await listGoals(ownerId, { db });
	const at = (weekStartsOn: string, version = 1): WeekLineAt => ({
		...{ programId: seeded.programId, version, weekStartsOn, today: TODAY, goals }
	});
	return { owner: ownerId, seeded, at };
}

const seedM7 = (db: Executor, owner?: string) =>
	seed<WeekKindsResult>(db, 'periodisation-week-kinds', owner);
const seedM3 = (db: Executor) => seed<M3WeeksResult>(db, 'periodisation-m3-weeks');

const origin = (requestId = crypto.randomUUID(), path = '/train') => ({
	requestId,
	method: 'GET',
	path,
	routeId: path === '/train' ? '/(app)/train' : '/(app)/today',
	appVersion: '0.1.0+test'
});

function program(data: TrainWeekData) {
	if (data.state !== 'program') throw new Error(`expected a program, got ${data.state}`);
	return data;
}

/** A decision written straight into the store, after the program's newest one. */
async function insertDecision(
	db: Executor,
	programId: string,
	values: Pick<typeof programmingDecisions.$inferInsert, 'kind' | 'summary' | 'affected'> &
		Partial<Pick<typeof programmingDecisions.$inferInsert, 'evidence'>>
) {
	const [version] = await db
		.select({ id: programVersions.id })
		.from(programVersions)
		.where(and(eq(programVersions.programId, programId), eq(programVersions.number, 1)));
	const [latest] = await db
		.select({ newest: sql<string | Date>`max(${programmingDecisions.createdAt})` })
		.from(programmingDecisions)
		.where(eq(programmingDecisions.programId, programId));
	await db.insert(programmingDecisions).values({
		...{ programId, versionId: version!.id, why: 'Written by the test.', decidedBy: 'rules' },
		createdAt: new Date(new Date(latest!.newest).getTime() + 60_000),
		...values
	});
}

/** The lineages of program week `n` (from 1, among the planned weeks) and of its block. */
async function lineagesOf(db: Executor, owner: string, programId: string, n: number) {
	const version = await getProgramVersion(owner, programId, 1, { db });
	const weeks = version.blocks.flatMap((b) => b.weeks.map((w) => ({ week: w, block: b })));
	const { week, block } = weeks[n - 1]!;
	return { week: week.lineage, block: block.lineage };
}

/**
 * `db`, except that a read of programming_decisions throws: the decisions read fails, and every
 * other read (the program, its weeks, the findings') goes on.
 */
function decisionsDown(db: Executor): Executor {
	const bound = <T extends object>(target: T, key: PropertyKey) => {
		const value = Reflect.get(target, key) as unknown;
		return typeof value === 'function' ? value.bind(target) : value;
	};
	return new Proxy(db, {
		get(target, key) {
			if (key !== 'select') return bound(target, key);
			return (...args: Parameters<Executor['select']>) => {
				const builder = target.select(...args);
				return new Proxy(builder, {
					get(b, k) {
						if (k !== 'from') return bound(b, k);
						return (table: unknown) => {
							if (table === programmingDecisions) throw new Error('decisions unreachable');
							return (b.from as (t: unknown) => unknown)(table);
						};
					}
				});
			};
		}
	});
}

describe('getWeekLine, an M7-built program', () => {
	it('reads each light week’s why, and the pills’ words', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, at } = await seedM7(db);
			const { mondays } = seeded;
			const countdown = `10K race ${RACE_IN}`;
			const deload = await getWeekLine(owner, at(mondays.deload), { db });
			expect(deload).toEqual({
				line: { label: 'Deload week', why: M7_DELOAD, countdown },
				marks: {
					[KIND_WEEKS.deload]: 'Deload',
					[KIND_WEEKS.taper]: 'Taper',
					[KIND_WEEKS.race]: 'Event'
				}
			});
			expect((await getWeekLine(owner, at(mondays.taper), { db })).line).toEqual({
				label: 'Taper',
				why: M7_TAPER,
				countdown
			});
			expect((await getWeekLine(owner, at(mondays.race), { db })).line).toEqual({
				label: 'Event week',
				why: M7_TAPER,
				countdown
			});
			// A normal week has no line, and a version that holds the same weeks marks the same.
			const next = await getWeekLine(owner, at(mondays.next, 2), { db });
			expect(next).toEqual({ line: null, marks: deload.marks });
			// Without the line (a past week's), it reads the words and never the decisions.
			const words = { ...at(mondays.deload), withLine: false };
			expect(await getWeekLine(owner, words, { db: decisionsDown(db) })).toEqual({
				line: null,
				marks: deload.marks
			});
		});
	});

	it('a second event’s mini-taper in the block leaves the taper and race weeks their own event’s why', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, at } = await seedM7(db);
			const { programId, mondays } = seeded;
			const { block } = await lineagesOf(db, owner, programId, KIND_WEEKS.taper);
			// As season.ts logs an overlap's taper: after the host's own, naming the same block.
			await insertDecision(db, programId, {
				kind: 'taper_planned',
				summary: 'Taper before 5K tune-up: 3 days',
				affected: [block],
				evidence: { event: '5K tune-up', date: addDays(mondays.next, 5) }
			});
			const why = async (monday: string) =>
				(await getWeekLine(owner, at(monday), { db })).line?.why;
			expect(await why(mondays.taper)).toBe(M7_TAPER);
			expect(await why(mondays.race)).toBe(M7_TAPER);
		});
	});

	it('another owner’s program, or a version it does not have, has no line and no words', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, at } = await seedM7(db);
			const stranger = await makeSecondOwner(db);
			expect(await getWeekLine(stranger, at(seeded.mondays.deload), { db })).toEqual({
				line: null,
				marks: {}
			});
			expect(await getWeekLine(owner, at(seeded.mondays.deload, 9), { db })).toEqual({
				line: null,
				marks: {}
			});
		});
	});
});

describe('getWeekLine, an M3-built program', () => {
	it('gives block_structure’s and event_taper’s summaries, then the default', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, at } = await seedM3(db);
			const { mondays } = seeded;
			const countdown = `5K race ${RACE_IN}`;
			const line = async (monday: string) => (await getWeekLine(owner, at(monday), { db })).line;
			expect(await line(mondays.deload)).toEqual({
				label: 'Deload week',
				why: M3_STRUCTURE,
				countdown
			});
			expect(await line(mondays.taper)).toEqual({ label: 'Taper', why: M3_TAPER, countdown });
			// event_taper names the taper week: it explains race week after it too.
			expect(await line(mondays.race)).toEqual({ label: 'Event week', why: M3_TAPER, countdown });
			// No decision names the second block or its deload.
			expect(await line(mondays.lateDeload)).toEqual({
				label: 'Deload week',
				why: WEEK_KIND_WHY.deload,
				countdown
			});
			const { marks } = await getWeekLine(owner, at(mondays.deload), { db });
			expect(marks).toEqual({
				[M3_WEEKS.deload]: 'Deload',
				[M3_WEEKS.taper]: 'Taper',
				[M3_WEEKS.race]: 'Event',
				[M3_WEEKS.lateDeload]: 'Deload'
			});
		});
	});

	it('the week’s own M7 decision comes before M3’s, and one naming the week before its block’s', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, at } = await seedM3(db);
			const { programId, mondays } = seeded;
			const before = await lineagesOf(db, owner, programId, M3_WEEKS.deload - 1);
			const deload = await lineagesOf(db, owner, programId, M3_WEEKS.deload);
			const late = await lineagesOf(db, owner, programId, M3_WEEKS.lateDeload);
			const why = async (monday: string) =>
				(await getWeekLine(owner, at(monday), { db })).line?.why;
			expect(await why(mondays.deload)).toBe(M3_STRUCTURE);

			// A deload decision about another week of the block explains nothing about this one.
			await insertDecision(db, programId, {
				kind: 'deload_scheduled',
				summary: 'Deload in week 4',
				affected: [before.week]
			});
			expect(await why(mondays.deload)).toBe(M3_STRUCTURE);

			// An M7 deload decision naming the block comes before M3's block_structure.
			await insertDecision(db, programId, {
				kind: 'deload_scheduled',
				summary: 'A deload ends the block',
				affected: [deload.block]
			});
			expect(await why(mondays.deload)).toBe('A deload ends the block');

			// One naming the week comes before it, and stays first once a newer one names the block.
			await insertDecision(db, programId, {
				kind: 'deload_triggered',
				summary: 'Deload in week 5',
				affected: [deload.week]
			});
			await insertDecision(db, programId, {
				kind: 'deload_scheduled',
				summary: 'Deloads close every block',
				affected: [deload.block]
			});
			expect(await why(mondays.deload)).toBe('Deload in week 5');

			// None of them is about the second block, and a kind the week does not read is passed over.
			await insertDecision(db, programId, {
				kind: 'session_moved',
				summary: 'Moved something',
				affected: [late.week, late.block]
			});
			expect(await why(mondays.lateDeload)).toBe(WEEK_KIND_WHY.deload);
		});
	});
});

describe('countdownOf', () => {
	const goal = (eventDate: string | null, status = 'active' as const) => ({
		title: 'Marathon',
		eventDate,
		status
	});

	it('names the nearest open event within the window, in days', () => {
		expect(countdownOf([goal(addDays(TODAY, 18)), goal(addDays(TODAY, 30))], TODAY)).toBe(
			'Marathon in 18 days'
		);
		expect(countdownOf([goal(TODAY)], TODAY)).toBe('Marathon today');
		expect(countdownOf([goal(addDays(TODAY, 1))], TODAY)).toBe('Marathon tomorrow');
		expect(countdownOf([goal(addDays(TODAY, COUNTDOWN_DAYS))], TODAY)).toBe(
			`Marathon in ${COUNTDOWN_DAYS} days`
		);
	});

	it('leaves out an event past the window, a passed one, a dropped goal’s and an undated goal', () => {
		expect(
			countdownOf(
				[
					goal(addDays(TODAY, COUNTDOWN_DAYS + 1)),
					goal(addDays(TODAY, -1)),
					{ ...goal(addDays(TODAY, 3)), status: 'dropped' },
					goal(null)
				],
				TODAY
			)
		).toBeUndefined();
	});
});

describe('Train’s load', () => {
	it('carries the line on a light week still ahead, and none on a normal or a past one', async () => {
		await withRollback(async (db) => {
			const { owner } = await seedM7(db);
			const load = async (week: number | null, now = NOW) =>
				program(
					await loadTrainWeek(
						owner,
						{ now, week: week === null ? null : String(week), origin: origin() },
						{ db }
					)
				);
			const current = await load(null);
			expect(current.shown).toBe(KIND_WEEKS.deload);
			expect(current.weekKind).toEqual({
				label: 'Deload week',
				why: `${M7_DELOAD} · 10K race ${RACE_IN}`
			});
			expect(current.marks).toEqual({ 2: 'Deload', 4: 'Taper', 5: 'Event' });
			expect(addedBy(current, ['weekKind', 'marks'])).toBeLessThanOrEqual(PAGE_DATA_B);
			expect((await load(KIND_WEEKS.taper)).weekKind?.label).toBe('Taper');
			expect((await load(KIND_WEEKS.next)).weekKind).toBeNull();
			// A week later the deload has passed: no line on it, and its pill keeps its word.
			const later = await load(KIND_WEEKS.deload, new Date(NOW.getTime() + 7 * 86_400_000));
			expect(later.weekKind).toBeNull();
			expect(later.marks).toEqual(current.marks);
		});
	});

	it('with the decisions unreadable, it renders the week without the line and records the error', async () => {
		await withRollback(async (db) => {
			const { owner } = await seedM7(db);
			const request = origin();
			const data = program(
				await loadTrainWeek(
					owner,
					{ now: NOW, week: null, origin: request },
					{ db, errorsDb: db, periodisation: { line: { db: decisionsDown(db) } } }
				)
			);
			expect(data.weekKind).toBeNull();
			expect(data.marks).toEqual({});
			expect(data.days.flatMap((d) => d.cards).length).toBeGreaterThan(0);
			const recorded = await findErrorsByRequestId(request.requestId, { db });
			expect(recorded).toHaveLength(1);
			expect(recorded[0]).toMatchObject({
				kind: 'load',
				status: 500,
				path: '/train',
				context: expect.objectContaining({ load: 'train', part: 'weekLine' })
			});
		});
	});

	it('an M3-built program’s deload week names block_structure’s summary', async () => {
		await withRollback(async (db) => {
			const { owner } = await seedM3(db);
			const data = program(
				await loadTrainWeek(owner, { now: NOW, week: null, origin: origin() }, { db })
			);
			expect(data.shown).toBe(M3_WEEKS.deload);
			expect(data.weekKind).toEqual({
				label: 'Deload week',
				why: `${M3_STRUCTURE} · 5K race ${RACE_IN}`
			});
		});
	});
});

describe('Today’s plan', () => {
	const todayOf = async (
		db: Executor,
		owner: string,
		line?: Parameters<typeof loadTodayPlan>[2]
	) => {
		const current = (await getCurrentProgram(owner, TODAY, { db }))!;
		const request = origin(crypto.randomUUID(), '/today');
		const view = await loadTodayPlan(
			owner,
			{ today: TODAY, program: current, origin: request },
			{ db, errorsDb: db, ...line }
		);
		if (view.failed) throw new Error('the plan failed to load');
		return { view, request };
	};

	it('names this week’s deload, M7’s and M3’s alike', async () => {
		await withCommitted(async (db) => {
			const { owner } = await seedM7(db);
			const { view } = await todayOf(db, owner);
			expect(view.weekKind).toEqual({
				label: 'Deload week',
				why: `${M7_DELOAD} · 10K race ${RACE_IN}`
			});
			expect(addedBy(view, ['weekKind'])).toBeLessThanOrEqual(PAGE_DATA_B);
		});
		await withCommitted(async (db) => {
			const { owner } = await seedM3(db);
			const { view } = await todayOf(db, owner);
			expect(view.weekKind).toEqual({
				label: 'Deload week',
				why: `${M3_STRUCTURE} · 5K race ${RACE_IN}`
			});
		});
	});

	it('with the line unreadable, the plan shows without it and the error is recorded', async () => {
		await withCommitted(async (db) => {
			const { owner } = await seedM7(db);
			const { view, request } = await todayOf(db, owner, {
				line: () => Promise.reject(new Error('decisions unreachable'))
			});
			expect(view.weekKind).toBeNull();
			expect(view.week?.days).toHaveLength(7);
			const recorded = await findErrorsByRequestId(request.requestId, { db });
			expect(recorded).toHaveLength(1);
			expect(recorded[0]).toMatchObject({
				kind: 'streamed',
				context: expect.objectContaining({ load: 'todayWeekLine' })
			});
		});
	});
});
