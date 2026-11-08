/**
 * Security headers on prerendered pages (docs/deployment.md). A prerendered page is a static
 * file: Vercel serves it without running hooks.server.ts, so vercel.json must send it
 * STATIC_PAGE_HEADERS, the hooks' SECURITY_HEADERS plus the `frame-ancestors` that a <meta> CSP
 * cannot carry. The pages are found in src/routes, so neither a new prerendered page nor a header
 * added to SECURITY_HEADERS can be left out of vercel.json, or out of the post-deploy smoke check
 * that asserts them in production.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SECURITY_HEADERS, STATIC_PAGE_HEADERS } from '#lib/server/security-headers.ts';

interface HeaderRule {
	source: string;
	headers: { key: string; value: string }[];
}

const root = new URL('../', import.meta.url);
const routesDir = fileURLToPath(new URL('src/routes', root));
const vercelRules = (
	JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8')) as { headers?: HeaderRule[] }
).headers;
const smoke = readFileSync(new URL('.github/workflows/post-deploy-smoke.yml', root), 'utf8');

const ROUTE_MODULE = /^\+(page|layout)(\.server)?\.[jt]s$/;
const PRERENDER = /^export\s+const\s+prerender\s*=\s*(?:true|'auto'|"auto")/m;

/**
 * The URL path of every prerendered page under `dir`: a page whose own module, or a layout above
 * it, sets `prerender`. Route groups are not part of the path.
 */
function prerenderedPages(dir: string, base = dir, inherited = false): string[] {
	const entries = readdirSync(dir, { withFileTypes: true });
	const sets = (kind: 'page' | 'layout') =>
		entries.some(
			(entry) =>
				entry.isFile() &&
				ROUTE_MODULE.exec(entry.name)?.[1] === kind &&
				PRERENDER.test(readFileSync(path.join(dir, entry.name), 'utf8'))
		);
	const prerendered = inherited || sets('layout');
	const isPage = entries.some((entry) => entry.isFile() && entry.name.startsWith('+page.'));
	const own = isPage && (prerendered || sets('page')) ? [urlPath(base, dir)] : [];
	const below = entries
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) => prerenderedPages(path.join(dir, entry.name), base, prerendered));
	return [...own, ...below].sort();
}

function urlPath(base: string, dir: string): string {
	const segments = path
		.relative(base, dir)
		.split(path.sep)
		.filter((segment) => segment !== '' && !/^\(.+\)$/.test(segment));
	if (segments.some((segment) => segment.includes('['))) {
		throw new Error(`${dir}: a prerendered page with parameters needs each of its paths listed`);
	}
	return `/${segments.join('/')}`;
}

/** Every way vercel.json's header rules fail to send `expected` on each of `pages`. */
function headerProblems(
	pages: string[],
	rules: HeaderRule[] = [],
	expected: Readonly<Record<string, string>>
): string[] {
	const problems = rules
		.filter((rule) => !/^\/(?:[\w.-]+(?:\/[\w.-]+)*)?$/.test(rule.source))
		.map((rule) => `"${rule.source}": not a literal path, so no check can tell what it covers`);
	for (const page of pages) {
		const matching = rules.filter((rule) => rule.source === page);
		if (matching.length === 0) {
			problems.push(`${page}: no headers rule in vercel.json`);
			continue;
		}
		const sent = new Map<string, string>();
		for (const { key, value } of matching.flatMap((rule) => rule.headers)) {
			if (sent.has(key.toLowerCase())) problems.push(`${page}: ${key} is sent twice`);
			sent.set(key.toLowerCase(), value);
		}
		for (const [key, value] of Object.entries(expected)) {
			const got = sent.get(key);
			if (got === undefined) problems.push(`${page}: ${key} is missing (want "${value}")`);
			else if (got !== value) problems.push(`${page}: ${key} is "${got}", want "${value}"`);
		}
		for (const key of sent.keys()) {
			if (!(key in expected)) problems.push(`${page}: ${key} is not in STATIC_PAGE_HEADERS`);
		}
	}
	return problems;
}

describe('security headers on prerendered pages', () => {
	const pages = prerenderedPages(routesDir);

	it('are every dynamic security header plus frame-ancestors', () => {
		expect(STATIC_PAGE_HEADERS).toEqual({
			...SECURITY_HEADERS,
			'content-security-policy': "frame-ancestors 'none'"
		});
	});

	it('are sent from vercel.json on every prerendered page', () => {
		expect(pages).toContain('/offline');
		expect(pages).toContain('/workout/run');
		expect(headerProblems(pages, vercelRules, STATIC_PAGE_HEADERS)).toEqual([]);
	});

	it('are asserted by the post-deploy smoke check on every prerendered page', () => {
		const listed = /^\s*prerendered_pages="([^"]*)"$/m.exec(smoke)?.[1] ?? '';
		expect(listed.split(/\s+/).filter(Boolean).sort()).toEqual(pages);

		const block = /<<'STATIC_PAGE_HEADERS'\n([\s\S]*?)\n\s*STATIC_PAGE_HEADERS\n/.exec(smoke);
		const lines = (block?.[1] ?? '').split('\n').map((line) => line.trim());
		const expected = Object.fromEntries(
			lines.map((line) => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)])
		);
		expect(expected).toEqual(STATIC_PAGE_HEADERS);
	});
});

describe('the prerendered-page check', () => {
	let planted: string | undefined;
	afterEach(() => {
		if (planted) rmSync(planted, { recursive: true, force: true });
		planted = undefined;
	});

	function plant(files: Record<string, string>): string {
		planted = mkdtempSync(path.join(tmpdir(), 'vercel-headers-'));
		for (const [file, source] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(planted, file)), { recursive: true });
			writeFileSync(path.join(planted, file), source);
		}
		return planted;
	}

	const offlineRule: HeaderRule = {
		source: '/offline',
		headers: Object.entries(STATIC_PAGE_HEADERS).map(([key, value]) => ({ key, value }))
	};

	it('finds pages prerendered by their own module or by a layout, outside route groups', () => {
		const dir = plant({
			'+page.svelte': '',
			'(app)/offline/+page.ts': 'export const prerender = true;\n',
			'(app)/offline/+page.svelte': '',
			'(app)/today/+page.server.ts': 'export const load = () => ({ prerender: true });\n',
			'(app)/today/+page.svelte': '',
			'guide/+layout.ts': "export const prerender = 'auto';\n",
			'guide/+page.svelte': '',
			'guide/(steps)/start/+page.svelte': ''
		});
		expect(prerenderedPages(dir)).toEqual(['/guide', '/guide/start', '/offline']);
	});

	it('refuses a prerendered page with parameters, whose paths it cannot list', () => {
		const dir = plant({ '[slug]/+page.ts': 'export const prerender = true;\n' });
		expect(() => prerenderedPages(dir)).toThrow(/needs each of its paths listed/);
	});

	it('fails a planted prerendered page that has no rule', () => {
		const dir = plant({
			'(app)/offline/+page.ts': 'export const prerender = true;\n',
			'workout/+page.ts': 'export const prerender = true;\n'
		});
		expect(headerProblems(prerenderedPages(dir), [offlineRule], STATIC_PAGE_HEADERS)).toEqual([
			'/workout: no headers rule in vercel.json'
		]);
	});

	it('fails a header added to SECURITY_HEADERS but not to vercel.json', () => {
		const grown = { ...STATIC_PAGE_HEADERS, 'x-planted-header': 'on' };
		expect(headerProblems(['/offline'], [offlineRule], grown)).toEqual([
			'/offline: x-planted-header is missing (want "on")'
		]);
	});

	it('fails a changed, repeated or extra header and a pattern source', () => {
		const rules: HeaderRule[] = [
			{
				source: '/offline',
				headers: offlineRule.headers.map((header) =>
					header.key === 'x-frame-options' ? { ...header, value: 'SAMEORIGIN' } : header
				)
			},
			{
				source: '/offline',
				headers: [
					{ key: 'X-Robots-Tag', value: 'noindex, nofollow' },
					{ key: 'x-powered-by', value: 'coach' }
				]
			},
			{ source: '/(.*)', headers: [{ key: 'x-dns-prefetch-control', value: 'off' }] }
		];
		expect(headerProblems(['/offline'], rules, STATIC_PAGE_HEADERS)).toEqual([
			'"/(.*)": not a literal path, so no check can tell what it covers',
			'/offline: X-Robots-Tag is sent twice',
			'/offline: x-frame-options is "SAMEORIGIN", want "DENY"',
			'/offline: x-powered-by is not in STATIC_PAGE_HEADERS'
		]);
	});
});
