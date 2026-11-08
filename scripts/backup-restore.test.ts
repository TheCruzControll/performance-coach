/**
 * `pnpm backup:restore`, spawned as an operator runs it (plain Node, no .env, stdin a pipe), so
 * every refusal is proven to come before any connection, request or write, and the key never
 * reaches the output. The Blob source's request rules (https on the token's private host only,
 * no redirect, a size cap) are pinned in process with an injected fetch.
 * tests/integration/backup/restore-cli.test.ts restores real backups through it.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchiveWriter } from '../src/lib/server/backup/archive';
import { sealStream } from '../src/lib/server/backup/envelope';
import { parseBackupKey } from '../src/lib/server/backup/key';
import { forceAllowed, timingTable } from './backup-restore';
import { parseSource, readSource, SourceError, type BackupSource } from './backup/source';
import { Refusal } from './backup/cli-support';

const root = fileURLToPath(new URL('../', import.meta.url));
const TIMEOUT = 30_000;
const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');
const TOKEN = 'vercel_blob_rw_AbCdEf123_secretpart456';
const HOST = 'abcdef123.private.blob.vercel-storage.com';
const BLOB_URL = `https://${HOST}/backups/2026/11/07/coach-20261107T104100Z.pcbk`;
/** Port 1 refuses connections, so a command that tried to connect would say so. */
const LOCAL = 'postgres://coach:s3cret-pass@127.0.0.1:1/scratch_restore';
const REMOTE = 'postgres://coach:s3cret-pass@ep-x.example.com:1/neondb';

/** Fails any network request the child makes, and says so on stderr. */
const FETCH_TRAP =
	'data:text/javascript,globalThis.fetch = async () => { process.stderr.write("FETCH SENT\\n"); throw new Error("no network"); };';
/** Answers every request with a redirect, naming what it was asked for (never the token). */
const FETCH_REDIRECT =
	'data:text/javascript,globalThis.fetch = async (url, init) => { process.stderr.write(`FETCH ${url} redirect=${init.redirect} bearer=${String(init.headers.authorization).startsWith("Bearer ")}\\n`); return new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }); };';

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(path.join(tmpdir(), 'coach-backup-restore-'));
});

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

function restore(args: string[], env: Record<string, string> = {}, fetchStub = FETCH_TRAP) {
	const result = spawnSync(
		process.execPath,
		['--import', fetchStub, path.join(root, 'scripts/backup-restore.ts'), ...args],
		{
			cwd: root,
			env: { PATH: process.env.PATH ?? '', ...env },
			input: '',
			encoding: 'utf8',
			timeout: 20_000
		}
	);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Nothing was requested, connected or printed that should not be. */
function untouched(result: ReturnType<typeof restore>) {
	const output = `${result.stdout}${result.stderr}`;
	expect(result.stderr).not.toContain('FETCH SENT');
	expect(output).not.toMatch(/ECONNREFUSED|unreachable|State:/);
	for (const secret of ['s3cret-pass', KEY, OTHER_KEY, 'secretpart456']) {
		expect(output).not.toContain(secret);
	}
}

/** A sealed backup under KEY whose one migration is no migration of this checkout. */
async function foreignBackup(): Promise<string> {
	const writer = new ArchiveWriter();
	const sealed = buffer(writer.output.pipe(sealStream(parseBackupKey(KEY, 'key'))));
	const hash = 'a'.repeat(64);
	writer.header({
		kind: 'header',
		format: 'performance-coach-backup',
		formatVersion: 1,
		createdAt: '2026-11-07T10:41:00.000Z',
		appVersion: '0.1.0',
		schema: { migrations: [{ hash, createdAt: 1 }], count: 1, lastHash: hash },
		settings: {
			TimeZone: 'UTC',
			DateStyle: 'ISO, YMD',
			IntervalStyle: 'postgres',
			extra_float_digits: '1',
			bytea_output: 'hex'
		},
		tables: [{ name: 'owners', columns: [{ name: 'id', type: 'uuid' }] }],
		excluded: []
	});
	writer.section('owners');
	writer.row('{"id":"7b0c1a52-55a3-4f43-9a35-6b1f0f6d8e21"}');
	writer.sequences([]);
	writer.finish();
	const file = path.join(scratch, 'foreign.pcbk');
	await writeFile(file, await sealed);
	return file;
}

describe('backup:restore usage', () => {
	it(
		'prints its usage for --help under plain Node',
		() => {
			const result = restore(['--help']);
			expect(result.stderr).toBe('');
			expect(result.status).toBe(0);
			expect(result.stdout).toMatch(/^Usage: .*pnpm backup:restore <file \| https-url> --target/);
		},
		TIMEOUT
	);

	it(
		'refuses an unknown flag, no backup, two backups, no --target or a target that is not a database',
		() => {
			const env = { BACKUP_ENCRYPTION_KEY: KEY };
			const cases: [string[], RegExp][] = [
				[['b.pcbk', '--target', LOCAL, '--nope'], /Unknown option '--nope'[\s\S]*Usage:/],
				[['--target', LOCAL, '--yes'], /Name exactly one backup/],
				[['a.pcbk', 'b.pcbk', '--target', LOCAL, '--yes'], /Name exactly one backup/],
				[['b.pcbk', '--yes'], /Name the database with --target <url>/],
				[
					['b.pcbk', '--target', 'https://u:s3cret-pass@db.example.com/x', '--yes'],
					/--target must be a postgres:\/\/ URL/
				]
			];
			for (const [args, message] of cases) {
				const result = restore(args, env);
				expect(result.status, args.join(' ')).toBe(2);
				expect(result.stderr).toMatch(message);
				untouched(result);
			}
		},
		TIMEOUT
	);

	it(
		'takes the key from BACKUP_ENCRYPTION_KEY or --key-file only, one of them, never echoed',
		async () => {
			const file = path.join(scratch, 'b.pcbk');
			const keyFile = path.join(scratch, 'key.txt');
			await writeFile(keyFile, `${OTHER_KEY}\n`);
			const args = [file, '--target', LOCAL, '--yes'];

			const missing = restore(args);
			expect(missing.status).toBe(2);
			expect(missing.stderr).toContain('set BACKUP_ENCRYPTION_KEY or pass --key-file <file>');
			untouched(missing);

			const both = restore([...args, '--key-file', keyFile], { BACKUP_ENCRYPTION_KEY: KEY });
			expect(both.status).toBe(2);
			expect(both.stderr).toContain('choose one key, BACKUP_ENCRYPTION_KEY or --key-file');
			untouched(both);

			const invalid = restore(args, { BACKUP_ENCRYPTION_KEY: KEY.slice(0, 20) });
			expect(invalid.status).toBe(2);
			expect(invalid.stderr).toContain('BACKUP_ENCRYPTION_KEY must be 32 bytes');
			expect(invalid.stderr).not.toContain(KEY.slice(0, 20));
			untouched(invalid);

			const unreadable = restore([...args, '--key-file', path.join(scratch, 'none')]);
			expect(unreadable.status).toBe(2);
			expect(unreadable.stderr).toContain('cannot read --key-file');
			untouched(unreadable);
		},
		TIMEOUT
	);
});

describe('backup:restore confirmation and --force', () => {
	const env = { BACKUP_ENCRYPTION_KEY: KEY };

	it(
		'refuses a run without --yes outside a terminal, remote or local, before reading the backup',
		async () => {
			const file = await foreignBackup();
			for (const target of [REMOTE, LOCAL]) {
				const result = restore([file, '--target', target], env);
				expect(result.status, target).toBe(2);
				expect(result.stderr).toContain('Refusing to run non-interactively');
				expect(result.stdout).not.toContain('Backup:');
				untouched(result);
			}
		},
		TIMEOUT
	);

	it(
		'refuses --yes on a remote host',
		async () => {
			const result = restore([await foreignBackup(), '--target', REMOTE, '--yes'], env);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('Refusing --yes for ep-x.example.com');
			expect(result.stdout).not.toContain('Backup:');
			untouched(result);
		},
		TIMEOUT
	);

	it(
		'refuses --force on neondb, postgres or any other non-scratch name',
		async () => {
			const file = await foreignBackup();
			for (const name of ['neondb', 'postgres', 'coach_dev']) {
				const target = LOCAL.replace('scratch_restore', name);
				const result = restore([file, '--target', target, '--yes', '--force'], env);
				expect(result.status, name).toBe(2);
				expect(result.stderr).toContain(`Refusing --force on ${name}`);
				untouched(result);
			}
		},
		TIMEOUT
	);

	it('allows --force only on the scratch names', () => {
		const allowed = [
			'scratch_a',
			'restore_drill',
			'drill_20261107',
			'coach_backup_dst_test',
			`scratch_${'a'.repeat(40)}`
		];
		const refused = [
			'neondb',
			'postgres',
			'coach_dev',
			'scratch_',
			'Scratch_a',
			'drill-1',
			`scratch_${'a'.repeat(41)}`,
			'test',
			'_test',
			'coach_test_copy'
		];
		expect(allowed.filter(forceAllowed)).toEqual(allowed);
		expect(refused.filter(forceAllowed)).toEqual([]);
	});
});

describe('backup:restore sources', () => {
	const env = { BACKUP_ENCRYPTION_KEY: KEY, BLOB_READ_WRITE_TOKEN: TOKEN };

	it(
		'refuses http, another host, a look-alike host, a port, credentials or no token before any request',
		() => {
			const cases: [string, Record<string, string>, string][] = [
				[BLOB_URL.replace('https:', 'http:'), env, 'Refusing to download over http:'],
				['https://evil.example/backups/x.pcbk', env, 'Refusing to download from evil.example'],
				[`https://${HOST}.evil.example/x.pcbk`, env, 'Refusing to download from'],
				[`https://${HOST}:8443/x.pcbk`, env, 'Refusing to download from'],
				[`https://u:p@${HOST}/x.pcbk`, env, 'Refusing to download from'],
				[
					BLOB_URL,
					{ BACKUP_ENCRYPTION_KEY: KEY },
					'Refusing to download: set BLOB_READ_WRITE_TOKEN'
				]
			];
			for (const [url, variables, message] of cases) {
				const result = restore([url, '--target', LOCAL, '--yes'], variables);
				expect(result.status, url).toBe(2);
				expect(result.stderr).toContain(message);
				untouched(result);
			}
		},
		TIMEOUT
	);

	it(
		'asks the private host for the object without following its redirect, and exits 3',
		() => {
			const result = restore([BLOB_URL, '--target', LOCAL, '--yes'], env, FETCH_REDIRECT);
			expect(result.status).toBe(3);
			expect(result.stderr).toContain(`FETCH ${BLOB_URL} redirect=error bearer=true`);
			expect(result.stderr).toContain('Backup refused (redirected)');
			untouched(result);
		},
		TIMEOUT
	);

	it(
		'refuses a file sealed with another key, or a backup this checkout cannot rebuild, before connecting',
		async () => {
			const file = await foreignBackup();
			const keyFile = path.join(scratch, 'key.txt');
			await writeFile(keyFile, OTHER_KEY);

			const wrongKey = restore([file, '--target', LOCAL, '--yes', '--key-file', keyFile]);
			expect(wrongKey.status).toBe(3);
			expect(wrongKey.stderr).toContain('Backup refused (wrong_key)');
			untouched(wrongKey);

			const foreign = restore([file, '--target', LOCAL, '--yes'], { BACKUP_ENCRYPTION_KEY: KEY });
			expect(foreign.status).toBe(3);
			expect(foreign.stdout).toContain('Taken:    2026-11-07T10:41:00.000Z (app 0.1.0)');
			expect(foreign.stdout).toContain(`Key id:   ${parseBackupKey(KEY, 'k').id}`);
			expect(foreign.stderr).toContain('Backup refused (history_diverged)');
			expect(foreign.stdout).not.toContain('Target:');
			untouched(foreign);

			const missing = restore([path.join(scratch, 'none.pcbk'), '--target', LOCAL, '--yes'], {
				BACKUP_ENCRYPTION_KEY: KEY
			});
			expect(missing.status).toBe(3);
			expect(missing.stderr).toContain('Backup refused (unreadable)');
			untouched(missing);
		},
		TIMEOUT
	);
});

describe('readSource', () => {
	const source = parseSource(BLOB_URL, TOKEN) as Extract<BackupSource, { kind: 'blob' }>;

	/** A fetch that answers `response` and records what it was asked. */
	function fake(response: () => Response | Promise<Response>) {
		const calls: { url: string; init: RequestInit }[] = [];
		const fetch = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return response();
		}) as unknown as typeof globalThis.fetch;
		return { fetch, calls };
	}

	const refusal = (promise: Promise<unknown>) =>
		promise.then(
			() => null,
			(error: unknown) => (error instanceof SourceError ? error.code : error)
		);

	it('sends the bearer to the private host only, refusing redirects', async () => {
		const { fetch, calls } = fake(() => new Response(Buffer.from('sealed')));
		expect((await readSource(source, { fetch })).toString()).toBe('sealed');
		expect(calls).toEqual([
			{ url: BLOB_URL, init: { headers: { authorization: `Bearer ${TOKEN}` }, redirect: 'error' } }
		]);
		expect(source).toMatchObject({ kind: 'blob', host: HOST });
	});

	it('refuses a redirect, whether fetch throws on it or answers it', async () => {
		const answered = fake(
			() => new Response(null, { status: 307, headers: { location: 'https://evil.example/' } })
		);
		expect(await refusal(readSource(source, answered))).toBe('redirected');
		const thrown = fake(() => {
			throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
		});
		expect(await refusal(readSource(source, thrown))).toBe('redirected');
		const status = fake(() => new Response('denied', { status: 403 }));
		expect(await refusal(readSource(source, status))).toBe('download_failed');
	});

	it('refuses more than the cap, by its length or as it streams, and a file over it', async () => {
		// Refused by its declared length before a byte of the body is read.
		let pulled = false;
		const body = () =>
			new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						pulled = true;
						controller.enqueue(new Uint8Array(11));
						controller.close();
					}
				},
				{ highWaterMark: 0 }
			);
		const declared = fake(() => new Response(body(), { headers: { 'content-length': '11' } }));
		expect(await refusal(readSource(source, { ...declared, maxBytes: 10 }))).toBe('too_large');
		expect(pulled).toBe(false);
		const streamed = fake(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(6));
							controller.enqueue(new Uint8Array(6));
							controller.close();
						}
					})
				)
		);
		expect(await refusal(readSource(source, { ...streamed, maxBytes: 10 }))).toBe('too_large');
		const file = path.join(scratch, 'big.pcbk');
		await writeFile(file, Buffer.alloc(11));
		expect(await refusal(readSource({ kind: 'file', path: file }, { maxBytes: 10 }))).toBe(
			'too_large'
		);
		expect(await readSource({ kind: 'file', path: file }, { maxBytes: 11 })).toHaveLength(11);
	});

	it('names a URL refusal without the token', () => {
		expect(() => parseSource('ftp://x/y', TOKEN)).toThrow(Refusal);
		expect(() => parseSource(`https://${HOST}/x`, 'not-a-token')).toThrow(
			'BLOB_READ_WRITE_TOKEN is not a read-write token'
		);
		expect(parseSource('relative/b.pcbk', undefined)).toEqual({
			kind: 'file',
			path: path.resolve('relative/b.pcbk')
		});
	});
});

describe('timingTable', () => {
	it('prints each phase in UTC, the skipped ones marked, and the total', () => {
		const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 10, 41, s));
		const table = timingTable(
			[
				{ name: 'download', start: at(0), end: at(1) },
				{ name: 'decrypt and verify', start: at(1), end: at(2) },
				{ name: 'schema', start: at(2), end: at(5) },
				{ name: 'rows and digests', start: at(5), end: at(9) }
			],
			'drill 2026-11-07'
		);
		expect(table.split('\n')).toEqual([
			'Restore timings (UTC): drill 2026-11-07',
			'',
			'| Phase | Started (UTC) | Finished (UTC) | Seconds |',
			'| --- | --- | --- | --- |',
			'| download | 2026-11-07T10:41:00.000Z | 2026-11-07T10:41:01.000Z | 1.00 |',
			'| decrypt and verify | 2026-11-07T10:41:01.000Z | 2026-11-07T10:41:02.000Z | 1.00 |',
			'| schema | 2026-11-07T10:41:02.000Z | 2026-11-07T10:41:05.000Z | 3.00 |',
			'| rows and digests | 2026-11-07T10:41:05.000Z | 2026-11-07T10:41:09.000Z | 4.00 |',
			'| forward migration | skipped | | |',
			'| total | 2026-11-07T10:41:00.000Z | 2026-11-07T10:41:09.000Z | 9.00 |'
		]);
	});
});
