/**
 * The least-privilege database role the running app connects as, and the grants that give it its
 * rights. `coach_runtime` is NOLOGIN: a login role (coach_app locally, coach_app_prod in
 * production) inherits it. It can read and write the rows of every public table, use its
 * sequences, and read the migration journal. It cannot empty a table, change a table's shape,
 * create or drop anything, own anything, or touch the backup restore log. Grants are re-applied
 * idempotently by runMigrations (so every deploy build), scripts/backup-restore.ts and
 * scripts/db-grants.ts, so no restore can leave a database without them.
 *
 * Plain Node: imports only pg, so scripts and the migration runner load it without a bundler.
 */
import pg from 'pg';
import type { ClientBase } from 'pg';

export const RUNTIME_ROLE = 'coach_runtime';
/** Serialises only grant runs on one database. Not the migration lock (727_001) or the owner-setup lock (727_002). */
export const RUNTIME_GRANTS_LOCK_KEY = 727_003;
export const SETUP_HINT =
	'locally: pnpm db:setup; on Neon: run CREATE ROLE coach_runtime NOLOGIN as the database owner (docs/deployment.md, "Least-privilege runtime role")';

/** True for a URL whose user is the runtime role or one of its login roles (coach_app, coach_app_*). */
export function isRuntimeRoleUrl(url: string): boolean {
	return /^coach_(runtime|app)(_|$)/.test(decodeURIComponent(new URL(url).username));
}

/**
 * The SQL that creates the role when it is missing (it needs CREATEROLE, else the hint says how
 * to make it) and grants it the rights above. Run as one simple query, in one transaction.
 */
export function runtimeGrantsSql(role: string = RUNTIME_ROLE): string {
	const id = pg.escapeIdentifier(role);
	const literal = pg.escapeLiteral(role);
	const hint = pg.escapeLiteral(SETUP_HINT);
	return `DO $$
BEGIN
	IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = ${literal}) THEN
		BEGIN
			CREATE ROLE ${id} NOLOGIN;
		EXCEPTION
			WHEN duplicate_object OR unique_violation THEN NULL;
			WHEN insufficient_privilege THEN
				RAISE EXCEPTION 'role % does not exist, and % cannot create it', ${literal}, current_user
					USING ERRCODE = 'insufficient_privilege',
						HINT = ${hint};
		END;
	END IF;
END $$;
GRANT USAGE ON SCHEMA public TO ${id};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${id};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${id};
GRANT USAGE ON SCHEMA drizzle TO ${id};
GRANT SELECT ON drizzle.__drizzle_migrations TO ${id};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${id};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${id};`;
}

/**
 * Apply the runtime role's grants on `client`'s database, in one transaction under an advisory
 * lock. Rolls back and rethrows on any error. The caller must not have a transaction open.
 */
export async function applyRuntimeGrants(
	client: ClientBase,
	role: string = RUNTIME_ROLE
): Promise<void> {
	try {
		await client.query('BEGIN');
		await client.query('SELECT pg_advisory_xact_lock($1)', [RUNTIME_GRANTS_LOCK_KEY]);
		await client.query(runtimeGrantsSql(role));
		await client.query('COMMIT');
	} catch (error) {
		await client.query('ROLLBACK').catch(() => {});
		throw error;
	}
}
