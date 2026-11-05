/**
 * Lighthouse (mobile emulation, simulated slow 4G + 4× CPU) against the local production Node
 * server, using the preinstalled Playwright Chromium. Reports go to ./lighthouse-reports.
 *
 *   ORIGIN=http://localhost:4174 pnpm build:node && pnpm lighthouse   # every screen, 3 runs
 *   pnpm lighthouse --runs 5 --routes /,/today
 *   pnpm lighthouse --url https://preview.example.com   # audit an already-running server
 *   pnpm lighthouse --assert                            # exit 1 when a threshold is missed
 *
 * The local server uses E2E_DATABASE_URL (default: local coach_e2e) after applying migrations.
 *
 * Every app screen needs a session (deny by default), so the script mints one for the owner
 * directly in that disposable database (a placeholder owner if setup never ran) and sends its
 * cookie with every request; `/` (the sign-in screen) is audited signed out. Against an external
 * server (--url) pass a session cookie value in LIGHTHOUSE_SESSION, or only `/` is meaningful.
 * Build the Node server with ORIGIN=http://localhost:<port> so it knows it is served over HTTP.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse, { type RunnerResult } from 'lighthouse';
import pg from 'pg';
import { LOCAL_DATABASE_URLS, runMigrations } from '../src/lib/server/db/migrate.ts';

const { values } = parseArgs({
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
		assert: { type: 'boolean', default: false },
		'min-perf': { type: 'string', default: '0.9' },
		'max-lcp': { type: 'string', default: '2500' },
		'max-cls': { type: 'string', default: '0.1' },
		'max-tbt': { type: 'string', default: '200' }
	}
});

/**
 * Thresholds checked with --assert (Lighthouse mobile, simulated throttling). Defaults are the
 * documented targets (docs/performance.md); CI may pass slightly looser values as a
 * regression guard because shared runners add CPU noise to TBT.
 */
const THRESHOLDS = {
	performance: Number(values['min-perf']),
	lcpMs: Number(values['max-lcp']),
	cls: Number(values['max-cls']),
	tbtMs: Number(values['max-tbt'])
};
const OUT_DIR = 'lighthouse-reports';
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
async function mintSession(db: string): Promise<string> {
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
		return token;
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

async function startServer(): Promise<{ base: string; stop: () => void; session: string }> {
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
			LOG_LEVEL: 'warn'
		}
	});
	await waitForHealth(base, server);
	return { base, stop: () => server.kill('SIGTERM'), session: await mintSession(db) };
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
			session: process.env.LIGHTHOUSE_SESSION ?? ''
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
async function auditOnce(url: string, attempt = 1): Promise<NonNullable<RunnerResult>> {
	await chrome.kill();
	chrome = await launchChrome();
	const signedIn = new URL(url).pathname !== '/';
	const result = await lighthouse(url, {
		port: chrome.port,
		...(signedIn && sessionHeaders ? { extraHeaders: sessionHeaders } : {}),
		output: ['json', 'html'],
		logLevel: 'error',
		onlyCategories: (process.env.LH_CATEGORIES ?? 'performance,accessibility,best-practices').split(
			','
		)
	});
	if (!result) throw new Error(`Lighthouse returned no result for ${url}`);
	const error = result.lhr.runtimeError;
	if (error) {
		if (attempt >= 3) throw new Error(`Lighthouse failed 3 times on ${url}: ${error.code}`);
		console.warn(`lighthouse: ${url} attempt ${attempt} failed (${error.code}); retrying`);
		return auditOnce(url, attempt + 1);
	}
	return result;
}
interface Summary {
	route: string;
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

try {
	for (const route of routes) {
		const results: Summary[] = [];
		for (let i = 0; i < runs; i++) {
			const result = await auditOnce(`${server.base}${route}`);
			const { lhr } = result;
			lighthouseVersion = lhr.lighthouseVersion;
			const audit = (id: string) => lhr.audits[id]?.numericValue ?? Number.NaN;
			results.push({
				route,
				performance: lhr.categories.performance?.score ?? 0,
				accessibility: lhr.categories.accessibility?.score ?? 0,
				bestPractices: lhr.categories['best-practices']?.score ?? 0,
				lcp: audit('largest-contentful-paint'),
				fcp: audit('first-contentful-paint'),
				tbt: audit('total-blocking-time'),
				cls: audit('cumulative-layout-shift'),
				si: audit('speed-index')
			});
			const name = `${route === '/' ? 'sign-in' : route.replace(/^\//, '').replace(/\//g, '-')}-run${i + 1}`;
			const [json, html] = result.report as string[];
			writeFileSync(`${OUT_DIR}/${name}.report.json`, json!);
			writeFileSync(`${OUT_DIR}/${name}.report.html`, html!);
		}
		const pick = (k: keyof Omit<Summary, 'route'>) => median(results.map((r) => r[k]));
		summaries.push({
			route,
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
} finally {
	await chrome.kill();
	server.stop();
}

const lines = [
	`Lighthouse ${lighthouseVersion} (mobile, simulated throttling) — median of ${runs} run(s) per route, ${chromeVersion}`,
	'',
	'| Route | Perf | A11y | Best pr. | LCP | FCP | TBT | CLS | Speed Index |',
	'| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
	...summaries.map(
		(s) =>
			`| \`${s.route}\` | ${Math.round(s.performance * 100)} | ${Math.round(s.accessibility * 100)} | ${Math.round(s.bestPractices * 100)} | ${Math.round(s.lcp)} ms | ${Math.round(s.fcp)} ms | ${Math.round(s.tbt)} ms | ${s.cls.toFixed(3)} | ${Math.round(s.si)} ms |`
	)
];
console.log(lines.join('\n'));
writeFileSync(
	`${OUT_DIR}/summary.json`,
	JSON.stringify({ runs, thresholds: THRESHOLDS, summaries }, null, 2)
);
if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Lighthouse\n\n${lines.join('\n')}\n`);
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
