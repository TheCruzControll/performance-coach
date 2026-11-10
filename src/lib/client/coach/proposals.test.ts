import { describe, expect, it, vi } from 'vitest';
import { decideProposal } from './proposals.ts';

const ID = '9b2f4d4e-5f0a-4d47-9a43-0c1d2b3a4e5f';

const view = (over: Record<string, unknown> = {}) => ({
	id: ID,
	kind: 'program_adjustment',
	status: 'applied',
	title: 'Swap Bulgarian split squats for leg press',
	rationale: 'You said you dislike them.',
	rows: [],
	impactLines: [],
	warnings: [],
	appliedVersion: { id: 'v2', number: 2 },
	supersededReason: null,
	...over
});

const answering = (status: number, body: unknown) =>
	vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
const ACCEPT = { action: 'accept' } as const;

describe('decideProposal', () => {
	it('posts only the action, to the proposal’s own path', async () => {
		const fetch = answering(200, { proposal: view(), changed: true });
		await decideProposal(ID, ACCEPT, fetch);
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe(`/api/coach/proposals/${ID}`);
		expect(init?.method).toBe('POST');
		expect(JSON.parse(String(init?.body))).toEqual({ action: 'accept' });
	});

	it('posts a rejection with its reason, or with none', async () => {
		const rejected = view({ status: 'rejected', appliedVersion: null });
		const fetch = answering(200, { proposal: rejected, changed: true });
		await decideProposal(ID, { action: 'reject', reason: 'Too much on Friday' }, fetch);
		await decideProposal(ID, { action: 'reject', reason: null }, fetch);
		const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as unknown);
		expect(bodies).toEqual([
			{ action: 'reject', reason: 'Too much on Friday' },
			{ action: 'reject', reason: null }
		]);
	});

	it('gives the applied card, with the version it made', async () => {
		const result = await decideProposal(
			ID,
			ACCEPT,
			answering(200, { proposal: view(), changed: true })
		);
		expect(result).toMatchObject({
			kind: 'decided',
			card: { id: ID, status: 'applied', appliedVersion: 2 }
		});
	});

	it('gives the stored card when it had already been decided, so a Retry shows the outcome', async () => {
		const result = await decideProposal(
			ID,
			ACCEPT,
			answering(200, { proposal: view(), changed: false })
		);
		expect(result).toMatchObject({ kind: 'decided', card: { status: 'applied' } });
	});

	it('gives the superseded card a conflict answers with', async () => {
		const superseded = view({
			status: 'superseded',
			appliedVersion: null,
			supersededReason: 'program_changed'
		});
		const result = await decideProposal(
			ID,
			ACCEPT,
			answering(409, { error: 'conflict', proposal: superseded })
		);
		expect(result).toMatchObject({
			kind: 'decided',
			card: { status: 'superseded', supersededReason: 'program_changed' }
		});
	});

	it.each([
		['a server failure', answering(500, { error: 'internal' })],
		['a gateway failure', answering(502, { proposal: view() })],
		['an answer cut off', vi.fn<typeof fetch>(async () => new Response('{"propos'))],
		['another proposal', answering(200, { proposal: view({ id: 'other' }) })],
		[
			'no connection',
			vi.fn<typeof fetch>(async () => {
				throw new TypeError('Failed to fetch');
			})
		]
	])('offers a Retry for %s', async (_, fetch) => {
		expect(await decideProposal(ID, ACCEPT, fetch)).toEqual({ kind: 'failed', retry: true });
	});

	it.each([
		['a refusal', answering(400, { error: 'refused', errors: {} })],
		['a missing proposal', answering(404, { error: 'not_found' })],
		['too many decisions', answering(429, { error: 'rate_limited' })],
		['a conflict with no proposal', answering(409, { error: 'conflict', reason: 'choose_start' })]
	])('offers no Retry for %s', async (_, fetch) => {
		expect(await decideProposal(ID, ACCEPT, fetch)).toEqual({ kind: 'failed', retry: false });
	});
});
