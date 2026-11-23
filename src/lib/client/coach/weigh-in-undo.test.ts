import { describe, expect, it, vi } from 'vitest';
import { undoWeighIn, WeighInUndo } from './weigh-in-undo.svelte.ts';

const RUN = '00000000-0000-4000-8000-0000000000b1';
const ID = 41;

/** A fetch that answers with `status`, or fails the request when `status` is null. */
const answering = (status: number | null) =>
	vi.fn<typeof globalThis.fetch>(async () => {
		if (status === null) throw new TypeError('Failed to fetch');
		return new Response(null, { status });
	});

describe('undoWeighIn', () => {
	it('posts the run to the weigh-in’s endpoint, and says it was undone on a 200', async () => {
		const fetch = answering(200);
		expect(await undoWeighIn(ID, RUN, fetch)).toBe('undone');
		expect(fetch).toHaveBeenCalledTimes(1);
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe(`/api/coach/weights/${ID}/undo`);
		expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ runId: RUN }) });
	});

	it.each([404, 409])('says there is nothing to undo on a %i', async (status) => {
		expect(await undoWeighIn(ID, RUN, answering(status))).toBe('nothing');
	});

	it.each([400, 401, 429, 500, 503])(
		'says it failed on a %i, so it can be tried again',
		async (status) => {
			expect(await undoWeighIn(ID, RUN, answering(status))).toBe('failed');
		}
	);

	it('says it failed when no answer came back, offline or dropped', async () => {
		expect(await undoWeighIn(ID, RUN, answering(null))).toBe('failed');
	});
});

describe('WeighInUndo', () => {
	it('is disabled while its request is on its way, and reads Undone once it took the write back', async () => {
		let release!: (response: Response) => void;
		const fetch = vi.fn<typeof globalThis.fetch>(
			() => new Promise<Response>((resolve) => (release = resolve))
		);
		const undo = new WeighInUndo(ID, RUN, fetch);
		expect(undo.phase).toBe('idle');
		expect(undo.posting).toBe(false);

		const pressed = undo.undo();
		expect(undo.phase).toBe('posting');
		expect(undo.posting).toBe(true);

		// A second press while the first is on its way sends nothing.
		await undo.undo();
		expect(fetch).toHaveBeenCalledTimes(1);

		release(new Response(null, { status: 200 }));
		await pressed;
		expect(undo.phase).toBe('undone');
		expect(undo.settled).toBe(true);
		expect(undo.posting).toBe(false);
	});

	it('reads Nothing to undo on a 404 or a 409, and sends nothing more once settled', async () => {
		const fetch = answering(409);
		const undo = new WeighInUndo(ID, RUN, fetch);
		await undo.undo();
		expect(undo.phase).toBe('nothing');
		expect(undo.settled).toBe(true);
		await undo.undo();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('keeps a failed Undo retryable: the same request goes out again and can succeed', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		const undo = new WeighInUndo(ID, RUN, fetch);
		await undo.undo();
		expect(undo.phase).toBe('failed');
		expect(undo.settled).toBe(false);
		expect(undo.posting).toBe(false);

		await undo.undo();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(fetch.mock.calls[1]![0]).toBe(fetch.mock.calls[0]![0]);
		expect(undo.phase).toBe('undone');
	});
});
