/**
 * Managing conversations on real Postgres (GET /api/coach/threads and POST
 * /api/coach/threads/<id>, the M5 plan's coach-thread-manage), called as SvelteKit calls them:
 * - the Archived list: archived conversations newest archived first, each saying when, a page at
 *   a time to its end; open ones are not in it; a fresh owner's is empty; a bad cursor is a 400
 * - rename persists the owner's name; a blank or too-long one is a 400 that changes nothing
 * - archive takes a conversation out of Recent into Archived, unarchive brings it back; repeating
 *   either answers the conversation as it is
 * - nothing else: a body that is not an action, or a delete, is a 400; someone else's or an
 *   unknown conversation is a 404
 */
import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../src/lib/server/db';
import { THREAD_TITLE_MAX } from '../../../src/lib/server/db/schema/coach';
import {
	archiveThread,
	listThreads,
	startOwnerTurn
} from '../../../src/lib/server/services/coach/threads';
import { GET } from '../../../src/routes/api/coach/threads/+server';
import { POST } from '../../../src/routes/api/coach/threads/[id]/+server';
import {
	THREAD_TITLE_CHARS,
	type ArchivedPage,
	type ManagedThread
} from '../../../src/routes/(app)/coach/[[thread]]/manage';
import { withCommitted } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const URL_BASE = 'http://localhost:5173';
const SEGMENT = { promptVersion: 'pv-0000000000000001', programVersionId: null };

const session = (ownerId: string) => ({
	session: { id: crypto.randomUUID(), ownerId },
	requestId: 'req-test'
});

function list(ownerId: string, query = '') {
	const url = new URL(`${URL_BASE}/api/coach/threads${query}`);
	return GET({
		request: new Request(url),
		url,
		params: {},
		locals: session(ownerId),
		getClientAddress: () => '127.0.0.1'
	} as never) as Promise<Response>;
}

async function page(ownerId: string, query: string): Promise<ArchivedPage> {
	const response = await list(ownerId, query);
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('no-store');
	return (await response.json()) as ArchivedPage;
}

function act(ownerId: string, id: string, body: unknown) {
	const url = new URL(`${URL_BASE}/api/coach/threads/${id}`);
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	return POST({
		request: new Request(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: text
		}),
		url,
		params: { id },
		locals: session(ownerId),
		getClientAddress: () => '127.0.0.1'
	} as never) as Promise<Response>;
}

async function done(promise: Promise<Response>): Promise<ManagedThread> {
	const response = await promise;
	expect(response.status).toBe(200);
	return ((await response.json()) as { thread: ManagedThread }).thread;
}

async function ask(db: Executor, ownerId: string, text: string) {
	const { thread } = await startOwnerTurn(
		ownerId,
		{ clientMessageId: crypto.randomUUID(), text, segment: SEGMENT },
		{ db }
	);
	return thread.id;
}

const recent = async (db: Executor, ownerId: string) =>
	(await listThreads(ownerId, {}, { db })).threads.map((t) => t.id);

describe('GET /api/coach/threads?archived=1', () => {
	it('lists archived conversations newest archived first, a page at a time to the end', async () => {
		await withCommitted(async (db) => {
			const me = await makeOwner(db);
			const open = await ask(db, me, 'Still open');
			const ids: string[] = [];
			for (const [i, text] of ['First', 'Second', 'Third'].entries()) {
				const id = await ask(db, me, text);
				await archiveThread(me, id, { db, now: () => new Date(Date.now() - (3 - i) * 60_000) });
				ids.push(id);
			}

			const first = await page(me, '?archived=1&limit=2');
			expect(first.threads.map((t) => t.title)).toEqual(['Third', 'Second']);
			expect(first.threads[0]!.when).toMatch(/^Archived (today|yesterday) · \d\d:\d\d$/);
			expect(first.next).toBe(ids[1]);
			const last = await page(me, `?archived=1&limit=2&before=${first.next}`);
			expect(last).toEqual({
				threads: [{ id: ids[0], title: 'First', when: expect.stringMatching(/^Archived /) }],
				next: null
			});
			expect([...first.threads, ...last.threads].map((t) => t.id)).not.toContain(open);
		});
	});

	it('gives a fresh owner an empty list, and no archived=1, a bad cursor or limit a 400', async () => {
		await withCommitted(async (db) => {
			const me = await makeOwner(db);
			expect(await page(me, '?archived=1')).toEqual({ threads: [], next: null });
			expect((await list(me, '')).status).toBe(400);
			expect((await list(me, '?archived=0')).status).toBe(400);
			expect((await list(me, '?archived=1&before=nope')).status).toBe(400);
			expect((await list(me, '?archived=1&limit=0')).status).toBe(400);
		});
	});
});

describe('POST /api/coach/threads/<id>', () => {
	it('renames a conversation for good, and refuses a blank or too-long name', async () => {
		await withCommitted(async (db) => {
			const me = await makeOwner(db);
			const id = await ask(db, me, 'How is my bench press going?');
			expect(await done(act(me, id, { action: 'rename', title: '  Bench block  ' }))).toEqual({
				id,
				title: 'Bench block',
				archived: false
			});
			// The sheet's field stops where the database does.
			expect(THREAD_TITLE_CHARS).toBe(THREAD_TITLE_MAX);
			for (const title of ['   ', 'x'.repeat(THREAD_TITLE_MAX + 1)]) {
				const refused = await act(me, id, { action: 'rename', title });
				expect(refused.status).toBe(400);
				expect(await refused.json()).toMatchObject({ error: 'invalid_request', field: 'title' });
			}
			const [stored] = (await listThreads(me, {}, { db })).threads;
			expect([stored!.title, stored!.titleSource]).toEqual(['Bench block', 'owner']);
		});
	});

	it('archives out of Recent and unarchives back, each repeat answering it as it is', async () => {
		await withCommitted(async (db) => {
			const me = await makeOwner(db);
			const id = await ask(db, me, 'Deload?');
			expect((await done(act(me, id, { action: 'archive' }))).archived).toBe(true);
			expect(await recent(db, me)).toEqual([]);
			expect((await page(me, '?archived=1')).threads.map((t) => t.id)).toEqual([id]);
			expect((await done(act(me, id, { action: 'archive' }))).archived).toBe(true);

			expect((await done(act(me, id, { action: 'unarchive' }))).archived).toBe(false);
			expect(await recent(db, me)).toEqual([id]);
			expect((await page(me, '?archived=1')).threads).toEqual([]);
			expect((await done(act(me, id, { action: 'unarchive' }))).archived).toBe(false);
		});
	});

	it('takes no other action, and finds no conversation that is not the owner’s', async () => {
		await withCommitted(async (db) => {
			const me = await makeOwner(db);
			const id = await ask(db, me, 'Mine');
			for (const body of [{ action: 'delete' }, { title: 'No action' }, 'not json']) {
				const refused = await act(me, id, body);
				expect(refused.status).toBe(400);
				expect(await refused.json()).toMatchObject({ error: 'invalid_request' });
			}
			expect(await recent(db, me)).toEqual([id]);
			expect((await act(me, crypto.randomUUID(), { action: 'archive' })).status).toBe(404);
			expect((await act(me, 'not-a-uuid', { action: 'archive' })).status).toBe(404);
			// One database holds one owner: anyone else's session finds none of the owner's threads.
			expect((await act(crypto.randomUUID(), id, { action: 'archive' })).status).toBe(404);
			expect(await recent(db, me)).toEqual([id]);
		});
	});
});
