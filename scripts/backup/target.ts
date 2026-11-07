/**
 * The restore's schema step (M9 plan, 'restore: an operator tool in scripts/backup/'): before
 * any row is written, the target must hold exactly the schema the backup was taken on, so an
 * old backup restores with new code and is forward-migrated afterwards.
 *
 * - compareSchemas: the backup's migrations must be a prefix of this checkout's journal, by
 *   hash and timestamp, or there is no SQL here that rebuilds its schema.
 * - inspectTarget: what the target holds now ('blank', 'migrated' or 'restored').
 * - prepareTarget: accepts a blank target, which it migrates to the backup's point in history
 *   without the exercise seed, or one already migrated to exactly that point and empty. It
 *   refuses everything else before writing anything.
 *
 * A restore leaves its marker in RESTORE_MARKER_TABLE, inside the migrations schema, so it is
 * never exported, and dropping that schema (a reset, or --force) forgets it.
 *
 * Imported by path with relative .ts specifiers, so plain Node runs it.
 */
import { rm } from 'node:fs/promises';
import pg from 'pg';
import type { ClientBase } from 'pg';
import type { BackupHeader } from '../../src/lib/domain/backup/format.ts';
import {
	MIGRATIONS_SCHEMA,
	MIGRATIONS_TABLE,
	migrationsFolderUpTo,
	runMigrations,
	type JournalMigration
} from '../../src/lib/server/db/migrate.ts';

/** One applied migration, as the backup's header and drizzle.__drizzle_migrations hold it. */
export type AppliedMigration = BackupHeader['schema']['migrations'][number];

export const RESTORE_MARKER_TABLE = `"${MIGRATIONS_SCHEMA}"."__backup_restores"`;
const HISTORY_TABLE = `"${MIGRATIONS_SCHEMA}"."${MIGRATIONS_TABLE}"`;

export type SchemaComparison =
	| { ok: true; count: number }
	| { ok: false; code: 'backup_newer_than_checkout'; backup: number; checkout: number }
	| { ok: false; code: 'history_diverged'; at: number; tag: string };

/**
 * ok with the backup's migration count when its migrations are the journal's first ones.
 * Otherwise history_diverged at the first index whose hash or timestamp differs (its journal
 * tag named), or backup_newer_than_checkout when the backup ran migrations this checkout lacks.
 */
export function compareSchemas(
	backup: readonly AppliedMigration[],
	journal: readonly JournalMigration[]
): SchemaComparison {
	for (const [at, migration] of backup.entries()) {
		const entry = journal[at];
		if (!entry) {
			return {
				ok: false,
				code: 'backup_newer_than_checkout',
				backup: backup.length,
				checkout: journal.length
			};
		}
		if (entry.hash !== migration.hash || entry.createdAt !== migration.createdAt) {
			return { ok: false, code: 'history_diverged', at, tag: entry.tag };
		}
	}
	return { ok: true, count: backup.length };
}

export interface RestoreMarker {
	sha256: string;
	schemaTag: string;
	restoredAt: Date;
}

interface Inspected {
	/** Applied migrations, oldest first; none when the database has no migration history. */
	migrations: AppliedMigration[];
	/** Public tables holding at least one row, in name order. */
	tables: string[];
	empty: boolean;
}

export type TargetState =
	| { state: 'blank' }
	| ({ state: 'migrated' } & Inspected)
	| ({ state: 'restored'; restores: RestoreMarker[] } & Inspected);

/**
 * 'blank': no migration history and nothing in public (no relation, type or function).
 * 'restored': a restore committed here (its marker exists).
 * 'migrated': anything else, with its history and the tables that hold rows. A database with
 * objects but no history is 'migrated' with no migrations, so it matches no backup.
 *
 * Awaits each query in turn on `client`.
 */
export async function inspectTarget(client: ClientBase): Promise<TargetState> {
	const { rows } = await client.query<{ history: boolean; marker: boolean; objects: number }>(
		`SELECT to_regclass($1) IS NOT NULL AS history, to_regclass($2) IS NOT NULL AS marker,
			(SELECT count(*) FROM pg_class WHERE relnamespace = to_regnamespace('public'))::int
			+ (SELECT count(*) FROM pg_type WHERE typnamespace = to_regnamespace('public')
				AND typrelid = 0 AND typcategory <> 'A')::int
			+ (SELECT count(*) FROM pg_proc WHERE pronamespace = to_regnamespace('public'))::int
			AS objects`,
		[HISTORY_TABLE, RESTORE_MARKER_TABLE]
	);
	const { history, marker, objects } = rows[0]!;
	if (!history && !marker && objects === 0) return { state: 'blank' };

	const migrations = history ? await appliedMigrations(client) : [];
	const tables = await tablesWithRows(client);
	const inspected = { migrations, tables, empty: tables.length === 0 };
	if (!marker) return { state: 'migrated', ...inspected };
	const restores = await client.query<RestoreMarker>(
		`SELECT sha256, schema_tag AS "schemaTag", restored_at AS "restoredAt"
		FROM ${RESTORE_MARKER_TABLE} ORDER BY restored_at, sha256`
	);
	return { state: 'restored', restores: restores.rows, ...inspected };
}

async function appliedMigrations(client: ClientBase): Promise<AppliedMigration[]> {
	const { rows } = await client.query<{ hash: string; created_at: string }>(
		`SELECT hash, created_at::text AS created_at FROM ${HISTORY_TABLE} ORDER BY id`
	);
	return rows.map((r) => ({ hash: r.hash, createdAt: Number(r.created_at) }));
}

/** One query: each public table that holds a row, read with EXISTS, never counted. */
async function tablesWithRows(client: ClientBase): Promise<string[]> {
	const { rows } = await client.query<{ name: string }>(
		`SELECT relname AS name FROM pg_class
		WHERE relnamespace = to_regnamespace('public') AND relkind IN ('r', 'p') AND NOT relispartition
		ORDER BY relname`
	);
	if (rows.length === 0) return [];
	const probes = rows.map(
		({ name }, i) =>
			`SELECT $${i + 1}::text AS name WHERE EXISTS (SELECT FROM public.${pg.escapeIdentifier(name)})`
	);
	const held = await client.query<{ name: string }>(
		probes.join(' UNION ALL '),
		rows.map((r) => r.name)
	);
	return held.rows.map((r) => r.name).sort();
}

/**
 * Records a committed restore of the archive whose trailer SHA-256 is `sha256`. Call it inside
 * the restore's transaction, after the digests match, so the marker commits with the rows.
 */
export async function markRestored(
	client: ClientBase,
	restore: { sha256: string; schemaTag: string }
): Promise<void> {
	await client.query(
		`CREATE TABLE IF NOT EXISTS ${RESTORE_MARKER_TABLE} (
			sha256 text PRIMARY KEY,
			schema_tag text NOT NULL,
			restored_at timestamptz NOT NULL DEFAULT now()
		)`
	);
	await client.query(`INSERT INTO ${RESTORE_MARKER_TABLE} (sha256, schema_tag) VALUES ($1, $2)`, [
		restore.sha256,
		restore.schemaTag
	]);
}

export type TargetRefusal =
	| Exclude<SchemaComparison, { ok: true }>
	| { ok: false; code: 'already_restored'; restoredAt: Date }
	| { ok: false; code: 'target_not_empty'; tables: string[] }
	| { ok: false; code: 'target_schema_mismatch'; target: number; backup: number };

export type PreparedTarget =
	{ ok: true; count: number; from: 'blank' | 'migrated' } | TargetRefusal;

export interface PrepareOptions {
	/** This checkout's journal (journalMigrations()). */
	journal: readonly JournalMigration[];
	/** The folder `journal` was read from; runMigrations' default when omitted. */
	migrationsFolder?: string;
}

/**
 * Brings the target at `url` (inspected through `client`) to exactly `backup.schema`, or refuses
 * it. A blank target is migrated through a journal-prefix folder without the seed; a migrated
 * one must be empty and record exactly the backup's migrations. The same archive restored
 * before answers already_restored; any other restored target is not empty.
 */
export async function prepareTarget(
	url: string,
	client: ClientBase,
	backup: { schema: BackupHeader['schema']; sha256: string },
	{ journal, migrationsFolder }: PrepareOptions
): Promise<PreparedTarget> {
	const comparison = compareSchemas(backup.schema.migrations, journal);
	if (!comparison.ok) return comparison;

	const before = await inspectTarget(client);
	if (before.state === 'blank') {
		const folder = await migrationsFolderUpTo(comparison.count, migrationsFolder);
		try {
			await runMigrations(url, { migrationsFolder: folder, seed: false });
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	}
	const target = before.state === 'blank' ? await inspectTarget(client) : before;
	if (target.state === 'blank') throw new Error('The target is still blank after migrating');
	if (target.state === 'restored') {
		const same = target.restores.find((r) => r.sha256 === backup.sha256);
		if (same) return { ok: false, code: 'already_restored', restoredAt: same.restoredAt };
	}
	if (target.state === 'restored' || !target.empty) {
		return { ok: false, code: 'target_not_empty', tables: target.tables };
	}
	if (!sameMigrations(target.migrations, backup.schema.migrations)) {
		return {
			ok: false,
			code: 'target_schema_mismatch',
			target: target.migrations.length,
			backup: comparison.count
		};
	}
	return {
		ok: true,
		count: comparison.count,
		from: before.state === 'blank' ? 'blank' : target.state
	};
}

function sameMigrations(a: readonly AppliedMigration[], b: readonly AppliedMigration[]): boolean {
	return (
		a.length === b.length &&
		a.every((m, i) => m.hash === b[i]!.hash && m.createdAt === b[i]!.createdAt)
	);
}
