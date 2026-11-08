/**
 * `pnpm backup:run --out` against the scratch source (scratch.ts), spawned as an operator runs it:
 * the file it writes opens with the key and holds exactly the database's rows, and its output
 * names the database redacted and never the key.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readArchive } from '../../../src/lib/server/backup/archive';
import { openEnvelope } from '../../../src/lib/server/backup/envelope';
import { parseBackupKey } from '../../../src/lib/server/backup/key';
import { backupClient } from '../../../src/lib/server/db/backup/connect';
import { tableDigests } from '../../../src/lib/server/db/backup/digest';
import { pinSettings } from '../../../src/lib/server/db/backup/sql';
import { prepareSource } from './scratch';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const KEY_TEXT = randomBytes(32).toString('base64');

let url: string;
let client: pg.Client;
let dir: string;

beforeAll(async () => {
	({ url } = await prepareSource());
	client = await backupClient(url);
	await client.query(`SET application_name = 'backup-test'`);
	// The scratch cycle needs a late key the app's LATE_ALLOWED does not list (run.test.ts).
	await client.query('DROP TABLE backup_cycle_a, backup_cycle_b CASCADE');
	dir = await mkdtemp(path.join(tmpdir(), 'coach-backup-cli-'));
}, 60_000);

afterAll(async () => {
	await client?.end();
	if (dir) await rm(dir, { recursive: true, force: true });
});

/** Each public table's primary key, read independently of the backup's catalog. */
async function primaryKeys(): Promise<Map<string, string[]>> {
	const { rows } = await client.query<{ table: string; columns: string[] }>(
		`SELECT c.relname AS table, array_agg(a.attname::text ORDER BY array_position(i.indkey, a.attnum)) AS columns
		FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
		JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
		WHERE i.indisprimary AND c.relnamespace = 'public'::regnamespace GROUP BY c.relname`
	);
	return new Map(rows.map((r) => [r.table, r.columns]));
}

describe('backup:run --out', () => {
	it('writes a file that opens with the key and matches the database row for row', async () => {
		const out = path.join(dir, 'manual.pcbk');
		// The command's own temp directory, to see what its staging leaves behind.
		const temp = await mkdtemp(path.join(dir, 'tmp-'));
		const result = spawnSync(process.execPath, ['scripts/backup-run.ts', '--out', out], {
			cwd: root,
			env: {
				PATH: process.env.PATH ?? '',
				DATABASE_URL_UNPOOLED: url,
				BACKUP_ENCRYPTION_KEY: KEY_TEXT,
				TMPDIR: temp
			},
			input: '',
			encoding: 'utf8',
			timeout: 60_000
		});
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);

		const target = new URL(url);
		target.password = '***';
		expect(result.stdout).toContain(`Database: ${target.toString()}`);
		expect(result.stdout).toContain(`Backup:   ${out}`);
		const file = await readFile(out);
		const sha256 = createHash('sha256').update(file).digest('hex');
		expect(result.stdout).toContain(`Size:     ${file.length} bytes, sha256 ${sha256}`);
		const output = `${result.stdout}${result.stderr}`;
		expect(output).not.toContain(KEY_TEXT);
		expect(output).not.toContain(`:${new URL(url).password}@`);

		const archive = readArchive(openEnvelope(parseBackupKey(KEY_TEXT, 'key'), file));
		const keys = await primaryKeys();
		await client.query('BEGIN');
		let digests;
		try {
			await pinSettings(client);
			digests = await tableDigests(
				client,
				archive.header.tables.map((t) => ({ name: t.name, primaryKey: keys.get(t.name)! }))
			);
		} finally {
			await client.query('ROLLBACK');
		}
		expect(archive.tables.length).toBeGreaterThan(10);
		for (const table of archive.header.tables) {
			expect(archive.trailer.rowCounts[table.name], table.name).toBe(digests[table.name]!.count);
			expect(archive.trailer.tableDigests[table.name], table.name).toBe(
				digests[table.name]!.sha256
			);
		}
		expect(archive.trailer.rowCounts.backup_bulk).toBeGreaterThan(1_000);
		// The run's temporary folder store is removed.
		expect(await readdir(temp)).toEqual([]);
	});
});
