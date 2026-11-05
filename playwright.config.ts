import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the real production Node server (adapter-node build) and a
 * disposable Postgres database; both are prepared by e2e/global-setup.ts.
 *
 * Projects: iPhone-class viewport on Chromium everywhere; CI (or E2E_WEBKIT=1) adds WebKit,
 * the engine behind iOS Safari. The CPU-sensitive main-thread budget (perf.e2e.ts) is its own
 * single-worker project that starts only after the Chromium suite, so nothing contends with it.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 4173);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`;
const withWebKit = Boolean(process.env.CI) || process.env.E2E_WEBKIT === '1';

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.ts',
	globalSetup: './e2e/global-setup.ts',
	outputDir: 'test-results',
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 1 : 2,
	timeout: 30_000,
	expect: { timeout: 7_500 },
	reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
	use: {
		baseURL,
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure',
		colorScheme: 'dark'
	},
	projects: [
		{
			name: 'iphone-chromium',
			testIgnore: '**/perf.e2e.ts',
			use: { ...devices['iPhone 15 Pro'], browserName: 'chromium' }
		},
		// The main-thread budget measures real CPU time, so it must not share the machine with
		// other specs: it runs alone (one worker) after the functional suite has finished.
		{
			name: 'perf',
			testMatch: '**/perf.e2e.ts',
			dependencies: ['iphone-chromium'],
			workers: 1,
			fullyParallel: false,
			use: { ...devices['iPhone 15 Pro'], browserName: 'chromium' }
		},
		...(withWebKit
			? [
					{
						name: 'iphone-webkit',
						testIgnore: '**/perf.e2e.ts',
						use: { ...devices['iPhone 15 Pro'], browserName: 'webkit' as const }
					}
				]
			: [])
	]
});
