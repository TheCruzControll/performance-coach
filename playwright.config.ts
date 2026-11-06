import { defineConfig, devices, type Project } from '@playwright/test';

/**
 * End-to-end tests run against the real production Node server (adapter-node build) and a
 * disposable Postgres database; both are prepared by e2e/global-setup.ts.
 *
 * Authentication (docs/testing.md#authentication):
 * - `setup` (Chromium) performs the owner's real first-run setup — a WebAuthn registration
 *   through a CDP virtual authenticator — and saves the signed-in state every Chromium spec
 *   starts from. Chromium never uses an auth bypass.
 * - `setup-webkit` (with WebKit only) mints a session through the test-only route, because
 *   WebKit has no virtual authenticator.
 * - Specs that need a signed-out browser opt out with `test.use({ storageState: signedOut })`.
 *
 * Projects: iPhone-class viewport on Chromium everywhere; CI (or E2E_WEBKIT=1) adds WebKit,
 * the engine behind iOS Safari. The CPU-sensitive main-thread budget (perf.e2e.ts) is its own
 * single-worker project that starts only after the functional suites, so nothing contends with
 * it. `exclusive` specs change state every other session depends on ("sign out everywhere
 * else"), so they run last, alone. `serial` specs change the one owner's training profile, so
 * they run one at a time after the functional suites (Chromium, then WebKit), before perf.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 4173);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`;
const withWebKit = Boolean(process.env.CI) || process.env.E2E_WEBKIT === '1';

const iphone = devices['iPhone 15 Pro'];
const CHROMIUM_STATE = 'e2e/.auth/chromium.json';
const WEBKIT_STATE = 'e2e/.auth/webkit.json';
const FUNCTIONAL_IGNORE = ['**/perf.e2e.ts', '**/*.exclusive.e2e.ts', '**/*.serial.e2e.ts'];
const SERIAL = '**/*.serial.e2e.ts';
// E2E_SERIAL_ALONE=1: run serial specs right after the owner setup, without the functional suite.
const serialAlone = process.env.E2E_SERIAL_ALONE === '1';

const projects: Project[] = [
	{
		name: 'setup',
		testMatch: '**/auth.setup.ts',
		use: { ...iphone, browserName: 'chromium' }
	},
	{
		name: 'iphone-chromium',
		testIgnore: FUNCTIONAL_IGNORE,
		dependencies: ['setup'],
		use: { ...iphone, browserName: 'chromium', storageState: CHROMIUM_STATE }
	},
	// The main-thread budget measures real CPU time, so it must not share the machine with
	// other specs: it runs alone (one worker) after the functional suite has finished.
	{
		name: 'perf',
		testMatch: '**/perf.e2e.ts',
		// E2E_PERF_ALONE=1 pnpm test:e2e --project=perf: just the owner setup, then the budget.
		dependencies:
			process.env.E2E_PERF_ALONE === '1'
				? ['setup']
				: [withWebKit ? 'serial-webkit' : 'serial-chromium'],
		workers: 1,
		fullyParallel: false,
		use: { ...iphone, browserName: 'chromium', storageState: CHROMIUM_STATE }
	}
];

if (withWebKit) {
	projects.push(
		{
			name: 'setup-webkit',
			testMatch: '**/auth-webkit.setup.ts',
			dependencies: ['setup'],
			use: { ...iphone, browserName: 'webkit' }
		},
		{
			name: 'iphone-webkit',
			testIgnore: FUNCTIONAL_IGNORE,
			dependencies: ['setup-webkit'],
			use: { ...iphone, browserName: 'webkit', storageState: WEBKIT_STATE }
		}
	);
}

// One spec at a time, after the functional suites: they reset and change the owner's training
// profile, which every browser and worker shares.
projects.push({
	name: 'serial-chromium',
	testMatch: SERIAL,
	dependencies: serialAlone
		? ['setup']
		: ['iphone-chromium', ...(withWebKit ? ['iphone-webkit'] : [])],
	workers: 1,
	fullyParallel: false,
	use: { ...iphone, browserName: 'chromium', storageState: CHROMIUM_STATE }
});
if (withWebKit) {
	projects.push({
		name: 'serial-webkit',
		testMatch: SERIAL,
		dependencies: serialAlone ? ['setup-webkit', 'serial-chromium'] : ['serial-chromium'],
		workers: 1,
		fullyParallel: false,
		use: { ...iphone, browserName: 'webkit', storageState: WEBKIT_STATE }
	});
}

projects.push({
	name: 'exclusive',
	testMatch: '**/*.exclusive.e2e.ts',
	dependencies: projects.filter((p) => !p.name!.startsWith('setup')).map((p) => p.name!),
	workers: 1,
	fullyParallel: false,
	use: { ...iphone, browserName: 'chromium', storageState: CHROMIUM_STATE }
});

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
	projects
});
