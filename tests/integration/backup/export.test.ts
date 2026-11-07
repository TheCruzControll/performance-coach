/**
 * exportDatabase on the scratch source (scratch.ts): every table but the deny-list, in one
 * REPEATABLE READ snapshot, written losslessly as Postgres's own row text, FETCH_ROWS at a time,
 * single-flight, and with no transaction left open once it resolves.
 */
import { buffer } from 'node:stream/consumers';
import { gunzipSync } from 'node:zlib';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SESSION_SETTINGS } from '../../../src/lib/domain/backup/format';
import { ArchiveWriter, readArchive, type Archive } from '../../../src/lib/server/backup/archive';
import { backupClient } from '../../../src/lib/server/db/backup/connect';
import { tableDigests } from '../../../src/lib/server/db/backup/digest';
import {
	BACKUP_LOCK_KEY,
	exportDatabase,
	FETCH_ROWS,
	type ExportResult
} from '../../../src/lib/server/db/backup/export';
import { pinSettings } from '../../../src/lib/server/db/backup/sql';
import { BackupExportError, EXCLUDED_TABLES } from '../../../src/lib/server/db/backup/tables';
import { BULK_ROWS, EDGE, prepareSource, SCRATCH_LATE } from './scratch';

let url: string;
let client: pg.Client;
/** A second connection to the source, for the test's own reads and writes. */
let other: pg.Client;

beforeAll(async () => {
	({ url } = await prepareSource());
	client = await backupClient(url);
	other = await backupClient(url);
	await other.query(`SET application_name = 'backup-test'`);
}, 60_000);

afterAll(async () => {
	await client?.end();
	await other?.end();
});

interface Run extends ExportResult {
	archive: Archive;
	/** The gunzipped archive's text. */
	text: string;
}

async function run(on: pg.Client = client): Promise<Run> {
	const writer = new ArchiveWriter();
	const output = buffer(writer.output);
	const result = await exportDatabase(on, writer, {
		appVersion: 'test',
		lateAllowed: SCRATCH_LATE
	});
	const gzip = await output;
	return { ...result, archive: readArchive(gzip), text: gunzipSync(gzip).toString('utf8') };
}

async function refusal(promise: Promise<unknown>): Promise<BackupExportError> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!(error instanceof BackupExportError)) throw new Error(`expected a refusal, got ${error}`);
	return error;
}

/** Each public table's primary key, read independently of the backup's catalog. */
async function primaryKeys(): Promise<Map<string, string[]>> {
	const { rows } = await other.query<{ table: string; columns: string[] }>(
		`SELECT c.relname AS table, array_agg(a.attname::text ORDER BY array_position(i.indkey, a.attnum)) AS columns
		FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
		JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
		WHERE i.indisprimary AND c.relnamespace = 'public'::regnamespace GROUP BY c.relname`
	);
	return new Map(rows.map((r) => [r.table, r.columns]));
}

/** `work` inside a transaction with the archive's settings, on the test's own connection. */
async function pinned<T>(work: () => Promise<T>): Promise<T> {
	await other.query('BEGIN');
	try {
		await pinSettings(other);
		return await work();
	} finally {
		await other.query('ROLLBACK');
	}
}

describe('exportDatabase', () => {
	let first: Run;

	beforeAll(async () => {
		first = await run();
	});

	it('exports every table but the deny-list, once, with its exact columns and row count', async () => {
		const { rows: tables } = await other.query<{ name: string }>(
			`SELECT table_name AS name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`
		);
		const expected = tables.map((t) => t.name).filter((name) => !(name in EXCLUDED_TABLES));
		const names = first.header.tables.map((t) => t.name);
		expect([...names].sort()).toEqual(expected);
		expect(new Set(names).size).toBe(names.length);
		expect(names).toEqual(expect.arrayContaining(['owners', 'passkey_credentials', 'backup_edge']));

		expect(first.header.excluded).toEqual([
			{ name: 'auth_rate_limits', reason: EXCLUDED_TABLES.auth_rate_limits },
			{ name: 'auth_sessions', reason: EXCLUDED_TABLES.auth_sessions },
			{ name: 'webauthn_challenges', reason: EXCLUDED_TABLES.webauthn_challenges }
		]);
		expect(first.absentExcluded).toEqual(['backup_runs', 'email_sign_in_links']);
		expect(first.text).not.toMatch(
			/"kind":"section","table":"(auth_sessions|webauthn_challenges|auth_rate_limits)"/
		);

		for (const table of first.header.tables) {
			const { rows: columns } = await other.query<{ name: string; type: string }>(
				`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
				FROM pg_attribute a WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
				ORDER BY a.attnum`,
				[`public.${table.name}`]
			);
			expect(table.columns, table.name).toEqual(columns);
			const { rows } = await other.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM public."${table.name}"`
			);
			expect(first.trailer.rowCounts[table.name], table.name).toBe(rows[0]!.n);
		}
		expect(first.trailer.rowCounts.owners).toBe(1);
		expect(first.trailer.rowCounts.set_records).toBe(3);
		expect(first.trailer.rowCounts.backup_bulk).toBe(BULK_ROWS);
		expect(first.header.schema.count).toBeGreaterThan(0);
		expect(first.header.settings).toEqual(SESSION_SETTINGS);
	});

	it('writes each row exactly as a direct row_to_json query does, every edge value intact', async () => {
		const keys = await primaryKeys();
		await pinned(async () => {
			for (const { name, rows } of first.archive.tables) {
				const order = keys
					.get(name)!
					.map((c) => `"${c}"`)
					.join(', ');
				const direct = await other.query<{ line: string }>(
					`SELECT row_to_json(r)::text AS line FROM public."${name}" r ORDER BY ${order}`
				);
				expect(rows, name).toEqual(direct.rows.map((r) => r.line));
			}
		});

		const [edge, other_] = first.archive.tables.find((t) => t.name === 'backup_edge')!.rows;
		// Digits that a JavaScript number would lose stay in the text.
		expect(edge).toContain(`"amount":${EDGE.amount}`);
		expect(edge).toContain(`"big":${EDGE.big}`);
		expect(edge).toContain(`"ratio":0.1,`);
		expect(edge).toContain(`"doubled":24691357802469135780.0246913578`);
		expect(other_).toContain(`"big":-9223372036854775808`);
		expect(other_).toContain(`"ratio":"Infinity"`);
		const parsed = JSON.parse(edge!) as Record<string, unknown>;
		expect(parsed).toMatchObject({
			id: 1,
			parent_id: null,
			at: '2026-11-07T10:41:00.123456+00:00',
			doc: EDGE.doc,
			note: EDGE.note,
			raw: EDGE.raw,
			tags: EDGE.tags,
			mood: EDGE.mood
		});
		expect(JSON.parse(other_!)).toMatchObject({ id: 2, parent_id: 1, raw: '\\x', tags: [] });
		expect(edge).toContain(' ');
	});

	it('writes the same bytes between the header and the trailer on a second run', async () => {
		const second = await run();
		// The header holds createdAt, and the trailer's archive digest covers the header.
		const body = (text: string) => text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n#'));
		expect(body(second.text)).toBe(body(first.text));
		expect(body(first.text).length).toBeGreaterThan(100_000);
		expect(second.trailer.rowCounts).toEqual(first.trailer.rowCounts);
		expect(second.trailer.tableDigests).toEqual(first.trailer.tableDigests);
	});

	it("streams the same digests as SQL's, and records the sequences", async () => {
		const keys = await primaryKeys();
		const digests = await pinned(() =>
			tableDigests(
				other,
				first.header.tables.map((t) => ({ name: t.name, primaryKey: keys.get(t.name)! }))
			)
		);
		for (const table of first.header.tables) {
			expect(first.trailer.tableDigests[table.name], table.name).toBe(digests[table.name]!.sha256);
			expect(first.trailer.rowCounts[table.name], table.name).toBe(digests[table.name]!.count);
		}
		expect(digests.backup_cycle_a!.sha256).not.toBe(digests.backup_cycle_b!.sha256);

		const names = first.archive.sequences.map((s) => s.name);
		expect(names).toEqual(
			expect.arrayContaining(['backup_edge_id_seq', 'set_records_id_seq', 'auth_events_id_seq'])
		);
		expect(first.archive.sequences.find((s) => s.name === 'backup_edge_id_seq')).toEqual({
			name: 'backup_edge_id_seq',
			lastValue: '2',
			isCalled: true
		});
	});

	it('reads 1,200 rows in three FETCHes of at most 500', async () => {
		const spy = vi.spyOn(client, 'query');
		try {
			await run();
			const texts = spy.mock.calls.map((call) => String(call[0]));
			const start = texts.findIndex((t) => t.startsWith('DECLARE') && t.includes('"backup_bulk"'));
			const end = texts.indexOf('CLOSE backup_rows', start);
			const fetches = texts.slice(start + 1, end);
			expect(fetches).toEqual(Array(3).fill(`FETCH ${FETCH_ROWS} FROM backup_rows`));
			const sizes: number[] = [];
			for (const result of spy.mock.results.slice(start + 1, end)) {
				sizes.push(((await result.value) as pg.QueryResult).rows.length);
			}
			expect(sizes).toEqual([500, 500, 200]);
		} finally {
			spy.mockRestore();
		}
	});

	it('leaves out a row committed after it began reading, in a table it reads later', async () => {
		const order = first.header.tables.map((t) => t.name);
		expect(order.indexOf('backup_cycle_a')).toBeGreaterThan(order.indexOf('backup_bulk'));
		// Hold the export on backup_bulk, once it has fetched every table before it; meanwhile
		// commit a row to backup_cycle_a, which it has not read yet. A snapshot per statement
		// would see that row; the export's one snapshot, taken by its first statement, must not.
		const writer = await backupClient(url);
		await other.query('BEGIN');
		await other.query('LOCK TABLE backup_bulk IN ACCESS EXCLUSIVE MODE');
		const exporting = run();
		try {
			for (let waited = 0; ; waited += 10) {
				const { rows } = await writer.query<{ n: number }>(
					`SELECT count(*)::int AS n FROM pg_stat_activity
					WHERE application_name = 'coach-backup' AND wait_event_type = 'Lock'`
				);
				if (rows[0]!.n === 1) break;
				if (waited > 5_000) throw new Error('The export never waited on backup_bulk');
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			await writer.query('INSERT INTO backup_cycle_a VALUES (99, NULL)');
		} finally {
			await other.query('COMMIT');
		}
		try {
			const late = await exporting;
			const cycle = late.archive.tables.find((t) => t.name === 'backup_cycle_a')!;
			expect(cycle.rows).toHaveLength(2);
			expect(late.trailer.rowCounts.backup_cycle_a).toBe(2);
			const { rows } = await writer.query<{ n: number }>(
				'SELECT count(*)::int AS n FROM backup_cycle_a'
			);
			expect(rows[0]!.n).toBe(3);
		} finally {
			await writer.query('DELETE FROM backup_cycle_a WHERE id = 99');
			await writer.end();
		}
	});

	it('pins its own settings, whatever the connection was set to', async () => {
		const local = await backupClient(url);
		try {
			await local.query(
				`SET TimeZone = 'America/Los_Angeles'; SET bytea_output = 'escape'; SET extra_float_digits = 0`
			);
			const pinned = await run(local);
			const edge = (r: Run) => r.archive.tables.find((t) => t.name === 'backup_edge')!.rows;
			expect(edge(pinned)).toEqual(edge(first));
			expect(pinned.trailer.tableDigests).toEqual(first.trailer.tableDigests);
		} finally {
			await local.end();
		}
	});

	it('refuses with already_running while another export holds the lock', async () => {
		await other.query('BEGIN');
		try {
			await other.query('SELECT pg_advisory_xact_lock($1)', [BACKUP_LOCK_KEY]);
			const error = await refusal(run());
			expect(error.code).toBe('already_running');
		} finally {
			await other.query('ROLLBACK');
		}
		// The refused export rolled back: the same connection exports again.
		expect((await run()).trailer.rowCounts.backup_bulk).toBe(BULK_ROWS);
	});

	it('refuses, by name, a table without a primary key', async () => {
		await other.query('CREATE TABLE backup_keyless (n int)');
		try {
			const error = await refusal(run());
			expect(error.code).toBe('no_primary_key');
			expect(error.names).toEqual(['backup_keyless']);
			expect(error.message).toContain('backup_keyless');
		} finally {
			await other.query('DROP TABLE backup_keyless');
		}
	});

	it('leaves no transaction open on its connection once it resolves', async () => {
		await run();
		const { rows } = await other.query<{ state: string }>(
			`SELECT state FROM pg_stat_activity
			WHERE application_name = 'coach-backup' AND datname = current_database()`
		);
		expect(rows.map((r) => r.state)).toEqual(['idle']);
	});
});
