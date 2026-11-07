/**
 * Each table's row count and SHA-256, computed in SQL over the same text the archive holds
 * (src/lib/domain/backup/format.ts): every `row_to_json(t.*)::text` with its '\n', in
 * primary-key order, an empty table digesting the empty string. The export's trailer must equal
 * it, restore recomputes it inside its transaction, and the security fingerprint reuses it.
 *
 * Run it inside a transaction with pinSettings applied, so Postgres writes each value as the
 * archive does. One query per table, awaited in turn.
 *
 * Server-only by use; imported by path with relative .ts specifiers, so scripts run it under
 * plain Node.
 */
import type { ClientBase } from 'pg';
import type { CatalogTable } from '../../../domain/backup/plan.ts';
import { ident, pkOrder, ROW_TEXT } from './sql.ts';

export interface TableDigest {
	count: number;
	sha256: string;
}

/** By table name, in the order given. */
export async function tableDigests(
	client: ClientBase,
	tables: readonly Pick<CatalogTable, 'name' | 'primaryKey'>[]
): Promise<Record<string, TableDigest>> {
	const digests: Record<string, TableDigest> = {};
	for (const table of tables) {
		const { rows } = await client.query<{ count: number; sha256: string }>(
			`SELECT count(*)::int AS count, encode(sha256(convert_to(coalesce(
				string_agg(${ROW_TEXT} || E'\\n', '' ORDER BY ${pkOrder(table)}), ''), 'UTF8')), 'hex') AS sha256
			FROM public.${ident(table.name)} t`
		);
		digests[table.name] = rows[0]!;
	}
	return digests;
}
