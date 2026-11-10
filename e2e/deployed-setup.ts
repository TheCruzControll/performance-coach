/**
 * A deployed run's target check (project `deployed-setup`, e2e/projects.ts): before any smoke spec,
 * the target is up, says which version it runs, and does NOT expose test routes. A server with
 * test routes on is not a deployment (env validation refuses them on every hosted environment):
 * the run stops rather than verify the wrong thing. With E2E_EXPECT_VERSION, the target must run
 * exactly that version (the post-deploy smoke passes the commit it deployed).
 */
import { expect, test as setup } from '@playwright/test';

setup(
	'the target is healthy, reports its version and has no test routes',
	async ({ request, baseURL }) => {
		const health = await request.get('/api/health');
		expect(health.status(), 'GET /api/health').toBe(200);
		const report = (await health.json()) as { ok: boolean; db: string; version: string };
		expect(report).toMatchObject({ ok: true, db: 'up' });
		expect(report.version, 'the deployed version').toMatch(/\S/);
		if (process.env.E2E_EXPECT_VERSION) expect(report.version).toBe(process.env.E2E_EXPECT_VERSION);

		// The test-only session route answers 404 unless test routes are on (it has only POST, so a
		// GET could not tell). On a real deployment this POST changes nothing.
		const minted = await request.post('/api/test-support/session', {
			headers: { origin: new URL(baseURL!).origin },
			maxRedirects: 0
		});
		expect(minted.status(), 'POST /api/test-support/session must be 404 on a deployment').toBe(404);
	}
);
