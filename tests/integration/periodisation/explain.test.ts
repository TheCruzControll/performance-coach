/**
 * 'Why this day?' (services/periodisation/explain.ts, m7/14) on real Postgres, for the
 * periodisation-week fixture on a pinned Wednesday: next week's Lower A, which the owner moved
 * in version 2, lists the owner's move and then version 1's placement; the owner's moves come
 * first and a session lists at most MAX_WHY_ITEMS; only the placement kinds are read; another
 * program's or owner's decisions never appear; a session no decision names has no disclosure. A
 * priority trade-off that keeps a clash becomes the resolution of the finding it explains
 * (getWeekEvaluation). Every read runs one query at a time on one client (the setup's
 * busy-client guard fails the test otherwise).
 */
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../src/lib/server/db';
import { PERIODISATION_INDEXES } from '../../../src/lib/server/db/queries/periodisation';
import { programmingDecisions, programVersions } from '../../../src/lib/server/db/schema';
import {
	getWeekEvaluation,
	NOTE_LABEL
} from '../../../src/lib/server/services/periodisation/evaluate';
import {
	getPlacementWhy,
	MAX_WHY_ITEMS
} from '../../../src/lib/server/services/periodisation/explain';
import {
	createProgramFromPlan,
	getCurrentProgram,
	getProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import type { PeriodisationWeekResult } from '../../../src/lib/server/test-support/analytics-fixtures/periodisation-week';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
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

/** Week 1 of the one-week fixture: Monday's heavy squats the day before Tuesday's class. */
async function tradeoffWeek(db: Executor) {
	const owner = await makeOwner(db);
	const plan = programFixture('one-week', { monday: '2026-11-09', today: '2026-11-09' });
	const monday = plan.blocks[0]!.weeks[0]!.sessions[0]!;
	if (monday.kind !== 'strength') throw new Error('expected Monday’s strength session');
	// Its back squat (exercise 2) at RPE 8: heavy lower body.
	const squat = monday.exercises[1]!;
	squat.sets = squat.sets.map((set) => ({ ...set, targetRpe: 8 }));
	plan.decisions.push({
		kind: 'priority_tradeoff',
		ruleKey: 'placement.priority_kept',
		summary: 'Strength over Muay Thai',
		why: 'Your strength goal ranks above Muay Thai, so its Full body keeps Monday.',
		decidedBy: 'rules',
		refs: ['blocks.0.weeks.0.sessions.0'],
		evidence: {}
	});
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
			const week = await getWeekEvaluation(
				owner,
				{
					version: p.version.number,
					weekStartsOn: '2026-11-09',
					today: '2026-11-09',
					tradeoffs
				},
				{ db }
			);
			expect(week.notes[monday.lineage]).toMatchObject({
				label: NOTE_LABEL.tradeOff,
				text: expect.stringMatching(
					/^Trade-off, explained · Heavy lower body the day before hard Muay Thai · /
				),
				why: expect.stringMatching(
					/Your strength goal ranks above Muay Thai, so its Full body keeps Monday\.$/
				)
			});
			expect(week.summary).toMatch(/1 trade-off, explained$/);
		});
	});
});
