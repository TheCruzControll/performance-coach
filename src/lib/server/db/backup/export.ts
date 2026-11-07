/**
 * Reads the whole database once, consistently, into an archive (M9 'export first, upload after
 * commit'):
 *
 * 1. BEGIN REPEATABLE READ READ ONLY: every read below sees one snapshot, taken by the first
 *    statement. pg_try_advisory_xact_lock makes the export single-flight (already_running when
 *    another holds it); a transaction-scoped lock is safe through Neon's transaction pooler.
 * 2. SET LOCAL the archive's settings and the timeouts (statement 60 s, idle 30 s).
 * 3. The header, from drizzle.__drizzle_migrations and the catalog (exportPlan's tables).
 * 4. Per table, in restore order: a NO SCROLL cursor over `row_to_json(t.*)::text` in
 *    primary-key order, FETCH_ROWS at a time, so memory is bounded per batch. Identifiers come
 *    only from the catalog, and JavaScript never parses a row.
 * 5. The sequences, then COMMIT, then the trailer.
 *
 * `writer` must be in memory (gzip, then seal into a bounded buffer): nothing slow is awaited
 * while the transaction is open, and the upload starts only after this resolves. On any error
 * the transaction is rolled back and the error rethrown; the writer is then unusable.
 *
 * Server-only by use; imported by path with relative .ts specifiers, so scripts run it under
 * plain Node.
 */
import type { ClientBase } from 'pg';
import {
	FORMAT_NAME,
	FORMAT_VERSION,
	SESSION_SETTINGS,
	type BackupHeader,
	type BackupSequences,
	type BackupTrailer
} from '../../../domain/backup/format.ts';
import type { ArchiveWriter } from '../../backup/archive.ts';
import { readCatalog } from './catalog.ts';
import { EXPORT_TIMEOUTS, ident, pinSettings, rowsQuery } from './sql.ts';
import { BackupExportError, exportPlan, type ExportPlanOptions } from './tables.ts';

/** The export's single-flight advisory lock (one bigint key; 7270xx are the app's other locks). */
export const BACKUP_LOCK_KEY = 727_900;
/** Rows per FETCH: a batch is a few hundred KB at most. */
export const FETCH_ROWS = 500;

const CURSOR = 'backup_rows';

export interface ExportOptions extends ExportPlanOptions {
	/** The running build's version, recorded in the header. */
	appVersion: string;
	now?: () => Date;
}

export interface ExportResult {
	header: BackupHeader;
	trailer: BackupTrailer;
	/** Excluded names the database does not hold (yet). */
	absentExcluded: string[];
}

export async function exportDatabase(
	client: ClientBase,
	writer: ArchiveWriter,
	{ appVersion, now = () => new Date(), ...planOptions }: ExportOptions
): Promise<ExportResult> {
	await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
	let header: BackupHeader;
	let absentExcluded: string[];
	try {
		const { rows } = await client.query<{ locked: boolean }>(
			'SELECT pg_try_advisory_xact_lock($1) AS locked',
			[BACKUP_LOCK_KEY]
		);
		if (!rows[0]!.locked) {
			throw new BackupExportError('already_running', 'Another backup export is running');
		}
		await pinSettings(client, EXPORT_TIMEOUTS);

		const catalog = await readCatalog(client);
		const plan = exportPlan(catalog, planOptions);
		absentExcluded = plan.absentExcluded;
		header = {
			kind: 'header',
			format: FORMAT_NAME,
			formatVersion: FORMAT_VERSION,
			createdAt: now().toISOString(),
			appVersion,
			schema: await readSchema(client),
			settings: { ...SESSION_SETTINGS },
			tables: plan.tables.map((t) => ({
				name: t.name,
				columns: t.columns.map((c) => ({ name: c.name, type: c.type }))
			})),
			excluded: plan.excluded
		};
		writer.header(header);

		for (const table of plan.tables) {
			writer.section(table.name);
			await client.query(`DECLARE ${CURSOR} NO SCROLL CURSOR FOR ${rowsQuery(table)}`);
			for (;;) {
				const batch = await client.query<{ line: string }>(`FETCH ${FETCH_ROWS} FROM ${CURSOR}`);
				for (const row of batch.rows) writer.row(row.line);
				if (batch.rows.length < FETCH_ROWS) break;
			}
			await client.query(`CLOSE ${CURSOR}`);
		}

		const exported = new Set(plan.tables.map((t) => t.name));
		const sequences: BackupSequences['sequences'] = [];
		for (const sequence of catalog.sequences) {
			if (sequence.table !== null && !exported.has(sequence.table)) continue;
			const state = await client.query<{ last_value: string; is_called: boolean }>(
				`SELECT last_value::text AS last_value, is_called FROM public.${ident(sequence.name)}`
			);
			const { last_value, is_called } = state.rows[0]!;
			sequences.push({ name: sequence.name, lastValue: last_value, isCalled: is_called });
		}
		writer.sequences(sequences);
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK').catch(() => {});
		throw error;
	}
	return { header, trailer: writer.finish(), absentExcluded };
}

/** The applied migrations, oldest first, as the header's schema tag. */
async function readSchema(client: ClientBase): Promise<BackupHeader['schema']> {
	const { rows } = await client.query<{ hash: string; created_at: string }>(
		'SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY id'
	);
	const migrations = rows.map((r) => ({ hash: r.hash, createdAt: Number(r.created_at) }));
	return { migrations, count: migrations.length, lastHash: migrations.at(-1)?.hash ?? '' };
}
