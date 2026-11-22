/**
 * The least-privilege runtime role (src/lib/server/db/runtime-grants.ts), seen through the app's
 * own login (coach_app, a member of coach_runtime) and the owner: row access on every public
 * table and sequence and nothing more, real DML and the backup export as that login, every
 * bypass refused with 42501, grants that reach a later table, and grants that re-apply to the
 * same state, and a skip (not a throw) when the role is missing and this login cannot create it.
 * Runs on the test database, which global setup has already migrated.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { buffer } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ArchiveWriter } from '../../../src/lib/server/backup/archive';
import { exportDatabase } from '../../../src/lib/server/db/backup/export';
import { connectionConfig } from '../../../src/lib/server/db/connection';
import { LOCAL_DATABASE_URLS } from '../../../src/lib/server/db/migrate';
import { applyRuntimeGrants, SETUP_HINT } from '../../../src/lib/server/db/runtime-grants';
import { runtimeUrl } from '../helpers';

const url = process.env.TEST_DATABASE_URL || LOCAL_DATABASE_URLS.test;

/** A role name that never exists: the grants see the runtime role as missing. */
const ABSENT_ROLE = 'coach_runtime_absent_probe';

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

	it('skips, without throwing, when the role is missing and this login cannot create it', async (ctx) => {
		// coach_app is the app's login, made NOCREATEROLE by pnpm db:setup. It runs the grants
		// with a role name that does not exist, so the CREATE ROLE it attempts must be refused.
		const { rows } = await owner.query<{ rolcreaterole: boolean }>(
			"SELECT rolcreaterole FROM pg_roles WHERE rolname = 'coach_app'"
		);
		if (rows[0]!.rolcreaterole) ctx.skip();

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			await expect(applyRuntimeGrants(app, ABSENT_ROLE)).resolves.toEqual({
				applied: false,
				reason: 'no-createrole'
			});
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith(
				`runtime grants skipped: ${ABSENT_ROLE} is missing and this role cannot create it; ${SETUP_HINT}`
			);
		} finally {
			warn.mockRestore();
		}

		// The refusal rolled back, so the same session still works and no role was created.
		await expect(app.query('SELECT 1 AS one')).resolves.toMatchObject({ rows: [{ one: 1 }] });
		const { rows: found } = await owner.query<{ n: number }>(
			'SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1',
			[ABSENT_ROLE]
		);
		expect(found[0]!.n).toBe(0);
	});
});

describe('pnpm db:grants as a login without CREATEROLE', () => {
	const repo = fileURLToPath(new URL('../../../', import.meta.url));
	const script = fileURLToPath(new URL('../../../scripts/db-grants.ts', import.meta.url));

	it('exits 1 when this login cannot apply the grants', async (ctx) => {
		// Needs an admin connection to create the throwaway login (CI sets PGADMIN_URL). The CLI
		// refuses the app's own logins, so the login is a plain one with no CREATEROLE.
		const admin = process.env.PGADMIN_URL;
		if (!admin) ctx.skip();

		const name = `grants_probe_${randomBytes(4).toString('hex')}`;
		const secret = randomBytes(16).toString('hex');
		const adminClient = new pg.Client(connectionConfig(admin!));
		await adminClient.connect();
		try {
			await adminClient.query(
				`CREATE ROLE ${pg.escapeIdentifier(name)} LOGIN PASSWORD ${pg.escapeLiteral(secret)} NOSUPERUSER NOCREATEROLE NOCREATEDB`
			);
			const probe = new URL(url);
			probe.username = name;
			probe.password = secret;

			const result = spawnSync(process.execPath, [script, probe.toString()], {
				cwd: repo,
				env: { PATH: process.env.PATH ?? '' },
				encoding: 'utf8',
				timeout: 60_000
			});
			expect(result.status).toBe(1);
			expect(result.stderr).toContain('db:grants: failed on');
			expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
		} finally {
			await adminClient.query(`DROP ROLE IF EXISTS ${pg.escapeIdentifier(name)}`).catch(() => {});
			await adminClient.end();
		}
	});
});
