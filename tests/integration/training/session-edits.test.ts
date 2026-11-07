/**
 * The session screen's edits on real Postgres (src/routes/(app)/train/session/[key]): the load
 * offers Move on the current version's sessions dated today or later, with the days of the
 * week it can reach, and says why any other session stays as it is; the `move` and `checkMove`
 * actions post through programAction to the program edit services. A move is the next version
 * with the owner's reason; a check writes nothing; a page left open on an older version
 * conflicts and changes nothing. Today is the owner's, in the time zone on their profile.
 *
 * The hybrid fixture's week 1 runs Monday 9 to Sunday 15 November 2026: Full body on Monday,
 * Muay Thai on Tuesday and Thursday evenings, Intervals on Wednesday, an Easy run on Thursday.
 */
import { isActionFailure } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { workouts, type Executor } from '../../../src/lib/server/db';
import { getAthleteProfile, saveBasics } from '../../../src/lib/server/services/profile/index';
import {
	createProgramFromPlan,
	getPlannedSession,
	getProgramVersion,
	getVersionHistory,
	skipSession,
	type ProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { EDITS_LOCKED } from '../../../src/lib/ui/program/session-words';
import {
	loadSessionDetail,
	type SessionDetailData
} from '../../../src/routes/(app)/train/session/[key]/detail.server';
import { editActions } from '../../../src/routes/(app)/train/session/[key]/edits.server';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const [MON, TUE, WED, THU, FRI, SAT, SUN] = [0, 1, 2, 3, 4, 5, 6].map((n) =>
	addDays(MONDAY, n)
) as [string, string, string, string, string, string, string];
/** Monday morning in UTC, the profile's zone until the owner sets one. */
const MONDAY_MORNING = new Date(`${MON}T08:00:00Z`);

async function withProgram(db: Executor) {
	const owner = await makeOwner(db);
	const plan = programFixture('hybrid', { monday: MONDAY, today: MONDAY });
	const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
	return { owner, programId, stored: await getProgramVersion(owner, programId, 1, { db }) };
}

/** A session of version 1 by its week (0 is week 1) and title. */
function sessionOf(stored: ProgramVersion, week: number, title: string) {
	const weeks = stored.blocks.flatMap((b) => b.weeks);
	return weeks[week]!.sessions.find((s) => s.title === title)!;
}

const origin = {
	requestId: 'test',
	method: 'GET',
	path: '/train/session/x',
	routeId: '/(app)/train/session/[key]',
	appVersion: '0.1.0+test'
};

/** The session screen as loaded at `now` (fails the test for the error state). */
async function screen(db: Executor, owner: string, key: string, now: Date, version?: string) {
	const data: SessionDetailData = await loadSessionDetail(
		owner,
		{ key, version: version ?? null, now, origin },
		{ db }
	);
	if (data.state !== 'session') throw new Error(`expected a session, got ${data.state}`);
	// Swap's stream shares the test's transaction: settled before the test's next query.
	await data.swaps;
	return data;
}

async function setTimeZone(db: Executor, owner: string, timeZone: string) {
	const { name, weightUnit, distanceUnit } = await getAthleteProfile(owner, { db });
	await saveBasics(owner, { name, weightUnit, distanceUnit, timeZone }, { db });
}

function locals(ownerId: string): App.Locals {
	return {
		requestId: 'test',
		session: {
			id: crypto.randomUUID(),
			ownerId,
			ownerName: 'Niko',
			kind: 'owner',
			expiresAt: new Date(),
			reauthenticatedAt: null
		}
	};
}

/** What the sheet posts: its state as JSON in `payload`, to ?/move or ?/checkMove. */
function post(payload: unknown): Request {
	const body = new FormData();
	body.set('payload', JSON.stringify(payload));
	return new Request('http://localhost/train/session/x?/move', { method: 'POST', body });
}

/** Run an edit action as `owner` at `now`, in the test's transaction. */
function act(
	db: Executor,
	owner: string,
	action: 'move' | 'checkMove',
	payload: unknown,
	now = MONDAY_MORNING
) {
	return editActions({ db, now: () => now })[action]({
		locals: locals(owner),
		request: post(payload)
	});
}

/** A failed action's status and data (fails the test if the action succeeded). */
function failure(result: unknown) {
	if (!isActionFailure(result))
		throw new Error(`expected a failure, got ${JSON.stringify(result)}`);
	return { status: result.status, data: result.data as unknown };
}

async function versionCount(db: Executor, owner: string) {
	return (await getVersionHistory(owner, {}, { db }))!.versions.length;
}

describe('the session screen’s edits, as loaded', () => {
	it('offers Move on the current version: every later day of the week, with what is planned there', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const full = sessionOf(stored, 0, 'Full body');
			const { edits } = await screen(db, owner, full.lineage, MONDAY_MORNING);
			expect(edits).toEqual({
				version: 1,
				locked: null,
				moveTo: [
					{ date: TUE, label: 'Tue 10 Nov', day: 'Tuesday', planned: 'Muay Thai class' },
					{ date: WED, label: 'Wed 11 Nov', day: 'Wednesday', planned: 'Intervals' },
					{
						date: THU,
						label: 'Thu 12 Nov',
						day: 'Thursday',
						planned: 'Easy run · Muay Thai class'
					},
					{ date: FRI, label: 'Fri 13 Nov', day: 'Friday', planned: 'Rest day' },
					{ date: SAT, label: 'Sat 14 Nov', day: 'Saturday', planned: 'Rest day' },
					{ date: SUN, label: 'Sun 15 Nov', day: 'Sunday', planned: 'Rest day' }
				]
			});
		});
	});

	it('says why a session stays as it is: its day has passed, it is skipped, or it is logged', async () => {
		await withRollback(async (db) => {
			const { owner, programId, stored } = await withProgram(db);
			const wednesday = new Date(`${WED}T08:00:00Z`);
			const full = sessionOf(stored, 0, 'Full body');
			const intervals = sessionOf(stored, 0, 'Intervals');
			const easy = sessionOf(stored, 0, 'Easy run');

			// Today's session can still move, to the days after it.
			const today = (await screen(db, owner, intervals.lineage, wednesday)).edits!;
			expect(today.locked).toBeNull();
			expect(today.moveTo.map((d) => d.date)).toEqual([THU, FRI, SAT, SUN]);

			expect((await screen(db, owner, full.lineage, wednesday)).edits).toEqual({
				version: 1,
				locked: EDITS_LOCKED.passed,
				moveTo: []
			});

			await skipSession(
				owner,
				{ sessionLineage: easy.lineage },
				{ version: 1, today: WED },
				{ db }
			);
			expect((await screen(db, owner, easy.lineage, wednesday)).edits).toEqual({
				version: 2,
				locked: EDITS_LOCKED.skipped,
				moveTo: []
			});

			// Logged early: a logged session stays as it was, whatever its date.
			await db.insert(workouts).values({
				ownerId: owner,
				clientId: crypto.randomUUID(),
				kind: 'run',
				discipline: 'running',
				sessionType: 'interval_run',
				title: 'Intervals',
				plannedSessionId: intervals.id,
				plannedLineageId: intervals.lineage,
				programId,
				status: 'completed',
				startedAt: new Date(`${WED}T06:00:00Z`),
				finishedAt: new Date(`${WED}T07:00:00Z`)
			});
			expect((await screen(db, owner, intervals.lineage, wednesday)).edits).toEqual({
				version: 2,
				locked: EDITS_LOCKED.completed,
				moveTo: []
			});
		});
	});

	it('an older version has no edits: it is read-only', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const easy = sessionOf(stored, 0, 'Easy run');
			await skipSession(
				owner,
				{ sessionLineage: easy.lineage },
				{ version: 1, today: MON },
				{ db }
			);
			const full = sessionOf(stored, 0, 'Full body');
			expect((await screen(db, owner, full.lineage, MONDAY_MORNING, '1')).edits).toBeNull();
			expect((await screen(db, owner, full.lineage, MONDAY_MORNING, '2')).edits).toMatchObject({
				version: 2,
				locked: null
			});
		});
	});

	it('takes today from the owner’s time zone, not the server’s', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const full = sessionOf(stored, 0, 'Full body');
			// 02:00 on Tuesday in UTC is still Monday evening in Los Angeles.
			const late = new Date(`${TUE}T02:00:00Z`);
			expect((await screen(db, owner, full.lineage, late)).edits!.locked).toBe(EDITS_LOCKED.passed);
			await setTimeZone(db, owner, 'America/Los_Angeles');
			const edits = (await screen(db, owner, full.lineage, late)).edits!;
			expect(edits.locked).toBeNull();
			expect(edits.moveTo[0]!.date).toBe(TUE);
		});
	});
});

describe('the session screen’s edit actions', () => {
	it('moves a session to another day of its week as the next version, with the owner’s reason', async () => {
		await withRollback(async (db) => {
			const { owner, programId, stored } = await withProgram(db);
			const full = sessionOf(stored, 0, 'Full body');
			const result = await act(db, owner, 'move', {
				sessionLineage: full.lineage,
				toDate: WED,
				reason: 'Work trip on Monday',
				version: 1
			});
			expect(result).toEqual({ version: 2 });

			expect(await getPlannedSession(owner, full.lineage, {}, { db })).toMatchObject({
				date: WED,
				status: 'moved',
				movedFrom: MON,
				version: { number: 2, current: true, createdBy: 'owner' }
			});
			// Version 1 is as it was.
			const first = await getProgramVersion(owner, programId, 1, { db });
			expect(sessionOf(first, 0, 'Full body')).toMatchObject({ date: MON, status: 'planned' });

			const { versions } = (await getVersionHistory(owner, {}, { db }))!;
			expect(versions.map((v) => v.number)).toEqual([2, 1]);
			expect(versions[0]!.decisions).toHaveLength(1);
			expect(versions[0]!.decisions[0]).toMatchObject({
				kind: 'session_moved',
				decidedBy: 'owner',
				summary: 'Moved Full body from Mon to Wed',
				why: 'You moved Full body from Mon to Wed. Work trip on Monday.'
			});
		});
	});

	it('checks a move before saving, writing nothing, and records the same warning when it is saved', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			// Week 2's Full body squats heavy (82.5 % of the week-1 estimate): on Wednesday it is
			// the day before Thursday's hard Muay Thai class.
			const heavy = sessionOf(stored, 1, 'Full body');
			const wednesday = addDays(MONDAY, 9);
			const move = { sessionLineage: heavy.lineage, toDate: wednesday, version: 1 };

			const checked = (await act(db, owner, 'checkMove', move)) as {
				warnings: { severity: string; message: string }[];
			};
			const avoid = checked.warnings.filter((w) => w.severity === 'avoid');
			expect(avoid).toEqual([
				{
					severity: 'avoid',
					message:
						'Heavy lower body the day before hard Muay Thai: Full body on Wednesday, then Muay Thai class on Thursday.'
				}
			]);
			// Advice too ('prefer'): hard days back to back, which the week has room to avoid.
			expect(checked.warnings.length).toBeGreaterThan(avoid.length);
			expect(await versionCount(db, owner)).toBe(1);

			expect(await act(db, owner, 'move', move)).toEqual({ version: 2 });
			const [latest] = (await getVersionHistory(owner, {}, { db }))!.versions;
			const { why } = latest!.decisions[0]!;
			expect(why.startsWith('You moved Full body from Mon to Wed. No reason given. ')).toBe(true);
			for (const { message } of checked.warnings) expect(why).toContain(message);
		});
	});

	it('refuses an edit made on an older version (409) and changes nothing', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const full = sessionOf(stored, 0, 'Full body');
			const move = { sessionLineage: full.lineage, toDate: WED, version: 1 };
			expect(await act(db, owner, 'move', move)).toEqual({ version: 2 });

			// The same page, still on version 1.
			for (const action of ['checkMove', 'move'] as const) {
				const stale = { ...move, toDate: FRI };
				expect(failure(await act(db, owner, action, stale))).toEqual({
					status: 409,
					data: { reason: 'version' }
				});
			}
			expect(await versionCount(db, owner)).toBe(2);
			expect(await getPlannedSession(owner, full.lineage, {}, { db })).toMatchObject({ date: WED });
		});
	});

	it('refuses a day the move cannot reach at the field it is about (400), and a page with no version (404)', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const full = sessionOf(stored, 0, 'Full body');
			const move = (toDate: string, page: { version?: unknown } = { version: 1 }) =>
				act(db, owner, 'move', { sessionLineage: full.lineage, toDate, ...page });

			expect(failure(await move(MON))).toEqual({
				status: 400,
				data: { errors: { toDate: 'It is already on that day' } }
			});
			expect(failure(await move(addDays(MONDAY, 8)))).toEqual({
				status: 400,
				data: { errors: { toDate: 'Pick a day in its own week' } }
			});
			expect(failure(await move('next Wednesday'))).toMatchObject({
				status: 400,
				data: { errors: { toDate: expect.any(String) } }
			});
			for (const page of [{}, { version: '1' }, { version: null }]) {
				expect(failure(await move(WED, page))).toEqual({
					status: 404,
					data: { message: 'That no longer exists. Reload to see the latest.' }
				});
			}
			expect(await versionCount(db, owner)).toBe(1);
		});
	});

	it('refuses a session whose day has passed by the owner’s clock, in the owner’s time zone', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const full = sessionOf(stored, 0, 'Full body');
			const move = { sessionLineage: full.lineage, toDate: WED, version: 1 };
			// 02:00 on Tuesday in UTC: Monday has passed in UTC, not yet in Los Angeles.
			const late = new Date(`${TUE}T02:00:00Z`);
			expect(failure(await act(db, owner, 'move', move, late))).toEqual({
				status: 400,
				data: { errors: { sessionLineage: 'This session has passed' } }
			});
			await setTimeZone(db, owner, 'America/Los_Angeles');
			expect(await act(db, owner, 'move', move, late)).toEqual({ version: 2 });
		});
	});
});
