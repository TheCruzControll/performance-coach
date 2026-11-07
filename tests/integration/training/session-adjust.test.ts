/**
 * Adjust and Skip on the session screen, on real Postgres (src/routes/(app)/train/session/[key]):
 * the load gives what the Adjust sheet steps for a session that can still change (and nothing
 * for one that cannot, or an older version); the `adjust`, `adjustSegment`, `adjustDetails` and
 * `skip` actions post through programAction to the program edit services. Each saves the next
 * version with its decision; a value out of range, a page on an older version and a session that
 * is already skipped change nothing.
 *
 * The hybrid fixture's week 1 runs Monday 9 to Sunday 15 November 2026: Full body on Monday,
 * Muay Thai on Tuesday and Thursday evenings, Intervals on Wednesday, an Easy run on Thursday.
 */
import { isActionFailure } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../src/lib/server/db';
import {
	createProgramFromPlan,
	getPlannedSession,
	getProgramVersion,
	getVersionHistory,
	type ProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import {
	loadSessionDetail,
	type SessionDetailData
} from '../../../src/routes/(app)/train/session/[key]/detail.server';
import { editActions } from '../../../src/routes/(app)/train/session/[key]/edits.server';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const MONDAY_MORNING = new Date(`${MONDAY}T08:00:00Z`);

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

async function screen(db: Executor, owner: string, key: string, version?: string) {
	const data: SessionDetailData = await loadSessionDetail(
		owner,
		{ key, version: version ?? null, now: MONDAY_MORNING, origin },
		{ db }
	);
	if (data.state !== 'session') throw new Error(`expected a session, got ${data.state}`);
	await data.swaps; // settled before the test's next query, on the same transaction
	return data;
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

type Action = 'adjust' | 'adjustSegment' | 'adjustDetails' | 'skip';

/** Run an edit action as the sheet posts it: its JSON in `payload`. */
function act(db: Executor, owner: string, action: Action, payload: unknown) {
	const body = new FormData();
	body.set('payload', JSON.stringify(payload));
	const request = new Request(`http://localhost/train/session/x?/${action}`, {
		method: 'POST',
		body
	});
	return editActions({ db, now: () => MONDAY_MORNING })[action]({
		locals: locals(owner),
		request
	});
}

function failure(result: unknown) {
	if (!isActionFailure(result))
		throw new Error(`expected a failure, got ${JSON.stringify(result)}`);
	return { status: result.status, data: result.data as unknown };
}

async function latestDecision(db: Executor, owner: string) {
	const [latest] = (await getVersionHistory(owner, {}, { db }))!.versions;
	expect(latest!.decisions).toHaveLength(1);
	return { number: latest!.number, ...latest!.decisions[0]! };
}

async function versionCount(db: Executor, owner: string) {
	return (await getVersionHistory(owner, {}, { db }))!.versions.length;
}

describe('what the Adjust sheet steps, as loaded', () => {
	it('gives each exercise’s set prescriptions by lineage, the run’s segments and a class’s length', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const full = sessionOf(stored, 0, 'Full body');
			if (full.kind !== 'strength') throw new Error('expected strength');
			const { adjust } = await screen(db, owner, full.lineage);
			if (adjust?.kind !== 'strength') throw new Error('expected strength values');
			expect(Object.keys(adjust.exercises)).toEqual(full.exercises.map((e) => e.lineage));
			const squat = full.exercises[1]!;
			expect(adjust.exercises[squat.lineage]!.map((s) => [s.position, s.load])).toEqual([
				[1, null],
				[2, { value: 0.72, unit: '%' }]
			]);

			const intervals = sessionOf(stored, 0, 'Intervals');
			const run = (await screen(db, owner, intervals.lineage)).adjust;
			expect(run).toMatchObject({ kind: 'run', paceUnit: 'km' });
			expect(run?.kind === 'run' && run.segments.map((s) => s.repeats)).toEqual([null, 6, 6, null]);

			const muayThai = sessionOf(stored, 0, 'Muay Thai class');
			expect((await screen(db, owner, muayThai.lineage)).adjust).toEqual({
				kind: 'other',
				durationMinutes: 90,
				targetRpe: 7
			});
		});
	});

	it('gives nothing to step on a skipped session or an older version', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const easy = sessionOf(stored, 0, 'Easy run');
			expect(await act(db, owner, 'skip', { sessionLineage: easy.lineage, version: 1 })).toEqual({
				version: 2
			});
			expect((await screen(db, owner, easy.lineage)).adjust).toBeNull();
			const full = sessionOf(stored, 0, 'Full body');
			expect((await screen(db, owner, full.lineage, '1')).adjust).toBeNull();
			expect((await screen(db, owner, full.lineage)).adjust).not.toBeNull();
		});
	});
});

describe('the Adjust and Skip actions', () => {
	it('adjusts a set prescription’s sets and RPE as the next version, with its decision', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const full = sessionOf(stored, 0, 'Full body');
			if (full.kind !== 'strength') throw new Error('expected strength');
			const row = full.exercises[3]!; // Barbell row: 3 × 8–10 @ RPE 7
			const result = await act(db, owner, 'adjust', {
				sessionLineage: full.lineage,
				plannedExerciseLineage: row.lineage,
				position: 1,
				sets: 4,
				targetRpe: 7.5,
				reason: 'Feeling strong',
				version: 1
			});
			expect(result).toEqual({ version: 2 });

			const session = await getPlannedSession(owner, full.lineage, {}, { db });
			if (session.kind !== 'strength') throw new Error('expected strength');
			expect(session.exercises[3]!.sets[0]).toMatchObject({ sets: 4, targetRpe: 7.5 });
			const decision = await latestDecision(db, owner);
			expect(decision).toMatchObject({ number: 2, kind: 'prescription_adjusted' });
			expect(decision.why).toContain('Feeling strong');
		});
	});

	it('refuses an RPE out of range at its field (400) and saves nothing', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const full = sessionOf(stored, 0, 'Full body');
			if (full.kind !== 'strength') throw new Error('expected strength');
			const adjust = {
				sessionLineage: full.lineage,
				plannedExerciseLineage: full.exercises[3]!.lineage,
				position: 1,
				targetRpe: 11,
				version: 1
			};
			expect(failure(await act(db, owner, 'adjust', adjust))).toEqual({
				status: 400,
				data: { errors: { targetRpe: 'RPE 5 to 10, in half steps' } }
			});
			expect(await versionCount(db, owner)).toBe(1);
		});
	});

	it('adjusts an interval’s repeats for its whole group, and the run’s minutes follow', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const intervals = sessionOf(stored, 0, 'Intervals');
			const adjust = { sessionLineage: intervals.lineage, position: 2, repeats: 5, version: 1 };
			expect(await act(db, owner, 'adjustSegment', adjust)).toEqual({ version: 2 });

			const session = await getPlannedSession(owner, intervals.lineage, {}, { db });
			if (session.kind !== 'run') throw new Error('expected a run');
			expect(session.segments.map((s) => s.repeats)).toEqual([null, 5, 5, null]);
			expect(session.estMinutes).toBeLessThan(intervals.estMinutes);
			expect(await latestDecision(db, owner)).toMatchObject({ kind: 'prescription_adjusted' });
		});
	});

	it('adjusts a Muay Thai class’s length, and its estimate is that length', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const muayThai = sessionOf(stored, 0, 'Muay Thai class');
			const adjust = { sessionLineage: muayThai.lineage, durationMinutes: 60, version: 1 };
			expect(await act(db, owner, 'adjustDetails', adjust)).toEqual({ version: 2 });

			const session = await getPlannedSession(owner, muayThai.lineage, {}, { db });
			if (session.kind !== 'other') throw new Error('expected another session');
			expect(session.details.durationMinutes).toBe(60);
			expect(session.estMinutes).toBe(60);
			expect(await latestDecision(db, owner)).toMatchObject({ kind: 'prescription_adjusted' });
		});
	});

	it('skips a session with the owner’s reason, then refuses to skip it again', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const easy = sessionOf(stored, 0, 'Easy run');
			const skip = { sessionLineage: easy.lineage, reason: 'Travelling', version: 1 };
			expect(await act(db, owner, 'skip', skip)).toEqual({ version: 2 });

			expect(await getPlannedSession(owner, easy.lineage, {}, { db })).toMatchObject({
				status: 'skipped',
				version: { number: 2, current: true }
			});
			const decision = await latestDecision(db, owner);
			expect(decision).toMatchObject({ kind: 'session_skipped', decidedBy: 'owner' });
			expect(decision.why).toContain('Travelling');

			const again = failure(await act(db, owner, 'skip', { ...skip, version: 2 }));
			expect(again).toMatchObject({
				status: 400,
				data: { errors: { sessionLineage: expect.any(String) } }
			});
			expect(await versionCount(db, owner)).toBe(2);
		});
	});

	it('refuses each edit from a page on an older version (409)', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const muayThai = sessionOf(stored, 0, 'Muay Thai class');
			const intervals = sessionOf(stored, 0, 'Intervals');
			const adjust = { sessionLineage: muayThai.lineage, durationMinutes: 60, version: 1 };
			expect(await act(db, owner, 'adjustDetails', adjust)).toEqual({ version: 2 });

			const stale: [Action, unknown][] = [
				['adjustDetails', { ...adjust, durationMinutes: 75 }],
				[
					'adjustSegment',
					{ sessionLineage: intervals.lineage, position: 2, repeats: 5, version: 1 }
				],
				['skip', { sessionLineage: intervals.lineage, version: 1 }]
			];
			for (const [action, payload] of stale) {
				expect(failure(await act(db, owner, action, payload)), action).toEqual({
					status: 409,
					data: { reason: 'version' }
				});
			}
			expect(await versionCount(db, owner)).toBe(2);
		});
	});
});
