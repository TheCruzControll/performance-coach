/**
 * `pnpm backup:restore` end to end, from the scratch source to the scratch destination
 * (scratch.ts): a file `pnpm backup:run --out` wrote restores into a blank database and prints
 * the drill's timing table; a database holding rows is refused before any write; --force resets
 * the scratch destination and restores; and a Blob URL restores through an injected fetch.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readArchive, type Archive } from '../../../src/lib/server/backup/archive';
import { openEnvelope } from '../../../src/lib/server/backup/envelope';
import { parseBackupKey } from '../../../src/lib/server/backup/key';
import { readCatalog } from '../../../src/lib/server/db/backup/catalog';
import { tableDigests } from '../../../src/lib/server/db/backup/digest';
import { pinSettings } from '../../../src/lib/server/db/backup/sql';
import { connectionConfig } from '../../../src/lib/server/db/connection';
import { journalMigrations, runMigrations } from '../../../src/lib/server/db/migrate';
import { EXIT, main } from '../../../scripts/backup-restore';
import { inspectTarget } from '../../../scripts/backup/target';
import { prepareSource, scratchUrl } from './scratch';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const SLOW = 90_000;
const KEY = randomBytes(32).toString('base64');
const TOKEN = 'vercel_blob_rw_AbCdEf123_secretpart456';
const BLOB_URL =
	'https://abcdef123.private.blob.vercel-storage.com/backups/2026/11/07/coach-20261107T104100Z.pcbk';
const dstUrl = scratchUrl('dst');

let dir: string;
let file: string;
let archive: Archive;
let src: pg.Client;
let dst: pg.Client;
let journalLength: number;

async function connect(url: string): Promise<pg.Client> {
	const client = new pg.Client(connectionConfig(url));
	await client.connect();
	return client;
}

function node(script: string, args: string[], env: Record<string, string>) {
	const result = spawnSync(process.execPath, [script, ...args], {
		cwd: root,
		env: { PATH: process.env.PATH ?? '', ...env },
		input: '',
		encoding: 'utf8',
		timeout: 80_000
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const restore = (args: string[]) =>
	node('scripts/backup-restore.ts', [file, '--target', dstUrl, ...args], {
		BACKUP_ENCRYPTION_KEY: KEY
	});

async function blank(): Promise<void> {
	await dst.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
	await dst.query('DROP SCHEMA IF EXISTS public CASCADE');
	await dst.query('CREATE SCHEMA public');
}

/** Each exported table's count and digest, read through `client`'s own catalog. */
async function digests(client: pg.Client) {
	const { tables } = await readCatalog(client);
	const exported = archive.header.tables.map(({ name }) => tables.find((t) => t.name === name)!);
	await client.query('BEGIN');
	try {
		await pinSettings(client);
		return await tableDigests(client, exported);
	} finally {
		await client.query('ROLLBACK');
	}
}

/** dst holds exactly the source's rows, under this checkout's every migration. */
async function expectRestored(): Promise<void> {
	const target = await inspectTarget(dst);
	expect(target).toMatchObject({
		state: 'restored',
		restores: [{ sha256: archive.trailer.sha256 }]
	});
	expect(target.state === 'restored' && target.migrations.length).toBe(journalLength);
	expect(await digests(dst)).toEqual(await digests(src));
}

const ISO = String.raw`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`;

beforeAll(async () => {
	const { url } = await prepareSource();
	src = await connect(url);
	// Only the app's schema: a blank target is migrated to it, and nothing else.
	await src.query(
		'DROP TABLE backup_edge, backup_cycle_a, backup_cycle_b, backup_bulk CASCADE; DROP TYPE backup_edge_mood'
	);
	dst = await connect(dstUrl);
	dir = await mkdtemp(path.join(tmpdir(), 'coach-restore-cli-'));
	file = path.join(dir, 'manual.pcbk');
	const run = node('scripts/backup-run.ts', ['--out', file], {
		DATABASE_URL_UNPOOLED: url,
		BACKUP_ENCRYPTION_KEY: KEY
	});
	expect(run.stderr).toBe('');
	expect(run.status).toBe(0);
	archive = readArchive(openEnvelope(parseBackupKey(KEY, 'key'), await readFile(file)));
	journalLength = (await journalMigrations()).length;
}, SLOW);

afterAll(async () => {
	await src?.end();
	await dst?.end();
	if (dir) await rm(dir, { recursive: true, force: true });
});

describe('backup:restore', () => {
	beforeEach(blank);

	it(
		'restores a backup:run file into a blank database and prints the timing table',
		async () => {
			const result = restore(['--yes', '--label', 'drill test']);
			expect(result.stderr).toBe('');
			expect(result.status).toBe(EXIT.ok);
			expect(result.stdout).toContain(`Backup:   ${file}`);
			expect(result.stdout).toContain(`Key id:   ${parseBackupKey(KEY, 'k').id}`);
			expect(result.stdout).toContain('State:    blank (no schema)');
			expect(result.stdout).toMatch(
				/^Restored: \d+ rows in \d+ tables, \d+ sequences, every digest verified/m
			);
			const table = result.stdout.slice(result.stdout.indexOf('Restore timings (UTC): drill test'));
			const rows = table.split('\n').filter((line) => /^\| [a-z]/.test(line));
			expect(table).toContain('| Phase | Started (UTC) | Finished (UTC) | Seconds |');
			expect(rows.map((row) => row.split(' | ')[0])).toEqual([
				'| download',
				'| decrypt and verify',
				'| schema',
				'| rows and digests',
				'| forward migration',
				'| total'
			]);
			for (const row of rows) {
				expect(row).toMatch(
					new RegExp(String.raw`^\| [a-z ]+ \| ${ISO} \| ${ISO} \| \d+\.\d\d \|$`)
				);
			}
			const output = `${result.stdout}${result.stderr}`;
			expect(output).not.toContain(KEY);
			expect(output).not.toContain(`:${new URL(dstUrl).password}@`);
			await expectRestored();

			const again = restore(['--yes']);
			expect(again.status).toBe(EXIT.ok);
			expect(again.stdout).toMatch(/^Already restored at .*: no row was written\.$/m);
			await expectRestored();
		},
		SLOW
	);

	it(
		'refuses a database that holds rows, before any write',
		async () => {
			await runMigrations(dstUrl);
			const result = restore(['--yes']);
			expect(result.status).toBe(EXIT.target);
			expect(result.stderr).toContain('Target refused (target_not_empty): rows in exercises.');
			expect(result.stdout).not.toContain('Restore timings');
			expect(await inspectTarget(dst)).toMatchObject({
				state: 'migrated',
				migrations: { length: journalLength },
				tables: ['exercises']
			});
		},
		SLOW
	);

	it(
		'--force resets the scratch destination and restores into it',
		async () => {
			await runMigrations(dstUrl);
			const result = restore(['--yes', '--force']);
			expect(result.stderr).toBe('');
			expect(result.status).toBe(EXIT.ok);
			expect(result.stdout).toMatch(/^State: {4}migrated \(\d+ migrations\), rows in exercises$/m);
			await expectRestored();
		},
		SLOW
	);

	it(
		'restores a Blob URL through the fetch it is given, sending the token to the private host',
		async () => {
			const sealed = await readFile(file);
			const requests: { url: string; authorization: string; redirect?: RequestRedirect }[] = [];
			const fetch = (async (url: string, init: RequestInit) => {
				const headers = init.headers as Record<string, string>;
				requests.push({ url, authorization: headers.authorization!, redirect: init.redirect });
				return new Response(sealed);
			}) as unknown as typeof globalThis.fetch;
			const log = vi.spyOn(console, 'log').mockImplementation(() => {});
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				const code = await main(
					[BLOB_URL, '--target', dstUrl, '--yes', '--no-forward-migrate'],
					{ BACKUP_ENCRYPTION_KEY: KEY, BLOB_READ_WRITE_TOKEN: TOKEN },
					{ fetch }
				);
				expect(error.mock.calls).toEqual([]);
				expect(code).toBe(EXIT.ok);
				const printed = log.mock.calls.map((call) => String(call[0])).join('\n');
				expect(printed).toContain(`Backup:   ${BLOB_URL}`);
				expect(printed).toContain('| forward migration | skipped | | |');
			} finally {
				log.mockRestore();
				error.mockRestore();
			}
			expect(requests).toEqual([
				{ url: BLOB_URL, authorization: `Bearer ${TOKEN}`, redirect: 'error' }
			]);
			await expectRestored();
		},
		SLOW
	);
});
