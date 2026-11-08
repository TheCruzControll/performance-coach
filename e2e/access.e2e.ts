/**
 * Deny by default, proven over HTTP. Routes are enumerated from src/routes (e2e/support.ts →
 * appRoutes), so a route added later is covered automatically — and an unclassified one fails
 * here, as it fails `pnpm check` and the unit suite (src/lib/server/auth/routes.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createSseDecoder } from '../src/lib/domain/coach/events';
import { ROUTE_ACCESS, routeAccess } from '../src/lib/server/auth/routes';
import { signInUrl } from '../src/lib/server/auth/return-path';
import { appRoutes, ORIGIN, query, SAME_ORIGIN, signedOut } from './support';

const ROUTES = appRoutes();
/** A request the program fixture route would answer by storing a program. */
const SEED_PROGRAM = { fixture: 'hybrid', start: 'next_week', timeZone: 'Europe/London' };
const PUBLIC_ENDPOINTS = [
	'/api/auth/setup/options',
	'/api/auth/setup/verify',
	'/api/auth/signin/options',
	'/api/auth/signin/verify',
	'/api/auth/signout',
	'/api/health',
	'/api/test-support/session'
];

test.describe('signed out: deny by default', () => {
	test.use({ storageState: signedOut });

	test('finds every route on disk', () => {
		expect(ROUTES.length).toBeGreaterThanOrEqual(20);
		expect(ROUTES.map((r) => r.id)).toEqual(
			expect.arrayContaining(['/(app)/today', '/(app)/profile/security', '/api/vitals'])
		);
		// At runtime an unclassified route falls back to `owner`, so it would pass every check
		// below: fail on it here.
		expect(
			ROUTES.map((r) => r.id).filter((id) => !(id in ROUTE_ACCESS)),
			'routes missing from ROUTE_ACCESS'
		).toEqual([]);
		// Every route is exercised below: a page, or an endpoint with a recognised handler. One
		// the walk cannot exercise (e.g. only a `fallback` export) fails here, not silently.
		expect(
			ROUTES.filter((r) => !r.page && r.methods.length === 0).map((r) => r.id),
			'routes the walk cannot exercise'
		).toEqual([]);
	});

	test('every app page redirects to sign-in with a safe same-origin return path', async ({
		request
	}) => {
		const pages = ROUTES.filter((r) => r.page && routeAccess(r.id) !== 'public');
		expect(pages.length).toBeGreaterThanOrEqual(8);
		for (const route of pages) {
			const res = await request.get(route.path, { maxRedirects: 0 });
			expect(res.status(), route.id).toBe(303);
			const location = res.headers().location!;
			expect(location, route.id).toBe(signInUrl(route.path));
			expect(location, route.id).toMatch(/^\/(\?next=%2F[^/]*)?/); // a path, never another origin
		}
		// With a query string it comes back too, encoded.
		const res = await request.get('/train?tool=plates', { maxRedirects: 0 });
		expect(res.headers().location).toBe('/?next=%2Ftrain%3Ftool%3Dplates');
	});

	test('client-side navigation data redirects too (no page data leaks)', async ({ request }) => {
		const res = await request.get('/profile/__data.json', { maxRedirects: 0 });
		expect(res.status()).toBe(200);
		expect(await res.json()).toEqual({
			type: 'redirect',
			status: 303,
			location: '/?next=%2Fprofile'
		});
	});

	test('every /api endpoint outside the allow-list answers 401 JSON, for every method', async ({
		request
	}) => {
		const endpoints = ROUTES.filter((r) => r.methods.length > 0);
		const protectedOnes = endpoints.filter((r) => routeAccess(r.id) !== 'public');
		expect(
			endpoints
				.filter((r) => routeAccess(r.id) === 'public')
				.map((r) => r.id)
				.sort()
		).toEqual(PUBLIC_ENDPOINTS);
		expect(protectedOnes.map((r) => r.id)).toEqual(
			expect.arrayContaining(['/api/vitals', '/api/client-errors', '/api/auth/passkeys/options'])
		);
		for (const route of protectedOnes) {
			for (const method of route.methods) {
				const res = await request.fetch(route.path, {
					method,
					headers: SAME_ORIGIN,
					data: method === 'GET' ? undefined : {},
					maxRedirects: 0
				});
				expect(res.status(), `${method} ${route.id}`).toBe(401);
				expect(await res.json(), `${method} ${route.id}`).toEqual({
					error: 'unauthenticated',
					message: 'Sign in to continue.'
				});
				expect(res.headers()['cache-control'], route.id).toBe('no-store');
			}
		}
	});

	test('test-only endpoints answer 404 unless test routes are enabled, before anything else', () => {
		const testRoutes = ROUTES.filter((r) => r.id.startsWith('/api/test-support/'));
		expect(testRoutes.map((r) => r.id)).toEqual(
			expect.arrayContaining(['/api/test-support/session', '/api/test-support/program'])
		);
		for (const route of testRoutes) {
			const file = path.resolve(import.meta.dirname, `../src/routes${route.id}/+server.ts`);
			const source = readFileSync(file, 'utf8');
			for (const method of route.methods) {
				// The handler's first statement: a hosted deployment never reaches the rest.
				const guarded = new RegExp(
					`export const ${method}: RequestHandler = (async )?\\([^)]*\\) => \\{\\s*` +
						`if \\(!testRoutesEnabled\\(\\)\\) error\\(404, 'Not found'\\);`
				);
				expect(source, `${method} ${route.id}`).toMatch(guarded);
			}
		}
	});

	test('the program fixture route needs an owner session', async ({ request }) => {
		// Classified as owner-only, not merely unknown (which falls back to owner too).
		expect(ROUTE_ACCESS).toHaveProperty(['/api/test-support/program'], 'owner');
		const res = await request.post('/api/test-support/program', {
			headers: SAME_ORIGIN,
			data: SEED_PROGRAM
		});
		expect(res.status()).toBe(401);
		expect(await query('select id from programs')).toEqual([]);
	});

	test('the coach endpoints need an owner session and store nothing without one', async ({
		request
	}) => {
		expect(ROUTE_ACCESS).toHaveProperty(['/api/coach/turns'], 'owner');
		expect(ROUTE_ACCESS).toHaveProperty(['/api/coach/runs/[run]/cancel'], 'owner');
		const clientMessageId = crypto.randomUUID();
		const turn = await request.post('/api/coach/turns', {
			headers: SAME_ORIGIN,
			data: { clientMessageId, text: 'Hello' }
		});
		expect(turn.status()).toBe(401);
		const stop = await request.post(`/api/coach/runs/${crypto.randomUUID()}/cancel`, {
			headers: SAME_ORIGIN
		});
		expect(stop.status()).toBe(401);
		expect(
			await query('select id from coach_messages where client_message_id = $1', [clientMessageId])
		).toEqual([]);
	});

	test('/api/vitals and /api/client-errors refuse telemetry without a session', async ({
		request
	}) => {
		for (const url of ['/api/vitals', '/api/client-errors']) {
			const res = await request.post(url, { headers: SAME_ORIGIN, data: { name: 'LCP' } });
			expect(res.status(), url).toBe(401);
		}
	});

	test('unknown URLs: pages redirect to sign-in, /api answers 401', async ({ request }) => {
		const page = await request.get('/nothing-here', { maxRedirects: 0 });
		expect(page.status()).toBe(303);
		expect(page.headers().location).toBe('/?next=%2Fnothing-here');
		const api = await request.get('/api/nothing-here');
		expect(api.status()).toBe(401);
	});

	test('the allow-list stays reachable', async ({ request }) => {
		expect((await request.get('/api/health')).status()).toBe(200);
		const signIn = await request.get('/', { maxRedirects: 0 });
		expect(signIn.status()).toBe(200);
		expect((await request.get('/recover', { maxRedirects: 0 })).status()).toBe(200);
		const options = await request.post('/api/auth/signin/options', { headers: SAME_ORIGIN });
		expect(options.status()).toBe(200);
		expect(await options.json()).toMatchObject({ rpId: 'localhost', userVerification: 'required' });
		// Setup is closed after the owner's setup: the route does not exist any more.
		expect((await request.get('/setup?token=anything-at-all-123')).status()).toBe(404);
	});

	test('a forged or stale session cookie is refused and cleared', async ({ request }) => {
		for (const name of ['session', '__Host-session']) {
			const res = await request.get('/today', {
				maxRedirects: 0,
				headers: { cookie: `${name}=${'A'.repeat(43)}` }
			});
			expect(res.status(), name).toBe(303);
		}
		const res = await request.get('/api/vitals', {
			headers: { cookie: `session=${'B'.repeat(43)}` }
		});
		expect(res.status()).toBe(401);
		expect(res.headers()['set-cookie']).toMatch(/^session=; .*Max-Age=0/i);
	});
});

test.describe('signed in: cross-site requests are refused', () => {
	test('JSON endpoints need the app’s own Origin', async ({ request }) => {
		const metric = {
			id: `csrf-${Date.now()}`,
			name: 'INP',
			value: 10,
			rating: 'good',
			path: '/today'
		};
		const attempts: Record<string, string>[] = [
			{ origin: 'https://evil.example' },
			{ origin: 'null' },
			{}
		];
		for (const headers of attempts) {
			const res = await request.post('/api/vitals', { headers, data: metric });
			expect(res.status(), JSON.stringify(headers)).toBe(403);
		}
		expect(
			(await request.post('/api/vitals', { headers: SAME_ORIGIN, data: metric })).status()
		).toBe(204);
	});

	test('a coach turn streams from the app itself, and a cross-site turn or Stop is refused', async ({
		request
	}) => {
		const clientMessageId = crypto.randomUUID();
		const data = { clientMessageId, text: 'Hello' };
		const attempts: Record<string, string>[] = [
			{ origin: 'https://evil.example' },
			{ origin: 'null' },
			{}
		];
		for (const headers of attempts) {
			const turn = await request.post('/api/coach/turns', { headers, data });
			expect(turn.status(), JSON.stringify(headers)).toBe(403);
			const stop = await request.post(`/api/coach/runs/${clientMessageId}/cancel`, { headers });
			expect(stop.status(), JSON.stringify(headers)).toBe(403);
		}
		const stored = () =>
			query('select id from coach_messages where client_message_id = $1', [clientMessageId]);
		expect(await stored()).toEqual([]);

		// From the app itself the turn runs (the mock coach outside production) and streams SSE.
		const own = await request.post('/api/coach/turns', { headers: SAME_ORIGIN, data });
		expect(own.status()).toBe(200);
		expect(own.headers()['content-type']).toBe('text/event-stream; charset=utf-8');
		expect(own.headers()['cache-control']).toBe('no-store');
		const decoder = createSseDecoder();
		const events = [...decoder.push(await own.text()), ...decoder.end()];
		expect(events[0]).toMatchObject({ type: 'run_started' });
		expect(events.at(-1)).toEqual({ type: 'done', status: 'completed' });
		expect(await stored()).toHaveLength(1);
	});

	test('a cross-site sign-out or form action changes nothing', async ({ request }) => {
		const signOut = await request.post('/api/auth/signout', {
			headers: { origin: 'https://evil.example', accept: 'application/json' }
		});
		expect(signOut.status()).toBe(403);
		const form = await request.post('/profile/security?/revokeOthers', {
			headers: { origin: 'https://evil.example' },
			form: {}
		});
		expect(form.status()).toBe(403);
		const textPlain = await request.post('/api/client-errors', {
			headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
			data: '{"source":"error","message":"x","path":"/"}'
		});
		expect(textPlain.status()).toBe(403);
		// Still signed in.
		const profile = await request.get('/profile', { maxRedirects: 0 });
		expect(profile.status()).toBe(200);
		expect(new URL(ORIGIN).hostname).toBe('localhost');
	});

	test('a cross-site request cannot seed a program through the test-only route', async ({
		request
	}) => {
		const before = await query('select id from programs');
		const attempts: Record<string, string>[] = [
			{ origin: 'https://evil.example' },
			{ origin: 'null' },
			{}
		];
		for (const headers of attempts) {
			const res = await request.post('/api/test-support/program', { headers, data: SEED_PROGRAM });
			expect(res.status(), JSON.stringify(headers)).toBe(403);
		}
		// From the app itself the route is reached: a fixture it does not know is refused there.
		const own = await request.post('/api/test-support/program', {
			headers: SAME_ORIGIN,
			data: { ...SEED_PROGRAM, fixture: 'marathon' }
		});
		expect(own.status()).toBe(400);
		expect(await own.json()).toMatchObject({ error: 'invalid' });
		expect(await query('select id from programs')).toEqual(before);
	});

	test('a cross-site save of a training-profile section is refused and stores nothing', async ({
		request
	}) => {
		const stored = () => query('select * from equipment_profiles');
		const before = await stored();
		const save = (origin: string, payload: unknown) =>
			request.post('/profile/equipment?/save', {
				headers: { origin, accept: 'application/json', 'x-sveltekit-action': 'true' },
				multipart: { payload: JSON.stringify(payload) }
			});
		// From the app itself the action runs: an invalid section comes back with its errors.
		const own = await save(ORIGIN, { gymType: 'castle', equipment: [], homeEquipment: [] });
		expect(own.status()).toBe(400);
		expect(await own.json()).toMatchObject({ type: 'failure', status: 400 });
		// From another site it is refused before it runs.
		const cross = await save('https://evil.example', {
			gymType: 'none',
			equipment: [],
			homeEquipment: [],
			notes: 'Cross-site'
		});
		expect(cross.status()).toBe(403);
		expect(await stored()).toEqual(before);
	});

	test('a cross-site move of a planned session is refused and changes nothing', async ({
		request
	}) => {
		const versions = () => query('select id from program_versions order by id');
		const before = await versions();
		const lineage = crypto.randomUUID();
		const move = (origin: string, toDate: string) =>
			request.post(`/train/session/${lineage}?/move`, {
				headers: { origin, accept: 'application/json', 'x-sveltekit-action': 'true' },
				multipart: { payload: JSON.stringify({ sessionLineage: lineage, toDate, version: 1 }) }
			});
		// From the app itself the action runs: a day that is not a date comes back with its error.
		const own = await move(ORIGIN, 'Wednesday');
		expect(own.status()).toBe(400);
		expect(await own.json()).toMatchObject({ type: 'failure', status: 400 });
		// From another site it is refused before it runs.
		expect((await move('https://evil.example', '2026-11-11')).status()).toBe(403);
		expect(await versions()).toEqual(before);
	});

	test('a cross-site Start week 1 is refused and creates nothing', async ({ request }) => {
		const programs = () => query('select id from programs order by id');
		const before = await programs();
		const build = (origin: string, payload: unknown) =>
			request.post('/today?/build', {
				headers: { origin, accept: 'application/json', 'x-sveltekit-action': 'true' },
				multipart: { payload: JSON.stringify(payload) }
			});
		// From the app itself the action runs: a request no preview sent comes back with its errors.
		const own = await build(ORIGIN, { start: 'next_monday', fingerprint: 'not a fingerprint' });
		expect(own.status()).toBe(400);
		expect(await own.json()).toMatchObject({ type: 'failure', status: 400 });
		// From another site it is refused before it runs.
		const cross = await build('https://evil.example', {
			timeZone: 'Pacific/Auckland',
			start: 'next_monday',
			startsOn: '2026-11-09',
			firstPlannedDay: '2026-11-09',
			fingerprint: '0123456789abcdef',
			digest: '0123456789abcdef'
		});
		expect(cross.status()).toBe(403);
		expect(await programs()).toEqual(before);
	});

	test('a cross-site Continue in onboarding is refused and stores nothing', async ({ request }) => {
		const stored = () => query('select name, onboarding_completed from athlete_profiles');
		const before = await stored();
		const save = (origin: string, payload: unknown) =>
			request.post('/onboarding?/save', {
				headers: { origin, accept: 'application/json', 'x-sveltekit-action': 'true' },
				multipart: { payload: JSON.stringify(payload) }
			});
		// From the app itself the action runs: a blank name comes back with its error.
		const own = await save(ORIGIN, { name: '', weightUnit: 'kg', distanceUnit: 'km' });
		expect(own.status()).toBe(400);
		expect(await own.json()).toMatchObject({ type: 'failure', status: 400 });
		// From another site it is refused before it runs.
		const cross = await save('https://evil.example', {
			name: 'Cross-site',
			weightUnit: 'lb',
			distanceUnit: 'mi'
		});
		expect(cross.status()).toBe(403);
		expect(await stored()).toEqual(before);
	});
});
