import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '$app/forms';
import { save, toOutcome } from './profile-form';

const applyAction = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$app/forms', () => ({
	applyAction,
	deserialize: (text: string) => JSON.parse(text) as ActionResult
}));

afterEach(() => {
	vi.unstubAllGlobals();
	applyAction.mockClear();
});

const equipment = { gymType: 'commercial', equipment: ['barbell'], homeEquipment: [], notes: null };

describe('toOutcome', () => {
	it('turns a validation failure into field errors', () => {
		const result: ActionResult = {
			type: 'failure',
			status: 400,
			location: '/profile/equipment',
			data: { errors: { gymType: 'Pick where you train', 'equipment.0': 'Unknown equipment' } }
		};
		expect(toOutcome(result)).toEqual({
			ok: false,
			errors: { gymType: 'Pick where you train', 'equipment.0': 'Unknown equipment' }
		});
	});

	it('turns a failure with only a message into a form-level failure', () => {
		const message = 'That no longer exists. Reload to see the latest.';
		expect(
			toOutcome({ type: 'failure', status: 404, location: '/profile/goals', data: { message } })
		).toEqual({ ok: false, errors: {}, failed: message });
	});

	it('never leaves a failure without something to show', () => {
		const outcome = toOutcome({ type: 'failure', status: 400, location: '/profile/equipment' });
		expect(outcome.ok).toBe(false);
		expect(outcome.failed).toBe('That didn’t save. Try again.');
	});

	it('returns the data of a successful save', () => {
		expect(
			toOutcome({ type: 'success', status: 200, location: '/profile', data: { saved: true } })
		).toEqual({ ok: true, errors: {}, data: { saved: true } });
	});

	it('counts a redirect (the next step) as saved', () => {
		expect(toOutcome({ type: 'redirect', status: 303, location: '/onboarding/goals' })).toEqual({
			ok: true,
			errors: {}
		});
	});

	it('does not count a server error as saved', () => {
		const error = { status: 500, message: 'Internal Error' };
		expect(toOutcome({ type: 'error', status: 500, error }).ok).toBe(false);
	});
});

describe('save', () => {
	it('says the server cannot be reached when the request fails, without leaving the form', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
		expect(await save('?/save', equipment)).toEqual({
			ok: false,
			errors: {},
			failed: 'Can’t reach the server. Check your connection.'
		});
		expect(applyAction).not.toHaveBeenCalled();
	});

	it('posts the section as JSON to the form action, as SvelteKit’s own forms do', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(
				new Response(JSON.stringify({ type: 'success', status: 200, data: { saved: true } }))
			);
		vi.stubGlobal('fetch', fetch);
		expect(await save('?/save', equipment, 'equipment', { then: 'back' })).toMatchObject({
			ok: true,
			data: { saved: true }
		});
		const [url, init] = fetch.mock.calls[0]!;
		expect(url).toBe('?/save');
		expect(init?.method).toBe('POST');
		const headers = new Headers(init?.headers);
		expect(headers.get('accept')).toBe('application/json');
		// Without it, a route that also has a +server.ts would send the POST there.
		expect(headers.get('x-sveltekit-action')).toBe('true');
		const body = init?.body as FormData;
		expect(JSON.parse(body.get('payload') as string)).toEqual(equipment);
		expect(body.get('then')).toBe('back');
		expect(applyAction).not.toHaveBeenCalled();
	});

	it('stops at the shared schema before posting anything', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		const outcome = await save('?/save', { ...equipment, gymType: 'castle' }, 'equipment');
		expect(outcome).toEqual({ ok: false, errors: { gymType: 'Pick where you train' } });
		expect(fetch).not.toHaveBeenCalled();
	});

	it('hands a redirect to SvelteKit to follow', async () => {
		const redirect = { type: 'redirect', status: 303, location: '/onboarding/goals' };
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(redirect))));
		expect(await save('?/save', equipment)).toEqual({ ok: true, errors: {} });
		expect(applyAction).toHaveBeenCalledWith(redirect);
	});

	it('hands a server error to SvelteKit to show, and does not count it as saved', async () => {
		const failure = { type: 'error', status: 500, error: { message: 'Internal Error' } };
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(failure))));
		expect((await save('?/save', equipment)).ok).toBe(false);
		expect(applyAction).toHaveBeenCalledWith(failure);
	});

	it('still posts when the validation chunk cannot load, leaving validation to the server', async () => {
		vi.doMock('#lib/domain/profile/schemas.ts', () => {
			throw new Error('Failed to fetch dynamically imported module');
		});
		vi.resetModules();
		try {
			const fresh = await import('./profile-form');
			const fetch = vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ type: 'success', status: 200, data: { saved: true } }))
				);
			vi.stubGlobal('fetch', fetch);
			const outcome = await fresh.save('?/save', { ...equipment, gymType: 'castle' }, 'equipment');
			expect(outcome).toMatchObject({ ok: true });
			expect(fetch).toHaveBeenCalledOnce();
		} finally {
			vi.doUnmock('#lib/domain/profile/schemas.ts');
			vi.resetModules();
		}
	});
});
