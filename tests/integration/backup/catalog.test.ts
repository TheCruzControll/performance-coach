/**
 * The backup's invariants on the real migrated catalog (the test database), asserted as rules
 * rather than as a snapshot of the order, so schema slices of later milestones never churn this
 * file: a new table needs a primary key, and a new cross-table cycle a nullable key column plus
 * a reviewed LATE_ALLOWED entry. A catalog that breaks either is refused by name.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RestorePlanError, type Catalog } from '../../../src/lib/domain/backup/plan';
import { readCatalog } from '../../../src/lib/server/db/backup/catalog';
import { backupClient } from '../../../src/lib/server/db/backup/connect';
import {
	BackupExportError,
	EXCLUDED_TABLES,
	exportPlan,
	LATE_ALLOWED
} from '../../../src/lib/server/db/backup/tables';

let client: pg.Client;
let catalog: Catalog;

beforeAll(async () => {
	client = await backupClient(process.env.DATABASE_URL!);
	catalog = await readCatalog(client);
});

afterAll(async () => {
	await client?.end();
});

/** What exportPlan refuses `ddl`'s catalog with (null when it accepts it); the DDL is rolled back. */
async function planted(ddl: string): Promise<unknown> {
	await client.query('BEGIN');
	try {
		await client.query(ddl);
		exportPlan(await readCatalog(client));
		return null;
	} catch (error) {
		return error;
	} finally {
		await client.query('ROLLBACK');
	}
}

describe('the migrated catalog', () => {
	it('reads every public table with its columns, key and foreign keys', () => {
		const owners = catalog.tables.find((t) => t.name === 'owners')!;
		expect(owners.primaryKey).toEqual(['id']);
		expect(owners.columns[0]).toMatchObject({ name: 'id', type: 'uuid', nullable: false });
		const programs = catalog.tables.find((t) => t.name === 'programs')!;
		expect(programs.foreignKeys).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					columns: ['current_version_id'],
					references: 'program_versions',
					referencedColumns: ['id']
				})
			])
		);
		const sets = catalog.tables.find((t) => t.name === 'set_records')!;
		expect(sets.columns.find((c) => c.name === 'id')!.identity).not.toBeNull();
		expect(catalog.sequences).toEqual(
			expect.arrayContaining([{ name: 'set_records_id_seq', table: 'set_records', column: 'id' }])
		);
	});

	it('loads every foreign-key target before its source, apart from late and self keys', () => {
		const plan = exportPlan(catalog);
		const position = new Map(plan.tables.map((t, i) => [t.name, i]));
		const late = new Set(plan.restore.late.map((l) => `${l.table}.${l.fk}`));
		const misordered = plan.tables.flatMap((table) =>
			table.foreignKeys
				.filter((key) => key.references !== table.name && !late.has(`${table.name}.${key.name}`))
				.filter((key) => position.get(key.references)! > position.get(table.name)!)
				.map((key) => `${table.name}.${key.name}`)
		);
		expect(misordered).toEqual([]);
		expect(plan.tables.map((t) => t.name).sort()).toEqual(
			catalog.tables
				.map((t) => t.name)
				.filter((name) => !(name in EXCLUDED_TABLES))
				.sort()
		);
	});

	it('makes late exactly the reviewed LATE_ALLOWED columns', () => {
		const late = exportPlan(catalog).restore.late.flatMap((l) =>
			l.columns.map((column) => `${l.table}.${column}`)
		);
		expect(late).toEqual([...LATE_ALLOWED]);
	});

	it('gives every exported table a primary key', () => {
		const keyless = exportPlan(catalog)
			.tables.filter((t) => t.primaryKey.length === 0)
			.map((t) => t.name);
		expect(keyless).toEqual([]);
	});

	it('refuses a planted NOT NULL cycle, naming its tables and keys', async () => {
		const error = await planted(`
			CREATE TABLE planted_hen (id int PRIMARY KEY, egg_id int NOT NULL);
			CREATE TABLE planted_egg (id int PRIMARY KEY, hen_id int NOT NULL REFERENCES planted_hen (id));
			ALTER TABLE planted_hen ADD CONSTRAINT planted_hen_egg_fk FOREIGN KEY (egg_id) REFERENCES planted_egg (id);`);
		expect(error).toBeInstanceOf(RestorePlanError);
		expect((error as RestorePlanError).code).toBe('unbreakable_cycle');
		expect((error as RestorePlanError).tables).toEqual(['planted_egg', 'planted_hen']);
		expect((error as RestorePlanError).foreignKeys).toEqual([
			'planted_egg.planted_egg_hen_id_fkey',
			'planted_hen.planted_hen_egg_fk'
		]);
	});

	it('refuses a planted nullable cycle that LATE_ALLOWED does not list, naming the column', async () => {
		const error = await planted(`
			CREATE TABLE planted_hen (id int PRIMARY KEY, egg_id int);
			CREATE TABLE planted_egg (id int PRIMARY KEY, hen_id int NOT NULL REFERENCES planted_hen (id));
			ALTER TABLE planted_hen ADD FOREIGN KEY (egg_id) REFERENCES planted_egg (id);`);
		expect(error).toBeInstanceOf(BackupExportError);
		expect((error as BackupExportError).code).toBe('late_not_allowed');
		expect((error as BackupExportError).names).toEqual(['planted_hen.egg_id']);
	});

	it('refuses a planted table without a primary key, by name', async () => {
		const error = await planted('CREATE TABLE planted_keyless (n int)');
		expect(error).toBeInstanceOf(BackupExportError);
		expect((error as BackupExportError).code).toBe('no_primary_key');
		expect((error as BackupExportError).names).toEqual(['planted_keyless']);
	});

	it('does not ask an excluded table for a primary key', async () => {
		const error = await planted(
			'ALTER TABLE auth_rate_limits DROP CONSTRAINT auth_rate_limits_pkey'
		);
		expect(error).toBeNull();
	});
});
