/**
 * The restore's row step (scripts/backup/restore.ts), from the scratch source to the scratch
 * destination: export → seal → open → restore gives back every row, id and sequence in one
 * verified transaction, through guards that would refuse historical rows; a file or target it
 * must not restore is refused before any write, and a failure part-way leaves nothing behind.
 */
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { buffer } from 'node:stream/consumers';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, createPool } from '../../../src/lib/server/db';
import { ArchiveWriter, readArchive, type Archive } from '../../../src/lib/server/backup/archive';
import { openEnvelope, sealStream } from '../../../src/lib/server/backup/envelope';
import { isBackupError } from '../../../src/lib/server/backup/errors';
import { BackupKey } from '../../../src/lib/server/backup/key';
import { readCatalog } from '../../../src/lib/server/db/backup/catalog';
import { tableDigests } from '../../../src/lib/server/db/backup/digest';
import { exportDatabase } from '../../../src/lib/server/db/backup/export';
import { ident, pinSettings } from '../../../src/lib/server/db/backup/sql';
import { connectionConfig } from '../../../src/lib/server/db/connection';
import {
	journalMigrations,
	migrationsFolderUpTo,
	runMigrations,
	type JournalMigration
} from '../../../src/lib/server/db/migrate';
import type { CatalogTable } from '../../../src/lib/domain/backup/plan';
import { createGoal } from '../../../src/lib/server/services/profile';
import { restoreArchive, restoreBackup } from '../../../scripts/backup/restore';
import { inspectTarget, prepareTarget } from '../../../scripts/backup/target';
import { clock, generalGoal } from '../profile/fixtures';
import { exerciseIds, logStrength, utc } from '../training/fixtures/history';
import { EDGE_DDL, prepareSource, SCRATCH_LATE, scratchUrl } from './scratch';

const SLOW = 60_000;
const dstUrl = scratchUrl('dst');
/** Created by the migration after the earlier backup's last one. */
const LATER_TABLE = 'email_sign_in_links';

/** A scratch table with a BEFORE INSERT guard like M5's: a row is stored as proposed only. */
const GUARDED_DDL = `
	CREATE FUNCTION backup_guarded_insert() RETURNS trigger LANGUAGE plpgsql AS $$
	BEGIN
		IF NEW.status <> 'proposed' THEN
			RAISE EXCEPTION 'stored as proposed' USING ERRCODE = 'restrict_violation';
		END IF;
		RETURN NEW;
	END;
	$$;
	CREATE TABLE backup_guarded (id int PRIMARY KEY, status text NOT NULL);
	CREATE TRIGGER backup_guarded_insert BEFORE INSERT ON backup_guarded
		FOR EACH ROW EXECUTE FUNCTION backup_guarded_insert();`;

const key = new BackupKey(randomBytes(32));
let srcUrl: string;
let ownerId: string;
let src: pg.Client;
let dst: pg.Client;
let journal: JournalMigration[];
let sealed: Buffer;
let archive: Archive;

async function connect(url: string): Promise<pg.Client> {
	const client = new pg.Client(connectionConfig(url));
	await client.connect();
	return client;
}

/** Export → gzip → seal, as backup:run does, into memory. */
async function backUp(client: pg.Client): Promise<Buffer> {
	const writer = new ArchiveWriter();
	const output = buffer(writer.output.pipe(sealStream(key)));
	await exportDatabase(client, writer, { appVersion: 'test', lateAllowed: SCRATCH_LATE });
	return output;
}

async function blank(client: pg.Client): Promise<void> {
	await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
	await client.query('DROP SCHEMA IF EXISTS public CASCADE');
	await client.query('CREATE SCHEMA public');
}

/** Brings blank dst to the source's schema, scratch tables included, and returns its catalog. */
async function prepareScratch(): Promise<Awaited<ReturnType<typeof readCatalog>>> {
	const target = await prepareTarget(
		dstUrl,
		dst,
		{ schema: archive.header.schema, sha256: archive.trailer.sha256 },
		{ journal }
	);
	expect(target).toMatchObject({ ok: true, from: 'blank' });
	await dst.query(EDGE_DDL);
	await dst.query(GUARDED_DDL);
	return readCatalog(dst);
}

/** The exported tables as `client`'s catalog holds them, in the archive's order. */
async function exportedTables(client: pg.Client): Promise<CatalogTable[]> {
	const { tables } = await readCatalog(client);
	return archive.header.tables.map(({ name }) => tables.find((t) => t.name === name)!);
}

async function digests(client: pg.Client) {
	const tables = await exportedTables(client);
	await client.query('BEGIN');
	try {
		await pinSettings(client);
		return await tableDigests(client, tables);
	} finally {
		await client.query('ROLLBACK');
	}
}

async function sequenceStates(client: pg.Client) {
	const states: Record<string, { last_value: string; is_called: boolean }> = {};
	for (const { name } of archive.sequences) {
		const { rows } = await client.query<{ last_value: string; is_called: boolean }>(
			`SELECT last_value::text AS last_value, is_called FROM public.${ident(name)}`
		);
		states[name] = rows[0]!;
	}
	return states;
}

/** Public user triggers, and how many of them are not enabled. */
async function triggers(client: pg.Client) {
	const { rows } = await client.query<{ total: number; disabled: number }>(
		`SELECT count(*)::int AS total, (count(*) FILTER (WHERE t.tgenabled <> 'O'))::int AS disabled
		FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
		WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace`
	);
	return rows[0]!;
}

async function sqlState(
	promise: Promise<unknown>
): Promise<{ code?: string; constraint?: string }> {
	return promise.then(
		() => ({}),
		(error: { code?: string; constraint?: string }) => ({
			code: error.code,
			constraint: error.constraint
		})
	);
}

/** `archive` written again, each row passed through `edit` first. */
async function rewrite(edit: (table: string, row: string) => string): Promise<Archive> {
	const writer = new ArchiveWriter();
	const output = buffer(writer.output);
	writer.header(archive.header);
	for (const table of archive.tables) {
		writer.section(table.name);
		for (const row of table.rows) writer.row(edit(table.name, row));
	}
	writer.sequences(archive.sequences);
	writer.finish();
	return readArchive(await output);
}

/**
 * dst holds the migrated schema, no row and no marker, with every trigger enabled and every
 * sequence untouched (pg_sequences.last_value is NULL until a sequence is first used).
 */
async function expectMigratedEmpty(): Promise<void> {
	expect(await inspectTarget(dst)).toMatchObject({ state: 'migrated', empty: true });
	expect((await triggers(dst)).disabled).toBe(0);
	const { rows } = await dst.query<{ name: string }>(
		`SELECT sequencename AS name FROM pg_sequences
		WHERE schemaname = 'public' AND last_value IS NOT NULL`
	);
	expect(rows).toEqual([]);
}

beforeAll(async () => {
	({ url: srcUrl, ownerId } = await prepareSource());
	src = await connect(srcUrl);
	dst = await connect(dstUrl);
	await src.query(GUARDED_DDL);
	await src.query(`INSERT INTO backup_guarded VALUES (1, 'proposed'), (2, 'proposed')`);
	await src.query(`UPDATE backup_guarded SET status = 'applied' WHERE id = 1`);
	journal = await journalMigrations();
	sealed = await backUp(src);
	archive = readArchive(openEnvelope(key, sealed));
}, SLOW);

afterAll(async () => {
	await src?.end();
	await dst?.end();
});

describe('restoreArchive', () => {
	let restored: Awaited<ReturnType<typeof restoreArchive>>;

	beforeAll(async () => {
		await blank(dst);
		restored = await restoreArchive(dst, archive, await prepareScratch());
	}, SLOW);

	it('reproduces every row, count and sequence, and the next identity value', async () => {
		expect(restored).toEqual({
			ok: true,
			rowCounts: archive.trailer.rowCounts,
			late: ['backup_cycle_a.b_id', 'programs.current_version_id'],
			sequences: archive.sequences.length
		});
		expect(Object.keys(archive.trailer.rowCounts).length).toBeGreaterThan(40);
		expect(archive.trailer.rowCounts.backup_guarded).toBe(2);

		const expected = Object.fromEntries(
			Object.entries(archive.trailer.tableDigests).map(([name, sha256]) => [
				name,
				{ count: archive.trailer.rowCounts[name], sha256 }
			])
		);
		expect(await digests(dst)).toEqual(expected);
		expect(await digests(src)).toEqual(expected);

		expect(archive.sequences.map((s) => s.name)).toEqual(
			expect.arrayContaining(['backup_edge_id_seq', 'set_records_id_seq'])
		);
		expect(await sequenceStates(dst)).toEqual(await sequenceStates(src));

		const next = async (client: pg.Client) => {
			await client.query('BEGIN');
			try {
				const { rows } = await client.query<{ id: string }>(
					`INSERT INTO backup_edge (at, amount, big, ratio, doc, note, raw, mood)
					VALUES (now(), 1, 1, 1, '{}', '', '\\x', 'calm') RETURNING id::text AS id`
				);
				return rows[0]!.id;
			} finally {
				await client.query('ROLLBACK');
			}
		};
		expect(await next(dst)).toBe('3');
		expect(await next(src)).toBe('3');
	});

	it('points every program head at the same version', async () => {
		const heads = async (client: pg.Client) =>
			(
				await client.query<{ id: string; current_version_id: string | null }>(
					'SELECT id, current_version_id FROM programs ORDER BY id'
				)
			).rows;
		const dstHeads = await heads(dst);
		expect(dstHeads.length).toBeGreaterThan(0);
		expect(dstHeads.every((p) => p.current_version_id !== null)).toBe(true);
		expect(dstHeads).toEqual(await heads(src));
	});

	it('restores rows a BEFORE INSERT guard refuses, and leaves every guard on', async () => {
		const { rows } = await dst.query<{ id: number; status: string }>(
			'SELECT id, status FROM backup_guarded ORDER BY id'
		);
		expect(rows).toEqual([
			{ id: 1, status: 'applied' },
			{ id: 2, status: 'proposed' }
		]);

		const srcTriggers = await triggers(src);
		expect(srcTriggers.total).toBeGreaterThan(40);
		expect(await triggers(dst)).toEqual({ total: srcTriggers.total, disabled: 0 });
		expect(await sqlState(dst.query(`INSERT INTO backup_guarded VALUES (3, 'applied')`))).toEqual({
			code: '23001',
			constraint: undefined
		});
		expect(
			await sqlState(dst.query(`UPDATE program_versions SET created_at = created_at`))
		).toEqual({ code: '23001', constraint: 'history_refuse_update' });
	});

	it(
		'answers already_restored for the same archive and changes nothing',
		async () => {
			const before = await digests(dst);
			expect(await restoreArchive(dst, archive, await readCatalog(dst))).toEqual({
				ok: false,
				code: 'already_restored',
				restoredAt: expect.any(Date)
			});
			expect(await restoreBackup(dstUrl, dst, sealed, key, { journal })).toEqual({
				ok: false,
				code: 'already_restored',
				restoredAt: expect.any(Date)
			});
			expect(await digests(dst)).toEqual(before);
			expect(await inspectTarget(dst)).toMatchObject({
				state: 'restored',
				restores: [{ sha256: archive.trailer.sha256 }]
			});
		},
		SLOW
	);

	it('takes the service writes that follow, past every restored id', async () => {
		const pool = createPool(dstUrl, { max: 1 });
		try {
			const db = createDatabase(pool);
			const goal = await createGoal(ownerId, generalGoal({ title: 'After the restore' }), {
				db,
				now: clock('2026-11-12T09:00:00Z').now
			});
			expect(goal.id).toEqual(expect.any(String));
			const ids = await exerciseIds(db, ['back_squat']);
			const { setIds } = await logStrength(db, ownerId, { startedAt: utc('2026-11-12', '17:00') }, [
				{ exercise: ids.back_squat, weight: 145, reps: 2 }
			]);
			const { rows } = await src.query<{ max: number }>(
				'SELECT max(id)::int AS max FROM set_records'
			);
			expect(setIds).toEqual([rows[0]!.max + 1]);
		} finally {
			await pool.end();
		}
	});
});

describe('restore refusals', () => {
	beforeEach(() => blank(dst));

	it('refuses a file with a flipped byte as tampered, before any write', async () => {
		const flipped = Buffer.from(sealed);
		flipped[flipped.length - 40]! ^= 0x01;
		const error = await restoreBackup(dstUrl, dst, flipped, key, { journal }).catch((e) => e);
		expect(isBackupError(error, 'tampered')).toBe(true);
		expect(await inspectTarget(dst)).toEqual({ state: 'blank' });
	});

	it('refuses another key as wrong_key, before any write', async () => {
		const other = new BackupKey(randomBytes(32));
		const error = await restoreBackup(dstUrl, dst, sealed, other, { journal }).catch((e) => e);
		expect(isBackupError(error, 'wrong_key')).toBe(true);
		expect(await inspectTarget(dst)).toEqual({ state: 'blank' });
	});

	it(
		'refuses a target that holds rows',
		async () => {
			await runMigrations(dstUrl);
			expect(await restoreBackup(dstUrl, dst, sealed, key, { journal })).toEqual({
				ok: false,
				code: 'target_not_empty',
				tables: ['exercises']
			});
		},
		SLOW
	);

	it(
		'refuses an archive whose tables the target lacks, naming them, before any write',
		async () => {
			await prepareTarget(
				dstUrl,
				dst,
				{ schema: archive.header.schema, sha256: archive.trailer.sha256 },
				{ journal }
			);
			const result = await restoreArchive(dst, archive, await readCatalog(dst));
			expect(result).toMatchObject({ ok: false, code: 'manifest_mismatch' });
			expect(result.ok === false && 'names' in result && [...result.names].sort()).toEqual([
				'backup_bulk',
				'backup_cycle_a',
				'backup_cycle_b',
				'backup_edge',
				'backup_edge_id_seq',
				'backup_guarded'
			]);
			await expectMigratedEmpty();
		},
		SLOW
	);

	it(
		'rolls a failure part-way through the load back to a migrated, empty target',
		async () => {
			await prepareScratch();
			const loaded = archive.header.tables.filter((t) => archive.trailer.rowCounts[t.name]! > 0);
			const last = loaded.at(-1)!.name;
			expect(loaded.length).toBeGreaterThan(5);
			await dst.query(
				`ALTER TABLE public.${ident(last)} ADD CONSTRAINT restore_fails CHECK (false) NOT VALID`
			);
			expect(await sqlState(restoreArchive(dst, archive, await readCatalog(dst)))).toEqual({
				code: '23514',
				constraint: 'restore_fails'
			});
			await expectMigratedEmpty();
		},
		SLOW
	);

	it(
		'rolls back when a restored table does not digest to the trailer’s',
		async () => {
			const catalog = await prepareScratch();
			const altered = await rewrite((table, row) =>
				table === 'backup_bulk' && row.startsWith('{"id":7,') ? row.replace(/}$/, ',"x":1}') : row
			);
			expect(await restoreArchive(dst, altered, catalog)).toEqual({
				ok: false,
				code: 'digest_mismatch',
				tables: ['backup_bulk']
			});
			await expectMigratedEmpty();
		},
		SLOW
	);
});

describe('a backup taken at an earlier migration', () => {
	it(
		'restores at its own migration, then forward-migrates to HEAD',
		async () => {
			const k = journal.findIndex((m) => m.tag.endsWith(`_${LATER_TABLE}`));
			expect(k).toBeGreaterThan(1);
			await blank(src);
			const folder = await migrationsFolderUpTo(k);
			try {
				await runMigrations(srcUrl, { migrationsFolder: folder });
			} finally {
				await rm(folder, { recursive: true, force: true });
			}
			const earlier = await backUp(src);
			archive = readArchive(openEnvelope(key, earlier));
			expect(archive.header.schema.count).toBe(k);
			expect(archive.trailer.rowCounts.exercises).toBeGreaterThan(0);

			await blank(dst);
			const result = await restoreBackup(dstUrl, dst, earlier, key, { journal });
			expect(result).toMatchObject({
				ok: true,
				from: 'blank',
				rows: { ok: true, rowCounts: archive.trailer.rowCounts },
				forward: { applied: journal.length - k, total: journal.length }
			});
			const target = await inspectTarget(dst);
			expect(target).toMatchObject({
				state: 'restored',
				restores: [{ sha256: archive.trailer.sha256 }]
			});
			expect(target.state === 'restored' && target.migrations.length).toBe(journal.length);
			const { rows } = await dst.query<{ present: boolean }>(
				'SELECT to_regclass($1) IS NOT NULL AS present',
				[`public.${LATER_TABLE}`]
			);
			expect(rows[0]!.present).toBe(true);
			const [ofSrc, ofDst] = [await digests(src), await digests(dst)];
			expect(ofDst.exercises).toEqual(ofSrc.exercises);
		},
		SLOW
	);
});
