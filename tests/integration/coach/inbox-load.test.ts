/**
 * The Proposals inbox's load (src/routes/(app)/coach/proposals/[[id]]/inbox.server.ts) on real
 * Postgres, through the proposals service:
 * - the proposals waiting for the owner come first, then the decided ones, each newest first,
 *   in words in the owner's zone
 * - pages of 20 run on from the waiting list into the decided one; a malformed cursor is the
 *   first page
 * - ?show= narrows it to either list; none at all differs from none in a filter
 * - /coach/proposals/<id> is that proposal's detail, with the owner's reason for a rejection
 * - a malformed or unknown id, or someone else's proposal, is the 404 page
 * - a read that fails is the screen's load-failed state, recorded
 *
 * Preference proposals need no program: each differs by its reason, so none is a duplicate.
 */
import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../src/lib/server/db';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import { saveBasics } from '../../../src/lib/server/services/profile/index';
import { createProposal, rejectProposal } from '../../../src/lib/server/services/coach/proposals';
import type { CoachDeps } from '../../../src/lib/server/services/coach/shared';
import {
	INBOX_PAGE,
	loadInbox,
	type InboxData
} from '../../../src/routes/(app)/coach/proposals/[[id]]/inbox.server';
import { unreachableDb, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const ROUTE = '/(app)/coach/proposals/[[id]]';
/** 19:00 on Monday 9 November 2026 in Sydney, a second later at each read. */
const START = new Date('2026-11-09T08:00:00Z');

const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/coach/proposals',
	routeId: ROUTE,
	appVersion: '0.1.0+test'
});

/** An owner in Sydney, and a clock that moves a second each read so proposals are in order. */
async function owner(db: Executor) {
	const ownerId = await makeOwner(db);
	await saveBasics(
		ownerId,
		{ name: 'Niko', weightUnit: 'kg', distanceUnit: 'km', timeZone: 'Australia/Sydney' },
		{ db }
	);
	let t = START.getTime();
	const deps: CoachDeps = { db, now: () => new Date((t += 1000)) };
	const bench = (await resolveKeys(['bench_press'], { db })).get('bench_press')!.id;
	/** `count` proposals titled `${prefix} 1…count`, oldest first; their ids. */
	const propose = async (prefix: string, count: number) => {
		const ids: string[] = [];
		for (let i = 1; i <= count; i++) {
			const { proposal } = await createProposal(
				ownerId,
				{
					proposal: {
						kind: 'preference_update',
						title: `${prefix} ${i}`,
						rationale: 'It suits your shoulders.',
						payload: { exerciseId: bench, sentiment: 'like', reason: `${prefix} ${i}` }
					}
				},
				deps
			);
			ids.push(proposal.id);
		}
		return ids;
	};
	return { ownerId, deps, propose };
}

const load = (db: Executor, ownerId: string, id?: string, query = '') =>
	loadInbox(ownerId, { id, search: new URLSearchParams(query), origin: origin() }, { db });

async function ready(promise: Promise<InboxData>) {
	const data = await promise;
	if (data.state !== 'ready') throw new Error('expected the inbox, got its load failure');
	return data;
}

const titles = (data: { rows: { title: string }[] }) => data.rows.map((row) => row.title);

async function status(promise: Promise<unknown>): Promise<number> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!isHttpError(error)) throw new Error(`expected an HTTP error, got ${String(error)}`);
	return error.status;
}

describe('the Proposals inbox load', () => {
	it('lists the waiting proposals first, then the decided ones, each newest first, in words', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps, propose } = await owner(db);
			const [first, second, third] = await propose('Like bench', 3);
			// The oldest and the newest are decided; the middle one still waits.
			await rejectProposal(ownerId, first!, { reason: 'Not now' }, deps);
			await rejectProposal(ownerId, third!, {}, deps);

			const data = await ready(load(db, ownerId));
			expect(data).toMatchObject({ filter: 'all', next: null, detail: null, none: false });
			expect(data.rows).toEqual([
				{
					id: second,
					title: 'Like bench 2',
					status: 'proposed',
					state: 'Waiting for you',
					meta: 'Exercise preference · Mon 9 Nov',
					origin: null
				},
				expect.objectContaining({ id: third, status: 'rejected', state: 'Declined' }),
				expect.objectContaining({ id: first, status: 'rejected', state: 'Declined' })
			]);
		});
	});

	it('pages 20 at a time from the waiting list on into the decided one', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps, propose } = await owner(db);
			const decided = await propose('Decided', 3);
			for (const id of decided) await rejectProposal(ownerId, id, {}, deps);
			await propose('Waiting', INBOX_PAGE + 3);

			const page1 = await ready(load(db, ownerId));
			expect(titles(page1)).toEqual(
				Array.from({ length: INBOX_PAGE }, (_, i) => `Waiting ${INBOX_PAGE + 3 - i}`)
			);
			expect(page1.next).toMatch(/^w\./);

			const page2 = await ready(load(db, ownerId, undefined, `more=${page1.next}`));
			expect(titles(page2)).toEqual([
				'Waiting 3',
				'Waiting 2',
				'Waiting 1',
				'Decided 3',
				'Decided 2',
				'Decided 1'
			]);
			expect(page2.next).toBeNull();

			// A malformed cursor, or one for a list the filter hides, is the first page.
			for (const more of ['nonsense', 'w.not-a-uuid', 'x.']) {
				expect(titles(await ready(load(db, ownerId, undefined, `more=${more}`)))).toEqual(
					titles(page1)
				);
			}
			const decidedOnly = await ready(
				load(db, ownerId, undefined, `show=decided&more=${page1.next}`)
			);
			expect(titles(decidedOnly)).toEqual(['Decided 3', 'Decided 2', 'Decided 1']);
		});
	});

	it('starts the decided list on the next page when the waiting one fills a page exactly', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps, propose } = await owner(db);
			const decided = await propose('Decided', 2);
			for (const id of decided) await rejectProposal(ownerId, id, {}, deps);
			await propose('Waiting', INBOX_PAGE);

			const page1 = await ready(load(db, ownerId));
			expect(page1.rows).toHaveLength(INBOX_PAGE);
			expect(page1.rows.every((row) => row.status === 'proposed')).toBe(true);
			expect(page1.next).toBe('d.');
			const page2 = await ready(load(db, ownerId, undefined, `more=${page1.next}`));
			expect(titles(page2)).toEqual(['Decided 2', 'Decided 1']);
			expect(page2.next).toBeNull();
		});
	});

	it('narrows to the waiting or the decided list, and tells none at all from none in a filter', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps, propose } = await owner(db);
			expect(await ready(load(db, ownerId))).toMatchObject({ rows: [], none: true, next: null });

			const [decided] = await propose('Decided', 1);
			await rejectProposal(ownerId, decided!, {}, deps);
			const waiting = await ready(load(db, ownerId, undefined, 'show=waiting'));
			expect(waiting).toMatchObject({ filter: 'waiting', rows: [], none: false });

			await propose('Waiting', 1);
			expect(titles(await ready(load(db, ownerId, undefined, 'show=waiting')))).toEqual([
				'Waiting 1'
			]);
			expect(titles(await ready(load(db, ownerId, undefined, 'show=decided')))).toEqual([
				'Decided 1'
			]);
			const unknown = await ready(load(db, ownerId, undefined, 'show=everything'));
			expect(unknown.filter).toBe('all');
			expect(titles(unknown)).toEqual(['Waiting 1', 'Decided 1']);
		});
	});

	it('opens a proposal’s detail beside the list, with the owner’s reason for a rejection', async () => {
		await withRollback(async (db) => {
			const { ownerId, deps, propose } = await owner(db);
			const [rejected, open] = await propose('Like bench', 2);
			await rejectProposal(ownerId, rejected!, { reason: 'My shoulder disagrees' }, deps);

			const data = await ready(load(db, ownerId, rejected));
			expect(titles(data)).toEqual(['Like bench 2', 'Like bench 1']);
			expect(data.detail).toMatchObject({
				kind: 'Exercise preference',
				dates: ['Proposed Mon 9 Nov', 'Decided Mon 9 Nov'],
				note: 'My shoulder disagrees',
				threadId: null,
				card: { id: rejected, status: 'rejected', title: 'Like bench 1' }
			});
			expect((await ready(load(db, ownerId, open))).detail).toMatchObject({
				dates: ['Proposed Mon 9 Nov'],
				note: null,
				card: { id: open, status: 'proposed' }
			});
		});
	});

	it('answers 404 for a malformed or unknown id, and for someone else’s proposal', async () => {
		await withRollback(async (db) => {
			const { ownerId, propose } = await owner(db);
			const [mine] = await propose('Mine', 1);
			expect(await status(load(db, ownerId, 'not-a-uuid'))).toBe(404);
			expect(await status(load(db, ownerId, crypto.randomUUID()))).toBe(404);
			expect(await status(load(db, crypto.randomUUID(), mine))).toBe(404);
		});
	});

	it('fails soft when the database cannot be reached, and records the failure', async () => {
		const broken = unreachableDb();
		try {
			await withRollback(async (tx) => {
				for (const id of [undefined, crypto.randomUUID()]) {
					const request = origin();
					const data = await loadInbox(
						crypto.randomUUID(),
						{ id, search: new URLSearchParams('show=decided'), origin: request },
						{ db: broken.db, errorsDb: tx }
					);
					expect(data).toEqual({ state: 'failed', filter: 'decided' });
					const recorded = await findErrorsByRequestId(request.requestId, { db: tx });
					expect(recorded).toHaveLength(1);
					expect(recorded[0]).toMatchObject({
						kind: 'load',
						status: 500,
						routeId: ROUTE,
						context: expect.objectContaining({ load: 'proposals' })
					});
				}
			});
		} finally {
			await broken.close();
		}
	});
});
