/**
 * Lighthouse (mobile emulation, simulated slow 4G + 4× CPU) against the local production Node
 * server, using the preinstalled Playwright Chromium. Reports go to ./lighthouse-reports.
 *
 *   ORIGIN=http://localhost:4174 pnpm build:node && pnpm lighthouse   # every screen, 3 runs
 *   pnpm lighthouse --desktop --seed   # desktop preset at 1440 × 900 → lighthouse-reports/desktop
 *   pnpm lighthouse --runs 5 --routes /,/today
 *   pnpm lighthouse --url https://preview.example.com   # audit an already-running server
 *   pnpm lighthouse --assert                            # exit 1 when a threshold is missed
 *   pnpm lighthouse --shard 2/3                         # every third route, from the second
 *
 * With --assert a route stops early once its runs so far decide every threshold's median
 * (3 of 5 runs passing or missing it: scripts/lib/lighthouse-verdict.ts); summary.json and the
 * table record the runs each route took.
 *
 * --shard i/N (scripts/lib/lighthouse-shard.ts) audits every N-th route of the full list (the
 * routes, then with --seed the program and workout screens), so CI's N parallel jobs audit each
 * route once; --seed still seeds in every shard, the program is built only in a shard that audits
 * a seeded screen, and the workouts are synced only in a shard that audits History or /workout.
 * A sharded run writes to lighthouse-reports/<form factor>/shard-<i>; every run puts each route's
 * wall time in the table and $GITHUB_STEP_SUMMARY.
 *
 * The local server uses E2E_DATABASE_URL (default: local coach_e2e) after applying migrations.
 *
 * Every app screen needs a session (deny by default), so the script mints one for the owner
 * directly in that disposable database (a placeholder owner if setup never ran) and sends its
 * cookie with every request; `/` (the sign-in screen) is audited signed out. Against an external
 * server (--url) pass a session cookie value in LIGHTHOUSE_SESSION, or only `/` is meaningful.
 * Build the Node server with ORIGIN=http://localhost:<port> so it knows it is served over HTTP.
 *
 * --seed (on by default in CI; --no-seed turns it off) audits the program screens against a real
 * generated program. It needs the local server's database, so it cannot be used with --url:
 * - it removes every program and writes the SEED_PROFILE demo profile (scripts/lib/demo-profiles.ts)
 *   for the owner, so the routes are audited with /today in its Build-card state
 * - it POSTs /today?/preview as the screen does (the minted session, the Origin header and
 *   SEED_TIME_ZONE), then /today?/build with the preview's dates and fingerprints
 * - it audits /today in its program state, /train, week 1's longest strength session and
 *   /train/history, with ids read from the database
 * - it fetches that session's start kit (GET /api/workouts/kit) and syncs HISTORY_WORKOUTS
 *   finished, ad-hoc workouts of it through POST /api/workouts/sync, as a device would, then
 *   audits workout History's list and the newest workout's detail
 * - it audits /workout in its active state: before each run it writes a workout in progress of
 *   that kit into the fresh browser's IndexedDB on the origin, over CDP
 *   (scripts/lib/workout-seed.ts), and the run keeps it (Lighthouse's storage reset off)
 * - last, it audits the coach as M5 finished it, each screen on a fixture of its own seeded through
 *   the test-only route (/api/test-support/coach, so the seeded server enables test routes) after
 *   emptying the owner's programs, workouts and conversations, which a fixture requires: a long
 *   conversation (long-thread, a full page of the thread view and one more exchange) and the
 *   Proposals inbox with two proposals waiting (split-squat-week, then the composer's real turns
 *   'I hate Bulgarian split squats, so replace them' and 'Plan my next cycle', as
 *   e2e/coach-inbox.serial.e2e.ts proposes them). They come after every other seeded screen,
 *   since the reset removes the program and the workouts those are audited on.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse, { type RunnerResult } from 'lighthouse';
import pg from 'pg';
import { PREPAINT_KEY } from '../src/lib/client/workout/prepaint.ts';
import { LOCAL_DATABASE_URLS, runMigrations } from '../src/lib/server/db/migrate.ts';
import type { StartKit, StrengthKit, SyncResponse } from '../src/lib/domain/workout/index.ts';
import { createSseDecoder } from '../src/lib/domain/coach/events.ts';
import type { CoachFixture, SeededCoach } from '../src/lib/server/test-support/coach-fixtures.ts';
import { readActionAnswer } from './lib/action-result.ts';
import { seedDemoProfile, type DemoProfile } from './lib/demo-profiles.ts';
import { verdictDecided } from './lib/lighthouse-verdict.ts';
import { lighthouseConfig, reportDir, type FormFactor } from './lib/lighthouse-config.ts';
import { parseShard, shardReportDir, shardUrls } from './lib/lighthouse-shard.ts';
import {
	activeWorkoutSeed,
	finishedWorkout,
	writeActiveWorkout,
	type ActiveSeed
} from './lib/workout-seed.ts';

const { values } = parseArgs({
	allowNegative: true,
	options: {
		url: { type: 'string' },
		// Every app screen: the sign-in screen, the five tabs (incl. the streamed, DB-backed
		// Profile) and Security.
		routes: {
			type: 'string',
			default: '/,/today,/train,/progress,/coach,/profile,/profile/security'
		},
		runs: { type: 'string', default: '3' },
		// Default: the port of the origin baked into the Node build (ORIGIN at build time).
		port: { type: 'string' },
		// Desktop form factor (scripts/lib/lighthouse-config.ts); the thresholds stay the same.
		desktop: { type: 'boolean', default: false },
		assert: { type: 'boolean', default: false },
		'min-perf': { type: 'string', default: '0.9' },
		'max-lcp': { type: 'string', default: '2500' },
		'max-cls': { type: 'string', default: '0.1' },
		'max-tbt': { type: 'string', default: '200' },
		seed: { type: 'boolean', default: Boolean(process.env.CI) },
		// i/N: every N-th audit of the full list, from the i-th (scripts/lib/lighthouse-shard.ts).
		shard: { type: 'string', default: '1/1' }
	}
});
if (values.seed && values.url) {
	throw new Error("--seed writes to the local server's database: pass --no-seed with --url.");
}

/** The profile the seeded run builds from: strength, runs and Muay Thai, so every session kind. */
const SEED_PROFILE: DemoProfile = 'hybrid-blank';
/** The device zone the seeded preview and build send: fixed, so the run never depends on the VM's. */
const SEED_TIME_ZONE = 'Europe/London';
/** 'This week', so week 1 is the current week and Today shows the program on any weekday. */
const SEED_START = 'this_week';
/** History's first page (20 a page): the list as full as it gets before 'Show older'. */
const HISTORY_WORKOUTS = 20;
/** Mutations per sync request, under the protocol's 25 (SYNC_LIMITS). */
const SYNC_BATCH = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
/** What the inbox is audited with: the swap and the next cycle, each proposed in its own turn. */
const COACH_PROPOSALS = [
	'I hate Bulgarian split squats, so replace them',
	'Plan my next cycle'
] as const;

/**
 * Thresholds checked with --assert (simulated throttling, both form factors). Defaults are the
 * documented targets (docs/performance.md); CI may pass slightly looser values as a
 * regression guard because shared runners add CPU noise to TBT.
 */
const THRESHOLDS = {
	performance: Number(values['min-perf']),
	lcpMs: Number(values['max-lcp']),
	cls: Number(values['max-cls']),
	tbtMs: Number(values['max-tbt'])
};
const FORM_FACTOR: FormFactor = values.desktop ? 'desktop' : 'mobile';
const CONFIG = lighthouseConfig(FORM_FACTOR);
const SHARD = parseShard(values.shard);
const OUT_DIR = shardReportDir(reportDir(FORM_FACTOR), FORM_FACTOR, SHARD);
/** The run's name in the table and the step summary: the form factor, and the shard if any. */
const RUN_NAME = `${FORM_FACTOR}${SHARD.count > 1 ? ` · shard ${SHARD.index}/${SHARD.count}` : ''}`;
const runs = Math.max(1, Number(values.runs));
const routes = values.routes
	.split(',')
	.map((r) => r.trim())
	.filter(Boolean);

async function waitForHealth(base: string, server: ChildProcess) {
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			if ((await fetch(`${base}/api/health`)).ok) return;
		} catch {
			// not up yet
		}
		if (server.exitCode !== null) throw new Error(`server exited (${server.exitCode})`);
		if (Date.now() > deadline) throw new Error('server did not become healthy in 30s');
		await new Promise((r) => setTimeout(r, 200));
	}
}

/**
 * A session for the owner in the disposable database (test tooling only — the app itself only
 * ever issues sessions after a passkey or recovery-code sign-in).
 */
async function mintSession(db: string): Promise<{ token: string; ownerId: string }> {
	const client = new pg.Client({ connectionString: db });
	await client.connect();
	try {
		const token = randomBytes(32).toString('base64url');
		const owner = await client.query<{ id: string }>(
			`with existing as (select id from owners limit 1),
			      created as (
			        insert into owners (display_name, webauthn_user_id)
			        select 'Test Owner', $1 where not exists (select 1 from existing)
			        returning id)
			 select id from existing union all select id from created`,
			[randomBytes(32).toString('base64url')]
		);
		await client.query(
			`insert into auth_sessions (owner_id, token_hash, method, expires_at, absolute_expires_at)
			 values ($1, $2, 'test', now() + interval '1 day', now() + interval '1 day')`,
			[owner.rows[0]!.id, createHash('sha256').update(token).digest('hex')]
		);
		return { token, ownerId: owner.rows[0]!.id };
	} finally {
		await client.end();
	}
}

/**
 * The public origin baked into the Node build (vite.config.ts → paths.origin). The server must
 * listen there: CSRF checks compare it with each request's Origin, and the sign-in screen's
 * passkey request is refused on any other port.
 */
function builtOrigin(): URL {
	const config = readFileSync('build/adapter-node.js', 'utf8');
	const origin = /export const origin = "([^"]+)"/.exec(config)?.[1];
	if (!origin) {
		throw new Error(
			'The Node build has no public origin. Rebuild with ORIGIN=http://localhost:4174 pnpm build:node.'
		);
	}
	return new URL(origin);
}

async function startServer(): Promise<{
	base: string;
	stop: () => void;
	session: string;
	db: string;
	ownerId: string;
}> {
	if (!existsSync('build/index.js')) {
		throw new Error(
			'No Node build found. Run `ORIGIN=http://localhost:4174 pnpm build:node` first.'
		);
	}
	const origin = builtOrigin();
	const port = values.port ?? origin.port;
	if (origin.hostname !== 'localhost' || origin.port !== port) {
		throw new Error(
			`The build's origin is ${origin.origin}, but Lighthouse would serve http://localhost:${port}. ` +
				`Rebuild with ORIGIN=http://localhost:${port} pnpm build:node.`
		);
	}
	const db = process.env.E2E_DATABASE_URL || LOCAL_DATABASE_URLS.e2e;
	await runMigrations(db);
	const base = `http://localhost:${port}`;
	const server = spawn(process.execPath, ['build/index.js'], {
		stdio: 'ignore',
		env: {
			...process.env,
			NODE_ENV: 'production',
			APP_ENV: 'test',
			PORT: port,
			ORIGIN: base,
			DATABASE_URL: db,
			LOG_LEVEL: 'warn',
			// The coach screens' fixtures are seeded through the test-only route; the screens audited
			// are the same with or without it.
			...(values.seed ? { ENABLE_TEST_ROUTES: 'true' } : {})
		}
	});
	await waitForHealth(base, server);
	const { token, ownerId } = await mintSession(db);
	return { base, stop: () => server.kill('SIGTERM'), session: token, db, ownerId };
}

/** Run `fn` with a client on the server's database. */
async function withClient<T>(db: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: db });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end();
	}
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const server = values.url
	? {
			base: values.url.replace(/\/$/, ''),
			stop: () => {},
			session: process.env.LIGHTHOUSE_SESSION ?? '',
			db: '',
			ownerId: ''
		}
	: await startServer();
/** The cookie name depends on the origin's scheme (src/lib/server/auth/cookies.ts): send both. */
const sessionHeaders = server.session
	? { Cookie: `session=${server.session}; __Host-session=${server.session}` }
	: undefined;
const chromePath = process.env.LIGHTHOUSE_CHROME_PATH || chromium.executablePath();

/**
 * A fresh browser for every run, as Lighthouse CI does. Reusing one browser made each run start
 * by tearing down the previous run's page on the same renderer thread: an untraced task of
 * 25–60 ms (observed; ×4 when simulated) *before our HTML is even parsed*, which Lighthouse
 * reports as "Unattributable" and which made simulated TBT bimodal (docs/performance.md).
 */
const launchChrome = () =>
	chromeLauncher.launch({
		chromePath,
		chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
	});

mkdirSync(OUT_DIR, { recursive: true });
let chrome = await launchChrome();
const chromeVersion = await fetch(`http://127.0.0.1:${chrome.port}/json/version`)
	.then((r) => r.json() as Promise<{ Browser: string }>)
	.then((v) => v.Browser)
	.catch(() => 'Chromium');
let lighthouseVersion = '';

/**
 * One Lighthouse run in a fresh browser. A run that Lighthouse itself reports as broken (e.g.
 * NO_NAVSTART: the trace missed the navigation, which happens occasionally right after a
 * browser starts) is repeated, up to twice; it is never counted as a score of 0.
 */
async function auditOnce(
	url: string,
	device?: ActiveSeed,
	attempt = 1
): Promise<NonNullable<RunnerResult>> {
	await chrome.kill();
	chrome = await launchChrome();
	if (device) await seedDevice(device);
	const signedIn = new URL(url).pathname !== '/';
	const result = await lighthouse(
		url,
		{
			port: chrome.port,
			// The device's workout, written into this browser's IndexedDB, stays for the run.
			...(device ? { disableStorageReset: true } : {}),
			...(signedIn && sessionHeaders ? { extraHeaders: sessionHeaders } : {}),
			output: ['json', 'html'],
			logLevel: 'error',
			// Only the HTML report's element thumbnails use it (about 1 s a run); no score or audit does.
			disableFullPageScreenshot: true,
			onlyCategories: (
				process.env.LH_CATEGORIES ?? 'performance,accessibility,best-practices'
			).split(',')
		},
		CONFIG
	);
	if (!result) throw new Error(`Lighthouse returned no result for ${url}`);
	const error = result.lhr.runtimeError;
	if (error) {
		if (attempt >= 3) throw new Error(`Lighthouse failed 3 times on ${url}: ${error.code}`);
		console.warn(`lighthouse: ${url} attempt ${attempt} failed (${error.code}); retrying`);
		return auditOnce(url, device, attempt + 1);
	}
	return result;
}
interface Summary {
	route: string;
	/** The runs the median is over: fewer than `runs` when --assert stopped early. */
	runs: number;
	/** The route's wall time over all its runs, in seconds. */
	seconds: number;
	performance: number;
	accessibility: number;
	bestPractices: number;
	lcp: number;
	fcp: number;
	tbt: number;
	cls: number;
	si: number;
}
const summaries: Summary[] = [];

/** No program, and the demo profile with onboarding complete: Today shows the Build card. */
async function seedProfile() {
	await withClient(server.db, async (client) => {
		await client.query('truncate programs cascade');
		await seedDemoProfile(client, server.ownerId, SEED_PROFILE);
	});
}

/** One of Today's actions, posted as the Build preview posts it: its decoded data. */
async function todayAction(name: 'preview' | 'build', payload: unknown): Promise<unknown> {
	const body = new FormData();
	body.set('payload', JSON.stringify(payload));
	const response = await fetch(`${server.base}/today?/${name}`, {
		method: 'POST',
		body,
		headers: {
			...sessionHeaders,
			origin: server.base,
			accept: 'application/json',
			'x-sveltekit-action': 'true'
		}
	});
	const text = await response.text();
	const answer = readActionAnswer(text);
	if (answer.type !== 'success') {
		throw new Error(`/today?/${name} answered ${response.status}: ${text.slice(0, 500)}`);
	}
	return answer.data;
}

/**
 * Preview and build the seeded profile's program, as Start week 1 does: the program screens to
 * audit, with the session's lineage read from the database.
 */
async function buildSeededProgram(): Promise<{
	paths: Record<ProgramRoute, string>;
	lineage: string;
}> {
	const request = { timeZone: SEED_TIME_ZONE, start: SEED_START };
	const { preview } = (await todayAction('preview', request)) as {
		preview: { startsOn: string; firstPlannedDay: string; fingerprint: string; digest: string };
	};
	const { startsOn, firstPlannedDay, fingerprint, digest } = preview;
	await todayAction('build', { ...request, startsOn, firstPlannedDay, fingerprint, digest });
	// The session with the most exercises: the session screen's longest page.
	const session = await withClient(server.db, (client) =>
		client.query<{ lineage: string }>(
			`select s.lineage_id as lineage
			 from programs p
			 join program_version_weeks vw on vw.version_id = p.current_version_id
			 join program_weeks w on w.id = vw.week_id
			 join planned_sessions s on s.week_id = w.id
			 where p.owner_id = $1 and p.status = 'active'
			 order by (select count(*) from planned_exercises e where e.session_id = s.id) desc,
			   s.scheduled_on, s.order_in_day
			 limit 1`,
			[server.ownerId]
		)
	);
	const lineage = session.rows[0]?.lineage;
	if (!lineage) throw new Error('The seeded program has no session');
	const paths = {
		'/today · program': '/today',
		'/train · program': '/train',
		'/train/session/[key]': `/train/session/${lineage}`,
		'/train/history': '/train/history'
	};
	return { paths, lineage };
}

/** The signed-in owner's JSON from `path`, as the app's own requests send it. */
async function ownerJson(path: string, body?: unknown): Promise<unknown> {
	const response = await fetch(`${server.base}${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { ...sessionHeaders, origin: server.base, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	});
	if (!response.ok) throw new Error(`${path} answered ${response.status}`);
	return response.json();
}

/**
 * The seeded session's kit, HISTORY_WORKOUTS finished workouts of it synced (one a day, the newest
 * yesterday), and the workout in progress /workout is audited with: History's routes and the seed.
 */
async function seedWorkouts(
	lineage: string
): Promise<{ paths: Record<WorkoutRoute, string>; device: ActiveSeed }> {
	const kit = (await ownerJson(`/api/workouts/kit?lineage=${lineage}`)) as StartKit;
	if (kit.kind !== 'strength') throw new Error(`The seeded session is ${kit.kind}, not strength`);
	let newest = '';
	for (let day = 1; day <= HISTORY_WORKOUTS; day++) {
		const { workoutId, mutations } = finishedWorkout(kit as StrengthKit, Date.now() - day * DAY_MS);
		for (let i = 0; i < mutations.length; i += SYNC_BATCH) {
			const batch = mutations.slice(i, i + SYNC_BATCH);
			const { results } = (await ownerJson('/api/workouts/sync', {
				v: 1,
				mutations: batch
			})) as SyncResponse;
			const refused = results.filter((r) => r.status !== 'applied');
			if (refused.length) throw new Error(`sync refused: ${JSON.stringify(refused)}`);
		}
		newest ||= workoutId;
	}
	const paths = {
		'/progress/workouts': '/progress/workouts',
		'/progress/workouts/[id]': `/progress/workouts/${newest}`,
		'/workout · active': '/workout'
	};
	return { paths, device: activeWorkoutSeed(kit, Date.now()) };
}

/**
 * Writes the device's workout into the current browser's IndexedDB, on the app's origin, then
 * shows it once on /workout, signed in as the audit is, until the strength view has kept the card
 * the next load paints before the app starts (prepaint.ts). Every real device has shown its
 * workout once, since starting one lands on /workout, so the audited load is that device's.
 */
async function seedDevice(device: ActiveSeed) {
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`);
	try {
		const page = await browser.contexts()[0]!.newPage();
		// No service worker for the seed: its install would fetch the whole build in the
		// background, and could refill the HTTP cache or take control after the clear below.
		await page.addInitScript(() => {
			if (!('serviceWorker' in navigator)) return;
			navigator.serviceWorker.register = () => new Promise<ServiceWorkerRegistration>(() => {});
		});
		await page.goto(`${server.base}/robots.txt`);
		await writeActiveWorkout(page, device);
		if (sessionHeaders) await page.setExtraHTTPHeaders(sessionHeaders);
		await page.goto(`${server.base}/workout`);
		await page.waitForFunction((key) => localStorage.getItem(key), PREPAINT_KEY);
		// Keep only the device's state (localStorage, IndexedDB): the audit, which skips the storage
		// reset for it, stays a cold network load, with no cached chunk from here.
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Network.clearBrowserCache');
		await cdp.detach();
		await page.close();
	} finally {
		// Connected over CDP, this disconnects: the browser and its profile stay for the run.
		await browser.close();
	}
}

/**
 * Empty the owner's programs, workouts and conversations (a coach fixture is refused on top of
 * any), then seed `fixture` through the test-only route: the ids it stored.
 */
async function seedCoach(fixture: CoachFixture): Promise<SeededCoach> {
	await withClient(server.db, (client) =>
		client.query('truncate coach_threads, programs, workouts cascade')
	);
	return (await ownerJson('/api/test-support/coach', {
		fixture,
		timeZone: SEED_TIME_ZONE
	})) as SeededCoach;
}

/** One turn in a new conversation, sent as the composer sends it and read to its end. */
async function coachTurn(text: string): Promise<void> {
	const response = await fetch(`${server.base}/api/coach/turns`, {
		method: 'POST',
		headers: { ...sessionHeaders, origin: server.base, 'content-type': 'application/json' },
		body: JSON.stringify({ threadId: null, clientMessageId: randomUUID(), text })
	});
	if (response.status !== 200) throw new Error(`'${text}' answered ${response.status}`);
	const decoder = createSseDecoder();
	const events = [...decoder.push(new Uint8Array(await response.arrayBuffer())), ...decoder.end()];
	const last = events.at(-1);
	if (last?.type !== 'done' || last.status !== 'completed') {
		throw new Error(`'${text}' ended with ${JSON.stringify(last)}`);
	}
}

/** The coach screen `label` on its own fixture: the path to audit. */
async function seedCoachScreen(label: CoachRoute): Promise<string> {
	if (label === '/coach/[thread] · long') {
		const { threads } = await seedCoach('long-thread');
		if (!threads.long) throw new Error('long-thread stored no thread');
		return `/coach/${threads.long}`;
	}
	await seedCoach('split-squat-week');
	for (const text of COACH_PROPOSALS) await coachTurn(text);
	const waiting = await withClient(server.db, (client) =>
		client.query<{ n: number }>(
			`select count(*)::int as n from coach_proposals where status = 'proposed'`
		)
	);
	if (waiting.rows[0]?.n !== COACH_PROPOSALS.length) {
		throw new Error(`The inbox has ${waiting.rows[0]?.n} waiting proposals`);
	}
	return '/coach/proposals';
}

/** The program screens --seed audits after the routes, in this order, by label. */
const PROGRAM_ROUTES = [
	'/today · program',
	'/train · program',
	'/train/session/[key]',
	'/train/history'
] as const;
type ProgramRoute = (typeof PROGRAM_ROUTES)[number];

/**
 * The workout screens --seed audits after the program's, in this order, by label. History comes
 * before /workout: the active workout, once synced, would add the resume bar. A shard keeps the
 * list's order, so this holds in every shard.
 */
const WORKOUT_ROUTES = [
	'/progress/workouts',
	'/progress/workouts/[id]',
	'/workout · active'
] as const;
type WorkoutRoute = (typeof WORKOUT_ROUTES)[number];

/**
 * The coach screens --seed audits last, each on its own fixture (seedCoachScreen). Seeding one
 * empties the program and the workouts, so they follow every other seeded screen; a shard keeps
 * the list's order, so this holds in every shard.
 */
const COACH_ROUTES = ['/coach/[thread] · long', '/coach/proposals · inbox'] as const;
type CoachRoute = (typeof COACH_ROUTES)[number];

const SEEDED_ROUTES = [...PROGRAM_ROUTES, ...WORKOUT_ROUTES, ...COACH_ROUTES] as const;
type SeededRoute = (typeof SEEDED_ROUTES)[number];
const isProgramRoute = (label: SeededRoute): label is ProgramRoute =>
	(PROGRAM_ROUTES as readonly string[]).includes(label);
const isCoachRoute = (label: SeededRoute): label is CoachRoute =>
	(COACH_ROUTES as readonly string[]).includes(label);

/** Every audit of the run, in order: the routes, then with --seed the program and workout screens. */
const AUDITS: ({ label: string; path: string } | { label: string; seeded: SeededRoute })[] = [
	...routes.map((path) => ({
		label: values.seed && path === '/today' ? '/today · build card' : path,
		path
	})),
	...(values.seed ? SEEDED_ROUTES.map((label) => ({ label, seeded: label })) : [])
];

/** Lighthouse `runs` times on `path`, summarised under `route`, its label; `device` seeded first. */
async function auditRoute(route: string, path: string, device?: ActiveSeed) {
	const started = Date.now();
	const results: Summary[] = [];
	for (let i = 0; i < runs; i++) {
		const result = await auditOnce(`${server.base}${path}`, device);
		const { lhr } = result;
		lighthouseVersion = lhr.lighthouseVersion;
		const audit = (id: string) => lhr.audits[id]?.numericValue ?? Number.NaN;
		results.push({
			route,
			runs: 1,
			seconds: 0,
			performance: lhr.categories.performance?.score ?? 0,
			accessibility: lhr.categories.accessibility?.score ?? 0,
			bestPractices: lhr.categories['best-practices']?.score ?? 0,
			lcp: audit('largest-contentful-paint'),
			fcp: audit('first-contentful-paint'),
			tbt: audit('total-blocking-time'),
			cls: audit('cumulative-layout-shift'),
			si: audit('speed-index')
		});
		const slug = route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
		const name = `${route === '/' ? 'sign-in' : slug}-run${i + 1}`;
		const [json, html] = result.report as string[];
		writeFileSync(`${OUT_DIR}/${name}.report.json`, json!);
		writeFileSync(`${OUT_DIR}/${name}.report.html`, html!);
		if (values.assert && i + 1 < runs && verdictDecided(results, runs, THRESHOLDS)) break;
	}
	const pick = (k: keyof Omit<Summary, 'route' | 'runs' | 'seconds'>) =>
		median(results.map((r) => r[k]));
	summaries.push({
		route,
		runs: results.length,
		seconds: (Date.now() - started) / 1000,
		performance: pick('performance'),
		accessibility: pick('accessibility'),
		bestPractices: pick('bestPractices'),
		lcp: pick('lcp'),
		fcp: pick('fcp'),
		tbt: pick('tbt'),
		cls: pick('cls'),
		si: pick('si')
	});
}

try {
	if (values.seed) await seedProfile();
	let program: Awaited<ReturnType<typeof buildSeededProgram>> | undefined;
	let workouts: Awaited<ReturnType<typeof seedWorkouts>> | undefined;
	for (const audit of shardUrls(AUDITS, SHARD.index, SHARD.count)) {
		if (!('seeded' in audit)) {
			await auditRoute(audit.label, audit.path);
			continue;
		}
		if (isCoachRoute(audit.seeded)) {
			await auditRoute(audit.label, await seedCoachScreen(audit.seeded));
			continue;
		}
		program ??= await buildSeededProgram();
		if (isProgramRoute(audit.seeded)) {
			await auditRoute(audit.label, program.paths[audit.seeded]);
			continue;
		}
		workouts ??= await seedWorkouts(program.lineage);
		const device = audit.seeded === '/workout · active' ? workouts.device : undefined;
		await auditRoute(audit.label, workouts.paths[audit.seeded], device);
	}
} finally {
	await chrome.kill();
	server.stop();
}

const lines = [
	`Lighthouse ${lighthouseVersion} (${RUN_NAME}, simulated throttling) — median of ${runs} run(s) per route${values.assert ? ', stopping early once the runs so far decide every asserted threshold' : ''}, ${chromeVersion}`,
	'',
	'| Route | Runs | Wall time | Perf | A11y | Best pr. | LCP | FCP | TBT | CLS | Speed Index |',
	'| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
	...summaries.map(
		(s) =>
			`| \`${s.route}\` | ${s.runs} | ${Math.round(s.seconds)} s | ${Math.round(s.performance * 100)} | ${Math.round(s.accessibility * 100)} | ${Math.round(s.bestPractices * 100)} | ${Math.round(s.lcp)} ms | ${Math.round(s.fcp)} ms | ${Math.round(s.tbt)} ms | ${s.cls.toFixed(3)} | ${Math.round(s.si)} ms |`
	)
];
console.log(lines.join('\n'));
writeFileSync(
	`${OUT_DIR}/summary.json`,
	JSON.stringify(
		{ formFactor: FORM_FACTOR, shard: SHARD, runs, thresholds: THRESHOLDS, summaries },
		null,
		2
	)
);
if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(
		process.env.GITHUB_STEP_SUMMARY,
		`## Lighthouse (${RUN_NAME})\n\n${lines.join('\n')}\n`
	);
}

if (values.assert) {
	const failures = summaries.flatMap((s) => [
		...(s.performance < THRESHOLDS.performance ? [`${s.route}: performance ${s.performance}`] : []),
		...(s.lcp > THRESHOLDS.lcpMs ? [`${s.route}: LCP ${Math.round(s.lcp)} ms`] : []),
		...(s.cls > THRESHOLDS.cls ? [`${s.route}: CLS ${s.cls.toFixed(3)}`] : []),
		...(s.tbt > THRESHOLDS.tbtMs ? [`${s.route}: TBT ${Math.round(s.tbt)} ms`] : [])
	]);
	if (failures.length) {
		console.error(`\nlighthouse: thresholds missed:\n  - ${failures.join('\n  - ')}`);
		process.exit(1);
	}
	console.log('\nlighthouse: all thresholds met');
}
