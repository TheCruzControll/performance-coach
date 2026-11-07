/**
 * The public schema as the backup sees it, read from pg_catalog (never from the Drizzle schema,
 * so a table the code does not know yet is still exported): tables, their columns in attnum
 * order with format_type's text, generated and identity columns, nullability, primary keys,
 * foreign keys with condeferrable, and sequences with the column that owns each.
 *
 * Five queries, awaited in turn on one client. Inside the export's REPEATABLE READ transaction
 * they read the same catalog the rows are read under.
 *
 * Server-only by use; imported by path with relative .ts specifiers, so scripts run it under
 * plain Node.
 */
import type { ClientBase } from 'pg';
import type {
	Catalog,
	CatalogColumn,
	CatalogForeignKey,
	CatalogTable
} from '../../../domain/backup/plan.ts';

/** Ordinary and partitioned tables of public, partitions left out (their parent holds them). */
const TABLES = `
	SELECT c.relname AS name FROM pg_class c
	WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
	ORDER BY c.relname`;

const COLUMNS = `
	SELECT c.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
		NOT a.attnotnull AS nullable, a.attgenerated <> '' AS generated, a.attidentity AS identity
	FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
	WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
		AND a.attnum > 0 AND NOT a.attisdropped
	ORDER BY c.relname, a.attnum`;

/** Each constraint's columns in key order, for primary and foreign keys alike. */
const keyColumns = (rel: string, keys: string) => `
	ARRAY(SELECT a.attname::text FROM unnest(k.${keys}) WITH ORDINALITY AS u(attnum, position)
		JOIN pg_attribute a ON a.attrelid = k.${rel} AND a.attnum = u.attnum ORDER BY u.position)`;

const KEYS = `
	SELECT k.contype AS kind, k.conname AS name, c.relname AS table, r.relname AS references,
		k.condeferrable AS deferrable, ${keyColumns('conrelid', 'conkey')} AS columns,
		CASE WHEN k.contype = 'f' THEN ${keyColumns('confrelid', 'confkey')} END AS referenced
	FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
	LEFT JOIN pg_class r ON r.oid = k.confrelid
	WHERE c.relnamespace = 'public'::regnamespace AND k.contype IN ('p', 'f')
	ORDER BY c.relname, k.conname`;

/** Owned by a column through OWNED BY ('a') or an identity column ('i'). */
const SEQUENCES = `
	SELECT s.relname AS name, t.relname AS table, a.attname AS column
	FROM pg_class s
	LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid
		AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
	LEFT JOIN pg_class t ON t.oid = d.refobjid
	LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
	WHERE s.relnamespace = 'public'::regnamespace AND s.relkind = 'S'
	ORDER BY s.relname`;

interface ColumnRow {
	table: string;
	name: string;
	type: string;
	nullable: boolean;
	generated: boolean;
	identity: string;
}

interface KeyRow {
	kind: 'p' | 'f';
	name: string;
	table: string;
	references: string | null;
	deferrable: boolean;
	columns: string[];
	referenced: string[] | null;
}

const IDENTITY: Record<string, CatalogColumn['identity']> = { a: 'always', d: 'by default' };

/** The public schema's tables (by name) and sequences, as planRestore and the export read them. */
export async function readCatalog(client: ClientBase): Promise<Catalog> {
	const tables = await client.query<{ name: string }>(TABLES);
	const columns = await client.query<ColumnRow>(COLUMNS);
	const keys = await client.query<KeyRow>(KEYS);
	const sequences = await client.query<{
		name: string;
		table: string | null;
		column: string | null;
	}>(SEQUENCES);

	const byName = new Map<string, CatalogTable>(
		tables.rows.map(({ name }) => [name, { name, columns: [], primaryKey: [], foreignKeys: [] }])
	);
	for (const row of columns.rows) {
		byName.get(row.table)?.columns.push({
			name: row.name,
			type: row.type,
			nullable: row.nullable,
			generated: row.generated,
			identity: IDENTITY[row.identity] ?? null
		});
	}
	for (const row of keys.rows) {
		const table = byName.get(row.table);
		if (!table) continue;
		if (row.kind === 'p') {
			table.primaryKey = row.columns;
			continue;
		}
		const key: CatalogForeignKey = {
			name: row.name,
			columns: row.columns,
			references: row.references!,
			referencedColumns: row.referenced ?? [],
			deferrable: row.deferrable
		};
		table.foreignKeys.push(key);
	}
	return { tables: [...byName.values()], sequences: sequences.rows };
}
