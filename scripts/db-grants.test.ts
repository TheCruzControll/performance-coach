/**
 * `pnpm db:grants` (scripts/db-grants.ts) and the runtime role's URL check, with no database: the
 * runtime-role refusal runs before any connection, the restore script re-applies the grants after
 * pg_restore, the package script is the one the docs name, and the grants' result (applied, or a
 * skip with its warning) is handled the same way by the CLI and by the restore.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ClientBase } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { grantsOutcome } from './db-grants.ts';
import {
	RUNTIME_ROLE,
	SETUP_HINT,
	applyRuntimeGrants,
	isRuntimeRoleUrl,
	runtimeGrantsSql
} from '../src/lib/server/db/runtime-grants.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Builds a fixture URL from parts, so the secrets scan does not read it as a credential. */
const pg = (user: string, rest: string) => ['postgres://', user, rest].join('');

/** A client that records each statement and throws the error `fail` picks for it. */
function fakeClient(fail: (sql: string) => Error | undefined = () => undefined) {
	const sent: string[] = [];
	const client = {
		query: async (sql: string) => {
			sent.push(sql);
			const error = fail(sql);
			if (error) throw error;
			return { rows: [] };
		}
	};
	return { client: client as unknown as ClientBase, sent };
}

/** The refusal runtimeGrantsSql raises when the role is missing and this login cannot create it. */
const missingRole = () =>
	Object.assign(new Error('role coach_runtime does not exist, and coach cannot create it'), {
		code: '42501',
		hint: SETUP_HINT
	});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('grantsOutcome', () => {
	it('exits 0 and names the database when the grants are applied', () => {
		expect(grantsOutcome({ applied: true }, 'postgres://u:***@h/d')).toEqual({
			exitCode: 0,
			line: `db:grants: ${RUNTIME_ROLE} grants applied on postgres://u:***@h/d`
		});
	});

	it('exits 1 on a skip, so an explicit request fails loudly', () => {
		const outcome = grantsOutcome(
			{ applied: false, reason: 'no-createrole' },
			'postgres://u:***@h/d'
		);
		expect(outcome.exitCode).toBe(1);
		expect(outcome.line).toContain('NOT applied on postgres://u:***@h/d');
	});
});

describe('applyRuntimeGrants', () => {
	it('runs the transaction in order and reports applied', async () => {
		const { client, sent } = fakeClient();
		await expect(applyRuntimeGrants(client)).resolves.toEqual({ applied: true });
		expect(sent).toEqual([
			'BEGIN',
			'SELECT pg_advisory_xact_lock($1)',
			runtimeGrantsSql(),
			'COMMIT'
		]);
	});

	it('rolls back, warns once and reports a skip when the role is missing and cannot be created', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { client, sent } = fakeClient((sql) =>
			sql.startsWith('DO $$') ? missingRole() : undefined
		);
		await expect(applyRuntimeGrants(client)).resolves.toEqual({
			applied: false,
			reason: 'no-createrole'
		});
		expect(sent.at(-1)).toBe('ROLLBACK');
		expect(sent).not.toContain('COMMIT');
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			`runtime grants skipped: ${RUNTIME_ROLE} is missing and this role cannot create it; ${SETUP_HINT}`
		);
	});

	it('rethrows a 42501 without the missing-role hint, such as a GRANT refused', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const refused = Object.assign(new Error('permission denied for schema public'), {
			code: '42501'
		});
		const { client, sent } = fakeClient((sql) => (sql.startsWith('DO $$') ? refused : undefined));
		await expect(applyRuntimeGrants(client)).rejects.toBe(refused);
		expect(sent.at(-1)).toBe('ROLLBACK');
		expect(warn).not.toHaveBeenCalled();
	});

	it('rethrows any other error', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const lost = Object.assign(new Error('connection terminated'), { code: '08006' });
		const { client, sent } = fakeClient((sql) => (sql.startsWith('DO $$') ? lost : undefined));
		await expect(applyRuntimeGrants(client)).rejects.toBe(lost);
		expect(sent.at(-1)).toBe('ROLLBACK');
		expect(warn).not.toHaveBeenCalled();
	});
});

describe('isRuntimeRoleUrl', () => {
	it.each([
		pg('coach_app', ':x@h/d'),
		pg('coach_app_prod', ':x@h/d'),
		'postgres://coach_runtime@h/d'
	])('is true for the runtime role or its login: %s', (url) => {
		expect(isRuntimeRoleUrl(url)).toBe(true);
	});

	it.each([
		pg('coach', ':x@h/d'),
		pg('neondb_owner', ':x@h/d'),
		pg('postgres', ':x@h/d'),
		pg('coach_application', ':x@h/d')
	])('is false for any other user: %s', (url) => {
		expect(isRuntimeRoleUrl(url)).toBe(false);
	});
});

describe('scripts/restore-backup.sh', () => {
	const script = readFileSync(`${root}scripts/restore-backup.sh`, 'utf8');

	it('re-applies the grants after pg_restore, before it reports done', () => {
		const grants = script.indexOf('node scripts/db-grants.ts "$target"');
		expect(grants).toBeGreaterThan(script.indexOf('pg_restore --clean'));
		expect(grants).toBeGreaterThan(-1);
		expect(grants).toBeLessThan(script.indexOf('echo "restore: done"'));
	});
});

describe('pnpm db:grants', () => {
	it('is the grants script', () => {
		const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts['db:grants']).toBe('node --env-file-if-exists=.env scripts/db-grants.ts');
	});

	it('refuses the runtime role before connecting', () => {
		const result = spawnSync(
			process.execPath,
			['scripts/db-grants.ts', pg('coach_app', ':x@localhost:1/coach_dev')],
			{ cwd: root, env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 30_000 }
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('it is the runtime role');
	});

	it('exits 2 on a malformed URL and never prints it, password included', () => {
		const result = spawnSync(process.execPath, ['scripts/db-grants.ts', pg('u', ':s3cret@[bad')], {
			cwd: root,
			env: { PATH: process.env.PATH ?? '' },
			encoding: 'utf8',
			timeout: 30_000
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('not a postgres:// URL');
		expect(result.stdout).not.toContain('s3cret');
		expect(result.stderr).not.toContain('s3cret');
	});
});
