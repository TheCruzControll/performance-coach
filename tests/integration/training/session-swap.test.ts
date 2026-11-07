/**
 * Swap on the session screen, on real Postgres (src/routes/(app)/train/session/[key]): the load
 * streams what each exercise of a current, editable strength session can be swapped for, as an
 * id, a name and a reason (never a catalogue row), or why nothing fits; the `swap` action posts
 * through programAction to swapExercise. A one-off swap is the next version with the exercise
 * marked 'This session only' and no preference saved; 'never prescribe this again' saves a
 * dislike (source 'swap') and swaps every session from today.
 *
 * The hybrid fixture's week 1 runs Monday 9 to Sunday 15 November 2026, with Full body on
 * Monday (power clean, back squat, bench press, barbell row), and again in week 2.
 */
import { isActionFailure } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../src/lib/server/db';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import { saveEquipment } from '../../../src/lib/server/services/profile/index';
import {
	createProgramFromPlan,
	getProgramVersion,
	type ProgramVersion,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import { listExercisePreferences } from '../../../src/lib/server/services/training/preferences';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { SWAPPED_ONCE } from '../../../src/lib/ui/program/session-words';
import {
	loadSessionDetail,
	type SessionDetailData
} from '../../../src/routes/(app)/train/session/[key]/detail.server';
import { editActions } from '../../../src/routes/(app)/train/session/[key]/edits.server';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const MONDAY_MORNING = new Date(`${MONDAY}T08:00:00Z`);
/** The next Monday: week 1 has passed. */
const WEEK_2 = new Date('2026-11-16T08:00:00Z');

async function withProgram(db: Executor) {
	const owner = await makeOwner(db);
	const plan = programFixture('hybrid', { monday: MONDAY, today: MONDAY });
	const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
	return { owner, programId, stored: await getProgramVersion(owner, programId, 1, { db }) };
}

/** Week `week`'s (0 is week 1) Full body, and its exercise `key`. */
function fullBody(stored: ProgramVersion, week: number) {
	const session = stored.blocks
		.flatMap((b) => b.weeks)
		[week]!.sessions.find((s) => s.title === 'Full body') as Extract<
		StoredSession,
		{ kind: 'strength' }
	>;
	const exercise = (key: string) =>
		session.exercises.find((e) => 'key' in e.exercise && e.exercise.key === key)!;
	return { session, exercise };
}

const origin = {
	requestId: 'test',
	method: 'GET',
	path: '/train/session/x',
	routeId: '/(app)/train/session/[key]',
	appVersion: '0.1.0+test'
};

async function screen(db: Executor, owner: string, key: string, now: Date, version?: string) {
	const data: SessionDetailData = await loadSessionDetail(
		owner,
		{ key, version: version ?? null, now, origin },
		{ db }
	);
	if (data.state !== 'session') throw new Error(`expected a session, got ${data.state}`);
	// Settled before the test's next query: the stream shares the test's transaction.
	await data.swaps;
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

/** Post `payload` to ?/swap as the sheet does, as `owner` at `now`, in the test's transaction. */
function swap(db: Executor, owner: string, payload: unknown, now = MONDAY_MORNING) {
	const body = new FormData();
	body.set('payload', JSON.stringify(payload));
	const request = new Request('http://localhost/train/session/x?/swap', { method: 'POST', body });
	return editActions({ db, now: () => now }).swap({ locals: locals(owner), request });
}

async function idOf(db: Executor, key: string) {
	return (await resolveKeys([key], { db })).get(key)!.id;
}

describe('the swaps the session screen streams', () => {
	it('lists each exercise’s alternatives as an id, a name and a reason, best first', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const { session, exercise } = fullBody(stored, 0);
			const data = await screen(db, owner, session.lineage, MONDAY_MORNING);
			expect(data.exercises.map((e) => e.lineage)).toEqual(session.exercises.map((e) => e.lineage));
			expect(data.exercises.every((e) => e.swapped === null)).toBe(true);

			const swaps = await data.swaps;
			expect(Object.keys(swaps!).sort()).toEqual(session.exercises.map((e) => e.lineage).sort());
			const squat = swaps![exercise('back_squat').lineage]!;
			expect(squat.blocked).toBeNull();
			expect(squat.alternatives.length).toBeGreaterThan(1);
			// Never a catalogue row: what the sheet shows and what a swap posts, nothing more.
			for (const alternative of squat.alternatives) {
				expect(Object.keys(alternative).sort()).toEqual(['id', 'name', 'reason']);
			}
			const [best] = squat.alternatives;
			expect(best).toEqual({
				id: expect.any(String),
				name: expect.any(String),
				reason: 'Does the same job as back squat'
			});
			expect(squat.alternatives.map((a) => a.name)).not.toContain('Back squat');
		});
	});

	it('says why nothing fits the power clean with bodyweight only', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			await saveEquipment(
				owner,
				{ gymType: 'none', equipment: [], homeEquipment: [], notes: null },
				{ db }
			);
			const { session, exercise } = fullBody(stored, 0);
			const swaps = await (await screen(db, owner, session.lineage, MONDAY_MORNING)).swaps;
			const clean = swaps![exercise('power_clean').lineage]!;
			expect(clean.alternatives).toEqual([]);
			expect(clean.blocked).toMatch(/^Needs a barbell\b/);
		});
	});

	it('streams none for a session that can no longer change, an older version or a run', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const passed = await screen(db, owner, fullBody(stored, 0).session.lineage, WEEK_2);
			expect(passed.edits?.locked).not.toBeNull();
			expect(passed.swaps).toBeNull();

			const run = stored.blocks[0]!.weeks[0]!.sessions.find((s) => s.title === 'Intervals')!;
			expect((await screen(db, owner, run.lineage, MONDAY_MORNING)).swaps).toBeNull();

			const { session, exercise } = fullBody(stored, 1);
			const to = await idOf(db, 'front_squat');
			const plannedExerciseLineage = exercise('back_squat').lineage;
			const payload = { sessionLineage: session.lineage, plannedExerciseLineage, scope: 'once' };
			expect(await swap(db, owner, { ...payload, toExerciseId: to, version: 1 })).toEqual({
				version: 2
			});
			const older = await screen(db, owner, session.lineage, MONDAY_MORNING, '1');
			expect(older.older).not.toBeNull();
			expect(older.swaps).toBeNull();
		});
	});
});

describe('the swap action', () => {
	it('swaps once: the next version has the alternative, this session only, and no preference', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const { session, exercise } = fullBody(stored, 0);
			const squat = exercise('back_squat');
			const swaps = await (await screen(db, owner, session.lineage, MONDAY_MORNING)).swaps;
			const [goblet] = swaps![squat.lineage]!.alternatives;

			const done = await swap(db, owner, {
				sessionLineage: session.lineage,
				plannedExerciseLineage: squat.lineage,
				toExerciseId: goblet!.id,
				scope: 'once',
				version: 1
			});
			expect(done).toEqual({ version: 2 });

			const after = await screen(db, owner, session.lineage, MONDAY_MORNING);
			const swapped = after.exercises.find((e) => e.lineage === squat.lineage)!;
			expect(swapped).toMatchObject({ name: goblet!.name, swapped: SWAPPED_ONCE });
			expect(after.exercises.filter((e) => e.swapped !== null)).toHaveLength(1);
			// Next week's Full body keeps its back squat.
			const next = fullBody(stored, 1);
			const later = await screen(db, owner, next.session.lineage, MONDAY_MORNING);
			expect(later.exercises.map((e) => e.name)).toContain('Back squat');
			expect(await listExercisePreferences(owner, { db })).toEqual([]);
		});
	});

	it('never again: saves a dislike from the swap and swaps every later session, with no session-only mark', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const { session, exercise } = fullBody(stored, 0);
			const squat = exercise('back_squat');
			const to = await idOf(db, 'front_squat');

			const done = await swap(db, owner, {
				sessionLineage: session.lineage,
				plannedExerciseLineage: squat.lineage,
				toExerciseId: to,
				scope: 'never_again',
				reason: 'My knees prefer it',
				version: 1
			});
			expect(done).toEqual({ version: 2 });
			expect(await listExercisePreferences(owner, { db })).toEqual([
				expect.objectContaining({
					exercise: 'Back squat',
					sentiment: 'dislike',
					source: 'swap',
					reason: 'My knees prefer it'
				})
			]);
			for (const week of [0, 1]) {
				const { session: s } = fullBody(stored, week);
				const shown = await screen(db, owner, s.lineage, MONDAY_MORNING);
				const names = shown.exercises.map((e) => e.name);
				expect(names).toContain('Front squat');
				expect(names).not.toContain('Back squat');
				expect(shown.exercises.every((e) => e.swapped === null)).toBe(true);
			}
		});
	});

	it('refuses a page on an older version (409), and one that is not offered at the field (400)', async () => {
		await withRollback(async (db) => {
			const { owner, stored } = await withProgram(db);
			const { session, exercise } = fullBody(stored, 0);
			const squat = {
				sessionLineage: session.lineage,
				plannedExerciseLineage: exercise('back_squat').lineage,
				toExerciseId: await idOf(db, 'front_squat'),
				scope: 'once'
			};
			// Swapped meanwhile from another tab: a page still on version 1 changes nothing.
			expect(await swap(db, owner, { ...squat, version: 1 })).toEqual({ version: 2 });
			const stale = await swap(db, owner, { ...squat, scope: 'never_again', version: 1 });
			if (!isActionFailure(stale)) throw new Error('expected a failure');
			expect(stale.status).toBe(409);
			expect(stale.data).toEqual({ reason: 'version' });
			expect(await listExercisePreferences(owner, { db })).toEqual([]);

			// With bodyweight only, the hang power clean needs what the owner does not have.
			await saveEquipment(
				owner,
				{ gymType: 'none', equipment: [], homeEquipment: [], notes: null },
				{ db }
			);
			const refused = await swap(db, owner, {
				sessionLineage: session.lineage,
				plannedExerciseLineage: exercise('power_clean').lineage,
				toExerciseId: await idOf(db, 'hang_power_clean'),
				scope: 'once',
				version: 2
			});
			if (!isActionFailure(refused)) throw new Error('expected a failure');
			expect(refused.status).toBe(400);
			expect(refused.data).toEqual({ errors: { toExerciseId: expect.stringMatching(/^Needs /) } });
		});
	});
});
