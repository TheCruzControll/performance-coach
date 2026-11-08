/**
 * The restore's row step (M9 plan, 'restore: an operator tool in scripts/backup/'): a verified
 * archive becomes the exact database again, every row with its id and every sequence, in one
 * transaction that proves its own result before it commits.
 *
 * restoreArchive, on a target prepareTarget (target.ts) has brought to the backup's schema:
 * 1. BEGIN, SET LOCAL the archive's settings, SET CONSTRAINTS ALL DEFERRED. The header's tables
 *    and the archive's sequences must be the target's, column for column, or nothing is written.
 * 2. DISABLE TRIGGER USER on every exported table.
 * 3. Per table, in planRestore order: stage its lines STAGE_BATCH_ROWS at a time, then one
 *    `INSERT … OVERRIDING SYSTEM VALUE SELECT … FROM stage CROSS JOIN LATERAL
 *    json_populate_record(NULL::t, line::json) ORDER BY ord`, the late columns left NULL.
 * 4. UPDATE the late columns from the same lines, joined on the primary key.
 * 5. ALTER SEQUENCE … RESTART then setval every sequence, ENABLE TRIGGER USER, SET CONSTRAINTS
 *    ALL IMMEDIATE. A bare setval survives ROLLBACK; the RESTART gives the sequence a new
 *    relfilenode inside the transaction, so the setval that follows rolls back with it.
 * 6. Recompute every table's digest in SQL and roll back on any difference from the trailer.
 * 7. Write the marker (target.ts), then COMMIT.
 * Any error rolls the whole transaction back: the target stays migrated and empty, and its
 * triggers, whose DISABLE was part of it, stay enabled. The same archive again answers
 * already_restored.
 *
 * Why an operator tool may suspend user triggers: the history guards refuse what a restore must
 * do, by design (a program inserted already pointing at a version, a proposal inserted already
 * applied, an audit row the load would write). Restore puts back rows those guards once accepted,
 * and step 6 proves they come back byte for byte. The bypass lives here, outside server code,
 * where scripts/history-guards.test.ts forbids it; it needs the table owner
 * (DATABASE_URL_UNPOOLED), never the app's runtime role.
 *
 * restoreBackup runs the whole tool: open the envelope, read the archive, prepare the target,
 * restore the rows, then forward-migrate. A file that does not open or read throws its
 * BackupError before the target is touched; a target or archive refusal is returned.
 *
 * Imported by path with relative .ts specifiers, so plain Node runs it.
 */
import type { ClientBase } from 'pg';
import { schemaTag } from '../../src/lib/domain/backup/format.ts';
import { planRestore, type Catalog, type CatalogTable } from '../../src/lib/domain/backup/plan.ts';
import { readArchive, type Archive } from '../../src/lib/server/backup/archive.ts';
import { openEnvelope } from '../../src/lib/server/backup/envelope.ts';
import type { BackupKey } from '../../src/lib/server/backup/key.ts';
import { readCatalog } from '../../src/lib/server/db/backup/catalog.ts';
import { tableDigests } from '../../src/lib/server/db/backup/digest.ts';
import { ident, pinSettings } from '../../src/lib/server/db/backup/sql.ts';
import { runMigrations, type MigrationRun } from '../../src/lib/server/db/migrate.ts';
import {
	markRestored,
	prepareTarget,
	RESTORE_MARKER_TABLE,
	type PrepareOptions,
	type TargetRefusal
} from './target.ts';

/** Row lines sent per staging INSERT: a batch is a few hundred KB at most. */
export const STAGE_BATCH_ROWS = 500;

/** The transaction's own staging table, dropped at COMMIT or ROLLBACK. */
const STAGE = 'backup_restore_stage';

export type RestoreRefusal =
	| { ok: false; code: 'already_restored'; restoredAt: Date }
	/** Tables whose columns differ from the target's, or sequences it lacks, by name. */
	| { ok: false; code: 'manifest_mismatch'; names: string[] }
	/** Tables whose restored rows do not digest to the trailer's, by name. */
	| { ok: false; code: 'digest_mismatch'; tables: string[] };

export interface RestoredRows {
	ok: true;
	/** Per table, as the trailer counts them. */
	rowCounts: Record<string, number>;
	/** The late columns filled in after every table was in, as `table.column`. */
	late: string[];
	sequences: number;
}

/**
 * The header's tables whose columns (names and types, in order) differ from the target's, or
 * that it lacks, then the archive's sequences it lacks. Empty when the archive fits the target.
 */
export function manifestMismatches(
	archive: Pick<Archive, 'header' | 'sequences'>,
	catalog: Catalog
): string[] {
	const tables = new Map(catalog.tables.map((t) => [t.name, t]));
	const names: string[] = [];
	for (const { name, columns } of archive.header.tables) {
		const target = tables.get(name)?.columns;
		const same =
			target?.length === columns.length &&
			target.every((c, i) => c.name === columns[i]!.name && c.type === columns[i]!.type);
		if (!same) names.push(name);
	}
	const sequences = new Set(catalog.sequences.map((s) => s.name));
	for (const { name } of archive.sequences) if (!sequences.has(name)) names.push(name);
	return names;
}

/**
 * Loads `archive` into the target `client` is connected to, whose catalog is `catalog`
 * (readCatalog, after prepareTarget), as the header comment's seven steps. Awaits each query in
 * turn on `client`. Rethrows any database error after rolling back.
 */
export async function restoreArchive(
	client: ClientBase,
	archive: Archive,
	catalog: Catalog
): Promise<RestoredRows | RestoreRefusal> {
	const mismatched = manifestMismatches(archive, catalog);
	if (mismatched.length > 0) return { ok: false, code: 'manifest_mismatch', names: mismatched };

	const exported = new Set(archive.header.tables.map((t) => t.name));
	const plan = planRestore(
		catalog,
		catalog.tables.map((t) => t.name).filter((name) => !exported.has(name))
	);
	const byName = new Map(catalog.tables.map((t) => [t.name, t]));
	const tables = plan.order.map((name) => byName.get(name)!);
	const rows = new Map(archive.tables.map((t) => [t.name, t.rows]));
	const allTables = tables.map((t) => `public.${ident(t.name)}`);

	await client.query('BEGIN');
	try {
		const restoredAt = await priorRestore(client, archive.trailer.sha256);
		if (restoredAt) {
			await client.query('ROLLBACK');
			return { ok: false, code: 'already_restored', restoredAt };
		}
		await pinSettings(client);
		await client.query('SET CONSTRAINTS ALL DEFERRED');
		await client.query(allTables.map((t) => `ALTER TABLE ${t} DISABLE TRIGGER USER`).join(';\n'));
		await client.query(
			`CREATE TEMP TABLE ${STAGE} (tbl text, ord int, line text, PRIMARY KEY (tbl, ord))
			ON COMMIT DROP`
		);

		const late = new Map<string, string[]>();
		for (const { table, columns } of plan.late) {
			late.set(table, [...(late.get(table) ?? []), ...columns]);
		}
		for (const table of tables) {
			const lines = rows.get(table.name)!;
			if (lines.length === 0) continue;
			await stage(client, table.name, lines);
			await client.query(insertRows(table, late.get(table.name) ?? []), [table.name]);
		}
		for (const [name, columns] of late) {
			if (rows.get(name)!.length === 0) continue;
			await client.query(updateLate(byName.get(name)!, columns), [name]);
		}

		if (archive.sequences.length > 0) {
			await client.query(
				archive.sequences.map((s) => `ALTER SEQUENCE public.${ident(s.name)} RESTART`).join(';\n')
			);
		}
		await client.query(
			`SELECT setval(format('public.%I', n)::regclass, v::bigint, c)
			FROM unnest($1::text[], $2::text[], $3::boolean[]) AS s(n, v, c)`,
			[
				archive.sequences.map((s) => s.name),
				archive.sequences.map((s) => s.lastValue),
				archive.sequences.map((s) => s.isCalled)
			]
		);
		await client.query(allTables.map((t) => `ALTER TABLE ${t} ENABLE TRIGGER USER`).join(';\n'));
		await client.query('SET CONSTRAINTS ALL IMMEDIATE');

		const digests = await tableDigests(client, tables);
		const { rowCounts, tableDigests: expected } = archive.trailer;
		const differing = tables
			.map((t) => t.name)
			.filter((n) => digests[n]!.count !== rowCounts[n] || digests[n]!.sha256 !== expected[n]);
		if (differing.length > 0) {
			await client.query('ROLLBACK');
			return { ok: false, code: 'digest_mismatch', tables: differing };
		}

		await markRestored(client, {
			sha256: archive.trailer.sha256,
			schemaTag: schemaTag(archive.header)
		});
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK').catch(() => {});
		throw error;
	}
	return {
		ok: true,
		rowCounts: { ...archive.trailer.rowCounts },
		late: plan.late.flatMap((l) => l.columns.map((c) => `${l.table}.${c}`)),
		sequences: archive.sequences.length
	};
}

/** When this archive was restored here before, if it was. */
async function priorRestore(client: ClientBase, sha256: string): Promise<Date | null> {
	const { rows } = await client.query<{ present: boolean }>(
		'SELECT to_regclass($1) IS NOT NULL AS present',
		[RESTORE_MARKER_TABLE]
	);
	if (!rows[0]!.present) return null;
	const marker = await client.query<{ restored_at: Date }>(
		`SELECT restored_at FROM ${RESTORE_MARKER_TABLE} WHERE sha256 = $1`,
		[sha256]
	);
	return marker.rows[0]?.restored_at ?? null;
}

/** Stages `lines` under `table`, numbered in file (primary-key) order. */
async function stage(client: ClientBase, table: string, lines: string[]): Promise<void> {
	for (let start = 0; start < lines.length; start += STAGE_BATCH_ROWS) {
		const batch = lines.slice(start, start + STAGE_BATCH_ROWS);
		await client.query(
			`INSERT INTO ${STAGE} (tbl, ord, line)
			SELECT $1::text, $2::int + o - 1, l FROM unnest($3::text[]) WITH ORDINALITY AS u(l, o)`,
			[table, start, batch]
		);
	}
}

/** `FROM stage s, the row r`: each staged line of table $1 as a record of `table`. */
const staged = (table: CatalogTable) =>
	`FROM ${STAGE} s CROSS JOIN LATERAL json_populate_record(NULL::public.${ident(table.name)}, s.line::json) r
	WHERE s.tbl = $1`;

/** Every written (non-generated) column, the late ones as NULL, keeping each row's ids. */
function insertRows(table: CatalogTable, late: readonly string[]): string {
	const columns = table.columns.filter((c) => !c.generated).map((c) => c.name);
	const values = columns.map((c) => (late.includes(c) ? 'NULL' : `r.${ident(c)}`));
	return `INSERT INTO public.${ident(table.name)} (${columns.map(ident).join(', ')})
		OVERRIDING SYSTEM VALUE SELECT ${values.join(', ')} ${staged(table)} ORDER BY s.ord`;
}

/** Fills `late` from the staged lines, matching each row on the primary key. */
function updateLate(table: CatalogTable, late: readonly string[]): string {
	const set = late.map((c) => `${ident(c)} = r.${ident(c)}`).join(', ');
	const key = table.primaryKey.map((c) => `AND t.${ident(c)} = r.${ident(c)}`).join(' ');
	return `UPDATE public.${ident(table.name)} t SET ${set} ${staged(table)} ${key}`;
}

export interface RestoreBackupOptions extends PrepareOptions {
	/**
	 * After the rows commit, run this checkout's later migrations and the exercise seed, as a
	 * deploy does (true by default). A rerun of the same file answers already_restored without
	 * migrating.
	 */
	forwardMigrate?: boolean;
}

export type RestoreBackupResult =
	| {
			ok: true;
			header: Archive['header'];
			trailer: Archive['trailer'];
			from: 'blank' | 'migrated';
			rows: RestoredRows;
			forward: MigrationRun | null;
	  }
	| TargetRefusal
	| RestoreRefusal;

/**
 * Restores the sealed backup `sealed`, opened with `key`, into the target at `url`, inspected
 * and loaded through `client` (connected to `url` as its owner).
 */
export async function restoreBackup(
	url: string,
	client: ClientBase,
	sealed: Uint8Array,
	key: BackupKey,
	{ forwardMigrate = true, ...prepare }: RestoreBackupOptions
): Promise<RestoreBackupResult> {
	const archive = readArchive(openEnvelope(key, sealed));
	const { header, trailer } = archive;
	const target = await prepareTarget(
		url,
		client,
		{ schema: header.schema, sha256: trailer.sha256 },
		prepare
	);
	if (!target.ok) return target;
	const rows = await restoreArchive(client, archive, await readCatalog(client));
	if (!rows.ok) return rows;
	const forward = forwardMigrate
		? await runMigrations(url, { migrationsFolder: prepare.migrationsFolder })
		: null;
	return { ok: true, header, trailer, from: target.from, rows, forward };
}
