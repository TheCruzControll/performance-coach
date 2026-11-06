import { expect, test, type Page } from '@playwright/test';
import { eventually, query, SAME_ORIGIN, trackConsoleErrors } from './support';

/**
 * Leaving a page cancels the loads it still had in flight, and WebKit reports each one as a
 * failure (src/lib/client/leaving.ts). Hold back the requests `held` matches, leave while they
 * are pending, then require that neither page logged an error and nothing was recorded.
 */
async function leaveWhilePending(page: Page, path: string, held: (url: string) => boolean) {
	const quietly = await expectLeftQuietly(page, path);
	let pending = 0;
	let left = false;
	await page.route('**/*', async (route) => {
		if (left || !held(route.request().url())) return route.fallback();
		pending += 1;
		await new Promise((resolve) => setTimeout(resolve, 5_000));
		await route.continue().catch(() => {}); // cancelled along with the page that asked
	});
	await page.goto(path, { waitUntil: 'commit' });
	await expect
		.poll(() => pending, { message: `${path} started no load that matches what is held` })
		.toBeGreaterThan(0);
	left = true;
	await quietly();
}

/**
 * Start watching `page` for errors; the returned check goes to /today and then requires that
 * neither page logged an error and nothing was recorded for `path`.
 */
async function expectLeftQuietly(page: Page, path: string) {
	const errors = trackConsoleErrors(page);
	const since = (await query<{ now: Date }>('select now()'))[0]!.now;
	return async () => {
		await page.goto('/today');
		await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
		await page.waitForLoadState('networkidle');
		expect(errors).toEqual([]);
		expect(
			await query(
				`select message from app_errors where kind = 'client' and path = $1 and occurred_at >= $2`,
				[path, since]
			)
		).toEqual([]);
	};
}

test.describe('platform: health, PWA, observability', () => {
	test('/api/health reports the database up via a real query', async ({ request, page }) => {
		const res = await request.get('/api/health');
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ ok: true, db: 'up' });
		expect(body.version).toMatch(/^\d+\.\d+\.\d+\+\w+/);
		expect(res.headers()['server-timing']).toMatch(/db;dur=[\d.]+/);
		expect(res.headers()['cache-control']).toBe('no-store');

		await page.goto('/profile');
		await expect(page.getByTestId('db-status')).toContainText(/connected · \d+ ms/i);
	});

	test('pages carry Server-Timing, a request id and security headers', async ({ page }) => {
		const response = await page.goto('/today');
		const headers = response!.headers();
		expect(headers['server-timing']).toMatch(/total;dur=[\d.]+/);
		expect(headers['x-request-id']).toMatch(/^[\w.:-]{8,}$/);
		expect(headers['x-content-type-options']).toBe('nosniff');
		expect(headers['cache-control']).toBe('private, no-cache');
		expect(headers['strict-transport-security']).toMatch(/max-age=\d+/);
	});

	test('a Content-Security-Policy is sent and enforced', async ({ page }) => {
		const response = await page.goto('/profile'); // streams data: needs the nonce
		const csp = response!.headers()['content-security-policy'];
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toMatch(/script-src 'self' 'sha256-[^']+' 'nonce-[^']+'/);
		expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
		await expect(page.getByTestId('db-status')).toBeVisible(); // streamed script ran

		// An injected inline script is refused.
		const outcome = await page.evaluate(
			() =>
				new Promise<string>((resolve) => {
					document.addEventListener(
						'securitypolicyviolation',
						(e) => resolve(`blocked:${e.effectiveDirective}`),
						{ once: true }
					);
					const script = document.createElement('script');
					script.textContent = 'window.__injected = true';
					document.head.append(script);
					setTimeout(() => resolve('__injected' in window ? 'ran' : 'silent'), 1_000);
				})
		);
		expect(outcome).toMatch(/^blocked:script-src/);
	});

	test('preloads at most two font files', async ({ page }) => {
		await page.goto('/today');
		const fonts = page.locator('link[rel="preload"][as="font"]');
		const count = await fonts.count();
		expect(count).toBeGreaterThanOrEqual(1);
		expect(count).toBeLessThanOrEqual(2);
	});

	test('serves a valid web app manifest with installable icons', async ({ page, request }) => {
		await page.goto('/today');
		const href = await page.locator('link[rel="manifest"]').getAttribute('href');
		expect(href).toBeTruthy();
		const res = await request.get(href!);
		expect(res.ok()).toBe(true);
		const manifest = await res.json();
		expect(manifest).toMatchObject({
			name: 'Performance Coach',
			display: 'standalone',
			start_url: '/today'
		});
		const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
		expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
		expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
		for (const icon of manifest.icons) {
			expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
		}
		await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
			'content',
			/viewport-fit=cover/
		);
		await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', /^#/);
	});

	test('registers and activates the service worker', async ({ page }) => {
		await page.goto('/today');
		const registration = await page.evaluate(async () => {
			const reg = await navigator.serviceWorker.ready;
			const worker = reg.active!;
			if (worker.state !== 'activated') {
				await new Promise<void>((resolve) =>
					worker.addEventListener('statechange', () => worker.state === 'activated' && resolve())
				);
			}
			return { scope: reg.scope, script: worker.scriptURL, state: worker.state };
		});
		expect(registration.scope).toMatch(/\/$/);
		expect(registration.script).toMatch(/service-worker\.js$/);
		expect(registration.state).toBe('activated');

		const cached = await page.evaluate(async () => {
			const keys = await caches.keys();
			const shell = keys.find((k) => k.startsWith('pc-shell-'));
			return shell
				? (await (await caches.open(shell)).keys()).map((r) => new URL(r.url).pathname)
				: [];
		});
		expect(cached).toContain('/manifest.webmanifest');
		expect(cached).toContain('/offline');
		expect(cached.filter((path) => path.startsWith('/icons/'))).toEqual([]);
	});

	test('/api/vitals stores a posted metric in Postgres', async ({ request }) => {
		const id = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const res = await request.post('/api/vitals', {
			headers: SAME_ORIGIN,
			data: {
				id,
				name: 'INP',
				value: 64,
				rating: 'good',
				navigationType: 'navigate',
				path: '/train'
			}
		});
		expect(res.status()).toBe(204);
		const rows = await query<{ name: string; value: number; path: string }>(
			'select name, value, path from web_vitals where metric_id = $1',
			[id]
		);
		expect(rows).toEqual([{ name: 'INP', value: 64, path: '/train' }]);

		const bad = await request.post('/api/vitals', {
			headers: SAME_ORIGIN,
			data: { id, name: 'FID', value: 1 }
		});
		expect(bad.status()).toBe(422);
	});

	test('real-user vitals are beaconed from the browser', async ({ page }) => {
		const since = new Date();
		await page.goto('/progress');
		// Wait for the lazily loaded web-vitals observers, then simulate the tab being hidden.
		await expect(page.locator('html')).toHaveAttribute('data-rum', 'ready', { timeout: 10_000 });
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
			document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
		});
		const rows = await eventually(async () => {
			const r = await query<{ name: string }>(
				`select name from web_vitals where path = '/progress' and recorded_at >= $1`,
				[since]
			);
			return r.length ? r : null;
		});
		expect(rows?.map((r) => r.name)).toEqual(expect.arrayContaining(['TTFB', 'FCP']));
	});

	test('vitals are attributed to the screen where they happened', async ({ page }) => {
		// Record this page's own beacons, so assertions never pick up rows written by tests
		// running in parallel against the same database.
		await page.addInitScript(() => {
			const sent: string[] = [];
			Object.assign(window, { __beacons: sent });
			const send = Navigator.prototype.sendBeacon;
			Navigator.prototype.sendBeacon = function (url, data) {
				if (data instanceof Blob) void data.text().then((text) => sent.push(text));
				return send.call(this, url, data);
			};
		});
		await page.goto('/today');
		await expect(page.locator('html')).toHaveAttribute('data-rum', 'ready', { timeout: 10_000 });

		// Client-side navigation, then a deliberately slow interaction on Train (the INP).
		await page
			.getByRole('navigation', { name: 'Primary' })
			.getByRole('link', { name: 'Train' })
			.click();
		await expect(page.getByRole('heading', { level: 1, name: 'Train' })).toBeVisible();
		// Let the tab's view transition finish: during it, clicks hit the transition overlay.
		await page.waitForFunction(() => document.getAnimations().length === 0);
		await page.evaluate(() => {
			const block = () => {
				// Far above anything else on the page: on a slow CI WebKit the navigation click
				// itself can take a few hundred ms, and INP reports the worst interaction.
				const end = performance.now() + 600;
				while (performance.now() < end) {
					// block the main thread so this interaction is the page's worst
				}
			};
			document.addEventListener('click', block, { capture: true, once: true });
		});
		await page.getByRole('heading', { level: 1, name: 'Train' }).click();
		await page.waitForTimeout(500); // the event-timing entry is dispatched after paint
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
			document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
		});

		type Sent = { id: string; name: string; value: number; path: string; route: string | null };
		const metrics = await page
			.waitForFunction(() => {
				const all = (window as unknown as { __beacons: string[] }).__beacons.flatMap(
					(text) => JSON.parse(text) as { name: string }[]
				);
				return all.some((m) => m.name === 'INP') ? all : null;
			})
			.then((handle) => handle.jsonValue() as Promise<Sent[]>);

		const inp = metrics.find((m) => m.name === 'INP')!;
		const ttfb = metrics.find((m) => m.name === 'TTFB')!;
		expect(inp).toMatchObject({ path: '/train', route: '/(app)/train' });
		expect(inp.value).toBeGreaterThanOrEqual(600);
		expect(ttfb).toMatchObject({ path: '/today', route: '/(app)/today' });

		// …and that is what Postgres stored.
		const rows = await eventually(() =>
			query<{ name: string; path: string; route_id: string | null }>(
				'select name, path, route_id from web_vitals where metric_id = any($1) order by name',
				[[inp.id, ttfb.id]]
			).then((r) => (r.length === 2 ? r : null))
		);
		expect(rows).toEqual([
			{ name: 'INP', path: '/train', route_id: '/(app)/train' },
			{ name: 'TTFB', path: '/today', route_id: '/(app)/today' }
		]);
	});

	test('leaving while startup stylesheets load is not an error', async ({ page }) => {
		// SvelteKit imports the root layout and error page on every start; the stylesheets they
		// need that the HTML does not link (inlined ones, the shell's on pages without it) are
		// fetched then. Hold those back. A fragment is not part of what is fetched: the icons'
		// `<use href="…/sprite….svg#name">` link the sprite, which the page requests as it renders.
		const html = await (await page.request.get('/design')).text();
		const linked = new Set([...html.matchAll(/(\/_app\/immutable\/[^"#]+)[#"]/g)].map((m) => m[1]));
		await leaveWhilePending(page, '/design', (url) => {
			const { pathname } = new URL(url);
			return pathname.startsWith('/_app/immutable/') && !linked.has(pathname);
		});
	});

	test('leaving as soon as a page renders is not an error', async ({ page }) => {
		// The icons request the sprite as /design renders, before SvelteKit has started (it starts
		// once its code has loaded): leave right then. The page goes on starting while /today
		// loads, and in WebKit the startup loads it begins fail on the way out.
		await leaveWhilePending(page, '/design', (url) =>
			/^\/_app\/immutable\/assets\/sprite\.[\w-]+\.svg$/.test(new URL(url).pathname)
		);
	});

	test('failures of a page left before the app has started are not errors', async ({
		page,
		browserName
	}) => {
		test.skip(
			browserName === 'webkit',
			'WebKit cancels the held entry as the leave starts, so the app never starts there'
		);
		// Hold the app's entry until /today is requested, which is after `beforeunload`. The page
		// then starts while /today loads, and its startup stylesheets are cancelled, which WebKit
		// reports as a failure. Only a leave noted from the page's first moment (src/app.html) is known by
		// then: the app's own listeners would have missed `beforeunload`, and WebKit fires no
		// `pagehide` for a page that has not finished loading.
		const quietly = await expectLeftQuietly(page, '/design');
		let entryRequested = false;
		let left = false;
		let release = () => {};
		const entry = new Promise<void>((resolve) => (release = resolve));
		await page.route('**/*', async (route) => {
			const request = route.request();
			const { pathname } = new URL(request.url());
			if (!left && pathname.startsWith('/_app/immutable/entry/app.')) {
				entryRequested = true;
				await entry;
				return route.continue().catch(() => {});
			}
			if (request.isNavigationRequest() && pathname === '/today') {
				left = true;
				release();
				await new Promise((resolve) => setTimeout(resolve, 1_500)); // while /design starts
				return route.continue();
			}
			const from = request.headers()['referer'] ?? '';
			// Cancelled, as a load is when its page is left.
			if (left && from.endsWith('/design') && pathname.endsWith('.css')) {
				return route.abort('aborted');
			}
			return route.fallback();
		});
		await page.goto('/design', { waitUntil: 'domcontentloaded' });
		await expect.poll(() => entryRequested, { message: 'the entry is held' }).toBe(true);
		await quietly();
	});

	test('leaving while the service worker registers is not an error', async ({
		page,
		browserName
	}) => {
		test.skip(browserName === 'chromium', 'Chromium does not route the service-worker script');
		await leaveWhilePending(page, '/train', (url) => url.endsWith('/service-worker.js'));
	});

	test('browser errors are reported to the server and recorded', async ({ page, request }) => {
		const marker = `e2e-client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		await page.goto('/train');
		await expect(page.locator('html')).toHaveAttribute('data-rum', 'ready', { timeout: 10_000 });
		// An uncaught exception and an unhandled rejection, as real app code would produce them.
		await page.evaluate((m) => {
			setTimeout(() => {
				throw new TypeError(`${m} uncaught`);
			});
			void Promise.reject(new Error(`${m} rejected`));
		}, marker);

		const rows = await eventually(() =>
			query<{ kind: string; message: string; route_id: string; source: string }>(
				`select kind, message, route_id, context->>'source' as source from app_errors
				 where message like $1 order by message`,
				[`%${marker}%`]
			).then((r) => (r.length === 2 ? r : null))
		);
		expect(rows).toEqual([
			{
				kind: 'client',
				message: `Error: ${marker} rejected`,
				route_id: '/(app)/train',
				source: 'unhandledrejection'
			},
			{
				kind: 'client',
				message: `TypeError: ${marker} uncaught`,
				route_id: '/(app)/train',
				source: 'error'
			}
		]);

		// The endpoint validates what it stores.
		const bad = await request.post('/api/client-errors', {
			headers: SAME_ORIGIN,
			data: { source: 'console' }
		});
		expect(bad.status()).toBe(422);
	});

	test('server errors are logged with a request id and recorded', async ({ request }) => {
		const res = await request.get('/api/test-support/error', {
			headers: { accept: 'application/json' }
		});
		expect(res.status()).toBe(500);
		const requestId = res.headers()['x-request-id'];
		expect(requestId).toBeTruthy();
		const body = await res.json();
		expect(body.message).toBe('Something went wrong on our side.');
		expect(JSON.stringify(body)).not.toContain('Intentional');

		const rows = await eventually(() =>
			query<{ kind: string; status: number; message: string }>(
				'select kind, status, message from app_errors where request_id = $1',
				[requestId]
			).then((r) => (r.length ? r : null))
		);
		expect(rows).toEqual([
			{ kind: 'unknown', status: 500, message: 'Intentional test error (observability check)' }
		]);
	});
});
