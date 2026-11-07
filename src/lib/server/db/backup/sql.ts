/**
 * The few SQL fragments the backup builds from the catalog, and the settings it pins. An
 * identifier is never quoted around: one that is not a lower-case Postgres name is refused, so
 * no table or column name can change a statement's meaning.
 *
 * Server-only by use; imported by path with relative .ts specifiers, so scripts run it under
 * plain Node.
 */
import type { ClientBase } from 'pg';
import { SESSION_SETTINGS } from '../../../domain/backup/format.ts';
import type { CatalogTable } from '../../../domain/backup/plan.ts';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** `"name"`, for a lower-case identifier only; anything else throws a RangeError. */
export function ident(name: string): string {
	if (!IDENTIFIER.test(name)) throw new RangeError(`Not a lower-case identifier: ${name}`);
	return `"${name}"`;
}

/**
 * `SELECT row_to_json(t.*)::text AS line FROM public."<table>" t ORDER BY <pk>`: one archive row
 * line per row, in primary-key order. `t.*` is always the whole row, even when the table has a
 * column named `t`. The digest and the restore check aggregate this same text.
 */
export function rowsQuery(table: Pick<CatalogTable, 'name' | 'primaryKey'>): string {
	return `SELECT ${ROW_TEXT} AS line FROM public.${ident(table.name)} t ORDER BY ${pkOrder(table)}`;
}

/** The row's archive text, over the alias `t`. */
export const ROW_TEXT = 'row_to_json(t.*)::text';

/** `t."a", t."b"`: the primary key's columns, in key order. */
export function pkOrder(table: Pick<CatalogTable, 'name' | 'primaryKey'>): string {
	if (table.primaryKey.length === 0) throw new RangeError(`${table.name} has no primary key`);
	return table.primaryKey.map((column) => `t.${ident(column)}`).join(', ');
}

/** Timeouts for the export's transaction, so a stuck run can never hold a snapshot open. */
export const EXPORT_TIMEOUTS = {
	statement_timeout: '60s',
	idle_in_transaction_session_timeout: '30s'
} as const;

/**
 * SET LOCAL each of SESSION_SETTINGS (and `extra`) in one statement. Call it inside a
 * transaction: the settings end with it.
 */
export async function pinSettings(
	client: ClientBase,
	extra: Readonly<Record<string, string>> = {}
): Promise<void> {
	const entries = Object.entries({ ...SESSION_SETTINGS, ...extra });
	const calls = entries.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, true)`);
	await client.query(`SELECT ${calls.join(', ')}`, entries.flat());
}
