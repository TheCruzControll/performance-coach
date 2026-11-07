/**
 * History (src/routes/(app)/train/history/[[version]]) on real Postgres: the active program's
 * versions newest first, HISTORY_PAGE_SIZE at a time, each with its date in the owner's zone, who
 * made it and every decision with its why. /train/history/<n> is
 * version n as a read-only week, on the week its change touched. Only version 1 is 'no changes
 * yet'. ?before=n is the page below version n. A malformed or unknown version is the 404 page; a read that fails is the designed error,
 * recorded.
 *
 * The hybrid fixture's week 1 runs Monday 9 to Sunday 15 November 2026: Full body on Monday,
 * Muay Thai on Tuesday and Thursday evenings, Intervals on Wednesday, an Easy run on Thursday.
 * Today is the Monday before, so every session can still move.
 */
import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import type { Executor } from '../../../src/lib/server/db';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import { getAthleteProfile, saveBasics } from '../../../src/lib/server/services/profile/index';
import {
	createProgramFromPlan,
	getProgramVersion,
	HISTORY_PAGE_SIZE,
	moveSession,
	type ProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import {
	HISTORY_ERROR,
	loadHistory,
	NO_CHANGES,
	NO_PROGRAM,
	type HistoryData
} from '../../../src/routes/(app)/train/history/[[version]]/history.server';
import { unreachableDb, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const [MON, , WED, , FRI] = [0, 1, 2, 3, 4].map((n) => addDays(MONDAY, n)) as [
	string,
	string,
	string,
	string,
	string
];
/** The Monday before week 1, mid-morning in UTC (the profile's zone until one is set). */
const TODAY = addDays(MONDAY, -7);
const NOW = new Date(`${TODAY}T10:00:00Z`);

const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/train/history',
	routeId: '/(app)/train/history/[[version]]',
	appVersion: '0.1.0+test'
});

/** Version 1, stored at 09:15 UTC on TODAY. */
async function withProgram(db: Executor) {
	const owner = await makeOwner(db);
	const plan = programFixture('hybrid', { monday: MONDAY, today: TODAY });
	const at = () => new Date(`${TODAY}T09:15:00Z`);
	const { programId } = await createProgramFromPlan(
		owner,
		plan,
		{ source: 'rules' },
		{ db, now: at }
	);
	const stored = await getProgramVersion(owner, programId, 1, { db });
	return { owner, stored, full: lineageOf(stored, 'Full body') };
}

function lineageOf(stored: ProgramVersion, title: string) {
	return stored.blocks[0]!.weeks[0]!.sessions.find((s) => s.title === title)!.lineage;
}

/** Move `lineage` to `toDate` on version `version`, as the owner, `minutes` past 09:15 UTC. */
function move(
	db: Executor,
	owner: string,
	lineage: string,
	toDate: string,
	version: number,
	{ reason, minutes = version }: { reason?: string; minutes?: number } = {}
) {
	const at = new Date(Date.parse(`${TODAY}T09:15:00Z`) + minutes * 60_000);
	return moveSession(
		owner,
		{ sessionLineage: lineage, toDate, ...(reason ? { reason } : {}) },
		{ version, today: TODAY },
		{ db, source: 'owner', now: () => at }
	);
}

function load(db: Executor, owner: string, version?: string, before: string | null = null) {
	return loadHistory(owner, { version, before, now: NOW, origin: origin() }, { db });
}

/** The list (fails the test for any other state). */
async function list(db: Executor, owner: string, before: string | null = null) {
	const data: HistoryData = await load(db, owner, undefined, before);
	if (data.state !== 'list') throw new Error(`expected the list, got ${data.state}`);
	return data;
}

/** A version's page (fails the test for any other state). */
async function version(db: Executor, owner: string, n: string) {
	const data: HistoryData = await load(db, owner, n);
	if (data.state !== 'version') throw new Error(`expected a version, got ${data.state}`);
	return data;
}

/** The HTTP status a load was refused with (fails the test if it was not refused). */
async function status(promise: Promise<unknown>): Promise<number> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!isHttpError(error)) throw new Error(`expected an HTTP error, got ${String(error)}`);
	return error.status;
}

describe('History’s list', () => {
	it('lists the versions newest first: when, who, what changed and every decision’s why', async () => {
		await withRollback(async (db) => {
			const { owner, full } = await withProgram(db);
			await move(db, owner, full, WED, 1, { reason: 'Work trip on Monday' });
			await move(db, owner, full, FRI, 2);

			const { page, empty } = await list(db, owner);
			expect(empty).toBeNull();
			expect(page.next).toBeNull();
			expect(page.versions.map((v) => [v.number, v.when, v.by, v.current])).toEqual([
				[3, 'Mon 2 Nov · 09:17', 'You', true],
				[2, 'Mon 2 Nov · 09:16', 'You', false],
				[1, 'Mon 2 Nov · 09:15', 'Programming rules', false]
			]);
			const [v3, v2, v1] = page.versions;
			expect(v3!.summary).toBe('Moved Full body from Wed to Fri');
			// An edit's one decision says what the version says: only its why is listed.
			expect(v3!.decisions).toEqual([
				{
					id: expect.any(String),
					summary: null,
					why: 'You moved Full body from Wed to Fri. No reason given.'
				}
			]);
			expect(v2!.decisions.map((d) => d.why)).toEqual([
				'You moved Full body from Mon to Wed. Work trip on Monday.'
			]);
			// Version 1: what the rules decided, each with its own words and why.
			expect(v1!.summary).toBe('Your first program');
			expect(v1!.decisions.map((d) => d.summary)).toEqual([
				'Week 1 establishes your baselines',
				'A baseline week, then three accumulation weeks and a deload',
				'Muay Thai stays on Tuesday and Thursday evenings',
				'Power clean opens the session',
				'Sessions last up to 60 minutes'
			]);
			expect(v1!.decisions[2]!.why).toBe(
				'Your classes are fixed, so they were placed before anything else.'
			);
		});
	});

	it('dates each version in the owner’s time zone', async () => {
		await withRollback(async (db) => {
			const { owner, full } = await withProgram(db);
			await move(db, owner, full, WED, 1, { minutes: 15 * 60 }); // 00:15 UTC on Tuesday
			const { name, weightUnit, distanceUnit } = await getAthleteProfile(owner, { db });
			const basics = { name, weightUnit, distanceUnit, timeZone: 'Pacific/Auckland' };
			await saveBasics(owner, basics, { db });

			const { page } = await list(db, owner);
			// Auckland is UTC+13 in November: both are a day ahead, the first at 22:15.
			expect(page.versions.map((v) => v.when)).toEqual(['Tue 3 Nov · 13:15', 'Mon 2 Nov · 22:15']);
		});
	});

	it('with only version 1, there are no changes yet', async () => {
		await withRollback(async (db) => {
			const { owner } = await withProgram(db);
			const { page, empty } = await list(db, owner);
			expect(empty).toEqual(NO_CHANGES);
			expect(page.versions.map((v) => v.number)).toEqual([1]);
			expect(page.versions[0]!.current).toBe(true);
		});
	});

	it(`pages ${HISTORY_PAGE_SIZE} versions at a time; ?before gives the next page`, async () => {
		await withRollback(async (db) => {
			const { owner, full } = await withProgram(db);
			for (let n = 1; n <= 21; n++) await move(db, owner, full, n % 2 ? WED : MON, n);

			const { page, empty } = await list(db, owner);
			expect(empty).toBeNull();
			expect(page.versions.map((v) => v.number)).toEqual(
				Array.from({ length: 20 }, (_, i) => 22 - i)
			);
			expect(page.next).toBe(3);

			const next = await list(db, owner, String(page.next));
			expect(next.empty).toBeNull(); // version 1, below the others: not 'no changes yet'
			expect(next.page.next).toBeNull();
			const versions = next.page.versions;
			expect(versions.map((v) => [v.number, v.by])).toEqual([
				[2, 'You'],
				[1, 'Programming rules']
			]);
			expect(versions[0]!.decisions[0]!.why).toBe(
				'You moved Full body from Mon to Wed. No reason given.'
			);
		});
	});

	it('a malformed cursor is the first page; one past any version is the 404 page', async () => {
		await withRollback(async (db) => {
			const { owner, full } = await withProgram(db);
			await move(db, owner, full, WED, 1);
			for (const before of ['0', '-1', '1.5', 'abc', '']) {
				const { page } = await list(db, owner, before);
				expect(
					page.versions.map((v) => v.number),
					JSON.stringify(before)
				).toEqual([2, 1]);
			}
			expect(await status(load(db, owner, undefined, '9999999999'))).toBe(404);
		});
	});

	it('with no program, says so', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(await load(db, owner)).toEqual({ state: 'none', card: NO_PROGRAM });
		});
	});
});

describe('a version’s page', () => {
	it('an older version is read-only, its sessions on the days they had then, and links to them at that version', async () => {
		await withRollback(async (db) => {
			const { owner, full } = await withProgram(db);
			await move(db, owner, full, WED, 1, { reason: 'Work trip on Monday' });

			const data = await version(db, owner, '1');
			expect(data.version).toMatchObject({ number: 1, current: false, by: 'Programming rules' });
			expect(data.today).toBe(TODAY);
			expect(data.week.label).toBe('Baseline week · Week 1');
			expect(data.week.strip.map((d) => d.date)[0]).toBe(MON);
			// Version 1 changed no one session: the week opens on its first session's day.
			expect(data.week.selected).toBe(0);
			expect(data.week.days[0]!.cards.map((c) => [c.title, c.statusWords, c.lineage])).toEqual([
				['Full body', null, full]
			]);
			expect(data.week.days[2]!.cards.map((c) => c.title)).toEqual(['Intervals']);
		});
	});

	it('an edit opens on the week and the day it changed; the current version says it is current', async () => {
		await withRollback(async (db) => {
			const { owner, full } = await withProgram(db);
			await move(db, owner, full, WED, 1);

			const data = await version(db, owner, '2');
			expect(data.version).toMatchObject({
				number: 2,
				current: true,
				summary: 'Moved Full body from Mon to Wed'
			});
			expect(data.week.selected).toBe(2); // Wednesday, where Full body went
			expect(data.week.days[0]!.cards).toEqual([]);
			expect(data.week.days[0]!.rest).toMatch(/^Recovery is part of the plan/);
			expect(data.week.days[2]!.cards.map((c) => [c.title, c.statusWords])).toEqual([
				['Intervals', null],
				['Full body', 'Moved from Mon']
			]);
		});
	});

	it('a malformed or unknown version is the 404 page', async () => {
		await withRollback(async (db) => {
			const { owner } = await withProgram(db);
			for (const n of ['0', '01', '2', '999', 'sample', '1.5', '-1', '2147483647', '9999999999']) {
				expect(await status(load(db, owner, n)), n).toBe(404);
			}
			// Another owner, with no program (the app has one owner: this one is never stored).
			expect(await status(load(db, crypto.randomUUID(), '1'))).toBe(404);
		});
	});

	it('fails soft when the database cannot be reached, and records the failure', async () => {
		const broken = unreachableDb();
		try {
			await withRollback(async (tx) => {
				for (const n of [undefined, '1']) {
					const request = origin();
					const data = await loadHistory(
						crypto.randomUUID(),
						{ version: n, before: null, now: NOW, origin: request },
						{ db: broken.db, errorsDb: tx }
					);
					expect(data).toEqual({ state: 'error', card: HISTORY_ERROR });
					const recorded = await findErrorsByRequestId(request.requestId, { db: tx });
					expect(recorded).toHaveLength(1);
					expect(recorded[0]).toMatchObject({
						kind: 'load',
						status: 500,
						routeId: '/(app)/train/history/[[version]]',
						context: expect.objectContaining({ load: 'history' })
					});
				}
			});
		} finally {
			await broken.close();
		}
	});
});
