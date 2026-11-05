/**
 * Lighthouse (mobile emulation, simulated slow 4G + 4× CPU) against the local production Node
 * server, using the preinstalled Playwright Chromium. Reports go to ./lighthouse-reports.
 *
 *   pnpm build:node && pnpm lighthouse
 *   pnpm lighthouse --runs 5 --routes /,/today
 *   pnpm lighthouse --url https://preview.example.com   # audit an already-running server
 *   pnpm lighthouse --assert                            # exit 1 when a threshold is missed
 *
 * The local server uses E2E_DATABASE_URL (default: local coach_e2e) after applying migrations.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { LOCAL_DATABASE_URLS, runMigrations } from '../src/lib/server/db/migrate.ts';

const { values } = parseArgs({
	options: {
		url: { type: 'string' },
		routes: { type: 'string', default: '/,/today,/train' },
		runs: { type: 'string', default: '3' },
		port: { type: 'string', default: '4174' },
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

async function startServer(): Promise<{ base: string; stop: () => void }> {
	if (!existsSync('build/index.js')) {
		throw new Error('No Node build found. Run `pnpm build:node` first.');
	}
	const db = process.env.E2E_DATABASE_URL || LOCAL_DATABASE_URLS.e2e;
	await runMigrations(db);
	const base = `http://localhost:${values.port}`;
	const server = spawn(process.execPath, ['build/index.js'], {
		stdio: 'ignore',
		env: {
			...process.env,
			NODE_ENV: 'production',
			APP_ENV: 'test',
			PORT: values.port,
			ORIGIN: base,
			DATABASE_URL: db,
			LOG_LEVEL: 'warn'
		}
	});
	await waitForHealth(base, server);
	return { base, stop: () => server.kill('SIGTERM') };
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const server = values.url
	? { base: values.url.replace(/\/$/, ''), stop: () => {} }
	: await startServer();
const chromePath = process.env.LIGHTHOUSE_CHROME_PATH || chromium.executablePath();
const chrome = await chromeLauncher.launch({
	chromePath,
	chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
});

mkdirSync(OUT_DIR, { recursive: true });
const chromeVersion = await fetch(`http://127.0.0.1:${chrome.port}/json/version`)
	.then((r) => r.json() as Promise<{ Browser: string }>)
	.then((v) => v.Browser)
	.catch(() => 'Chromium');
let lighthouseVersion = '';
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
			const result = await lighthouse(`${server.base}${route}`, {
				port: chrome.port,
				output: ['json', 'html'],
				logLevel: 'error',
				onlyCategories: (
					process.env.LH_CATEGORIES ?? 'performance,accessibility,best-practices'
				).split(',')
			});
			if (!result) throw new Error(`Lighthouse returned no result for ${route}`);
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
			const name = `${route === '/' ? 'landing' : route.replace(/^\//, '').replace(/\//g, '-')}-run${i + 1}`;
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
