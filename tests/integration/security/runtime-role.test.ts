/**
 * The least-privilege runtime role (src/lib/server/db/runtime-grants.ts), seen through the app's
 * own login (coach_app, a member of coach_runtime) and the owner: row access on every public
 * table and sequence and nothing more, real DML and the backup export as that login, every
 * bypass refused with 42501, grants that reach a later table, and grants that re-apply to the
 * same state. Runs on the test database, which global setup has already migrated.
 */
import { buffer } from 'node:stream/consumers';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArchiveWriter } from '../../../src/lib/server/backup/archive';
import { exportDatabase } from '../../../src/lib/server/db/backup/export';
import { connectionConfig } from '../../../src/lib/server/db/connection';
import { LOCAL_DATABASE_URLS } from '../../../src/lib/server/db/migrate';
import { applyRuntimeGrants, SETUP_HINT } from '../../../src/lib/server/db/runtime-grants';
import { runtimeUrl } from '../helpers';

const url = process.env.TEST_DATABASE_URL || LOCAL_DATABASE_URLS.test;

let owner: pg.Client;
let app: pg.Client;

beforeAll(async () => {
	owner = new pg.Client(connectionConfig(url));
	app = new pg.Client(connectionConfig(runtimeUrl(url)));
	await owner.connect();
	await app.connect();
}, 30_000);

afterAll(async () => {
	await app?.end();
	await owner?.end();
});

/** Every statement the app's login may not run: each must be refused with insufficient_privilege. */
const BYPASSES = [
	'TRUNCATE program_versions',
	'ALTER TABLE program_versions DISABLE TRIGGER USER',
	'SET session_replication_role = replica',
	'DROP TABLE program_versions',
	'CREATE TABLE runtime_probe (id int)',
	'CREATE TABLE drizzle.runtime_probe (id int)',
	'CREATE OR REPLACE FUNCTION history_refuse_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
	"INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('probe', 1)",
	'CREATE ROLE runtime_probe_role'
];

describe('the runtime role', () => {
	it('has every table and sequence right, and nothing more', async () => {
		const tables = await owner.query<{
			name: string;
			select: boolean;
			insert: boolean;
			update: boolean;
			delete: boolean;
			truncate: boolean;
			trigger: boolean;
			references: boolean;
		}>(
			`SELECT c.relname AS name,
				has_table_privilege('coach_runtime', c.oid, 'SELECT') AS "select",
				has_table_privilege('coach_runtime', c.oid, 'INSERT') AS insert,
				has_table_privilege('coach_runtime', c.oid, 'UPDATE') AS "update",
				has_table_privilege('coach_runtime', c.oid, 'DELETE') AS delete,
				has_table_privilege('coach_runtime', c.oid, 'TRUNCATE') AS truncate,
				has_table_privilege('coach_runtime', c.oid, 'TRIGGER') AS trigger,
				has_table_privilege('coach_runtime', c.oid, 'REFERENCES') AS "references"
			FROM pg_class c
			WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
			ORDER BY 1`
		);
		expect(tables.rows.length).toBeGreaterThan(0);
		for (const row of tables.rows) {
			expect(row, row.name).toMatchObject({
				select: true,
				insert: true,
				update: true,
				delete: true,
				truncate: false,
				trigger: false,
				references: false
			});
		}

		const sequences = await owner.query<{
			name: string;
			usage: boolean;
			select: boolean;
			update: boolean;
		}>(
			`SELECT c.relname AS name,
				has_sequence_privilege('coach_runtime', c.oid, 'USAGE') AS usage,
				has_sequence_privilege('coach_runtime', c.oid, 'SELECT') AS "select",
				has_sequence_privilege('coach_runtime', c.oid, 'UPDATE') AS "update"
			FROM pg_class c
			WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
			ORDER BY 1`
		);
		for (const row of sequences.rows) {
			expect(row, row.name).toMatchObject({ usage: true, select: true, update: false });
		}

		const { rows } = await owner.query<{ read: boolean; write: boolean }>(
			`SELECT has_table_privilege('coach_runtime', 'drizzle.__drizzle_migrations', 'SELECT') AS read,
				has_table_privilege('coach_runtime', 'drizzle.__drizzle_migrations', 'INSERT') AS write`
		);
		expect(rows[0]).toEqual({ read: true, write: false });
	});

	it("does real DML as the app's login, then rolls back", async () => {
		await app.query('BEGIN');
		try {
			const inserted = await app.query<{ id: string }>(
				`INSERT INTO app_errors (kind, message) VALUES ('app', 'runtime-role probe') RETURNING id`
			);
			const id = inserted.rows[0]!.id;
			const updated = await app.query(
				"UPDATE app_errors SET message = 'runtime-role probe 2' WHERE id = $1",
				[id]
			);
			expect(updated.rowCount).toBe(1);
			const deleted = await app.query('DELETE FROM app_errors WHERE id = $1', [id]);
			expect(deleted.rowCount).toBe(1);
		} finally {
			await app.query('ROLLBACK');
		}
	});

	it('runs the backup export as the app login', async () => {
		const writer = new ArchiveWriter();
		const output = buffer(writer.output);
		const result = await exportDatabase(app, writer, { appVersion: 'test' });
		await output;
		expect(result.header.tables.length).toBeGreaterThan(0);
		expect(result.header.schema.count).toBeGreaterThan(0);
	});

	it.each(BYPASSES)('refuses %s with 42501 as the app login', async (statement) => {
		await expect(app.query(statement)).rejects.toMatchObject({ code: '42501' });
	});

	it('reaches a table created later through the default privileges', async () => {
		try {
			await owner.query('CREATE TABLE runtime_probe_later (id int PRIMARY KEY)');
			await app.query('INSERT INTO runtime_probe_later VALUES (1)');
			const { rows } = await app.query('SELECT id FROM runtime_probe_later');
			expect(rows).toEqual([{ id: 1 }]);
		} finally {
			await owner.query('DROP TABLE IF EXISTS runtime_probe_later');
		}
	});

	it('changes nothing when the grants are applied again', async () => {
		const snapshot = async () => {
			const acls = await owner.query(
				`SELECT n.nspname, c.relname, c.relacl::text AS acl
				FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname IN ('public', 'drizzle') ORDER BY 1, 2`
			);
			const defaults = await owner.query(
				`SELECT defaclobjtype, defaclacl::text AS acl FROM pg_default_acl
				WHERE defaclnamespace = 'public'::regnamespace ORDER BY 1`
			);
			return { acls: acls.rows, defaults: defaults.rows };
		};
		await applyRuntimeGrants(owner);
		const first = await snapshot();
		await applyRuntimeGrants(owner);
		expect(await snapshot()).toEqual(first);
	});

	it('names the setup step when the role is missing and the owner cannot create it', async (ctx) => {
		const { rows } = await owner.query<{ rolcreaterole: boolean }>(
			'SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user'
		);
		if (rows[0]!.rolcreaterole) ctx.skip();

		await expect(applyRuntimeGrants(owner, 'coach_runtime_absent_probe')).rejects.toMatchObject({
			code: '42501',
			hint: SETUP_HINT
		});
		const { rows: found } = await owner.query<{ n: number }>(
			"SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'coach_runtime_absent_probe'"
		);
		expect(found[0]!.n).toBe(0);
	});
});
