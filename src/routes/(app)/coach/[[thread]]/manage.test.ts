import { afterEach, describe, expect, it, vi } from 'vitest';
import { manageThread, THREAD_ACTIONS } from './manage';

const ID = '0b6f6a52-1c55-4d2e-9a52-6d1f1e0c2a11';
const THREAD = { id: ID, title: 'Bench block', archived: false };

afterEach(() => vi.unstubAllGlobals());

describe('managing a conversation', () => {
	it('offers only rename, archive and unarchive: nothing deletes a conversation', () => {
		expect(THREAD_ACTIONS).toEqual(['rename', 'archive', 'unarchive']);
	});

	it('posts the action for the conversation and answers it as it now stands', async () => {
		const fetch = vi.fn(async () => Response.json({ thread: THREAD }));
		vi.stubGlobal('fetch', fetch);
		expect(await manageThread(ID, { action: 'rename', title: 'Bench block' })).toEqual(THREAD);
		expect(fetch).toHaveBeenCalledWith(`/api/coach/threads/${ID}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'rename', title: 'Bench block' })
		});
	});

	it('answers null when the action did not go through, refused, failed or offline', async () => {
		vi.stubGlobal('fetch', async () =>
			Response.json({ error: 'invalid_request' }, { status: 400 })
		);
		expect(await manageThread(ID, { action: 'archive' })).toBeNull();
		vi.stubGlobal('fetch', async () => new Response('', { status: 500 }));
		expect(await manageThread(ID, { action: 'archive' })).toBeNull();
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('Failed to fetch');
		});
		expect(await manageThread(ID, { action: 'unarchive' })).toBeNull();
	});
});
