/**
 * The restore's schema step (scripts/backup/target.ts) on the scratch destination: a blank target
 * is brought to exactly the backup's point in history, without the exercise seed, and forward
 * to HEAD afterwards; a target that holds rows, a different history or an earlier restore is
 * refused, and a backup this checkout cannot rebuild is refused before anything is written.
 */
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BackupHeader } from '../../../src/lib/domain/backup/format';
import { connectionConfig } from '../../../src/lib/server/db/connection';
import {
	journalMigrations,
	migrationsFolderUpTo,
	runMigrations,
	type JournalMigration
} from '../../../src/lib/server/db/migrate';
import {
	compareSchemas,
	inspectTarget,
	markRestored,
	prepareTarget
} from '../../../scripts/backup/target';
import { scratchUrl } from './scratch';

const url = scratchUrl('dst');
/** Created by the migration after the truncated checkout's last one. */
const LATER_TABLE = 'email_sign_in_links';
const SHA = 'a'.repeat(64);
const SLOW = 60_000;

let client: pg.Client;
let journal: JournalMigration[];
/** The truncated checkout: every migration before the one creating LATER_TABLE. */
let k: number;

const applied = (entries: JournalMigration[]) =>
	entries.map(({ hash, createdAt }) => ({ hash, createdAt }));

/** A backup header's schema taken after the first `n` journal migrations. */
function schemaAt(n: number): BackupHeader['schema'] {
	const migrations = applied(journal.slice(0, n));
	return { migrations, count: n, lastHash: migrations.at(-1)!.hash };
}

const prepare = (n: number, sha256 = SHA) =>
	prepareTarget(url, client, { schema: schemaAt(n), sha256 }, { journal });

async function blank(): Promise<void> {
	await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
	await client.query('DROP SCHEMA IF EXISTS public CASCADE');
	await client.query('CREATE SCHEMA public');
}

async function hasTable(name: string): Promise<boolean> {
	const { rows } = await client.query<{ present: boolean }>(
		'SELECT to_regclass($1) IS NOT NULL AS present',
		[`public.${name}`]
	);
	return rows[0]!.present;
}

beforeAll(async () => {
	journal = await journalMigrations();
	k = journal.findIndex((m) => m.tag.endsWith(`_${LATER_TABLE}`));
	expect(k).toBeGreaterThan(1);
	client = new pg.Client(connectionConfig(url));
	await client.connect();
});

afterAll(async () => {
	await client?.end();
});

beforeEach(blank);

describe('journalMigrations', () => {
	it('hashes each migration as Drizzle records it once applied', async () => {
		const run = await runMigrations(url, { seed: false });
		expect(run.total).toBe(journal.length);
		const target = await inspectTarget(client);
		expect(target.state === 'migrated' && target.migrations).toEqual(applied(journal));
		const raw = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8')) as {
			entries: { tag: string }[];
		};
		expect(journal.map((m) => m.tag)).toEqual(raw.entries.map((e) => e.tag));
	}, SLOW);
});

describe('migrationsFolderUpTo', () => {
	it('holds only the first n journal entries and their SQL', async () => {
		const folder = await migrationsFolderUpTo(k);
		try {
			expect((await journalMigrations(folder)).map((m) => m.tag)).toEqual(
				journal.slice(0, k).map((m) => m.tag)
			);
			expect(existsSync(path.join(folder, `${journal[k]!.tag}.sql`))).toBe(false);
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	});

	it('refuses a count outside the journal', async () => {
		await expect(migrationsFolderUpTo(0)).rejects.toThrow(RangeError);
		await expect(migrationsFolderUpTo(journal.length + 1)).rejects.toThrow(RangeError);
	});
});

describe('compareSchemas', () => {
	it('accepts any prefix of the journal, the whole journal included', () => {
		expect(compareSchemas(schemaAt(k).migrations, journal)).toEqual({ ok: true, count: k });
		expect(compareSchemas(schemaAt(journal.length).migrations, journal)).toEqual({
			ok: true,
			count: journal.length
		});
	});

	it('names the first migration whose hash or timestamp differs', () => {
		const hash = schemaAt(k).migrations.map((m, i) => (i === 3 ? { ...m, hash: SHA } : m));
		expect(compareSchemas(hash, journal)).toEqual({
			ok: false,
			code: 'history_diverged',
			at: 3,
			tag: journal[3]!.tag
		});
		const time = schemaAt(k).migrations.map((m, i) =>
			i === k - 1 ? { ...m, createdAt: m.createdAt + 1 } : m
		);
		expect(compareSchemas(time, journal)).toMatchObject({ code: 'history_diverged', at: k - 1 });
	});

	it('refuses a backup with migrations this checkout lacks', () => {
		const newer = [...applied(journal), { hash: SHA, createdAt: Date.now() }];
		expect(compareSchemas(newer, journal)).toEqual({
			ok: false,
			code: 'backup_newer_than_checkout',
			backup: journal.length + 1,
			checkout: journal.length
		});
	});
});

describe('inspectTarget', () => {
	it('reports a database without history or objects as blank', async () => {
		expect(await inspectTarget(client)).toEqual({ state: 'blank' });
	});

	it('reports objects without history as migrated, with no migrations', async () => {
		await client.query('CREATE TABLE stray (id int PRIMARY KEY)');
		expect(await inspectTarget(client)).toEqual({
			state: 'migrated',
			migrations: [],
			tables: [],
			empty: true
		});
		await client.query('DROP TABLE stray');
		await client.query("CREATE TYPE stray_mood AS ENUM ('calm')");
		expect(await inspectTarget(client)).toMatchObject({ state: 'migrated', migrations: [] });
	});

	it('names the tables that hold rows in a seeded database', async () => {
		await runMigrations(url);
		const target = await inspectTarget(client);
		expect(target).toMatchObject({ state: 'migrated', empty: false, tables: ['exercises'] });
	}, SLOW);

	it('reports a committed restore with its marker', async () => {
		await runMigrations(url, { seed: false });
		await client.query('BEGIN');
		await markRestored(client, { sha256: SHA, schemaTag: '27-0123abcd' });
		await client.query('COMMIT');
		const target = await inspectTarget(client);
		expect(target).toMatchObject({
			state: 'restored',
			migrations: applied(journal),
			empty: true,
			restores: [{ sha256: SHA, schemaTag: '27-0123abcd', restoredAt: expect.any(Date) }]
		});
	}, SLOW);
});

describe('prepareTarget', () => {
	it('migrates a blank target to exactly the backup’s migrations, without the seed', async () => {
		expect(await prepare(k)).toEqual({ ok: true, count: k, from: 'blank' });
		expect(await inspectTarget(client)).toEqual({
			state: 'migrated',
			migrations: applied(journal.slice(0, k)),
			tables: [],
			empty: true
		});
		expect(await hasTable('exercises')).toBe(true);
		expect(await hasTable(LATER_TABLE)).toBe(false);

		// Then the checkout's later migrations complete it to HEAD.
		const forward = await runMigrations(url, { seed: false });
		expect(forward).toEqual({ applied: journal.length - k, total: journal.length, library: null });
		expect(await hasTable(LATER_TABLE)).toBe(true);
		const head = await inspectTarget(client);
		expect(head.state === 'migrated' && head.migrations).toEqual(applied(journal));
	}, SLOW);

	it('accepts an empty target already at the backup’s migrations', async () => {
		await prepare(k);
		expect(await prepare(k)).toEqual({ ok: true, count: k, from: 'migrated' });
	}, SLOW);

	it('refuses an empty target at other migrations', async () => {
		await prepare(k);
		expect(await prepare(k - 1)).toEqual({
			ok: false,
			code: 'target_schema_mismatch',
			target: k,
			backup: k - 1
		});
		expect(await prepare(journal.length)).toMatchObject({ code: 'target_schema_mismatch' });
	}, SLOW);

	it('refuses a target that holds rows, naming its tables', async () => {
		await runMigrations(url);
		expect(await prepare(journal.length)).toEqual({
			ok: false,
			code: 'target_not_empty',
			tables: ['exercises']
		});
	}, SLOW);

	it('answers already_restored for the same archive, and refuses any other', async () => {
		await prepare(k);
		await markRestored(client, { sha256: SHA, schemaTag: 'k' });
		await runMigrations(url, { seed: false });
		expect(await prepare(k)).toEqual({
			ok: false,
			code: 'already_restored',
			restoredAt: expect.any(Date)
		});
		expect(await prepare(k, 'b'.repeat(64))).toMatchObject({ code: 'target_not_empty' });
	}, SLOW);

	it('refuses a backup this checkout cannot rebuild before writing anything', async () => {
		const diverged = schemaAt(k);
		diverged.migrations[2] = { ...diverged.migrations[2]!, hash: SHA };
		expect(
			await prepareTarget(url, client, { schema: diverged, sha256: SHA }, { journal })
		).toMatchObject({ code: 'history_diverged', at: 2 });

		const migrations = [...applied(journal), { hash: SHA, createdAt: Date.now() }];
		const newer = { migrations, count: migrations.length, lastHash: SHA };
		expect(
			await prepareTarget(url, client, { schema: newer, sha256: SHA }, { journal })
		).toMatchObject({ code: 'backup_newer_than_checkout' });
		expect(await inspectTarget(client)).toEqual({ state: 'blank' });
	});
});
