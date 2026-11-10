import { describe, expect, it, vi } from 'vitest';
import { acceptProposal } from './proposals.ts';

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

describe('acceptProposal', () => {
	it('posts only the action, to the proposal’s own path', async () => {
		const fetch = answering(200, { proposal: view(), changed: true });
		await acceptProposal(ID, fetch);
		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe(`/api/coach/proposals/${ID}`);
		expect(init?.method).toBe('POST');
		expect(JSON.parse(String(init?.body))).toEqual({ action: 'accept' });
	});

	it('gives the applied card, with the version it made', async () => {
		const card = await acceptProposal(ID, answering(200, { proposal: view(), changed: true }));
		expect(card).toMatchObject({ id: ID, status: 'applied', appliedVersion: 2 });
	});

	it('gives the superseded card a conflict answers with', async () => {
		const superseded = view({
			status: 'superseded',
			appliedVersion: null,
			supersededReason: 'program_changed'
		});
		const card = await acceptProposal(
			ID,
			answering(409, { error: 'conflict', proposal: superseded })
		);
		expect(card).toMatchObject({ status: 'superseded', supersededReason: 'program_changed' });
	});

	it.each([
		['a refusal', answering(400, { error: 'refused', errors: {} })],
		['a missing proposal', answering(404, { error: 'not_found' })],
		['a server failure', answering(500, { proposal: view() })],
		['a conflict with no proposal', answering(409, { error: 'conflict', reason: 'choose_start' })],
		['another proposal', answering(200, { proposal: view({ id: 'other' }) })],
		['a body that is not JSON', vi.fn<typeof fetch>(async () => new Response('<html>'))],
		[
			'no connection',
			vi.fn<typeof fetch>(async () => {
				throw new TypeError('Failed to fetch');
			})
		]
	])('gives nothing for %s', async (_, fetch) => {
		expect(await acceptProposal(ID, fetch)).toBeNull();
	});
});
