/**
 * The backup operator commands, spawned as `pnpm backup:*` runs them (plain Node, no .env), so
 * every refusal is proven to come before any connection or request, and the shared support's
 * redaction and typed confirmation are pinned. tests/integration/backup/cli.test.ts runs a real
 * backup:run --out against the scratch source.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupPathname } from '../src/lib/domain/backup/pathnames';
import { fileStore } from '../src/lib/server/backup/fs-store';
import { parseBackupKey } from '../src/lib/server/backup/key';
import { confirmTyped, databaseTarget, redactUrl, Refusal } from './backup/cli-support';

const root = fileURLToPath(new URL('../', import.meta.url));
const TIMEOUT = 30_000;
/** Refuses connections, so a command that tried to connect would say ECONNREFUSED. */
const DEAD_URL = 'postgres://coach:s3cret-pass@127.0.0.1:1/neondb';
const KEY = randomBytes(32).toString('base64');
const TOKEN = 'vercel_blob_rw_AbCdEf123_secretpart456';

let scratch: string;

beforeEach(async () => {
	scratch = await mkdtemp(path.join(tmpdir(), 'coach-backup-cli-'));
});

afterEach(async () => {
	await rm(scratch, { recursive: true, force: true });
});

/** Fails any network request the child makes, and says so on stderr. */
const FETCH_TRAP =
	'data:text/javascript,globalThis.fetch = async () => { process.stderr.write("FETCH SENT\\n"); throw new Error("no network"); };';

function command(
	name: 'run' | 'list' | 'keygen',
	args: string[],
	env: Record<string, string> = {},
	{ cwd = root, trapFetch = false } = {}
) {
	const result = spawnSync(
		process.execPath,
		[
			...(trapFetch ? ['--import', FETCH_TRAP] : []),
			path.join(root, `scripts/backup-${name}.ts`),
			...args
		],
		{
			cwd,
			// Only what the test names, as `pnpm backup:*` loads no .env file.
			env: { PATH: process.env.PATH ?? '', ...env },
			input: '',
			encoding: 'utf8',
			timeout: 20_000
		}
	);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('package.json', () => {
	it('runs the three commands with plain Node, after auth:*, without loading .env', async () => {
		const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
			scripts: Record<string, string>;
		};
		const names = Object.keys(pkg.scripts);
		const backups = names.filter((name) => name.startsWith('backup:'));
		expect(backups).toEqual(['backup:run', 'backup:list', 'backup:keygen']);
		expect(names.indexOf('backup:run')).toBe(names.indexOf('auth:reset-owner') + 1);
		for (const name of backups) {
			expect(pkg.scripts[name]).toBe(`node scripts/${name.replace(':', '-')}.ts`);
		}
	});
});

describe('under plain Node', () => {
	it.each(['run', 'list', 'keygen'] as const)(
		'backup:%s loads its imports and prints its usage for --help',
		(name) => {
			const result = command(name, ['--help']);
			expect(result.stderr).toBe('');
			expect(result.status).toBe(0);
			expect(result.stdout).toMatch(new RegExp(`^Usage: .*pnpm backup:${name}`));
		},
		TIMEOUT
	);

	it.each(['run', 'list', 'keygen'] as const)(
		'backup:%s refuses an unknown flag with exit 2',
		(name) => {
			const result = command(name, ['--nope']);
			expect(result.status).toBe(2);
			expect(result.stderr).toMatch(/Unknown option '--nope'[\s\S]*Usage:/);
		},
		TIMEOUT
	);
});

describe('backup:run', () => {
	const noConnection = (result: ReturnType<typeof command>) => {
		expect(result.stderr).not.toMatch(/ECONNREFUSED|Backup failed/);
		expect(`${result.stdout}${result.stderr}`).not.toContain('s3cret-pass');
		expect(`${result.stdout}${result.stderr}`).not.toContain(KEY);
	};

	it(
		'refuses without DATABASE_URL_UNPOOLED, however DATABASE_URL is set',
		() => {
			const out = path.join(scratch, 'b.pcbk');
			const result = command('run', ['--out', out], {
				DATABASE_URL: DEAD_URL,
				BACKUP_ENCRYPTION_KEY: KEY
			});
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('Refusing to run: set DATABASE_URL_UNPOOLED');
			expect(result.stdout).not.toContain('Database:');
			noConnection(result);
		},
		TIMEOUT
	);

	it(
		'refuses without a key, or with an invalid one, before connecting',
		() => {
			const out = path.join(scratch, 'b.pcbk');
			const missing = command('run', ['--out', out], { DATABASE_URL_UNPOOLED: DEAD_URL });
			expect(missing.status).toBe(2);
			expect(missing.stderr).toContain('Refusing to run: set BACKUP_ENCRYPTION_KEY');
			noConnection(missing);

			const invalid = command('run', ['--out', out], {
				DATABASE_URL_UNPOOLED: DEAD_URL,
				BACKUP_ENCRYPTION_KEY: 'c2hvcnQ='
			});
			expect(invalid.status).toBe(2);
			expect(invalid.stderr).toContain('BACKUP_ENCRYPTION_KEY is not valid');
			noConnection(invalid);
		},
		TIMEOUT
	);

	it(
		'refuses both --out and --blob, and neither',
		() => {
			const env = { DATABASE_URL_UNPOOLED: DEAD_URL, BACKUP_ENCRYPTION_KEY: KEY };
			for (const args of [['--out', path.join(scratch, 'b.pcbk'), '--blob'], []]) {
				const result = command('run', args, env);
				expect(result.status, args.join(' ')).toBe(2);
				expect(result.stderr).toContain('Choose exactly one of --out <file> and --blob.');
				noConnection(result);
			}
		},
		TIMEOUT
	);

	it(
		'refuses to overwrite an existing --out file',
		async () => {
			const out = path.join(scratch, 'kept.pcbk');
			await writeFile(out, 'an older backup');
			const result = command('run', ['--out', out], {
				DATABASE_URL_UNPOOLED: DEAD_URL,
				BACKUP_ENCRYPTION_KEY: KEY
			});
			expect(result.status).toBe(2);
			expect(result.stderr).toContain(`Refusing to overwrite ${out}`);
			noConnection(result);
		},
		TIMEOUT
	);

	it(
		'--blob names the redacted database, then refuses without a terminal to confirm in',
		() => {
			const result = command('run', ['--blob'], {
				DATABASE_URL_UNPOOLED: DEAD_URL,
				BACKUP_ENCRYPTION_KEY: KEY,
				BLOB_READ_WRITE_TOKEN: TOKEN
			});
			expect(result.status).toBe(2);
			expect(result.stdout).toContain('Database: postgres://coach:***@127.0.0.1:1/neondb');
			expect(result.stdout).toContain(
				'Into:     Vercel Blob abcdef123.private.blob.vercel-storage.com'
			);
			expect(result.stdout).toContain(`Key id:   ${parseBackupKey(KEY, 'k').id}`);
			expect(result.stderr).toContain('Refusing to run non-interactively');
			expect(result.stdout).not.toContain('secretpart456');
			noConnection(result);
		},
		TIMEOUT
	);

	it(
		'--blob refuses without BLOB_READ_WRITE_TOKEN, even when BACKUP_DIR is set',
		() => {
			const result = command('run', ['--blob'], {
				DATABASE_URL_UNPOOLED: DEAD_URL,
				BACKUP_ENCRYPTION_KEY: KEY,
				BACKUP_DIR: scratch
			});
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('Refusing to run: set BLOB_READ_WRITE_TOKEN');
			noConnection(result);
		},
		TIMEOUT
	);
});

describe('backup:keygen', () => {
	it(
		'prints a valid key and its matching id, different on every run, and writes no file',
		async () => {
			const runs = [1, 2].map(() => command('keygen', [], {}, { cwd: scratch }));
			const printed = runs.map((result) => {
				expect(result.status).toBe(0);
				expect(result.stderr).toBe('');
				const key = /^BACKUP_ENCRYPTION_KEY=(\S+)$/m.exec(result.stdout)?.[1];
				const id = /^Key id: ([0-9a-f]{16})$/m.exec(result.stdout)?.[1];
				expect(key).toBeDefined();
				expect(parseBackupKey(key!, 'printed').id).toBe(id);
				expect(Buffer.from(key!, 'base64')).toHaveLength(32);
				return key;
			});
			expect(printed[0]).not.toBe(printed[1]);
			expect(await readdir(scratch)).toEqual([]);
		},
		TIMEOUT
	);
});

describe('backup:list', () => {
	const HOUR = 3_600_000;
	/** A folder store holding a backup taken at each of `dates`. */
	async function folderWith(dates: Date[]): Promise<string> {
		const dir = await mkdtemp(path.join(scratch, 'store-'));
		for (const date of dates)
			await fileStore({ dir }).put(backupPathname(date), Buffer.alloc(2_000));
		return dir;
	}

	it(
		'exits 1 when the newest backup is 37 hours old, and 0 at 35 hours',
		async () => {
			const now = Date.now();
			const stale = command('list', [], {
				BACKUP_DIR: await folderWith([new Date(now - 37 * HOUR), new Date(now - 60 * HOUR)])
			});
			expect(stale.status, stale.stderr).toBe(1);
			expect(stale.stderr).toContain('Stale: the newest backup is 37 h old, over the 36 h limit.');

			const fresh = command('list', [], {
				BACKUP_DIR: await folderWith([new Date(now - 35 * HOUR)])
			});
			expect(fresh.status, fresh.stderr).toBe(0);
			expect(fresh.stdout).toContain('Fresh: the newest backup is 35 h old (limit 36 h).');
		},
		TIMEOUT
	);

	it(
		'lists newest first with age, size and retention bucket, totalled against the Hobby allowance',
		async () => {
			const day = Math.floor(Date.now() / (24 * HOUR)) * 24 * HOUR - 3 * 24 * HOUR;
			const [first, middle, last] = [0.5, 1, 2].map((h) => new Date(day + h * HOUR));
			const result = command('list', [], {
				BACKUP_DIR: await folderWith([middle!, first!, last!])
			});
			expect(result.status).toBe(1);
			const rows = result.stdout.split('\n').filter((line) => line.includes('backups/'));
			expect(rows.map((row) => row.trim().split(/\s{2,}/))).toEqual([
				[
					expect.stringMatching(/^\d{4}-.*Z$/),
					expect.stringMatching(/^\d+ d \d+ h$/),
					'2.0 KB',
					'daily',
					backupPathname(last!)
				],
				[
					expect.any(String),
					expect.any(String),
					'2.0 KB',
					'deleted by the next prune',
					backupPathname(middle!)
				],
				[expect.any(String), expect.any(String), '2.0 KB', 'monthly', backupPathname(first!)]
			]);
			expect(result.stdout).toContain(
				"Total: 3 backup(s), 6.0 KB of the Hobby plan's 1 GB Blob storage (0.0 %"
			);
		},
		TIMEOUT
	);

	it(
		'exits 1 on an empty store',
		async () => {
			const result = command('list', [], { BACKUP_DIR: await folderWith([]) });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain('No backups in the store.');
		},
		TIMEOUT
	);

	it(
		'refuses --probe without a token before any request, even with a folder store',
		async () => {
			const result = command(
				'list',
				['--probe'],
				{ BACKUP_DIR: await folderWith([new Date()]) },
				{ trapFetch: true }
			);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('Refusing to probe: set BLOB_READ_WRITE_TOKEN');
			expect(result.stderr).not.toContain('FETCH SENT');
			expect(result.stdout).not.toContain('Store:');
		},
		TIMEOUT
	);

	it(
		'refuses with neither a token nor a folder',
		() => {
			const result = command('list', []);
			expect(result.status).toBe(2);
			expect(result.stderr).toContain('Refusing to run: set BLOB_READ_WRITE_TOKEN');
		},
		TIMEOUT
	);
});

describe('cli-support', () => {
	it('redacts the password and credential-like query values', () => {
		expect(
			redactUrl('postgres://coach:pw@ep-x.neon.tech/neondb?sslmode=require&password=pw2&apikey=k')
		).toBe('postgres://coach:***@ep-x.neon.tech/neondb?sslmode=require&password=***&apikey=***');
		expect(redactUrl('postgres://coach@localhost/coach_dev')).toBe(
			'postgres://coach@localhost/coach_dev'
		);
	});

	it('names the database and host to confirm, and refuses a URL that is not a database', () => {
		expect(databaseTarget('postgresql://u:p@db.example.com:5432/neon%5Fdb', 'X')).toEqual({
			redacted: 'postgresql://u:***@db.example.com:5432/neon%5Fdb',
			name: 'neon_db',
			host: 'db.example.com',
			confirmation: 'neon_db@db.example.com'
		});
		for (const url of [
			'not a url p4ss',
			'https://u:p4ss@db.example.com/x',
			'postgres://u:p4ss@h/'
		]) {
			const refuse = () => databaseTarget(url, 'DATABASE_URL_UNPOOLED');
			expect(refuse).toThrow(Refusal);
			expect(refuse).toThrow(/DATABASE_URL_UNPOOLED/);
			expect(refuse).not.toThrow(/p4ss/);
		}
	});

	it('confirms only the exact text typed in a terminal', async () => {
		const typed = async (answer: string, isTTY = true) => {
			const input = Object.assign(new PassThrough(), { isTTY });
			const output = new PassThrough();
			const asked = confirmTyped('neondb@ep-x', { input, output });
			input.end(`${answer}\n`);
			return asked;
		};
		expect(await typed('neondb@ep-x')).toBe('confirmed');
		expect(await typed('  neondb@ep-x  ')).toBe('confirmed');
		expect(await typed('neondb@ep-y')).toBe('mismatch');
		expect(await typed('')).toBe('mismatch');
		expect(await typed('neondb@ep-x', false)).toBe('not_interactive');
	});
});
