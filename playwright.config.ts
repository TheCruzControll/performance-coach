import { defineConfig, devices, type Project } from '@playwright/test';
import { DESKTOP } from './e2e/desktop';
import { bypassHeaders, e2eProjects, GROUPS, parseChoice, SMOKE } from './e2e/projects';

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
 * the engine behind iOS Safari (and Chrome for iOS). `desktop-chromium` opens a 1440 × 900
 * desktop window and runs whole files: every `*.desktop.e2e.ts`, which the iPhone projects skip,
 * plus the shell, offline and axe specs. There is no desktop WebKit project: the one user's
 * desktop browser is Chrome. It reuses the setup session, so they run only specs that leave shared state as
 * they found it; desktop cases that change the training profile live in serial specs with
 * `test.use(DESKTOP)`. The CPU-sensitive budgets (perf.e2e.ts, perf-*.e2e.ts) are their own
 * single-worker project that starts only after the functional suites, so nothing contends with
 * it. `exclusive` specs change state every other session depends on ("sign out everywhere
 * else"), so they run last, alone. `serial` specs change the one owner's training profile, so
 * they run one at a time after the functional suites (Chromium, then WebKit), before perf.
 * Heavy `*.sweep.e2e.ts` specs run one at a time in `sweep-chromium` and `sweep-webkit`, after
 * perf and before exclusive. E2E_ENGINE and E2E_GROUP run one CI leg (e2e/projects.ts).
 *
 * Targets (e2e/projects.ts e2eMode): E2E_BASE_URL alone verifies a deployment with only the
 * read-only `*.smoke.e2e.ts` specs, signed out; E2E_TEST_AUTH=1 with it runs the whole suite
 * against an external server with test routes on; E2E_DEPLOYED_LOCAL=1 runs the smoke specs
 * against the local production build with test routes off. The local projects run the smoke
 * specs too, the desktop one included.
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 4173);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`;
const group = parseChoice('E2E_GROUP', process.env.E2E_GROUP, GROUPS);
const withWebKit =
	Boolean(process.env.CI) || process.env.E2E_WEBKIT === '1' || process.env.E2E_ENGINE === 'webkit';

const iphone = devices['iPhone 15 Pro'];
const CHROMIUM_STATE = 'e2e/.auth/chromium.json';
const WEBKIT_STATE = 'e2e/.auth/webkit.json';
const SWEEP = '**/*.sweep.e2e.ts';
/** The perf project's specs: M3's screens (perf.e2e.ts) and one file per later concern. */
const PERF = ['**/perf.e2e.ts', '**/perf-*.e2e.ts'];
const FUNCTIONAL_IGNORE = [...PERF, '**/*.exclusive.e2e.ts', '**/*.serial.e2e.ts', SWEEP];
const DESKTOP_ONLY = '**/*.desktop.e2e.ts';
/**
 * What the desktop project runs: desktop specs, the width-agnostic shell, offline and smoke specs,
 * and axe.
 */
const DESKTOP_SPECS = [
	DESKTOP_ONLY,
	'**/shell.e2e.ts',
	'**/offline.e2e.ts',
	'**/a11y-*.e2e.ts',
	SMOKE
];
/** A device descriptor resized to the DESKTOP window (e2e/desktop.ts) that desktop specs use. */
const desktopWindow = (device: string) => ({ ...devices[device], ...DESKTOP });
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
		testIgnore: [...FUNCTIONAL_IGNORE, DESKTOP_ONLY],
		dependencies: ['setup'],
		use: { ...iphone, browserName: 'chromium', storageState: CHROMIUM_STATE }
	},
	{
		name: 'desktop-chromium',
		testMatch: DESKTOP_SPECS,
		testIgnore: FUNCTIONAL_IGNORE,
		dependencies: ['setup'],
		use: {
			...desktopWindow('Desktop Chrome'),
			browserName: 'chromium',
			storageState: CHROMIUM_STATE
		}
	},
	// The main-thread budget measures real CPU time, so it must not share the machine with
	// other specs: it runs alone (one worker) after the functional suite has finished.
	{
		name: 'perf',
		testMatch: PERF,
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
			testIgnore: [...FUNCTIONAL_IGNORE, DESKTOP_ONLY],
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
		: ['iphone-chromium', 'desktop-chromium', ...(withWebKit ? ['iphone-webkit'] : [])],
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

// Heavy sweeps, one at a time, after every functional, serial and perf project. In CI they run
// in legs of their own, which start them right after the setup projects (e2e/projects.ts).
projects.push({
	name: 'sweep-chromium',
	testMatch: SWEEP,
	dependencies: projects.filter((p) => !p.name!.startsWith('setup')).map((p) => p.name!),
	workers: 1,
	fullyParallel: false,
	use: { ...iphone, browserName: 'chromium', storageState: CHROMIUM_STATE }
});
if (withWebKit) {
	projects.push({
		name: 'sweep-webkit',
		testMatch: SWEEP,
		dependencies: ['setup-webkit', 'sweep-chromium'],
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
	// CI main legs run whole files side by side on 2 workers, as local runs do (auth.setup.ts
	// registers a passkey per worker). serial, alone, exclusive and sweeps legs keep 1.
	workers: process.env.CI && group !== 'main' ? 1 : 2,
	timeout: 30_000,
	expect: { timeout: 7_500 },
	reporter: [
		['list'],
		['html', { open: 'never', outputFolder: 'playwright-report' }],
		// Read by scripts/e2e-timing.ts: where each CI leg's minutes go.
		...(process.env.CI ? [['json', { outputFile: 'test-results/report.json' }] as const] : [])
	],
	use: {
		baseURL,
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure',
		colorScheme: 'dark',
		extraHTTPHeaders: bypassHeaders(process.env)
	},
	projects: e2eProjects(process.env, projects)
});
