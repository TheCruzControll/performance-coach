/**
 * The repository secrets scan on a throwaway git repository: every format is found in the tree
 * and in a deleted file's history and masked in the report; placeholders, public hashes and
 * binary files are not reported; the allowlist matches by fingerprint only; --history follows
 * HEAD and --refs all every branch on origin. The secrets are assembled from parts, so this file
 * holds none for the real scan to find.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	findSecrets,
	fingerprint,
	KNOWN_PLACEHOLDERS,
	SECRET_FORMATS
} from './secrets-patterns.ts';
import { ALLOWLIST_FILE, parseMode, report, runScan } from './secrets-scan.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts/secrets-scan.ts');
const join = (...parts: string[]) => parts.join('');

/** One made-up credential per format, keyed by format id, each with the value its finding has. */
const SECRETS: Record<string, { line: string; value: string }> = {
	anthropic: { line: '', value: join('sk-ant-', 'admin01-', 'Qm7vT2xLp9WcR4nB8kZ3dF6h') },
	resend: { line: '', value: join('re_', 'Ab12Cd34', '_', 'Xy98Wv76Ut54Sr32Qp10Mn') },
	'vercel-blob': { line: '', value: join('vercel_blob_', 'rw_', 'St0re1d', '_', 'S3cr3tV4lu3xyz') },
	neon: { line: '', value: join('npg_', 'aB3dE5gH7jK9') },
	pem: {
		line: join(
			'-----BEGIN ',
			'RSA PRIVATE KEY-----\n',
			'MIIEowIBAAKCAQEA7xQ2\n-----END RSA PRIVATE KEY-----'
		),
		value: join('-----BEGIN ', 'RSA PRIVATE KEY-----\n', 'MIIEowIBAAKCAQEA7xQ2')
	},
	bearer: { line: '', value: join('eyJhbGciOiJIUzI1NiJ9', 'abcdef123') },
	'postgres-url': { line: '', value: join('owner:Hx7', 'qP2vLm9') },
	assigned: { line: '', value: join('9f8e7d6c5b4a3928', '1706f5e4d3c2b1a0') }
};
SECRETS.anthropic!.line = `const key = '${SECRETS.anthropic!.value}';`;
SECRETS.resend!.line = `send(' ${SECRETS.resend!.value}')`;
SECRETS['vercel-blob']!.line = `token: "${SECRETS['vercel-blob']!.value}"`;
SECRETS.neon!.line = `password=${SECRETS.neon!.value}`;
SECRETS.bearer!.line = `Authorization: Bearer ${SECRETS.bearer!.value}`;
SECRETS['postgres-url']!.line =
	`postgres://${SECRETS['postgres-url']!.value}@ep-x.neon.tech/neondb`;
SECRETS.assigned!.line = join('CRON_', 'SECRET=', SECRETS.assigned!.value);
const SECRET_FILE = Object.values(SECRETS)
	.map((s) => s.line)
	.join('\n');
const label = (id: string) => SECRET_FORMATS.find((f) => f.id === id)!.label;

let repo: string;
let origin: string;
const git = (...args: string[]) =>
	execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
function commit(file: string, content: string | Buffer | null, message = `change ${file}`) {
	if (content === null) git('rm', '-q', file);
	else {
		mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
		writeFileSync(path.join(repo, file), content);
		git('add', file);
	}
	git('commit', '-q', '--allow-empty', '-m', message);
	return git('rev-parse', 'HEAD').slice(0, 12);
}
const allowlist = (entries: { fingerprint: string; path: string; reason: string }[]) =>
	writeFileSync(path.join(repo, ALLOWLIST_FILE), JSON.stringify({ entries }));

beforeEach(() => {
	repo = mkdtempSync(path.join(tmpdir(), 'coach-secrets-'));
	origin = mkdtempSync(path.join(tmpdir(), 'coach-secrets-origin-'));
	git('init', '-q', '-b', 'main');
	for (const [key, value] of [
		['user.name', 'Test'],
		['user.email', 'test@example.test'],
		['commit.gpgsign', 'false'],
		['core.hooksPath', '.git/no-hooks']
	]) {
		git('config', key!, value!);
	}
	commit('README.md', 'hello\n', 'root');
});

afterEach(() => {
	rmSync(repo, { recursive: true, force: true });
	rmSync(origin, { recursive: true, force: true });
});

describe('secrets scan', () => {
	it('finds each format in a file and in a deleted file’s history, and masks it', async () => {
		const added = commit('src/config.ts', `${SECRET_FILE}\n`);
		const ids = Object.keys(SECRETS);
		expect([...ids].sort()).toEqual(SECRET_FORMATS.map((f) => f.id).sort());

		const tree = await runScan(repo, 'tree');
		expect(tree.findings.map((f) => f.label)).toEqual(ids.map(label));
		expect(tree.findings.map((f) => f.fingerprint)).toEqual(
			ids.map((id) => fingerprint(SECRETS[id]!.value))
		);
		expect(tree.findings.find((f) => f.label === label('bearer'))).toMatchObject({
			path: 'src/config.ts',
			line: 8
		});

		commit('src/config.ts', null);
		expect((await runScan(repo, 'tree')).findings).toEqual([]);
		const history = await runScan(repo, 'history');
		expect(history.findings.map((f) => f.label).sort()).toEqual(ids.map(label).sort());
		expect(new Set(history.findings.map((f) => f.commit))).toEqual(new Set([added]));
		expect(history.commits).toBe(3);

		const text = report(history);
		for (const { value } of Object.values(SECRETS)) {
			expect(text).not.toContain(value);
			expect(text).not.toContain(value.slice(0, 12));
		}
		expect(text).toContain('rotate it at its provider');
		expect(text).toMatch(/sk-ant… \(\d+ chars\)/);
	});

	it('reports no placeholder, nor exercises_measure_ck, which would match without the exemption', async () => {
		const lines = [
			'DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres',
			'DATABASE_URL=postgres://coach:coach@localhost:5432/coach_dev',
			'DATABASE_URL=postgres://coach_app:coach_app@localhost:5432/coach_dev',
			"resetTarget('postgres://u:p@pooler/neondb')",
			"'postgres://user:pass@ep-xxx.region.aws.neon.tech/neondb'",
			"'postgresql://neondb_owner:p%40ss@ep-x-pooler.neon.tech/neondb'",
			'# RESEND_API_KEY=re_example_not_a_real_key',
			`const KEY = '${KNOWN_PLACEHOLDERS.find((p) => p.value.startsWith('sk-ant'))!.value}';`,
			'RESEND_API_KEY=re_e2e_canary_3fa9c2d17b8e4f60a5d2'
		];
		const text = lines.join('\n');
		for (const p of KNOWN_PLACEHOLDERS) expect(text).toContain(p.value);
		expect(findSecrets(text, SECRET_FORMATS, { placeholders: false })).toHaveLength(lines.length);

		commit(
			'fixtures.ts',
			`${text}\nCONSTRAINT "exercises_measure_ck" CHECK (measure in ('reps'))\n`
		);
		expect((await runScan(repo, 'tree')).findings).toEqual([]);
		expect((await runScan(repo, 'history')).findings).toEqual([]);
	});

	it('matches the allowlist by fingerprint only, and fails a stale fingerprint in history', async () => {
		const value = SECRETS.neon!.value;
		commit('a.ts', `${SECRETS.neon!.line}\n`);
		allowlist([{ fingerprint: fingerprint(value), path: 'somewhere-else.ts', reason: 'fixture' }]);
		expect(await runScan(repo, 'tree')).toMatchObject({ findings: [], allowed: 1, stale: [] });

		allowlist([{ fingerprint: fingerprint(`${value}x`), path: 'a.ts', reason: 'fixture' }]);
		const tree = await runScan(repo, 'tree');
		expect(tree.findings.map((f) => f.path)).toEqual(['a.ts']);
		expect(tree.stale).toEqual([]);
		const history = await runScan(repo, 'history');
		expect(history.findings).toHaveLength(1);
		expect(history.stale.map((e) => e.fingerprint)).toEqual([fingerprint(`${value}x`)]);
		expect(report(history)).toContain('stale allowlist entry');
	});

	it('ignores fonts, SRI hashes, git SHAs and UUIDs', async () => {
		const font = Buffer.concat([
			Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]),
			Buffer.from(SECRETS.anthropic!.line)
		]);
		commit('static/fonts/mona.woff2', font);
		const hashes = [
			'<link rel="stylesheet" integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC">',
			"ASSET_INTEGRITY_TOKEN: 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC'",
			'PINNED_COMMIT_TOKEN=3e44127eaf90f0c0e1d2c3b4a5968778695a4b3c',
			"SESSION_TOKEN: '7f9c2ba4-e88f-4a7b-9d1e-0c5f3b2a6d84'"
		];
		commit('hashes.ts', `${hashes.join('\n')}\n`);
		expect((await runScan(repo, 'tree')).findings).toEqual([]);
		expect((await runScan(repo, 'history')).findings).toEqual([]);
		// The same values under a secret name would be flagged were they not public hashes.
		expect(findSecrets(`CRON_SECRET=${'3e44127eaf90f0c0e1d2c3b4a5968778695a4b3c'}9`)).toHaveLength(
			1
		);
	});

	it('scans only HEAD with --history, and every origin branch with --refs all', async () => {
		git('checkout', '-q', '-b', 'other');
		const leaked = commit('leak.ts', `${SECRETS.resend!.line}\n`);
		git('checkout', '-q', 'main');
		commit('main.ts', 'export const x = 1;\n');

		expect((await runScan(repo, 'history')).findings).toEqual([]);
		await expect(runScan(repo, 'refs')).rejects.toThrow(/fetch origin first/);

		execFileSync('git', ['init', '-q', '--bare', origin]);
		git('remote', 'add', 'origin', origin);
		git('push', '-q', 'origin', 'main', 'other');
		git('fetch', '-q', 'origin');
		const refs = await runScan(repo, 'refs');
		expect(refs.refs.sort()).toEqual(['refs/remotes/origin/main', 'refs/remotes/origin/other']);
		expect(refs.commits).toBe(3);
		expect(refs.findings).toMatchObject([
			{ label: label('resend'), path: 'leak.ts', line: 1, commit: leaked }
		]);
	});

	it('finds a credential added in a merge commit and deleted afterwards', async () => {
		git('checkout', '-q', '-b', 'side');
		commit('side.ts', 'export const y = 2;\n');
		git('checkout', '-q', 'main');
		commit('main.ts', 'export const x = 1;\n');
		git('merge', '-q', '--no-ff', '--no-commit', 'side');
		const merge = commit('merge.ts', `${SECRETS.neon!.line}\n`, 'merge side');
		commit('merge.ts', null);
		execFileSync('git', ['init', '-q', '--bare', origin]);
		git('remote', 'add', 'origin', origin);
		git('push', '-q', 'origin', 'main');
		git('fetch', '-q', 'origin');

		for (const mode of ['history', 'refs'] as const) {
			expect((await runScan(repo, mode)).findings).toMatchObject([
				{ label: label('neon'), path: 'merge.ts', line: 1, commit: merge }
			]);
		}
	});

	it('runs as a command that fails on a finding and passes a clean repository', () => {
		const run = (...args: string[]) =>
			spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: 'utf8' });
		const clean = run('--history');
		expect(clean.status).toBe(0);
		expect(clean.stdout).toContain('Secrets scan (history): 1 commits on 1 ref; 0 findings');

		commit('a.ts', `${SECRETS['vercel-blob']!.line}\n`);
		const dirty = run();
		expect(dirty.status).toBe(1);
		expect(dirty.stdout).toContain(`a.ts:1: ${label('vercel-blob')}`);
		expect(dirty.stdout).not.toContain(SECRETS['vercel-blob']!.value);
		expect(run('--refs').status).not.toBe(0);
		expect(() => parseMode(['--all'])).toThrow(/Usage/);
	});
});

describe('CI', () => {
	it('scans the tree and the full history in the lint job', () => {
		const ci = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
		const quality = ci.slice(ci.indexOf('  quality:'), ci.indexOf('\n  test:'));
		expect(quality).toMatch(/actions\/checkout@\S+\n\s+with:\n(?:\s+#.*\n)*\s+fetch-depth: 0/);
		expect(quality).toContain('run: pnpm security:scan\n');
		expect(quality).toContain('run: pnpm security:scan --history\n');
	});
});
