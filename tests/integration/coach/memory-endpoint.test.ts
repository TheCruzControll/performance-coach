/**
 * 'What the coach knows' on real Postgres (GET /api/coach/memory, the M5 plan's
 * coach-memory-panel), called as SvelteKit calls it:
 * - a fresh owner gets no sections: the sheet's empty state
 * - a dislike and an injury saved through Profile come back in words, each section with its
 *   Profile link, never cached
 * - 429 past the 'coach.action' limit
 */
import { describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '../../../src/lib/server/auth/policy';
import { createAuthRepository } from '../../../src/lib/server/db';
import {
	saveExercisePreferences,
	saveInjuries
} from '../../../src/lib/server/services/profile/index';
import { GET } from '../../../src/routes/api/coach/memory/+server';
import type { KnowsView } from '../../../src/routes/(app)/coach/[[thread]]/knows';
import { withCommitted } from '../helpers';
import { makeOwner } from '../profile/fixtures';

function read(ownerId: string) {
	const url = new URL('http://localhost:5173/api/coach/memory');
	return GET({
		request: new Request(url),
		url,
		params: {},
		locals: { session: { id: crypto.randomUUID(), ownerId }, requestId: 'req-test' },
		getClientAddress: () => '127.0.0.1'
	} as never) as Promise<Response>;
}

async function view(ownerId: string): Promise<KnowsView> {
	const response = await read(ownerId);
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('no-store');
	return (await response.json()) as KnowsView;
}

describe('GET /api/coach/memory', () => {
	it('gives a fresh owner no sections', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			const body = await view(ownerId);
			expect(body.sections).toEqual([]);
			expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});
	});

	it('shows a dislike and an injury saved through Profile, each section linking back to it', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			await saveExercisePreferences(
				ownerId,
				{ items: [{ exercise: 'Bulgarian split squat', sentiment: 'dislike' }] },
				{ db }
			);
			await saveInjuries(
				ownerId,
				{
					injuries: [
						{
							bodyArea: 'knee',
							side: null,
							severity: 'moderate',
							notes: 'Old meniscus',
							avoid: ['Jump lunges'],
							active: true
						}
					]
				},
				{ db }
			);

			const body = await view(ownerId);
			expect(body.sections.map((s) => [s.key, s.edit])).toEqual([
				['preferences', 'exercises'],
				['injuries', 'injuries']
			]);
			const [preferences, injuries] = body.sections;
			expect(preferences!.items).toEqual([
				{
					title: expect.stringMatching(/^Dislikes Bulgarian split squat/i),
					detail: 'From Profile',
					date: null,
					href: null
				}
			]);
			expect(injuries!.items.map((i) => [i.title, i.detail])).toEqual([
				['Knee', 'Moderate · Old meniscus'],
				['Avoid Jump lunges', 'Knee injury']
			]);
		});
	});

	it('answers 429 past the coach.action limit', async () => {
		await withCommitted(async (db) => {
			const ownerId = await makeOwner(db);
			const { limit, windowMs } = RATE_LIMITS['coach.action'];
			const repo = createAuthRepository(db);
			let hits = 0;
			while (hits < limit)
				hits = await repo.hitRateLimit('coach.action:global', windowMs, new Date());

			const response = await read(ownerId);
			expect(response.status).toBe(429);
			expect(await response.json()).toMatchObject({ error: 'rate_limited' });
		});
	});
});
