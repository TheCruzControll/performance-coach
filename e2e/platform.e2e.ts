import { expect, test } from '@playwright/test';
import { eventually, query } from './support';

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
	});

	test('/api/vitals stores a posted metric in Postgres', async ({ request }) => {
		const id = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const res = await request.post('/api/vitals', {
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

		const bad = await request.post('/api/vitals', { data: { id, name: 'FID', value: 1 } });
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
