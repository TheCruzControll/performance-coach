/**
 * 'Why this day?' (services/periodisation/explain.ts, m7/14) on real Postgres, for the
 * periodisation-week fixture on a pinned Wednesday: next week's Lower A, which the owner moved
 * in version 2, lists the owner's move and then version 1's placement; the owner's moves come
 * first and a session lists at most MAX_WHY_ITEMS; only the placement kinds are read; another
 * program's or owner's decisions never appear; a session no decision names has no disclosure. A
 * priority trade-off that keeps a clash becomes the resolution of the finding it explains
 * (getWeekEvaluation), and one that keeps none (a long run's length) leaves it a heads-up. Train's
 * load carries the disclosures, and when the decisions cannot be read it records the failure and
 * renders the findings without them. Every read runs one query at a time on one client (the
 * setup's busy-client guard fails the test otherwise).
 */
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../src/lib/server/db';
import { PERIODISATION_INDEXES } from '../../../src/lib/server/db/queries/periodisation';
import { programmingDecisions, programVersions } from '../../../src/lib/server/db/schema';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import {
	getWeekEvaluation,
	NOTE_LABEL
} from '../../../src/lib/server/services/periodisation/evaluate';
import {
	getPlacementWhy,
	MAX_WHY_ITEMS
} from '../../../src/lib/server/services/periodisation/explain';
import { getAthleteProfile } from '../../../src/lib/server/services/profile/index';
import {
	createProgramFromPlan,
	getCurrentProgram,
	getProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import {
	FIXTURE_WEEKS,
	type PeriodisationWeekResult
} from '../../../src/lib/server/test-support/analytics-fixtures/periodisation-week';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { loadTrainWeek, type TrainWeekData } from '../../../src/routes/(app)/train/week.server';
import { unreachableDb, withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';

/** Wednesday 11 November 2026, noon, on UTC: this week starts Monday 9 November. */
const NOW = new Date('2026-11-11T12:00:00Z');
const TODAY = '2026-11-11';

const MOVED_WHY = 'You moved Lower A from Fri to Mon. Friday is busy at work.';
const RULE_WHY =
	'Heavy lower body the day before hard Muay Thai: Lower A on Wednesday, then Muay Thai class on Thursday, so Lower A goes on Friday morning instead.';

async function seed(db: Executor, owner?: string) {
	const ownerId = owner ?? (await makeOwner(db));
	const seeded = (await seedAnalyticsFixture(
		ownerId,
		'periodisation-week',
		{ timeZone: 'UTC', now: NOW },
		{ db }
	)) as unknown as PeriodisationWeekResult;
	const program = (await getCurrentProgram(ownerId, TODAY, { db }))!;
	return { owner: ownerId, seeded, program };
}

/** The sessions of the program's week `place` in Base (2 is next week), as the store holds them. */
async function weekSessions(db: Executor, owner: string, programId: string, place: number) {
	const { number } = (await getCurrentProgram(owner, TODAY, { db }))!.version;
	const version = await getProgramVersion(owner, programId, number, { db });
	return version.blocks[0]!.weeks[place]!.sessions.map(({ lineage, date, title }) => ({
		lineage,
		date,
		title
	}));
}

/** The sessions a generator's decision names in a hybrid week: the classes and Lower A. */
const NAMED = ['Muay Thai class', 'Lower A'];

const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/train',
	routeId: '/(app)/train',
	appVersion: '0.1.0+test'
});

function program(data: TrainWeekData) {
	if (data.state !== 'program') throw new Error(`expected a program, got ${data.state}`);
	return data;
}

/**
 * Week 1 of the one-week fixture: Monday's heavy squats the day before Tuesday's class. The owner
 * gets a priority trade-off under `ruleKey` (none when null).
 */
async function tradeoffWeek(db: Executor, ruleKey: string | null = 'placement.priority_kept') {
	const owner = await makeOwner(db);
	// The profile row a program's owner has (ownerWithProfile in context.test.ts): the context reads it.
	await getAthleteProfile(owner, { db });
	const plan = programFixture('one-week', { monday: '2026-11-09', today: '2026-11-09' });
	const monday = plan.blocks[0]!.weeks[0]!.sessions[0]!;
	if (monday.kind !== 'strength') throw new Error('expected Monday’s strength session');
	// Its back squat (exercise 2) at RPE 8: heavy lower body.
	const squat = monday.exercises[1]!;
	squat.sets = squat.sets.map((set) => ({ ...set, targetRpe: 8 }));
	if (ruleKey) {
		plan.decisions.push({
			kind: 'priority_tradeoff',
			ruleKey,
			summary: 'Strength over Muay Thai',
			why: 'Your strength goal ranks above Muay Thai, so its Full body keeps Monday.',
			decidedBy: 'rules',
			refs: ['blocks.0.weeks.0.sessions.0'],
			evidence: {}
		});
	}
	await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
	return owner;
}

/** A decision written straight into the store, `minutes` after the fixture's clock. */
async function insertDecision(
	db: Executor,
	at: { programId: string; version: number; lineage: string; minutes: number },
	over: Partial<typeof programmingDecisions.$inferInsert> = {}
) {
	const [version] = await db
		.select({ id: programVersions.id })
		.from(programVersions)
		.where(
			and(eq(programVersions.programId, at.programId), eq(programVersions.number, at.version))
		);
	await db.insert(programmingDecisions).values({
		programId: at.programId,
		versionId: version!.id,
		kind: 'schedule_repaired',
		summary: `Repair ${at.minutes}`,
		why: `Repaired after ${at.minutes} minutes.`,
		decidedBy: 'rules',
		affected: [at.lineage],
		createdAt: new Date(NOW.getTime() + at.minutes * 60_000),
		...over
	});
}

describe('getPlacementWhy', () => {
	it('a session moved in version 2 lists the owner’s move, then version 1’s placement', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, program: p } = await seed(db);
			const sessions = await weekSessions(db, owner, p.id, 2);
			const view = await getPlacementWhy(owner, { programId: p.id, sessions }, { db });
			expect(view.byLineage[seeded.lineages.moved!]).toEqual({
				title: 'Why Monday?',
				items: [
					{
						kind: 'Session moved',
						summary: 'Moved Lower A from Fri to Mon',
						why: expect.stringMatching(new RegExp(`^${MOVED_WHY}`)),
						decidedBy: 'You',
						version: 2
					},
					{
						kind: 'Interference avoided',
						summary: 'Lower A kept clear of Muay Thai class',
						why: RULE_WHY,
						decidedBy: 'Programming rules',
						version: 1
					}
				]
			});
			// Each session a decision names says why, Tuesday's class by its commitment; Upper A and
			// the runs, which no generator stage explains, have none.
			expect(Object.keys(view.byLineage).sort()).toEqual(
				sessions
					.filter((s) => NAMED.includes(s.title))
					.map((s) => s.lineage)
					.sort()
			);
			expect(view.byLineage[seeded.lineages.hardMuayThai!]).toMatchObject({
				title: 'Why Tuesday?',
				items: [{ kind: 'Commitment placed', decidedBy: 'Programming rules', version: 1 }]
			});
			expect(view.tradeoffs).toEqual([]);
		});
	});

	it('the owner’s moves come first, then the newest, at most six, of the placement kinds only', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, program: p } = await seed(db);
			const lineage = seeded.lineages.moved!;
			// Seven repairs written after the move, and a newer swap, which is not a placement.
			for (let minutes = 1; minutes <= 7; minutes++) {
				await insertDecision(db, { programId: p.id, version: 2, lineage, minutes });
			}
			await insertDecision(
				db,
				{ programId: p.id, version: 2, lineage, minutes: 60 },
				{ kind: 'exercise_swapped', summary: 'Swapped', why: 'A swap.' }
			);
			const sessions = await weekSessions(db, owner, p.id, 2);
			const { byLineage } = await getPlacementWhy(owner, { programId: p.id, sessions }, { db });
			const items = byLineage[lineage]!.items;
			expect(items).toHaveLength(MAX_WHY_ITEMS);
			expect(items.map((i) => i.summary)).toEqual([
				'Moved Lower A from Fri to Mon',
				'Repair 7',
				'Repair 6',
				'Repair 5',
				'Repair 4',
				'Repair 3'
			]);
		});
	});

	it('another program’s or another owner’s decisions never appear', async () => {
		await withRollback(async (db) => {
			const mine = await seed(db);
			const theirs = await seed(db, await makeSecondOwner(db));
			const their = await weekSessions(db, theirs.owner, theirs.program.id, 2);
			const own = await weekSessions(db, mine.owner, mine.program.id, 2);
			// My program asked about their sessions, and their program asked by me: nothing.
			const empty = { byLineage: {}, tradeoffs: [] };
			expect(
				await getPlacementWhy(mine.owner, { programId: mine.program.id, sessions: their }, { db })
			).toEqual(empty);
			expect(
				await getPlacementWhy(mine.owner, { programId: theirs.program.id, sessions: their }, { db })
			).toEqual(empty);
			// Both at once: only mine.
			const both = await getPlacementWhy(
				mine.owner,
				{ programId: mine.program.id, sessions: [...own, ...their] },
				{ db }
			);
			expect(Object.keys(both.byLineage).sort()).toEqual(
				own
					.filter((s) => NAMED.includes(s.title))
					.map((s) => s.lineage)
					.sort()
			);
		});
	});

	it('a session no decision names gets no disclosure', async () => {
		await withRollback(async (db) => {
			const { owner, program: p } = await seed(db);
			// This week's easy runs, and yesterday's Lower B and Sparring: no decision names them.
			const sessions = await weekSessions(db, owner, p.id, 1);
			expect(sessions.length).toBeGreaterThan(0);
			expect(await getPlacementWhy(owner, { programId: p.id, sessions }, { db })).toEqual({
				byLineage: {},
				tradeoffs: []
			});
			expect(await getPlacementWhy(owner, { programId: p.id, sessions: [] }, { db })).toEqual({
				byLineage: {},
				tradeoffs: []
			});
			const data = program(
				await loadTrainWeek(owner, { now: NOW, week: null, origin: origin() }, { db })
			);
			expect(data.noteParts.why).toEqual([]);
		});
	});

	it('names the index its read is shaped for, and the index exists', async () => {
		await withRollback(async (db) => {
			const { rows } = await db.execute<{ indexname: string }>(
				sql`select indexname from pg_indexes where schemaname = 'public'`
			);
			const existing = rows.map((r) => r.indexname);
			for (const name of Object.values(PERIODISATION_INDEXES)) {
				expect(existing, name).toContain(name);
			}
		});
	});

	it('a priority trade-off that keeps a clash becomes the resolution of the finding it explains', async () => {
		await withRollback(async (db) => {
			const owner = await tradeoffWeek(db);
			const p = (await getCurrentProgram(owner, TODAY, { db }))!;
			const sessions = await weekSessions(db, owner, p.id, 0);
			const { tradeoffs } = await getPlacementWhy(owner, { programId: p.id, sessions }, { db });
			expect(tradeoffs).toHaveLength(1);
			const monday = sessions.find((s) => s.date === '2026-11-09')!;
			const { requestId } = origin();
			const week = await getWeekEvaluation(
				owner,
				{
					version: p.version.number,
					weekStartsOn: '2026-11-09',
					today: '2026-11-09',
					tradeoffs
				},
				{ db, errorsDb: db, origin: origin(requestId) }
			);
			// The evaluation context loaded: its days are the week's, and no read of it failed.
			expect(week.days.length).toBeGreaterThan(0);
			expect(await findErrorsByRequestId(requestId, { db })).toEqual([]);
			expect(week.notes[monday.lineage]).toMatchObject({
				label: NOTE_LABEL.tradeOff,
				text: expect.stringMatching(
					/^Trade-off, explained · Heavy lower body the day before hard Muay Thai · /
				),
				why: expect.stringMatching(
					/Your strength goal ranks above Muay Thai, so its Full body keeps Monday\.$/
				)
			});
			// The context's three-hard-day finding also shares that sentence: two trade-offs, as Train's
			// test counts them.
			expect(week.summary).toMatch(/2 trade-offs, explained$/);
		});
	});
});

describe('a priority trade-off', () => {
	const monday = new Date('2026-11-09T12:00:00Z');

	it('becomes the resolution of the finding it explains, and is listed in the why', async () => {
		await withRollback(async (db) => {
			const owner = await tradeoffWeek(db);
			const data = await loadTrainWeek(
				owner,
				{ now: monday, week: null, origin: origin() },
				{ db }
			);
			// Monday's Full body: the week's first finding and first why (v2/07, the week's note).
			const { noteParts } = program(data);
			expect(noteParts.findings[0]).toMatchObject({
				label: 'Trade-off, explained',
				text: expect.stringMatching(
					/^Trade-off, explained · Heavy lower body the day before hard Muay Thai · /
				),
				why: expect.stringMatching(
					/Your strength goal ranks above Muay Thai, so its Full body keeps Monday\.$/
				)
			});
			// With the evaluation context (m7/22), Monday to Wednesday is also three hard days in a
			// row, which shares the Monday trade-off's sentence.
			expect(noteParts.summary).toMatch(/2 trade-offs, explained$/);
			expect(noteParts.why[0]).toEqual({
				title: 'Why Monday?',
				lines: [
					'Priority trade-off (Programming rules, version 1): Your strength goal ranks above Muay Thai, so its Full body keeps Monday.'
				]
			});
		});
	});

	it('one that keeps no clash, such as a long run’s length, leaves the finding a heads-up', async () => {
		await withRollback(async (db) => {
			const owner = await tradeoffWeek(db, 'running.long_run_length');
			const data = await loadTrainWeek(
				owner,
				{ now: monday, week: null, origin: origin() },
				{ db }
			);
			const { noteParts } = program(data);
			expect(noteParts.findings[0]).toMatchObject({
				label: 'Heads-up',
				text: expect.stringMatching(/^Heads-up · Heavy lower body the day before hard Muay Thai · /)
			});
			expect(noteParts.summary).not.toMatch(/trade-off/);
			// It still says why, in the week's note.
			const mondayWhy = noteParts.why.find((w) => w.title === 'Why Monday?');
			expect(mondayWhy?.lines).toEqual([expect.stringMatching(/^Priority trade-off /)]);
		});
	});

	it('without it the same clash is a heads-up', async () => {
		await withRollback(async (db) => {
			const owner = await tradeoffWeek(db, null);
			const data = await loadTrainWeek(
				owner,
				{ now: monday, week: null, origin: origin() },
				{ db }
			);
			const { noteParts } = program(data);
			expect(noteParts.findings[0]).toMatchObject({
				label: 'Heads-up',
				text: expect.stringMatching(/^Heads-up · Heavy lower body the day before hard Muay Thai · /)
			});
			expect(noteParts.why.find((w) => w.title === 'Why Monday?')).toBeUndefined();
			expect(noteParts.summary).not.toMatch(/trade-off/);
		});
	});
});

describe('Train’s load with the why', () => {
	it('puts each session’s why in the week’s note, as plain lines, the owner’s move first', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const data = program(
				await loadTrainWeek(
					owner,
					{ now: NOW, week: String(FIXTURE_WEEKS.moved), origin: origin() },
					{ db }
				)
			);
			// The sessions a decision names, and only those, say why: Lower A (moved to Monday, the
			// week's first line) and the two classes, in the week's order.
			expect(data.noteParts.why).toHaveLength(3);
			expect(data.lines[0]!.session?.lineage).toBe(seeded.lineages.moved);
			const [moved] = data.noteParts.why;
			expect(moved!.title).toBe('Why Monday?');
			expect(moved!.lines).toEqual([
				expect.stringMatching(new RegExp(`^Session moved \\(You, version 2\\): ${MOVED_WHY}`)),
				`Interference avoided (Programming rules, version 1): ${RULE_WHY}`
			]);
			// The finding still shows beside it.
			expect(data.noteParts.findings[0]?.label).toBe('Heads-up');
		});
	});

	it('with the decisions unreachable, it renders the findings without disclosures and records the error', async () => {
		const broken = unreachableDb();
		try {
			await withRollback(async (db) => {
				const { owner, seeded } = await seed(db);
				const request = origin();
				const data = program(
					await loadTrainWeek(
						owner,
						{ now: NOW, week: String(FIXTURE_WEEKS.moved), origin: request },
						{ db, errorsDb: db, periodisation: { why: { db: broken.db } } }
					)
				);
				expect(data.noteParts.why).toEqual([]);
				expect(data.noteParts.summary).toBe('1 heads-up this week');
				// The moved session's note and the class's, in the week's order.
				expect(data.noteParts.findings).toHaveLength(2);
				expect(data.noteParts.findings[0]!.text).toMatch(/ · You moved this here$/);
				expect(data.lines.map((l) => l.session?.lineage)).toEqual(
					expect.arrayContaining([seeded.lineages.moved, seeded.lineages.hardMuayThai])
				);
				const recorded = await findErrorsByRequestId(request.requestId, { db });
				expect(recorded).toHaveLength(1);
				expect(recorded[0]).toMatchObject({
					kind: 'load',
					status: 500,
					path: '/train',
					context: expect.objectContaining({ load: 'train', part: 'why' })
				});
			});
		} finally {
			await broken.close();
		}
	});

	it('with periodisation off, nothing is read', async () => {
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			const data = program(
				await loadTrainWeek(
					owner,
					{ now: NOW, week: String(FIXTURE_WEEKS.moved), origin: origin() },
					{ db, periodisation: false }
				)
			);
			expect(data.noteParts.why).toEqual([]);
		});
	});

	it('runs one query at a time on one client: the why, then the findings, then the rest', async () => {
		// withRollback hands every read one client; the setup fails a query sent while it is busy.
		await withRollback(async (db) => {
			const { owner } = await seed(db);
			for (const week of [null, String(FIXTURE_WEEKS.moved), String(FIXTURE_WEEKS.past)]) {
				const data = program(
					await loadTrainWeek(owner, { now: NOW, week, origin: origin() }, { db })
				);
				expect(data.week.planned && data.week.days.length).toBe(7);
			}
		});
	});
});
